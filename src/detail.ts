// src/detail.ts
// Everything for the detail panel that isn't drawing: fetching one issue's
// description + comments, and turning markdown-ish text into plain, word-wrapped
// lines. No terminal or styling code here, only plain strings and flags.
//
// SECURITY: descriptions and comments are written by other people, so every
// string is cleaned the moment it arrives (see cleanText / cleanMultiline).

import { cleanMultiline, cleanText, linearQuery } from "./linear.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export type Comment = {
  author: string;
  createdAt: string;
  body: string;
  isReply: boolean; // a reply to another comment
};

export type IssueDetail = {
  description: string;
  assignee: string | null;
  project: string | null;
  createdAt: string;
  updatedAt: string;
  comments: Comment[];
  moreComments: boolean; // there are more than we fetched
};

// One line of the scrolling body, already wrapped to fit. Styling is just flags.
export type BodyLine = { text: string; bold?: boolean; dim?: boolean };

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------
const MAX_COMMENTS = 50;

const DETAIL_QUERY = `
  query IssueDetail($id: String!, $first: Int!) {
    issue(id: $id) {
      description
      createdAt
      updatedAt
      assignee { name displayName }
      project { name }
      comments(first: $first) {
        pageInfo { hasNextPage }
        nodes {
          id
          body
          createdAt
          user { name displayName }
          botActor { name }
          parent { id }
        }
      }
    }
  }
`;

// The shape of Linear's reply (everything optional-ish: bots have no user, etc.).
type DetailData = {
  issue: {
    description: string | null;
    createdAt: string;
    updatedAt: string;
    assignee: { name: string; displayName: string } | null;
    project: { name: string } | null;
    comments: {
      pageInfo: { hasNextPage: boolean };
      nodes: {
        id: string;
        body: string;
        createdAt: string;
        user: { name: string; displayName: string } | null;
        botActor: { name: string | null } | null;
        parent: { id: string } | null;
      }[];
    };
  } | null;
};

export async function fetchIssueDetail(apiKey: string, identifier: string): Promise<IssueDetail> {
  const data = await linearQuery<DetailData>(apiKey, DETAIL_QUERY, { id: identifier, first: MAX_COMMENTS });
  const issue = data.issue;
  if (!issue) throw new Error(`Issue ${cleanText(identifier)} was not found`);

  // Linear returns comments newest-first and flat, so replies can end up under
  // the wrong parent. Reorder like a conversation reads: oldest thread first,
  // each followed by its own replies (also oldest first). ISO dates sort correctly
  // as plain strings.
  const raw = issue.comments.nodes;
  const byTime = (a: { createdAt: string }, b: { createdAt: string }) => a.createdAt.localeCompare(b.createdAt);
  const threads = raw.filter((c) => c.parent === null).sort(byTime);
  const ordered = threads.flatMap((top) => [top, ...raw.filter((c) => c.parent?.id === top.id).sort(byTime)]);
  // A reply whose parent wasn't fetched (or a reply to a reply) must not vanish.
  const placed = new Set(ordered.map((c) => c.id));
  ordered.push(...raw.filter((c) => !placed.has(c.id)).sort(byTime));

  return {
    description: cleanMultiline(issue.description ?? ""),
    assignee: issue.assignee ? cleanText(issue.assignee.displayName || issue.assignee.name) : null,
    project: issue.project ? cleanText(issue.project.name) : null,
    createdAt: cleanText(issue.createdAt),
    updatedAt: cleanText(issue.updatedAt),
    comments: ordered.map((c) => ({
      author: cleanText(c.user?.displayName || c.user?.name || c.botActor?.name || "Unknown"),
      createdAt: cleanText(c.createdAt),
      body: cleanMultiline(c.body),
      isReply: c.parent !== null,
    })),
    moreComments: issue.comments.pageInfo.hasNextPage,
  };
}

// ---------------------------------------------------------------------------
// Word wrapping
// ---------------------------------------------------------------------------

// Width in terminal columns. Bun.stringWidth knows that CJK characters and many
// emoji take 2 columns, which a plain `.length` would get wrong.
const cols = (text: string) => Bun.stringWidth(text);

// Wrap `text` to at most `width` columns. `firstPrefix` starts the first line and
// `restPrefix` starts the rest (so a bullet's text lines up under its first line).
// Words wider than a whole line are chopped. Whitespace is collapsed.
export function wrapText(text: string, width: number, firstPrefix = "", restPrefix = ""): string[] {
  const lines: string[] = [];
  let line = firstPrefix;
  let empty = true; // no words on the current line yet
  const flush = () => {
    lines.push(line);
    line = restPrefix;
    empty = true;
  };

  for (const word of text.split(/\s+/).filter((w) => w.length > 0)) {
    let rest = word;

    // A word too wide for even a fresh line: fill the line with as much as fits.
    while (cols(rest) > Math.max(1, width - cols(restPrefix))) {
      if (!empty) flush();
      let take = "";
      for (const ch of rest) {
        if (cols(line + take + ch) > width) break;
        take += ch;
      }
      if (take === "") take = [...rest][0] ?? ""; // always make progress
      line += take;
      rest = rest.slice(take.length);
      empty = false;
      flush();
    }
    if (rest === "") continue;

    if (!empty && cols(line) + 1 + cols(rest) > width) flush();
    line += (empty ? "" : " ") + rest;
    empty = false;
  }

  if (!empty || lines.length === 0) lines.push(line);
  return lines;
}

