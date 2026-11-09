# Roadmap

Ideas for Terminal Velocity, roughly in the order they'd be worth doing. Sizes are rough T-shirt guesses (S = an afternoon, M = a day or two, L = more). **⚠ writes** marks anything that would let the app change data in Linear, which gets the same care as the existing edit flow (confirm first, dry run, tests that count requests).

## Up next

### 1. Boxed status groups (M)
Give each status group its own rounded box instead of a bare header line. The box highlights when the *group* is selected, and issues keep the `▌` selector.

- Selected group: accent-colored border (and heavier line). Unselected: dim border. Decide whether a group's border also brightens a little while one of its issues is selected (helps you see where you are in a long list).
- Folded group: collapse to a single boxed line (`╭─ ▸ ● DONE  5 ─╮`) or keep it as a plain header. Try both in a real pane.
- The box costs 2 columns (side borders) and 2 lines per group (top and bottom). On a narrow pane the 2 columns matter: check at 32 columns.
- Scroll and click maths: `list-layout.ts` and `issueHeight` assume items are whole lines. The bottom border is best modelled as its own tiny item so offsets, clicks and "scroll to reveal" keep working. Clicking a border line should do nothing (or fold on the top border).
- Tests: border characters, highlight only on the selected group, click mapping with borders, narrow width.

### 2. Better threaded comments (S to M)
Make threads easy to read in the detail screen.

- A left rail (`│`) running beside every reply in a thread, but not the first (root) comment. Optionally also a box around the whole thread. Try the rail alone first; it's cheaper and reads better in narrow panes.
- Linear threads are one level deep (replies to a root comment), so the rail never needs nesting.
- Rail and replies lose a couple of columns of text width, so wrapping must use the narrower width. `detail.ts` should stay free of styling: have each line carry its role (root, reply, last reply) and let `detail-view.tsx` draw the rail (`├`/`└` on first/last reply is a nice touch).
- Dim resolved threads and show "resolved" in the thread header.
- Optional: fold a thread (key and click on its header) with a "3 replies" summary.

## Make it easy for other people to use (public release)

- **Demo mode (S):** `--demo` runs on built-in fake data with no API key and no network. Makes screenshots, trying it out, and bug reports easy, and is safe by construction (no writes possible).
- **Screenshots or a short GIF in the README (S):** best done with demo mode.
- **First-run setup (M):** a `terminal-velocity setup` command that asks for the key and stores it, instead of README instructions for `security add-generic-password`.
- **Not macOS only (M):** the key is read from the macOS Keychain. Add fallbacks: Linux secret-service (`secret-tool`), and an env var (`LINEAR_API_KEY`) with a clear warning that env vars are less safe. The `open` command also needs a Linux equivalent (`xdg-open`).
- **CI (S):** a GitHub Actions workflow running `bun run lint`, `typecheck` and `test` on every PR (macOS runner, since some code is platform-specific).
- **Install story (M):** `bunx` or `bun install -g` from the repo, then maybe single-file binaries (`bun build --compile`) attached to releases, and a Homebrew tap.
- **Project hygiene (S):** `CONTRIBUTING.md` (including the "break it first" test rule and the "no real data in fixtures" rule), issue and PR templates, a changelog.

## Features

- **Copy to clipboard (S):** `y` copies the issue ID, `Y` the URL, and a key for Linear's suggested git branch name (very handy for developers).
- **Cycle switching (M):** current, next and previous cycle; and a "no cycle" view for backlog items.
- **Other people's issues (M):** toggle between mine, unassigned, a teammate's, or a whole team. Today it's only your own.
- **Group and sort options (M):** group by status (today), project, label, assignee or priority; sort by priority, due date or recently updated.
- **Due dates (S):** an "overdue" and "due this week" treatment, and a filter for it.
- **Sub-issues and relations (M):** show the parent, sub-issues and "blocked by" in the detail screen, with a way to jump to them.
- **Linked pull requests (M):** show PR state and CI status from Linear's attachments, and open them from the detail screen.
- **Add a comment (L, ⚠ writes):** the most-wanted missing write. Needs a text input, a confirm screen, dry run support and its own request-counting tests.
- **Change assignee or labels (M each, ⚠ writes):** same pattern as status, priority and estimate. Labels are multi-select, so the picker needs a new mode.
- **Undo the last change (M, ⚠ writes):** a visible "press u to revert" after an edit. Careful: it's a second write, so it needs the same confirm step.
- **Notifications / inbox view (L):** Linear's notification list in a second screen.
- **Several workspaces (L):** switch between Linear accounts.

## Detail screen polish

- **Clickable status, priority and estimate (S):** click them in the detail header to open the matching edit picker (the mouse support already exists).
- **Clickable links (S):** list the links found in the description and comments and open one with a number key or a click.
- **Richer markdown (M):** better code blocks, tables, checkbox lists (`- [x]`), and a placeholder for images with the alt text.
- **Comment polish (S):** show reactions, show "edited", show relative times ("3d ago") with the full date on hover or in a key.
- **Remember the scroll position (S):** when you go back to the list and reopen an issue.

## List polish

- **Scroll indicator (S):** a thin scrollbar column showing where you are in a long list, with click-to-jump.
- **Highlight what's new (S):** after a refresh, mark issues that changed or arrived since the last one.
- **Remember folds and filters (S):** keep folded groups and the last filter across restarts (a small config file).
- **Loading and empty states (S):** a skeleton while loading, and friendly messages for "no active cycle", "no issues match" and "can't reach Linear" (with a retry key).
- **Pagination (M):** confirm behaviour for very large lists (more than one page of results).
- **Double-click (S):** single click selects, double click opens (today a click opens straight away).
- **Hover (M):** needs a different mouse mode (any-motion tracking), which is noisier; probably not worth it.
- **Type-to-filter inside pickers (S):** useful for long status lists.
- **Help search (S):** `/` inside the help panel.

## Configuration and accessibility

- **Config file (M):** `~/.config/terminal-velocity/config.toml` for refresh interval, default filters, group order and key remapping.
- **Colors (S):** respect `NO_COLOR`, and check the palette on light terminal themes.
- **Priority is not only color (S):** double-check priority and status are readable without color (glyph shapes already help).
- **Narrow panes (ongoing):** every new feature gets checked at 32 columns first. That has found bugs the tests missed before.

## Quality and safety

- **Fuzz the mouse parser (S):** random byte streams must never throw or hang, and must never leave mouse mode on.
- **Crash safety (S):** a test that kills the app with each signal and checks the terminal is restored (alternate screen and mouse mode off).
- **Rate limits (S):** back off politely if Linear returns a rate-limit response.
- **Dependency updates (S):** Dependabot for version bumps, and a periodic check that pinned tools still work.
