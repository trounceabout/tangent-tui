import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_VIEW_SETTINGS, loadSettings, parseSettings, saveSettings, settingsDir } from "./settings";

describe("parseSettings", () => {
  test("reads a valid file", () => {
    expect(parseSettings('{"showLabels": false}')).toEqual({ showLabels: false });
    expect(parseSettings('{"showLabels": true}')).toEqual({ showLabels: true });
  });

  test("garbage or non-object JSON gives the defaults", () => {
    for (const text of ["", "not json", "null", "[]", "42", '"labels"', "{"]) {
      expect(parseSettings(text)).toEqual(DEFAULT_VIEW_SETTINGS);
    }
  });

  test("a wrong type for a field falls back to that field's default", () => {
    expect(parseSettings('{"showLabels": "no"}')).toEqual(DEFAULT_VIEW_SETTINGS);
    expect(parseSettings('{"showLabels": 0}')).toEqual(DEFAULT_VIEW_SETTINGS);
  });

  test("unknown fields are ignored and not carried along", () => {
    expect(parseSettings('{"showLabels": false, "apiKey": "secret"}')).toEqual({ showLabels: false });
  });

  test("the defaults object is never handed out to be mutated", () => {
    const a = parseSettings("");
    a.showLabels = false;
    expect(DEFAULT_VIEW_SETTINGS.showLabels).toBe(true);
  });
});

describe("loadSettings / saveSettings", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tangent-settings-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("a missing file gives the defaults", () => {
    expect(loadSettings(join(dir, "nothing-here"))).toEqual(DEFAULT_VIEW_SETTINGS);
  });

  test("what is saved is what is loaded", () => {
    expect(saveSettings({ showLabels: false }, dir)).toBeNull();
    expect(loadSettings(dir)).toEqual({ showLabels: false });
  });

  test("save creates the folder if needed", () => {
    const nested = join(dir, "a", "b");
    expect(saveSettings({ showLabels: false }, nested)).toBeNull();
    expect(loadSettings(nested)).toEqual({ showLabels: false });
  });

  test("a corrupt file loads as defaults instead of throwing", () => {
    writeFileSync(join(dir, "settings.json"), "{{{ broken");
    expect(loadSettings(dir)).toEqual(DEFAULT_VIEW_SETTINGS);
  });

  test("the file holds only the view settings", () => {
    saveSettings({ showLabels: false }, dir);
    expect(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"))).toEqual({ showLabels: false });
  });

  test("a failed save returns a message and does not throw", () => {
    // A FILE where the folder should be: mkdir fails.
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "x");
    expect(saveSettings({ showLabels: false }, join(blocker, "sub"))).toBe("couldn't save view settings");
  });
});

describe("settingsDir", () => {
  const saved = process.env.XDG_CONFIG_HOME;
  afterEach(() => {
    if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = saved;
  });

  test("an explicit dir wins", () => {
    expect(settingsDir("/somewhere")).toBe("/somewhere");
  });

  test("XDG_CONFIG_HOME is respected", () => {
    process.env.XDG_CONFIG_HOME = "/xdg";
    expect(settingsDir()).toBe("/xdg/tangent");
  });

  test("otherwise it is ~/.config/tangent", () => {
    delete process.env.XDG_CONFIG_HOME;
    expect(settingsDir().endsWith("/.config/tangent")).toBe(true);
  });
});
