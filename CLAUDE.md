# linear-tui

A full-screen terminal app (Bun + TypeScript + Ink 8) showing my Linear issues from all active cycles. macOS only. See `README.md` for setup and keys.

## Commands

- `bun run start` runs the app (needs a real terminal; Ink uses raw mode)
- `bun run typecheck` and `bun run lint` must both be clean before committing
- Use `bun`, not npm/node

## Layout

- `index.tsx` entry point. Renders `<App />` with `alternateScreen: true`.
- `src/linear.ts` DATA layer: Keychain key, GraphQL fetch, grouping/sorting, cycle progress, estimate and due-date formatting. Returns plain values only. No terminal or styling code here.
- `src/components.tsx` visual pieces (`IssueRow`, `GroupHeader`, `CycleHeader`).
- `src/app.tsx` state, keyboard handling, scrolling, screen layout.
- `src/detail.ts` DETAIL data: fetches one issue's description + comments, orders comments as threads, wraps markdown-ish text into plain lines (`wrapText`, `renderMarkdown`, `buildBodyLines`). No styling code.
- `src/detail-view.tsx` the detail screen (pinned header, scrolling body, footer). Loads its own data.
- `src/filter.ts` FILTER logic, pure functions (`filterIssues`, `parseQuery`, `nextTeam/nextLabel/nextPriority`, `describeFilters`). The `/` search bar edits `filters.query`; `t`, `p`, `L` cycle the other filters. `app.tsx` has a second `useInput` for the search bar, active only while `searching`, where every key is text.
- `src/keys.ts` `expandBurst()`: see the input gotcha below.
- `src/theme.ts` the few colors Linear's API doesn't provide.
- `src/open.ts` opens links with macOS `open` (https only).

## Conventions and gotchas

- **Colors come from Linear's own palette** (`state.color`, `labels.color` from the API), not the Undercurrent design system. The few in `theme.ts` (urgent orange, bar gray, overdue red) were matched by eye, not sampled.
- **Estimates follow each team's scale** via `team.issueEstimationType`. PD and UC are T-shirt (XS=1, S=2, M=3, L=5, XL=8). 0 or null means no estimate.
- **Flexbox: set `flexShrink={0}` on anything with a fixed size.** Ink shrinks children by default, which wrapped issue IDs and squashed two-line rows (their detail line spilled onto the next row). Fixed-width columns and stacked row blocks all need it.
- **Scrolling works in whole items**, not lines. `issueHeight()` in `components.tsx` must match when `IssueRow` draws its detail line.
- **Selection is tracked by key** (`issue:PD-3066`, `group:Todo`), not by index, so it survives refreshes.
- **Issue text is untrusted.** Titles, labels and so on are written by other people, so `fetchIssues` runs everything through `cleanText()` (strips control characters and bidi overrides) and `safeColor()` (only `#rrggbb`) before any other code sees it. Don't render a raw API string; add new string fields to `sanitizeIssue`. Ink strips some escape sequences itself but keeps style and hyperlink ones, so don't rely on it.
- **Ink delivers a burst of keys as ONE string.** If several characters arrive in a single chunk (held key, fast typing), the `useInput` handler is called once with `"jjj"`, not three times, so `input === "j"` silently does nothing. Route handlers through `expandBurst()`, which repeats only navigation keys (never `o`, `r`, `q`, so a paste can't trigger actions). When testing with `rex send-key a b c`, remember the keys go out together.
- **Wrap text yourself** (with `Bun.stringWidth`, not `.length`, since CJK and emoji take 2 columns) so scrolling knows the exact line count. Comments arrive newest-first and flat; `fetchIssueDetail` reorders them into threads.
- **Regexes run on untrusted text must be linear.** Use bounded quantifiers (`[^\]]{0,200}`, not `[^\]]*`) and cap input size: 100 KB of unclosed `![` took ~3.5 s with open-ended ones. See the caps and bounds in `detail.ts` and `MAX_QUERY_CHARS` in `filter.ts`.
- Long text from the API goes through `cleanMultiline()` (keeps newlines); short strings through `cleanText()`.
- `tsconfig` has `noUncheckedIndexedAccess`: `array[i]` may be undefined, so handle it.
- Ink 8 is newer than most references. Check `node_modules/ink/readme.md` for exact APIs instead of guessing.
- The API key lives only in the macOS Keychain (service `linear-api-key`). Never write it to a file, env var, log, or chat.

## Testing in Rex

Run the app in a Rex pane and drive it: `rex send-key -b BLOCK j tab enter` (capitals need `shift+g`), then `rex capture -b BLOCK` to read the screen. `rex capture --format=vt` shows the terminal's real state, which is what exposed overlapping rows once.
