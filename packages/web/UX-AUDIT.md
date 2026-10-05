# gwarestrin web console: UX audit (round 1)

Branch `ux/polish-1`, 2026-10-05. Scope is `packages/web` only.

## How this was tested

- The admin instance on the homelab (`http://100.96.0.10:3000`) could not be reached during the session. The host answered ping and SSH, but TCP 3000 timed out on every try. So **no real agent was run and no homelab resources were used.**
- To still see every screen, I used a throwaway mock of the REST + WS surface. It lives in the session scratchpad and is not committed. It has fake providers (a `llama-local` tier with a gguf path id, and `openrouter` with `:free` models), two profiles (`Default`, `sql-analyst` with graph-rag), three MCP servers (one with a very long name and URL, one unreachable) and one synthetic review-queue item. Its fake agent streams text, makes one `bash` tool call and can raise an extension `confirm` dialog.
- Dev loop: `GW_BACKEND=<url> GW_DEV_USER=ux-admin npm run dev:web`. The proxy target and the identity header now come from env (commit 1).
- I checked desktop (~1000px), tablet (768) and mobile (375, touch emulation), and emulated light and dark color schemes. I read the console at each step.
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
| 17 | MCP panel vs profile editor | The profile says "MCP servers (fixed at agent creation)", but the agent's MCP panel lets you toggle them later. The footer says "(restarts it)". | Contradictory copy about tool access. | Proposal **P-3**. | proposal |
| 18 | Composer | There is no name field. The agent is named after the first ~32 characters of the prompt ("ux-demo list the wo…"). The code already has unused `name` state. | Agents end up with sentence-fragment names in the rail. | Proposal **P-5**. | proposal |
| 19 | Rail profile headers | Clicking a profile name opens the profile editor. Most people expect that to select or collapse the group. ✎ beside it does the same thing. | A non-technical user lands in a settings form by surprise. | Proposal **P-2**. | proposal |
| 20 | The whole app | Dark only: `<html class="dark">` and `color-scheme: dark` are hard-coded, so a light OS preference is ignored. | Some audiences (projectors, printed screenshots) need light. | Proposal **P-6** (needs a palette). | proposal |
| 21 | Model picker and composer | Tiers show as "local" / "cloud" with provider ids ("llama-local", "openrouter") and raw model ids. Nothing shows *where the data goes*. | Data control is the pitch, and it is invisible. | Proposal **P-1**. | proposal |

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
| 30 | Naming drift | The button says "files" and the panel says "workspace". The button says "context" and the panel says "standing context". "graph review" vs "graph write approvals". | proposal **P-4** (vocabulary) |
| 31 | Profile dropdown | "⚙" after a name means "has a context engine". It is not explained. | proposal **P-1/P-4** |
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

## Proposed vocabulary

Pick one word per concept and use it everywhere: UI copy, headings, tooltips and docs.

| Concept (code) | UI term | One-line definition shown in the UI | Where it should appear |
|---|---|---|---|
| instance (tenant) | **Workspace** (or "Organisation" if you sell to multi-team customers) | "Your private gwarestrin deployment: its agents, tools, models and knowledge graph." | Top of the rail under the brand ("Acme · workspace"), browser title, offline banner. It is never shown today. |
| profile | **Agent template** | "Defaults for new agents: model tier, allowed tools, knowledge context." | Rail group headers, composer ("Template"), editor title "Edit template". "Profile" reads like a user profile. |
| agent | **Agent** | "A persistent AI worker with its own sandbox, files and history." | As now. |
| sandbox (gondolin VM) | **Sandbox** | "Isolated machine the agent runs in; it can only reach approved hosts." | Agent header status ("sandbox running"), dialogs that ask for network access. |
| session | **Conversation** | "One thread of messages with an agent. Start a new one any time; files stay." | Session menu becomes "Conversation ▾ / New conversation / Branch from here / Summarise to save space". |
| MCP server | **Tool connection** (keep "MCP" as a small technical tag) | "An external system the agent may use (database, GitHub, files…)." | Drawer button "Tools", the template editor's "Allowed tools", composer chips under a "Tools" label. |
| MCP registry | **Tool catalogue** (admin) | "All tool connections this workspace knows about." | A separate admin page, not the per-agent drawer (P-3). |
| provider / tier | **Model** + **Where it runs**: "On-prem (private)" / "Cloud: <vendor>" | "On-prem: data never leaves your network. Cloud: prompts are sent to <vendor>." | Model pickers, rail model line, agent header badge. |
| context engine | **Knowledge briefing** | "Before the agent starts, it reads the knowledge graph and writes a briefing it always keeps in mind." | Template editor section, context drawer ("Briefing"), the "⚙" marker replaced with a "briefing" tag. |
| standing context | **Briefing** | as above | Context drawer title, button "Briefing". |
| shared tools (`/tools`) | **Shared scripts** | "Scripts agents can save and reuse across the workspace." | Template editor checkbox. |
| graph review queue | **Approvals** | "Changes agents want to make to the knowledge graph. Nothing is written until someone approves." | Rail button "Approvals (3)" with a count; dialog title. |

## Open proposals (need a decision; not implemented)

- **P-1 Data-control badge per agent.** Put a compact "trust strip" in the chat header and the rail: where the model runs (On-prem / Cloud: vendor), how many tools are allowed and which ones, and whether a briefing is attached. This is the security pitch made visible. It needs the agent's tier (already in `/api/providers`) and its MCP list (already on the record). Web only, but it is a new UI element.
- **P-2 Rail interaction.** Clicking a template header should collapse or expand the group; only ✎ opens the editor. Optionally add "+ agent from this template" on hover. This changes existing behaviour.
- **P-3 Split tool scope.** The agent drawer only toggles that agent's tools, within what its template allows. Registry add/edit/delete moves to an admin "Tool catalogue" screen. Also fix the contradictory "fixed at agent creation" copy once the intended rule is confirmed (can agent tools change after creation or not?).
- **P-4 Adopt the vocabulary above.** These are renames of core concepts, so they need your sign-off and should be done in one pass.
- **P-5 Optional name field in the composer.** It is prefilled from the template prefix, with the prompt-derived name as the placeholder.
- **P-6 Light theme.** The tokens already exist in `@theme`. It needs a light palette, removing the hard-coded `class="dark"`, and checking pi-web-ui's light styles.
- **P-7 Tool-call copy.** Override pi-web-ui's "Running command..." for finished calls, either through its i18n or a custom renderer.
- **P-8 One stop button.** Keep the composer's stop button and drop the model-bar duplicate, or the other way round.
- **P-9 Approvals badge and readable items.** Show a pending count on the rail button. Show "requested by <agent> · 5 min ago", and a short summary of the write ("create Customer 'Acme'") above the raw statement.
- **P-10 Agent header.** Give the chat view a title row: agent name, template, status and a stop/start control. Today the name only appears in the rail (and, after fix 11, the mobile header).
