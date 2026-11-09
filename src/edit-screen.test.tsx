// Tests for src/edit-screen.tsx: the edit flow, driven with fake keystrokes and a fake
// network. The point is to count how many write requests are REALLY sent in each
// scenario: browsing must send none, a confirmed change exactly one, and a second
// Enter (or a double-submit) must never send a second.

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Mock } from "bun:test";
import { Box } from "ink";
import { EditScreen } from "./edit-screen.tsx";
import type { EditKind } from "./edit.ts";
import type { Issue } from "./linear.ts";
import { ESC, makeIssue, mockFetch } from "./testing.ts";
import type { SeenRequest } from "./testing.ts";
import { KEY, mountTerminal } from "./testing-terminal.ts";

const ID = (n: number) => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const issue: Issue = makeIssue({
  identifier: "PD-7",
  title: "Fix the thing",
  priority: 2,
  estimate: 3,
  state: { name: "Todo", type: "unstarted", position: 1, color: "#fff" },
});

// The Keychain read (`security find-generic-password`) is replaced by a fake key.
let spawn: Mock<typeof Bun.spawn>;
let restoreFetch: (() => void) | undefined;
beforeEach(() => {
  spawn = spyOn(Bun, "spawn").mockImplementation((() => ({
    stdout: new Response("fake-key\n").body,
    stderr: new Response("").body,
    exited: Promise.resolve(0),
  })) as never);
});
afterEach(() => {
  spawn.mockRestore();
  restoreFetch?.();
  restoreFetch = undefined;
  delete process.env.LINEAR_TUI_DRY_RUN;
});

const teamSettings = {
  data: {
    teams: {
      nodes: [
        {
          key: "PD",
          issueEstimationType: "tShirt",
          issueEstimationExtended: false,
          issueEstimationAllowZero: true,
          states: {
            nodes: [
              { id: ID(1), name: "Todo", type: "unstarted", position: 1, color: "#e2e2e2" },
              { id: ID(2), name: "In Progress", type: "started", position: 2, color: "#f2c94c" },
              { id: ID(3), name: "Done", type: "completed", position: 3, color: "#5e6ad2" },
            ],
          },
        },
      ],
    },
  },
};

// What a successful issueUpdate looks like, echoing back what was asked for.
const applied = (request: SeenRequest) => {
  const input = request.variables.input as { stateId?: string; priority?: number; estimate?: number };
  return {
    data: {
      issueUpdate: {
        success: true,
        issue: {
          identifier: "PD-7",
          priority: input.priority ?? 2,
          estimate: input.estimate ?? 3,
          state: { id: input.stateId ?? ID(1), name: "x", type: "started", color: "#fff" },
        },
      },
    },
  };
};

// Mount the edit screen with a fake network. `respond` decides what each WRITE gets;
// the team-settings read is answered from `settings` (default: a normal PD team).
function mount(
  kind: EditKind,
  respond: (request: SeenRequest) => unknown = applied,
  options: { delayMs?: number; settings?: unknown } = {},
) {
  const requests: SeenRequest[] = [];
  restoreFetch = mockFetch(
    (request) => {
      requests.push(request);
      return request.query.includes("TeamSettings") ? (options.settings ?? teamSettings) : respond(request);
    },
    { delayMs: options.delayMs },
  );
  const events = { cancelled: 0, done: [] as string[] };
  // The panel is positioned over its PARENT, so it needs a parent with a size, exactly
  // like the full-screen box the app puts it in. Without one it would be clipped to nothing.
  const terminal = mountTerminal(
    <Box width={60} height={24}>
      <EditScreen issue={issue} kind={kind} onCancel={() => events.cancelled++} onDone={(message) => events.done.push(message)} />
    </Box>,
    { columns: 60, rows: 24 },
  );

  return {
    requests,
    events,
    writes: () => requests.filter((r) => r.query.includes("issueUpdate")),
    ...terminal,
  };
}

// ---------------------------------------------------------------------------
describe("browsing sends nothing", () => {
  test("the priority picker appears immediately, with the cursor on the current value", async () => {
    const edit = mount("priority");
    await edit.settle();
    expect(edit.screen()).toContain("Change priority");
    expect(edit.screen()).toContain("High  (current)");
    expect(edit.requests).toHaveLength(0);
    edit.unmount();
  });

  test("moving around, reaching the confirm screen and backing out sends no write", async () => {
    const edit = mount("priority");
    await edit.settle();
    await edit.press(KEY.j, KEY.j, KEY.k, KEY.enter); // now on the confirm screen
    expect(edit.screen()).toContain("enter apply");
    await edit.press(KEY.esc); // back to the picker
    expect(edit.screen()).toContain("enter select");
    await edit.press(KEY.esc); // cancel
    expect(edit.events.cancelled).toBe(1);
    expect(edit.requests).toHaveLength(0);
    expect(edit.events.done).toHaveLength(0);
    edit.unmount();
  });

  test("status loads the team's options with a READ, and still sends no write", async () => {
    const edit = mount("status");
    await edit.settle(250);
    expect(edit.screen()).toContain("In Progress");
    expect(edit.requests).toHaveLength(1);
    expect(edit.requests[0]?.query).toContain("TeamSettings");
    expect(edit.writes()).toHaveLength(0);
    edit.unmount();
  });

  test("keys pressed while the options are still loading do nothing", async () => {
    const edit = mount("status", applied, { delayMs: 300 });
    await edit.press(KEY.j, KEY.enter, KEY.enter);
    expect(edit.screen()).toContain("Loading");
    expect(edit.writes()).toHaveLength(0);
    await edit.press(KEY.esc);
    expect(edit.events.cancelled).toBe(1);
    edit.unmount();
  });

  test("q cancels from the confirm screen without sending anything", async () => {
    const edit = mount("priority");
    await edit.settle();
    await edit.press(KEY.j, KEY.enter, KEY.q);
    expect(edit.events.cancelled).toBe(1);
    expect(edit.writes()).toHaveLength(0);
    edit.unmount();
  });
});

