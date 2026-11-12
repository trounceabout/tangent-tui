// Tests for src/linear.ts: fetching, cleaning, grouping, and formatting issues.

import { afterEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import {
  COLLAPSED_STATUSES,
  cleanMultiline,
  cleanText,
  cycleProgress,
  daysLeft,
  fetchIssues,
  formatDue,
  formatEstimate,
  groupIssues,
  isFinished,
  linearQuery,
  API_KEY_ITEM,
  BAD_CREDENTIAL_MESSAGE,
  getApiKey,
} from "./linear.ts";
import { BEL, ESC, hasControlChars, makeIssue, mockFetch } from "./testing.ts";

// Each test that fakes the network or the clock cleans up after itself.
let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
  setSystemTime(); // back to the real clock
});

// ---------------------------------------------------------------------------
describe("cleanText", () => {
  test("leaves ordinary text alone, including emoji and CJK", () => {
    expect(cleanText("Fix the login 🚀 日本語")).toBe("Fix the login 🚀 日本語");
  });

  test("turns control characters (incl. ESC and newline) into spaces", () => {
    expect(cleanText(`a${ESC}[31mb\nc\td`)).toBe("a [31mb c d");
    expect(hasControlChars(cleanText(`x${ESC}]0;title${BEL}y${ESC}[2J`))).toBe(false);
  });

  test("drops bidirectional override characters", () => {
    expect(cleanText("abc‮def⁦")).toBe("abcdef");
  });
});

describe("cleanMultiline", () => {
  test("keeps newlines and normalises Windows/old-Mac line endings", () => {
    expect(cleanMultiline("a\r\nb\rc\nd")).toBe("a\nb\nc\nd");
  });

  test("still strips every other control character", () => {
    const cleaned = cleanMultiline(`x${ESC}]52;c;aGk=${BEL}y\tz`);
    expect(hasControlChars(cleaned.replaceAll("\n", ""))).toBe(false);
    expect(cleaned).toContain("x");
    expect(cleaned).toContain("z");
  });
});

// ---------------------------------------------------------------------------
describe("linearQuery", () => {
  test("sends the API key as-is (no 'Bearer'), and returns the data", async () => {
    let seen = "";
    restore = mockFetch((request) => {
      seen = request.headers.Authorization ?? "";
      return { data: { hello: "world" } };
    });
    const data = await linearQuery<{ hello: string }>("lin_api_secret", "{ x }", {});
    expect(data.hello).toBe("world");
    expect(seen).toBe("lin_api_secret");
  });

  test("throws on an HTTP error", async () => {
    restore = mockFetch(() => new Response("nope", { status: 500 }));
    await expect(linearQuery("k", "{ x }", {})).rejects.toThrow("HTTP 500");
  });

  test("throws on GraphQL errors", async () => {
    restore = mockFetch(() => ({ errors: [{ message: "bad field" }] }));
    await expect(linearQuery("k", "{ x }", {})).rejects.toThrow("bad field");
  });

  test("throws when there is no data", async () => {
    restore = mockFetch(() => ({}));
    await expect(linearQuery("k", "{ x }", {})).rejects.toThrow("no data");
  });
});

