import type { WsClientMessage, WsServerMessage } from "@gwarestrin/shared";

export type WsStatus = "connecting" | "open" | "closed";

export class WsClient {
  private ws: WebSocket | null = null;
  private url: string;
  private backoff = 500;
  private closedByUser = false;
  private listeners = new Set<(msg: WsServerMessage) => void>();
  private statusListeners = new Set<(s: WsStatus) => void>();
  private nextBrowserId = 1;

  constructor(url?: string) {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    this.url = url ?? `${proto}//${location.host}/ws`;
  }

  connect(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    this.closedByUser = false;
    this.notifyStatus("connecting");
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.backoff = 500;
      this.notifyStatus("open");
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data as string) as WsServerMessage;
        for (const l of this.listeners) l(msg);
      } catch {
        /* ignore malformed */
      }
    };
    ws.onclose = () => {
      this.notifyStatus("closed");
      if (!this.closedByUser) {
        setTimeout(() => this.connect(), this.backoff);
        this.backoff = Math.min(this.backoff * 2, 15_000);
      }
    };
    ws.onerror = () => {
      /* onclose follows */
    };
  }

  close(): void {
    this.closedByUser = true;
    this.ws?.close();
  }

  send(msg: WsClientMessage): void {
    if (this.ws?.readyState !== WebSocket.OPEN) throw new Error("ws not open");
    this.ws.send(JSON.stringify(msg));
  }

  /** send as soon as the socket is open (queues through connecting/reconnect) */
  private sendWhenOpen(msg: WsClientMessage): Promise<void> {
    return new Promise((resolve) => {
      const trySend = (): boolean => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify(msg));
          return true;
        }
        return false;
      };
      if (trySend()) return resolve();
      const off = this.onStatus((s) => {
        if (s === "open" && trySend()) {
          off();
          resolve();
        }
      });
    });
  }

  /** send an RPC command; resolves with the correlated response event */
  rpc(agentId: string, type: string, payload: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const id = `b-${this.nextBrowserId++}`;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        off();
        reject(new Error(`rpc ${type} timed out`));
      }, 60_000);
      const on = (msg: WsServerMessage) => {
        if (msg.kind !== "event") return;
        const ev = msg.event as { type?: string; browserId?: string };
        if (ev.type === "response" && ev.browserId === id) {
          clearTimeout(timeout);
          off();
          resolve(msg.event);
        }
      };
      const off = () => this.listeners.delete(on);
      this.listeners.add(on);
      this.sendWhenOpen({ v: 1, agentId, kind: "cmd", id, type, ...payload } as never).catch((err) => {
        clearTimeout(timeout);
        off();
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }

  onMessage(l: (msg: WsServerMessage) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  onStatus(l: (s: WsStatus) => void): () => void {
    this.statusListeners.add(l);
    l(this.ws?.readyState === WebSocket.OPEN ? "open" : "closed");
    return () => this.statusListeners.delete(l);
  }

  private notifyStatus(s: WsStatus): void {
    for (const l of this.statusListeners) l(s);
  }
}

export const ws = new WsClient();
