// Tests for the whole app (src/app.tsx): the list, the detail screen, and the edit
// panel that floats over them. It runs the REAL app against a fake Linear server that
// REMEMBERS changes, so the reload after an edit returns the new values like the
// real one would. Keys go in, the screen comes out.

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Mock } from "bun:test";
import { App } from "./app.tsx";
import { helpHeight } from "./help-screen.tsx";
import { helpLines } from "./help.ts";
import { panelGeometry } from "./panel.tsx";
import { mockFetch } from "./testing.ts";
import type { SeenRequest } from "./testing.ts";
import { KEY, mountTerminal } from "./testing-terminal.ts";

const ID = (n: number) => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const STATES: Record<string, { name: string; type: string }> = {
  [ID(1)]: { name: "Todo", type: "unstarted" },
  [ID(2)]: { name: "In Progress", type: "started" },
  [ID(3)]: { name: "Done", type: "completed" },
};

const COLUMNS = 80;
const ROWS = 30;
// Long lines, on purpose: they run underneath the edit panel's columns, so these tests
// notice if the panel is drawn UNDER the screen or lets the screen show through it.
const DESCRIPTION = Array.from({ length: 60 }, (_, i) => `Line ${i + 1} ${"=".repeat(60)}`).join("\n");

// A tiny fake of Linear: one issue (PD-7) whose status, priority and estimate can be
// changed, plus the detail and team-settings queries.
function fakeLinear() {
  const server = { stateId: ID(1), priority: 2, estimate: 3, requests: [] as SeenRequest[], writes: [] as unknown[] };
  const respond = (request: SeenRequest): unknown => {
    server.requests.push(request);
    const state = STATES[server.stateId] ?? { name: "?", type: "started" };

    if (request.query.includes("issueUpdate")) {
      const input = request.variables.input as { stateId?: string; priority?: number; estimate?: number };
      server.writes.push(input);
      if (input.stateId !== undefined) server.stateId = input.stateId;
      if (input.priority !== undefined) server.priority = input.priority;
      if (input.estimate !== undefined) server.estimate = input.estimate;
      const after = STATES[server.stateId] ?? state;
      return {
        data: {
          issueUpdate: {
            success: true,
            issue: { identifier: "PD-7", priority: server.priority, estimate: server.estimate, state: { id: server.stateId, ...after, color: "#fff" } },
          },
        },
      };
    }
    if (request.query.includes("TeamSettings")) {
      return {
        data: {
          teams: {
            nodes: [
              {
                key: "PD",
                issueEstimationType: "tShirt",
                issueEstimationExtended: false,
                issueEstimationAllowZero: true,
                states: { nodes: Object.entries(STATES).map(([id, s], i) => ({ id, ...s, position: i + 1, color: "#e2e2e2" })) },
              },
            ],
          },
        },
      };
    }
    if (request.query.includes("IssueDetail")) {
      return {
        data: {
          issue: {
            description: DESCRIPTION,
            createdAt: "2026-11-01T00:00:00Z",
            updatedAt: "2026-11-02T00:00:00Z",
            assignee: null,
            project: null,
            comments: { pageInfo: { hasNextPage: false }, nodes: [] },
          },
        },
      };
    }
    // Otherwise: the list of my issues.
    return {
      data: {
        viewer: {
          assignedIssues: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                identifier: "PD-7",
                title: "Fix the thing",
                url: "https://linear.app/x/issue/PD-7",
                priority: server.priority,
                state: { name: state.name, type: state.type, position: 1, color: "#e2e2e2" },
                dueDate: null,
                estimate: server.estimate,
                labels: { nodes: [] },
                team: { key: "PD", issueEstimationType: "tShirt" },
                cycle: { number: 1, endsAt: "2099-12-30T05:00:00.000Z", team: { key: "PD" } },
              },
            ],
          },
        },
      },
    };
  };
  return { server, respond };
}

