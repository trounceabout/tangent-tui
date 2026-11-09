// src/detail-view.tsx
// The detail screen: replaces the list while open. A pinned header (id, title,
// status, priority, estimate, due date, assignee, project, labels), a scrolling
// body (description + comments), and a footer. It loads its own data.

import { useEffect, useMemo, useState } from "react";
import { Box, Text, useInput, useWindowSize } from "ink";
import type { Key } from "ink";
import { expandBurst } from "./keys.ts";
import { cleanText, formatDue, formatEstimate, getApiKey, isFinished } from "./linear.ts";
import type { Issue } from "./linear.ts";
import { buildBodyLines, fetchIssueDetail, wrapText } from "./detail.ts";
import type { IssueDetail } from "./detail.ts";
import { PriorityGlyph, fitLabels } from "./components.tsx";
import { openInBrowser } from "./open.ts";
import type { EditKind } from "./edit.ts";

const PRIORITY_NAMES = ["No priority", "Urgent", "High", "Medium", "Low"];
const MAX_TITLE_LINES = 3;
const FOOTER_HEIGHT = 3; // two lines of key hints + one status line

// What we know about loading this issue's details.
type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; detail: IssueDetail };

export function DetailView({
  issue,
  onClose,
  onEdit,
}: {
  issue: Issue;
  onClose: () => void;
  onEdit: (kind: EditKind) => void; // opens the edit screen (it confirms before changing anything)
}) {
  const { columns, rows } = useWindowSize();
  const [load, setLoad] = useState<LoadState>({ status: "loading" });
  const [top, setTop] = useState(0); // index of the first visible body line

  // Fetch this issue's description + comments when the view opens. `cancelled`
  // stops a slow reply from updating the screen after we've already closed.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const detail = await fetchIssueDetail(await getApiKey(), issue.identifier);
        if (!cancelled) setLoad({ status: "ready", detail });
      } catch (err) {
        if (!cancelled) setLoad({ status: "error", message: cleanText(err instanceof Error ? err.message : String(err)) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [issue.identifier]);

  // --- Layout ---------------------------------------------------------------
  const innerWidth = Math.max(10, columns - 2); // 1 column of padding each side

  // Title wrapped to at most MAX_TITLE_LINES lines (the last gets an ellipsis).
  const titleLines = useMemo(() => {
    const wrapped = wrapText(issue.title, innerWidth);
    if (wrapped.length <= MAX_TITLE_LINES) return wrapped;
    const kept = wrapped.slice(0, MAX_TITLE_LINES);
    kept[MAX_TITLE_LINES - 1] = `${(kept[MAX_TITLE_LINES - 1] ?? "").slice(0, -1)}…`;
    return kept;
  }, [issue.title, innerWidth]);

  // Header = id line + title + 3 meta lines + divider.
  const headerHeight = 1 + titleLines.length + 3 + 1;
  const bodyHeight = Math.max(1, rows - headerHeight - FOOTER_HEIGHT);

  // The wrapped body. Recomputed only when the data or the width changes.
  const lines = useMemo(
    () => (load.status === "ready" ? buildBodyLines(load.detail, innerWidth) : []),
    [load, innerWidth],
  );
  const maxTop = Math.max(0, lines.length - bodyHeight);
  const shownTop = Math.min(top, maxTop); // clamp (e.g. after a resize)

  // --- Keys -----------------------------------------------------------------
  const scrollTo = (next: number) => setTop(Math.max(0, Math.min(maxTop, next)));
  // Relative moves use the functional form `setTop(t => ...)`, which always starts
  // from the LATEST value. Reading `shownTop` here instead would use the value from
  // the render this handler was created in, so several quick key presses (or a held
  // key) would each start from the same old position and lose steps.
  const scrollBy = (delta: number) => setTop((t) => Math.max(0, Math.min(maxTop, Math.min(t, maxTop) + delta)));
  const page = Math.max(1, bodyHeight - 1);

  const handleKey = (input: string, key: Key) => {
    if (key.escape || input === "q" || key.leftArrow || input === "h" || key.backspace) onClose();
    else if (key.downArrow || input === "j") scrollBy(1);
    else if (key.upArrow || input === "k") scrollBy(-1);
    else if (key.pageDown || input === " ") scrollBy(page);
    else if (key.pageUp || input === "b") scrollBy(-page);
    else if (input === "g" || key.home) scrollTo(0);
    else if (input === "G" || key.end) scrollTo(maxTop);
    else if (input === "o") openInBrowser(issue.url);
    // s / P / e change status / priority / estimate. Opens the edit screen only.
    else if (input === "s") onEdit("status");
    else if (input === "P") onEdit("priority");
    else if (input === "e") onEdit("estimate");
  };
  // A chunk like "jjj" counts as three presses (see keys.ts).
  useInput((input, key) => {
    for (const char of expandBurst(input)) handleKey(char, key);
  });

  // --- Header pieces ----------------------------------------------------------
  const muted = isFinished(issue.state.type);
  const estimate = formatEstimate(issue);
  const due = formatDue(issue);
  const { shown, hidden } = fitLabels(issue.labels.nodes, innerWidth);
  const detail = load.status === "ready" ? load.detail : null;
  const people = detail
    ? [detail.assignee ? `assigned to ${detail.assignee}` : "unassigned", detail.project].filter(Boolean).join("  ·  ")
    : load.status === "loading"
      ? "loading…"
      : "";

  const visible = lines.slice(shownTop, shownTop + bodyHeight);
  const hasAbove = shownTop > 0;
  const hasBelow = shownTop + bodyHeight < lines.length;

  return (
    <Box flexDirection="column" width={columns} height={rows} paddingX={1}>
      {/* ---- Pinned header: always exactly headerHeight lines ---- */}
      <Box flexDirection="column" flexShrink={0}>
        <Text wrap="truncate-end">
          <Text bold>{issue.identifier}</Text>
          <Text>{"  "}</Text>
          <Text color={issue.state.color}>{"●"}</Text>
          <Text>{` ${issue.state.name}`}</Text>
        </Text>
        {titleLines.map((line, index) => (
          <Text key={index} bold>
            {line}
          </Text>
        ))}
        <Text wrap="truncate-end">
          <PriorityGlyph priority={issue.priority} muted={muted} />
          <Text>{`  ${PRIORITY_NAMES[issue.priority] ?? ""}`}</Text>
          {estimate ? <Text dimColor>{"  ·  "}</Text> : null}
          {estimate ? <Text>{estimate}</Text> : null}
          {due ? <Text dimColor>{"  ·  "}</Text> : null}
          {due ? (
            <Text color={due.overdue ? "#eb5757" : undefined} dimColor={!due.overdue}>
              {due.text}
            </Text>
          ) : null}
        </Text>
        <Text dimColor wrap="truncate-end">
          {people === "" ? " " : people}
        </Text>
        <Text wrap="truncate-end">
          {shown.length === 0 ? " " : null}
          {shown.map((label, index) => (
            <Text key={label.name}>
              {index > 0 ? "  " : ""}
              <Text color={label.color}>{"●"}</Text>
              <Text dimColor>{` ${label.name}`}</Text>
            </Text>
          ))}
          {hidden > 0 ? <Text dimColor>{`  +${hidden}`}</Text> : null}
        </Text>
        <Text dimColor>{"─".repeat(innerWidth)}</Text>
      </Box>

      {/* ---- Scrolling body ---- */}
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        {load.status === "loading" ? <Text dimColor>Loading description and comments…</Text> : null}
        {load.status === "error" ? <Text color="red">{load.message}</Text> : null}
        {visible.map((line, index) => (
          <Box key={shownTop + index} flexShrink={0}>
            <Text bold={line.bold} dimColor={line.dim} wrap="truncate-end">
              {line.text === "" ? " " : line.text}
            </Text>
          </Box>
        ))}
      </Box>

      {/* ---- Footer ---- */}
      <Box flexDirection="column" flexShrink={0}>
        <Text dimColor wrap="truncate-end">
          {"↑↓ scroll  space page  o open  esc back"}
        </Text>
        <Text dimColor wrap="truncate-end">
          {"change: s status  P priority  e estimate"}
        </Text>
        <Text dimColor wrap="truncate-end">
          {lines.length > 0
            ? `${hasAbove ? "▲ " : ""}${hasBelow ? "▼ " : ""}lines ${shownTop + 1}–${Math.min(lines.length, shownTop + bodyHeight)} of ${lines.length}`
            : " "}
        </Text>
      </Box>
    </Box>
  );
}
