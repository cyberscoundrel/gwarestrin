import assert from "node:assert/strict";
import { test } from "node:test";
import { createHealth, createLoops, FIRST_PAUSE_MS, isOutage, MAX_PAUSE_MS, Outage } from "../src/health.js";

test("an outage is the dependency's: credit, rate limits, server errors, timeouts, unreachable", () => {
  for (const s of [402, 408, 429, 500, 502, 503]) assert.equal(isOutage(s), true, String(s));
  for (const s of [400, 401, 403, 404, 422]) assert.equal(isOutage(s), false, String(s));
  assert.equal(isOutage(Object.assign(new Error("x"), { name: "TimeoutError" })), true);
  assert.equal(isOutage(new TypeError("fetch failed")), true);
  assert.equal(isOutage(new Error("connect ECONNREFUSED 10.0.0.1:4000")), true);
  assert.equal(isOutage(new Error("bad JSON from the model")), false);
});

test("a dependency that fails is paused, probed after the pause, and paused longer each time", () => {
  let t = 1_000_000;
  const h = createHealth(() => t);
  assert.equal(h.down("m"), false);
  assert.equal(h.fail("m", null, 400), null, "the request's own fault doesn't pause anything");
  assert.equal(h.down("m"), false);
  const o = h.fail("m", null, 402);
  assert.ok(o instanceof Outage);
  assert.equal(o.later, true);
  assert.match(o.message, /out of credit/);
  assert.equal(h.down("m"), true);
  assert.ok(h.outage("m") instanceof Outage);
  t += FIRST_PAUSE_MS;
  assert.equal(h.down("m"), false, "the probe goes through");
  h.fail("m", null, 402);
  assert.equal(o.until - 1_000_000, FIRST_PAUSE_MS);
  assert.equal(h.status().m.ok, false);
  assert.equal(Date.parse(h.status().m.retry_at) - t, 2 * FIRST_PAUSE_MS, "twice as long");
  for (let i = 0; i < 10; i++) h.fail("m", null, 503);
  assert.equal(Date.parse(h.status().m.retry_at) - t, MAX_PAUSE_MS, "capped");
  h.ok("m");
  assert.equal(h.down("m"), false);
  assert.equal(h.status().m.ok, true);
  h.fail("m", null, 429);
  assert.equal(Date.parse(h.status().m.retry_at) - t, FIRST_PAUSE_MS, "a recovery starts the pauses over");
});

test("a loop that keeps failing shows in the status until it runs again; the log says it once", async () => {
  const lines = [];
  const loops = createLoops({ warn: (l) => lines.push(`W ${l}`), info: (l) => lines.push(`I ${l}`) });
  await loops.run("sweep", async () => {
    throw new Error("parse error at row 3");
  });
  await loops.run("sweep", async () => {
    throw new Error("parse error at row 3");
  });
  assert.deepEqual(loops.status().sweep, { ok: false, since: loops.status().sweep.since, failures: 2, error: "parse error at row 3" });
  assert.equal(lines.length, 1, "one log line per distinct error");
  assert.equal(await loops.run("sweep", async () => 7), 7);
  assert.equal(loops.status().sweep.ok, true);
  assert.match(lines.at(-1), /recovered after 2/);
});
