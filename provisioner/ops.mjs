// Operations API: the organization's workspaces and their settings, for the
// admin's dashboard. Listens on the backend network only (never published);
// every call needs the operations token, which the provisioner issues only
// to admin-tier instances (in their metadata, values.ops).
//
//   GET /instances                    workspaces, their settings, the choices
//   PUT /instances/:name/settings     change one workspace's settings
import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";

export function startOpsServer({ port, token, list, update, log }) {
  const authorized = (req) => {
    const h = String(req.headers.authorization ?? "");
    const got = Buffer.from(h.startsWith("Bearer ") ? h.slice(7) : "");
    const want = Buffer.from(token);
    return got.length === want.length && timingSafeEqual(got, want);
  };
  const send = (res, status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const server = createServer((req, res) => {
    if (!authorized(req)) return send(res, 401, { error: "unauthorized" });
    const url = new URL(req.url ?? "/", "http://ops");
    const actor = String(req.headers["x-gw-actor"] ?? "unknown").slice(0, 64);
    if (req.method === "GET" && url.pathname === "/instances") {
      return void Promise.resolve(list()).then((body) => send(res, 200, body), (err) => send(res, 500, { error: String(err.message ?? err) }));
    }
    const m = /^\/instances\/([a-z0-9][a-z0-9-]{0,62})\/settings$/i.exec(url.pathname);
    if (req.method === "PUT" && m) {
      let raw = "";
      req.on("data", (c) => {
        raw += c;
        if (raw.length > 64 * 1024) req.destroy();
      });
      req.on("end", () => {
        let body;
        try {
          body = JSON.parse(raw || "{}");
        } catch {
          return send(res, 400, { error: "invalid JSON" });
        }
        void Promise.resolve(update(m[1], body, actor)).then(
          (out) => send(res, 200, out),
          (err) => send(res, err.status ?? 400, { error: String(err.message ?? err).slice(0, 300) }),
        );
      });
      return;
    }
    send(res, 404, { error: "not found" });
  });
  server.listen(port, "0.0.0.0", () => log(`ops API listening on :${port} (backend network)`));
  return server;
}
