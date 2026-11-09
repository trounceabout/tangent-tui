// src/edit-views.tsx
// What the edit panel LOOKS like. Plain functions of their props: no state, no keys,
// no network (those live in edit-screen.tsx), so they're easy to test.
//
// The edit flow appears as a panel floating over whatever screen you were on (the list
// or the issue's detail). The panel itself (border, title bar, placement) is in panel.tsx.

import { Box, Text } from "ink";
import { wrapText } from "./detail.ts";
import type { EditOption } from "./edit.ts";
import type { Issue } from "./linear.ts";
import { FOOTER_HEIGHT, HEADER_HEIGHT, PanelFooter, PanelHeader } from "./panel.tsx";

// How tall each view is, from the shared panel constants (see panel.tsx).

// How many lines each view needs, given the width it will be drawn at.
export function pickerHeight(optionCount: number, maxHeight: number): number {
  const room = Math.max(1, Math.min(optionCount, maxHeight - HEADER_HEIGHT - FOOTER_HEIGHT));
  return HEADER_HEIGHT + room + FOOTER_HEIGHT;
}

const noChangeText = (field: string, to: string) => `${field} is already ${to}. Nothing to change.`;
const warningLines = (warning: string, width: number) => wrapText(warning, Math.max(10, width - 2), "⚠ ", "  ");
// The dry-run banner is wrapped by us (not left to Ink) so we know how many lines it
// takes. In a narrow panel it takes two, and a height that counted one cut the banner
// and squashed the warning above it.
const dryRunLines = (width: number) => wrapText("DRY RUN: nothing will be sent to Linear.", Math.max(10, width));

// The change normally reads on one line: "Status  Todo  →  ● In Progress". If that doesn't
// fit, it is STACKED on three lines instead, so the destination (the one thing that must
// be readable on a confirm screen) is never cut off.
const changeIsStacked = (width: number, field: string, from: string, to: string, hasColor: boolean): boolean =>
  Bun.stringWidth(`${field}  ${from}  →  ${hasColor ? "● " : ""}${to}`) > width;

export function confirmHeight(
  width: number,
  {
    field,
    from,
    to,
    toColor,
    warning,
    dryRun,
    noChange,
  }: { field: string; from: string; to: string; toColor?: string; warning: string | null; dryRun: boolean; noChange: boolean },
): number {
  let body = 1; // the blank line under the header
  if (noChange) body += wrapText(noChangeText(field, to), width).length;
  else body += changeIsStacked(width, field, from, to, toColor !== undefined) ? 3 : 1;
  if (warning && !noChange) body += 1 + warningLines(warning, width).length;
  if (dryRun) body += 1 + dryRunLines(width).length; // a blank line, then the banner
  return HEADER_HEIGHT + body + FOOTER_HEIGHT;
}

export const messageHeight = (width: number, message: string): number =>
  HEADER_HEIGHT + 1 + wrapText(message, Math.max(10, width)).length + FOOTER_HEIGHT;

// ---------------------------------------------------------------------------
// The list to choose from. Scrolls if there are more options than rows.
// ---------------------------------------------------------------------------
export function PickerView({
  title,
  issue,
  options,
  cursor,
  currentIndex,
  width,
  height,
}: {
  title: string;
  issue: Issue;
  options: EditOption[];
  cursor: number;
  currentIndex: number; // which option is the issue's current value (-1 if none)
  width: number;
  height: number;
}) {
  const room = Math.max(1, height - HEADER_HEIGHT - FOOTER_HEIGHT);
  // Show a window of `room` options that keeps the cursor in view.
  const start = Math.max(0, Math.min(options.length - room, cursor - Math.floor(room / 2)));
  const visible = options.slice(start, start + room);

  return (
    <Box flexDirection="column" height={height} width={width}>
      <PanelHeader title={title} subtitle={`${issue.identifier}  ${issue.title}`} width={width} />
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        {visible.map((option, offset) => {
          const index = start + offset;
          return (
            // The whole row is ONE Text that truncates as a unit. If the label and its
            // notes were separate boxes, a long note would wrap onto a second line, and
            // the scrolling assumes every option is exactly one line.
            <Box key={`${index}-${option.label}`} flexShrink={0} width={width}>
              <Text wrap="truncate-end">
                <Text color="cyan">{index === cursor ? "▌ " : "  "}</Text>
                {option.color ? <Text color={option.color}>{"● "}</Text> : null}
                <Text bold={index === cursor}>{option.label}</Text>
                {index === currentIndex ? <Text dimColor>{"  (current)"}</Text> : null}
                {option.finished ? <Text dimColor>{"  finishes the work"}</Text> : null}
              </Text>
            </Box>
          );
        })}
      </Box>
      <PanelFooter hint="↑↓ choose  enter select  esc cancel" />
    </Box>
  );
}

