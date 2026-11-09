// src/components.tsx
// The visual building blocks. Each one is a small function that returns a
// description of what to draw: <Box> is a frame (direction, gap, widths) and
// <Text> is a text layer (color, bold, dim...).

import { Box, Text } from "ink";
import type { CycleProgress, Issue, StatusGroup } from "./linear.ts";
import { daysLeft, formatDue, formatEstimate, isFinished } from "./linear.ts";
import { BAR_GRAY, OVERDUE_RED, URGENT_ORANGE } from "./theme.ts";

// ---------------------------------------------------------------------------
// Priority icon: always exactly 3 columns wide so titles line up.
// ---------------------------------------------------------------------------
function PriorityGlyph({ priority, muted }: { priority: number; muted: boolean }) {
  // Urgent: solid orange block with a white "!" (finished issues go plain).
  if (priority === 1) {
    return muted ? (
      <Text dimColor>{"[!]"}</Text>
    ) : (
      <Text backgroundColor={URGENT_ORANGE} color="white" bold>
        {" ! "}
      </Text>
    );
  }

  // High = 3 filled bars, Medium = 2, Low = 1, none = "---".
  const filled = priority === 2 ? 3 : priority === 3 ? 2 : priority === 4 ? 1 : 0;
  if (filled === 0) return <Text dimColor>{"---"}</Text>;

  const bars = ["▂", "▄", "▆"];
  return (
    <Text>
      <Text color={BAR_GRAY} dimColor={muted}>
        {bars.slice(0, filled).join("")}
      </Text>
      <Text color={BAR_GRAY} dimColor>
        {bars.slice(filled).join("")}
      </Text>
    </Text>
  );
}

// ---------------------------------------------------------------------------
// Work out which labels fit on the detail line, instead of relying on the
// terminal to clip them (clipping left stray fragments in other columns).
// Labels that don't fit are counted so we can show "+N".
// ---------------------------------------------------------------------------
type Label = { name: string; color: string };

function fitLabels(labels: Label[], room: number): { shown: Label[]; hidden: number } {
  // With more than one label, keep 4 columns free for a possible "+N".
  const reserve = labels.length > 1 ? 4 : 0;
  const shown: Label[] = [];
  let used = 0;

  for (const label of labels) {
    const gap = shown.length > 0 ? 2 : 0;
    const needed = gap + 2 + label.name.length; // gap + "● " + name
    if (used + needed > room - reserve) {
      // Not even the first label fits? Show a shortened version of it.
      if (shown.length === 0 && room - reserve > 5) {
        shown.push({ name: `${label.name.slice(0, room - reserve - 4)}…`, color: label.color });
      }
      break;
    }
    shown.push(label);
    used += needed;
  }
  return { shown, hidden: labels.length - shown.length };
}

// How many terminal lines an issue takes: 1 for the title row, plus 1 if it has
// a detail line (labels or a due date). The app needs this to work out scrolling,
// and it must match the condition IssueRow uses to draw the detail line.
export function issueHeight(issue: Issue): number {
  return 1 + (issue.labels.nodes.length > 0 || formatDue(issue) ? 1 : 0);
}

