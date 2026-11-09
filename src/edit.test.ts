// Tests for src/edit.ts: what the edit pickers offer and what change they send.

import { describe, expect, test } from "bun:test";
import { buildOptions, changeFor, currentLabel, describeChange, isCurrent, needsTeamSettings, startIndex, warningFor } from "./edit.ts";
import type { EditOption } from "./edit.ts";
import type { TeamSettings, TeamState } from "./mutations.ts";
import { makeIssue } from "./testing.ts";

const ID = (n: number) => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const state = (name: string, type: string, n: number): TeamState => ({ id: ID(n), name, type, position: n, color: "#e2e2e2" });

const pd: TeamSettings = {
  key: "PD",
  states: [state("Todo", "unstarted", 1), state("In Progress", "started", 2), state("Done", "completed", 3)],
  estimationType: "tShirt",
  estimationExtended: false,
  estimationAllowZero: true,
};
const issue = makeIssue({ identifier: "PD-7", state: { name: "Todo", type: "unstarted", position: 1, color: "#fff" }, priority: 2, estimate: 3 });

const offered = (kind: Parameters<typeof buildOptions>[0], i = issue, s: TeamSettings | null = pd) => {
  const offer = buildOptions(kind, i, s);
  if (!("options" in offer)) throw new Error(`expected options, got: ${offer.unsupported}`);
  return offer.options;
};
const reason = (kind: Parameters<typeof buildOptions>[0], i = issue, s: TeamSettings | null = pd) => {
  const offer = buildOptions(kind, i, s);
  return "unsupported" in offer ? offer.unsupported : null;
};

// ---------------------------------------------------------------------------
describe("buildOptions", () => {
  test("priority needs no team settings", () => {
    expect(needsTeamSettings("priority")).toBe(false);
    expect(offered("priority", issue, null).map((o) => o.label)).toEqual(["Urgent", "High", "Medium", "Low", "No priority"]);
  });

  test("status and estimate do need them", () => {
    expect(needsTeamSettings("status")).toBe(true);
    expect(needsTeamSettings("estimate")).toBe(true);
    expect(reason("status", issue, null)).toContain("couldn't be loaded");
    expect(reason("estimate", issue, null)).toContain("couldn't be loaded");
  });

  test("status offers the issue's own team's statuses, in display order", () => {
    expect(offered("status").map((o) => o.label)).toEqual(["Todo", "In Progress", "Done"]);
  });

  // SAFETY: a status id from the wrong team's workflow must never be offered.
  test("refuses settings that belong to a different team", () => {
    const ucIssue = makeIssue({ team: { key: "UC", issueEstimationType: "tShirt" } });
    expect(reason("status", ucIssue, pd)).toContain("PD");
    expect(reason("estimate", ucIssue, pd)).toContain("UC");
  });

  test("a team with no statuses is reported, not offered as an empty picker", () => {
    expect(reason("status", issue, { ...pd, states: [] })).toContain("no statuses");
  });

  test("estimate offers T-shirt sizes", () => {
    expect(offered("estimate").map((o) => o.label)).toEqual(["No estimate", "XS", "S", "M", "L", "XL"]);
  });

  test("an unsupported estimate scale says why instead of guessing", () => {
    expect(reason("estimate", issue, { ...pd, estimationType: "fibonacci" })).toContain("fibonacci");
  });
});

// ---------------------------------------------------------------------------
describe("the current value", () => {
  test("currentLabel for each field", () => {
    expect(currentLabel("status", issue)).toBe("Todo");
    expect(currentLabel("priority", issue)).toBe("High");
    expect(currentLabel("estimate", issue)).toBe("M");
  });

  test("priority 0 and a missing estimate read as 'No priority' / 'No estimate'", () => {
    const bare = makeIssue({ priority: 0, estimate: null });
    expect(currentLabel("priority", bare)).toBe("No priority");
    expect(currentLabel("estimate", bare)).toBe("No estimate");
    expect(currentLabel("estimate", makeIssue({ estimate: 0 }))).toBe("No estimate");
  });

  test("isCurrent matches status by name, priority and estimate by value", () => {
    expect(isCurrent("status", issue, { value: ID(1), label: "Todo" })).toBe(true);
    expect(isCurrent("status", issue, { value: ID(2), label: "In Progress" })).toBe(false);
    expect(isCurrent("priority", issue, { value: 2, label: "High" })).toBe(true);
    expect(isCurrent("priority", issue, { value: 3, label: "Medium" })).toBe(false);
    expect(isCurrent("estimate", issue, { value: 3, label: "M" })).toBe(true);
  });

  test("an issue with no estimate counts as already 'No estimate' (0)", () => {
    const none = makeIssue({ estimate: null });
    expect(isCurrent("estimate", none, { value: 0, label: "No estimate" })).toBe(true);
    expect(isCurrent("estimate", none, { value: 1, label: "XS" })).toBe(false);
  });

  test("the cursor starts on the current value", () => {
    expect(startIndex("status", issue, offered("status"))).toBe(0); // Todo
    expect(startIndex("priority", issue, offered("priority"))).toBe(1); // High
    expect(startIndex("estimate", issue, offered("estimate"))).toBe(3); // M
  });

  test("the cursor starts at the top when the current value isn't in the list", () => {
    const odd = makeIssue({ state: { name: "Mystery", type: "started", position: 1, color: "#fff" } });
    expect(startIndex("status", odd, offered("status", odd))).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe("changeFor: exactly what is sent", () => {
  test("each field becomes only its own key", () => {
    expect(changeFor("status", { value: ID(2), label: "In Progress" })).toEqual({ stateId: ID(2) });
    expect(changeFor("priority", { value: 1, label: "Urgent" })).toEqual({ priority: 1 });
    expect(changeFor("estimate", { value: 5, label: "L" })).toEqual({ estimate: 5 });
    expect(changeFor("estimate", { value: 0, label: "No estimate" })).toEqual({ estimate: 0 });
  });

  test("a value of the wrong type is an error, never sent", () => {
    expect(() => changeFor("status", { value: 3, label: "x" })).toThrow("by its id");
    expect(() => changeFor("priority", { value: "high", label: "x" })).toThrow("number");
    expect(() => changeFor("estimate", { value: "3", label: "x" })).toThrow("number");
  });
});

describe("warnings and messages", () => {
  const finishing: EditOption = { value: ID(3), label: "Done", finished: true };
  const active: EditOption = { value: ID(2), label: "In Progress", finished: false };

  test("a finishing status warns about the validation comment", () => {
    expect(warningFor("status", finishing)).toContain("validation comment");
  });

  test("an active status, a priority and an estimate don't warn", () => {
    expect(warningFor("status", active)).toBeNull();
    expect(warningFor("priority", { value: 1, label: "Urgent" })).toBeNull();
    expect(warningFor("estimate", { value: 3, label: "M", finished: true })).toBeNull(); // 'finished' only matters for status
  });

  test("describeChange reads 'PD-7: Todo → In Progress'", () => {
    expect(describeChange("status", issue, active)).toBe("PD-7: Todo → In Progress");
    expect(describeChange("priority", issue, { value: 1, label: "Urgent" })).toBe("PD-7: High → Urgent");
    expect(describeChange("estimate", issue, { value: 0, label: "No estimate" })).toBe("PD-7: M → No estimate");
  });
});