// ---------------------------------------------------------------------------
// The "are you sure" screen: exactly what will change, before anything is sent.
// ---------------------------------------------------------------------------
export function ConfirmView({
  title,
  issue,
  field,
  from,
  to,
  toColor,
  warning,
  dryRun,
  noChange,
  width,
  height,
}: {
  title: string;
  issue: Issue;
  field: string; // "Status", "Priority" or "Estimate"
  from: string;
  to: string;
  toColor?: string;
  warning: string | null;
  dryRun: boolean;
  noChange: boolean; // the chosen value is what the issue already has
  width: number;
  height: number;
}) {
  return (
    <Box flexDirection="column" height={height} width={width}>
      <PanelHeader title={title} subtitle={`${issue.identifier}  ${issue.title}`} width={width} />
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        <Text> </Text>
        {noChange ? (
          wrapText(noChangeText(field, to), width).map((line, index) => <Text key={index}>{line}</Text>)
        ) : changeIsStacked(width, field, from, to, toColor !== undefined) ? (
          // Too narrow for one line: field, then the old value, then the NEW value.
          <Box flexDirection="column">
            <Text dimColor wrap="truncate-end">
              {field}
            </Text>
            <Text wrap="truncate-end">{`  ${from}`}</Text>
            <Text wrap="truncate-end">
              <Text dimColor>{"→ "}</Text>
              {toColor ? <Text color={toColor}>{"● "}</Text> : null}
              <Text bold>{to}</Text>
            </Text>
          </Box>
        ) : (
          <Text wrap="truncate-end">
            <Text dimColor>{`${field}  `}</Text>
            <Text>{from}</Text>
            <Text dimColor>{"  →  "}</Text>
            {toColor ? <Text color={toColor}>{"● "}</Text> : null}
            <Text bold>{to}</Text>
          </Text>
        )}
        {warning && !noChange ? (
          <Box flexDirection="column" marginTop={1}>
            {warningLines(warning, width).map((line, index) => (
              <Text key={index} color="yellow">
                {line}
              </Text>
            ))}
          </Box>
        ) : null}
        {dryRun ? (
          <Box flexDirection="column" marginTop={1}>
            {dryRunLines(width).map((line, index) => (
              <Text key={index} color="cyan">
                {line}
              </Text>
            ))}
          </Box>
        ) : null}
      </Box>
      <PanelFooter hint={noChange ? "enter close  esc cancel" : "enter apply  esc back  q cancel"} />
    </Box>
  );
}

// ---------------------------------------------------------------------------
// A plain message: loading, saving, "not supported", or an error.
// ---------------------------------------------------------------------------
export function MessageView({
  title,
  issue,
  message,
  tone,
  hint,
  width,
  height,
}: {
  title: string;
  issue: Issue;
  message: string;
  tone: "info" | "error";
  hint: string;
  width: number;
  height: number;
}) {
  return (
    <Box flexDirection="column" height={height} width={width}>
      <PanelHeader title={title} subtitle={`${issue.identifier}  ${issue.title}`} width={width} />
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        <Text> </Text>
        {wrapText(message, Math.max(10, width)).map((line, index) => (
          <Text key={index} color={tone === "error" ? "red" : undefined}>
            {line}
          </Text>
        ))}
      </Box>
      <PanelFooter hint={hint} />
    </Box>
  );
}
