/**
 * Agent workspace file access on the OpenShell runtime, where the workspace
 * lives inside the sandbox (no shared host mount). Mirrors the host files
 * API's rules: lexical checks run server-side (normalizeRel); the symlink
 * containment half runs inside the sandbox with the image's node, since
 * only the sandbox can resolve its own paths.
 */
import { Readable } from "node:stream";
import type { SandboxClient } from "@nvidia/openshell-sdk";
import { HttpPathError, normalizeRel } from "../util/paths.js";

export interface FileEntry {
  name: string;
  type: "file" | "dir" | "symlink" | "other";
  size: number;
  mtime: string;
  mode: number;
}

export type SandboxFsApi = Pick<SandboxClient, "exec" | "execStream">;

/**
 * Upload chunk size per exec. stdin travels in one gRPC message and the
 * gateway rejects messages over 1 MiB, so stay well under it.
 */
const WRITE_CHUNK = 512 * 1024;

/**
 * In-sandbox helper: `node -e FSCTL <op> <root> <rel>` prints one JSON
 * object. Resolves `rel` under `root`, refusing symlinks that leave it; for
 * a nonexistent path the nearest existing parent must resolve inside.
 */
export const FSCTL = String.raw`
const fs = require("fs"), path = require("path");
const [op, root, rel] = process.argv.slice(1);
const out = (o) => process.stdout.write(JSON.stringify(o));
const fail = (code, msg) => { out({ ok: false, code, msg }); process.exit(0); };
let realRoot;
try { realRoot = fs.realpathSync(root); } catch (e) { fail(e.code || "EIO", "workspace root missing"); }
const inside = (p) => p === realRoot || p.startsWith(realRoot + path.sep);
const abs = path.resolve(root, rel === "." ? "" : rel);
let real = null;
try { real = fs.realpathSync(abs); } catch (e) {
  if (e.code !== "ENOENT") fail(e.code || "EIO", e.message);
  for (let p = path.dirname(abs); ; ) {
    try { if (!inside(fs.realpathSync(p))) fail("ESCAPE", "symlink escapes workspace"); break; }
    catch (e2) { if (e2.code !== "ENOENT") fail(e2.code || "EIO", e2.message); const q = path.dirname(p); if (q === p) fail("ESCAPE", "path escapes workspace"); p = q; }
  }
}
if (real && !inside(real)) fail("ESCAPE", "symlink escapes workspace");
const target = real || abs;
const entry = (name, p) => { const st = fs.lstatSync(p); return { name, type: st.isDirectory() ? "dir" : st.isSymbolicLink() ? "symlink" : st.isFile() ? "file" : "other", size: st.size, mtime: st.mtime.toISOString(), mode: st.mode }; };
try {
  switch (op) {
    case "resolve": out({ ok: true, abs: target, exists: !!real }); break;
    case "stat": if (!real) fail("ENOENT", "not found"); out({ ok: true, abs: target, entry: entry(path.basename(target), target), dir: fs.statSync(target).isDirectory() }); break;
    case "list": if (!real) fail("ENOENT", "not found"); out({ ok: true, entries: fs.readdirSync(target).map((n) => entry(n, path.join(target, n))) }); break;
    case "mkdir": fs.mkdirSync(target, { recursive: true }); out({ ok: true }); break;
    case "rm": if (!real) fail("ENOENT", "not found"); fs.rmSync(target, { recursive: true }); out({ ok: true }); break;
    default: fail("EINVAL", "unknown op " + op);
  }
} catch (e) { fail(e.code || "EIO", e.message); }
`;

function errorFor(code: string, msg: string): Error {
  if (code === "ESCAPE") return new HttpPathError(400, msg);
  if (code === "ENOTDIR") return new HttpPathError(400, "not a directory");
  return Object.assign(new Error(msg), { code });
}

export class SandboxFs {
  private readonly scope: { workspace?: string };

