# gwarestrin web console: UX audit (rounds 1 and 2)

Round 2 adopted the vocabulary and the tool-scope rule, and added the chat header with the trust strip. Those parts are in the sections at the end. The findings table below is round 1, with the statuses updated.

Branch `ux/polish-1`, 2026-10-05. Scope is `packages/web` only.

## How this was tested

- The admin instance on the homelab (`http://100.96.0.10:3000`) could not be reached during the session. The host answered ping and SSH, but TCP 3000 timed out on every try. So **no real agent was run and no homelab resources were used.**
- To still see every screen, I used a throwaway mock of the REST + WS surface. It lives in the session scratchpad and is not committed. It has fake providers (a `llama-local` tier with a gguf path id, and `openrouter` with `:free` models), two profiles (`Default`, `sql-analyst` with graph-rag), three MCP servers (one with a very long name and URL, one unreachable) and one synthetic review-queue item. Its fake agent streams text, makes one `bash` tool call and can raise an extension `confirm` dialog.
- Dev loop: `GW_BACKEND=<url> GW_DEV_USER=ux-admin npm run dev:web`. The proxy target and the identity header now come from env (commit 1).
- I checked desktop (~1000px), tablet (768) and mobile (375, touch emulation), and emulated light and dark color schemes. I read the console at each step.
- **Round 2 also needs a live check:** the header's start/stop against real sandboxes (stop takes time, and the status should step through starting/stopped over the WebSocket), that `contextStatus` and `tier` are actually filled in on the admin instance's records and providers, and the restart that happens when a tool connection is toggled.
- **Still needs a live check against the real backend:** real streaming timing, long tool output, the context-engine create path ("analyze & start"), and real extension dialogs.

Screenshots of the issues as found (before the fixes) are in `ux-audit/`. They show mock data.

## Ranked findings

Status: **fixed** = committed on this branch. **proposal** = needs a decision, see the end of this file.

### P0: broken

| # | Where | What I saw | Why a business viewer cares | Fix | Status |
|---|---|---|---|---|---|
| 1 | Create agent → chat | The first prompt typed in the composer disappears from the transcript. The agent replies to a question the viewer can no longer see, until a reload (`01`). Cause: the adapter's `get_messages` snapshot arrives after the optimistic append and overwrites it. | It is the first thing anyone does in a demo, and the transcript looks wrong. | Merge messages appended locally while the snapshot was in flight (`rpc-agent-adapter.ts`). | fixed |
| 2 | Files / MCP / context drawer at ≤900px (phones and portrait tablets) | The fixed 20rem drawer sits beside the chat and squeezes the transcript and composer into a column one letter wide (`02`). | The app looks broken on any phone or tablet. | The drawer overlays the chat below 900px. | fixed |
| 3 | Standing-context drawer | Its ✕ button does nothing, because `onclose` was never passed. | A dead control. | Wired it up and labelled it. | fixed |

### P1: confusing or ugly

