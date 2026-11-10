# Tangent

(Renamed from Terminal Velocity. The package is `tangent-tui`, the command is `tangent`.)

A full-screen terminal app (Bun + TypeScript + Ink 8) showing my Linear issues from all active cycles. macOS only. See `README.md` for setup and keys.

## Commands

- `bun run start` runs the app (needs a real terminal; Ink uses raw mode)
- `bun test`, `bun run typecheck` and `bun run lint` must all be clean before committing
- Use `bun`, not npm/node

## Layout

- `index.tsx` entry point and the `tangent` command (`bin` in `package.json`, `#!/usr/bin/env bun`, must stay executable). Handles `--help`/`--version` first, then loads the UI with `await import` (so those flags never touch raw mode) and renders `<App />` with `alternateScreen: true`.
- `scripts/build.ts` builds the single-file macOS binaries (`bun run build [darwin-arm64|darwin-x64]`, output in `dist/`). Build tool only; nothing in `src/` imports it. Two things it does that look odd but are needed: it stubs `react-devtools-core` (Ink loads it on demand; without the stub the binary crashes at startup) and it re-signs each binary with `codesign` (compiling breaks the signature and macOS then kills the binary), so it only runs on macOS. x64 uses Bun's baseline build so it runs on older Intel Macs and under Rosetta.
- `scripts/release.ts` the small checks the release workflow runs: `checkTag` (tag must be `vX.Y.Z[-pre]` and equal `package.json`'s version), `isPrerelease`, `sha256Sums` (the `SHA256SUMS` text; refuses if a binary is missing). Kept as code, not shell in the YAML, so it is tested.
- `.github/workflows/release.yml` publishes a GitHub Release when a `v*` tag is pushed: refuses a tag not on `main` or not matching `package.json`, runs lint + typecheck + tests, builds, writes `SHA256SUMS`, attests build provenance, then `gh release create`. It then runs the arm64 binary with `--version` and checks it prints the tag's version (the x64 binary is NOT run in CI: the runner is Apple Silicon and may lack Rosetta). **To release:** on `main` after `git pull`, `npm version patch` then `git push origin main --follow-tags`. If `main` ever requires PRs (a ruleset called "Protect" exists but is disabled): bump with `npm version patch --no-git-tag-version` in a PR, merge it, then on `main` `git tag vX.Y.Z && git push origin vX.Y.Z`. Always tag the commit that is ON `main`: a tag made on a PR branch is refused after a squash merge, because the squash rewrites the commit. A tag like `v0.2.0-rc.1` publishes a pre-release (`package.json` must carry the same version), and GitHub's "latest release" SKIPS pre-releases, so install an rc with `TANGENT_VERSION=v0.2.0-rc.1`; the plain one-line install 404s until a non-rc release exists. Rules for editing the workflow, all enforced by `scripts/release.test.ts`: actions pinned to full commit SHAs, Bun pinned to an exact version (the one the binaries are tested with), nothing from `${{ }}` pasted into a `run:` script (pass it through `env:`), no permissions beyond the job's three, a `timeout-minutes` on the job, and the smoke test between the build and the checksums. The first real run needs a real tag, so it can't be tried in a test.
- `install.sh` the one-line installer (`curl -fsSL …/install.sh | sh`). POSIX `sh`, no sudo, installs to `~/.local/bin`. Downloads `tangent-darwin-<arch>` and `SHA256SUMS` from the latest (or a named) release and refuses to install on a checksum mismatch or missing entry. Rules when editing it: everything stays inside `main()`, called on the LAST line (a cut-off download then runs nothing; a test cuts it every 100 characters), it must pass `shellcheck -s sh` and run under `dash`, and the file names it asks for must match `binaryName()` in `scripts/build.ts`. A Rosetta shell reports x86_64 on Apple Silicon, so it asks `sysctl sysctl.proc_translated`. `mktemp` gets an explicit `${TMPDIR}` template because macOS's bare `mktemp -d` ignores `TMPDIR`. The checksum only proves the download is intact, not that the release is genuine (that is what the provenance attestation is for). So it runs the STAGED binary with `--version` before renaming it into place (a binary that fails or prints nothing is refused and never replaces a working install; keep that check as its own statement, because a failing `$(...)` inside another command's arguments does not stop `set -e`). `curl` gets `--proto-redir` as well as `--proto`, since `--proto` only limits the first request and redirects default to allowing plain http. The exit trap removes the staging file too. `scripts/install.test.ts` runs the real script against a fake release server, with stand-in `uname`/`sysctl`/`curl` first on `PATH`; macOS only. The same file checks that the README's Install section quotes the same curl command, setting names and binary names as the script, so change them together.
- `src/cli.ts` command-line arguments: `userArgs`, `parseArgs`, `helpText`, `versionText`. Pure; unknown options are an error, never a silent start. The version comes from `package.json`. `userArgs` exists because of a Bun 1.2.21 quirk: a compiled binary run with NO arguments gets its own path as a fake first argument, so don't read `process.argv.slice(2)` directly.
- `src/linear.ts` DATA layer: Keychain key, GraphQL fetch, grouping/sorting, cycle progress, estimate and due-date formatting. Returns plain values only. No terminal or styling code here.
- `src/components.tsx` visual pieces (`IssueRow`, `GroupHeader`, `CycleHeader`).
- `src/app.tsx` state, keyboard handling, scrolling, screen layout.
- `src/detail.ts` DETAIL data: fetches one issue's description + comments, orders comments as threads, wraps markdown-ish text into plain lines (`wrapText`, `renderMarkdown`, `buildBodyLines`). No styling code.
- `src/detail-view.tsx` the detail screen (pinned header, scrolling body, footer). Loads its own data.
- `src/filter.ts` FILTER logic, pure functions (`filterIssues`, `parseQuery`, `nextTeam/nextLabel/nextPriority`, `describeFilters`). The `/` search bar edits `filters.query`; `t`, `p`, `L` cycle the other filters. `app.tsx` has a second `useInput` for the search bar, active only while `searching`, where every key is text.
- `src/mutations.ts` the ONLY file that writes to Linear (status, priority, estimate). See "Writes" below.
- `src/edit.ts` pure logic for the edit flow (what each picker offers, current value, the exact change sent, the finishing warning). `src/edit-views.tsx` what it looks like (props only) and the height helpers. `src/edit-screen.tsx` the stateful flow: load options, pick, confirm, save, retry. Opened with `s`/`P`/`e` from the list or the detail screen.
- `src/panel.tsx` the floating panel shared by the edit flow and the help: `Panel`, `panelGeometry`, `PanelHeader` (the colored title bar), `PanelFooter`. See "The edit panel is an overlay" below.
- `src/help.ts` the content of the `?` help: which keys do what on the board and on the detail screen (pure data). `src/help-screen.tsx` the help panel (`HelpView`, `HelpScreen`), which scrolls when the pane is short.
- `src/mouse.ts` MOUSE input: `parseMouse()` (SGR reports) and `createMouseInput()`, a filter stream between the real stdin and Ink, plus on/off control of the terminal's mouse mode. `src/mouse-context.ts` hands events to components (`useMouse`, `useMouseApi`). `src/list-layout.ts` pure arithmetic for the list: item offsets and which item a screen row is on (clicks).
- `src/env.ts` the environment switches (dry run, mouse off). Each has a `TANGENT_*` name plus two older ones (`TERMINAL_VELOCITY_*`, `LINEAR_TUI_*`); dry run is ON if ANY of them says `1`.
- `src/keys.ts` `expandBurst()`: see the input gotcha below.
- `src/theme.ts` the few colors Linear's API doesn't provide.
- `src/open.ts` opens links with macOS `open` (https only).

