// What graph-rag depends on (the model routes, the decision API) and how its
// own background loops are doing. One rule for every call: a failure that is
// the dependency's (out of credit, rate-limited, down, timed out) marks it
// down for a while and puts the work off without spending a retry; any other
// failure is the work's own. Nothing that fails here is only logged: the
// status shows it until it recovers.

/** an HTTP status or thrown error that means the dependency is out, not that the request was wrong */
export function isOutage(statusOrError) {
  if (typeof statusOrError === "number") return statusOrError === 402 || statusOrError === 408 || statusOrError === 429 || statusOrError >= 500;
  const e = statusOrError;
  if (e?.outage) return true;
  const name = String(e?.name ?? "");
  const text = `${e?.message ?? e} ${e?.cause?.code ?? ""}`;
  return name === "TimeoutError" || name === "AbortError" || /fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|socket hang up/i.test(text);
}

/** thrown for a dependency that's out: the job waits until `until` and keeps its retries */
export class Outage extends Error {
  constructor(dep, reason, until) {
    super(`${dep} unavailable: ${reason}`);
    this.dep = dep;
    this.until = until;
    this.later = true;
    this.outage = true;
  }
}

export const FIRST_PAUSE_MS = 60_000;
export const MAX_PAUSE_MS = 15 * 60_000;

/**
 * Dependency health. `down(dep)` is true while a failed dependency is paused;
 * when the pause ends one call goes through as a probe (and pauses it again,
 * twice as long, if it fails).
 */
export function createHealth(now = () => Date.now()) {
  const deps = new Map(); // dep -> { downSince, until, pause, reason, failures, okAt }
  const get = (dep) => deps.get(dep) ?? { downSince: null, until: 0, pause: 0, reason: "", failures: 0, okAt: null };
  return {
    ok(dep) {
      deps.set(dep, { ...get(dep), downSince: null, until: 0, pause: 0, reason: "", okAt: new Date(now()).toISOString() });
    },
    /** record a failure; an outage pauses the dependency. Returns the Outage to throw, or null */
    fail(dep, err, status) {
      if (!isOutage(status ?? err)) return null;
      const d = get(dep);
      const pause = Math.min(MAX_PAUSE_MS, d.pause ? d.pause * 2 : FIRST_PAUSE_MS);
      const reason = status ? `HTTP ${status}${status === 402 ? " (out of credit)" : status === 429 ? " (rate-limited)" : ""}` : String(err?.message ?? err).slice(0, 120);
      const until = now() + pause;
      deps.set(dep, { ...d, downSince: d.downSince ?? new Date(now()).toISOString(), until, pause, reason, failures: d.failures + 1 });
      return new Outage(dep, reason, until);
    },
    /** paused right now (a probe is let through once the pause is over) */
    down(dep) {
      const d = deps.get(dep);
      return Boolean(d?.downSince) && now() < d.until;
    },
    /** the Outage for a paused dependency, to throw without calling it */
    outage(dep) {
      const d = deps.get(dep);
      return d?.downSince && now() < d.until ? new Outage(dep, d.reason, d.until) : null;
    },
    status() {
      return Object.fromEntries(
        [...deps].map(([dep, d]) => [dep, d.downSince ? { ok: false, since: d.downSince, reason: d.reason, retry_at: new Date(d.until).toISOString() } : { ok: true, at: d.okAt }]),
      );
    },
  };
}

/**
 * Background loops (the sweep, pruning, batches, regrading, ...): each run
 * reports here, so a loop that keeps failing shows in the status instead of
 * only in the log. A loop's log line is written once per distinct error.
 */
export function createLoops(log = console, now = () => Date.now()) {
  const loops = new Map(); // name -> { okAt, failing, since, error, count }
  return {
    ran(name) {
      const l = loops.get(name);
      if (l?.failing) log.info?.(`${name} recovered after ${l.count} failed run(s)`);
      loops.set(name, { okAt: new Date(now()).toISOString(), failing: false, since: null, error: "", count: 0 });
    },
    failed(name, err) {
      const l = loops.get(name) ?? { okAt: null, failing: false, since: null, error: "", count: 0 };
      const error = String(err?.message ?? err).slice(0, 300);
      if (error !== l.error) log.warn?.(`${name} failed: ${error.slice(0, 200)}`);
      loops.set(name, { ...l, failing: true, since: l.since ?? new Date(now()).toISOString(), error, count: l.count + 1 });
    },
    /** run one pass of a loop, reporting how it went (never throws) */
    async run(name, fn) {
      try {
        const r = await fn();
        this.ran(name);
        return r;
      } catch (e) {
        this.failed(name, e);
        return undefined;
      }
    },
    status() {
      return Object.fromEntries([...loops].map(([n, l]) => [n, l.failing ? { ok: false, since: l.since, failures: l.count, error: l.error } : { ok: true, at: l.okAt }]));
    },
  };
}
