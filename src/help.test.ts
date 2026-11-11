// Tests for src/help.ts: the content of the help screen.

import { describe, expect, test } from "bun:test";
import { HELP, helpLines, keyColumnWidth } from "./help.ts";
import type { HelpKind } from "./help.ts";

const KINDS: HelpKind[] = ["list", "detail"];

// The key labels on a screen, split into single keys: "↑↓  j k" -> ["↑↓", "j", "k"].
const keysOf = (kind: HelpKind): string[] =>
  helpLines(kind).flatMap((line) => (line.kind === "entry" ? line.keys.split(/\s+/).filter(Boolean) : []));

describe("helpLines", () => {
  test.each(KINDS)("%s: starts with a section title and ends with a key, no stray blanks", (kind) => {
    const lines = helpLines(kind);
    expect(lines[0]?.kind).toBe("title");
    expect(lines.at(-1)?.kind).toBe("entry");
    for (let i = 1; i < lines.length; i++) {
      // Never two blank lines in a row.
      expect(lines[i]?.kind === "blank" && lines[i - 1]?.kind === "blank").toBe(false);
    }
  });

  test.each(KINDS)("%s: there's exactly one blank line between sections, and a title after each", (kind) => {
    const lines = helpLines(kind);
    const blanks = lines.flatMap((line, i) => (line.kind === "blank" ? [i] : []));
    expect(blanks).toHaveLength(HELP[kind].length - 1);
    for (const i of blanks) expect(lines[i + 1]?.kind).toBe("title");
  });

  test.each(KINDS)("%s: every section is shown, in order", (kind) => {
    const titles = helpLines(kind).flatMap((line) => (line.kind === "title" ? [line.text] : []));
    expect(titles).toEqual(HELP[kind].map((section) => section.title));
  });

  test.each(KINDS)("%s: every entry has a description", (kind) => {
    for (const line of helpLines(kind)) {
      if (line.kind === "entry") expect(line.description.trim()).not.toBe("");
    }
  });

  // A narrow pane's panel has about 28 columns for text. If a row doesn't fit it gets
  // cut with an ellipsis, so keep every row short enough to read in full.
  test.each(KINDS)("%s: every row fits in 28 columns, so even a narrow pane shows it in full", (kind) => {
    const lines = helpLines(kind);
    const keyWidth = keyColumnWidth(lines);
    for (const line of lines) {
      if (line.kind === "entry") expect(Bun.stringWidth(`${line.keys.padEnd(keyWidth)}  ${line.description}`)).toBeLessThanOrEqual(28);
      if (line.kind === "title") expect(Bun.stringWidth(line.text)).toBeLessThanOrEqual(28);
    }
  });

  test("the board's help lists every key the board responds to", () => {
    const keys = keysOf("list");
    for (const key of ["↑↓", "j", "k", "g", "G", "tab", "enter", "space", "o", "r", "/", "t", "p", "L", "esc", "s", "P", "e", "?", "v", "q", "click", "wheel", "m"]) {
      expect(keys).toContain(key);
    }
  });

  test("the detail screen's help lists its keys, including the ones to leave", () => {
    const keys = keysOf("detail");
    for (const key of ["↑↓", "j", "k", "space", "b", "g", "G", "o", "s", "P", "e", "esc", "q", "h", "?", "wheel"]) {
      expect(keys).toContain(key);
    }
  });
});

describe("keyColumnWidth", () => {
  test("is the width of the longest key label, so descriptions line up", () => {
    const lines = helpLines("list");
    const longest = Math.max(...lines.map((l) => (l.kind === "entry" ? Bun.stringWidth(l.keys) : 0)));
    expect(keyColumnWidth(lines)).toBe(longest);
    expect(keyColumnWidth([])).toBe(0);
  });
});
