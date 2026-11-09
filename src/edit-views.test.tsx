// Tests for src/edit-views.tsx: what the edit screens show.

import { describe, expect, test } from "bun:test";
import type { ReactElement } from "react";
import { Box, Text, renderToString } from "ink";
import { ConfirmView, MessageView, Panel, PickerView, confirmHeight, messageHeight, panelGeometry, pickerHeight } from "./edit-views.tsx";
import type { EditOption } from "./edit.ts";
import { ESC, makeIssue } from "./testing.ts";

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

const issue = makeIssue({ identifier: "PD-3066", title: "Design VM deployment flow and provisioning state for the new portal" });
const statuses: EditOption[] = [
  { value: "a", label: "Backlog", color: "#bec2c8" },
  { value: "b", label: "Todo", color: "#e2e2e2" },
  { value: "c", label: "In Progress", color: "#f2c94c" },
  { value: "d", label: "Done", color: "#5e6ad2", finished: true },
];

// ---------------------------------------------------------------------------
describe("PickerView", () => {
  const render = (cursor: number, currentIndex = 1, columns = 60, height = 20, options = statuses) =>
    lines(<PickerView title="Change status" issue={issue} options={options} cursor={cursor} currentIndex={currentIndex} width={columns} height={height} />, columns);

  test("shows the title, the issue, and every option", () => {
    const out = render(0);
    expect(out[0]).toBe("Change status");
    expect(out[1]).toContain("PD-3066");
    expect(out[1]).toContain("Design VM deployment");
    for (const label of ["Backlog", "Todo", "In Progress", "Done"]) expect(out.join("\n")).toContain(label);
  });

  test("marks the cursor row with a bar, and only that row", () => {
    const out = render(2);
    const marked = out.filter((l) => l.startsWith("▌"));
    expect(marked).toHaveLength(1);
    expect(marked[0]).toContain("In Progress");
  });

  test("labels the current value and the options that finish the work", () => {
    const out = render(0, 1).join("\n");
    expect(out).toContain("Todo  (current)");
    expect(out).toContain("Done  finishes the work");
    expect(out).not.toContain("Backlog  (current)");
  });

  test("with no current value in the list, nothing is labelled current", () => {
    expect(render(0, -1).join("\n")).not.toContain("(current)");
  });

  test("shows the key hints", () => {
    expect(render(0).join("\n")).toContain("enter select");
  });

  test("scrolls to keep the cursor visible when there are more options than rows", () => {
    const many: EditOption[] = Array.from({ length: 20 }, (_, i) => ({ value: i, label: `Option ${i}` }));
    const out = render(15, -1, 60, 10, many);
    expect(out.join("\n")).toContain("Option 15");
    expect(out.join("\n")).not.toContain("Option 0\n");
    expect(out.filter((l) => l.startsWith("▌"))[0]).toContain("Option 15");
    expect(out.length).toBeLessThanOrEqual(10);
  });

  test("no line is wider than the pane", () => {
    for (const columns of [20, 30, 47, 80]) {
      for (const line of render(0, 1, columns)) expect(width(line)).toBeLessThanOrEqual(columns);
    }
  });
});

// ---------------------------------------------------------------------------
describe("ConfirmView", () => {
  const render = (props: Partial<Parameters<typeof ConfirmView>[0]> = {}, columns = 60) =>
    lines(
      <ConfirmView
        title="Change status"
        issue={issue}
        field="Status"
        from="Todo"
        to="In Progress"
        toColor="#f2c94c"
        warning={null}
        dryRun={false}
        noChange={false}
        width={columns}
        height={20}
        {...props}
      />,
      columns,
    );

  test("shows exactly what will change: field, from, to", () => {
    const out = render().join("\n");
    expect(out).toContain("Status  Todo  →  ● In Progress");
    expect(out).toContain("enter apply");
  });

  test("a finishing status shows the validation-comment warning", () => {
    const out = render({ warning: "This marks the work as finished. Post a validation comment first." }).join("\n");
    expect(out).toContain("⚠ This marks the work as finished");
  });

  test("dry-run mode says plainly that nothing will be sent", () => {
    expect(render({ dryRun: true }).join("\n")).toContain("DRY RUN: nothing will be sent to Linear.");
    expect(render({ dryRun: false }).join("\n")).not.toContain("DRY RUN");
  });

  test("when nothing would change, it says so and offers no 'apply'", () => {
    const out = render({ noChange: true, to: "Todo", warning: "should not show" }).join("\n");
    expect(out).toContain("Status is already Todo. Nothing to change.");
    expect(out).not.toContain("enter apply");
    expect(out).toContain("enter close");
    expect(out).not.toContain("should not show"); // no warning when there's no change
    expect(out).not.toContain("→");
  });

  test("no line is wider than the pane", () => {
    for (const columns of [20, 30, 47, 80]) {
      const out = render({ warning: "A fairly long warning that has to wrap across several lines of text.", dryRun: true }, columns);
      for (const line of out) expect(width(line)).toBeLessThanOrEqual(columns);
    }
  });
});

// ---------------------------------------------------------------------------
describe("MessageView", () => {
  const render = (props: Partial<Parameters<typeof MessageView>[0]> = {}, columns = 40) =>
    lines(<MessageView title="Change estimate" issue={issue} message="Hello there" tone="info" hint="esc close" width={columns} height={12} {...props} />, columns);

  test("shows the message and the hint", () => {
    const out = render().join("\n");
    expect(out).toContain("Hello there");
    expect(out).toContain("esc close");
  });

  test("wraps a long message to the pane width", () => {
    const out = render({ message: "word ".repeat(30) }, 30);
    for (const line of out) expect(width(line)).toBeLessThanOrEqual(30);
    expect(out.filter((l) => l.includes("word")).length).toBeGreaterThan(2);
  });
});

