// Tests for src/env.ts: the new and the old environment variable names.

import { afterEach, describe, expect, test } from "bun:test";
import { dryRunRequested, mouseStartsOff } from "./env.ts";

const NAMES = [
  "TANGENT_DRY_RUN",
  "TERMINAL_VELOCITY_DRY_RUN",
  "LINEAR_TUI_DRY_RUN",
  "TANGENT_MOUSE",
  "TERMINAL_VELOCITY_MOUSE",
  "LINEAR_TUI_MOUSE",
];
afterEach(() => NAMES.forEach((name) => delete process.env[name]));

describe("dryRunRequested", () => {
  test("is off by default", () => {
    expect(dryRunRequested()).toBe(false);
  });

  test("the new name turns it on", () => {
    process.env.TANGENT_DRY_RUN = "1";
    expect(dryRunRequested()).toBe(true);
  });

  test.each(["TERMINAL_VELOCITY_DRY_RUN", "LINEAR_TUI_DRY_RUN"])(
    "the OLD name %s still turns it on, so an old habit can't send a real write",
    (name) => {
      process.env[name] = "1";
      expect(dryRunRequested()).toBe(true);
    },
  );

  test("any name on is enough, even if the others say something else", () => {
    process.env.TANGENT_DRY_RUN = "0";
    process.env.TERMINAL_VELOCITY_DRY_RUN = "0";
    process.env.LINEAR_TUI_DRY_RUN = "1";
    expect(dryRunRequested()).toBe(true);
  });

  test("only exactly '1' counts", () => {
    for (const value of ["", "0", "true", "yes", "2"]) {
      process.env.TANGENT_DRY_RUN = value;
      expect(dryRunRequested()).toBe(false);
    }
  });
});

describe("mouseStartsOff", () => {
  test("is on by default", () => {
    expect(mouseStartsOff()).toBe(false);
  });

  test.each(["TANGENT_MOUSE", "TERMINAL_VELOCITY_MOUSE", "LINEAR_TUI_MOUSE"])(
    "%s set to 0 turns the mouse off at start",
    (name) => {
      process.env[name] = "0";
      expect(mouseStartsOff()).toBe(true);
    },
  );
});