// ---------------------------------------------------------------------------
// A real `fetch` (Bun) given a bad header value throws an error that QUOTES the whole value:
//   Header '14' has invalid value: 'Bearer abc\nSECRETTAIL'
// and the app shows error text on screen, so the credential would be printed.
describe("linearQuery never prints the credential", () => {
  const badCredentials: [string, string][] = [
    ["a line break", "Bearer abc\r\nSECRETTAIL"],
    ["a newline", "lin_api_abc\nSECRETTAIL"],
    ["a euro sign", "Bearer abc\u20acSECRETTAIL"],
    ["a zero-width space", "lin_api_abc\u200bSECRETTAIL"],
    ["a tab", "lin_api_abc\tSECRETTAIL"],
    ["an empty value", ""],
  ];

  test.each(badCredentials)("%s: refused with a fixed message, and nothing is sent", async (_label, credential) => {
    let sent = 0;
    restore = mockFetch(() => {
      sent += 1;
      return { data: {} };
    });
    let message = "";
    try {
      await linearQuery("x", "{ x }", {}).then(() => linearQuery(credential, "{ x }", {}));
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe(BAD_CREDENTIAL_MESSAGE);
    expect(message).not.toContain("SECRETTAIL");
    expect(sent).toBe(1); // only the good first call went out
  });

  test("the message says what to check, and fits a narrow pane's wrapping", () => {
    expect(BAD_CREDENTIAL_MESSAGE).toContain("LINEAR_API_KEY");
    expect(BAD_CREDENTIAL_MESSAGE).toContain("saved key");
  });

  test("the credential every real call uses is accepted: a Bearer login and a plain API key", async () => {
    restore = mockFetch(() => ({ data: { ok: true } }));
    expect(await linearQuery("Bearer abc.def_ghi-123~+/=", "{ x }", {})).toEqual({ ok: true });
    expect(await linearQuery("lin_api_0123456789abcdef", "{ x }", {})).toEqual({ ok: true });
  });

  test("a fetch that throws an error quoting the header (like Bun's) gives a fixed message", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("Header '14' has invalid value: 'Bearer abc SECRETTAIL'");
    }) as unknown as typeof fetch;
    try {
      const message = await linearQuery("lin_api_ok", "{ x }", {}).then(
        () => "",
        (error: Error) => error.message,
      );
      expect(message).toBe("Couldn't reach Linear. Check your connection and try again.");
      expect(message).not.toContain("SECRETTAIL");
      expect(message).not.toContain("Header");
    } finally {
      globalThis.fetch = original;
    }
  });

  test("no network gives the same fixed message", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    try {
      await expect(linearQuery("lin_api_ok", "{ x }", {})).rejects.toThrow("Couldn't reach Linear");
    } finally {
      globalThis.fetch = original;
    }
  });

  test("a REAL fetch given a bad header really does quote it (so the guard above is needed, not decoration)", async () => {
    // Aimed at a closed local port: the header is rejected before anything is sent. (Bun throws this
    // SYNCHRONOUSLY from the fetch call itself, not as a rejected promise.)
    let message = "";
    try {
      await fetch("http://127.0.0.1:9/", { method: "POST", headers: { Authorization: "Bearer abc\nSECRETTAIL" } });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("SECRETTAIL");
  });
});

// ---------------------------------------------------------------------------
describe("getApiKey", () => {
  let spawn: ReturnType<typeof spyOn<typeof Bun, "spawn">>;
  afterEach(() => spawn?.mockRestore());
  const keychain = (exitCode: number, stdout = "") => {
    spawn = spyOn(Bun, "spawn").mockImplementation((() => ({
      stdout: new Response(stdout).body,
      stderr: new Response("").body,
      exited: Promise.resolve(exitCode),
    })) as never);
  };

  test("returns the saved key", async () => {
    keychain(0, "lin_api_saved\n");
    expect(await getApiKey()).toBe("lin_api_saved");
  });

  test("looks the key up under its own Keychain item name", async () => {
    keychain(0, "k");
    await getApiKey();
    expect(spawn.mock.calls[0]?.[0]).toEqual(["security", "find-generic-password", "-s", API_KEY_ITEM, "-w"]);
    expect(API_KEY_ITEM).toBe("linear-api-key");
  });

  test("no such item (exit 44) is null: there is simply no saved key", async () => {
    keychain(44);
    expect(await getApiKey()).toBeNull();
  });

  test("an empty key is null too", async () => {
    keychain(0, "\n");
    expect(await getApiKey()).toBeNull();
  });

  test.each([36, 51, 1, 128])("a Keychain that can't be read (exit %d) is an ERROR, never 'no key'", async (code) => {
    keychain(code);
    await expect(getApiKey()).rejects.toThrow("Couldn't read the saved API key");
  });
});

