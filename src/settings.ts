// src/settings.ts
// VIEW SETTINGS: what the user chooses to see (for now, only whether the list shows labels).
// They are remembered in a small JSON file between launches.
//
// Rules for this file:
//  - It holds view preferences ONLY. Never the API key (that lives in the Keychain) or any
//    Linear data.
//  - Reading never throws: a missing, unreadable or hand-edited file just means "defaults".
//  - Writing never throws either: a failed save is reported to the caller, who shows it in
//    the footer. Losing a preference must not crash the app.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type ViewSettings = {
  // Show each issue's labels on the list's second line.
  showLabels: boolean;
};

export const DEFAULT_VIEW_SETTINGS: ViewSettings = { showLabels: true };

// What the View settings panel lists, in order. To add a setting: add the field to
// ViewSettings, its default and its parse line below, and one row here.
export const VIEW_OPTIONS: { key: keyof ViewSettings; label: string }[] = [{ key: "showLabels", label: "Show labels" }];

// A copy of the settings with one option flipped.
export const toggled = (settings: ViewSettings, key: keyof ViewSettings): ViewSettings => ({
  ...settings,
  [key]: !settings[key],
});

// Turns the text of the settings file into settings. Pure, so it is easy to test.
// Anything that isn't the right type falls back to its default, field by field, so one bad
// value doesn't throw away the good ones.
export const parseSettings = (text: string): ViewSettings => {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ...DEFAULT_VIEW_SETTINGS };
  }
  const object = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return {
    showLabels: typeof object.showLabels === "boolean" ? object.showLabels : DEFAULT_VIEW_SETTINGS.showLabels,
  };
};

// Where the file lives: $XDG_CONFIG_HOME/tangent (if set), otherwise ~/.config/tangent.
// `dir` is for tests, so they never touch the real home directory.
export const settingsDir = (dir?: string): string =>
  dir ?? join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "tangent");

const settingsPath = (dir?: string): string => join(settingsDir(dir), "settings.json");

// Reads the saved settings. Missing file or any error: defaults.
export const loadSettings = (dir?: string): ViewSettings => {
  try {
    return parseSettings(readFileSync(settingsPath(dir), "utf8"));
  } catch {
    return { ...DEFAULT_VIEW_SETTINGS };
  }
};

// Saves the settings. Returns null on success, or a short message if it failed (so the
// caller can show it instead of crashing).
export const saveSettings = (settings: ViewSettings, dir?: string): string | null => {
  try {
    mkdirSync(settingsDir(dir), { recursive: true });
    writeFileSync(settingsPath(dir), `${JSON.stringify(settings, null, 2)}\n`);
    return null;
  } catch {
    return "couldn't save view settings";
  }
};
