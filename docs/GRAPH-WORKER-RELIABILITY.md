# Graph worker reliability

Why the graph worker kept turning up a new problem with each test batch, and
the rules that replaced the one-off fixes (2026-10-28).

## What the batches kept finding

Every batch from ux-t to ux-z found something new. Sorted by cause rather than
by symptom, most of them were four problems:

| Cause | What it produced |
|---|---|
| A dependency's failure treated as the work's fault, or not handled | the master hung an hour on one request; a sandbox retried forever after a host move; an out-of-credit model spent every job's retries; the identity sweep stalled for a day on one row; a grader outage left notes at admins-only |
| An entry's home decided in several places | search lifting notes to the root; the floor-lift cascade; repairs that needed an admin to approve each move back |
| Saving made things on speculation | "(other)" placeholders; placeholders named after a note's own code; workers spending turns deleting them |
| Failures logged and swallowed (`.catch(() => [])`, `log.warn`) | none on its own, but it's why each problem above was found by poking at a batch rather than reported by the system |

The fourth row is why it looked like a cycle. graph-rag runs about a dozen
background loops against four dependencies (litellm's model routes, the
decision API, ArcadeDB, and the workspace that runs threads), and each batch
exercised a slightly different path into a failure nobody saw.

## The rules now

### A dependency that's out pauses its work; it never fails it

`graph-rag/src/health.js`. Every call to a model route (`modelPost` in
`server.js`: embeddings, the grader, the linker, extraction) and to the
decision API is classified once:

- **The dependency's fault** (HTTP 402 out of credit, 408, 429 rate-limited,
  5xx, a timeout, unreachable): the route is paused, for 1 minute and then
  twice as long each time it fails again, up to 15 minutes. While it's
  paused, calls fail at once without going out. When the pause ends, one
  call goes through as a probe.
- **The request's fault** (other 4xx, an unusable answer): the work's own
  failure, retried and eventually failed as before.

Work that needs a paused route waits: the job loop claims nothing while the
worker's model or the embeddings are out, a job that hits an outage is put
off until the next probe without spending a retry, and the workspace is
handed no threads while the worker's model is out. Triage falls back to
sending entries to the master untriaged.

Worker threads follow the same rule. A thread's agent talks to its model
directly, so the workspace reads how its turn ended: a turn that ended on a
model error (after pi's own retries) or a stop is never counted as done. When
that error is the connection or the provider (a dropped connection, a
timeout, 402, 429, 5xx), the thread is reported as an outage: graph-rag
pauses the worker's model, hands out no threads until the pause ends, and
puts the thread off until then without spending a try. Any other error spends
one of its three tries. A thread put off six times in a row counts its next
failures as its own, so one that keeps dying this way can't wait forever.

### A model on your own hardware gets only what it can serve

Level-1 threads ran on the local Qwen (llama.cpp: four requests at a time
from one shared 262k-token context). The pool sent it every level-1 thread;
past four, requests queued for minutes behind other workers' long prompts
and were cut ("Connection error", "terminated", "Request timed out"), and
several large conversations together overflowed its context ("Context size
has been exceeded"). They failed together because they waited together. It
looked like a network fault; the sandboxes, the gateway and OpenRouter were
never the cause (reproduced 2026-10-29: a test agent on the local model
answered in 2 s until five workers started, then waited past 2 minutes).

The worker profile sets **at most N at once** per level, next to its model.
Levels on the same model share the lowest limit; a thread with no level
counts against the profile's own model. The pool counts its running threads
by model and asks graph-rag only for the room left; graph-rag's claim skips a
full model's threads, which stay pending with their tries. A thread's model is
the one it really runs on: a resumed thread keeps its agent's model whatever
its level, and a thread with no level runs on the profile's model or the
workspace default. The pool checks that before it starts a thread and hands a
thread on a full model back (pending again in a minute, tries kept).

### Every background loop reports how it went

The sweep, pruning, jobs, leases, batches and regrading run through
`loops.run(name, fn)`. A loop that keeps failing is in the worker status
(`loops`), with its error and how many runs failed. Its log line is written
once per distinct error, not every run.

The graph worker panel shows a banner for any paused dependency, any failing
loop, and the entries awaiting the grader.

### Where an entry is seen from is decided in one place

`graph-rag/src/placement.js` puts the grader's verdict, the derived-data
floor and the hold for an ungraded entry together. A write, a regrade and a
worker's write all use it (`place`, `applyFloor`, `floorLifts`).

### Ungraded is a status, not a move a person undoes

Before, an entry written while the grader was out was held one level up and a
"move it back" proposal was queued for an admin. Now it's held the same way
(nothing widens while nobody has judged it), but marked `_ungraded` with
what's needed to grade it later: its origin, the derived-data floor, and when
it was written. `regradeTick` grades waiting entries once the grader answers
and places them by the same rules, queuing a proposal only for what the
grader itself is unsure about or suggests releasing. An entry someone moved
while it waited stays where they put it.

The hold stays at one level up, rather than leaving the entry at its origin
and hiding it, because every read path filters on `_home`: hiding it would
mean a second visibility rule in every query.

### New things are made on purpose

With triage on (the master pool and a decision API key), saving a note links
it only to things that already exist. A name with no thing is kept, and once
triage has looked at the note:

- **No work needed:** it becomes a thing then, as linking would have made it.
- **Work needed:** the master's batch lists it as "not in the graph yet", and
  the worker makes it a thing with `link_things` only if it's a real person,
  place, part, order or the like.

Either way, a code that names another entry ("ux-z04" in
"ux-z04 inspect-2 new pins") is never a thing. Without triage, saving creates
things as before, with the same code guard.

## The replay harness

`graph-rag/e2e/e2e.sh` runs graph-rag from the checkout against a throwaway
ArcadeDB and fake models (`e2e/fake-models.mjs`) on a private Docker network,
then replays the failures above (`e2e/run.mjs`):

- a graded note lands at its writer's position;
- the grader out of credit: the note is held, nobody is asked to move it, and
  it's placed on its own when the grader is back;
- the linking model out of credit: the job waits with no retry spent, then runs;
- a note's own code never becomes a thing;
- the sweep embeds rows the old inline SQL couldn't parse;
- with triage, a new name becomes a thing only after triage;
- no loop is still failing at the end.

It needs only Docker, touches no running stack and calls no real model, so
it's the check to run before a live batch. It takes a few minutes, mostly
waiting out the real pause and regrade timers.

```bash
graph-rag/e2e/e2e.sh
```