// ---------------------------------------------------------------------------
// One issue: a title row, plus a dim detail line (labels + due date) under it.
//
//   ▌ PD-3066  !   Design VM deployment flow and provisioning state        M
//                  ● Managed Hosting portal  ● Feature            due Nov 6
//
// `selected` draws the left marker (used once we add keyboard selection).
// `width` is the pane width, needed to decide how many labels fit.
// ---------------------------------------------------------------------------
export function IssueRow({ issue, selected, width }: { issue: Issue; selected: boolean; width: number }) {
  const muted = isFinished(issue.state.type);
  const canceled = issue.state.type === "canceled";
  const estimate = formatEstimate(issue);
  const due = formatDue(issue);
  const labels = issue.labels.nodes;

  // Room for labels = pane width, minus the 15 columns on the left, minus the
  // due date (and the 1-column gap before it) if there is one.
  const room = width - 15 - (due ? due.text.length + 1 : 0);
  const { shown, hidden } = fitLabels(labels, room);

  return (
    // flexShrink={0}: never squash this 1-2 line block when space runs short.
    <Box flexDirection="column" flexShrink={0}>
      {/* Title row. Fixed-width columns on the left, a flexible title in the
          middle, and a fixed estimate column on the right. */}
      <Box>
        {/* flexShrink={0} on the fixed columns is essential: without it a long
            title makes the row too wide and flexbox squeezes THESE columns
            too (wrapping the issue ID), instead of just truncating the title. */}
        <Box width={2} flexShrink={0}>
          <Text color="cyan">{selected ? "▌" : " "}</Text>
        </Box>
        <Box width={8} flexShrink={0}>
          <Text dimColor={muted} strikethrough={canceled} bold={selected}>
            {issue.identifier}
          </Text>
        </Box>
        <Box width={3} marginRight={2} flexShrink={0}>
          <PriorityGlyph priority={issue.priority} muted={muted} />
        </Box>
        {/* flexGrow lets the title take the leftover width; truncate-end adds
            the "…" when it doesn't fit, so it never wraps. */}
        <Box flexGrow={1} flexShrink={1}>
          <Text wrap="truncate-end" dimColor={muted} strikethrough={canceled} bold={selected}>
            {issue.title}
          </Text>
        </Box>
        <Box width={5} justifyContent="flex-end" flexShrink={0}>
          <Text dimColor={muted}>{estimate}</Text>
        </Box>
      </Box>

      {/* Detail line: only if there's something to show. 15 = the width of the
          columns to the left of the title, so it lines up underneath. */}
      {(labels.length > 0 || due) && (
        <Box paddingLeft={15}>
          {/* Labels fill the left. fitLabels already chose how many fit. */}
          <Box flexGrow={1} gap={2}>
            {shown.map((label) => (
              <Box key={label.name}>
                <Text color={label.color} dimColor={muted}>
                  {"●"}
                </Text>
                <Text dimColor wrap="truncate-end">{` ${label.name}`}</Text>
              </Box>
            ))}
            {hidden > 0 && <Text dimColor>{`+${hidden}`}</Text>}
          </Box>
          {due && (
            <Box flexShrink={0} marginLeft={1}>
              <Text color={due.overdue ? OVERDUE_RED : undefined} dimColor={!due.overdue}>
                {due.text}
              </Text>
            </Box>
          )}
        </Box>
      )}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// A status header, e.g.  ▾ ● TODO 24   (▸ when collapsed)
// The dot uses Linear's own color for that status.
// ---------------------------------------------------------------------------
export function GroupHeader({
  group,
  collapsed,
  selected,
}: {
  group: StatusGroup;
  collapsed: boolean;
  selected: boolean;
}) {
  return (
    <Box>
      <Text color="cyan">{selected ? "▌" : " "}</Text>
      <Text dimColor>{collapsed ? "▸ " : "▾ "}</Text>
      <Text color={group.color}>{"●"}</Text>
      <Text bold>{` ${group.name.toUpperCase()}`}</Text>
      <Text dimColor>{` ${group.issues.length}`}</Text>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Title + one progress line per active cycle:
//   PD #112 ███░░░░░░░  30%  14 days left
// ---------------------------------------------------------------------------
export function CycleHeader({ cycles, doneColor }: { cycles: CycleProgress[]; doneColor: string }) {
  return (
    // marginBottom: a blank line between this header and the first status group.
    <Box flexDirection="column" flexShrink={0} marginBottom={1}>
      <Text>
        <Text bold>LINEAR BOARD</Text>
        <Text dimColor> my current cycles</Text>
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {cycles.map((cycle) => {
          const filled = Math.round(cycle.percent / 10);
          return (
            <Box key={cycle.label}>
              <Box width={9} flexShrink={0}>
                <Text bold>{cycle.label}</Text>
              </Box>
              <Box flexShrink={0}>
                <Text color={doneColor}>{"█".repeat(filled)}</Text>
                <Text dimColor>{"░".repeat(10 - filled)}</Text>
              </Box>
              <Box width={5} justifyContent="flex-end" flexShrink={0}>
                <Text>{`${cycle.percent}%`}</Text>
              </Box>
              <Text dimColor>{`  ${daysLeft(cycle.endsAt)}`}</Text>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}
