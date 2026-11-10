// Tests for src/mutations.ts: the ONLY code that can change data in Linear.
//
// Nothing here touches the real Linear: every test uses the fake network. The
// important guarantees are the negative ones: invalid input, unknown fields and
// dry-run mode must NEVER produce a network request.

import { afterEach, describe, expect, test } from "bun:test";
import {
  PRIORITY_OPTIONS,
  estimateOptions,
  fetchTeamSettings,
  isDryRun,
  sortStates,
  statusOptions,
  updateIssue,
  validateChange,
} from "./mutations.ts";
import type { TeamSettings, TeamState } from "./mutations.ts";
import { BEL, ESC, hasControlChars, mockFetch } from "./testing.ts";
import type { SeenRequest } from "./testing.ts";

const ID_A = "11111111-1111-4111-8111-111111111111";
const ID_B = "22222222-2222-4222-8222-222222222222";

let restoreFetch: (() => void) | undefined;
afterEach(() => {
  restoreFetch?.();
  restoreFetch = undefined;
  delete process.env.TANGENT_DRY_RUN;
});

// A fake network that records every request, and fails the test if one is made
// when it shouldn't be.
function recordRequests(respond: (request: SeenRequest) => unknown = () => ({ data: {} })) {
  const seen: SeenRequest[] = [];
  restoreFetch = mockFetch((request) => {
    seen.push(request);
    return respond(request);
  });
  return seen;
}

const state = (overrides: Partial<TeamState> = {}): TeamState => ({
  id: ID_A,
  name: "Todo",
  type: "unstarted",
  position: 1,
  color: "#e2e2e2",
  ...overrides,
});
const settings = (overrides: Partial<TeamSettings> = {}): TeamSettings => ({
  key: "PD",
  states: [state()],
  estimationType: "tShirt",
  estimationExtended: false,
  estimationAllowZero: true,
  ...overrides,
});

// ---------------------------------------------------------------------------
describe("validateChange", () => {
  test("accepts each of the three fields, alone or together", () => {
    expect(validateChange("PD-1", { priority: 2 })).toEqual({ priority: 2 });
    expect(validateChange("PD-1", { stateId: ID_A })).toEqual({ stateId: ID_A });
    expect(validateChange("PD-1", { estimate: 0 })).toEqual({ estimate: 0 }); // 0 is allowed
    expect(validateChange("UC-12", { stateId: ID_A, priority: 1, estimate: 5 })).toEqual({
      stateId: ID_A,
      priority: 1,
      estimate: 5,
    });
  });

  test("drops fields that are undefined", () => {
    expect(validateChange("PD-1", { priority: 2, estimate: undefined })).toEqual({ priority: 2 });
  });

  test.each(["", "pd-1", "PD1", "PD-", "PD-1 ", "PD-1; drop", "../x", "PD-1\n", "-1"])("rejects the issue ID %p", (id) => {
    expect(() => validateChange(id, { priority: 1 })).toThrow();
  });

  test("rejects an empty change", () => {
    expect(() => validateChange("PD-1", {})).toThrow("nothing to change");
    expect(() => validateChange("PD-1", { priority: undefined })).toThrow("nothing to change");
  });

  test("rejects any field other than the three allowed ones", () => {
    for (const field of ["assigneeId", "title", "description", "cycleId", "labelIds", "dueDate", "projectId"]) {
      expect(() => validateChange("PD-1", { priority: 1, [field]: "x" } as never)).toThrow("can't be changed");
    }
  });

  test.each([-1, 5, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "2" as never])("rejects priority %p", (priority) => {
    expect(() => validateChange("PD-1", { priority })).toThrow("Priority");
  });

  test.each([0, 1, 2, 3, 4])("accepts priority %d", (priority) => {
    expect(validateChange("PD-1", { priority })).toEqual({ priority });
  });

  test.each([-1, 22, 2.5, Number.NaN, "3" as never])("rejects estimate %p", (estimate) => {
    expect(() => validateChange("PD-1", { estimate })).toThrow("Estimate");
  });

  test.each(["", "todo", "not-a-uuid", `${ID_A}x`, ID_A.slice(1), "1111111111114111811111111111111"])(
    "rejects the status id %p",
    (stateId) => {
      expect(() => validateChange("PD-1", { stateId })).toThrow("not a valid status");
    },
  );
});

