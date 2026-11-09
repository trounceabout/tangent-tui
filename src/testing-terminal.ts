// src/testing-terminal.ts
// A fake terminal for running a REAL Ink app in tests: send keystrokes (and, with
// `mouse: true`, mouse events) in, read the screen back. Not part of the app itself.
//
// Used by the tests that drive whole screens (edit-screen.test.tsx, app.test.tsx, ...).
// Combine with testing.ts: mockFetch() fakes the network, and a spy on Bun.spawn can
// fake the Keychain read.

import { PassThrough } from "node:stream";
import { createElement } from "react";
import type { ReactElement } from "react";
import { render } from "ink";
import { createMouseInput } from "./mouse.ts";
import { MouseContext, mouseApiFor } from "./mouse-context.ts";
import { ESC } from "./testing.ts";

const ANSI = new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]`, "g");

// Keys, as the bytes a terminal sends.
export const KEY = { enter: "\r", esc: ESC, down: `${ESC}[B`, up: `${ESC}[A`, j: "j", k: "k", q: "q", space: " " };
export const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Ink needs a stdin that looks like a terminal: isTTY, and raw mode it can switch on.
class FakeStdin extends PassThrough {
  isTTY = true;
  setRawMode() {
    return this;
  }
  ref() {
    return this;
  }
  unref() {
    return this;
  }
}

// A mouse report in the format terminals send (SGR). x and y are 0-based screen cells.
const mouseReport = (code: number, x: number, y: number, final: "M" | "m") => `${ESC}[<${code};${x + 1};${y + 1}${final}`;

export function mountTerminal(node: ReactElement, { columns = 60, rows = 24, mouse = false } = {}) {
  const stdin = new FakeStdin();
  const stdout = new PassThrough() as PassThrough & { columns: number; rows: number; isTTY: boolean };
  stdout.columns = columns;
  stdout.rows = rows;
  stdout.isTTY = true;
  // debug mode writes each complete frame as one chunk, so the last chunk is the screen.
  const frames: string[] = [];
  stdout.on("data", (chunk: Buffer) => frames.push(chunk.toString()));

  // With `mouse: true` the app gets the REAL mouse pipeline: the filter sits between this
  // fake keyboard and Ink, and the context carries the events, exactly as in index.tsx.
  // What the app tells the terminal about mouse reporting is recorded in `mouseWrites`.
  const mouseWrites: string[] = [];
  const mouseInput = mouse ? createMouseInput(stdin, { write: (text: string) => mouseWrites.push(text), isTTY: true }) : undefined;
  const tree = mouseInput ? createElement(MouseContext.Provider, { value: mouseApiFor(mouseInput) }, node) : node;

  const app = render(tree, {
    stdin: (mouseInput?.stdin ?? stdin) as never,
    stdout: stdout as never,
    debug: true,
    patchConsole: false,
    exitOnCtrlC: false,
  });

  return {
    // Send keys one at a time, with a pause so each is handled before the next.
    async press(...keys: string[]) {
      for (const key of keys) {
        stdin.write(key);
        await wait(60);
      }
    },
    // A click at a screen cell: the button goes down, then up. Left by default.
    async click(x: number, y: number, button: "left" | "middle" | "right" = "left") {
      const code = { left: 0, middle: 1, right: 2 }[button];
      stdin.write(mouseReport(code, x, y, "M"));
      await wait(30);
      stdin.write(mouseReport(code, x, y, "m"));
      await wait(60);
    },
    // One notch of the mouse wheel at a screen cell.
    async wheel(direction: "up" | "down", x = 0, y = 0) {
      stdin.write(mouseReport(direction === "up" ? 64 : 65, x, y, "M"));
      await wait(60);
    },
    mouseWrites,
    // The current screen as plain text (colors removed).
    screen: () => (frames.at(-1) ?? "").replace(ANSI, ""),
    // The same, with line breaks and runs of spaces collapsed, for text that may wrap.
    // The panel's side borders are dropped too: text wrapped inside a panel would
    // otherwise have "┃ ┃" in the middle of it.
    flat: () => (frames.at(-1) ?? "").replace(ANSI, "").replace(/[┃│]/g, " ").replace(/\s+/g, " "),
    async settle(ms = 120) {
      await wait(ms);
    },
    unmount: () => {
      app.unmount();
      mouseInput?.close();
    },
  };
}