// ---------------------------------------------------------------------------
describe("a confirmed change sends exactly one write", () => {
  test("priority: High -> Medium", async () => {
    const edit = mount("priority");
    await edit.settle();
    await edit.press(KEY.j, KEY.enter, KEY.enter);
    await edit.settle();
    expect(edit.writes()).toHaveLength(1);
    expect(edit.writes()[0]?.variables).toEqual({ id: "PD-7", input: { priority: 3 } });
    expect(edit.events.done).toEqual(["PD-7: High → Medium"]);
    expect(edit.events.cancelled).toBe(0);
    edit.unmount();
  });

  test("status: Todo -> In Progress, by the team's own status id", async () => {
    const edit = mount("status");
    await edit.settle(250);
    await edit.press(KEY.j, KEY.enter, KEY.enter);
    await edit.settle();
    expect(edit.writes()).toHaveLength(1);
    expect(edit.writes()[0]?.variables).toEqual({ id: "PD-7", input: { stateId: ID(2) } });
    expect(edit.events.done).toEqual(["PD-7: Todo → In Progress"]);
    edit.unmount();
  });

  test("estimate: M -> L", async () => {
    const edit = mount("estimate");
    await edit.settle(250);
    await edit.press(KEY.j, KEY.enter, KEY.enter);
    await edit.settle();
    expect(edit.writes()[0]?.variables).toEqual({ id: "PD-7", input: { estimate: 5 } });
    expect(edit.events.done).toEqual(["PD-7: M → L"]);
    edit.unmount();
  });

  test("a finishing status shows the warning before anything is sent", async () => {
    const edit = mount("status");
    await edit.settle(250);
    await edit.press(KEY.j, KEY.j, KEY.enter); // -> Done, confirm screen
    expect(edit.screen()).toContain("validation comment");
    expect(edit.writes()).toHaveLength(0);
    edit.unmount();
  });
});

// ---------------------------------------------------------------------------
describe("double-submit safety", () => {
  // The write is slow here, so extra Enters arrive WHILE it is in flight.
  test("Enter pressed again while saving never sends a second write", async () => {
    const edit = mount("priority", applied, { delayMs: 300 });
    await edit.settle();
    await edit.press(KEY.j, KEY.enter, KEY.enter); // apply
    await edit.press(KEY.enter, KEY.enter, KEY.enter); // impatient extra Enters, mid-flight
    expect(edit.screen()).toContain("Saving");
    await edit.settle(500);
    expect(edit.writes()).toHaveLength(1);
    expect(edit.events.done).toHaveLength(1);
    edit.unmount();
  });

  test("two Enters in ONE chunk can't apply twice", async () => {
    const edit = mount("priority", applied, { delayMs: 200 });
    await edit.settle();
    await edit.press(KEY.j, KEY.enter); // on the confirm screen
    await edit.press(`${KEY.enter}${KEY.enter}`); // both in one chunk
    await edit.settle(500);
    expect(edit.writes().length).toBeLessThanOrEqual(1);
    expect(edit.events.done.length).toBeLessThanOrEqual(1);
    edit.unmount();
  });

  test("Esc can't interrupt a write that is already in flight", async () => {
    const edit = mount("priority", applied, { delayMs: 300 });
    await edit.settle();
    await edit.press(KEY.j, KEY.enter, KEY.enter, KEY.esc, KEY.q);
    expect(edit.events.cancelled).toBe(0);
    await edit.settle(500);
    expect(edit.writes()).toHaveLength(1);
    expect(edit.events.done).toHaveLength(1);
    edit.unmount();
  });
});

