// src/app.tsx
// The app: holds the state (data, selection, which groups are folded), handles
// the keyboard, scrolls the list, and lays out the screen.
//
// Pass 2, part A: selection + scrolling + folding. (Refresh and open-in-browser
// keys come in part B.)

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useWindowSize } from "ink";
import { COLLAPSED_STATUSES, cleanText, cycleProgress, fetchIssues, getApiKey, groupIssues } from "./linear.ts";
import type { Issue, StatusGroup } from "./linear.ts";
import { CycleHeader, GroupHeader, IssueRow, issueHeight } from "./components.tsx";
import { openInBrowser } from "./open.ts";

const REFRESH_MS = 60_000;
const FOOTER_HEIGHT = 3; // two lines of key hints + one status line

// ---------------------------------------------------------------------------
// The list the cursor moves through: a flat array where a status header and an
// issue are both "items". `height` is how many terminal lines the item takes,
// which the scrolling logic needs.
// ---------------------------------------------------------------------------
type Item =
  | { key: string; kind: "group"; group: StatusGroup; height: number }
  | { key: string; kind: "issue"; group: StatusGroup; issue: Issue; height: number };

function buildItems(groups: StatusGroup[], collapsed: Set<string>): Item[] {
  const items: Item[] = [];
  groups.forEach((group, index) => {
    // A header is 1 line, plus a blank line above it (except the very first).
    items.push({ key: `group:${group.name}`, kind: "group", group, height: index === 0 ? 1 : 2 });
    if (collapsed.has(group.name)) return; // folded: header only
    for (const issue of group.issues) {
      items.push({ key: `issue:${issue.identifier}`, kind: "issue", group, issue, height: issueHeight(issue) });
    }
  });
  return items;
}

