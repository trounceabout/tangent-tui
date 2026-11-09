// Tests for src/mouse.ts: reading mouse reports, and keeping them out of Ink's input.

import { afterEach, describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { createMouseInput, parseMouse } from "./mouse.ts";
import type { MouseEvent, MouseInput } from "./mouse.ts";
import { ESC } from "./testing.ts";

const report = (code: number, column: number, row: number, final: "M" | "m" = "M") => `${ESC}[<${code};${column};${row}${final}`;
const wait = (ms = 15) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
describe("parseMouse: reading a report", () => {
  test("a left press, with columns and rows turned into 0-based cells", () => {
    expect(parseMouse(report(0, 12, 5))).toEqual({ events: [{ kind: "press", button: "left", x: 11, y: 4 }], text: "", pending: "" });
  });

  test("middle and right presses", () => {
    expect(parseMouse(report(1, 1, 1)).events).toEqual([{ kind: "press", button: "middle", x: 0, y: 0 }]);
    expect(parseMouse(report(2, 1, 1)).events).toEqual([{ kind: "press", button: "right", x: 0, y: 0 }]);
  });

  test("a lowercase m means the button was released", () => {
    expect(parseMouse(report(0, 3, 4, "m")).events).toEqual([{ kind: "release", x: 2, y: 3 }]);
  });

  test("the wheel: 64 is up, 65 is down", () => {
    expect(parseMouse(report(64, 10, 10)).events).toEqual([{ kind: "wheel", direction: "up", x: 9, y: 9 }]);
    expect(parseMouse(report(65, 10, 10)).events).toEqual([{ kind: "wheel", direction: "down", x: 9, y: 9 }]);
  });

  test("modifier keys (shift 4, alt 8, ctrl 16) don't change which button it was", () => {
    for (const modifier of [4, 8, 16, 28]) {
      expect(parseMouse(report(modifier, 2, 2)).events).toEqual([{ kind: "press", button: "left", x: 1, y: 1 }]);
    }
  });

  test("sideways wheel and mouse motion are ignored, but still removed from the text", () => {
    for (const code of [66, 67, 32, 35]) expect(parseMouse(report(code, 4, 4))).toEqual({ events: [], text: "", pending: "" });
  });

  test("several reports in one chunk, with ordinary text between them", () => {
    const parsed = parseMouse(`j${report(0, 1, 1)}k${report(64, 2, 2)}l`);
    expect(parsed.text).toBe("jkl");
    expect(parsed.events).toHaveLength(2);
  });
});

describe("parseMouse: leaving everything else alone", () => {
  test.each([
    ["arrow keys", `${ESC}[A${ESC}[B`],
    ["a modified arrow", `${ESC}[1;5A`],
    ["bracketed paste markers", `${ESC}[200~hello${ESC}[201~`],
    ["plain text", "hello world"],
    ["a lone Escape", ESC],
    ["the start of an arrow key at the end of a chunk", `x${ESC}[`],
  ])("%s passes through untouched", (_name, input) => {
    expect(parseMouse(input)).toEqual({ events: [], text: input, pending: "" });
  });

  test("a report with absurdly long numbers is not mistaken for one", () => {
    const junk = `${ESC}[<${"1".repeat(30)};1;1M`;
    expect(parseMouse(junk).events).toEqual([]);
  });
});

describe("parseMouse: a report cut off at the end of a chunk", () => {
  test("the unfinished start is held back as `pending`, not passed on as text", () => {
    expect(parseMouse(`ab${ESC}[<0;12`)).toEqual({ events: [], text: "ab", pending: `${ESC}[<0;12` });
    expect(parseMouse(`${ESC}[<`)).toEqual({ events: [], text: "", pending: `${ESC}[<` });
  });

  test("a complete report at the very end is NOT pending", () => {
    expect(parseMouse(`ab${report(0, 1, 1)}`).pending).toBe("");
  });

  test("pending text plus the rest of the report parses as one event", () => {
    const first = parseMouse(`${ESC}[<0;1`);
    const second = parseMouse(`${first.pending}2;5M`);
    expect(second.events).toEqual([{ kind: "press", button: "left", x: 11, y: 4 }]);
  });
});

describe("parseMouse: stays fast on hostile input", () => {
  test("a megabyte of repeated report starts", () => {
    const start = performance.now();
    parseMouse(`${ESC}[<`.repeat(200_000));
    parseMouse(`${ESC}[<0;`.repeat(100_000));
    parseMouse(`${ESC}[<${"1;".repeat(300_000)}`);
    expect(performance.now() - start).toBeLessThan(500);
  });
});

// ---------------------------------------------------------------------------
// The filter, with a fake keyboard and a fake terminal.
class FakeSource extends PassThrough {
  isTTY = true;
  rawModes: boolean[] = [];
  refs = 0;
  setRawMode(mode: boolean) {
    this.rawModes.push(mode);
    return this;
  }
  ref() {
    this.refs++;
    return this;
  }
}

const ENABLE = `${ESC}[?1000h${ESC}[?1006h`;
const DISABLE = `${ESC}[?1006l${ESC}[?1000l`;

describe("createMouseInput", () => {
  const open: MouseInput[] = [];
  afterEach(() => {
    for (const input of open.splice(0)) input.close();
  });

  const setup = (options: Parameters<typeof createMouseInput>[2] = {}, outputIsTTY: boolean | undefined = true) => {
    const source = new FakeSource();
    const written: string[] = [];
    const output = { write: (text: string) => written.push(text), isTTY: outputIsTTY };
    const mouse = createMouseInput(source, output, options);
    open.push(mouse);
    let keys = "";
    mouse.stdin.setEncoding("utf8");
    mouse.stdin.on("data", (chunk: string) => (keys += chunk));
    const events: MouseEvent[] = [];
    mouse.subscribe((event) => events.push(event));
    return { source, written, mouse, events, keys: () => keys };
  };

  test("separates the mouse reports (for us) from the keystrokes (for Ink)", async () => {
    const { source, events, keys } = setup();
    source.write(Buffer.from(`x${report(0, 3, 4)}y`));
    await wait();
    expect(keys()).toBe("xy"); // Ink would see only these
    expect(events).toEqual([{ kind: "press", button: "left", x: 2, y: 3 }]);
  });

  test("a report split across two chunks is one event and never leaks to Ink", async () => {
    const { source, events, keys } = setup();
    source.write(Buffer.from(`a${ESC}[<0;1`));
    await wait();
    source.write(Buffer.from("2;5Mb"));
    await wait();
    expect(keys()).toBe("ab");
    expect(events).toEqual([{ kind: "press", button: "left", x: 11, y: 4 }]);
  });

  test("a multi-byte character split across chunks stays whole", async () => {
    const { source, keys } = setup();
    const bytes = Buffer.from("é日");
    source.write(bytes.subarray(0, 1)); // half of "é"
    await wait();
    source.write(bytes.subarray(1));
    await wait();
    expect(keys()).toBe("é日");
  });

  test("looks like a terminal to Ink, and passes raw mode through to the real keyboard", () => {
    const { source, mouse } = setup();
    const stdin = mouse.stdin as unknown as { isTTY: boolean; setRawMode: (m: boolean) => unknown; ref: () => unknown };
    expect(stdin.isTTY).toBe(true);
    stdin.setRawMode(true);
    stdin.ref();
    expect(source.rawModes).toEqual([true]);
    expect(source.refs).toBe(1);
  });

  test("subscribers can stop listening", async () => {
    const { source, mouse, events } = setup();
    const more: MouseEvent[] = [];
    const stop = mouse.subscribe((event) => more.push(event));
    source.write(Buffer.from(report(0, 1, 1)));
    await wait();
    stop();
    source.write(Buffer.from(report(0, 2, 2)));
    await wait();
    expect(more).toHaveLength(1);
    expect(events).toHaveLength(2); // the first subscriber still hears both
  });
});

describe("createMouseInput: turning mouse reporting on and off in the terminal", () => {
  const open: MouseInput[] = [];
  afterEach(() => {
    for (const input of open.splice(0)) input.close();
  });
  const setup = (options: Parameters<typeof createMouseInput>[2] = {}, outputIsTTY: boolean | undefined = true) => {
    const written: string[] = [];
    const mouse = createMouseInput(new FakeSource(), { write: (text: string) => written.push(text), isTTY: outputIsTTY }, options);
    open.push(mouse);
    return { written, mouse };
  };

  test("is on by default and says so to the terminal", () => {
    const { written, mouse } = setup();
    expect(written).toEqual([ENABLE]);
    expect(mouse.enabled()).toBe(true);
  });

  test("can start off, and then writes nothing", () => {
    const { written, mouse } = setup({ enabled: false });
    expect(written).toEqual([]);
    expect(mouse.enabled()).toBe(false);
  });

  test("toggling writes the matching sequence, once per change", () => {
    const { written, mouse } = setup();
    mouse.setEnabled(false);
    mouse.setEnabled(false); // no change: nothing written
    mouse.setEnabled(true);
    expect(written).toEqual([ENABLE, DISABLE, ENABLE]);
  });

  test("close() turns reporting OFF, and a second close writes nothing", () => {
    const { written, mouse } = setup();
    mouse.close();
    mouse.close();
    expect(written).toEqual([ENABLE, DISABLE]);
  });

  test("close() writes nothing if it was already off", () => {
    const { written, mouse } = setup({ enabled: false });
    mouse.close();
    expect(written).toEqual([]);
  });

  test("after close() it ignores further changes and keystrokes", async () => {
    const source = new FakeSource();
    const written: string[] = [];
    const mouse = createMouseInput(source, { write: (t: string) => written.push(t), isTTY: true });
    mouse.close();
    mouse.setEnabled(true);
    expect(written).toEqual([ENABLE, DISABLE]); // nothing new
    expect(source.listenerCount("data")).toBe(0);
  });

  test("never writes escape codes to something that is not a terminal", () => {
    const { written, mouse } = setup({}, false);
    mouse.setEnabled(false);
    mouse.setEnabled(true);
    mouse.close();
    expect(written).toEqual([]);
  });
});

// SAFETY: the app must turn mouse reporting off however it ends, or the terminal is left
// printing a report for every mouse move.
describe("createMouseInput: exit hooks", () => {
  test("are NOT installed unless asked for (so tests don't leak process handlers)", () => {
    const before = process.listenerCount("exit");
    const mouse = createMouseInput(new FakeSource(), { write: () => {}, isTTY: true });
    expect(process.listenerCount("exit")).toBe(before);
    mouse.close();
  });

  test("installs 'exit', SIGTERM and SIGHUP handlers, and removes them on close", () => {
    const before = { exit: process.listenerCount("exit"), term: process.listenerCount("SIGTERM"), hup: process.listenerCount("SIGHUP") };
    const mouse = createMouseInput(new FakeSource(), { write: () => {}, isTTY: true }, { exitHooks: true });
    expect(process.listenerCount("exit")).toBe(before.exit + 1);
    expect(process.listenerCount("SIGTERM")).toBe(before.term + 1);
    expect(process.listenerCount("SIGHUP")).toBe(before.hup + 1);
    mouse.close();
    expect(process.listenerCount("exit")).toBe(before.exit);
    expect(process.listenerCount("SIGTERM")).toBe(before.term);
    expect(process.listenerCount("SIGHUP")).toBe(before.hup);
  });

  test("the 'exit' handler turns reporting off, even though close() was never called", () => {
    const written: string[] = [];
    const existing = new Set(process.listeners("exit"));
    const mouse = createMouseInput(new FakeSource(), { write: (t: string) => written.push(t), isTTY: true }, { exitHooks: true });
    const ours = process.listeners("exit").find((listener) => !existing.has(listener));
    expect(ours).toBeDefined();
    ours?.(0); // what Node does when the process is about to exit
    expect(written).toEqual([ENABLE, DISABLE]);
    mouse.close();
    expect(written).toEqual([ENABLE, DISABLE]); // and close() doesn't turn it off a second time
  });
});
