# Roadmap

Where Tangent is headed, in broad strokes. **The details live in the [issues](https://github.com/trounceabout/tangent-tui/issues)**: each item below links to its issue, which has the design notes, a rough size (S, M, L) and labels you can filter by. Treat the issues as the source of truth; this page only gives the shape of the plan.

Anything marked **⚠ writes** would let the app change data in Linear, so it gets the same care as the existing edit flow: confirm first, dry run support, and tests that count the requests actually sent.

## Next

The two things being worked on first:

- **Clearer structure in the list:** boxed status groups that highlight when selected (#2).
- **Easier-to-read comment threads** in the detail screen (#3).

## Themes

### Easy for anyone to try and use
Right now it's a macOS-only tool that needs some setup. The aim is that a stranger can try it in a minute and run it on any machine.
Demo mode (#4), screenshots (#5), first-run setup (#6), Linux support (#7), CI (#8), installation (#9), contributor docs (#10).

### See more of your work
Today it shows your own issues in the current cycle. Widen that, and let people organise it their way.
Cycle switching (#12), other people's issues (#13), grouping and sorting (#14), due dates (#15), sub-issues and relations (#16), linked pull requests (#17), notifications (#21), several workspaces (#22), copy helpers (#11).

### Do more without leaving the terminal
Status, priority and estimate can be changed already. More of the everyday actions, each one a deliberate, confirmed write.
Add a comment (#18 ⚠ writes), change assignee or labels (#19 ⚠ writes), undo the last change (#20 ⚠ writes).

### A nicer detail screen
Make long issues and long discussions pleasant to read and act on.
Clickable status, priority and estimate (#23), clickable links (#24), richer markdown (#25), comment polish (#26), remembering your place (#27).

### A nicer list
Small things that make it feel finished.
Scroll indicator (#28), highlighting what's new (#29), remembering folds and filters (#30), loading and empty states (#31), large lists (#32), double-click (#33), hover (#34), filtering inside pickers (#35), help search (#36).

### Make it yours
Configuration, colors and accessibility.
Config file (#37), colors (#38), not relying on color alone (#39), narrow panes (#40).

### Robust and safe
It holds an API key and can change shared data, so this never stops.
Fuzzing the mouse parser (#41), crash safety (#42), rate limits (#43), dependency updates (#44).

## How to suggest something

Open an issue, or comment on an existing one. For anything that writes to Linear, please describe what could go wrong and how it would be confirmed before it is sent.
