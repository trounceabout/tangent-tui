// Tests for src/filter.ts: searching and filtering the issue list.

import { describe, expect, test } from "bun:test";
import {
  NO_FILTERS,
  describeFilters,
  filterIssues,
  isFiltering,
  nextLabel,
  nextPriority,
  nextTeam,
  parseQuery,
} from "./filter.ts";
import { labels, makeIssue } from "./testing.ts";

// A small, varied set with known answers.
const A = makeIssue({ identifier: "PD-1", title: "Add staging environment", priority: 1, labels: labels("CPQ", "Bug") });
const B = makeIssue({ identifier: "PD-2", title: "Deploy to Staging Worker", priority: 2, labels: labels("CPQ") });
const C = makeIssue({
  identifier: "UC-3",
  title: "Add MCP server to wallaby",
  priority: 4,
  team: { key: "UC", issueEstimationType: "tShirt" },
  labels: labels("Ops", "Feature"),
});
const D = makeIssue({ identifier: "UC-4", title: "Fix the Button", priority: 0, team: { key: "UC", issueEstimationType: "tShirt" } });
const E = makeIssue({ identifier: "PD-5", title: "Design VM flow", priority: 3, labels: labels("Feature") });
const ALL = [A, B, C, D, E];

const ids = (issues: typeof ALL) => issues.map((i) => i.identifier);
const filter = (patch: Partial<typeof NO_FILTERS>) => ids(filterIssues(ALL, { ...NO_FILTERS, ...patch }));

describe("filterIssues: text", () => {
  test("no filters returns everything, in order", () => {
    expect(filter({})).toEqual(["PD-1", "PD-2", "UC-3", "UC-4", "PD-5"]);
  });

  test("a whitespace-only query filters nothing", () => {
    expect(filter({ query: "   " })).toEqual(ids(ALL));
  });

  test("matches the title, ignoring case", () => {
    expect(filter({ query: "staging" })).toEqual(["PD-1", "PD-2"]);
    expect(filter({ query: "STAGING" })).toEqual(["PD-1", "PD-2"]);
  });

  test("every word must match (AND), in any order", () => {
    expect(filter({ query: "staging deploy" })).toEqual(["PD-2"]);
    expect(filter({ query: "deploy staging" })).toEqual(["PD-2"]);
  });

  test("matches the issue ID", () => {
    expect(filter({ query: "uc-3" })).toEqual(["UC-3"]);
    expect(filter({ query: "uc-" })).toEqual(["UC-3", "UC-4"]);
  });

  test("no match gives an empty list", () => {
    expect(filter({ query: "zzzz" })).toEqual([]);
  });
});

describe("filterIssues: operators in the search bar", () => {
  test("label:x matches a label name containing x", () => {
    expect(filter({ query: "label:cpq" })).toEqual(["PD-1", "PD-2"]);
    expect(filter({ query: "label:feat" })).toEqual(["UC-3", "PD-5"]); // partial match
  });

  test("l: is a shorthand for label:", () => {
    expect(filter({ query: "l:ops" })).toEqual(["UC-3"]);
  });

  test("team:x matches the team key exactly", () => {
    expect(filter({ query: "team:uc" })).toEqual(["UC-3", "UC-4"]);
    expect(filter({ query: "t:pd" })).toEqual(["PD-1", "PD-2", "PD-5"]);
    expect(filter({ query: "team:u" })).toEqual([]); // not a prefix match
  });

  test("operators and plain words combine", () => {
    expect(filter({ query: "label:cpq staging bug" })).toEqual([]); // "bug" is a label, not in id/title
    expect(filter({ query: "label:cpq deploy" })).toEqual(["PD-2"]);
  });

  test("an unknown operator is treated as plain text", () => {
    expect(filter({ query: "foo:bar" })).toEqual([]);
  });
});