| # | Where | What I saw | Why it matters | Fix | Status |
|---|---|---|---|---|---|
| 4 | Every styled dropdown | The chevron is drawn on top of the end of the label ("Qwen3 Coder (free)", "openrouter", "cloud") (`05`). `@apply px-*` was resetting the chevron padding. | Looks unfinished everywhere. | Padding is now declared after the shorthand. | fixed |
| 5 | Composer at 375px | The model dropdown runs off-screen and the page scrolls sideways (`04`). On desktop there are big gaps between the tier, provider and model pickers. | The create flow is broken on phones and sloppy on desktop. | Added a `full` prop to `Dropdown`, clamped the grid track, and let the model picker wrap onto its own row. | fixed |
| 6 | Profile editor | The default-model picker sticks out of the card (`06`). | Sloppy. | Same `full` sizing. | fixed |
| 7 | Profile editor | The local/cloud toggle decides a provider's tier from whether its id contains "local", so `ollama` or `lmstudio` would be listed under cloud. | Mislabels where data goes, which is the security selling point. | Uses `ProviderView.tier`. | fixed |
| 8 | Chat toolbar on phones | A long model name overlaps the session/files/mcp buttons (`03`). | Looks broken. | The wrapper can now shrink and the name truncates. | fixed |
| 9 | Agent rail | Delete (✕) only appears on mouse hover, so touch and keyboard users cannot delete an agent. | Missing function on tablets. | Shows on focus-within and always on coarse pointers. | fixed |
| 10 | Mobile drawer | "graph review" is pushed below the fold. The shell uses 100vh, which phones measure behind their toolbars (`07`). | The review queue can't be found on phones. | Drawer is a flex column; shell uses `dvh`. | fixed |
| 11 | Mobile header | Always says "ground chat", with nothing showing which agent's chat is open. | Disorienting. | Header shows the agent name or "edit profile". | fixed |
| 12 | Backend down | The rail says "no agents" and the dropdowns show "—". The only explanation is a 7px red dot (`08`). There is also an unhandled promise rejection in the composer. | Looks like an empty or broken install, which is the worst first impression. | A banner appears after 2s of disconnection, and the composer catches the error. | fixed |
| 13 | Graph review | approve/reject ignore the HTTP status, so a failure looks like success. A failed load shows "no review surface configured". The payload scrolls sideways, so a reviewer can't read the whole write (`09`). | This is the human approval step, a key trust feature. A silent failure or a half-read statement is bad. | Responses are checked, the error is shown, and the payload wraps. | fixed |
| 14 | Delete / graph review / session menu | Escape does nothing. Other popovers already close on Escape. | Inconsistent. | Escape now closes them; added dialog labels and `aria-expanded`. | fixed |
| 15 | Extension dialogs | "allow network access?" pops up over any view without saying which agent is asking (`10`). | With several agents the user can't make an informed security decision. | Shows "request from agent X"; the dialog is sized to the viewport. | fixed |
| 16 | MCP panel | Per-agent toggles sit right next to registry-wide edit and delete. ✕ removes the server for **every** agent, and its tooltip just says "delete" (`11`). | It is easy to break other agents by accident, and the scope can't be explained in a demo. | Labels and tooltips now say "registry (all agents)". Splitting the panel is proposal **P-3**. | partly fixed |
| 17 | MCP panel vs profile editor | The profile says "MCP servers (fixed at agent creation)", but the agent's MCP panel lets you toggle them later. The footer says "(restarts it)". | Contradictory copy about tool access. | Round 2: copy rewritten to match the agreed rule (see "Tool-scope rule"). | fixed (round 2) |
| 18 | Composer | There is no name field. The agent is named after the first ~32 characters of the prompt ("ux-demo list the wo…"). The code already has unused `name` state. | Agents end up with sentence-fragment names in the rail. | Proposal **P-5**. | proposal |
| 19 | Rail profile headers | Clicking a profile name opens the profile editor. Most people expect that to select or collapse the group. ✎ beside it does the same thing. | A non-technical user lands in a settings form by surprise. | Proposal **P-2**. | proposal |
| 20 | The whole app | Dark only: `<html class="dark">` and `color-scheme: dark` are hard-coded, so a light OS preference is ignored. | Some audiences (projectors, printed screenshots) need light. | Proposal **P-6** (needs a palette). | proposal |
| 21 | Model picker and composer | Tiers show as "local" / "cloud" with provider ids ("llama-local", "openrouter") and raw model ids. Nothing shows *where the data goes*. | Data control is the pitch, and it is invisible. | Round 2: "On-prem" / "Cloud: <provider>" labels and the trust strip (P-1). | fixed (round 2) |

### P2: polish

| # | Where | What | Status |
|---|---|---|---|
| 22 | Model picker | Showed full gguf paths and a 🧠 emoji while the button showed cleaned-up names. Now uses `modelDisplayName`, a "reasoning" tag, and the full id in a tooltip. | fixed |
| 23 | Icon-only controls | ✎/✕/● had no accessible names. The connection dot said "ws: closed". Labelled them; drawer toggles expose `aria-pressed`. | fixed |
| 24 | Files panel | Delete was hover-only. It now shows on focus and touch, and is named per file. | fixed |
| 25 | Composer | "⌘/ctrl+enter" hint shown on touch devices. Now hidden there. | fixed |
| 26 | Dropdown | Accessible name now includes the current value ("provider: openrouter"). | fixed |
| 27 | Tool calls (pi-web-ui `BashRenderer`) | A finished command still says "Running command..." (only the icon turns green). This is upstream copy. | proposal **P-7** |
| 28 | Chat | Two stop buttons while streaming: the model bar's red "stop" and the composer's square. | proposal **P-8** |
| 29 | Context drawer footer | "(context-injection.md)" is developer jargon. | proposal (copy) |
| 30 | Naming drift | The button says "files" and the panel says "workspace". The button says "context" and the panel says "standing context". "graph review" vs "graph write approvals". | fixed (round 2 vocabulary) |
| 31 | Profile dropdown | "⚙" after a name means "has a context engine". It is not explained. | fixed (round 2): now "· briefing" |
| 32 | Graph review | Raw `#41:7` record ids and ISO timestamps. There is no pending-count badge on the rail button, so pending writes go unnoticed. | proposal **P-9** |
| 33 | Session menu | "clone branch", "compact context" and "fork from message" have no explanations. | proposal (tooltips) |
| 34 | Profile editor | Once a tier is picked it can't be cleared back to "server default". | proposal |

