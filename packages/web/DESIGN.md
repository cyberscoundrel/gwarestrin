# Graphite: the gwarestrin web console design language

The look is quiet and precise, in the Linear/Vercel tradition. The trust strip borrows status semantics from ops consoles. Every screen is built from the tokens and patterns below. When a new screen needs something that isn't here, add it here first.

Source of truth: `src/app.css` (tokens, Tailwind mapping, component classes) and the primitives in `src/components/` (`Icon`, `StatusChip`, `PanelHeader`, `EmptyState`, `SkeletonRows`, `Dialog`, `Switch`, `ModelPicker`, `ProfilePicker`, `Dropdown`).

## Tokens

Use the Tailwind names in components (`bg-panel`, `text-dim`, `border-edge`…). Use the raw `--gw-*` variables only in `app.css`. Never write a hex value in a component.

| Role | Tailwind | Variable | Dark | Light |
|---|---|---|---|---|
| Canvas (page) | `bg` | `--gw-canvas` | `#0f1012` | `#f6f5f2` |
| Raised (rail, cards, drawers) | `panel` | `--gw-raised` | `#151619` | `#fbfaf8` |
| Overlay (menus, dialogs) | `panel2` | `--gw-overlay` | `#1a1c1f` | `#ffffff` |
| Hover fill | `hover` | `--gw-hover` | `#1e2024` | `#eeece7` |
| Selected fill | `selected` | `--gw-selected` | `#222428` | `#e7e5df` |
| Inset (inputs, code) | `inset` | `--gw-inset` | `#121315` | `#f1efeb` |
| Hairline | `edge` | `--gw-line` | `#222428` | `#e3e1db` |
| Strong hairline (controls) | `edge2` | `--gw-line-strong` | `#2c2e33` | `#d3d0c8` |
| Text, primary | `fg` | `--gw-fg` | `#e8e8ea` | `#1b1c1e` |
| Text, secondary | `dim` | `--gw-fg2` | `#9a9ca2` | `#4f5157` |
| Text, muted | `faint` | `--gw-fg3` | `#8b8d94` | `#5f6167` |
| Accent (state + focus only) | `signal`, `signal-soft`, `on-signal` | `--gw-signal` | `#2dd4bf` | `#0b6f64` |
| Success | `ok`, `ok-soft` | `--gw-ok` | `#5cc28a` | `#1f7045` |
| Warning / Cloud | `warn`, `warn-soft` | `--gw-warn` | `#d9a957` | `#8a570c` |
| Danger | `err`, `err-soft` | `--gw-err` | `#ec7f84` | `#b0373d` |
| Scrim | `scrim` | `--gw-scrim` | 50% black | 28% ink |
| Overlay shadow | `shadow-overlay` | `--gw-shadow-overlay` | one shadow, floating overlays only | |

- Every text colour passes WCAG AA (4.5:1) on every surface in its theme. Muted was lifted from the brief's `#6c6e74` to `#8b8d94` to pass.
- The theme follows `prefers-color-scheme`. An inline script in `index.html` also sets `.dark` on `<html>`, because pi-web-ui keys its dark variant off that class.
- pi-web-ui's shadcn variables (`--background`, `--card`, `--border`…) are re-pointed at these tokens in `app.css`.

## Type

- **Sans:** Inter Variable, used for all UI.
- **Mono:** JetBrains Mono Variable, only where it carries meaning: commands, output, paths, IDs, model ids, token counts.
- Both are self-hosted via `@fontsource-variable/*`, with no CDN.
- Scale: `text-2xs` 11, `text-xs` 12, `text-sm` 13, `text-base` 14 (body), `text-lg` 16, `text-xl` 20.
- Weights: 400 and 500. 600 is used only for the wordmark.
- Use the `tabular` utility for counts, sizes and tokens.
- **Copy:** sentence case for UI chrome ("New agent", "Stop agent"). The brand `ground chat` stays lowercase. Use the adopted vocabulary: agent profile, conversation, tool connection, briefing, approvals, workspace, On-prem / Cloud: vendor.

## Space, radius, elevation

- 4px base: Tailwind's 1 = 4px. The common steps are 1.5, 2, 2.5, 3, 4, 5.
- Standard paddings:
  - rail rows `px-2 py-1.5`
  - header `px-4 py-2.5`
  - drawer sections `px-4 py-3`
  - cards `p-4`
  - dialogs `p-5`
- Controls are 32px tall (`h-8`); compact ones are 28px (`h-7`).
- Radii: `rounded-md` 6 for controls and rows, `rounded-lg` 8 for cards, `rounded-xl` 10 for drawers, dialogs, popovers and the composer.
- Use hairline borders, not shadows. The single `shadow-overlay` is for floating overlays (menus, dialogs, toasts) only.

## Motion

