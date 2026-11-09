# linear-tui

A full-screen terminal app (Bun + TypeScript + Ink 8) showing my Linear issues from all active cycles. macOS only. See `README.md` for setup and keys.

## Commands

- `bun run start` runs the app (needs a real terminal; Ink uses raw mode)
- `bun test`, `bun run typecheck` and `bun run lint` must all be clean before committing
- Use `bun`, not npm/node

## Layout

- `index.tsx` entry point. Renders `<App />` with `alternateScreen: true`.
- `src/linear.ts` DATA layer: Keychain key, GraphQL fetch, grouping/sorting, cycle progress, estimate and due-date formatting. Returns plain values only. No terminal or styling code here.
- `src/components.tsx` visual pieces (`IssueRow`, `GroupHeader`, `CycleHeader`).
- `src/app.tsx` state, keyboard handling, scrolling, screen layout.
- `src/detail.ts` DETAIL data: fetches one issue's description + comments, orders comments as threads, wraps markdown-ish text into plain lines (`wrapText`, `renderMarkdown`, `buildBodyLines`). No styling code.
- `src/detail-view.tsx` the detail screen (pinned header, scrolling body, footer). Loads its own data.
- `src/filter.ts` FILTER logic, pure functions (`filterIssues`, `parseQuery`, `nextTeam/nextLabel/nextPriority`, `describeFilters`). The `/` search bar edits `filters.query`; `t`, `p`, `L` cycle the other filters. `app.tsx` has a second `useInput` for the search bar, active only while `searching`, where every key is text.
- `src/mutations.ts` the ONLY file that writes to Linear (status, priority, estimate). See "Writes" below.
- `src/edit.ts` pure logic for the edit screens (what each picker offers, current value, the exact change sent, the finishing warning). `src/edit-views.tsx` what they look like (props only). `src/edit-screen.tsx` the stateful flow: load options, pick, confirm, save, retry. Opened with `s`/`P`/`e` from the list or the detail screen.
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

## Writes (changing issues in Linear)

This is the only part of the app that changes shared company data, so treat it as high risk. Don't loosen these rules:

- All writes live in `src/mutations.ts`. Nothing else may send a mutation.
- Only three fields can change: status (`stateId`), priority, estimate. One issue per call, never a batch. Unknown fields are rejected.
- `validateChange()` runs BEFORE anything is sent. Invalid input, an unknown field, or dry-run mode must produce zero network requests (the tests assert this).
- The reply is checked against the request: `success: false` or a different value than asked for is an error, not a silent success.
- `LINEAR_TUI_DRY_RUN=1` sends nothing. Use it to try the screens. Any manual test of a real write needs the user's explicit go-ahead on a named throwaway issue.
- Statuses come from the ISSUE'S OWN team (PD and UC differ). Estimates are T-shirt teams only; other scales say "not supported".
- Finishing statuses (completed, canceled, duplicate) get an extra warning: the user's process needs a validation comment before work is called done.
- The edit screen sends nothing until Enter on the CONFIRM screen. The save is guarded three ways (the stage check in `handleKey`, the stage check in `save()`, and `savingRef`), so a second Enter can't send a second write. These overlap on purpose, so removing one alone changes nothing (an "equivalent mutant"): to test them, remove all three.
- When you manually try the edit flow in a real pane, ALWAYS start it with `LINEAR_TUI_DRY_RUN=1` and check the `DRY RUN` banner is on screen before pressing Enter on a confirm screen.

## Tests (`bun test`)

One `*.test.ts(x)` file per module. They use made-up data and a fake network, never real Linear or the Keychain, so they're fast and anyone can run them.

- `src/testing.ts` has the shared helpers: `makeIssue()`, `labels()`, `mockFetch()` (swap `fetch`; restore it in `afterEach`), and `hasControlChars()`. It is not part of the app.
- **Component tests** use Ink's `renderToString(element, { columns })`. Render inside a **column** box of the pane's width, like the real app does; a default row box lets `flexShrink={0}` children overflow and hides the bugs you're looking for. To measure how tall a component really is, stack a marker under it (`heightOf`) and see which line it lands on. `issueHeight()` and `CycleHeader`'s height must match what's drawn, because the scroll math multiplies on them.
- The squash regression needs 3 two-line rows in a 4-line box; with only 2 rows the rounding hides it.
- Time-dependent tests use `setSystemTime` and build dates in local time, so they pass in any timezone.
- `open.test.ts` spies on `Bun.spawn`, so no real browser ever launches.
- `edit-screen.test.tsx` runs the REAL `EditScreen` with Ink's `render`, a fake stdin (`FakeStdin`, a PassThrough with `isTTY`/`setRawMode`) and a fake network, sends keystrokes, and counts the write requests actually sent. It also spies on `Bun.spawn` so the Keychain read returns a fake key. Slow (about 11 s) because keys are paced; keep it that way rather than risk flaky timing. Use `mockFetch(..., { delayMs })` to hold a write in flight.
- Timing tests (ReDoS) use a generous 500 ms limit; the bug they guard took 3.5 s at 100 KB. `inline()` is exported so the regex bounds are tested **separately** from the line cap that also protects `renderMarkdown`.
- **A test that has never failed proves nothing.** When you add a safety or layout test, temporarily break the code it guards and confirm the test fails. That check found two tests that couldn't fail when this suite was written.

## Testing the real app in Rex

Run the app in a Rex pane and drive it: `rex send-key -b BLOCK j tab enter` (capitals need `shift+g`), then `rex capture -b BLOCK` to read the screen. `rex capture --format=vt` shows the terminal's real state, which is what exposed overlapping rows once.
