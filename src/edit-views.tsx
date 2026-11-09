// src/edit-views.tsx
// What the edit panel LOOKS like. Plain functions of their props: no state, no keys,
// no network (those live in edit-screen.tsx), so they're easy to test.
//
// The edit flow appears as a bordered panel floating over whatever screen you were
// on (the list or the issue's detail). A terminal has no layers, so the panel is an
// absolutely-positioned box drawn after (on top of) the screen below, with a fill of
// spaces behind its content so the screen underneath doesn't show through.

import type { ReactNode } from "react";
import { Box, Text } from "ink";
import { wrapText } from "./detail.ts";
import type { EditOption } from "./edit.ts";
import type { Issue } from "./linear.ts";
import { PANEL_ACCENT } from "./theme.ts";

// ---------------------------------------------------------------------------
// Sizes. Every view below draws EXACTLY the height its helper returns, and a test
// checks that, because the panel's border and fill are sized from these numbers.
// ---------------------------------------------------------------------------
const HEADER_HEIGHT = 3; // title, issue line, divider
const FOOTER_HEIGHT = 2; // a blank line, then the key hints

const PANEL_MAX_WIDTH = 64;

export type PanelGeometry = {
  width: number; // outer width, border included
  height: number; // outer height, border included
  left: number;
  top: number;
  contentWidth: number; // room for text: outside width minus border and padding
  contentHeight: number; // room for lines: outside height minus border
};

// Below this many columns the panel takes the FULL width. A margin on a narrower
// terminal just reveals stray characters of the screen underneath (a lone "j" beside the
// panel's corner, say), which looks like a glitch. Wider than this, the panel floats
// centred and the fragments beside it are whole words.
const FULL_WIDTH_BELOW = 100;

// Place the panel. It wants `wantedContentHeight` lines but is never taller than the
// screen (minus a 1-line margin top and bottom) or wider than it.
export function panelGeometry(columns: number, rows: number, wantedContentHeight: number): PanelGeometry {
  const fullWidth = columns < FULL_WIDTH_BELOW;
  const width = fullWidth ? Math.max(1, columns) : Math.min(PANEL_MAX_WIDTH, columns - 4);
  const height = Math.min(Math.max(3, wantedContentHeight + 2), Math.max(3, rows - 2));
  return {
    width,
    height,
    left: fullWidth ? 0 : Math.max(0, Math.floor((columns - width) / 2)),
    top: Math.max(0, Math.floor((rows - height) / 2)),
    contentWidth: Math.max(10, width - 4),
    contentHeight: height - 2,
  };
}

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
// The floating panel itself: a heavy-lined border with ROUNDED corners (there is no
// such built-in style, so the characters are spelled out), in the accent color.
// ---------------------------------------------------------------------------
const PANEL_BORDER = {
  topLeft: "╭",
  top: "━",
  topRight: "╮",
  right: "┃",
  bottomRight: "╯",
  bottom: "━",
  bottomLeft: "╰",
  left: "┃",
};

export function Panel({ geometry, children }: { geometry: PanelGeometry; children: ReactNode }) {
  const { width, height, left, top } = geometry;
  // A block of spaces the size of the inside. Drawn first, so it blanks out whatever
  // the screen below put there, and the real content is drawn over it.
  const fill = Array.from({ length: height - 2 }, () => " ".repeat(width - 2)).join("\n");
  return (
    <Box
      position="absolute"
      top={top}
      left={left}
      width={width}
      height={height}
      borderStyle={PANEL_BORDER}
      borderColor={PANEL_ACCENT}
      flexDirection="column"
    >
      <Box position="absolute">
        <Text>{fill}</Text>
      </Box>
      <Box paddingX={1} flexDirection="column" width={width - 2} height={height - 2}>
        {children}
      </Box>
    </Box>
  );
}

// A colored title bar, then the issue (ID + title, cut to fit), then a divider. Always 3
// lines. The bar runs edge to edge: a negative margin cancels the panel's side padding.
function EditHeader({ title, issue, width }: { title: string; issue: Issue; width: number }) {
  return (
    <Box flexDirection="column" flexShrink={0}>
      <Box marginX={-1} width={width + 2}>
        <Text backgroundColor={PANEL_ACCENT} color="#ffffff" bold wrap="truncate-end">
          {` ${title}`.padEnd(width + 2)}
        </Text>
      </Box>
      <Text dimColor wrap="truncate-end">{`${issue.identifier}  ${issue.title}`}</Text>
      <Text dimColor>{"─".repeat(width)}</Text>
    </Box>
  );
}

function Footer({ hint }: { hint: string }) {
  return (
    <Box flexDirection="column" flexShrink={0}>
      <Text> </Text>
      <Text dimColor wrap="truncate-end">
        {hint}
      </Text>
    </Box>
  );
}

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
      <EditHeader title={title} issue={issue} width={width} />
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
      <Footer hint="↑↓ choose  enter select  esc cancel" />
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
      <EditHeader title={title} issue={issue} width={width} />
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
      <Footer hint={noChange ? "enter close  esc cancel" : "enter apply  esc back  q cancel"} />
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
      <EditHeader title={title} issue={issue} width={width} />
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        <Text> </Text>
        {wrapText(message, Math.max(10, width)).map((line, index) => (
          <Text key={index} color={tone === "error" ? "red" : undefined}>
            {line}
          </Text>
        ))}
      </Box>
      <Footer hint={hint} />
    </Box>
  );
}