export function App() {
  const { exit } = useApp();
  // Live terminal size. Ink re-renders us whenever the pane is resized.
  const { columns, rows } = useWindowSize();

  // --- State ----------------------------------------------------------------
  // `issues` is separate from `error` so a failed refresh keeps the last good
  // board on screen instead of blanking it.
  const [issues, setIssues] = useState<Issue[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [refreshing, setRefreshing] = useState(false); // a fetch is in flight
  // Which statuses are folded. Starts with Done/Canceled/Duplicate folded.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(COLLAPSED_STATUSES));
  // The selection is remembered by KEY (e.g. "issue:PD-3066"), not by position,
  // so it stays on the same issue when the list refreshes or changes.
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  // Index of the first item shown on screen. A ref (not state) because it is a
  // scrolling memory we adjust while rendering, not something that should itself
  // trigger a redraw.
  const topRef = useRef(0);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const fresh = await fetchIssues(await getApiKey());
      setIssues(fresh);
      setError(null);
      setUpdatedAt(new Date());
    } catch (err) {
      // Error text can echo back server responses, so clean it too.
      setError(cleanText(err instanceof Error ? err.message : String(err)));
    } finally {
      setRefreshing(false); // runs whether the fetch worked or failed
    }
  }, []);

  // Load once on start, then every REFRESH_MS. The returned function is cleanup:
  // it stops the timer if the app closes.
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  // --- Derived data (recomputed only when its inputs change) -----------------
  const groups = useMemo(() => (issues ? groupIssues(issues) : []), [issues]);
  const cycles = useMemo(() => (issues ? cycleProgress(issues) : []), [issues]);
  const items = useMemo(() => buildItems(groups, collapsed), [groups, collapsed]);
  // Reuse Linear's own "completed" color for the filled part of the bars.
  const doneColor = groups.find((g) => g.type === "completed")?.color ?? "#4cb782";

  // Where's the cursor? If the selected item has disappeared (its group got
  // folded, or it left the cycle), fall back to the top.
  const foundIndex = items.findIndex((item) => item.key === selectedKey);
  const selIndex = foundIndex >= 0 ? foundIndex : 0;
  const selectedItem = items[selIndex];

  // --- Layout sizes -------------------------------------------------------------
  // Pinned header = title (1) + gap (1) + one line per cycle + gap (1).
  const headerHeight = 3 + cycles.length;
  const viewHeight = Math.max(1, rows - headerHeight - FOOTER_HEIGHT);

  // --- Keyboard ---------------------------------------------------------------
  const moveTo = (index: number) => {
    const clamped = Math.max(0, Math.min(items.length - 1, index));
    setSelectedKey(items[clamped]?.key ?? null);
  };

  // Tab / Shift+Tab: jump to the next / previous status header, wrapping around.
  const jumpGroup = (direction: 1 | -1) => {
    const headers = items.flatMap((item, index) => (item.kind === "group" ? [index] : []));
    if (headers.length === 0) return;
    const target =
      direction === 1
        ? (headers.find((i) => i > selIndex) ?? headers[0])
        : (headers.findLast((i) => i < selIndex) ?? headers[headers.length - 1]);
    if (target !== undefined) moveTo(target);
  };

  // Fold or unfold the group of whatever is selected. When folding, the cursor
  // moves to that group's header so it doesn't vanish with the rows it was on.
  const setFolded = (folded: boolean) => {
    if (!selectedItem) return;
    const name = selectedItem.group.name;
    if (folded === collapsed.has(name)) return; // already in that state
    const next = new Set(collapsed);
    if (folded) next.add(name);
    else next.delete(name);
    setCollapsed(next);
    setSelectedKey(`group:${name}`);
  };

  useInput((input, key) => {
    const page = Math.max(1, Math.floor(viewHeight / 2));
    if (input === "q") exit();
    else if (key.downArrow || input === "j") moveTo(selIndex + 1);
    else if (key.upArrow || input === "k") moveTo(selIndex - 1);
    else if (key.pageDown) moveTo(selIndex + page);
    else if (key.pageUp) moveTo(selIndex - page);
    else if (input === "g" || key.home) moveTo(0);
    else if (input === "G" || key.end) moveTo(items.length - 1);
    else if (key.tab) jumpGroup(key.shift ? -1 : 1);
    else if (key.leftArrow || input === "h") setFolded(true);
    else if (key.rightArrow || input === "l") setFolded(false);
    // r = refresh now (the timer does the same thing every REFRESH_MS).
    else if (input === "r") void load();
    // o = open the selected issue in the browser (does nothing on a status header).
    else if (input === "o" && selectedItem?.kind === "issue") openInBrowser(selectedItem.issue.url);
    // Enter / space on a status header toggles its fold.
    else if ((key.return || input === " ") && selectedItem?.kind === "group") {
      setFolded(!collapsed.has(selectedItem.group.name));
    }
  });

  // --- Scrolling ------------------------------------------------------------------
  // We scroll in whole items (never half a row). Find the first visible item so
  // that the selected one fits on screen.
  const heightFrom = (from: number, to: number) => {
    let total = 0;
    for (let i = from; i <= to; i++) total += items[i]?.height ?? 0;
    return total;
  };

  let top = Math.min(topRef.current, Math.max(0, items.length - 1));
  if (selIndex < top) top = selIndex; // moved above the window: scroll up
  while (top < selIndex && heightFrom(top, selIndex) > viewHeight) top++; // below: scroll down
  // Blank space at the bottom (after folding or a resize)? Scroll back up to fill it.
  while (top > 0 && heightFrom(top - 1, items.length - 1) <= viewHeight) top--;
  topRef.current = top;

  // Take items from `top` until the view is full.
  const visible: Item[] = [];
  let used = 0;
  for (let i = top; i < items.length; i++) {
    const item = items[i];
    if (!item || (used + item.height > viewHeight && visible.length > 0)) break;
    visible.push(item);
    used += item.height;
  }
  const hasAbove = top > 0;
  const hasBelow = top + visible.length < items.length;

  const time = updatedAt?.toLocaleTimeString("en-GB") ?? "";

  return (
    // The whole screen: a column exactly as big as the terminal.
    <Box flexDirection="column" width={columns} height={rows}>
      {issues === null ? (
        <Box flexGrow={1}>
          <Text dimColor>{error ? "" : "Loading from Linear…"}</Text>
        </Box>
      ) : (
        <>
          {/* Pinned header: never scrolls. */}
          <CycleHeader cycles={cycles} doneColor={doneColor} />

          {/* The scrolling list. flexShrink={0} on every block stops flexbox from
              squashing multi-line rows when space is short. */}
          <Box flexDirection="column" flexGrow={1} overflow="hidden">
            {visible.map((item, index) =>
              item.kind === "group" ? (
                // The blank line above a header is dropped if it's first on screen.
                <Box key={item.key} flexShrink={0} marginTop={index === 0 ? 0 : item.height - 1}>
                  <GroupHeader
                    group={item.group}
                    collapsed={collapsed.has(item.group.name)}
                    selected={item.key === selectedItem?.key}
                  />
                </Box>
              ) : (
                <IssueRow
                  key={item.key}
                  issue={item.issue}
                  selected={item.key === selectedItem?.key}
                  width={columns}
                />
              ),
            )}
          </Box>
        </>
      )}

      {/* Footer: always visible. Errors show in red. */}
      <Box flexDirection="column" flexShrink={0}>
        <Text dimColor wrap="truncate-end">
          {"↑↓ move  tab group  ⏎ fold"}
        </Text>
        <Text dimColor wrap="truncate-end">
          {"o open  r refresh  q quit"}
        </Text>
        <Text wrap="truncate-end">
          {error ? <Text color="red">{`${error}  `}</Text> : null}
          <Text dimColor>
            {`${hasAbove ? "▲ " : ""}${hasBelow ? "▼ " : ""}${refreshing ? "refreshing…" : time ? `updated ${time}` : ""}`}
          </Text>
        </Text>
      </Box>
    </Box>
  );
}
