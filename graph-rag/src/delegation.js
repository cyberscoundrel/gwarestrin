// Agent tokens: an instance delegates graph access to one of its agents at a
// position its profile chooses.
//
//   gwa1.<base64url(payload)>.<base64url(HMAC-SHA256(key, "gwa1." + payload))>
//   payload = { u: tenant user, a: agent id, p: [position ids], iat, exp? }
//
// The key is the tenant's delegationKey (token map entry, provisioner-issued;
// the tenant server holds the same key). Even a valid signature can't widen:
// requested positions outside what the tenant's user sees are dropped, and an
// agent never gets approve or raw (approving is a person's act).
//
// Two roles for the organization's graph worker agents (payload.r), honoured
// only when the tenant is the organization's root with direct writes (its
// admin); anyone else's claim is ignored and the token is an ordinary agent's:
//   worker   one queue entry's thread (j: job id, e: the entry's rid). Sees the
//            whole graph and may run read-only raw queries; it writes
//            directly, and proposes (then waits) what it judges a large
//            change. Raw writes and widening who sees something are always
//            proposals.
//   liaison  relays workers' questions and proposals to the admin: answers
//            questions and decides workers' proposals, writes nothing itself.
//   master   the long-running coordinator: reads everything, plans batches,
//            starts workers and handlers, settles what it can of a stopped
//            worker; changes the graph only through workers.
//   handler  settles one stopped worker with the operator (j: its handler
//            job): answers its questions and decides its proposals on the
//            operator's word; writes nothing itself.
import { createHmac, timingSafeEqual } from "node:crypto";
import { heldPositions, visibleHomes } from "./positions.js";

export const PREFIX = "gwa1.";

const b64u = (buf) => Buffer.from(buf).toString("base64url");

/** sign an agent token (the tenant server does this; here for tests) */
export function signAgentToken(key, payload) {
  const body = b64u(JSON.stringify(payload));
  const sig = b64u(createHmac("sha256", key).update(PREFIX + body).digest());
  return `${PREFIX}${body}.${sig}`;
}

/**
 * Resolve an agent token to an identity, or null if it isn't valid.
 * `entryFor(user)` returns the tenant's token-map entry; `map` is the
 * position map (null: not loaded, so the agent sees nothing).
 */
export function resolveAgentToken(token, entryFor, map, now = Date.now()) {
  if (typeof token !== "string" || !token.startsWith(PREFIX)) return null;
  const [body, sig, extra] = token.slice(PREFIX.length).split(".");
  if (!body || !sig || extra !== undefined) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!payload || typeof payload.u !== "string" || typeof payload.a !== "string") return null;
  const entry = entryFor(payload.u);
  if (!entry || typeof entry.delegationKey !== "string" || entry.delegationKey.length < 32) return null;
  const want = createHmac("sha256", entry.delegationKey).update(PREFIX + body).digest();
  const got = Buffer.from(sig, "base64url");
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  if (typeof payload.exp === "number" && now / 1000 > payload.exp) return null;

  const tenantPositions = Array.isArray(entry.positions) ? entry.positions : [];
  const requested = Array.isArray(payload.p) ? payload.p.filter((x) => typeof x === "string") : [];
  let positions = tenantPositions;
  if (requested.length > 0) {
    if (!map) {
      positions = [];
    } else {
      const reach = visibleHomes(map, heldPositions(map, tenantPositions)); // null = root: anywhere
      positions = requested.filter((p) => map.positions[p] && (reach === null || reach.has(p)));
    }
  }
  const rootTenant = !!map && tenantPositions.includes(map.root) && entry.caps?.write === "direct" && entry.caps?.read === true;
  if (rootTenant && payload.r === "worker" && typeof payload.j === "string" && /^[0-9a-f-]{36}$/i.test(payload.j) && typeof payload.e === "string" && /^#\d+:\d+$/.test(payload.e)) {
    return {
      user: `${entry.user}/worker:${payload.a.slice(0, 8)}`,
      key: `${entry.user}/agent:${payload.a}`,
      agent: payload.a,
      role: { kind: "worker", job: payload.j, entry: payload.e },
      caps: { read: true, write: "direct", approve: false, raw: entry.caps?.raw === true },
      positions: tenantPositions,
    };
  }
  if (rootTenant && payload.r === "master") {
    return {
      user: `${entry.user}/master:${payload.a.slice(0, 8)}`,
      key: `${entry.user}/agent:${payload.a}`,
      agent: payload.a,
      role: { kind: "master" },
      caps: { read: true, write: "deny", approve: true, raw: entry.caps?.raw === true },
      positions: tenantPositions,
    };
  }
  if (rootTenant && payload.r === "handler" && typeof payload.j === "string" && /^[0-9a-f-]{36}$/i.test(payload.j)) {
    return {
      user: `${entry.user}/handler:${payload.a.slice(0, 8)}`,
      key: `${entry.user}/agent:${payload.a}`,
      agent: payload.a,
      role: { kind: "handler", job: payload.j },
      caps: { read: true, write: "deny", approve: true, raw: false },
      positions: tenantPositions,
    };
  }
  if (rootTenant && payload.r === "liaison") {
    return {
      user: `${entry.user}/liaison:${payload.a.slice(0, 8)}`,
      key: `${entry.user}/agent:${payload.a}`,
      agent: payload.a,
      role: { kind: "liaison" },
      caps: { read: true, write: "deny", approve: true, raw: false },
      positions: tenantPositions,
    };
  }
  return {
    user: `${entry.user}/agent:${payload.a.slice(0, 8)}`, // for audit trails
    key: `${entry.user}/agent:${payload.a}`, // unique per agent (read tracking)
    agent: payload.a,
    caps: {
      read: entry.caps?.read === true,
      write: entry.caps?.write ?? "deny",
      approve: false,
      raw: false,
    },
    positions,
  };
}
