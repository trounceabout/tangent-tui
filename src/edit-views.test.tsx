// Tests for src/edit-views.tsx: what the edit screens show.

import { describe, expect, test } from "bun:test";
import type { ReactElement } from "react";
import { Box, renderToString } from "ink";
import { ConfirmView, MessageView, PickerView } from "./edit-views.tsx";
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