// ---------------------------------------------------------------------------
describe("updateIssue: the request it sends", () => {
  const ok = (stateId = ID_A, priority = 2, estimate: number | null = 3) => ({
    data: {
      issueUpdate: {
        success: true,
        issue: { identifier: "PD-1", priority, estimate, state: { id: stateId, name: "In Progress", type: "started", color: "#f2c94c" } },
      },
    },
  });

  test("sends a single issueUpdate with the issue id and ONLY the validated input", async () => {
    const seen = recordRequests(() => ok(ID_B, 2, 3));
    await updateIssue("key", "PD-1", { stateId: ID_B, priority: 2, estimate: 3 });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.query).toContain("issueUpdate(id: $id, input: $input)");
    expect(seen[0]?.variables).toEqual({ id: "PD-1", input: { stateId: ID_B, priority: 2, estimate: 3 } });
  });

  test("uses the API key as given (no Bearer)", async () => {
    const seen = recordRequests(() => ok(ID_B, 2, 3));
    await updateIssue("lin_api_secret", "PD-1", { priority: 2 });
    expect(seen[0]?.headers.Authorization).toBe("lin_api_secret");
  });

  test("returns the issue as Linear reports it, cleaned", async () => {
    recordRequests(() => ({
      data: {
        issueUpdate: {
          success: true,
          issue: { identifier: "PD-1", priority: 2, estimate: 3, state: { id: ID_B, name: `Done${ESC}[31m`, type: "completed", color: "red" } },
        },
      },
    }));
    const result = await updateIssue("k", "PD-1", { stateId: ID_B });
    expect(result.dryRun).toBe(false);
    if (result.dryRun) return;
    expect(hasControlChars(result.issue.state.name)).toBe(false);
    expect(result.issue.state.color).toBe("#8a8f98"); // an invalid color falls back to gray
  });
});

describe("updateIssue: nothing is sent when it shouldn't be", () => {
  test("an invalid issue id", async () => {
    const seen = recordRequests();
    await expect(updateIssue("k", "not an id", { priority: 1 })).rejects.toThrow("valid issue ID");
    expect(seen).toHaveLength(0);
  });

  test("an empty change", async () => {
    const seen = recordRequests();
    await expect(updateIssue("k", "PD-1", {})).rejects.toThrow("nothing to change");
    expect(seen).toHaveLength(0);
  });

  test("an unknown field (e.g. reassigning the issue)", async () => {
    const seen = recordRequests();
    await expect(updateIssue("k", "PD-1", { priority: 1, assigneeId: ID_A } as never)).rejects.toThrow("can't be changed");
    expect(seen).toHaveLength(0);
  });

  test("an out-of-range priority, estimate or status", async () => {
    const seen = recordRequests();
    await expect(updateIssue("k", "PD-1", { priority: 9 })).rejects.toThrow();
    await expect(updateIssue("k", "PD-1", { estimate: -1 })).rejects.toThrow();
    await expect(updateIssue("k", "PD-1", { stateId: "nope" })).rejects.toThrow();
    expect(seen).toHaveLength(0);
  });

  test("dry-run mode sends nothing, even for a valid change", async () => {
    process.env.TANGENT_DRY_RUN = "1";
    const seen = recordRequests();
    expect(isDryRun()).toBe(true);
    expect(await updateIssue("k", "PD-1", { stateId: ID_A, priority: 2 })).toEqual({ dryRun: true });
    expect(seen).toHaveLength(0);
  });

  test("dry-run mode still validates, so a bad change is caught in testing too", async () => {
    process.env.TANGENT_DRY_RUN = "1";
    await expect(updateIssue("k", "PD-1", { priority: 9 })).rejects.toThrow("Priority");
  });

  test("dry-run is off by default and for any value other than exactly 1", () => {
    expect(isDryRun()).toBe(false);
    for (const value of ["0", "true", "yes", ""]) {
      process.env.TANGENT_DRY_RUN = value;
      expect(isDryRun()).toBe(false);
    }
  });
});