| Use | Token / class | Spec |
|---|---|---|
| Hover, focus, press | default `transition` | 150ms, `cubic-bezier(0.2,0,0,1)` |
| Popover / menu in | `animate-pop` | 140ms fade + 4px rise |
| Drawer in | `animate-drawer`, `animate-drawer-right` | 200ms fade + 8px slide |
| Scrim | `animate-fade` | 160ms |
| New content (sent prompt, empty states, list items) | `animate-enter` | 180ms fade + 6px rise |
| Loading | `.skeleton` | calm shimmer |
| Working | `animate-working` | status-dot pulse, **only while a turn is in flight** |
| Running tool | `.gw-tool-spin` | ring spinner, only while running |

- No bounce, nothing longer than 200ms, nothing that loops while idle.
- Under `prefers-reduced-motion: reduce` every animation and transition becomes instant (a global rule in `app.css`).

## Icons

- lucide only, through `Icon.svelte`: 14–16px, stroke 1.5, `currentColor`.
- Decorative icons sit next to a visible label. Icon-only buttons get an `aria-label` and a `title`.
- No emoji in chrome.

## Component patterns

- **Rail row (agent):**
  - 16px column with a 6px status dot: `ok` running, `signal` + pulse working, `warn` + pulse starting, `err` error, `edge2` stopped.
  - The name is `text-sm fg`; the model is on a second line in `font-mono text-2xs faint`.
  - Hover uses `bg-hover`, selected uses `bg-selected` plus `aria-current`.
  - Row actions (delete) appear on hover, on focus, and always on coarse pointers.
- **Rail section (agent profile):** a quiet `text-xs faint` header with a chevron that collapses on click and a tabular count. Edit is a separate pencil icon.
- **Status chip (trust strip):**
  - `StatusChip` is 24px tall, `rounded-md`, with an icon and a short fact. The tooltip carries the detail.
  - Tones: `signal` for on-prem/trusted, `warn` for data leaving the workspace (Cloud: vendor), `err` for failure, `neutral` for facts, `quiet` for absent things.
  - A chip is clickable only when it opens something.
- **Card:** `rounded-lg border-edge bg-panel p-4`. Never add a shadow.
- **Tool card:** state glyph (spinner / ok dot / err dot), tool icon, verb ("Ran", "Wrote", "Read", "Edited"), then the command or path in mono. Output sits in a native `<details>` body with capped height. Built in `lib/tool-renderers.ts` via pi-web-ui's `registerToolRenderer`.
- **Drawer:**
  - `PanelHeader` (icon, title, one-line explanation, icon actions, close), then sections.
  - Section labels use `.eyebrow`.
  - States: `SkeletonRows` while loading, `EmptyState` when empty, `EmptyState tone="err"` or an inline alert on errors.
- **Dialog:** `Dialog` (scrim, `rounded-xl`, overlay shadow, Escape). The body is `p-5` with an icon tile, title and explanation. The footer is `border-t bg-panel px-5 py-3`, with Cancel (secondary) to the left of the primary action and destructive actions in `btn-danger-solid`.
- **Field:** `.field` > `.field-label` + control (`.input`, `.select`, `Dropdown full`, `ModelPicker`) + `.field-hint` + `.field-error`, with `aria-invalid`/`aria-describedby` on the control. Validate inline; don't disable Save.
- **Buttons:**
  - One `btn-primary` (ink on canvas) per view.
  - Use `btn-secondary` for alternatives and `btn-ghost` for quiet actions; add `btn-sm` in toolbars and footers.
  - Accent-tinted buttons (`signal-soft`) are only for "start", which is a state change.
- **Switch / segmented:** `Switch` for on/off settings (accent fill when on); `.segmented` for 2–3 mutually exclusive modes.
- **Pickers:** `ModelPicker` is one grouped list ("On-prem", "Cloud: provider") with filter and "Free only", and the button shows the name plus a tier badge. `ProfilePicker` shows name, focus, tool chips and briefing.
- **Page document (profile editor):**
  - Sections with a title and explanation on the left third and controls on the right, collapsing to one column on narrow screens.
  - A sticky footer with the dirty state, Cancel and the primary action.

## Do / don't

- **Do** let the accent mean state or focus: running, selected, on, trusted. **Don't** use it to decorate headings, borders or hover.
- **Do** give every list an empty, a loading and an error state. **Don't** show "empty" before the first load has settled.
- **Do** keep one primary action per view, and keyboard hints muted. **Don't** put two buttons that do the same thing in one view.
- **Do** use mono for things a user might copy (commands, paths, ids). **Don't** use mono for labels or prose.
- **Do** theme pi-web-ui through its classes and variables in `app.css`, or through `registerToolRenderer`. **Don't** fork the library.
- **Do** check desktop, 768 and 375, light and dark, and reduced motion. **Don't** ship anything that scrolls sideways at 375px.