// ---------------------------------------------------------------------------
describe("fetchIssues", () => {
  const page = (nodes: unknown[], hasNextPage = false, endCursor: string | null = null) => ({
    data: { viewer: { assignedIssues: { pageInfo: { hasNextPage, endCursor }, nodes } } },
  });

  test("follows pagination until the last page", async () => {
    const cursorsSeen: unknown[] = [];
    restore = mockFetch((request) => {
      cursorsSeen.push(request.variables.after);
      return request.variables.after === null
        ? page([makeIssue({ identifier: "PD-1" })], true, "cursor-1")
        : page([makeIssue({ identifier: "PD-2" })]);
    });
    const issues = await fetchIssues("k");
    expect(issues.map((i) => i.identifier)).toEqual(["PD-1", "PD-2"]);
    expect(cursorsSeen).toEqual([null, "cursor-1"]);
  });

  test("an empty result is an empty list", async () => {
    restore = mockFetch(() => page([]));
    expect(await fetchIssues("k")).toEqual([]);
  });

  test("cleans every network-supplied string at the boundary", async () => {
    const hostile = makeIssue({
      identifier: `PD-1${ESC}[31m`,
      title: `Fix ${ESC}]0;PWNED${BEL}it ${ESC}[2J\nnow ‮evil`,
      url: `https://linear.app/x${ESC}[0m`,
      state: { name: `Todo${ESC}[8m`, type: "unstarted", position: 1, color: `red${ESC}[2J` },
      labels: { nodes: [{ name: `Bug${ESC}]0;x${BEL}`, color: "javascript:alert(1)" }] },
      team: { key: `PD${ESC}`, issueEstimationType: "tShirt" },
      cycle: { number: 1, endsAt: "2026-11-23T05:00:00.000Z", team: { key: `PD${ESC}` } },
    });
    restore = mockFetch(() => page([hostile]));
    const [issue] = await fetchIssues("k");
    expect(issue).toBeDefined();
    const everyString: string[] = [];
    const walk = (value: unknown): void => {
      if (typeof value === "string") everyString.push(value);
      else if (value && typeof value === "object") Object.values(value).forEach(walk);
    };
    walk(issue);
    expect(everyString.filter(hasControlChars)).toEqual([]);
  });

  test("replaces anything that isn't a #rrggbb color with a neutral gray", async () => {
    const odd = makeIssue({
      state: { name: "Todo", type: "unstarted", position: 1, color: "red" },
      labels: { nodes: [{ name: "ok", color: "#4cb782" }, { name: "bad", color: "javascript:alert(1)" }] },
    });
    restore = mockFetch(() => page([odd]));
    const [issue] = await fetchIssues("k");
    expect(issue?.state.color).toBe("#8a8f98");
    expect(issue?.labels.nodes.map((l) => l.color)).toEqual(["#4cb782", "#8a8f98"]);
  });

  test("passes errors through", async () => {
    restore = mockFetch(() => new Response("", { status: 401 }));
    await expect(fetchIssues("k")).rejects.toThrow("HTTP 401");
  });
});

