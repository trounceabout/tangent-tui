// Tests for src/help-screen.tsx: how the help panel looks, scrolls and closes.

import { describe, expect, test } from "bun:test";
import type { ReactElement } from "react";
import { Box, renderToString } from "ink";
import { HelpScreen, HelpView, helpHeight } from "./help-screen.tsx";
import { HELP_TITLE, helpLines, helpSubtitle } from "./help.ts";
import { ESC } from "./testing.ts";
import { KEY, mountTerminal } from "./testing-terminal.ts";

const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
function lines(node: ReactElement, columns: number): string[] {
  const out = renderToString(
    <Box flexDirection="column" width={columns}>
      {node}
    </Box>,
    { columns },
  );
  return out.replace(ANSI, "").split("\n");
}
const width = (text: string) => Bun.stringWidth(text);

const all = helpLines("list");
const view = (top: number, columns: number, height: number) =>
  lines(<HelpView title={HELP_TITLE} subtitle={helpSubtitle("list")} lines={all} top={top} width={columns} height={height} />, columns);

describe("helpHeight", () => {
  test("is the header, every line, and the footer, when there's room", () => {
    expect(helpHeight(10, 100)).toBe(3 + 10 + 2);
  });

  test("never exceeds the room it's given (the rest scrolls)", () => {
    expect(helpHeight(100, 12)).toBe(12);
    expect(helpHeight(100, 6)).toBe(6);
  });

  test("always leaves at least one line for content", () => {
    expect(helpHeight(5, 3)).toBe(6);
  });
});

describe("HelpView", () => {
  test("shows the title bar, the subtitle, and the keys with their descriptions lined up", () => {
    const out = view(0, 40, helpHeight(all.length, 100));
    expect(out[0]).toBe("Keyboard help");
    expect(out[1]).toBe("On the board");
    expect(out.join("\n")).toContain("Move");
    // Descriptions are in one column: find where "move" starts on the first entry row, and "this help" on another.
    const rowFor = (needle: string) => out.find((l) => l.includes(needle)) ?? "";
    const col = (row: string, text: string) => row.indexOf(text);
    expect(col(rowFor("move"), "move")).toBe(col(rowFor("open in browser"), "open in browser"));
  });

  test("when everything fits there is no scroll hint, just how to close", () => {
    const height = helpHeight(all.length, 100);
    const out = view(0, 40, height);
    expect(out[height - 1]).toBe("esc close");
    expect(out.join("\n")).not.toContain("↑↓ scroll"); // the hint itself (the help text has its own "scroll" rows)
  });

  test("when it doesn't fit, it scrolls: arrows show which way there's more", () => {
    const height = helpHeight(all.length, 12); // 12 rows: 7 body lines
    const top = view(0, 40, height).join("\n");
    expect(top).toContain("▼ ↑↓ scroll");
    expect(top).not.toContain("▲");
    const middle = view(5, 40, height).join("\n");
    expect(middle).toContain("▲ ▼ ↑↓ scroll");
    const bottom = view(all.length - 7, 40, height).join("\n");
    expect(bottom).toContain("▲ ↑↓ scroll");
    expect(bottom).not.toContain("▼");
  });

  test("a window starting at `top` shows exactly the lines from there", () => {
    const height = helpHeight(all.length, 12);
    const out = view(3, 40, height);
    expect(out).toHaveLength(height);
    const first = all[3];
    const expected = first?.kind === "entry" ? first.keys.trim() : first?.kind === "title" ? first.text : "";
    expect(out[3]).toContain(expected); // the body starts on row 3, under the 3-line header
  });

  test("no line is ever wider than the panel, and every key row is one line", () => {
    for (const columns of [14, 20, 24, 28, 32, 40, 60]) {
      const height = helpHeight(all.length, 100);
      const out = view(0, columns, height);
      expect(out).toHaveLength(height);
      for (const line of out) expect(width(line)).toBeLessThanOrEqual(columns);
    }
  });

  test("it fills exactly the height reported: the footer is the last line, the line above it blank", () => {
    for (const columns of [20, 30, 60]) {
      const height = helpHeight(all.length, 100);
      const out = view(0, columns, height);
      expect(out[height - 1]?.trim()).not.toBe("");
      expect(out[height - 2]?.trim()).toBe("");
      expect(out[height - 3]?.trim()).not.toBe(""); // the last key row, not a gap
    }
  });
});

describe("HelpScreen (with a fake keyboard)", () => {
  const mount = (kind: "list" | "detail", { columns = 60, rows = 40 } = {}) => {
    const events = { closed: 0 };
    const term = mountTerminal(
      <Box width={columns} height={rows}>
        <HelpScreen kind={kind} onClose={() => events.closed++} />
      </Box>,
      { columns, rows },
    );
    return { ...term, events };
  };

  test("shows the keys for the screen it was opened on", async () => {
    const list = mount("list");
    await list.waitForText("Keyboard help"); // the first frame is drawn
    expect(list.screen()).toContain("On the board");
    expect(list.screen()).toContain("cycle team");
    list.unmount();

    const detail = mount("detail");
    await detail.waitForText("Keyboard help"); // the first frame is drawn
    expect(detail.screen()).toContain("On an issue's detail screen");
    expect(detail.screen()).toContain("back to the board");
    detail.unmount();
  });

  test.each([
    ["esc", KEY.esc],
    ["?", "?"],
    ["q", "q"],
  ])("%s closes it", async (_name, key) => {
    const help = mount("list");
    await help.waitForText("Keyboard help"); // the first frame is drawn
    await help.press(key);
    expect(help.events.closed).toBe(1);
    help.unmount();
  });

  test("other keys don't close it", async () => {
    const help = mount("list");
    await help.waitForText("Keyboard help"); // the first frame is drawn
    await help.press("x", "o", "s", KEY.enter);
    expect(help.events.closed).toBe(0);
    help.unmount();
  });

  test("scrolls when the terminal is short: j moves down, k back, G to the bottom, g to the top", async () => {
    const help = mount("list", { rows: 14 }); // too short for all 29 lines
    await help.waitForText("Keyboard help"); // the first frame is drawn
    expect(help.screen()).toContain("▼");
    expect(help.screen()).not.toContain("quit"); // the last row is below the fold
    await help.press("G");
    expect(help.screen()).toContain("quit");
    expect(help.screen()).toContain("▲");
    expect(help.screen()).not.toContain("▼");
    await help.press("g");
    expect(help.screen()).toContain("Move");
    expect(help.screen()).not.toContain("▲");
    await help.press(KEY.j, KEY.j, KEY.j);
    expect(help.screen()).toContain("▲ ▼");
    await help.press(KEY.k, KEY.k, KEY.k);
    expect(help.screen()).not.toContain("▲");
    help.unmount();
  });

  test("a burst of j in one chunk scrolls several lines (see keys.ts)", async () => {
    const help = mount("list", { rows: 14 });
    await help.waitForText("Keyboard help"); // the first frame is drawn
    await help.press("jjjj");
    expect(help.screen()).toContain("▲");
    expect(help.events.closed).toBe(0);
    help.unmount();
  });

  test("a short list needs no scrolling: a tall terminal shows every line and G does nothing", async () => {
    const help = mount("detail", { rows: 40 });
    await help.waitForText("Keyboard help"); // the first frame is drawn
    const before = help.screen();
    await help.press("G", KEY.j);
    expect(help.screen()).toBe(before);
    expect(help.screen()).not.toContain("▼");
    help.unmount();
  });
});
