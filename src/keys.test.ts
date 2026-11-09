// Tests for src/keys.ts: turning one chunk of input into key presses.
//
// Why this exists: Ink hands a burst of keys ("jjj") to the key handler as ONE
// string, so a handler checking `input === "j"` would ignore all of them.

import { describe, expect, test } from "bun:test";
import { expandBurst } from "./keys.ts";

describe("expandBurst", () => {
  test("a single key is passed through", () => {
    expect(expandBurst("j")).toEqual(["j"]);
  });

  test("no text (an arrow key, Enter, Esc) is passed through as one press", () => {
    expect(expandBurst("")).toEqual([""]);
  });

  test("a run of the same navigation key counts as that many presses", () => {
    expect(expandBurst("jjj")).toEqual(["j", "j", "j"]);
    expect(expandBurst("kk")).toEqual(["k", "k"]);
    expect(expandBurst("   ")).toEqual([" ", " ", " "]);
    expect(expandBurst("hh")).toEqual(["h", "h"]);
    expect(expandBurst("ll")).toEqual(["l", "l"]);
    expect(expandBurst("bb")).toEqual(["b", "b"]);
  });

  // SECURITY / SAFETY: a burst must never fire an action several times, and pasted
  // text must never act as commands. (A burst of "o" would open several browser tabs.)
  test("a run of an ACTION key is ignored, not repeated", () => {
    for (const action of ["o", "r", "q", "t", "p", "L", "/", "g", "G"]) {
      expect(expandBurst(action.repeat(3))).toEqual([]);
    }
  });

  test("mixed or pasted text is ignored entirely", () => {
    expect(expandBurst("jk")).toEqual([]);
    expect(expandBurst("hello world")).toEqual([]);
    expect(expandBurst("jjjq")).toEqual([]); // one stray character spoils the run
  });

  test("a single action key is still a normal press", () => {
    expect(expandBurst("o")).toEqual(["o"]);
    expect(expandBurst("q")).toEqual(["q"]);
  });
});