## Screens and flows walked

1. **First run / greeting**: centered greeting with the user name from `/api/me` via the injected header. Profile and model pickers. Empty-rail state ("no agents" per profile).
2. **Create agent via composer**: profile switch updates the tool chips and the model defaults. "analyze & start" appears for engine profiles. Cmd+Enter works. Findings 1, 4, 5, 18.
3. **Chat**: streaming text, a `bash` tool call and its result, the second turn, and the stop button while streaming. Findings 1, 27, 28.
4. **Model bar**: picker grouped local/cloud, switching model, thinking level, context meter. Findings 8, 21, 22.
5. **Sessions menu**: new / clone / compact / fork list. Finding 14 (Escape), 33.
6. **Files panel**: listing, long filename truncation, upload / mkdir controls. Findings 2, 24.
7. **MCP panel**: reachability dots, profile-locked badge, registry add/edit/delete. Findings 16, 17.
8. **Context drawer**: profile, engine, status, block. Findings 3, 29.
9. **Profile editor**: tiers, provider and model, MCP allow-list, engine, shared tools. Findings 6, 7, 19, 34.
10. **Graph review queue**: viewed only; I did not approve or reject anything. Findings 13, 32.
11. **Delete agent**: modal with export trace. Only mock `ux-` agents were deleted. Finding 14.
12. **Extension dialogs**: a confirm dialog raised by the mock. Finding 15.
13. **Backend down**: finding 12.
14. **Mobile / tablet**: findings 2, 5, 8, 9, 10, 11.
15. **Light scheme**: finding 20.

## Vocabulary (adopted, round 2)

The user approved these terms. They are **UI labels only**: code identifiers, API fields, routes and store keys are unchanged. The UI keeps its lowercase style for running copy. Tier badges use the exact forms "On-prem" and "Cloud: <vendor>".

| Concept (code) | UI term | Meaning | Where it appears now |
|---|---|---|---|
| instance (tenant) | **workspace** | Your private gwarestrin deployment: its agents, tool connections, models and knowledge graph. | Offline banner, profile editor ("allow all workspace connections", shared /tools), tools drawer, approvals empty state. The agent's own file browser is now "files", so "workspace" only means the instance. |
| profile | **agent profile** | A group of agents that share a contextual focus and tooling: which tool connections they may use, a default model, an optional briefing. | Rail headers, "+ new agent profile", composer label, editor title ("edit agent profile — x"), chat header ("agent profile sql-analyst"), confirms, aria-labels. |
| agent | **agent** | A persistent AI worker with its own sandbox, files and conversations. | Unchanged. |
| session | **conversation** | One thread of messages with an agent. | Toolbar menu "conversation" (new / clone / compact / fork), delete dialog, "export conversation". |
| MCP server | **tool connection** | An external system an agent may use (database, GitHub, files…). | Drawer button "tools", drawer heading, profile editor "allowed tool connections", composer "tools:" chips, trust strip, confirms. |
| provider tier | **On-prem** / **Cloud: <vendor>** | Where the model runs. On-prem: on your own infrastructure. Cloud: prompts are sent to that provider. | Composer and profile-editor tier pickers ("On-prem" / "Cloud"), model picker groups ("On-prem", "Cloud: openrouter"), trust strip. |
| context engine / context injection | **briefing** | Before an agent starts, the knowledge graph is summarised into a briefing the agent keeps in mind on every turn. | Drawer button and heading "briefing", composer ("build briefing & start", "· briefing" profile tag replacing "⚙"), profile editor section, trust strip. |
| graph review queue | **approvals** | Changes agents want to write to the knowledge graph; nothing is written until someone approves. | Rail button "approvals", dialog title and empty/error states. |

Not decided yet, so these keep their current wording: "sandbox" (used in a few tooltips and the status line), the MCP registry (described as "the workspace" in copy), and "shared /tools directory".

## Tool-scope rule (round 2)

