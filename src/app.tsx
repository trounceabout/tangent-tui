// src/app.tsx
// The app: holds the state (data, filters, selection, which groups are folded),
// handles the keyboard, scrolls the list, and lays out the screen. The detail
// screen (detail-view.tsx) replaces it while an issue is open.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useWindowSize } from "ink";
import type { Key } from "ink";
import { expandBurst } from "./keys.ts";
import { COLLAPSED_STATUSES, cleanText, cycleProgress, fetchIssues, getApiKey, groupIssues } from "./linear.ts";
import type { Issue, StatusGroup } from "./linear.ts";
import { CycleHeader, GroupHeader, IssueRow, issueHeight } from "./components.tsx";
import { DetailView } from "./detail-view.tsx";
import { EditScreen } from "./edit-screen.tsx";
import type { EditKind } from "./edit.ts";
import { isDryRun } from "./mutations.ts";
import { openInBrowser } from "./open.ts";
import {
  MAX_QUERY_CHARS,
  NO_FILTERS,
  describeFilters,
  filterIssues,
  isFiltering,
  nextLabel,
  nextPriority,
  nextTeam,
} from "./filter.ts";
import type { Filters } from "./filter.ts";

const REFRESH_MS = 60_000;
const FOOTER_HEIGHT = 4; // three lines of key hints + one status line
const NO_FOLDS = new Set<string>(); // "nothing is folded", used while filtering

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
  // Where the cursor is RIGHT NOW. Kept in a ref that the move functions update
  // immediately, because state isn't updated until the next render: several quick
  // key presses would otherwise all start from the same old position.
  const cursorRef = useRef(0);
  // The issue whose detail screen is open, or null when we're on the list.
  const [detailIssue, setDetailIssue] = useState<Issue | null>(null);
  // What's being filtered (the "/" search bar plus the t, p and L keys), and
  // whether the search bar is open and taking typed input.
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [searching, setSearching] = useState(false);
  // The issue and field being edited (status, priority or estimate), or null. While
  // set, the edit screen replaces everything else.
  const [editing, setEditing] = useState<{ issue: Issue; kind: EditKind } | null>(null);
  // A short confirmation after a change ("PD-3066: Todo → In Progress"), shown in
  // the footer for a few seconds.
  const [flash, setFlash] = useState<string | null>(null);

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

  // Clear the confirmation message after 8 seconds. The returned function cancels
  // the timer if a newer message arrives first.
  useEffect(() => {
    if (flash === null) return;
    const timer = setTimeout(() => setFlash(null), 8_000);
    return () => clearTimeout(timer);
  }, [flash]);

  // --- Derived data (recomputed only when its inputs change) -----------------
  const filtering = isFiltering(filters);
  // Only issues that pass the filters are listed. The cycle progress bars above the
  // list still count ALL issues: they describe the cycle, not the search.
  const shownIssues = useMemo(() => (issues ? filterIssues(issues, filters) : []), [issues, filters]);
  const groups = useMemo(() => groupIssues(shownIssues), [shownIssues]);
  const cycles = useMemo(() => (issues ? cycleProgress(issues) : []), [issues]);
  // While filtering, ignore the folds so matches inside Done/Canceled aren't hidden.
  const items = useMemo(
    () => buildItems(groups, filtering ? NO_FOLDS : collapsed),
    [groups, filtering, collapsed],
  );
  // Reuse Linear's own "completed" color for the filled part of the bars.
  const doneColor = issues?.find((i) => i.state.type === "completed")?.state.color ?? "#4cb782";
  const countText = `${shownIssues.length} of ${issues?.length ?? 0}`;

  // Where's the cursor? If the selected item has disappeared (its group got
  // folded, or it left the cycle), fall back to the top.
  const foundIndex = items.findIndex((item) => item.key === selectedKey);
  const selIndex = foundIndex >= 0 ? foundIndex : 0;
  const selectedItem = items[selIndex];
  cursorRef.current = selIndex; // re-sync with what's really selected on every render

  // --- Layout sizes -------------------------------------------------------------
  // Pinned header = title (1) + gap (1) + one line per cycle + gap (1).
  const headerHeight = 3 + cycles.length;
  const viewHeight = Math.max(1, rows - headerHeight - FOOTER_HEIGHT);

  // --- Keyboard ---------------------------------------------------------------
  const moveTo = (index: number) => {
    const clamped = Math.max(0, Math.min(items.length - 1, index));
    cursorRef.current = clamped; // update NOW so the next key press builds on this one
    setSelectedKey(items[clamped]?.key ?? null);
  };
  // Relative moves start from the ref (the latest position), not from `selIndex`.
  const moveBy = (delta: number) => moveTo(cursorRef.current + delta);

  // Tab / Shift+Tab: jump to the next / previous status header, wrapping around.
  const jumpGroup = (direction: 1 | -1) => {
    const headers = items.flatMap((item, index) => (item.kind === "group" ? [index] : []));
    if (headers.length === 0) return;
    const from = cursorRef.current;
    const target =
      direction === 1
        ? (headers.find((i) => i > from) ?? headers[0])
        : (headers.findLast((i) => i < from) ?? headers[headers.length - 1]);
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

  const handleKey = (input: string, key: Key) => {
    const page = Math.max(1, Math.floor(viewHeight / 2));
    if (input === "q") exit();
    else if (key.downArrow || input === "j") moveBy(1);
    else if (key.upArrow || input === "k") moveBy(-1);
    else if (key.pageDown) moveBy(page);
    else if (key.pageUp) moveBy(-page);
    else if (input === "g" || key.home) moveTo(0);
    else if (input === "G" || key.end) moveTo(items.length - 1);
    else if (key.tab) jumpGroup(key.shift ? -1 : 1);
    else if (key.leftArrow || input === "h") setFolded(true);
    else if (key.rightArrow || input === "l") setFolded(false);
    // / opens the search bar.
    else if (input === "/") setSearching(true);
    // t / p / L step the team, priority and label filters through their values
    // (All -> first -> second ... -> All). Functional updates, so quick presses add up.
    else if (input === "t" && issues) setFilters((f) => ({ ...f, team: nextTeam(issues, f.team) }));
    else if (input === "p") setFilters((f) => ({ ...f, minPriority: nextPriority(f.minPriority) }));
    else if (input === "L" && issues) setFilters((f) => ({ ...f, label: nextLabel(issues, f.label) }));
    // Esc clears every filter, when there are any.
    else if (key.escape && filtering) setFilters(NO_FILTERS);
    // r = refresh now (the timer does the same thing every REFRESH_MS).
    else if (input === "r") void load();
    // o = open the selected issue in the browser (does nothing on a status header).
    else if (input === "o" && selectedItem?.kind === "issue") openInBrowser(selectedItem.issue.url);
    // s / P / e change the selected issue's status / priority / estimate. This only
    // OPENS the edit screen: nothing is sent until you confirm there.
    else if (input === "s" && selectedItem?.kind === "issue") setEditing({ issue: selectedItem.issue, kind: "status" });
    else if (input === "P" && selectedItem?.kind === "issue") setEditing({ issue: selectedItem.issue, kind: "priority" });
    else if (input === "e" && selectedItem?.kind === "issue") setEditing({ issue: selectedItem.issue, kind: "estimate" });
    // Enter on an issue opens its detail screen.
    else if (key.return && selectedItem?.kind === "issue") setDetailIssue(selectedItem.issue);
    // Enter / space on a status header toggles its fold.
    else if ((key.return || input === " ") && selectedItem?.kind === "group") {
      setFolded(!collapsed.has(selectedItem.group.name));
    }
  };
  // A chunk like "jjj" counts as three presses (see keys.ts). isActive: the list
  // keys are switched OFF while the detail screen is open, so one keypress never
  // drives two screens at once.
  // The list keys are also OFF while the search bar is open (below).
  useInput(
    (input, key) => {
      for (const char of expandBurst(input)) handleKey(char, key);
    },
    { isActive: detailIssue === null && !searching && editing === null },
  );

  // While the search bar is open, typed characters go INTO the query instead of
  // acting as commands, so you can search for words containing j, k, q and so on.
  // Edits use functional updates (`f => ...`) so fast typing never loses letters.
  useInput(
    (input, key) => {
      if (key.escape) {
        // Esc clears the text and closes the bar.
        setFilters((f) => ({ ...f, query: "" }));
        setSearching(false);
      } else if (key.return) setSearching(false); // Enter keeps the filter
      else if (key.backspace || key.delete) setFilters((f) => ({ ...f, query: [...f.query].slice(0, -1).join("") }));
      else if (key.ctrl && input === "u") setFilters((f) => ({ ...f, query: "" }));
      else if (key.upArrow) moveBy(-1); // move through the results while typing
      else if (key.downArrow) moveBy(1);
      else if (input !== "" && !key.ctrl && !key.meta && !key.tab) {
        // Typed or pasted text: strip control characters and cap the total length.
        const typed = cleanText(input);
        setFilters((f) => ({ ...f, query: (f.query + typed).slice(0, MAX_QUERY_CHARS) }));
      }
    },
    { isActive: detailIssue === null && searching },
  );

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

  // The edit screen replaces everything while it's open. Cancelling returns to
  // wherever you were (the list, or the detail screen). After a change is applied we
  // go back to the list, show a confirmation, and reload so the board shows what
  // Linear really has.
  if (editing) {
    return (
      <EditScreen
        issue={editing.issue}
        kind={editing.kind}
        onCancel={() => setEditing(null)}
        onDone={(message) => {
          setEditing(null);
          setDetailIssue(null);
          setFlash(message);
          void load();
        }}
      />
    );
  }

  // The detail screen replaces the list while it's open. (The list's state, like
  // the selection and scroll position, is kept, so closing puts you right back.)
  if (detailIssue) {
    return (
      <DetailView
        issue={detailIssue}
        onClose={() => setDetailIssue(null)}
        onEdit={(kind) => setEditing({ issue: detailIssue, kind })}
      />
    );
  }

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
            {items.length === 0 ? <Text dimColor>No issues match the filters.</Text> : null}
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
        {searching ? (
          // The search bar replaces the first hint line while it's open. The query
          // is truncated from the START so the end (where you're typing) stays visible.
          <Box>
            <Text color="cyan">{"/ "}</Text>
            <Box flexShrink={1}>
              <Text wrap="truncate-start">{filters.query}</Text>
            </Box>
            <Text color="cyan">{"▏"}</Text>
            <Box flexGrow={1} />
            <Text dimColor>{countText}</Text>
          </Box>
        ) : filtering ? (
          // Filters are active but the bar is closed: summarise them.
          <Text wrap="truncate-end">
            <Text color="cyan">{"filter "}</Text>
            <Text>{describeFilters(filters)}</Text>
            <Text dimColor>{`  ${countText}`}</Text>
          </Text>
        ) : (
          <Text dimColor wrap="truncate-end">
            {"↑↓ move  tab group  ⏎ open  o web  q quit"}
          </Text>
        )}
        <Text dimColor wrap="truncate-end">
          {searching
            ? "enter keep  esc clear  ↑↓ move"
            : filtering
              ? "esc clear  / edit  t team  p prio  L label"
              : "filter: / find  t team  p prio  L label"}
        </Text>
        <Text dimColor wrap="truncate-end">
          {searching ? " " : "change: s status  P prio  e est  r reload"}
        </Text>
        <Text wrap="truncate-end">
          {isDryRun() ? <Text color="cyan">DRY RUN  </Text> : null}
          {flash ? <Text color="green">{`✓ ${flash}  `}</Text> : null}
          {error ? <Text color="red">{`${error}  `}</Text> : null}
          <Text dimColor>
            {`${hasAbove ? "▲ " : ""}${hasBelow ? "▼ " : ""}${refreshing ? "refreshing…" : time ? `updated ${time}` : ""}`}
          </Text>
        </Text>
      </Box>
    </Box>
  );
}