  constructor(
    private readonly api: SandboxFsApi,
    private readonly sandbox: string,
    /** absolute workspace dir inside the sandbox */
    private readonly root: string,
    workspace?: string,
  ) {
    this.scope = workspace ? { workspace } : {};
  }

  private async ctl<T>(op: string, rel: string): Promise<T & { ok: true }> {
    const res = await this.api.exec(this.sandbox, ["node", "-e", FSCTL, op, this.root, rel], { ...this.scope, noLoginShell: true });
    const text = res.stdout.toString("utf8");
    let parsed: { ok: boolean; code?: string; msg?: string };
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`sandbox fs ${op} failed (${res.exitCode}): ${res.stderr.toString("utf8").slice(0, 300) || text.slice(0, 300)}`);
    }
    if (!parsed.ok) throw errorFor(parsed.code ?? "EIO", parsed.msg ?? "sandbox fs error");
    return parsed as T & { ok: true };
  }

  private async run(argv: string[], stdin?: Buffer): Promise<void> {
    const res = await this.api.exec(this.sandbox, argv, { ...this.scope, noLoginShell: true, ...(stdin ? { stdin } : {}) });
    if (res.exitCode !== 0) throw new Error(`sandbox ${argv[0]} failed (${res.exitCode}): ${res.stderr.toString("utf8").slice(0, 300)}`);
  }

  /** file metadata, or the listing when rel is a directory */
  async statOrList(input: string): Promise<{ rel: string; file?: FileEntry; entries?: FileEntry[] }> {
    const rel = normalizeRel(input);
    const st = await this.ctl<{ entry: FileEntry; dir: boolean }>("stat", rel);
    if (!st.dir) return { rel, file: { ...st.entry, type: "file" } };
    const { entries } = await this.ctl<{ entries: FileEntry[] }>("list", rel);
    entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
    return { rel, entries };
  }

  async open(input: string): Promise<{ name: string; size: number; stream: Readable }> {
    const rel = normalizeRel(input);
    const st = await this.ctl<{ abs: string; entry: FileEntry; dir: boolean }>("stat", rel);
    if (st.dir || st.entry.type !== "file") throw new HttpPathError(400, "not a regular file");
    const events = this.api.execStream(this.sandbox, ["cat", "--", st.abs], { ...this.scope, noLoginShell: true });
    async function* stdout() {
      for await (const ev of events) {
        if ("type" in ev) {
          if (ev.exitCode !== 0) throw new Error(`sandbox cat exited ${ev.exitCode}`);
        } else if (ev.stream === "stdout") {
          yield ev.data;
        }
      }
    }
    return { name: st.entry.name, size: st.entry.size, stream: Readable.from(stdout()) };
  }

  /** stream `source` into rel via a temp file, moved into place at the end */
  async write(input: string, source: AsyncIterable<Buffer | string>): Promise<number> {
    const rel = normalizeRel(input);
    const { abs } = await this.ctl<{ abs: string }>("resolve", rel);
    const tmp = `${abs}.upload-tmp`;
    await this.run(["sh", "-c", 'mkdir -p "$(dirname "$1")" && : > "$1"', "sh", tmp]);
    let total = 0;
    let pending: Buffer[] = [];
    let pendingBytes = 0;
    const flush = async () => {
      if (!pendingBytes) return;
      await this.run(["sh", "-c", 'cat >> "$1"', "sh", tmp], Buffer.concat(pending));
      pending = [];
      pendingBytes = 0;
    };
    try {
      for await (const chunk of source) {
        const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
        pending.push(buf);
        pendingBytes += buf.length;
        total += buf.length;
        if (pendingBytes >= WRITE_CHUNK) await flush();
      }
      await flush();
      await this.run(["mv", "-f", "--", tmp, abs]);
    } catch (err) {
      await this.run(["rm", "-f", "--", tmp]).catch(() => {});
      throw err;
    }
    return total;
  }

  async mkdir(input: string): Promise<void> {
    await this.ctl("mkdir", normalizeRel(input));
  }

  async remove(input: string): Promise<void> {
    await this.ctl("rm", normalizeRel(input));
  }
}