**Rule:** the agent profile defines which tool connections its agents may use at all. Each allowed connection has a configurable default (on/off). An agent can only toggle within the allowed set.

**What the current API can express** (read from `packages/server`, which I did not change):
- `ProfileRecord.mcpServers` is the allowed set: a list of names, or `"all"`.
- At creation, the server switches on every allowed connection (`manager.ts`: `defaults.mcpServers = profile.mcpServers === "all" ? all registry : profile.mcpServers`).
- `AgentRecord.mcpServers` is the agent's switched-on set, changed with `PATCH /api/agents/:id` (this restarts the agent).

**What the UI now says:**
- Profile editor: "allowed tool connections", with an explanation that a new agent starts with every allowed connection switched on, and each agent can switch them off and on in its tools drawer but never beyond the list. The choices are "allow all workspace connections" (which also allows connections added later) and "allow only selected…".
- Tools drawer: allowed connections come first. The footer names the agent profile that sets the limit. Connections outside the set are marked "not allowed" and can't be switched on. One that is already on but no longer allowed (because the profile changed) can still be switched off.

**API change needed (proposal P-11, backend):**
- Add a per-connection default to the profile, e.g. `mcpDefaults: Record<name, boolean>`, or change `mcpServers` to `Array<{ name, defaultOn }>`. Create-time would then switch on only the connections whose default is on.
- Enforce the allowed set on `PATCH /api/agents/:id`. Today only the UI blocks switching on a connection the profile doesn't allow.
- Until both exist, the UI does not offer a per-connection default toggle, so it doesn't fake behaviour the server lacks.

## Trust strip and chat header (P-1 and P-10, implemented in round 2)

The new `AgentHeader.svelte` sits above the chat toolbar and is shown whether the agent is running or stopped. It contains:
- The agent name (hidden on phones, where the app header already shows it), its **agent profile**, and its status (running / working / starting / stopped / error).
- **start agent / stop agent**, using the existing `/api/agents/:id/start` and `/stop`.
- The **trust strip**:
  - **Where the model runs:** "On-prem" in green or "Cloud: <provider id>" in amber. It is derived from the agent's model provider and that provider's declared `tier`, falling back to the workspace default model. The tooltip names the model.
  - **N tool connections:** the agent's switched-on set; the tooltip lists them.
  - **briefing / briefing failed / no briefing:** from `AgentRecord.contextStatus` plus the profile's `contextEngine.type`.
  - While the agent runs, the tools and briefing chips open their drawers.

**Gaps (proposal P-12):**
- **Vendor name:** "Cloud: <vendor>" uses the provider *id* (e.g. `openrouter`). OpenRouter routes to many upstream vendors, so the real recipient of the data isn't known to the UI. Needed: a display name per provider (and ideally the upstream vendor per model) in `ProviderView`.
- **Live vs declared model:** the strip uses the *declared* model on the record. The model bar can show a live model the agent switched to over RPC. Model-bar changes are persisted with PATCH, so the two normally agree.
- **Sandbox network allow-list:** `gondolin.allowedHosts` is on the record and would complete the picture ("can reach: api.github.com, …"). I left it out to keep the strip short; it needs a decision on how to present it.
- **Briefing on old records:** `contextStatus` may be absent on agents created before it existed. Those show "no briefing".
- **Rail:** the strip is only in the chat header. A small On-prem/Cloud tag on each rail row is a possible follow-up.

## Open proposals (need a decision; not implemented)

