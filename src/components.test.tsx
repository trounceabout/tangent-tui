// Tests for src/components.tsx: how the pieces of the screen are laid out.
//
// Each component is rendered to plain text with Ink's renderToString at a chosen
// pane width. These guard the layout bugs we hit while building: wrapped issue IDs,
// squashed two-line rows, and rows wider than the pane.

import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import type { ReactElement } from "react";
import { Box, Text, renderToString } from "ink";
import { CycleHeader, GroupHeader, IssueRow, PriorityGlyph, fitLabels, issueHeight } from "./components.tsx";
import { ESC, labels, makeIssue } from "./testing.ts";

afterEach(() => setSystemTime());

const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`, "g");

// Render inside a COLUMN box of the pane's width, like the real app does (a row
// box would let children overflow and hide the problems we want to catch).
function lines(node: ReactElement, columns: number): string[] {
  const out = renderToString(
    <Box flexDirection="column" width={columns}>
      {node}
    </Box>,
    { columns },
  );
  return out.replace(ANSI, "").split("\n");
}

// How many terminal lines a component really takes: stack a marker under it and
// see which line the marker lands on. The scrolling code relies on these heights.
function heightOf(node: ReactElement): number {
  const output = lines(
    <>
      {node}
      <Text>END_MARKER</Text>
    </>,
    80,
  );
  return output.findIndex((line) => line.includes("END_MARKER"));
}

const width = (text: string) => Bun.stringWidth(text);
const tall = makeIssue({
  identifier: "PD-3066",
  title: "Design VM deployment flow and provisioning state for the new portal",
  priority: 1,
  estimate: 3,
  dueDate: "2020-01-02",
  labels: labels("Managed Hosting portal", "Feature", "CPQ"),
});

// ---------------------------------------------------------------------------
describe("IssueRow content", () => {
  test("first line: ID, title and estimate. Second line: labels and due date.", () => {
    const [first, second] = lines(<IssueRow issue={tall} selected={false} width={100} />, 100);
    expect(first).toContain("PD-3066");
    expect(first).toContain("Design VM deployment flow and provisioning state for the new portal");
    expect(first?.trimEnd().endsWith("M")).toBe(true); // 3 = "M" on a T-shirt team
    expect(second).toContain("● Managed Hosting portal");
    expect(second).toContain("● Feature");
    expect(second?.trimEnd().endsWith("due Jan 2")).toBe(true);
  });

  test("a row with no estimate shows none", () => {
    const [first] = lines(<IssueRow issue={makeIssue({ title: "Just a title", estimate: null })} selected={false} width={60} />, 60);
    expect(first?.trimEnd().endsWith("Just a title")).toBe(true);
  });

  test("the selected row starts with a marker bar; others start with a space", () => {
    const issue = makeIssue();
    expect(lines(<IssueRow issue={issue} selected width={60} />, 60)[0]?.startsWith("▌")).toBe(true);
    expect(lines(<IssueRow issue={issue} selected={false} width={60} />, 60)[0]?.startsWith(" ")).toBe(true);
  });

  test("urgent shows a ! block; other priorities show bars", () => {
    expect(lines(<IssueRow issue={makeIssue({ priority: 1 })} selected={false} width={60} />, 60)[0]).toContain(" ! ");
    expect(lines(<IssueRow issue={makeIssue({ priority: 2 })} selected={false} width={60} />, 60)[0]).toContain("▂▄▆");
  });

  test("labels that don't fit collapse into +N", () => {
    const narrow = lines(<IssueRow issue={tall} selected={false} width={34} />, 34)[1];
    expect(narrow).toMatch(/\+\d/);
  });

  test("a row with no labels and no due date is a single line", () => {
    const plain = makeIssue({ labels: { nodes: [] }, dueDate: null });
    expect(lines(<IssueRow issue={plain} selected={false} width={60} />, 60).filter((l) => l.trim() !== "")).toHaveLength(1);
  });
});

describe("IssueRow layout", () => {
  const widths = [24, 30, 40, 47, 60, 80, 100];

  test("the issue ID is never wrapped or squeezed, at any width", () => {
    for (const columns of widths) {
      const [first] = lines(<IssueRow issue={tall} selected={false} width={columns} />, columns);
      expect(first).toContain("PD-3066");
    }
  });

  test("no line is ever wider than the pane", () => {
    for (const columns of widths) {
      for (const line of lines(<IssueRow issue={tall} selected width={columns} />, columns)) {
        expect(width(line)).toBeLessThanOrEqual(columns);
      }
    }
  });

  test("a title too long for the pane is cut with an ellipsis, a short one is not", () => {
    expect(lines(<IssueRow issue={tall} selected={false} width={47} />, 47)[0]).toContain("…");
    expect(lines(<IssueRow issue={tall} selected={false} width={100} />, 100)[0]).not.toContain("…");
  });

  test("the estimate stays at the right edge, in the same column for every row", () => {
    const a = lines(<IssueRow issue={makeIssue({ title: "short", estimate: 1 })} selected={false} width={50} />, 50)[0] ?? "";
    const b = lines(<IssueRow issue={makeIssue({ title: "a much longer title here", estimate: 8 })} selected={false} width={50} />, 50)[0] ?? "";
    expect(a.trimEnd().length).toBe(b.trimEnd().length);
  });
});

describe("IssueRow in a container that is too short", () => {
  // The bug: in a fixed-height column, flexbox squashed a 2-line row down to 1 line,
  // so its detail line was drawn on top of the next row. Rows must keep their height
  // and the overflow must be clipped instead.
  // Three 2-line rows (6 lines) in a 4-line box. With only two rows the rounding
  // happens to hide the squash; three rows expose it.
  test("keeps its full height and clips the overflow, instead of squashing", () => {
    const row = (id: string) => makeIssue({ identifier: id, title: `row ${id}`, labels: labels("CPQ") });
    const out = renderToString(
      <Box flexDirection="column" width={60} height={4} overflow="hidden">
        {["PD-1", "PD-2", "PD-3"].map((id) => (
          <IssueRow key={id} issue={row(id)} selected={false} width={60} />
        ))}
      </Box>,
      { columns: 60 },
    )
      .replace(ANSI, "")
      .split("\n");
    expect(out).toHaveLength(4);
    expect(out[0]).toContain("PD-1");
    expect(out[1]).toContain("● CPQ"); // row 1's detail line is intact
    expect(out[2]).toContain("PD-2");
    expect(out[3]).toContain("● CPQ"); // row 2's detail line is intact, row 3 is clipped off
  });
});

// The scrolling code multiplies on these numbers, so they must be exactly right.
describe("issueHeight matches what is actually drawn", () => {
  const cases = [
    ["no labels, no due date", makeIssue({ labels: { nodes: [] }, dueDate: null })],
    ["labels only", makeIssue({ labels: labels("CPQ") })],
    ["due date only", makeIssue({ dueDate: "2030-01-01" })],
    ["labels and due date", tall],
  ] as const;

  // Both view settings: the scroll math breaks if the height and the drawing ever disagree.
  for (const showLabels of [true, false]) {
    for (const [name, issue] of cases) {
      test(`${name} (labels ${showLabels ? "shown" : "hidden"})`, () => {
        expect(heightOf(<IssueRow issue={issue} selected={false} width={80} showLabels={showLabels} />)).toBe(
          issueHeight(issue, showLabels),
        );
      });
    }
  }

  test("1 line without details, 2 with", () => {
    expect(issueHeight(makeIssue())).toBe(1);
    expect(issueHeight(tall)).toBe(2);
  });

  test("with labels hidden, only a due date makes a second line", () => {
    const labelsOnly = makeIssue({ labels: labels("CPQ"), dueDate: null });
    const dueOnly = makeIssue({ labels: { nodes: [] }, dueDate: "2030-01-01" });
    expect(issueHeight(labelsOnly)).toBe(2);
    expect(issueHeight(labelsOnly, false)).toBe(1); // the row gets shorter
    expect(issueHeight(dueOnly, false)).toBe(2); // the due date keeps its line
    expect(issueHeight(tall, false)).toBe(2);
  });
});

describe("IssueRow with labels hidden", () => {
  test("no label names are drawn, but the due date stays on the right", () => {
    const [first, second] = lines(<IssueRow issue={tall} selected={false} width={100} showLabels={false} />, 100);
    expect(first).toContain("PD-3066");
    expect(second).not.toContain("●");
    expect(second).not.toContain("Feature");
    expect(second).not.toMatch(/\+\d/); // and no "+N" count either
    expect(second?.trimEnd().endsWith("due Jan 2")).toBe(true);
  });

  test("an issue with labels but no due date becomes a single line", () => {
    const labelsOnly = makeIssue({ labels: labels("CPQ"), dueDate: null });
    const out = lines(<IssueRow issue={labelsOnly} selected={false} width={60} showLabels={false} />, 60);
    expect(out.filter((l) => l.trim() !== "")).toHaveLength(1);
    expect(out.join("\n")).not.toContain("CPQ");
  });

  test("labels are shown by default (existing behaviour)", () => {
    expect(lines(<IssueRow issue={tall} selected={false} width={100} />, 100)[1]).toContain("● Feature");
  });
});

// ---------------------------------------------------------------------------
describe("fitLabels", () => {
  const three = labels("Managed Hosting portal", "Feature", "CPQ").nodes;

  test("shows them all when there is room", () => {
    expect(fitLabels(three, 100)).toEqual({ shown: three, hidden: 0 });
  });

  test("shows what fits and counts the rest", () => {
    const { shown, hidden } = fitLabels(three, 40);
    expect(shown.length + hidden).toBe(3);
    expect(hidden).toBeGreaterThan(0);
  });

  test("a single label that is too long is shortened with an ellipsis, not dropped", () => {
    const { shown, hidden } = fitLabels([{ name: "abcdefghij", color: "#fff" }], 6);
    expect(shown.map((l) => l.name)).toEqual(["ab…"]);
    expect(hidden).toBe(0);
  });

  test("with almost no room, nothing is shown and everything is counted", () => {
    expect(fitLabels(three, 3)).toEqual({ shown: [], hidden: 3 });
  });

  test("no labels, nothing to show", () => {
    expect(fitLabels([], 50)).toEqual({ shown: [], hidden: 0 });
  });
});

// ---------------------------------------------------------------------------
describe("PriorityGlyph", () => {
  test("is exactly 3 columns wide for every priority, so titles line up", () => {
    for (const priority of [0, 1, 2, 3, 4]) {
      for (const muted of [false, true]) {
        const [line] = lines(
          <Box>
            <PriorityGlyph priority={priority} muted={muted} />
            <Text>|</Text>
          </Box>,
          20,
        );
        expect(width((line ?? "").split("|")[0] ?? "")).toBe(3);
      }
    }
  });
});

// ---------------------------------------------------------------------------
describe("GroupHeader", () => {
  const group = { name: "Todo", type: "unstarted", color: "#e2e2e2", issues: [makeIssue(), makeIssue({ identifier: "PD-2" })] };

  test("shows the status in capitals with its count", () => {
    expect(lines(<GroupHeader group={group} collapsed={false} selected={false} />, 40)[0]?.trim()).toBe("▾ ● TODO 2");
  });

  test("a folded group shows ▸ instead of ▾", () => {
    expect(lines(<GroupHeader group={group} collapsed selected={false} />, 40)[0]?.trim()).toBe("▸ ● TODO 2");
  });

  test("the selected header gets the marker bar", () => {
    expect(lines(<GroupHeader group={group} collapsed={false} selected />, 40)[0]?.startsWith("▌")).toBe(true);
  });

  test("is exactly one line tall", () => {
    expect(heightOf(<GroupHeader group={group} collapsed={false} selected={false} />)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe("CycleHeader", () => {
  const NOW = new Date(2026, 10, 9, 12, 0, 0);
  const tomorrow = new Date(2026, 10, 10, 5, 0, 0).toISOString();
  const cycle = (label: string, percent: number) => ({ label, done: 0, total: 0, percent, endsAt: tomorrow });

  test("shows the title, each cycle's progress bar, percentage and days left", () => {
    setSystemTime(NOW);
    const out = lines(<CycleHeader cycles={[cycle("PD #112", 70), cycle("UC #39", 0)]} doneColor="#4cb782" />, 47);
    expect(out[0]).toContain("TANGENT");
    const pd = out.find((l) => l.includes("PD #112")) ?? "";
    expect(pd).toContain("70%");
    expect(pd).toContain("ends tomorrow");
    expect(pd.split("█").length - 1).toBe(7); // 70% = 7 of 10 blocks
    expect(pd.split("░").length - 1).toBe(3);
    const uc = out.find((l) => l.includes("UC #39")) ?? "";
    expect(uc.split("░").length - 1).toBe(10);
  });

  test("takes 3 lines plus one per cycle (the app's scroll math depends on it)", () => {
    setSystemTime(NOW);
    for (const count of [1, 2, 3]) {
      const cycles = Array.from({ length: count }, (_, i) => cycle(`PD #${i}`, 50));
      expect(heightOf(<CycleHeader cycles={cycles} doneColor="#4cb782" />)).toBe(3 + count);
    }
  });

  // The app's scroll math assumes this header is exactly 3 + one line per cycle. At a
  // narrow width "14 days left" used to wrap onto three lines (9 lines for 2 cycles),
  // so the list thought it had more room than it did and clipped its bottom rows.
  test("never wraps: it stays 3 + one line per cycle at any width of 24 columns or more", () => {
    setSystemTime(NOW);
    const cycles = [cycle("PD #112", 70), cycle("UC #39", 0)];
    for (const columns of [24, 26, 28, 30, 32, 36, 40, 47, 60, 80]) {
      const output = lines(
        <>
          <CycleHeader cycles={cycles} doneColor="#4cb782" />
          <Text>END_MARKER</Text>
        </>,
        columns,
      );
      expect(output.findIndex((l) => l.includes("END_MARKER"))).toBe(3 + cycles.length);
    }
  });

  test("100% fills the whole bar", () => {
    setSystemTime(NOW);
    const [, , line] = lines(<CycleHeader cycles={[cycle("PD #1", 100)]} doneColor="#4cb782" />, 47);
    expect((line ?? "").split("█").length - 1).toBe(10);
    expect(line).toContain("100%");
  });
});
