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