- **P-1 Trust strip:** implemented in round 2, see above. Gaps are in P-12.
- **P-2 Rail interaction.** Clicking an agent profile header should collapse or expand the group; only ✎ opens the editor. Optionally add "+ agent in this profile" on hover. This changes existing behaviour.
- **P-3 Split tool scope:** the copy is done in round 2. Still open: move workspace-wide add/edit/remove of tool connections out of the per-agent drawer into an admin screen. Today ✎/✕ are only labelled "workspace-wide, all agents".
- **P-4 Vocabulary:** adopted in round 2.
- **P-5 Optional name field in the composer.** It would be prefilled from the profile's name prefix, with the prompt-derived name as the placeholder. (Round 2 note: a profile prefix like `sql-` is prepended to the derived name, so an agent created from prompt "ux-scope …" was named `sql-ux-scope-list-files`.)
- **P-6 Light theme.** It needs a light palette, removing the hard-coded `class="dark"`, and checking pi-web-ui's light styles.
- **P-7 Tool-call copy:** done in round 3. Our own renderers are registered through pi-web-ui's public `registerToolRenderer`, so no fork.
- **P-8 One stop button.** The model bar's "stop" (interrupt the current reply) and the composer's square do the same thing. Round 2 added "stop agent" in the header (stop the sandbox), so the labels need to stay distinct, e.g. "interrupt" vs "stop agent".
- **P-9 Approvals badge and readable items.** A pending count on the rail button, "requested by <agent> · 5 min ago", and a short summary of the write above the raw statement.
- **P-10 Agent header:** implemented in round 2.
- **P-11 Per-connection default and server-side allow-list enforcement** (backend), see "Tool-scope rule".
- **P-12 Trust-strip data gaps** (provider display name / upstream vendor, sandbox network allow-list), see above.
- **P-13 Phone toolbar density.** On a 375px screen the header, trust strip and toolbar together take about 190px. Collapse the model/thinking/conversation controls into one "⋯" menu below 600px. (Round 3 gave the model name its own full-width row so it is readable, which makes the toolbar one row taller.)
- **P-14 Pricing data for models** (backend). OpenRouter's discovered catalogue has `cost` set to all zeros, so the UI can only treat `:free` ids as free. Every other model may be billed, but nothing says so. Fill `ModelView.cost` from the provider's pricing so the pickers can show price and warn before choosing a paid model.
- **P-15 Landing selection:** done in round 4. The app now lands on the composer unless this browser previously opened an agent that still exists (remembered in localStorage). The 15s poll never auto-selects. Deleting the open agent returns to the composer. There is no URL deep-linking in the app; rail selection works as before.

## Round 3: real-backend findings (admin instance, main's backend)

**Fixed on this branch:**
- **Conversation rendered N times after a reload** (a regression from my bootstrap merge). Overlapping bootstraps each appended the whole snapshot again. Fixed with a generation token, explicit tracking of optimistic prompts, and structural dedupe. Covered by a vitest unit test (`npm test -w @gwarestrin/web`). Three reloads of a 28-message conversation rendered 28 messages each time.
- **Sandbox status overlapped "approvals":** the "sandbox: running" text moved into the agent header and is now tracked per agent.
- **464-model picker:** type-to-filter plus a "free only" toggle in the composer, profile-editor and chat pickers. The composer also now defaults to a `:free` model instead of the catalogue's first entry, which is billed.
- **Phone model name** truncated to "nem…": the model bar now gets its own row.
- **Profile editor:** the state warnings were a real bug, fixed. Opening ✎ after "+ new agent profile" showed an empty "new" form, and saving it would have created a new profile. Editing a second profile kept the first one's values.
- **Tool cards:** write/read/edit now render readable cards instead of raw JSON, and bash says "Ran command" once it finishes.

**Backend issues found (no web change; the server needs fixing):**
- **B-1, the write tool stores file contents base64-encoded (data corruption).**
  - The agent called `write` with `hello from ux test` (18 bytes). The tool reported "Successfully wrote 18 bytes", but the file on disk is the 24-byte base64 `aGVsbG8gZnJvbSB1eCB0ZXN0`.
  - This is confirmed by `read`, `wc -c`, `ls -l`, the files API listing and a download.
  - The files drawer's size label is correct; it shows the real (encoded) size. The 20-byte write that showed 28 B in the coordinator's check is consistent with this: base64 of 20 bytes is 28 characters.
  - It is most likely in the write path that bridges file writes into the gondolin VM, where the payload is not decoded.
- **B-2, `POST /api/agents/:id/stop` doesn't stop the agent: it restarts it.**
  - Polling after a stop showed `stopped`, then `error`, then `running` within about 4 seconds, with "Gondolin VM ready" again.
  - `manager.stop()` deletes the agent from `running` before killing it, and `onExit` only treats a SIGTERM/SIGKILL *signal* as deliberate. The VM wrapper apparently exits with a normal exit code, so the stop is counted as a crash and the auto-restart kicks in.
  - The header's "stop agent" button is affected (main has no stop button, so this was latent). Until it is fixed the button gives a misleading result. Decision needed: hide it until the backend fix lands, or keep it.

**Round 4 status:**
- B-1 (base64 `write`) and B-2 (stop counted as a crash and auto-restarted) are being fixed in the backend on `fix/main-bugs`. No UI change is needed.
- The header's "stop agent" button stays, by decision. Re-check stop against the backend once `fix/main-bugs` lands.
- P-15 is done (see above).
- P-14 (model pricing data) is still open.