// ---------------------------------------------------------------------------
describe("nothing is sent when there is nothing to change", () => {
  test("choosing the issue's current value closes without a write", async () => {
    const edit = mount("priority");
    await edit.settle();
    await edit.press(KEY.enter); // current is High: choose it
    expect(edit.screen()).toContain("Nothing to change");
    expect(edit.screen()).not.toContain("enter apply");
    await edit.press(KEY.enter);
    expect(edit.events.cancelled).toBe(1);
    expect(edit.events.done).toHaveLength(0);
    expect(edit.requests).toHaveLength(0);
    edit.unmount();
  });

  test("dry-run mode does the whole flow and sends no write", async () => {
    process.env.LINEAR_TUI_DRY_RUN = "1";
    const edit = mount("priority");
    await edit.settle();
    await edit.press(KEY.j, KEY.enter);
    expect(edit.screen()).toContain("DRY RUN: nothing will be sent to Linear.");
    await edit.press(KEY.enter);
    await edit.settle();
    expect(edit.requests).toHaveLength(0);
    expect(edit.events.done).toEqual(["(dry run) PD-7: High → Medium"]);
    edit.unmount();
  });

  test("an estimate scale that isn't supported says so and sends nothing", async () => {
    const fibonacci = structuredClone(teamSettings);
    fibonacci.data.teams.nodes[0]!.issueEstimationType = "fibonacci";
    const edit = mount("estimate", applied, { settings: fibonacci });
    await edit.settle(250);
    expect(edit.flat()).toContain("isn't supported yet");
    await edit.press(KEY.enter);
    expect(edit.events.cancelled).toBe(1);
    expect(edit.writes()).toHaveLength(0);
    edit.unmount();
  });

  test("settings for a different team are refused, not used", async () => {
    const wrongTeam = structuredClone(teamSettings);
    wrongTeam.data.teams.nodes[0]!.key = "UC";
    const edit = mount("status", applied, { settings: wrongTeam });
    await edit.settle(250);
    expect(edit.screen()).toContain("can't be used");
    await edit.press(KEY.enter, KEY.enter);
    expect(edit.writes()).toHaveLength(0);
    edit.unmount();
  });
});

// ---------------------------------------------------------------------------
describe("when the write fails", () => {
  test("shows the error, leaves the issue alone, and does not report success", async () => {
    const edit = mount("priority", () => new Response("forbidden", { status: 403 }));
    await edit.settle();
    await edit.press(KEY.j, KEY.enter, KEY.enter);
    await edit.settle();
    expect(edit.flat()).toContain("Linear didn't apply the change");
    expect(edit.flat()).toContain("HTTP 403");
    expect(edit.events.done).toHaveLength(0);
    expect(edit.writes()).toHaveLength(1);
    edit.unmount();
  });

  test("a permission error from Linear is shown", async () => {
    const edit = mount("priority", () => ({ errors: [{ message: "You do not have permission to update this issue" }] }));
    await edit.settle();
    await edit.press(KEY.j, KEY.enter, KEY.enter);
    await edit.settle();
    expect(edit.screen()).toContain("permission");
    expect(edit.events.done).toHaveLength(0);
    edit.unmount();
  });

  test("Enter retries once per press, and a later success is reported once", async () => {
    let attempts = 0;
    const edit = mount("priority", (request) => (++attempts < 3 ? new Response("busy", { status: 503 }) : applied(request)));
    await edit.settle();
    await edit.press(KEY.j, KEY.enter, KEY.enter); // attempt 1 fails
    await edit.settle();
    expect(edit.writes()).toHaveLength(1);
    await edit.press(KEY.enter); // retry: attempt 2 fails
    await edit.settle();
    expect(edit.writes()).toHaveLength(2);
    await edit.press(KEY.enter); // retry: attempt 3 succeeds
    await edit.settle();
    expect(edit.writes()).toHaveLength(3);
    expect(edit.events.done).toEqual(["PD-7: High → Medium"]);
    edit.unmount();
  });

  test("Esc after a failure goes back to the picker; nothing more is sent", async () => {
    const edit = mount("priority", () => new Response("nope", { status: 500 }));
    await edit.settle();
    await edit.press(KEY.j, KEY.enter, KEY.enter);
    await edit.settle();
    await edit.press(KEY.esc);
    expect(edit.screen()).toContain("enter select");
    expect(edit.writes()).toHaveLength(1);
    edit.unmount();
  });

  test("a write that Linear reports as applied with a DIFFERENT value is treated as a failure", async () => {
    const edit = mount("priority", () => ({
      data: { issueUpdate: { success: true, issue: { identifier: "PD-7", priority: 4, estimate: 3, state: { id: ID(1), name: "x", type: "started", color: "#fff" } } } },
    }));
    await edit.settle();
    await edit.press(KEY.j, KEY.enter, KEY.enter);
    await edit.settle();
    expect(edit.screen()).toContain("different priority");
    expect(edit.events.done).toHaveLength(0);
    edit.unmount();
  });

  test("an error text containing escape sequences is cleaned before it is shown", async () => {
    const edit = mount("priority", () => new Response("x", { status: 500 }));
    await edit.settle();
    await edit.press(KEY.j, KEY.enter, KEY.enter);
    await edit.settle();
    expect(edit.screen()).not.toContain(ESC);
    edit.unmount();
  });

  test("if the team's options can't be loaded, it says so and nothing is sent", async () => {
    const edit = mount("status", applied, { settings: { errors: [{ message: "Team lookup failed" }] } });
    await edit.settle(250);
    expect(edit.screen()).toContain("Team lookup failed");
    await edit.press(KEY.enter);
    expect(edit.events.cancelled).toBe(1);
    expect(edit.writes()).toHaveLength(0);
    edit.unmount();
  });
});
