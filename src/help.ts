// src/help.ts
// The content of the help screen: which keys do what, on each screen. Pure data and
// one function, so it can be tested without any UI.
//
// KEEP THIS IN SYNC with the real key handlers: handleKey in app.tsx (the board) and
// detail-view.tsx (an issue's detail screen). When you add, remove or change a key
// there, change it here too. Rows are short on purpose (keys up to 10 characters, the
// description up to 17) so they fit even a narrow panel without wrapping.

export type HelpKind = "list" | "detail";

type Entry = [keys: string, description: string];
type Section = { title: string; entries: Entry[] };

const LIST_HELP: Section[] = [
  {
    title: "Move",
    entries: [
      ["↑↓  j k", "move"],
      ["PgUp PgDn", "half a page"],
      ["g  G", "top / bottom"],
      ["tab ⇧tab", "next / prev group"],
      ["← → h l", "fold / unfold"],
    ],
  },
  {
    title: "Open",
    entries: [
      ["enter", "open / fold group"],
      ["space", "fold a group"],
      ["o", "open in browser"],
      ["r", "reload now"],
    ],
  },
  {
    title: "Filter",
    entries: [
      ["/", "search"],
      ["", "label:x  team:x"],
      ["t", "cycle team"],
      ["p", "cycle priority"],
      ["L", "cycle label"],
      ["esc", "clear filters"],
    ],
  },
  {
    title: "Change",
    entries: [
      ["s", "status"],
      ["P", "priority"],
      ["e", "estimate"],
    ],
  },
  {
    title: "Mouse",
    entries: [
      ["click", "open / fold group"],
      ["wheel", "scroll the list"],
      ["m", "mouse on / off"],
    ],
  },
  {
    title: "App",
    entries: [
      ["?", "this help"],
      ["q", "quit"],
    ],
  },
];

const DETAIL_HELP: Section[] = [
  {
    title: "Scroll",
    entries: [
      ["↑↓  j k", "one line"],
      ["space b", "page down / up"],
      ["PgDn PgUp", "page down / up"],
      ["g  G", "top / bottom"],
    ],
  },
  {
    title: "Open",
    entries: [["o", "open in browser"]],
  },
  {
    title: "Change",
    entries: [
      ["s", "status"],
      ["P", "priority"],
      ["e", "estimate"],
    ],
  },
  {
    title: "Mouse",
    entries: [["wheel", "scroll"]],
  },
  {
    title: "Leave",
    entries: [
      ["esc q h ←", "back to the board"],
      ["?", "this help"],
    ],
  },
];

export const HELP: Record<HelpKind, Section[]> = { list: LIST_HELP, detail: DETAIL_HELP };

export const HELP_TITLE = "Keyboard help";
export const helpSubtitle = (kind: HelpKind): string => (kind === "list" ? "On the board" : "On an issue's detail screen");

// One line of the help screen.
export type HelpLine =
  | { kind: "title"; text: string }
  | { kind: "entry"; keys: string; description: string }
  | { kind: "blank" };

// The sections flattened into lines, with a blank line between sections (none at the
// start or end).
export function helpLines(kind: HelpKind): HelpLine[] {
  const lines: HelpLine[] = [];
  for (const [index, section] of HELP[kind].entries()) {
    if (index > 0) lines.push({ kind: "blank" });
    lines.push({ kind: "title", text: section.title });
    for (const [keys, description] of section.entries) lines.push({ kind: "entry", keys, description });
  }
  return lines;
}

// How wide the key column is: the longest key label, so the descriptions line up.
export const keyColumnWidth = (lines: HelpLine[]): number =>
  Math.max(0, ...lines.map((line) => (line.kind === "entry" ? Bun.stringWidth(line.keys) : 0)));