describe("updateIssue: when Linear says no", () => {
  test("an HTTP error is passed on", async () => {
    restoreFetch = mockFetch(() => new Response("forbidden", { status: 403 }));
    await expect(updateIssue("k", "PD-1", { priority: 1 })).rejects.toThrow("HTTP 403");
  });

  test("a GraphQL error (e.g. no write permission) is passed on", async () => {
    restoreFetch = mockFetch(() => ({ errors: [{ message: "You do not have permission" }] }));
    await expect(updateIssue("k", "PD-1", { priority: 1 })).rejects.toThrow("permission");
  });

  test("success: false is an error", async () => {
    restoreFetch = mockFetch(() => ({ data: { issueUpdate: { success: false, issue: null } } }));
    await expect(updateIssue("k", "PD-1", { priority: 1 })).rejects.toThrow("did not apply");
  });

  // The issue is present here, so only the success flag itself can reject this.
  // (With issue: null the "no issue" check would throw first and hide a bug.)
  test("success: false is an error even when an issue comes back", async () => {
    restoreFetch = mockFetch(() => ({
      data: { issueUpdate: { success: false, issue: { identifier: "PD-1", priority: 1, estimate: null, state: { id: ID_A, name: "x", type: "started", color: "#fff" } } } },
    }));
    await expect(updateIssue("k", "PD-1", { priority: 1 })).rejects.toThrow("did not apply");
  });

  test("success with no issue is an error", async () => {
    restoreFetch = mockFetch(() => ({ data: { issueUpdate: { success: true, issue: null } } }));
    await expect(updateIssue("k", "PD-1", { priority: 1 })).rejects.toThrow("did not apply");
  });

  test("a reply that doesn't match what we asked for is an error, not a silent success", async () => {
    const reply = (stateId: string, priority: number, estimate: number | null) => ({
      data: { issueUpdate: { success: true, issue: { identifier: "PD-1", priority, estimate, state: { id: stateId, name: "x", type: "started", color: "#fff" } } } },
    });
    restoreFetch = mockFetch(() => reply(ID_B, 4, 8));
    await expect(updateIssue("k", "PD-1", { stateId: ID_A })).rejects.toThrow("different status");
    await expect(updateIssue("k", "PD-1", { priority: 1 })).rejects.toThrow("different priority");
    await expect(updateIssue("k", "PD-1", { estimate: 1 })).rejects.toThrow("different estimate");
    await expect(updateIssue("k", "PD-1", { priority: 1, estimate: 1 })).rejects.toThrow("priority and estimate");
  });

  test("clearing an estimate (0) accepts Linear reporting null", async () => {
    restoreFetch = mockFetch(() => ({
      data: { issueUpdate: { success: true, issue: { identifier: "PD-1", priority: 2, estimate: null, state: { id: ID_A, name: "x", type: "started", color: "#fff" } } } },
    }));
    expect((await updateIssue("k", "PD-1", { estimate: 0 })).dryRun).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("fetchTeamSettings", () => {
  const reply = (nodes: unknown[]) => ({ data: { teams: { nodes } } });
  const team = (states: unknown[]) => ({
    key: "PD",
    issueEstimationType: "tShirt",
    issueEstimationExtended: false,
    issueEstimationAllowZero: true,
    states: { nodes: states },
  });

  test("asks for the team by key and returns its statuses sorted for display", async () => {
    const seen = recordRequests(() =>
      reply([
        team([
          { id: ID_A, name: "Done", type: "completed", position: 1, color: "#4cb782" },
          { id: ID_B, name: "Todo", type: "unstarted", position: 2, color: "#e2e2e2" },
          { id: "33333333-3333-4333-8333-333333333333", name: "In Progress", type: "started", position: 3, color: "#f2c94c" },
          { id: "44444444-4444-4444-8444-444444444444", name: "Backlog", type: "backlog", position: 1, color: "#bec2c8" },
        ]),
      ]),
    );
    const result = await fetchTeamSettings("k", "PD");
    expect(seen[0]?.variables).toEqual({ key: "PD" });
    expect(result.states.map((s) => s.name)).toEqual(["Backlog", "Todo", "In Progress", "Done"]);
    expect(result).toMatchObject({ key: "PD", estimationType: "tShirt", estimationExtended: false, estimationAllowZero: true });
  });

  test("rejects a malformed team key without any network request", async () => {
    const seen = recordRequests();
    for (const key of ["", "pd", "P D", 'PD"}', "PD-1"]) await expect(fetchTeamSettings("k", key)).rejects.toThrow("valid team key");
    expect(seen).toHaveLength(0);
  });

  test("throws when the team doesn't exist", async () => {
    recordRequests(() => reply([]));
    await expect(fetchTeamSettings("k", "ZZ")).rejects.toThrow("ZZ was not found");
  });

  test("cleans names and colors from the network", async () => {
    recordRequests(() => reply([team([{ id: ID_A, name: `Todo${ESC}]0;x${BEL}`, type: "unstarted", position: 1, color: "javascript:1" }])]));
    const [only] = (await fetchTeamSettings("k", "PD")).states;
    expect(hasControlChars(only?.name ?? "")).toBe(false);
    expect(only?.color).toBe("#8a8f98");
  });
});

// ---------------------------------------------------------------------------
describe("sortStates and statusOptions", () => {
  test("orders by type (triage, backlog, todo, in progress, finished), then position", () => {
    const sorted = sortStates([
      state({ name: "Canceled", type: "canceled", position: 1 }),
      state({ name: "Done", type: "completed", position: 5 }),
      state({ name: "In Review", type: "started", position: 9 }),
      state({ name: "In Progress", type: "started", position: 2 }),
      state({ name: "Todo", type: "unstarted", position: 1 }),
      state({ name: "Triage", type: "triage", position: 1 }),
      state({ name: "Backlog", type: "backlog", position: 1 }),
      state({ name: "Duplicate", type: "duplicate", position: 1 }),
    ]);
    expect(sorted.map((s) => s.name)).toEqual(["Triage", "Backlog", "Todo", "In Progress", "In Review", "Done", "Canceled", "Duplicate"]);
  });

  test("an unknown type sorts last instead of breaking", () => {
    expect(sortStates([state({ name: "Odd", type: "mystery" }), state({ name: "Done", type: "completed" })]).map((s) => s.name)).toEqual([
      "Done",
      "Odd",
    ]);
  });

  test("flags every finishing status, including Duplicate, and keeps Linear's colors", () => {
    const options = statusOptions(
      settings({
        states: [
          state({ name: "Todo", type: "unstarted", color: "#e2e2e2" }),
          state({ name: "Done", type: "completed" }),
          state({ name: "Canceled", type: "canceled" }),
          state({ name: "Duplicate", type: "duplicate" }),
          state({ name: "In Review", type: "started" }),
        ],
      }),
    );
    expect(options.map((o) => [o.label, o.finished])).toEqual([
      ["Todo", false],
      ["Done", true],
      ["Canceled", true],
      ["Duplicate", true],
      ["In Review", false],
    ]);
    expect(options[0]?.color).toBe("#e2e2e2");
  });
});

describe("priority and estimate options", () => {
  test("priority offers Urgent to Low, then No priority, using Linear's numbering", () => {
    expect(PRIORITY_OPTIONS.map((o) => [o.label, o.value])).toEqual([
      ["Urgent", 1],
      ["High", 2],
      ["Medium", 3],
      ["Low", 4],
      ["No priority", 0],
    ]);
  });

  test("T-shirt teams get No estimate (when 0 is allowed) then XS to XL", () => {
    expect(estimateOptions(settings())?.map((o) => [o.label, o.value])).toEqual([
      ["No estimate", 0],
      ["XS", 1],
      ["S", 2],
      ["M", 3],
      ["L", 5],
      ["XL", 8],
    ]);
  });

  test("an extended scale adds XXL and XXXL", () => {
    const labels = estimateOptions(settings({ estimationExtended: true }))?.map((o) => o.label);
    expect(labels?.slice(-2)).toEqual(["XXL", "XXXL"]);
  });

  test("when zero isn't allowed there is no 'No estimate' option", () => {
    expect(estimateOptions(settings({ estimationAllowZero: false }))?.map((o) => o.label)).toEqual(["XS", "S", "M", "L", "XL"]);
  });

  test("other scales are not supported yet (null), so the app can say so", () => {
    for (const estimationType of ["fibonacci", "exponential", "linear", "notUsed"]) {
      expect(estimateOptions(settings({ estimationType }))).toBeNull();
    }
  });
});