## Conventions and gotchas

- **Colors come from Linear's own palette** (`state.color`, `labels.color` from the API), not any other design system. The few in `theme.ts` (urgent orange, bar gray, overdue red) were matched by eye, not sampled.
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
- `TANGENT_DRY_RUN=1` sends nothing (the old `TERMINAL_VELOCITY_DRY_RUN=1` and `LINEAR_TUI_DRY_RUN=1` still work too: any of them turns it on). Use it to try the screens. Any manual test of a real write needs the owner's explicit go-ahead on a named throwaway issue.
- Statuses come from the ISSUE'S OWN team (PD and UC differ). Estimates are T-shirt teams only; other scales say "not supported".
- Finishing statuses (completed, canceled, duplicate) get an extra warning: some teams need a validation comment before work is called done.
- The edit screen sends nothing until Enter on the CONFIRM screen. The save is guarded three ways (the stage check in `handleKey`, the stage check in `save()`, and `savingRef`), so a second Enter can't send a second write. These overlap on purpose, so removing one alone changes nothing (an "equivalent mutant"): to test them, remove all three.
- When you manually try the edit flow in a real pane, ALWAYS start it with `TANGENT_DRY_RUN=1` and check the `DRY RUN` banner is on screen before pressing Enter on a confirm screen.

