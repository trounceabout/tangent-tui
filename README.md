# linear-tui

A full-screen terminal app (in the spirit of lazygit) that shows **my Linear issues from every currently active cycle**, grouped by status and sorted by priority.

- Cycle progress bars with days left
- Status groups in Linear's own colors, foldable
- Priority icons, T-shirt (or point) estimates, labels, due dates
- Keyboard-driven, auto-refreshes every 60 seconds

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

## Keys

| Key | Action |
|---|---|
| `↑` `↓` / `j` `k` | Move the cursor |
| `PgUp` `PgDn` | Move half a screen |
| `g` / `G` (or Home / End) | Jump to top / bottom |
| `Tab` / `Shift+Tab` | Next / previous status group |
| `Enter` / `Space` on a status | Fold or unfold it |
| `←` `→` / `h` `l` | Fold / unfold the current group |
| `o` | Open the selected issue in the browser |
| `r` | Refresh now |
| `q` | Quit |

## Development

```sh
bun run typecheck   # tsc --noEmit (strict, with noUncheckedIndexedAccess)
bun run lint        # oxlint
```

See `CLAUDE.md` for how the code is organized.