// Split text into pieces of at most `width` columns WITHOUT touching spaces
// (used for code, where indentation matters).
function chop(text: string, width: number): string[] {
  const pieces: string[] = [];
  let piece = "";
  for (const ch of text) {
    if (piece !== "" && cols(piece + ch) > width) {
      pieces.push(piece);
      piece = "";
    }
    piece += ch;
  }
  pieces.push(piece);
  return pieces;
}

// ---------------------------------------------------------------------------
// Markdown-lite
//
// Linear descriptions are markdown. We don't try to render all of it, just make
// it readable as plain text: headings bold, lists with bullets, task lists with
// boxes, quotes with a bar, code dimmed, images and links reduced to their text.
// ---------------------------------------------------------------------------

// Inline clean-up: images -> "[image: alt]", links -> just the text, **bold** -> bold.
const inline = (text: string) =>
  text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, (_match, alt: string) => (alt ? `[image: ${alt}]` : "[image]"))
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__)(.*?)\1/g, "$2");

export function renderMarkdown(markdown: string, width: number): BodyLine[] {
  const out: BodyLine[] = [];
  let inCode = false;

  // At most one blank line in a row, and never one at the very start.
  const blank = () => {
    if (out.length > 0 && out[out.length - 1]?.text !== "") out.push({ text: "" });
  };
  const add = (lines: string[], style: Omit<BodyLine, "text"> = {}) => {
    for (const text of lines) out.push({ text, ...style });
  };

  for (const raw of markdown.split("\n")) {
    const line = raw.replace(/\s+$/, "");

    // ``` fences toggle "code mode".
    if (/^\s*(```|~~~)/.test(line)) {
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      add(chop(`  ${line}`, width), { dim: true });
      continue;
    }

    if (line.trim() === "") {
      blank();
      continue;
    }

    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    const task = /^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(line);
    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    const numbered = /^(\s*)(\d+[.)])\s+(.*)$/.exec(line);
    const quote = /^\s*>\s?(.*)$/.exec(line);

    if (heading) {
      blank();
      add(wrapText(inline(heading[1] ?? ""), width), { bold: true });
    } else if (task) {
      const indent = " ".repeat(Math.min(6, (task[1] ?? "").length));
      const box = task[2] === " " ? "☐ " : "☑ ";
      add(wrapText(inline(task[3] ?? ""), width, indent + box, `${indent}  `));
    } else if (bullet) {
      const indent = " ".repeat(Math.min(6, (bullet[1] ?? "").length));
      add(wrapText(inline(bullet[2] ?? ""), width, `${indent}• `, `${indent}  `));
    } else if (numbered) {
      const indent = " ".repeat(Math.min(6, (numbered[1] ?? "").length));
      const marker = `${numbered[2] ?? ""} `;
      add(wrapText(inline(numbered[3] ?? ""), width, indent + marker, indent + " ".repeat(marker.length)));
    } else if (quote) {
      add(wrapText(inline(quote[1] ?? ""), width, "│ ", "│ "), { dim: true });
    } else {
      add(wrapText(inline(line), width));
    }
  }

  // Trim a trailing blank line.
  while (out[out.length - 1]?.text === "") out.pop();
  return out;
}

// ---------------------------------------------------------------------------
// Relative time: "just now", "5m ago", "3h ago", "2d ago", "3w ago", else a date.
// ---------------------------------------------------------------------------
export function relativeTime(iso: string, now: Date = new Date()): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "";
  const seconds = Math.round((now.getTime() - then.getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  if (days < 35) return `${Math.floor(days / 7)}w ago`;
  return then.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

// ---------------------------------------------------------------------------
// The whole scrolling body: description, then comments.
// ---------------------------------------------------------------------------
export function buildBodyLines(detail: IssueDetail, width: number): BodyLine[] {
  const lines: BodyLine[] = [];
  const section = (title: string) => lines.push({ text: title, bold: true, dim: true });

  section("DESCRIPTION");
  const description = renderMarkdown(detail.description, width);
  if (description.length === 0) lines.push({ text: "No description.", dim: true });
  else lines.push(...description);

  lines.push({ text: "" });
  section(`COMMENTS (${detail.comments.length}${detail.moreComments ? "+" : ""})`);
  if (detail.comments.length === 0) lines.push({ text: "No comments.", dim: true });
  // We fetch the NEWEST comments, so if there are more, the missing ones are older.
  if (detail.moreComments) lines.push({ text: "… older comments not shown (press o)", dim: true });

  for (const comment of detail.comments) {
    lines.push({ text: "" });
    const when = relativeTime(comment.createdAt);
    lines.push({ text: `${comment.isReply ? "↳ " : ""}${comment.author}${when ? ` · ${when}` : ""}`, bold: true });
    // Indent the comment body (replies a little further).
    const indent = comment.isReply ? "    " : "  ";
    for (const line of renderMarkdown(comment.body, width - indent.length)) {
      lines.push({ ...line, text: line.text === "" ? "" : indent + line.text });
    }
  }

  return lines;
}
