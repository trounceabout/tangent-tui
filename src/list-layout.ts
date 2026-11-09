// src/list-layout.ts
// The arithmetic behind the board's scrolling list: where each item starts, and which
// item a given line belongs to (for clicks). Pure functions, no UI.
//
// The list is ONE tall column of items stacked one after another. Item i takes
// `heights[i]` lines, starting at line `offsets[i]`.

// The line where each item starts, and the height of the whole column.
export function layoutItems(heights: number[]): { offsets: number[]; totalLines: number } {
  const offsets: number[] = [];
  let line = 0;
  for (const height of heights) {
    offsets.push(line);
    line += height;
  }
  return { offsets, totalLines: line };
}

// Which item contains `line` (counted from the top of the whole column, not the screen)?
// Returns its index and which of its lines it is, or null if the line is past the end.
export function itemAtLine(
  offsets: number[],
  heights: number[],
  line: number,
): { index: number; lineInItem: number } | null {
  if (line < 0) return null;
  // Binary search for the last item starting at or before `line`.
  let low = 0;
  let high = offsets.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if ((offsets[middle] ?? 0) <= line) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  if (found === -1) return null;
  const lineInItem = line - (offsets[found] ?? 0);
  return lineInItem < (heights[found] ?? 0) ? { index: found, lineInItem } : null;
}

// Where in the list a click on screen row `screenY` lands, given how the list is placed:
// it starts at screen row `listTop`, is `viewHeight` rows tall, and is scrolled by `scrollTop`
// lines. Returns null for a click above or below the list.
export function lineAtScreenRow(screenY: number, listTop: number, viewHeight: number, scrollTop: number): number | null {
  if (screenY < listTop || screenY >= listTop + viewHeight) return null;
  return screenY - listTop + scrollTop;
}
