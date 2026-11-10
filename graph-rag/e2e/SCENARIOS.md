# Scenario files

The replay harness (`e2e.sh`, `run.mjs`) runs its own 22 scenarios and then
every stream's, from `graph-rag/e2e/scenarios-<stream>.mjs`, as one suite
with one summary line (`N/N scenarios passed`, `(k skipped)` when any were)
and the same `PASS`/`FAIL name: reason` lines. A stream adds its file and
touches nothing else in this directory: `run.mjs`, `fake-models.mjs`,
`e2e.sh` and the loader (`scenarios.mjs`) belong to the Test harness stream.

## The file

`scenarios-<stream>.mjs` (`<stream>`: `discovery`, `condenser`, `admission`,
`authority`, `reconcile`, `queries`, or any `[a-z0-9-]+`), an ES module whose
default export (or a named `scenarios`) is a non-empty array of:

```js
export default [
  { name: "what it checks, as a sentence", run: async (ctx) => { ... } },
  { name: "...", skip: "why, until when", run: async (ctx) => { ... } },
  { name: "...", skip: async (ctx) => (await ready(ctx)) ? null : "not yet: ...", run: ... },
];
```

- `name`: a sentence; it prints as `PASS name [stream]`.
- `run(ctx)`: throws (or fails a `ctx.check`) to fail. Scenarios run in
  file order, files in name order, after the 22 built-in ones, against the
  same graph: use a prefix of your own for entry names (`e2e-<stream>-...`)
  and look nothing up by a name another stream might also write.
- `skip` (optional): a reason string, `true`, or an `async (ctx)` returning
  a reason or `null` to run. A skipped scenario prints `SKIP name [file]:
  reason`, is left out of the count, and fails the run: a run with a SKIP in
  it exits non-zero, since it proved nothing about that scenario. So does a
  run that selects nothing (`ONLY=` matching no scenario).

A file that fails to import, or exports the wrong shape, counts as one
failed scenario named `load scenarios-<stream>.mjs`; the rest still run.

`ONLY=condenser graph-rag/e2e/e2e.sh` runs only the scenarios whose name,
file or stream contains a term (comma-separated terms, any match); `ONLY=harness`
is the built-in 22 plus `scenarios-harness.mjs`.

## What `run` receives

Everything `run.mjs` has, by name, on one object:

| field | what it is |
|---|---|
| `GRAPH`, `MODELS` | the graph-rag and fake-models base URLs inside the network |
| `TOKENS` | `{ admin, alice, bob, carol }` -> bearer tokens (e2e.sh): admin at the root (`write: direct`, `approve`, `raw`), alice at Operations, bob at the Production floor, carol at Operations for negative checks (she never writes; a search records what it shows as reads, and a writer's own notes graded above them show via "writer", so searching as alice raises her derived floor for the rest of the run) |
| `POS` | `{ org, ops, floor }` -> position ids of the harness tree (root `org` > `ops` > `floor`) |
| `tool(who, name, args)` | one MCP `tools/call` as `who` (a key of `TOKENS`, or a raw token); returns the tool's JSON, or `{ error }` |
| `sql(query)` | `query_graph` in SQL as the admin (raw); rows |
| `api(path, init?)` | an `/api/*` call as the admin; parsed JSON |
| `models(path, body)` | a POST to the fake models' control routes (`/__fail`, `/__ok`, `/__slow`, `/__resolve`, `/__condense`, `/__reset`) |
| `entry(name)` | `{ rid, name, _home, _grade, _ungraded, _mentions_at }` of an entry, or undefined |
| `thing(label)` | `{ rid, name }` of a thing by its label |
| `job(rid, kind = "mentions")` | the latest Job row whose payload names the rid |
| `unresolved(name)` | what the linker left unresolved on an entry (`_unresolved`, parsed; `[]` when nothing) |
| `until(label, fn, timeoutMs = 240000)` | polls `fn` every 3 s until it returns truthy; throws with `label` |
| `check(cond, message)` | throws `message` when `cond` is falsy |
| `save(who, name, text)` | `upsert_entities` of one note with that identity text |
| `delegated(claims)`, `workerToken(entryRid, job?)`, `handlerToken(job)` | delegated tokens as the admin's workspace signs them (a worker thread, a handler) |
| `randomUUID()` | node's |
| `fixtures.read(name)`, `fixtures.url(name)`, `fixtures.dir` | `graph-rag/test/fixtures/` (`classes.json`, `policy.json`, `positions.json`, `oracle-sixty.json`, `conversations/oracle-sixty.batch.json`) |
| `srcUrl(rel)` | a URL into `graph-rag/src/` for a read-only `import()` of a module (`srcUrl("model/claims.js")`); a static `import ... from "../src/model/claims.js"` works too |
| `e2eDir` | this directory's path |

The runner mounts the whole `graph-rag` checkout read-only at `/gr`, so
relative imports from a scenario file (`../src/model/claims.js`,
`../test/fixtures/...`) resolve as they do on the host.

After each scenario `run.mjs` clears every fake-model override (`/__ok` for
every model, then `/__reset`), so a scenario need not clean up its own.

## The fakes

`fake-models.mjs` answers from phrases in the text, so a scenario says what it
wants by what it writes. Markers:

| in | marker | the fake answers |
|---|---|---|
| a note (grader) | `[admins]` | restricted to the top (topic "personnel and health") |
| a note (grader) | `[no-topic]` | would restrict but names no listed topic: stays where written |
| a section (grader) | `[claimed]` | a section with claims: stays at the writer's position, and `GET /__calls` counts it under `grader:claimed` (the grader must never be asked about one) |
| a statement (linker) | `[things: Name/type, Other/type]` | those mentions |
| an entry (decision model) | `[L2]` | an investigation (level 2, record_lookup); else nothing to do |
| an entry (decision model) | `[contradicts]` | the `contradiction` question answers yes |
| an entry (decision model) | `[who_0: c1]` | the closed question `who_0` picks `c1` |
| an entry (decision model) | `[resolve: Diep=NGUD]` | any `who_<n>` whose candidate line contains `NGUD` picks it; `POST /__resolve {name, pick}` adds a lookup at run time; built in: Diep -> NGUD, Brian -> LOWB, John F. -> FRAJ; else `none` |
| a conversation (condenser) | `[title: ...]`, `[on record: person\|position\|reason]`, `[claim: kind\|subject\|class\|attribute\|value]` | the built-in condenser's document: one section per blank-line block, the tags its claims (tags stripped from the text); `POST /__condense {match, document}` answers a given document when the text contains `match` |

A chat request is the condenser's when its model name or system prompt
contains "condens". The Condenser stream's own canned responses go in
`graph-rag/e2e/fake-condenser.mjs`, loaded when present:

```js
export function complete(body) { ... }          // a chat-completions response ({ choices: [{ message: { content } }] }), or
export function condense(messages, body) { ... } // the assistant's content: a string, or an object to JSON-encode
export function matches(body) { ... }           // optional: claim a request; default: model or system prompt says "condens"
```

`GET /__condenser` says whether it was loaded. The decision model's closed
questions (`who_<n>`, any `type: "choice"`) are answered from the lookup
above; `level` and `reason` as before.