## Mouse

- **Ink drops mouse reports** before its input handlers see them, so `index.tsx` puts `createMouseInput` between `process.stdin` and Ink. Events reach components through `MouseContext`, not `useInput`. Without a provider (most tests) the context is inert.
- Mouse mode (`ESC[?1000h ESC[?1006h`) MUST be switched off on every exit path (quit, SIGTERM, SIGHUP, crash): `exitHooks: true` plus `close()` after `waitUntilExit()`. A terminal left in mouse mode prints click codes into the shell.
- **Mouse mode disables the terminal's own text selection.** That is why `m` toggles it and `TANGENT_MOUSE=0` starts it off. Keep both.
- The list is scrolled by LINES (`scrollTop`), independent of the highlight. Keyboard moves scroll just far enough to show the highlight. The list click handler maps screen row to item with `list-layout.ts`; the header height is computed (`headerHeight`), so keep it in sync with what is drawn.
- **A click never writes.** In the edit panel a click can cancel or move to the confirm screen. Only Enter on the confirm screen saves, and a test asserts no write request is sent from clicks.
- Tests: `mountTerminal(node, { mouse: true })` gives `click(x, y, button?)`, `wheel(direction, x, y)` and `mouseWrites`. Coordinates are 0-based screen cells.

## Help and the footer

- The footer is deliberately SHORT: one hint line (`? help  ↑↓ move  ⏎ open  / find  q quit`) plus the status line. Everything else is in the `?` help, so don't grow the footer again; add keys to `help.ts` instead.
- **`help.ts` is hand-written, so keep it in sync with the real key handlers** (`handleKey` in `app.tsx` for the board, and `detail-view.tsx` for the detail screen). When you add, remove or rename a key, change `help.ts` too. A test checks the known keys are listed and that every row fits 28 columns (a narrow pane's panel), so keep rows short.
- `?` is handled by the board and by the detail screen, and is just text in the search bar. It doesn't open over the edit panel. Both screens switch their keys off while the help is open (`!helpOpen` in the board's `isActive`, `inputActive` on the detail screen).

## The edit panel is an overlay

The edit flow floats over whichever screen is showing (list or detail); the screen below stays mounted. How it works, and what to remember:

