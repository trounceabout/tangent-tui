// src/mouse.ts
// Mouse support. Ink has none, and it deliberately DROPS mouse reports from the input it
// passes on, so we can't listen through Ink. Instead a small filter sits between the real
// keyboard stream and Ink: it pulls the mouse reports out (for us) and hands everything
// else on (to Ink), so Ink still sees only keystrokes.
//
// A mouse report arrives as text on the same channel as keys, in the "SGR" format
// (terminal mode 1006): ESC [ < button ; column ; row  M   (pressed or wheel)
//                       ESC [ < button ; column ; row  m   (released)
// with column and row counted from 1.
//
// RISK: if the app dies with mouse reporting still ON, the terminal keeps sending those
// reports for every mouse move, which fills the shell with garbage. So turning it OFF is
// registered for every exit path we can catch (see `exitHooks`).

import { PassThrough } from "node:stream";
import { StringDecoder } from "node:string_decoder";

const ESC = "\u001b";

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------
// Positions are 0-based screen cells (column x, row y) within the terminal pane.
export type MouseEvent =
  | { kind: "press"; button: "left" | "middle" | "right"; x: number; y: number }
  | { kind: "release"; x: number; y: number }
  | { kind: "wheel"; direction: "up" | "down"; x: number; y: number };

// ---------------------------------------------------------------------------
// Parsing (pure)
// ---------------------------------------------------------------------------
// A complete report. The digit runs are capped so a hostile stream can't make us scan far.
const COMPLETE = new RegExp(`${ESC}\\[<(\\d{1,6});(\\d{1,6});(\\d{1,6})([Mm])`, "g");
// The START of a report that hasn't finished arriving (the chunk ended in the middle).
const PARTIAL_TAIL = new RegExp(`${ESC}\\[<[0-9;]{0,24}$`);

// Turn one report's numbers into an event, or null for the ones we ignore.
function toEvent(code: number, column: number, row: number, pressed: boolean): MouseEvent | null {
  const x = column - 1;
  const y = row - 1;
  if (code & 64) {
    // Wheel: 64 = up, 65 = down. (66 and 67 are sideways; ignored.)
    const base = code & 3;
    return base === 0 ? { kind: "wheel", direction: "up", x, y } : base === 1 ? { kind: "wheel", direction: "down", x, y } : null;
  }
  if (code & 32) return null; // motion while a button is held: we don't ask for these
  if (!pressed) return { kind: "release", x, y };
  const button = (["left", "middle", "right"] as const)[code & 3];
  return button === undefined ? null : { kind: "press", button, x, y };
}

// Split `input` into: the mouse events in it, the remaining text (to hand on to Ink), and
// `pending`, the start of a report cut off at the end of the chunk (to try again with the
// next chunk).
export function parseMouse(input: string): { events: MouseEvent[]; text: string; pending: string } {
  let body = input;
  let pending = "";
  const tail = PARTIAL_TAIL.exec(input);
  if (tail) {
    pending = tail[0];
    body = input.slice(0, tail.index);
  }
  const events: MouseEvent[] = [];
  const text = body.replace(COMPLETE, (_match, code: string, column: string, row: string, final: string) => {
    const event = toEvent(Number(code), Number(column), Number(row), final === "M");
    if (event) events.push(event);
    return "";
  });
  return { events, text, pending };
}

// ---------------------------------------------------------------------------
// The filter and the terminal mode
// ---------------------------------------------------------------------------
// 1000 = report presses, releases and the wheel. 1006 = in the SGR format.
const ENABLE = `${ESC}[?1000h${ESC}[?1006h`;
const DISABLE = `${ESC}[?1006l${ESC}[?1000l`;

type Source = NodeJS.EventEmitter & {
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => unknown;
  ref?: () => unknown;
  unref?: () => unknown;
};
type Output = { write: (text: string) => unknown; isTTY?: boolean };

export type MouseInput = {
  // Give THIS to Ink as its stdin: it carries the keystrokes with the mouse reports removed.
  stdin: PassThrough;
  // Be told about each mouse event. Returns a function that stops listening.
  subscribe: (handler: (event: MouseEvent) => void) => () => void;
  enabled: () => boolean;
  // Turn mouse reporting on or off in the terminal. While it is ON the terminal can't do
  // its normal text selection, so the app lets the user switch it off.
  setEnabled: (on: boolean) => void;
  // Turn reporting off and stop reading. Safe to call twice.
  close: () => void;
};

export function createMouseInput(
  source: Source,
  output: Output,
  { enabled = true, exitHooks = false }: { enabled?: boolean; exitHooks?: boolean } = {},
): MouseInput {
  // What Ink reads. It must look like a terminal (isTTY, setRawMode) or Ink refuses to
  // read keys from it, so those calls pass straight through to the real input.
  const filtered = new PassThrough() as PassThrough & {
    isTTY: boolean;
    setRawMode: (mode: boolean) => PassThrough;
    ref: () => PassThrough;
    unref: () => PassThrough;
  };
  filtered.isTTY = source.isTTY === true;
  filtered.setRawMode = (mode) => {
    source.setRawMode?.(mode);
    return filtered;
  };
  filtered.ref = () => {
    source.ref?.();
    return filtered;
  };
  filtered.unref = () => {
    source.unref?.();
    return filtered;
  };

  const handlers = new Set<(event: MouseEvent) => void>();
  const decoder = new StringDecoder("utf8"); // keeps a character split across two chunks whole
  let carry = ""; // the start of a mouse report cut off at the end of the last chunk
  let on = false;
  let closed = false;

  const onData = (chunk: Buffer | string) => {
    const { events, text, pending } = parseMouse(carry + (typeof chunk === "string" ? chunk : decoder.write(chunk)));
    carry = pending;
    for (const event of events) for (const handler of handlers) handler(event);
    if (text !== "") filtered.write(text);
  };
  source.on("data", onData);

  const setEnabled = (next: boolean) => {
    if (closed || next === on) return;
    on = next;
    if (output.isTTY !== false) output.write(next ? ENABLE : DISABLE); // only talk to a real terminal
  };

  // Turn reporting off however the app ends: a normal exit, a crash (the process 'exit'
  // event still fires), or being asked to stop (SIGTERM, SIGHUP).
  const onExit = () => {
    if (on && output.isTTY !== false) output.write(DISABLE);
    on = false;
  };
  const signals = ["SIGTERM", "SIGHUP"] as const;
  const onSignal = () => {
    onExit();
    process.exit(1);
  };
  if (exitHooks) {
    process.on("exit", onExit);
    for (const signal of signals) process.on(signal, onSignal);
  }

  const close = () => {
    if (closed) return;
    onExit();
    closed = true;
    source.off("data", onData);
    handlers.clear();
    if (exitHooks) {
      process.off("exit", onExit);
      for (const signal of signals) process.off(signal, onSignal);
    }
    filtered.end();
  };

  setEnabled(enabled);

  return {
    stdin: filtered,
    subscribe(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    enabled: () => on,
    setEnabled,
    close,
  };
}
