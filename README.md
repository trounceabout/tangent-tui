# Tangent

A full-screen terminal app (in the spirit of lazygit) that shows **your Linear issues from every currently active cycle**, grouped by status and sorted by priority.

- Cycle progress bars with days left
- Status groups in Linear's own colors, foldable
- Priority icons, T-shirt (or point) estimates, labels, due dates
- Keyboard-driven, auto-refreshes every 60 seconds

> **Unofficial.** Tangent is an independent project. It is not made by, affiliated with or endorsed by Linear. "Linear" is a trademark of its owner.
>
> **It can change your issues.** You can change an issue's status, priority and estimate from inside the app, using your own Linear login. Nothing is sent until you confirm, and `TANGENT_DRY_RUN=1` lets you try every screen without sending anything. See [SECURITY.md](SECURITY.md).

Built with [Bun](https://bun.sh), TypeScript and [Ink](https://github.com/vadimdemedes/ink) (React for the terminal).

## Install

Tangent runs on **macOS** (Apple Silicon or Intel). It keeps your Linear login in the macOS Keychain and opens links with `open`; Linux support is planned (issue #7).

### One command

```sh
curl -fsSL https://raw.githubusercontent.com/trounceabout/tangent-tui/main/install.sh | sh
```

This downloads the latest release for your Mac, checks it against the release's checksum, and installs a `tangent` command into `~/.local/bin`. It doesn't use `sudo`, doesn't need Bun, and doesn't touch your shell config. If it says `~/.local/bin` is not on your `PATH`, add the line it prints to `~/.zshrc`.

The script is short ([install.sh](install.sh)), so read it before you run it if you like. If it can't verify the download, or the downloaded program won't start, it installs nothing and leaves any version you already have alone.

To pick a version or a folder, set these on the `sh` side of the pipe:

```sh
curl -fsSL https://raw.githubusercontent.com/trounceabout/tangent-tui/main/install.sh \
  | TANGENT_VERSION=v0.1.0 TANGENT_INSTALL_DIR=~/bin sh
```

### With Bun

If you already have [Bun](https://bun.sh) 1.2 or newer:

```sh
bunx github:trounceabout/tangent-tui            # run it once, nothing installed
bun install -g github:trounceabout/tangent-tui  # install the command
```

This runs straight from the source on GitHub. (It isn't published to npm yet.)

### Download by hand

Every release on the [Releases page](https://github.com/trounceabout/tangent-tui/releases) has a binary for each Mac (`tangent-darwin-arm64` for Apple Silicon, `tangent-darwin-x64` for Intel) and a `SHA256SUMS` file.

macOS **refuses to run a binary you download in a browser** (it is killed straight away) because these binaries are not notarized by Apple. Clear the quarantine mark, then make it executable and put it on your `PATH`:

```sh
xattr -d com.apple.quarantine tangent-darwin-arm64
chmod +x tangent-darwin-arm64
mv tangent-darwin-arm64 ~/.local/bin/tangent
```

The one-command install isn't affected, because `curl` doesn't add the quarantine mark.

### Check what you downloaded

The one-command install already checks the checksum. To check a file you downloaded by hand, put it in the same folder as `SHA256SUMS`:

```sh
shasum -a 256 -c --ignore-missing SHA256SUMS
```

A checksum shows the file arrived intact. It doesn't prove the release is genuine, because the checksum file is published next to the binary. For that, each release carries a signed **build-provenance attestation**: proof that GitHub Actions built this exact file from this repository. With the [GitHub CLI](https://cli.github.com/):

```sh
gh attestation verify tangent-darwin-arm64 --repo trounceabout/tangent-tui
```

### Update

Run the same install command again. It replaces the old version, and your saved login is untouched. (With Bun: `bun remove -g tangent-tui`, then `bun install -g github:trounceabout/tangent-tui` again.)

### Uninstall

Log out first, while the program is still installed. It ends the login at Linear and removes it from your Keychain:

```sh
tangent logout
```

Then remove the program:

```sh
rm ~/.local/bin/tangent        # installed with the one command or by hand
bun remove -g tangent-tui      # installed with Bun
```

**Upgrading from Terminal Velocity?** The app used to have that name, so an older install is a separate program. Remove it too: `rm ~/.local/bin/terminal-velocity` and `bun remove -g terminal-velocity`.

If you already removed the program without logging out, end the login yourself: remove Tangent in Linear (Settings → Security & access → Authorized applications), then delete the saved copy:

```sh
security delete-generic-password -s tangent-oauth -a tangent
```

If you used a personal API key before, it stays in the Keychain until you remove it:

```sh
security delete-generic-password -s linear-api-key
```

## Requirements

- macOS
- A Linear account. Tangent logs in through your browser (see Setup). A personal API key still works as a fallback.
- [Bun](https://bun.sh) 1.2 or newer, but **only** for the Bun install or for running from source. The one-command install and the downloaded binaries don't need it.

## Setup

Log in once, after installing:

```sh
tangent login
```

Your browser opens on a Linear page asking you to authorize **Tangent**. Before you approve:

- **Check the workspace name at the top left of the page.** Linear picks the workspace you used last. If it's the wrong one, use the dropdown there to switch, then approve.
- **What you're allowing.** The page lists two permissions: `read` (read your workspace) and `issues:create` (Linear's name for creating and updating issues). Tangent only ever changes an issue's status, priority or estimate, and only when you confirm. It never asks for admin access.

When you approve, the terminal says `Logged in to <workspace>.` and the login is saved in your macOS Keychain. It renews itself, so you shouldn't need to log in again.

**Switching workspace:** run `tangent login` again and pick the other workspace in that dropdown. A login belongs to one workspace.

**Logging out:** `tangent logout` ends the login at Linear and removes it from this computer. If it can't reach Linear it still removes it here, says so, and tells you where to end it by hand (Linear → Settings → Security & access → Authorized applications).

### On a server, or without a browser

The login needs a browser on the same computer. Where there isn't one, use a personal API key instead (Linear → Settings → Security & access → Personal API keys). Give it for a single run:

```sh
LINEAR_API_KEY=lin_api_... tangent
```

or save it in the macOS Keychain once. It prompts for the key, so it never lands in your shell history or in a file:

```sh
security add-generic-password -a "$USER" -s linear-api-key -w
```

An environment variable is the least safe of these (other programs you run can read it), so prefer a login or the Keychain. Tangent uses a browser login first if there is one, then the saved key, then `LINEAR_API_KEY`. A read-only key can look at your board, but changing an issue needs a key that is allowed to.

## Run

```sh
tangent
tangent login       # log in with your browser
tangent logout      # log out, and end the login at Linear
tangent --help      # usage and environment switches
tangent --version
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
| `v` | View settings: choose what the list shows (see below) |
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

### View settings

Press `v` on the list to open a small panel of choices about **what you see**. `Space` or `Enter` flips the highlighted one, and it applies at once; `Esc` (or `v`, `q`) closes the panel. These only change how the list looks: nothing is sent to Linear.

| Setting | Effect |
|---|---|
| Show labels | On (the default): each issue's labels are listed under its title. Off: labels are hidden, and rows without a due date shrink to one line, so more issues fit on screen. Due dates always stay. |

When a setting is changed from its default the status line says so (for example `labels off`). Your choices are remembered between launches in `~/.config/tangent/settings.json` (or `$XDG_CONFIG_HOME/tangent/settings.json`). The file holds view preferences only, never your API key. You can delete it to go back to the defaults, and an unreadable or hand-edited file is ignored rather than breaking the app.

### Changing an issue

> **This changes real data in Linear.** Teammates see it, and automations or notifications may fire.

With an issue selected (in the list or the detail screen), press `s` (status), `P` (priority, capital) or `e` (estimate). A **panel opens over the screen you're on**, so you keep your context. Pick a value with `↑↓` and `Enter`, then **confirm**, which shows exactly what will change (`Status  Todo → In Progress`). Nothing is sent until that second `Enter`. `Esc` goes back a step, and closes the panel from the picker. While the panel is open its keys are the only ones active; the screen underneath keeps its place.

After a change you stay on the screen you were on, and it shows Linear's new value once the board reloads, with a `✓` confirmation in the footer. The panel has a colored title bar and a heavy rounded border in Linear's accent color, so it stands out from the page beneath. In a terminal under 100 columns wide it spans the full width; wider than that it floats, centred.

- Statuses are the issue's **own team's** (they differ between teams).
- Estimates work for T-shirt teams only; other scales say "not supported yet".
- Moving to a finishing status (Done, Canceled, Duplicate, Ready to Release) shows an extra warning.
- Choosing the value the issue already has sends nothing.
- If Linear refuses (for example a read-only API key), the error is shown, nothing changes, and `Enter` retries.
- After a change the board reloads from Linear, so it shows what Linear really has.

**Try it safely:** start the app with `TANGENT_DRY_RUN=1 tangent`. Every screen works and the footer shows `DRY RUN`, but nothing is ever sent. (The app used to be called Terminal Velocity and, before that, linear-tui, so the old `TERMINAL_VELOCITY_*` and `LINEAR_TUI_*` names still work too.)

Your login needs permission to update issues for a change to succeed, and the browser login asks for exactly that. A read-only personal API key can look at the board, but its changes are refused.

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
| View settings panel: click an option | Flip it. Click outside the panel to close it |
| Edit panel: click outside it | Cancel |
| Edit panel: click an option | Go to the confirm screen (a click never saves; only `Enter` on the confirm screen does) |
| `m` | Mouse on / off |

**Text selection:** while the mouse is on, the terminal sends clicks to the app instead of selecting text. Press `m` to switch it off and select or copy as usual (the status line shows `mouse off`), or start with `TANGENT_MOUSE=0`. It is always switched off when the app quits.

## Development

To work on the code, run it from source:

```sh
git clone https://github.com/trounceabout/tangent-tui.git
cd tangent-tui
bun install
bun run start       # run from source (needs a real terminal)
bun link            # make `tangent` run from this folder; `bun unlink` undoes it
```

```sh
bun test            # about 25 seconds; no network or Keychain needed
bun run typecheck   # tsc --noEmit (strict, with noUncheckedIndexedAccess)
bun run lint        # oxlint
bun run build       # the single-file binaries, into dist/ (macOS only)
```

Releases are built by GitHub Actions when a version tag is pushed. See `CLAUDE.md` for how the code is organized and for the release steps.

## License

[MIT](LICENSE)
