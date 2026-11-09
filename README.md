# Terminal Velocity

A full-screen terminal app (in the spirit of lazygit) that shows **your Linear issues from every currently active cycle**, grouped by status and sorted by priority.

- Cycle progress bars with days left
- Status groups in Linear's own colors, foldable
- Priority icons, T-shirt (or point) estimates, labels, due dates
- Keyboard-driven, auto-refreshes every 60 seconds

> **Unofficial.** Terminal Velocity is an independent project. It is not made by, affiliated with or endorsed by Linear. "Linear" is a trademark of its owner.
>
> **It can change your issues.** You can change an issue's status, priority and estimate from inside the app, using your own Linear API key. Nothing is sent until you confirm, and `TERMINAL_VELOCITY_DRY_RUN=1` lets you try every screen without sending anything. See [SECURITY.md](SECURITY.md).

Built with [Bun](https://bun.sh), TypeScript and [Ink](https://github.com/vadimdemedes/ink) (React for the terminal).

## Requirements

- macOS (it reads the API key from the Keychain and opens links with `open`)
- [Bun](https://bun.sh) 1.2 or newer
- A Linear personal API key (Linear → Settings → Security & access → Personal API keys). A read-only key is enough.

## Setup

```sh
bun install

# Store your API key in the macOS Keychain. It prompts for the key,
# so it never lands in your shell history or in a file.
security add-generic-password -a "$USER" -s linear-api-key -w
```

## Run

```sh
bun run start
```

Or install it as a command, so you can run it from any folder:

```sh
bun link            # once, from inside the repo
terminal-velocity   # start the app
terminal-velocity --help      # usage and environment switches
terminal-velocity --version
```

## Keys

| Key | Action |
|---|---|
| `↑` `↓` / `j` `k` | Move the cursor |
| `PgUp` `PgDn` | Move half a screen |
| `g` / `G` (or Home / End) | Jump to top / bottom |
| `Tab` / `Shift+Tab` | Next / previous status group |
| `Enter` on an issue | Open its detail screen (description + comments) |
| `Enter` / `Space` on a status | Fold or unfold it |
| `←` `→` / `h` `l` | Fold / unfold the current group |
| `o` | Open the selected issue in the browser |
| `/` | Search (see Filtering below) |
| `t` / `p` / `L` | Cycle the team / priority / label filter |
| `Esc` | Clear all filters |
| `s` / `P` / `e` | Change the selected issue's status / priority / estimate (see below) |
| `r` | Refresh now |
| `?` | Help: every key for the screen you're on (the footer only shows a few) |
| `q` | Quit |

### Filtering

Press `/` and type. The list narrows as you type; `Enter` keeps the filter and returns to the list, `Esc` clears it. While the bar is open, every key is text, so you can search for words containing `j`, `q` and so on.

| Search | Matches |
|---|---|
| `staging branch` | Issue ID or title containing every word (case-insensitive) |
| `label:cpq` (or `l:cpq`) | Issues with a label whose name contains `cpq` |
| `team:pd` (or `t:pd`) | Issues from that team |

The `t`, `p` and `L` keys step through values (all → first → second → … → all). `p` means *at least this urgent*: Urgent, then High and above, then Medium and above. Issues with no priority never match a priority filter. Filters combine, and while any filter is on, folded groups (Done, Canceled) are opened so matches there aren't hidden. The cycle progress bars always count all your issues.

### Changing an issue

> **This changes real data in Linear.** Teammates see it, and automations or notifications may fire.

With an issue selected (in the list or the detail screen), press `s` (status), `P` (priority, capital) or `e` (estimate). A **panel opens over the screen you're on**, so you keep your context. Pick a value with `↑↓` and `Enter`, then **confirm**, which shows exactly what will change (`Status  Todo → In Progress`). Nothing is sent until that second `Enter`. `Esc` goes back a step, and closes the panel from the picker. While the panel is open its keys are the only ones active; the screen underneath keeps its place.

After a change you stay on the screen you were on, and it shows Linear's new value once the board reloads, with a `✓` confirmation in the footer. The panel has a colored title bar and a heavy rounded border in Linear's accent color, so it stands out from the page beneath. In a terminal under 100 columns wide it spans the full width; wider than that it floats, centred.

- Statuses are the issue's **own team's** (they differ between teams).
- Estimates work for T-shirt teams only; other scales say "not supported yet".
- Moving to a finishing status (Done, Canceled, Duplicate, Ready to Release) shows an extra warning.
- Choosing the value the issue already has sends nothing.
- If Linear refuses (for example your API key is read-only), the error is shown, nothing changes, and `Enter` retries.
- After a change the board reloads from Linear, so it shows what Linear really has.

**Try it safely:** start the app with `TERMINAL_VELOCITY_DRY_RUN=1 bun run start`. Every screen works and the footer shows `DRY RUN`, but nothing is ever sent. (The app used to be called linear-tui, so the old `LINEAR_TUI_DRY_RUN` and `LINEAR_TUI_MOUSE` names still work too.)

Your API key needs **write** permission for changes to succeed; reading the board only needs read access.

### Detail screen

Shows the issue's status, priority, estimate, due date, assignee, project and labels, then the description and the comment threads (oldest first, replies indented under their parent).

| Key | Action |
|---|---|
| `↑` `↓` / `j` `k` | Scroll a line |
| `Space` / `PgDn`, `b` / `PgUp` | Scroll a page |
| `g` / `G` | Top / bottom |
| `o` | Open the issue in the browser |
| `Esc` / `q` / `h` / `←` | Back to the list |

## Mouse

The mouse works alongside the keys.

| Where | Action |
|---|---|
| List: click an issue | Open its detail screen |
| List: click a status header | Fold / unfold the group |
| List, detail screen, help: wheel | Scroll (the list scrolls without moving the highlight) |
| Edit panel: click outside it | Cancel |
| Edit panel: click an option | Go to the confirm screen (a click never saves; only `Enter` on the confirm screen does) |
| `m` | Mouse on / off |

**Text selection:** while the mouse is on, the terminal sends clicks to the app instead of selecting text. Press `m` to switch it off and select or copy as usual (the status line shows `mouse off`), or start with `TERMINAL_VELOCITY_MOUSE=0`. It is always switched off when the app quits.

## Development

```sh
bun test            # 171 tests, about a quarter of a second; no network or Keychain needed
bun run typecheck   # tsc --noEmit (strict, with noUncheckedIndexedAccess)
bun run lint        # oxlint
```

See `CLAUDE.md` for how the code is organized.

## License

[MIT](LICENSE)