// ---------------------------------------------------------------------------
describe("groupIssues", () => {
  const status = (name: string, type: string, position = 1) => ({ name, type, position, color: "#fff" });

  test("orders groups: started, unstarted, backlog, completed, canceled", () => {
    const groups = groupIssues([
      makeIssue({ identifier: "PD-1", state: status("Canceled", "canceled") }),
      makeIssue({ identifier: "PD-2", state: status("Done", "completed") }),
      makeIssue({ identifier: "PD-3", state: status("Todo", "unstarted") }),
      makeIssue({ identifier: "PD-4", state: status("In Review", "started") }),
      makeIssue({ identifier: "PD-5", state: status("Backlog", "backlog") }),
    ]);
    expect(groups.map((g) => g.name)).toEqual(["In Review", "Todo", "Backlog", "Done", "Canceled"]);
  });

  test("within one type, uses Linear's own position order", () => {
    const groups = groupIssues([
      makeIssue({ identifier: "PD-1", state: status("Done", "completed", 2) }),
      makeIssue({ identifier: "PD-2", state: status("Ready to Release", "completed", 1) }),
    ]);
    expect(groups.map((g) => g.name)).toEqual(["Ready to Release", "Done"]);
  });

  test("an unrecognised status type sorts last instead of crashing", () => {
    const groups = groupIssues([
      makeIssue({ identifier: "PD-1", state: status("Weird", "mystery") }),
      makeIssue({ identifier: "PD-2", state: status("Canceled", "canceled") }),
    ]);
    expect(groups.map((g) => g.name)).toEqual(["Canceled", "Weird"]);
  });

  test("a Duplicate status (its own type in this workspace) sorts after Canceled", () => {
    const groups = groupIssues([
      makeIssue({ identifier: "PD-1", state: status("Duplicate", "duplicate") }),
      makeIssue({ identifier: "PD-2", state: status("Canceled", "canceled") }),
      makeIssue({ identifier: "PD-3", state: status("Done", "completed") }),
    ]);
    expect(groups.map((g) => g.name)).toEqual(["Done", "Canceled", "Duplicate"]);
  });

  test("merges issues with the same status name into one group", () => {
    const groups = groupIssues([makeIssue({ identifier: "PD-1" }), makeIssue({ identifier: "UC-2" })]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.issues).toHaveLength(2);
  });

  test("sorts issues by priority, with 'no priority' last", () => {
    const [group] = groupIssues([
      makeIssue({ identifier: "PD-1", priority: 0 }),
      makeIssue({ identifier: "PD-2", priority: 4 }),
      makeIssue({ identifier: "PD-3", priority: 1 }),
      makeIssue({ identifier: "PD-4", priority: 2 }),
    ]);
    expect(group?.issues.map((i) => i.identifier)).toEqual(["PD-3", "PD-4", "PD-2", "PD-1"]);
  });

  test("breaks priority ties by issue number, numerically (PD-9 before PD-10)", () => {
    const [group] = groupIssues([
      makeIssue({ identifier: "PD-10" }),
      makeIssue({ identifier: "PD-9" }),
      makeIssue({ identifier: "PD-100" }),
    ]);
    expect(group?.issues.map((i) => i.identifier)).toEqual(["PD-9", "PD-10", "PD-100"]);
  });

  test("no issues, no groups", () => {
    expect(groupIssues([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe("cycleProgress", () => {
  const done = { name: "Done", type: "completed", position: 1, color: "#fff" };
  const canceled = { name: "Canceled", type: "canceled", position: 1, color: "#fff" };

  test("counts completed over total, leaving canceled out of the total", () => {
    const [cycle] = cycleProgress([
      makeIssue({ identifier: "PD-1", state: done }),
      makeIssue({ identifier: "PD-2", state: done }),
      makeIssue({ identifier: "PD-3" }),
      makeIssue({ identifier: "PD-4", state: canceled }),
    ]);
    expect(cycle).toMatchObject({ label: "PD #1", done: 2, total: 3, percent: 67 });
  });

  test("a cycle with only canceled issues is 0%, not NaN", () => {
    const [cycle] = cycleProgress([makeIssue({ state: canceled })]);
    expect(cycle).toMatchObject({ total: 0, percent: 0 });
  });

  test("keeps separate cycles separate", () => {
    const uc = { number: 7, endsAt: "2026-12-01T05:00:00.000Z", team: { key: "UC" } };
    const cycles = cycleProgress([makeIssue(), makeIssue({ identifier: "UC-1", cycle: uc })]);
    expect(cycles.map((c) => c.label)).toEqual(["PD #1", "UC #7"]);
    expect(cycles[1]?.endsAt).toBe("2026-12-01T05:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------
describe("daysLeft", () => {
  // The clock is set to local noon on Nov 9 2026, and cycle ends are built in
  // local time too, so these hold in any timezone.
  const NOW = new Date(2026, 10, 9, 12, 0, 0);
  const endsInDays = (days: number) => new Date(2026, 10, 9 + days, 5, 0, 0).toISOString();

  test.each([
    [-1, "ended"],
    [0, "ends today"],
    [1, "ends tomorrow"],
    [2, "2 days left"],
    [14, "14 days left"],
  ])("%d day(s) away -> %s", (days, expected) => {
    setSystemTime(NOW);
    expect(daysLeft(endsInDays(days))).toBe(expected);
  });

  test("the wording doesn't change over the course of a day", () => {
    const ends = endsInDays(1);
    setSystemTime(new Date(2026, 10, 9, 0, 1));
    const morning = daysLeft(ends);
    setSystemTime(new Date(2026, 10, 9, 23, 59));
    expect(daysLeft(ends)).toBe(morning);
  });
});

// ---------------------------------------------------------------------------
describe("formatEstimate", () => {
  test("T-shirt teams show sizes", () => {
    const size = (estimate: number | null) => formatEstimate(makeIssue({ estimate }));
    expect([1, 2, 3, 5, 8, 13, 21].map(size)).toEqual(["XS", "S", "M", "L", "XL", "XXL", "XXXL"]);
  });

  test("no estimate (null or 0) is blank", () => {
    expect(formatEstimate(makeIssue({ estimate: null }))).toBe("");
    expect(formatEstimate(makeIssue({ estimate: 0 }))).toBe("");
  });

  test("an unknown T-shirt value falls back to the number", () => {
    expect(formatEstimate(makeIssue({ estimate: 4 }))).toBe("4");
  });

  test("teams on another scale show plain numbers", () => {
    const fib = makeIssue({ estimate: 5, team: { key: "X", issueEstimationType: "fibonacci" } });
    expect(formatEstimate(fib)).toBe("5");
  });
});

describe("formatDue", () => {
  const NOW = new Date(2026, 10, 9, 12, 0, 0);

  test("no due date, no result", () => {
    expect(formatDue(makeIssue({ dueDate: null }))).toBeNull();
  });

  test("a future date is not overdue", () => {
    setSystemTime(NOW);
    expect(formatDue(makeIssue({ dueDate: "2026-11-20" }))).toEqual({ text: "due Nov 20", overdue: false });
  });

  test("today is not overdue; yesterday is", () => {
    setSystemTime(NOW);
    expect(formatDue(makeIssue({ dueDate: "2026-11-09" }))?.overdue).toBe(false);
    expect(formatDue(makeIssue({ dueDate: "2026-11-08" }))?.overdue).toBe(true);
  });

  test("a finished issue is never overdue", () => {
    setSystemTime(NOW);
    const finished = makeIssue({
      dueDate: "2026-11-01",
      state: { name: "Done", type: "completed", position: 1, color: "#fff" },
    });
    expect(formatDue(finished)?.overdue).toBe(false);
  });

  test("a malformed date means 'no usable due date'", () => {
    expect(formatDue(makeIssue({ dueDate: "garbage" }))).toBeNull();
    expect(formatDue(makeIssue({ dueDate: "2026-11" }))).toBeNull();
    expect(formatDue(makeIssue({ dueDate: "" }))).toBeNull();
  });

  test("three parts that aren't numbers is also unusable (not 'Invalid Date')", () => {
    expect(formatDue(makeIssue({ dueDate: "a-b-c" }))).toBeNull();
    expect(formatDue(makeIssue({ dueDate: "2026-xx-09" }))).toBeNull();
  });
});

describe("small helpers", () => {
  test("isFinished is true for completed, canceled and duplicate", () => {
    expect(["completed", "canceled", "duplicate"].map(isFinished)).toEqual([true, true, true]);
    expect(["started", "unstarted", "backlog", "triage"].map(isFinished)).toEqual([false, false, false, false]);
  });

  test("Done, Canceled and Duplicate start folded; Ready to Release does not", () => {
    expect([...COLLAPSED_STATUSES].sort()).toEqual(["Canceled", "Done", "Duplicate"]);
    expect(COLLAPSED_STATUSES.has("Ready to Release")).toBe(false);
  });
});
