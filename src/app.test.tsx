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
import { ESC, mockFetch } from "./testing.ts";
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
function fakeLinear(extraIssues = 0) {
  const server = { stateId: ID(1), priority: 2, estimate: 3, requests: [] as SeenRequest[], writes: [] as unknown[] };
  // More issues, to give the list something to scroll. Each is one line tall, in the same group.
  const extraIssue = (i: number) => ({
    identifier: `PD-${100 + i}`,
    title: `Extra issue ${i}`,
    url: `https://linear.app/x/issue/PD-${100 + i}`,
    priority: 3,
    state: { name: "Todo", type: "unstarted", position: 1, color: "#e2e2e2" },
    dueDate: null,
    estimate: null,
    labels: { nodes: [] },
    team: { key: "PD", issueEstimationType: "tShirt" },
    cycle: { number: 1, endsAt: "2099-12-30T05:00:00.000Z", team: { key: "PD" } },
  });
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
              ...Array.from({ length: extraIssues }, (_, i) => extraIssue(i)),
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
  delete process.env.TANGENT_DRY_RUN;
});

// Start the app against the fake Linear and wait for the first load.
async function startApp({ extraIssues = 0 } = {}) {
  const linear = fakeLinear(extraIssues);
  restoreFetch = mockFetch(linear.respond);
  // mouse: true gives the app the real mouse pipeline (the filter and the context).
  const terminal = mountTerminal(<App />, { columns: COLUMNS, rows: ROWS, mouse: true });
  await terminal.waitForText("PD-7"); // the first load has finished
  const rowsOf = () => terminal.screen().split("\n");
  const issueQueries = () => linear.server.requests.filter((r) => r.query.includes("MyCycleIssues")).length;
  const openDetail = async () => {
    await terminal.press(KEY.j, KEY.enter); // select PD-7, open it
    await terminal.waitForText("Line 1"); // the description has loaded
  };
  return { ...terminal, ...linear, rowsOf, issueQueries, openDetail };
}

// ---------------------------------------------------------------------------
describe("the app, before any editing", () => {
  test("loads and shows the board", async () => {
    const app = await startApp();
    expect(app.screen()).toContain("TANGENT");
    expect(app.screen()).toContain("PD-7");
    expect(app.screen()).toContain("Fix the thing");
    app.unmount();
  });
});

