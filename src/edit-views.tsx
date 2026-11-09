// src/edit-views.tsx
// What the edit screens LOOK like. Plain functions of their props: no state, no keys,
// no network (those live in edit-screen.tsx), so they're easy to test.

import { Box, Text } from "ink";
import { wrapText } from "./detail.ts";
import type { EditOption } from "./edit.ts";
import type { Issue } from "./linear.ts";

// Title, then the issue (ID + title, cut to fit), then a divider. Always 3 lines.
function EditHeader({ title, issue, width }: { title: string; issue: Issue; width: number }) {
  return (
    <Box flexDirection="column" flexShrink={0}>
      <Text bold>{title}</Text>
      <Text dimColor wrap="truncate-end">{`${issue.identifier}  ${issue.title}`}</Text>
      <Text dimColor>{"─".repeat(width)}</Text>
    </Box>
  );
}
const HEADER_HEIGHT = 3;
const FOOTER_HEIGHT = 2; // a blank line, then the key hints

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
            <Box key={`${index}-${option.label}`} flexShrink={0}>
              <Text color="cyan">{index === cursor ? "▌ " : "  "}</Text>
              {option.color ? <Text color={option.color}>{"● "}</Text> : null}
              <Text bold={index === cursor} wrap="truncate-end">
                {option.label}
              </Text>
              {index === currentIndex ? <Text dimColor>{"  (current)"}</Text> : null}
              {option.finished ? <Text dimColor>{"  finishes the work"}</Text> : null}
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
          <Text>{`${field} is already ${to}. Nothing to change.`}</Text>
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
            {wrapText(warning, Math.max(10, width - 2), "⚠ ", "  ").map((line, index) => (
              <Text key={index} color="yellow">
                {line}
              </Text>
            ))}
          </Box>
        ) : null}
        {dryRun ? (
          <Box marginTop={1}>
            <Text color="cyan">DRY RUN: nothing will be sent to Linear.</Text>
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