// ---------------------------------------------------------------------------
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

// If a height helper undercounts, the view's footer or last line is clipped; if it
// overcounts, there's a gap. So: at the helper's height, the last body line is right
// above the blank line and the hint, and the hint is the very last line.
describe("each view fills exactly the height its helper reports", () => {
  const atLeast = (out: string[], height: number) => {
    expect(out).toHaveLength(height);
    expect(out[height - 1]?.trim()).not.toBe(""); // the key hint
    expect(out[height - 2]?.trim()).toBe(""); // the blank line above it
    expect(out[height - 3]?.trim()).not.toBe(""); // the last body line, not a gap
  };

  test("PickerView", () => {
    for (const count of [1, 3, 5, 11]) {
      const options: EditOption[] = Array.from({ length: count }, (_, i) => ({ value: i, label: `Option ${i}` }));
      const height = pickerHeight(count, 50);
      const out = lines(<PickerView title="T" issue={issue} options={options} cursor={0} currentIndex={0} width={40} height={height} />, 40);
      atLeast(out, height);
      expect(out.join("\n")).toContain(`Option ${count - 1}`); // the last option isn't clipped
    }
  });

  // The scrolling assumes every option is exactly ONE line. A long note ("finishes the
  // work") used to wrap onto a second line in a narrow panel, pushing the last options
  // out of view. Each option must be one line, at any width.
  test("every option is exactly one line, even with long notes in a narrow panel", () => {
    const options: EditOption[] = [
      { value: "a", label: "Backlog", color: "#bec2c8" },
      { value: "b", label: "In Progress", color: "#f2c94c" },
      { value: "c", label: "Ready to Release", color: "#5e6ad2", finished: true },
      { value: "d", label: "Done", color: "#5e6ad2", finished: true },
      { value: "e", label: "Canceled", color: "#95a2b3", finished: true },
      { value: "f", label: "Duplicate", color: "#95a2b3", finished: true },
    ];
    for (const columns of [14, 20, 24, 28, 32, 40, 60]) {
      const height = pickerHeight(options.length, 50);
      const out = lines(<PickerView title="T" issue={issue} options={options} cursor={1} currentIndex={1} width={columns} height={height} />, columns);
      const rows = out.slice(3, 3 + options.length); // directly under the 3-line header
      expect(rows).toHaveLength(options.length);
      for (const row of rows) {
        expect(row.trim()).not.toBe(""); // each option sits on its own line, none pushed out
        expect(width(row)).toBeLessThanOrEqual(columns);
      }
      expect(out[3 + options.length]?.trim()).toBe(""); // and the blank line before the hint follows directly
      // A row that doesn't fit is cut with an ellipsis, so you can tell text is missing.
      if (columns <= 28) expect(rows.some((row) => row.endsWith("…"))).toBe(true);
    }
  });

  test("pickerHeight never exceeds the room it's given, and scrolls instead", () => {
    expect(pickerHeight(100, 12)).toBe(12);
    expect(pickerHeight(2, 12)).toBe(3 + 2 + 2);
  });

  test("ConfirmView, with and without a warning and the dry-run banner", () => {
    const cases = [
      { warning: null, dryRun: false, noChange: false },
      { warning: null, dryRun: true, noChange: false },
      { warning: "A fairly long warning that has to wrap across several lines of text.", dryRun: false, noChange: false },
      { warning: "A fairly long warning that has to wrap across several lines of text.", dryRun: true, noChange: false },
      { warning: "ignored when nothing changes", dryRun: true, noChange: true },
    ];
    // Including narrow widths, where the banner and the warning wrap onto more lines.
    // (A narrow panel once cut the banner and squashed the warning's first line.)
    for (const columns of [14, 20, 24, 30, 38, 44, 47, 60]) {
      for (const flags of cases) {
        const details = { field: "Status", from: "Todo", to: "In Progress", ...flags };
        const height = confirmHeight(columns, details);
        const out = lines(<ConfirmView title="T" issue={issue} {...details} width={columns} height={height} />, columns);
        atLeast(out, height);
        // Flexbox squashes blank spacing lines to make things fit, so an undercounted
        // height would still show the text. Check the SPACING survived: a blank line
        // above the banner, and above the warning.
        const blankAbove = (needle: string) => {
          const at = out.findIndex((l) => l.includes(needle));
          expect(at).toBeGreaterThan(0);
          expect(out[at - 1]?.trim()).toBe("");
        };
        if (flags.dryRun) blankAbove("DRY RUN");
        if (flags.warning && !flags.noChange) blankAbove("⚠");
        // Nothing may be cut: every word of the banner and of the warning is on screen.
        const flat = out.join(" ").replace(/\s+/g, " ").replace(/│/g, "");
        if (flags.dryRun) expect(flat).toContain("to Linear.");
        if (flags.warning && !flags.noChange) expect(flat).toContain("lines of text.");
        // The destination is the one thing that must always be readable on a confirm
        // screen. (Below 20 columns even "→ ● In Progress" can't fit.)
        if (columns >= 20 && !flags.noChange) expect(flat).toContain("In Progress");
      }
    }
  });

  test("MessageView, for short and long messages", () => {
    for (const message of ["Saving…", "A much longer message that needs several lines to be shown in a narrow panel."]) {
      for (const columns of [24, 40]) {
        const height = messageHeight(columns, message);
        atLeast(lines(<MessageView title="T" issue={issue} message={message} tone="info" hint="esc" width={columns} height={height} />, columns), height);
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
