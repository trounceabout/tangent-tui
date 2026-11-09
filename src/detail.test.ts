// Tests for src/detail.ts: fetching an issue's detail, ordering comments, and
// turning markdown-ish text into plain wrapped lines.

import { afterEach, describe, expect, test } from "bun:test";
import {
  buildBodyLines,
  fetchIssueDetail,
  inline,
  relativeTime,
  renderMarkdown,
  wrapText,
} from "./detail.ts";
import type { IssueDetail } from "./detail.ts";
import { BEL, ESC, hasControlChars, mockFetch } from "./testing.ts";

let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
});

const width = (text: string) => Bun.stringWidth(text);
const texts = (lines: { text: string }[]) => lines.map((l) => l.text);

// ---------------------------------------------------------------------------
describe("wrapText", () => {
  test("wraps at word boundaries", () => {
    expect(wrapText("the quick brown fox", 10)).toEqual(["the quick", "brown fox"]);
  });

  test("collapses runs of whitespace", () => {
    expect(wrapText("a    b \n c", 40)).toEqual(["a b c"]);
  });

  test("uses a different prefix for the first line and the rest (hanging indent)", () => {
    expect(wrapText("aaa bbb ccc", 9, "• ", "  ")).toEqual(["• aaa bbb", "  ccc"]);
  });

  test("chops a word that is wider than a whole line", () => {
    expect(wrapText("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
  });

  test("empty text still gives one line (so an empty bullet keeps its marker)", () => {
    expect(wrapText("", 20)).toEqual([""]);
    expect(wrapText("", 20, "☐ ", "  ")).toEqual(["☐ "]);
  });

  test("measures CJK characters as 2 columns each", () => {
    expect(wrapText("日本語日本語", 6)).toEqual(["日本語", "日本語"]);
  });

  test("no line is ever wider than the limit, for any width", () => {
    const samples = [
      "Plain ASCII text that goes on for a while and needs wrapping at several widths",
      "Emoji 🚀🚀🚀 and CJK 日本語のテキストがここにあります mixed in",
      "Superlongwordwithoutanyspacesatalljustkeepsgoingandgoingandgoingandgoing end",
      "a b c d e f g h i j k l m n o p q r s t u v w x y z",
    ];
    for (const sample of samples) {
      for (let max = 8; max <= 60; max += 4) {
        for (const line of wrapText(sample, max)) expect(width(line)).toBeLessThanOrEqual(max);
        for (const line of wrapText(sample, max, "• ", "  ")) expect(width(line)).toBeLessThanOrEqual(max);
      }
    }
  });
});

// ---------------------------------------------------------------------------
describe("renderMarkdown", () => {
  test("headings are bold, with a blank line above them", () => {
    expect(renderMarkdown("para\n# Title", 40)).toEqual([
      { text: "para" },
      { text: "" },
      { text: "Title", bold: true },
    ]);
  });

  test("bullets, nested bullets and numbered lists", () => {
    const lines = texts(renderMarkdown("- one\n  - sub\n1. first\n2) second", 40));
    expect(lines).toEqual(["• one", "  • sub", "1. first", "2) second"]);
  });

  test("task lists become boxes", () => {
    expect(texts(renderMarkdown("- [ ] open\n- [x] done\n- [X] also done", 40))).toEqual([
      "☐ open",
      "☑ done",
      "☑ also done",
    ]);
  });

  test("a wrapped bullet lines its continuation up under the text", () => {
    expect(texts(renderMarkdown("- aaa bbb ccc ddd", 10))).toEqual(["• aaa bbb", "  ccc ddd"]);
  });

  test("quotes get a bar and are dim", () => {
    expect(renderMarkdown("> a remark", 40)).toEqual([{ text: "│ a remark", dim: true }]);
  });

  test("code is dim, keeps its indentation, and the fences are not shown", () => {
    const lines = renderMarkdown("before\n```\n  indented();\n```\nafter", 40);
    expect(lines).toEqual([
      { text: "before" },
      { text: "    indented();", dim: true },
      { text: "after" },
    ]);
  });

  test("images become [image: alt], links keep only their text, bold markers go", () => {
    const [line] = renderMarkdown("See [the docs](https://x.example/a) ![diagram](https://x/y.png) **now** and ![](a.png)", 100);
    expect(line?.text).toBe("See the docs [image: diagram] now and [image]");
  });

  test("collapses repeated blank lines and trims the ends", () => {
    expect(texts(renderMarkdown("\n\na\n\n\n\nb\n\n", 40))).toEqual(["a", "", "b"]);
  });

  test("no rendered line is wider than the limit", () => {
    const nasty = [
      "# A heading that is quite long and must wrap around",
      "Plain with [a link](https://example.com) and **bold** and ![img](x.png)",
      "- [ ] a task that is long enough to wrap onto the next line",
      "> a quoted remark that also needs wrapping around the edge",
      "```",
      "const veryLongCodeLine = someFunction(argumentNumberOne, argumentNumberTwo);",
      "```",
      "Superlongwordwithoutanyspacesatalljustkeepsgoingandgoingandgoing",
      "Emoji 🚀🚀🚀 and CJK 日本語のテキストがここにあります",
    ].join("\n");
    for (const max of [20, 30, 47, 80]) {
      for (const line of renderMarkdown(nasty, max)) expect(width(line.text)).toBeLessThanOrEqual(max);
    }
  });

  test("text past the size limit is cut and says so", () => {
    const lines = renderMarkdown("x".repeat(30), 100, 10);
    expect(lines[0]?.text).toBe("x".repeat(10));
    expect(lines.at(-1)).toEqual({ text: "… text truncated (press o for the full text)", dim: true });
  });

  test("a single enormous line is capped too", () => {
    const lines = renderMarkdown("a".repeat(5_000), 40);
    expect(lines.length).toBeLessThan(60); // 2,000 chars at 40 per line is about 51
  });
});

// ---------------------------------------------------------------------------
// SECURITY: these guard the fix for a real problem. With open-ended regex
// quantifiers, 100 KB of unclosed "![" or "[" took about 3.5 SECONDS and the cost
// grew with the square of the size. The limits below are generous (a slow machine
// is fine) but far below the old behaviour.
describe("renderMarkdown stays fast on hostile input", () => {
  const MAX_MS = 500;
  const cases: [string, (n: number) => string][] = [
    ["unclosed image openers", (n) => "![".repeat(n / 2)],
    ["unclosed link openers", (n) => "[".repeat(n)],
    ["unclosed bold markers", (n) => "**".repeat(n / 2)],
    ["one enormous word", (n) => "a".repeat(n)],
    ["a long run of spaces then text", (n) => `${" ".repeat(n)}x`],
    ["many short lines", (n) => "- item\n".repeat(n / 7)],
  ];

  for (const size of [100_000, 1_000_000]) {
    for (const [name, make] of cases) {
      test(`${name} (${size.toLocaleString()} chars)`, () => {
        const text = make(size);
        const start = performance.now();
        renderMarkdown(text, 40);
        expect(performance.now() - start).toBeLessThan(MAX_MS);
      });
    }
  }
});

// renderMarkdown also cuts every line to 2,000 characters BEFORE these regexes run,
// so the tests above can't tell whether the regexes themselves are safe. This calls
// inline() directly with the full hostile input, so each protection is tested alone.
describe("inline() is linear on its own (without the line cap's help)", () => {
  test.each([
    ["![", 50_000],
    ["[", 100_000],
    ["**", 50_000],
    ["__", 50_000],
    ["[a](", 25_000],
  ])("%s repeated %d times", (unit, count) => {
    const start = performance.now();
    inline(unit.repeat(count));
    expect(performance.now() - start).toBeLessThan(500);
  });

  test("still converts images, links and bold correctly", () => {
    expect(inline("![alt](a.png) [text](https://x) **bold** __also__")).toBe("[image: alt] text bold also");
  });
});

// ---------------------------------------------------------------------------
describe("relativeTime", () => {
  const NOW = new Date("2026-11-09T12:00:00Z");
  test.each([
    ["2026-11-09T11:59:40Z", "just now"],
    ["2026-11-09T11:55:00Z", "5m ago"],
    ["2026-11-09T09:00:00Z", "3h ago"],
    ["2026-11-06T12:00:00Z", "3d ago"],
    ["2026-10-20T12:00:00Z", "2w ago"],
    ["2025-01-02T12:00:00Z", "Jan 2, 2025"],
  ])("%s -> %s", (iso, expected) => {
    expect(relativeTime(iso, NOW)).toBe(expected);
  });

  test("an unparseable date gives an empty string", () => {
    expect(relativeTime("garbage", NOW)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// A reply to the Linear API shaped like the real one.
type RawComment = {
  id: string;
  body: string;
  createdAt: string;
  user: { name: string; displayName: string } | null;
  botActor: { name: string | null } | null;
  parent: { id: string } | null;
};
const comment = (id: string, createdAt: string, parent: string | null, extra: Partial<RawComment> = {}): RawComment => ({
  id,
  body: `body ${id}`,
  createdAt,
  user: { name: id, displayName: id },
  botActor: null,
  parent: parent ? { id: parent } : null,
  ...extra,
});
const issueReply = (comments: RawComment[], extra: Record<string, unknown> = {}, hasNextPage = false) => ({
  data: {
    issue: {
      description: "desc",
      createdAt: "2026-11-01T00:00:00Z",
      updatedAt: "2026-11-02T00:00:00Z",
      assignee: null,
      project: null,
      comments: { pageInfo: { hasNextPage }, nodes: comments },
      ...extra,
    },
  },
});

describe("fetchIssueDetail", () => {
  test("maps the fields, preferring the display name", async () => {
    restore = mockFetch(() =>
      issueReply([], {
        assignee: { name: "Ada Example", displayName: "ada" },
        project: { name: "Example Project" },
      }),
    );
    const detail = await fetchIssueDetail("k", "PD-1");
    expect(detail).toMatchObject({ description: "desc", assignee: "ada", project: "Example Project", moreComments: false });
  });

  test("asks for the right issue and the comment limit", async () => {
    let variables: Record<string, unknown> = {};
    restore = mockFetch((request) => {
      variables = request.variables;
      return issueReply([]);
    });
    await fetchIssueDetail("k", "PD-3066");
    expect(variables).toEqual({ id: "PD-3066", first: 50 });
  });

  test("a missing description is an empty string, a missing assignee is null", async () => {
    restore = mockFetch(() => issueReply([], { description: null }));
    const detail = await fetchIssueDetail("k", "PD-1");
    expect(detail.description).toBe("");
    expect(detail.assignee).toBeNull();
    expect(detail.project).toBeNull();
  });

  test("throws a clear error when the issue doesn't exist", async () => {
    restore = mockFetch(() => ({ data: { issue: null } }));
    await expect(fetchIssueDetail("k", "PD-999")).rejects.toThrow("PD-999 was not found");
  });

  test("orders comments as threads: oldest first, replies under their parent", async () => {
    // Linear sends them newest-first and flat. This mix has two threads and a reply
    // that arrives before its parent.
    restore = mockFetch(() =>
      issueReply([
        comment("r2", "2026-11-05T00:00:00Z", "a"),
        comment("b", "2026-11-04T00:00:00Z", null),
        comment("r1", "2026-11-02T12:00:00Z", "a"),
        comment("a", "2026-11-02T00:00:00Z", null),
      ]),
    );
    const { comments } = await fetchIssueDetail("k", "PD-1");
    expect(comments.map((c) => c.author)).toEqual(["a", "r1", "r2", "b"]);
    expect(comments.map((c) => c.isReply)).toEqual([false, true, true, false]);
  });

  test("keeps a reply whose parent wasn't fetched instead of dropping it", async () => {
    restore = mockFetch(() =>
      issueReply([comment("a", "2026-11-02T00:00:00Z", null), comment("orphan", "2026-11-03T00:00:00Z", "NOT-FETCHED")]),
    );
    const { comments } = await fetchIssueDetail("k", "PD-1");
    expect(comments.map((c) => c.author)).toEqual(["a", "orphan"]);
  });

  test("author falls back: display name, then name, then bot name, then 'Unknown'", async () => {
    restore = mockFetch(() =>
      issueReply([
        comment("1", "2026-11-01T00:00:00Z", null, { user: { name: "Real Name", displayName: "" } }),
        comment("2", "2026-11-02T00:00:00Z", null, { user: null, botActor: { name: "Robo" } }),
        comment("3", "2026-11-03T00:00:00Z", null, { user: null, botActor: null }),
      ]),
    );
    const { comments } = await fetchIssueDetail("k", "PD-1");
    expect(comments.map((c) => c.author)).toEqual(["Real Name", "Robo", "Unknown"]);
  });

  test("reports when there are more comments than were fetched", async () => {
    restore = mockFetch(() => issueReply([comment("a", "2026-11-02T00:00:00Z", null)], {}, true));
    expect((await fetchIssueDetail("k", "PD-1")).moreComments).toBe(true);
  });

  test("cleans hostile text in the description, authors and comments", async () => {
    restore = mockFetch(() =>
      issueReply(
        [
          comment("a", "2026-11-02T00:00:00Z", null, {
            body: `bot says ${ESC}[1mBOLD${ESC}[0m ${ESC}]52;c;aGk=${BEL}`,
            user: null,
            botActor: { name: `Robo${ESC}[31m` },
          }),
        ],
        { description: `Hello ${ESC}]0;PWNED${BEL} ${ESC}[2J world\r\nline two ‮evil` },
      ),
    );
    const detail = await fetchIssueDetail("k", "PD-1");
    const everything = JSON.stringify(detail) + buildBodyLines(detail, 40).map((l) => l.text).join("\n");
    expect(hasControlChars(detail.description.replaceAll("\n", ""))).toBe(false);
    expect(detail.description).toContain("line two"); // newline kept
    expect(hasControlChars(everything.replaceAll("\n", ""))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("buildBodyLines", () => {
  const detail = (extra: Partial<IssueDetail> = {}): IssueDetail => ({
    description: "The description.",
    assignee: null,
    project: null,
    createdAt: "2026-11-01T00:00:00Z",
    updatedAt: "2026-11-02T00:00:00Z",
    comments: [],
    moreComments: false,
    ...extra,
  });

  test("has a description section and a comments section", () => {
    const lines = texts(buildBodyLines(detail(), 40));
    expect(lines).toEqual(["DESCRIPTION", "The description.", "", "COMMENTS (0)", "No comments."]);
  });

  test("says so when there is no description", () => {
    expect(texts(buildBodyLines(detail({ description: "" }), 40))[1]).toBe("No description.");
  });

  test("indents top-level comments by 2 and replies by 4, and marks replies with ↳", () => {
    const lines = texts(
      buildBodyLines(
        detail({
          comments: [
            { author: "ann", createdAt: "2026-11-02T00:00:00Z", body: "first", isReply: false },
            { author: "bob", createdAt: "2026-11-02T01:00:00Z", body: "second", isReply: true },
          ],
        }),
        40,
      ),
    );
    expect(lines).toContain("  first");
    expect(lines).toContain("    second");
    expect(lines.find((l) => l.startsWith("ann"))).toBeDefined();
    expect(lines.find((l) => l.startsWith("↳ bob"))).toBeDefined();
    expect(lines).toContain("COMMENTS (2)");
  });

  test("when older comments weren't fetched, the count gets a + and a note follows the heading", () => {
    const lines = texts(
      buildBodyLines(
        detail({
          moreComments: true,
          comments: [{ author: "ann", createdAt: "2026-11-02T00:00:00Z", body: "hi", isReply: false }],
        }),
        40,
      ),
    );
    const heading = lines.indexOf("COMMENTS (1+)");
    expect(heading).toBeGreaterThan(-1);
    expect(lines[heading + 1]).toBe("… older comments not shown (press o)");
  });

  test("no line is wider than the limit", () => {
    const long = "word ".repeat(80);
    const lines = buildBodyLines(
      detail({
        description: long,
        comments: [{ author: "ann", createdAt: "2026-11-02T00:00:00Z", body: long, isReply: true }],
      }),
      30,
    );
    for (const line of lines) expect(width(line.text)).toBeLessThanOrEqual(30);
  });
});
