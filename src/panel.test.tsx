// Tests for src/panel.tsx: where the floating panel goes, how it's drawn, and that it
// fully covers the screen underneath.

import { describe, expect, test } from "bun:test";
import { Box, Text, renderToString } from "ink";
import { PickerView, pickerHeight } from "./edit-views.tsx";
import { Panel, panelGeometry } from "./panel.tsx";
import { ESC, makeIssue } from "./testing.ts";

const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
const issue = makeIssue({ identifier: "PD-3066", title: "Design VM deployment flow and provisioning state for the new portal" });

// The panel floats over another screen. These cover where it goes, how big it is,
// and that it fully covers what's underneath.
describe("panelGeometry", () => {
  test("below 100 columns it takes the full width, flush left", () => {
    expect(panelGeometry(80, 40, 10)).toEqual({ width: 80, height: 12, left: 0, top: 14, contentWidth: 76, contentHeight: 10 });
    expect(panelGeometry(30, 40, 5)).toMatchObject({ width: 30, left: 0 });
    expect(panelGeometry(20, 40, 5)).toMatchObject({ width: 20, left: 0 });
    expect(panelGeometry(99, 40, 5)).toMatchObject({ width: 99, left: 0 });
  });

  // A margin on a narrower terminal only reveals stray characters of the screen below
  // (a lone "j" beside the panel's corner looked like a glitch).
  test("so no part of the screen below is left showing at the sides", () => {
    for (let columns = 15; columns < 100; columns += 7) {
      const g = panelGeometry(columns, 30, 8);
      expect(g.left).toBe(0);
      expect(g.width).toBe(columns); // it spans the whole width
    }
  });

  test("from 100 columns it floats centred, at most 64 wide", () => {
    expect(panelGeometry(100, 40, 10)).toEqual({ width: 64, height: 12, left: 18, top: 14, contentWidth: 60, contentHeight: 10 });
    expect(panelGeometry(200, 40, 5)).toMatchObject({ width: 64, left: 68 });
  });

  test("is never taller than the screen minus a 1-line margin", () => {
    expect(panelGeometry(80, 10, 50).height).toBe(8);
    expect(panelGeometry(80, 3, 50).height).toBe(3); // a tiny terminal still gets a usable box
  });

  test("always fits inside the screen, at any terminal size", () => {
    for (let columns = 10; columns <= 220; columns += 5) {
      for (let rows = 5; rows <= 60; rows += 5) {
        for (const wanted of [1, 8, 40]) {
          const g = panelGeometry(columns, rows, wanted);
          expect(g.left).toBeGreaterThanOrEqual(0);
          expect(g.top).toBeGreaterThanOrEqual(0);
          expect(g.left + g.width).toBeLessThanOrEqual(columns);
          expect(g.top + g.height).toBeLessThanOrEqual(rows);
          expect(g.contentWidth).toBeGreaterThanOrEqual(10);
        }
      }
    }
  });
});

describe("Panel floating over another screen", () => {
  const screen = (columns: number, rows: number, wanted: number) => {
    const geometry = panelGeometry(columns, rows, wanted);
    const under = Array.from({ length: rows }, () => "X".repeat(columns));
    const out = renderToString(
      <Box width={columns} height={rows}>
        <Box flexDirection="column" width={columns} height={rows}>
          {under.map((row, i) => (
            <Text key={i}>{row}</Text>
          ))}
        </Box>
        <Panel geometry={geometry}>
          <PickerView title="Change status" issue={issue} options={[{ value: 1, label: "Todo" }]} cursor={0} currentIndex={0} width={geometry.contentWidth} height={geometry.contentHeight} />
        </Panel>
      </Box>,
      { columns },
    )
      .replace(ANSI, "")
      .split("\n");
    return { out, geometry };
  };
  // A narrow screen (full-width panel) and a wide one (a floating panel with margins).
  const sizes: [number, number][] = [
    [40, 14],
    [120, 20],
  ];

  test("draws a rounded border at the computed position, with heavy lines", () => {
    for (const [columns, rows] of sizes) {
      const { out, geometry: g } = screen(columns, rows, pickerHeight(1, 50));
      expect(out[g.top]?.[g.left]).toBe("╭");
      expect(out[g.top]?.[g.left + g.width - 1]).toBe("╮");
      expect(out[g.top + g.height - 1]?.[g.left]).toBe("╰");
      expect(out[g.top + g.height - 1]?.[g.left + g.width - 1]).toBe("╯");
      expect(out[g.top]?.[g.left + 1]).toBe("━"); // heavy horizontal
      expect(out[g.top + 1]?.[g.left]).toBe("┃"); // heavy vertical
    }
  });

  test("shows the title in the bar at the top and the issue under it", () => {
    for (const [columns, rows] of sizes) {
      const { out, geometry: g } = screen(columns, rows, pickerHeight(1, 50));
      expect(out[g.top + 1]).toContain("Change status");
      expect(out[g.top + 2]).toContain("PD-3066");
    }
  });

  test("covers EVERYTHING underneath it: no part of the screen below shows through", () => {
    for (const [columns, rows] of sizes) {
      const { out, geometry: g } = screen(columns, rows, pickerHeight(1, 50));
      for (let row = g.top + 1; row < g.top + g.height - 1; row++) {
        const inside = (out[row] ?? "").slice(g.left + 1, g.left + g.width - 1);
        expect(inside).not.toContain("X");
      }
      expect(out.join("\n")).toContain("Todo"); // and its own content is drawn
    }
  });

  // The panel once had a drop shadow; it was removed because it looked heavy.
  test("has no shadow: nothing is drawn outside the panel", () => {
    for (const [columns, rows] of sizes) {
      const { out } = screen(columns, rows, pickerHeight(1, 50));
      expect(out.join("")).not.toContain("░");
    }
  });

  test("leaves the screen untouched everywhere outside the panel", () => {
    for (const [columns, rows] of sizes) {
      const { out, geometry: g } = screen(columns, rows, pickerHeight(1, 50));
      for (let row = 0; row < rows; row++) {
        const line = out[row] ?? "";
        if (row < g.top || row >= g.top + g.height) {
          expect(line).toBe("X".repeat(columns)); // rows above and below the panel
        } else {
          expect(line.slice(0, g.left)).toBe("X".repeat(g.left)); // left of the panel
          expect(line.slice(g.left + g.width)).toBe("X".repeat(columns - g.left - g.width)); // right of it
        }
      }
    }
  });
});