// ---------------------------------------------------------------------------
describe("the edit panel floats over the detail screen", () => {
  test("it's drawn on top of the screen, which stays visible around it and is fully covered beneath it", async () => {
    const app = await startApp();
    await app.openDetail();
    await app.press("s");
    await app.waitForText("Change status", "In Progress"); // the team's statuses load

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
    await app.waitForText("Change status", "In Progress");

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
    await app.waitForText("Change status", "In Progress");
    await app.press(KEY.j, KEY.enter, KEY.enter); // In Progress -> confirm -> apply
    await app.waitForText("✓ PD-7: Todo → In Progress"); // the write, then the reload

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
    process.env.TANGENT_DRY_RUN = "1";
    const app = await startApp();
    await app.openDetail();
    await app.press("s");
    await app.waitForText("Change status", "In Progress");
    await app.press(KEY.j, KEY.enter);
    expect(app.screen()).toContain("DRY RUN: nothing will be sent to Linear.");
    await app.press(KEY.enter);
    await app.waitForText("(dry run) PD-7: Todo → In Progress");
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
    expect(app.screen()).toContain("TANGENT"); // the list is still there, above the panel

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
    await app.waitForText("✓ PD-7: High → Medium");

    expect(app.server.writes).toEqual([{ priority: 3 }]);
    expect(app.screen()).toContain("TANGENT");
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
    expect(app.rowsOf()[0]).toContain("TANGENT"); // the board is still there, above the panel

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

// ---------------------------------------------------------------------------
// The list used to show "whole items from a remembered first item" and always forced the
// highlighted one into view, so scrolling and selection were the same thing (the wheel
// even arrived as arrow keys). Now it's a real scrolling window, line by line.
describe("scrolling the list for real", () => {
  const BODY_TOP = 4; // rows above the list: the title, a gap, one cycle line, a gap
  const ENABLE = `${ESC}[?1000h${ESC}[?1006h`;

  test("the app asks the terminal for mouse reports at start", async () => {
    const app = await startApp();
    expect(app.mouseWrites).toEqual([ENABLE]);
    app.unmount();
  });

  test("one notch of the wheel scrolls three lines, and the highlight is left where it was", async () => {
    const app = await startApp({ extraIssues: 40 });
    expect(app.rowsOf()[BODY_TOP]).toContain("TODO"); // the group header is the first line of the list
    expect(app.screen()).toContain("▌▾ ● TODO"); // and it is highlighted
    expect(app.rowsOf().at(-1)).not.toContain("▲");

    await app.wheel("down", 5, 10);
    // Lines 0-2 (the header, PD-7, PD-100) scrolled off; line 3 is now at the top.
    expect(app.rowsOf()[BODY_TOP]).toContain("PD-101");
    expect(app.screen()).not.toContain("▌"); // the highlight is out of view, NOT moved along with the scroll
    expect(app.rowsOf().at(-1)).toContain("▲");
    app.unmount();
  });

  test("stops at the top and at the bottom", async () => {
    const app = await startApp({ extraIssues: 40 });
    await app.wheel("up");
    await app.wheel("up");
    expect(app.rowsOf()[BODY_TOP]).toContain("TODO"); // can't go above the top
    for (let notch = 0; notch < 25; notch++) await app.wheel("down");
    expect(app.screen()).toContain("Extra issue 39"); // the last issue is on screen
    expect(app.rowsOf().at(-1)).not.toContain("▼"); // nothing more below
    expect(app.rowsOf().at(-1)).toContain("▲");
    const bottom = app.screen();
    await app.wheel("down"); // another notch changes nothing
    expect(app.screen()).toBe(bottom);
    app.unmount();
  });

  test("moving the highlight with the keyboard afterwards scrolls it back into view", async () => {
    const app = await startApp({ extraIssues: 40 });
    await app.wheel("down");
    await app.wheel("down"); // 6 lines down: the highlighted header is far above the window
    expect(app.screen()).not.toContain("▌");
    await app.press(KEY.j); // the highlight moves to PD-7, which must now be shown
    expect(app.rowsOf()[BODY_TOP]).toContain("▌ PD-7");
    app.unmount();
  });

  test("G jumps to the last issue and scrolls to show it", async () => {
    const app = await startApp({ extraIssues: 40 });
    await app.press("G");
    expect(app.screen()).toContain("▌ PD-139");
    expect(app.rowsOf().at(-1)).not.toContain("▼");
    app.unmount();
  });

  test("starting a search puts the list back at the top", async () => {
    const app = await startApp({ extraIssues: 40 });
    await app.wheel("down");
    await app.wheel("down");
    expect(app.rowsOf().at(-1)).toContain("▲");
    await app.press("/");
    await app.press("E");
    expect(app.rowsOf()[BODY_TOP]).toContain("TODO"); // back at the top
    app.unmount();
  });

  test("a wheel report is never typed into the search bar", async () => {
    const app = await startApp({ extraIssues: 40 });
    await app.press("/");
    await app.wheel("down");
    await app.wheel("up");
    const bar = app.rowsOf().at(-2) ?? "";
    expect(bar).toContain("/ ");
    expect(bar).not.toContain("<");
    expect(bar).not.toContain("[");
    app.unmount();
  });

  test("the wheel doesn't move the highlight or open anything", async () => {
    const app = await startApp({ extraIssues: 40 });
    await app.press(KEY.j); // highlight PD-7
    await app.wheel("down");
    await app.wheel("down");
    await app.wheel("up");
    await app.wheel("up");
    expect(app.screen()).toContain("▌ PD-7"); // back where it was, never moved
    expect(app.screen()).not.toContain("DESCRIPTION");
    app.unmount();
  });
});

// ---------------------------------------------------------------------------
describe("clicking in the list", () => {
  const BODY_TOP = 4; // the list starts on screen row 4 (rows are counted from 0)

  test("clicking an issue opens its detail screen", async () => {
    const app = await startApp();
    await app.click(10, BODY_TOP + 1); // row 5 is PD-7, the first issue under the TODO header
    await app.waitForText("Line 1");
    expect(app.screen()).toContain("DESCRIPTION");
    expect(app.screen()).toContain("Line 1");
    app.unmount();
  });

  test("clicking an issue lower in the list opens THAT issue", async () => {
    const app = await startApp({ extraIssues: 3 });
    await app.click(10, BODY_TOP + 2); // PD-100, the next row down
    await app.waitForText("DESCRIPTION"); // the detail screen is open
    expect(app.screen()).toContain("PD-100");
    expect(app.screen()).toContain("Extra issue 0");
    app.unmount();
  });

  test("clicking after scrolling hits the issue that is on screen, not the one at the top of the list", async () => {
    const app = await startApp({ extraIssues: 40 });
    await app.wheel("down"); // 3 lines: PD-101 is now the first row
    expect(app.rowsOf()[BODY_TOP]).toContain("PD-101");
    await app.click(10, BODY_TOP);
    await app.waitForText("DESCRIPTION");
    expect(app.screen()).toContain("Extra issue 1"); // PD-101
    app.unmount();
  });

  test("clicking a group header folds the group, and clicking again unfolds it", async () => {
    const app = await startApp();
    await app.click(10, BODY_TOP);
    expect(app.screen()).not.toContain("PD-7"); // folded away
    expect(app.screen()).toContain("▸"); // the fold arrow now points right
    await app.click(10, BODY_TOP);
    expect(app.screen()).toContain("PD-7");
    app.unmount();
  });

  test("clicks on the header or the footer do nothing", async () => {
    const app = await startApp();
    const before = app.screen();
    await app.click(10, 0); // the title
    await app.click(10, ROWS - 1); // the footer
    expect(app.screen()).toBe(before);
    app.unmount();
  });

  test("clicks below the last issue do nothing", async () => {
    const app = await startApp();
    const before = app.screen();
    await app.click(10, BODY_TOP + 8); // empty space under the list
    expect(app.screen()).toBe(before);
    app.unmount();
  });

  test("right and middle buttons don't open anything", async () => {
    const app = await startApp();
    await app.click(10, 5, "right");
    await app.click(10, 5, "middle");
    await app.settle(200);
    expect(app.screen()).not.toContain("DESCRIPTION");
    app.unmount();
  });
});

describe("the m key", () => {
  test("switches mouse reporting off and on again, and says so in the status line", async () => {
    const app = await startApp();
    expect(app.screen()).not.toContain("mouse off");
    await app.press("m");
    expect(app.screen()).toContain("mouse off");
    expect(app.mouseWrites.at(-1)).toBe(`${ESC}[?1006l${ESC}[?1000l`);
    await app.press("m");
    expect(app.screen()).not.toContain("mouse off");
    expect(app.mouseWrites.at(-1)).toBe(`${ESC}[?1000h${ESC}[?1006h`);
    app.unmount();
  });
});

// ---------------------------------------------------------------------------
describe("the wheel and clicks on the detail screen and the help", () => {
  test("the wheel scrolls the detail screen", async () => {
    const app = await startApp();
    await app.openDetail();
    expect(app.rowsOf().at(-1)).toContain("lines 1–");
    await app.wheel("down", 10, 10);
    expect(app.screen()).not.toContain("Line 1 ="); // the first body line scrolled away
    expect(app.rowsOf().at(-1)).toContain("lines 4–"); // three lines per notch
    await app.wheel("up", 10, 10);
    expect(app.rowsOf().at(-1)).toContain("lines 1–");
    app.unmount();
  });

  test("the wheel scrolls the help, and the list underneath doesn't move", async () => {
    const app = await startApp({ extraIssues: 40 });
    await app.press("?");
    expect(app.screen()).toContain("Keyboard help");
    const before = app.screen();
    await app.wheel("down", 30, 15);
    expect(app.screen()).toContain("Keyboard help");
    expect(app.screen()).not.toBe(before); // the help scrolled
    expect(app.screen()).toContain("▲"); // there is more above now
    await app.press(KEY.esc);
    expect(app.rowsOf()[4]).toContain("TODO"); // the list is still at the top
    app.unmount();
  });

  test("a click outside the help closes it; a click inside does not", async () => {
    const app = await startApp();
    await app.press("?");
    await app.click(COLUMNS / 2, ROWS / 2); // the middle of the panel
    expect(app.screen()).toContain("Keyboard help");
    await app.click(0, 0); // far outside it
    expect(app.screen()).not.toContain("Keyboard help");
    expect(app.screen()).not.toContain("DESCRIPTION"); // and the click didn't open an issue underneath
    app.unmount();
  });
});

// ---------------------------------------------------------------------------
describe("the mouse in the edit panel (a click never saves)", () => {
  // Open the priority picker for PD-7 (priority High) and find the screen row of an option.
  const openPicker = async (app: Awaited<ReturnType<typeof startApp>>) => {
    await app.press(KEY.j, "P"); // select PD-7, open the priority picker
    await app.waitForText("Low");
    expect(app.screen()).toContain("Low");
  };
  const rowOf = (app: Awaited<ReturnType<typeof startApp>>, text: string) => app.rowsOf().findIndex((row) => row.includes(text));

  test("clicking an option goes to the confirm screen and sends NOTHING; only Enter saves", async () => {
    const app = await startApp();
    await openPicker(app);
    await app.click(COLUMNS / 2, rowOf(app, "Low"));
    await app.waitForText("enter apply"); // the confirm screen
    expect(app.flat()).toContain("Priority High → Low"); // the confirm screen
    expect(app.flat()).toContain("enter apply");
    expect(app.server.writes).toEqual([]); // the click sent nothing

    await app.click(COLUMNS / 2, 15); // a click inside the confirm panel: still nothing
    await app.settle(200);
    expect(app.flat()).toContain("enter apply");
    expect(app.server.writes).toEqual([]);

    await app.press(KEY.enter); // only this saves
    await app.waitFor(() => app.server.writes.length > 0);
    expect(app.server.writes).toEqual([{ priority: 4 }]);
    app.unmount();
  });

  test("clicking outside the panel cancels: nothing sent, nothing opened underneath", async () => {
    const app = await startApp();
    await openPicker(app);
    await app.click(0, 0);
    await app.waitFor(() => !app.screen().includes("Change priority")); // the panel closes
    expect(app.screen()).not.toContain("Change priority");
    expect(app.screen()).not.toContain("DESCRIPTION");
    expect(app.server.writes).toEqual([]);

    // Also from the confirm screen.
    await openPicker(app);
    await app.press(KEY.down, KEY.enter); // a different value, so the confirm screen offers to apply it
    expect(app.flat()).toContain("enter apply");
    await app.click(0, 0);
    await app.waitFor(() => !app.screen().includes("Change priority"));
    expect(app.screen()).not.toContain("Change priority");
    expect(app.server.writes).toEqual([]);
    app.unmount();
  });

  test("the wheel moves the picker's cursor", async () => {
    const app = await startApp();
    await openPicker(app);
    const cursorRow = () => app.rowsOf().find((row) => row.includes("▌ ") && row.includes("┃"));
    expect(cursorRow()).toContain("High"); // the current priority starts highlighted
    await app.wheel("down", COLUMNS / 2, 15);
    expect(cursorRow()).toContain("Medium");
    await app.wheel("up", COLUMNS / 2, 15);
    await app.wheel("up", COLUMNS / 2, 15);
    expect(cursorRow()).toContain("Urgent");
    expect(app.server.writes).toEqual([]);
    app.unmount();
  });

  test("clicking in the gap beside the options (header, footer) does nothing", async () => {
    const app = await startApp();
    await openPicker(app);
    const before = app.screen();
    await app.click(COLUMNS / 2, rowOf(app, "Change priority"));
    await app.click(COLUMNS / 2, rowOf(app, "enter select"));
    expect(app.screen()).toBe(before);
    app.unmount();
  });
});