describe("filterIssues: team, label and priority filters", () => {
  test("team filter", () => {
    expect(filter({ team: "UC" })).toEqual(["UC-3", "UC-4"]);
  });

  test("label filter is an exact name", () => {
    expect(filter({ label: "CPQ" })).toEqual(["PD-1", "PD-2"]);
    expect(filter({ label: "cpq" })).toEqual([]); // exact, so case matters here
  });

  test("minPriority means 'at least this urgent'", () => {
    expect(filter({ minPriority: 1 })).toEqual(["PD-1"]);
    expect(filter({ minPriority: 2 })).toEqual(["PD-1", "PD-2"]);
    expect(filter({ minPriority: 3 })).toEqual(["PD-1", "PD-2", "PD-5"]);
  });

  test("issues with no priority never match a priority filter", () => {
    expect(filter({ minPriority: 3 })).not.toContain("UC-4"); // priority 0
    expect(filter({ minPriority: 3 })).not.toContain("UC-3"); // low (4) is below Medium
  });

  test("all filters combine (AND)", () => {
    expect(filter({ team: "PD", label: "CPQ", minPriority: 2, query: "deploy" })).toEqual(["PD-2"]);
    expect(filter({ team: "UC", label: "CPQ" })).toEqual([]);
  });

  test("does not modify the list it was given", () => {
    const copy = [...ALL];
    filterIssues(ALL, { ...NO_FILTERS, query: "staging" });
    expect(ALL).toEqual(copy);
  });
});

describe("parseQuery", () => {
  test("splits words from operators and lower-cases everything", () => {
    expect(parseQuery("Staging label:CPQ t:pd x:y")).toEqual({
      words: ["staging", "x:y"],
      labels: ["cpq"],
      teams: ["pd"],
    });
  });

  test("ignores extra whitespace and an empty operator value", () => {
    expect(parseQuery("  a   b  ")).toEqual({ words: ["a", "b"], labels: [], teams: [] });
    expect(parseQuery("label:")).toEqual({ words: ["label:"], labels: [], teams: [] });
  });

  test("stays fast on a huge query (no runaway regex)", () => {
    const start = performance.now();
    parseQuery("a ".repeat(50_000));
    parseQuery(`label:${"x".repeat(100_000)}`);
    expect(performance.now() - start).toBeLessThan(1000);
  });
});

describe("cycling filters with a key", () => {
  test("nextTeam goes through every team, then back to all", () => {
    expect(nextTeam(ALL, null)).toBe("PD");
    expect(nextTeam(ALL, "PD")).toBe("UC");
    expect(nextTeam(ALL, "UC")).toBeNull();
  });

  test("nextTeam starts again if the current team has disappeared", () => {
    expect(nextTeam(ALL, "GONE")).toBe("PD");
  });

  test("nextTeam with no issues stays on 'all'", () => {
    expect(nextTeam([], null)).toBeNull();
  });

  test("nextLabel visits each distinct label once, in order, then back to all", () => {
    const seen: string[] = [];
    let current: string | null = null;
    for (let step = 0; step < 20; step++) {
      current = nextLabel(ALL, current);
      if (current === null) break;
      seen.push(current);
    }
    expect(seen).toEqual(["Bug", "CPQ", "Feature", "Ops"]);
  });

  test("nextPriority steps Urgent, High, Medium, then off", () => {
    expect([nextPriority(null), nextPriority(1), nextPriority(2), nextPriority(3)]).toEqual([1, 2, 3, null]);
  });
});

describe("describing filters", () => {
  test("isFiltering is false for empty or whitespace-only filters", () => {
    expect(isFiltering(NO_FILTERS)).toBe(false);
    expect(isFiltering({ ...NO_FILTERS, query: "  " })).toBe(false);
  });

  test("isFiltering is true when anything is set", () => {
    expect(isFiltering({ ...NO_FILTERS, query: "a" })).toBe(true);
    expect(isFiltering({ ...NO_FILTERS, team: "PD" })).toBe(true);
    expect(isFiltering({ ...NO_FILTERS, minPriority: 1 })).toBe(true);
    expect(isFiltering({ ...NO_FILTERS, label: "CPQ" })).toBe(true);
  });

  test("describeFilters summarises them in order", () => {
    expect(describeFilters({ query: " stag ", team: "PD", minPriority: 2, label: "CPQ" })).toBe(
      '"stag" · team PD · ≥ High · label CPQ',
    );
    expect(describeFilters({ ...NO_FILTERS, minPriority: 1 })).toBe("Urgent");
    expect(describeFilters(NO_FILTERS)).toBe("");
  });
});
