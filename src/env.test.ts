// Tests for src/env.ts: the new and the old environment variable names.

import { afterEach, describe, expect, test } from "bun:test";
import { dryRunRequested, mouseStartsOff } from "./env.ts";

const NAMES = ["TERMINAL_VELOCITY_DRY_RUN", "LINEAR_TUI_DRY_RUN", "TERMINAL_VELOCITY_MOUSE", "LINEAR_TUI_MOUSE"];
afterEach(() => NAMES.forEach((name) => delete process.env[name]));

describe("dryRunRequested", () => {
  test("is off by default", () => {
    expect(dryRunRequested()).toBe(false);
  });

  test("the new name turns it on", () => {
    process.env.TERMINAL_VELOCITY_DRY_RUN = "1";
    expect(dryRunRequested()).toBe(true);
  });

  test("the OLD name still turns it on, so an old habit can't send a real write", () => {
    process.env.LINEAR_TUI_DRY_RUN = "1";
    expect(dryRunRequested()).toBe(true);
  });

  test("either name on is enough, even if the other says something else", () => {
    process.env.TERMINAL_VELOCITY_DRY_RUN = "0";
    process.env.LINEAR_TUI_DRY_RUN = "1";
    expect(dryRunRequested()).toBe(true);
  });

  test("only exactly '1' counts", () => {
    for (const value of ["", "0", "true", "yes", "2"]) {
      process.env.TERMINAL_VELOCITY_DRY_RUN = value;
      expect(dryRunRequested()).toBe(false);
    }
  });
});

describe("mouseStartsOff", () => {
  test("is on by default", () => {
    expect(mouseStartsOff()).toBe(false);
  });

  test("either name set to 0 turns the mouse off at start", () => {
    process.env.TERMINAL_VELOCITY_MOUSE = "0";
    expect(mouseStartsOff()).toBe(true);
    delete process.env.TERMINAL_VELOCITY_MOUSE;
    process.env.LINEAR_TUI_MOUSE = "0";
    expect(mouseStartsOff()).toBe(true);
  });
});
