// src/env.ts
// The environment switches. The app has been renamed twice (linear-tui, then
// terminal-velocity, now tangent), so the older TERMINAL_VELOCITY_* and LINEAR_TUI_* names
// still work next to the new TANGENT_* ones.

const DRY_RUN_NAMES = ["TANGENT_DRY_RUN", "TERMINAL_VELOCITY_DRY_RUN", "LINEAR_TUI_DRY_RUN"];
const MOUSE_NAMES = ["TANGENT_MOUSE", "TERMINAL_VELOCITY_MOUSE", "LINEAR_TUI_MOUSE"];

// Dry run: nothing is ever sent to Linear. ANY of the names set to "1" turns it ON, so an
// old habit (TERMINAL_VELOCITY_DRY_RUN=1) can never end up sending a real write.
export const dryRunRequested = (): boolean => DRY_RUN_NAMES.some((name) => process.env[name] === "1");

// Mouse: any of the names set to "0" starts the app with the mouse off.
export const mouseStartsOff = (): boolean => MOUSE_NAMES.some((name) => process.env[name] === "0");