- `App` returns `<Box width height>{detail ?? list}{overlay}</Box>`. The overlay comes AFTER the screen, so it is painted on top. The panel is `position="absolute"` with `top`/`left` from `panelGeometry()`.
- **Absolute boxes are see-through.** The terminal only has characters, so `Panel` draws a block of spaces behind its content to blank out what's underneath. Without it the screen below shows through.
- The panel is placed relative to its PARENT, so the parent must have a size (the app's full-screen `Box`). In a test, wrap `EditScreen` in a sized `Box` or it is clipped to nothing.
- While the panel is open, the screen below must have its keys OFF: the list's `useInput` has `isActive` including `editing === null`, and `DetailView` takes `inputActive`. One keypress must never drive two things.
- After a change the panel closes and you STAY on the screen you were on. `App` shows `detailShown`, the freshest copy of the issue from the last reload, so the new value appears; the `✓` message goes to the footer (`notice` on the detail screen).
- **Sizes are computed, not measured.** `pickerHeight`, `confirmHeight` and `messageHeight` must equal the lines the view really draws. Anything that can wrap (the warning, the dry-run banner, the "nothing to change" text) is wrapped by us with `wrapText` so its line count is known. A miscount makes flexbox squash the spacing, which once cut the first line of the finishing-status warning in a narrow pane.
- **Every picker option is exactly ONE line** (one outer `Text` with `wrap="truncate-end"`), because the scrolling assumes it.
- The confirm screen stacks the change on three lines when it doesn't fit on one, so the DESTINATION is never cut off.
- Under 100 columns the panel takes the full width. A margin there only reveals stray fragments of the screen below, which look like glitches. From 100 columns it floats, centred, at most 64 wide.
- **The look**, so it stays pronounced: heavy `━`/`┃` lines with ROUNDED corners (a custom `borderStyle` object, since Ink has no built-in heavy-round style), in the accent `PANEL_ACCENT` (`theme.ts`, Linear's purple-blue, readable on light and dark terminals), and a title bar with the accent as its background (a negative `marginX` makes it run edge to edge past the panel's padding).
- **No drop shadow, on purpose.** A `░` shadow was tried and removed: one terminal draws it as a heavy solid gray block, which looked clunky. A test asserts no `░` is drawn. Don't add one back.
- Colors don't show in plain-text test output (Ink strips them), so the tests check the characters (border, title). To check actual colors, capture a real pane with `rex capture --format=vt` and grep for the escape codes (`38;2;94;106;210` is the accent foreground, `48;2;94;106;210` its background).
- Check the panel on a real narrow pane in dry-run. The first real look at a 32-column pane found three bugs the tests had missed.

## Tests (`bun test`)

One `*.test.ts(x)` file per module. They use made-up data and a fake network, never real Linear or the Keychain, so they're fast and anyone can run them.

- `src/testing.ts` has the shared helpers: `makeIssue()`, `labels()`, `mockFetch()` (swap `fetch`; restore it in `afterEach`), and `hasControlChars()`. It is not part of the app.
- **Component tests** use Ink's `renderToString(element, { columns })`. Render inside a **column** box of the pane's width, like the real app does; a default row box lets `flexShrink={0}` children overflow and hides the bugs you're looking for. To measure how tall a component really is, stack a marker under it (`heightOf`) and see which line it lands on. `issueHeight()` and `CycleHeader`'s height must match what's drawn, because the scroll math multiplies on them.
- The squash regression needs 3 two-line rows in a 4-line box; with only 2 rows the rounding hides it.
- Time-dependent tests use `setSystemTime` and build dates in local time, so they pass in any timezone.
- `open.test.ts` spies on `Bun.spawn`, so no real browser ever launches.
- `src/testing-terminal.ts` has `mountTerminal(node, { columns, rows })`: it runs a REAL Ink app with a fake stdin (a PassThrough with `isTTY`/`setRawMode`) and returns `press(...keys)`, `screen()`, `flat()` (whitespace collapsed, for text that may wrap), `waitFor(until)`, `waitForText(...texts)`, `settle()`, `unmount()` (plus `click`, `wheel` and `mouseWrites` when mounted with `mouse: true`). `KEY` has the byte sequences.
- **Wait for the screen, don't sleep.** To wait for something that WILL happen (a load, a save, a panel opening or closing), use `waitForText("…")` or `waitFor(() => …)`: it carries on the moment the screen is ready and, on a timeout, prints the screen it saw. A fixed `settle(ms)` is right only to prove that NOTHING happens. Blind sleeps made the suite slow (62 s) and flaky (a different test failed on each busy run); with `waitFor` it takes about 20 s.
- `edit-screen.test.tsx` runs the real `EditScreen` through it with a fake network and counts the write requests actually sent. `app.test.tsx` runs the whole `App` against a fake Linear server that REMEMBERS changes (so the reload after an edit returns the new values), and checks the panel over the detail and list screens. Both spy on `Bun.spawn` so the Keychain read returns a fake key. They are the slow files (nearly all of the suite's ~20 s) because each key press is paced by 60 ms; keep the pacing, and use `waitFor` for everything else. Use `mockFetch(..., { delayMs })` to hold a write in flight.
- Make fake data realistic enough to expose layering bugs: `app.test.tsx` uses long description lines so they run underneath the panel; short ones hid a "panel drawn under the screen" bug.
- Timing tests (ReDoS) use a generous 500 ms limit; the bug they guard took 3.5 s at 100 KB. `inline()` is exported so the regex bounds are tested **separately** from the line cap that also protects `renderMarkdown`.
- **A test that has never failed proves nothing.** When you add a safety or layout test, temporarily break the code it guards and confirm the test fails. That check found two tests that couldn't fail when this suite was written, and two more in a later review (an `<= 1 write` assertion that also passed with 0 writes, and an "error is cleaned" test whose error had nothing to clean). It also works the other way: before deleting a test as a duplicate, break the code it guards and confirm another test fails too. Two guards that overlap on purpose (the save guards, `expandBurst` and the Enter check) must be broken together.

## Testing the real app in Rex

Run the app in a Rex pane and drive it: `rex send-key -b BLOCK j tab enter` (capitals need `shift+g`), then `rex capture -b BLOCK` to read the screen. `rex capture --format=vt` shows the terminal's real state, which is what exposed overlapping rows once.
