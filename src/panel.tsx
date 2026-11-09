// src/panel.tsx
// The floating panel shared by the edit flow and the help screen: where it goes, how
// it's drawn, and its header and footer. Plain functions of their props.
//
// A panel appears over whatever screen you were on (the list or an issue's detail). A
// terminal has no layers, so the panel is an absolutely-positioned box drawn after (on
// top of) the screen below, with a fill of spaces behind its content so the screen
// underneath doesn't show through.

import type { ReactNode } from "react";
import { Box, Text } from "ink";
import { PANEL_ACCENT } from "./theme.ts";

// ---------------------------------------------------------------------------
// Sizes. Every view drawn inside a panel fills EXACTLY the height its helper returns,
// and tests check that, because the panel's border and fill are sized from these numbers.
// ---------------------------------------------------------------------------
export const HEADER_HEIGHT = 3; // title bar, subtitle, divider
export const FOOTER_HEIGHT = 2; // a blank line, then the key hints

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

// Is the screen cell (x, y) (0-based, as mouse events give them) inside the panel?
export const insidePanel = (g: PanelGeometry, x: number, y: number): boolean =>
  x >= g.left && x < g.left + g.width && y >= g.top && y < g.top + g.height;

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

// A colored title bar, then a subtitle (cut to fit), then a divider. Always 3 lines. The
// bar runs edge to edge: a negative margin cancels the panel's side padding.
export function PanelHeader({ title, subtitle, width }: { title: string; subtitle: string; width: number }) {
  return (
    <Box flexDirection="column" flexShrink={0}>
      <Box marginX={-1} width={width + 2}>
        <Text backgroundColor={PANEL_ACCENT} color="#ffffff" bold wrap="truncate-end">
          {` ${title}`.padEnd(width + 2)}
        </Text>
      </Box>
      <Text dimColor wrap="truncate-end">
        {subtitle}
      </Text>
      <Text dimColor>{"─".repeat(width)}</Text>
    </Box>
  );
}

// A blank line, then the key hints. Always 2 lines.
export function PanelFooter({ hint }: { hint: string }) {
  return (
    <Box flexDirection="column" flexShrink={0}>
      <Text> </Text>
      <Text dimColor wrap="truncate-end">
        {hint}
      </Text>
    </Box>
  );
}
