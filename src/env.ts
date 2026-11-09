// src/env.ts
// The environment switches. The app used to be called linear-tui, so the old LINEAR_TUI_*
// names still work next to the new TERMINAL_VELOCITY_* ones.

// Dry run: nothing is ever sent to Linear. Either name set to "1" turns it ON, so an old
// habit (LINEAR_TUI_DRY_RUN=1) can never end up sending a real write.
export const dryRunRequested = (): boolean =>
  process.env.TERMINAL_VELOCITY_DRY_RUN === "1" || process.env.LINEAR_TUI_DRY_RUN === "1";

// Mouse: either name set to "0" starts the app with the mouse off.
export const mouseStartsOff = (): boolean =>
  process.env.TERMINAL_VELOCITY_MOUSE === "0" || process.env.LINEAR_TUI_MOUSE === "0";
