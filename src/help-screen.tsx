// src/help-screen.tsx
// The help panel: a list of keys that floats over whatever screen you're on. It opens
// with `?` and closes with Esc (or `?` again, or q). If the list is taller than the pane
// it scrolls. The content is in help.ts; the panel itself is in panel.tsx.

import { useMemo, useState } from "react";
import { Box, Text, useInput, useWindowSize } from "ink";
import type { Key } from "ink";
import { HELP_TITLE, helpLines, helpSubtitle, keyColumnWidth } from "./help.ts";
import type { HelpKind, HelpLine } from "./help.ts";
import { expandBurst } from "./keys.ts";
import { WHEEL_LINES, useMouse } from "./mouse-context.ts";
import { FOOTER_HEIGHT, HEADER_HEIGHT, Panel, PanelFooter, PanelHeader, insidePanel, panelGeometry } from "./panel.tsx";
import { PANEL_ACCENT } from "./theme.ts";

// How tall the panel wants to be: its header and footer, plus every line, up to the room
// it has. Anything beyond that scrolls.
export function helpHeight(lineCount: number, maxHeight: number): number {
  const room = Math.max(1, Math.min(lineCount, maxHeight - HEADER_HEIGHT - FOOTER_HEIGHT));
  return HEADER_HEIGHT + room + FOOTER_HEIGHT;
}

// ---------------------------------------------------------------------------
// What it looks like: a window of `lines` starting at `top`. Every line is exactly one
// terminal line (it truncates rather than wraps), because the scrolling counts lines.
// ---------------------------------------------------------------------------
export function HelpView({
  title,
  subtitle,
  lines,
  top,
  width,
  height,
}: {
  title: string;
  subtitle: string;
  lines: HelpLine[];
  top: number; // index of the first visible line
  width: number;
  height: number;
}) {
  const room = Math.max(1, height - HEADER_HEIGHT - FOOTER_HEIGHT);
  const visible = lines.slice(top, top + room);
  const keyWidth = Math.min(keyColumnWidth(lines), Math.floor(width / 2));
  const scrolls = lines.length > room;
  const hint = `${top > 0 ? "▲ " : ""}${top + room < lines.length ? "▼ " : ""}${scrolls ? "↑↓ scroll  " : ""}esc close`;

  return (
    <Box flexDirection="column" height={height} width={width}>
      <PanelHeader title={title} subtitle={subtitle} width={width} />
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        {visible.map((line, offset) => (
          <Box key={top + offset} flexShrink={0} width={width}>
            {line.kind === "title" ? (
              <Text bold color={PANEL_ACCENT} wrap="truncate-end">
                {line.text}
              </Text>
            ) : line.kind === "entry" ? (
              <Text wrap="truncate-end">
                <Text bold>{line.keys.padEnd(keyWidth)}</Text>
                <Text dimColor>{`  ${line.description}`}</Text>
              </Text>
            ) : (
              <Text> </Text>
            )}
          </Box>
        ))}
      </Box>
      <PanelFooter hint={hint} />
    </Box>
  );
}

// ---------------------------------------------------------------------------
// The panel with its scrolling and keys.
// ---------------------------------------------------------------------------
export function HelpScreen({ kind, onClose }: { kind: HelpKind; onClose: () => void }) {
  const { columns, rows } = useWindowSize();
  const lines = useMemo(() => helpLines(kind), [kind]);
  const [top, setTop] = useState(0);

  const geometry = panelGeometry(columns, rows, helpHeight(lines.length, Math.max(3, rows - 4)));
  const room = Math.max(1, geometry.contentHeight - HEADER_HEIGHT - FOOTER_HEIGHT);
  const maxTop = Math.max(0, lines.length - room);
  const shownTop = Math.min(top, maxTop); // clamp (e.g. after a resize)

  const scrollTo = (next: number) => setTop(Math.max(0, Math.min(maxTop, next)));
  // Relative moves use the functional form, so quick key presses add up (see detail-view.tsx).
  const scrollBy = (delta: number) => setTop((t) => Math.max(0, Math.min(maxTop, Math.min(t, maxTop) + delta)));
  const page = Math.max(1, room - 1);

  const handleKey = (input: string, key: Key) => {
    if (key.escape || input === "?" || input === "q") onClose();
    else if (key.downArrow || input === "j") scrollBy(1);
    else if (key.upArrow || input === "k") scrollBy(-1);
    else if (key.pageDown || input === " ") scrollBy(page);
    else if (key.pageUp || input === "b") scrollBy(-page);
    else if (input === "g" || key.home) scrollTo(0);
    else if (input === "G" || key.end) scrollTo(maxTop);
  };
  useInput((input, key) => {
    for (const char of expandBurst(input)) handleKey(char, key);
  });
  // Wheel scrolls the help. A click outside the panel closes it, like Esc.
  useMouse((event) => {
    if (event.kind === "wheel") scrollBy(event.direction === "up" ? -WHEEL_LINES : WHEEL_LINES);
    else if (event.kind === "press" && event.button === "left" && !insidePanel(geometry, event.x, event.y)) onClose();
  });

  return (
    <Panel geometry={geometry}>
      <HelpView
        title={HELP_TITLE}
        subtitle={helpSubtitle(kind)}
        lines={lines}
        top={shownTop}
        width={geometry.contentWidth}
        height={geometry.contentHeight}
      />
    </Panel>
  );
}
