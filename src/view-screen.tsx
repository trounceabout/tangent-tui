// src/view-screen.tsx
// The View settings panel: a small checklist that floats over the list. It opens with `v`.
// Space or Enter flips the highlighted option, and the change applies right away (nothing
// here is sent to Linear: these only change what the list shows). Esc, `v` or q closes.
// The options themselves are in settings.ts; the panel shell is in panel.tsx.

import { useState } from "react";
import { Box, Text, useInput, useWindowSize } from "ink";
import { expandBurst } from "./keys.ts";
import { useMouse } from "./mouse-context.ts";
import { FOOTER_HEIGHT, HEADER_HEIGHT, Panel, PanelFooter, PanelHeader, insidePanel, panelGeometry } from "./panel.tsx";
import { VIEW_OPTIONS } from "./settings.ts";
import type { ViewSettings } from "./settings.ts";
import { PANEL_ACCENT } from "./theme.ts";

// How tall the panel is: header, one line per option, footer. (A fixed number of options,
// so there is nothing to scroll.)
export const viewPanelHeight = (optionCount: number): number => HEADER_HEIGHT + optionCount + FOOTER_HEIGHT;

// ---------------------------------------------------------------------------
// What it looks like. Every option is exactly ONE line (it truncates rather than wraps),
// so the height above is always right.
// ---------------------------------------------------------------------------
export function ViewSettingsView({
  settings,
  cursor,
  width,
  height,
}: {
  settings: ViewSettings;
  cursor: number; // index of the highlighted option
  width: number;
  height: number;
}) {
  // In a pane too short for the whole panel (header + options + footer) the options would be
  // clipped away. Say so, instead of showing an empty panel that still reacts to keys.
  if (height < viewPanelHeight(VIEW_OPTIONS.length)) {
    return (
      <Box height={height} width={width}>
        <Text wrap="truncate-end">Too small: esc closes</Text>
      </Box>
    );
  }
  const hint = `${VIEW_OPTIONS.length > 1 ? "↑↓ move  " : ""}space toggle  esc close`;
  return (
    <Box flexDirection="column" height={height} width={width}>
      <PanelHeader title="View settings" subtitle="Choose what the list shows" width={width} />
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        {VIEW_OPTIONS.map((option, index) => {
          const selected = index === cursor;
          return (
            <Box key={option.key} flexShrink={0} width={width}>
              <Text wrap="truncate-end">
                <Text color={PANEL_ACCENT}>{selected ? "❯ " : "  "}</Text>
                <Text bold={selected}>{`${settings[option.key] ? "[x]" : "[ ]"} ${option.label}`}</Text>
              </Text>
            </Box>
          );
        })}
      </Box>
      <PanelFooter hint={hint} />
    </Box>
  );
}

// ---------------------------------------------------------------------------
// The panel with its keys and mouse.
// ---------------------------------------------------------------------------
export function ViewSettingsScreen({
  settings,
  onToggle,
  onClose,
}: {
  settings: ViewSettings;
  onToggle: (key: keyof ViewSettings) => void;
  onClose: () => void;
}) {
  const { columns, rows } = useWindowSize();
  const [cursor, setCursor] = useState(0);
  const geometry = panelGeometry(columns, rows, viewPanelHeight(VIEW_OPTIONS.length));

  // Relative moves use the functional form, so quick key presses add up.
  const move = (delta: number) => setCursor((c) => Math.max(0, Math.min(VIEW_OPTIONS.length - 1, c + delta)));
  // Does the whole panel fit? If not it only shows "Too small", so nothing may be toggled.
  const fits = geometry.contentHeight >= viewPanelHeight(VIEW_OPTIONS.length);
  const toggleAt = (index: number) => {
    const option = VIEW_OPTIONS[index];
    if (fits && option) onToggle(option.key);
  };

  useInput((input, key) => {
    if (key.escape || input === "v" || input === "q") onClose();
    // Toggling takes ONE exact press. A burst like "   " (a held key or a paste) is ignored:
    // expandBurst repeats Space, and an even number of repeats would flip it back.
    else if (key.return || input === " ") toggleAt(cursor);
    else if (key.downArrow) move(1);
    else if (key.upArrow) move(-1);
    else {
      for (const char of expandBurst(input)) {
        if (char === "j") move(1);
        else if (char === "k") move(-1);
      }
    }
  });

  // A click outside the panel closes it (like Esc). A click on an option flips it. A click
  // never writes to Linear: the only thing it can change is the view setting.
  useMouse((event) => {
    if (event.kind !== "press" || event.button !== "left") return;
    if (!insidePanel(geometry, event.x, event.y)) {
      onClose();
      return;
    }
    // Option rows start below the border (1) and the header.
    const index = event.y - (geometry.top + 1 + HEADER_HEIGHT);
    if (index >= 0 && index < VIEW_OPTIONS.length) {
      setCursor(index);
      toggleAt(index);
    }
  });

  return (
    <Panel geometry={geometry}>
      <ViewSettingsView settings={settings} cursor={cursor} width={geometry.contentWidth} height={geometry.contentHeight} />
    </Panel>
  );
}
