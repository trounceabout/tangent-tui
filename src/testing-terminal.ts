// src/testing-terminal.ts
// A fake terminal for running a REAL Ink app in tests: send keystrokes in, read the
// screen back. Not part of the app itself.
//
// Used by the tests that drive whole screens (edit-screen.test.tsx, app.test.tsx).
// Combine with testing.ts: mockFetch() fakes the network, and a spy on Bun.spawn can
// fake the Keychain read.

import { PassThrough } from "node:stream";
import type { ReactElement } from "react";
import { render } from "ink";
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

export function mountTerminal(node: ReactElement, { columns = 60, rows = 24 } = {}) {
  const stdin = new FakeStdin();
  const stdout = new PassThrough() as PassThrough & { columns: number; rows: number; isTTY: boolean };
  stdout.columns = columns;
  stdout.rows = rows;
  stdout.isTTY = true;
  // debug mode writes each complete frame as one chunk, so the last chunk is the screen.
  const frames: string[] = [];
  stdout.on("data", (chunk: Buffer) => frames.push(chunk.toString()));

  const app = render(node, { stdin: stdin as never, stdout: stdout as never, debug: true, patchConsole: false, exitOnCtrlC: false });

  return {
    // Send keys one at a time, with a pause so each is handled before the next.
    async press(...keys: string[]) {
      for (const key of keys) {
        stdin.write(key);
        await wait(60);
      }
    },
    // The current screen as plain text (colors removed).
    screen: () => (frames.at(-1) ?? "").replace(ANSI, ""),
    // The same, with line breaks and runs of spaces collapsed, for text that may wrap.
    // The panel's side borders are dropped too: text wrapped inside a panel would
    // otherwise have "┃ ┃" in the middle of it.
    flat: () => (frames.at(-1) ?? "").replace(ANSI, "").replace(/[┃│]/g, " ").replace(/\s+/g, " "),
    async settle(ms = 120) {
      await wait(ms);
    },
    unmount: () => app.unmount(),
  };
}
