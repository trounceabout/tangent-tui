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
import { HelpScreen } from "./help-screen.tsx";
import type { EditKind } from "./edit.ts";
import { WHEEL_LINES, useMouse, useMouseApi } from "./mouse-context.ts";
import { itemAtLine, layoutItems, lineAtScreenRow } from "./list-layout.ts";
import { isDryRun } from "./mutations.ts";
import { openInBrowser } from "./open.ts";
import { loadSettings, saveSettings, toggled } from "./settings.ts";
import type { ViewSettings } from "./settings.ts";
import { ViewSettingsScreen } from "./view-screen.tsx";
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
const FOOTER_HEIGHT = 2; // one line of key hints + one status line (the rest is in the ? help)
const NO_FOLDS = new Set<string>(); // "nothing is folded", used while filtering

// ---------------------------------------------------------------------------
// The list the cursor moves through: a flat array where a status header and an
// issue are both "items". `height` is how many terminal lines the item takes,
// which the scrolling logic needs.
// ---------------------------------------------------------------------------
type Item =
  | { key: string; kind: "group"; group: StatusGroup; height: number }
  | { key: string; kind: "issue"; group: StatusGroup; issue: Issue; height: number };

function buildItems(groups: StatusGroup[], collapsed: Set<string>, showLabels: boolean): Item[] {
  const items: Item[] = [];
  groups.forEach((group, index) => {
    // A header is 1 line, plus a blank line above it (except the very first).
    items.push({ key: `group:${group.name}`, kind: "group", group, height: index === 0 ? 1 : 2 });
    if (collapsed.has(group.name)) return; // folded: header only
    for (const issue of group.issues) {
      items.push({ key: `issue:${issue.identifier}`, kind: "issue", group, issue, height: issueHeight(issue, showLabels) });
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
  // How many LINES of the list are scrolled off the top. This is independent of which
  // issue is highlighted: the mouse wheel changes it without moving the highlight, and
  // moving the highlight (keyboard, click) scrolls just enough to keep it in view.
  const [scrollTop, setScrollTop] = useState(0);
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
  // Whether the ? help panel is open over the current screen.
  const [helpOpen, setHelpOpen] = useState(false);
  // The view settings (what the list shows), read from the settings file once at start,
  // and whether their panel (v) is open over the list.
  const [viewSettings, setViewSettings] = useState<ViewSettings>(() => loadSettings());
  const [viewOpen, setViewOpen] = useState(false);
  // Why the last settings save failed, or null. Separate from `error` (which belongs to the
  // Linear fetch): a successful reload clears `error`, and must not hide a save that is still
  // failing. It clears when a later save works.
  const [settingsError, setSettingsError] = useState<string | null>(null);
  // Mouse reporting: on or off in the terminal. (While it's on the terminal can't do its
  // normal text selection, so the `m` key switches it off.)
  const mouseApi = useMouseApi();
  const [mouseOn, setMouseOn] = useState(mouseApi.enabled());

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
  // The label setting changes how tall the rows are, so it is an input here: the scroll
  // math (offsets, total lines, clicks) all follows from these heights.
  const items = useMemo(
    () => buildItems(groups, filtering ? NO_FOLDS : collapsed, viewSettings.showLabels),
    [groups, filtering, collapsed, viewSettings.showLabels],
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
  const setGroupFolded = (name: string, folded: boolean) => {
    if (folded === collapsed.has(name)) return; // already in that state
    const next = new Set(collapsed);
    if (folded) next.add(name);
    else next.delete(name);
    setCollapsed(next);
    setSelectedKey(`group:${name}`);
  };
  const setFolded = (folded: boolean) => {
    if (selectedItem) setGroupFolded(selectedItem.group.name, folded);
  };

  // m switches mouse reporting on or off.
  const toggleMouse = () => {
    mouseApi.setEnabled(!mouseApi.enabled());
    setMouseOn(mouseApi.enabled());
  };

  // Flip one view setting (from the v panel): apply it now, then remember it in the settings
  // file. A failed save is shown in the footer; the setting still applies for this session.
  const toggleViewSetting = (key: keyof ViewSettings) => {
    const next = toggled(viewSettings, key);
    setViewSettings(next);
    setSettingsError(saveSettings(next)); // null on success, so a good save clears an old message
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
    // m switches the mouse on or off (off lets the terminal select text again).
    else if (input === "m") toggleMouse();
    // / opens the search bar.
    else if (input === "/") setSearching(true);
    // ? opens the help panel (every key, on this screen).
    else if (input === "?") setHelpOpen(true);
    // v opens the View settings panel (what the list shows).
    else if (input === "v") setViewOpen(true);
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
    { isActive: detailIssue === null && !searching && editing === null && !helpOpen && !viewOpen },
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
  // The list is ONE tall column of all the items, seen through a window `viewHeight`
  // lines tall. `offsets[i]` is the line where item i starts; `totalLines` is the height
  // of the whole column.
  const { offsets, totalLines } = useMemo(() => layoutItems(items.map((item) => item.height)), [items]);
  const maxScrollTop = Math.max(0, totalLines - viewHeight);
  // Clamp: the list can get shorter (a filter, a fold) or the pane taller.
  const shownTop = Math.min(scrollTop, maxScrollTop);

  // The scroll position that shows item `index` completely, moving as little as possible
  // from `from`.
  const scrolledToShow = (index: number, from: number): number => {
    const start = offsets[index] ?? 0;
    const end = start + (items[index]?.height ?? 1);
    if (start < from) return start; // above the window: scroll up to it
    if (end > from + viewHeight) return Math.max(0, end - viewHeight); // below: scroll down just enough
    return from;
  };

  // When the HIGHLIGHT moves (a key, a click, a fold), keep it in view. This is keyed on
  // the selection alone, on purpose: the mouse wheel can scroll the highlight out of view
  // and nothing drags it back until you move the highlight again. The one other trigger is
  // the label setting: it changes the row heights, so the highlighted row could otherwise
  // end up scrolled out of view.
  useEffect(() => {
    setScrollTop((t) => scrolledToShow(selIndex, Math.min(t, maxScrollTop)));
  }, [selectedKey, viewSettings.showLabels]);
  // A new search or filter starts again at the top.
  useEffect(() => {
    setScrollTop(0);
  }, [filters]);

  // Scroll by a number of lines (negative = up) WITHOUT touching the highlight.
  const scrollBy = (lines: number) =>
    setScrollTop((t) => Math.max(0, Math.min(maxScrollTop, Math.min(t, maxScrollTop) + lines)));

  // The mouse wheel scrolls the list, three lines per notch. (When the detail screen or a
  // panel is open, it has its own handler for the wheel.)
  // A left click on an issue selects it and opens its detail; on a status header it folds
  // or unfolds the group. Clicks above or below the list (the header, the footer), and on
  // the blank line above a header, do nothing. A click leaves the search bar open or closed
  // as is, except that opening an issue closes it (the filter stays).
  const clickList = (screenY: number) => {
    const line = lineAtScreenRow(screenY, headerHeight, viewHeight, shownTop);
    if (line === null) return;
    const hit = itemAtLine(offsets, items.map((item) => item.height), line);
    const item = hit ? items[hit.index] : undefined;
    if (!hit || !item) return;
    // A header after the first has a blank line above it. That blank line is part of the
    // header's item, but it isn't the header.
    if (item.kind === "group" && item.height > 1 && hit.lineInItem < item.height - 1) return;
    cursorRef.current = hit.index;
    setSelectedKey(item.key);
    if (item.kind === "issue") {
      setSearching(false);
      setDetailIssue(item.issue);
    } else {
      setGroupFolded(item.group.name, !collapsed.has(item.group.name));
    }
  };

  // Wheel: scroll the list. Click: see clickList.
  useMouse((event) => {
    if (event.kind === "wheel") scrollBy(event.direction === "up" ? -WHEEL_LINES : WHEEL_LINES);
    else if (event.kind === "press" && event.button === "left") clickList(event.y);
  }, detailIssue === null && editing === null && !helpOpen && !viewOpen);

  const hasAbove = shownTop > 0;
  const hasBelow = shownTop < maxScrollTop;

  const time = updatedAt?.toLocaleTimeString("en-GB") ?? "";

  // The detail screen replaces the list while it's open. (The list's state, like the
  // selection and scroll position, is kept, so closing puts you right back.) It shows
  // the freshest copy of the issue from the last reload, so a change you just made
  // appears there, falling back to the copy we opened.
  const detailShown = detailIssue ? (issues?.find((i) => i.identifier === detailIssue.identifier) ?? detailIssue) : null;
  const detail = detailShown ? (
    <DetailView
      issue={detailShown}
      onClose={() => setDetailIssue(null)}
      onEdit={(kind) => setEditing({ issue: detailShown, kind })}
      onHelp={() => setHelpOpen(true)}
      inputActive={editing === null && !helpOpen}
      notice={flash}
    />
  ) : null;

  // The edit panel floats over whichever screen is showing. Cancelling just closes it.
  // After a change is applied we stay where we were, show a confirmation, and reload so
  // the board shows what Linear really has. The screen below stays mounted the whole
  // time (its keys are switched off), so it keeps its scroll position.
  const overlay = editing ? (
    <EditScreen
      issue={editing.issue}
      kind={editing.kind}
      onCancel={() => setEditing(null)}
      onDone={(message) => {
        setEditing(null);
        setFlash(message);
        void load();
      }}
    />
  ) : helpOpen ? (
    // The help panel: the same kind of overlay, listing the keys of whichever screen is showing.
    <HelpScreen kind={detailShown ? "detail" : "list"} onClose={() => setHelpOpen(false)} />
  ) : viewOpen ? (
    // The View settings panel: another overlay, over the list.
    <ViewSettingsScreen settings={viewSettings} onToggle={toggleViewSetting} onClose={() => setViewOpen(false)} />
  ) : null;

  const list = (
    // The whole list screen: a column exactly as big as the terminal.
    <Box flexDirection="column" width={columns} height={rows}>
      {issues === null ? (
        <Box flexGrow={1}>
          <Text dimColor>{error ? "" : "Loading from Linear…"}</Text>
        </Box>
      ) : (
        <>
          {/* Pinned header: never scrolls. */}
          <CycleHeader cycles={cycles} doneColor={doneColor} />

          {/* The scrolling list: ONE tall column of every item, seen through a window. The
              window clips (overflow="hidden") and contentOffsetY slides the column up by
              the number of scrolled lines. flexShrink={0} keeps the column at its natural
              height: without it flexbox would squash it to fit and there'd be nothing to
              scroll. */}
          <Box flexDirection="column" flexGrow={1} overflow="hidden" contentOffsetY={shownTop}>
            <Box flexDirection="column" flexShrink={0}>
              {items.length === 0 ? <Text dimColor>No issues match the filters.</Text> : null}
              {items.map((item, index) =>
                item.kind === "group" ? (
                  // The blank line above every header except the first.
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
                    showLabels={viewSettings.showLabels}
                  />
                ),
              )}
            </Box>
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
            <Text dimColor>{`  ${countText}  (esc clears)`}</Text>
          </Text>
        ) : (
          // The one hint line. Every other key is in the ? help.
          <Text dimColor wrap="truncate-end">
            {"? help  ↑↓ move  ⏎ open  q quit  / find"}
          </Text>
        )}
        {searching ? (
          // While the search bar is open its own keys replace the status line.
          <Text dimColor wrap="truncate-end">
            {"enter keep  esc clear  ↑↓ move"}
          </Text>
        ) : (
          <Text wrap="truncate-end">
            {isDryRun() ? <Text color="cyan">DRY RUN  </Text> : null}
            {mouseApi.supported && !mouseOn ? <Text dimColor>mouse off  </Text> : null}
            {!viewSettings.showLabels ? <Text dimColor>labels off  </Text> : null}
            {flash ? <Text color="green">{`✓ ${flash}  `}</Text> : null}
            {error ? <Text color="red">{`${error}  `}</Text> : null}
            {settingsError ? <Text color="red">{`${settingsError}  `}</Text> : null}
            <Text dimColor>
              {`${hasAbove ? "▲ " : ""}${hasBelow ? "▼ " : ""}${refreshing ? "refreshing…" : time ? `updated ${time}` : ""}`}
            </Text>
          </Text>
        )}
      </Box>
    </Box>
  );

  // The base screen, with the edit panel (if any) drawn on top of it. The panel comes
  // AFTER the screen, so it is painted over it.
  return (
    <Box width={columns} height={rows}>
      {detail ?? list}
      {overlay}
    </Box>
  );
}