let spawn: Mock<typeof Bun.spawn>;
let restoreFetch: (() => void) | undefined;
beforeEach(() => {
  // The Keychain read is replaced by a fake key.
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

// Start the app against the fake Linear and wait for the first load.
async function startApp() {
  const linear = fakeLinear();
  restoreFetch = mockFetch(linear.respond);
  const terminal = mountTerminal(<App />, { columns: COLUMNS, rows: ROWS });
  await terminal.settle(500);
  const rowsOf = () => terminal.screen().split("\n");
  const issueQueries = () => linear.server.requests.filter((r) => r.query.includes("MyCycleIssues")).length;
  const openDetail = async () => {
    await terminal.press(KEY.j, KEY.enter); // select PD-7, open it
    await terminal.settle(500);
  };
  return { ...terminal, ...linear, rowsOf, issueQueries, openDetail };
}

// ---------------------------------------------------------------------------
describe("the app, before any editing", () => {
  test("loads and shows the board", async () => {
    const app = await startApp();
    expect(app.screen()).toContain("LINEAR BOARD");
    expect(app.screen()).toContain("PD-7");
    expect(app.screen()).toContain("Fix the thing");
    app.unmount();
  });

  test("Enter opens the detail screen, which fetches the description", async () => {
    const app = await startApp();
    await app.openDetail();
    expect(app.screen()).toContain("DESCRIPTION");
    expect(app.screen()).toContain("Line 1");
    expect(app.rowsOf().at(-1)).toContain("lines 1–");
    app.unmount();
  });
});

// ---------------------------------------------------------------------------
describe("the edit panel floats over the detail screen", () => {
  test("it's drawn on top of the screen, which stays visible around it and is fully covered beneath it", async () => {
    const app = await startApp();
    await app.openDetail();
    await app.press("s");
    await app.settle(400); // the team's statuses load

    const rows = app.rowsOf();
    expect(app.screen()).toContain("Change status");
    // Above the panel the detail screen is still there...
    expect(rows[7]).toContain("Line 1");
    expect(app.screen()).toContain("DESCRIPTION");
    expect(rows.at(-1)).toContain("lines 1–");
    // ...and nothing of it shows through INSIDE the panel.
    const g = panelGeometry(COLUMNS, ROWS, 8); // 3 statuses: header 3 + 3 + footer 2
    for (let row = g.top + 1; row < g.top + g.height - 1; row++) {
      const inside = (rows[row] ?? "").slice(g.left + 1, g.left + g.width - 1);
      expect(inside).not.toContain("Line ");
      expect(inside).not.toContain("=====");
      expect(inside).not.toContain("DESCRIPTION");
    }
    app.unmount();
  });

  test("while the panel is open, keys go to the panel only; Esc closes just the panel", async () => {
    const app = await startApp();
    await app.openDetail();
    await app.press("s");
    await app.settle(400);

    await app.press(KEY.j, KEY.j, KEY.k); // moves the panel's cursor, not the detail's scroll
    expect(app.rowsOf().at(-1)).toContain("lines 1–"); // the detail did not scroll
    expect(app.screen()).toContain("Change status");

    await app.press(KEY.esc);
    expect(app.screen()).not.toContain("Change status"); // the panel is gone
    expect(app.screen()).toContain("DESCRIPTION"); // the detail screen is still here, not closed
    expect(app.rowsOf().at(-1)).toContain("lines 1–");

    await app.press(KEY.j); // and the detail's own keys work again
    expect(app.rowsOf().at(-1)).toContain("lines 2–");
    app.unmount();
  });

  test("a change made in the panel stays on the detail screen, which then shows the new status", async () => {
    const app = await startApp();
    await app.openDetail();
    const queriesBefore = app.issueQueries();
    expect(app.rowsOf()[0]).toContain("Todo");

    await app.press("s");
    await app.settle(400);
    await app.press(KEY.j, KEY.enter, KEY.enter); // In Progress -> confirm -> apply
    await app.settle(700); // the write, then the reload

    expect(app.server.writes).toEqual([{ stateId: ID(2) }]);
    expect(app.issueQueries()).toBeGreaterThan(queriesBefore); // the board reloaded
    expect(app.screen()).not.toContain("Change status"); // the panel closed itself
    expect(app.screen()).toContain("DESCRIPTION"); // still on the detail screen
    expect(app.rowsOf()[0]).toContain("In Progress"); // its header shows Linear's new value
    expect(app.rowsOf().at(-1)).toContain("✓ PD-7: Todo → In Progress");
    app.unmount();
  });

  test("scroll position survives the panel (the detail screen stays mounted)", async () => {
    const app = await startApp();
    await app.openDetail();
    await app.press(KEY.j, KEY.j, KEY.j); // scroll down 3
    expect(app.rowsOf().at(-1)).toContain("lines 4–");
    await app.press("P");
    await app.press(KEY.esc);
    expect(app.rowsOf().at(-1)).toContain("lines 4–");
    app.unmount();
  });

  test("dry-run: the whole flow works, the banner shows, and nothing is sent", async () => {
    process.env.LINEAR_TUI_DRY_RUN = "1";
    const app = await startApp();
    await app.openDetail();
    await app.press("s");
    await app.settle(400);
    await app.press(KEY.j, KEY.enter);
    expect(app.screen()).toContain("DRY RUN: nothing will be sent to Linear.");
    await app.press(KEY.enter);
    await app.settle(500);
    expect(app.server.writes).toEqual([]);
    expect(app.rowsOf().at(-1)).toContain("(dry run) PD-7: Todo → In Progress");
    app.unmount();
  });
});

// ---------------------------------------------------------------------------
describe("the edit panel floats over the list", () => {
  test("it covers part of the list; the rest stays visible; Esc closes only the panel", async () => {
    const app = await startApp();
    await app.press(KEY.j); // select PD-7
    await app.press("P");
    expect(app.screen()).toContain("Change priority");
    expect(app.screen()).toContain("LINEAR BOARD"); // the list is still there, above the panel

    await app.press(KEY.j, KEY.j); // moves the panel's cursor, not the list's
    await app.press(KEY.esc);
    expect(app.screen()).not.toContain("Change priority");
    expect(app.screen()).toContain("▌ PD-7"); // the list cursor never moved
    app.unmount();
  });

  test("a change made from the list stays on the list and shows a confirmation", async () => {
    const app = await startApp();
    await app.press(KEY.j);
    await app.press("P");
    await app.press(KEY.j, KEY.enter, KEY.enter); // High -> Medium -> confirm -> apply
    await app.settle(700);

    expect(app.server.writes).toEqual([{ priority: 3 }]);
    expect(app.screen()).toContain("LINEAR BOARD");
    expect(app.rowsOf().at(-1)).toContain("✓ PD-7: High → Medium");
    app.unmount();
  });

  test("the edit keys do nothing when a status header is selected (no issue to edit)", async () => {
    const app = await startApp(); // the cursor starts on the group header
    await app.press("s", "P", "e");
    expect(app.screen()).not.toContain("Change");
    expect(app.server.requests.filter((r) => !r.query.includes("MyCycleIssues"))).toHaveLength(0);
    app.unmount();
  });
});

// ---------------------------------------------------------------------------
describe("the ? help panel", () => {
  test("the footer is short now: one hint line and the status line", async () => {
    const app = await startApp();
    const rows = app.rowsOf();
    expect(rows.at(-2)).toContain("? help");
    expect(rows.at(-1)).toContain("updated");
    expect(app.screen()).not.toContain("change: s status"); // the long hint lines moved into the help
    expect(app.screen()).not.toContain("filter: /");
    app.unmount();
  });

  test("the detail screen's footer is short too", async () => {
    const app = await startApp();
    await app.openDetail();
    const rows = app.rowsOf();
    expect(rows.at(-2)).toContain("? help");
    expect(rows.at(-1)).toContain("lines 1–");
    expect(app.screen()).not.toContain("change: s status");
    app.unmount();
  });

  test("opens over the board, which stays visible around it; keys go to the help only; Esc closes it", async () => {
    const app = await startApp();
    await app.press(KEY.j); // select PD-7
    await app.press("?");
    expect(app.screen()).toContain("Keyboard help");
    expect(app.screen()).toContain("On the board");
    expect(app.rowsOf()[0]).toContain("LINEAR BOARD"); // the board is still there, above the panel

    await app.press(KEY.j, KEY.j, KEY.k); // scroll the HELP, not the board
    await app.press(KEY.esc);
    expect(app.screen()).not.toContain("Keyboard help");
    expect(app.screen()).toContain("▌ PD-7"); // the board's cursor never moved
    app.unmount();
  });

  test("covers the board beneath it completely", async () => {
    const app = await startApp();
    await app.press(KEY.j);
    await app.press("?");
    const g = panelGeometry(COLUMNS, ROWS, helpHeight(helpLines("list").length, ROWS - 4));
    const rows = app.rowsOf();
    for (let row = g.top + 1; row < g.top + g.height - 1; row++) {
      const inside = (rows[row] ?? "").slice(g.left + 1, g.left + g.width - 1);
      expect(inside).not.toContain("PD-7");
      expect(inside).not.toContain("Fix the thing");
    }
    app.unmount();
  });

  test("? again closes it", async () => {
    const app = await startApp();
    await app.press("?");
    expect(app.screen()).toContain("Keyboard help");
    await app.press("?");
    expect(app.screen()).not.toContain("Keyboard help");
    app.unmount();
  });

  test("over the detail screen it shows the detail screen's keys, and that screen stays put", async () => {
    const app = await startApp();
    await app.openDetail();
    await app.press("?");
    expect(app.screen()).toContain("Keyboard help");
    expect(app.screen()).toContain("On an issue's detail screen");
    expect(app.screen()).toContain("back to the board");

    await app.press(KEY.j, KEY.j); // must NOT scroll the detail screen underneath
    expect(app.rowsOf().at(-1)).toContain("lines 1–");

    await app.press(KEY.esc); // closes only the help
    expect(app.screen()).not.toContain("Keyboard help");
    expect(app.screen()).toContain("DESCRIPTION");
    await app.press(KEY.j); // and the detail's own keys work again
    expect(app.rowsOf().at(-1)).toContain("lines 2–");
    app.unmount();
  });

  test("doesn't open on top of the edit panel", async () => {
    const app = await startApp();
    await app.press(KEY.j);
    await app.press("P");
    expect(app.screen()).toContain("Change priority");
    await app.press("?");
    expect(app.screen()).not.toContain("Keyboard help");
    expect(app.screen()).toContain("Change priority");
    app.unmount();
  });

  test("a ? typed into the search bar is just text, not the help key", async () => {
    const app = await startApp();
    await app.press("/");
    await app.press("?");
    expect(app.screen()).not.toContain("Keyboard help");
    expect(app.rowsOf().at(-2)).toContain("/ ?"); // the search bar shows the typed character
    app.unmount();
  });

  test("the edit keys still work from the board after closing the help", async () => {
    const app = await startApp();
    await app.press(KEY.j);
    await app.press("?");
    await app.press(KEY.esc);
    await app.press("P");
    expect(app.screen()).toContain("Change priority");
    app.unmount();
  });
});
