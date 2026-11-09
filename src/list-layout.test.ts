// Tests for src/list-layout.ts: the arithmetic behind scrolling and clicking in the list.

import { describe, expect, test } from "bun:test";
import { itemAtLine, layoutItems, lineAtScreenRow } from "./list-layout.ts";

// A group header (1 line), two one-line issues, a header with a blank line above it (2),
// then a two-line issue (title + detail).
const heights = [1, 1, 1, 2, 2];

describe("layoutItems", () => {
  test("gives each item's starting line and the total height", () => {
    expect(layoutItems(heights)).toEqual({ offsets: [0, 1, 2, 3, 5], totalLines: 7 });
  });

  test("an empty list is empty", () => {
    expect(layoutItems([])).toEqual({ offsets: [], totalLines: 0 });
  });
});

describe("itemAtLine", () => {
  const { offsets } = layoutItems(heights);
  const at = (line: number) => itemAtLine(offsets, heights, line);

  test("finds the item on a given line, and which of its lines it is", () => {
    expect(at(0)).toEqual({ index: 0, lineInItem: 0 });
    expect(at(1)).toEqual({ index: 1, lineInItem: 0 });
    expect(at(2)).toEqual({ index: 2, lineInItem: 0 });
    expect(at(3)).toEqual({ index: 3, lineInItem: 0 }); // the blank line above the second header
    expect(at(4)).toEqual({ index: 3, lineInItem: 1 }); // the header itself
    expect(at(5)).toEqual({ index: 4, lineInItem: 0 }); // an issue's title line
    expect(at(6)).toEqual({ index: 4, lineInItem: 1 }); // its detail line
  });

  test("a line past the end, or before the start, is nothing", () => {
    expect(at(7)).toBeNull();
    expect(at(100)).toBeNull();
    expect(at(-1)).toBeNull();
  });

  test("an empty list has nothing to find", () => {
    expect(itemAtLine([], [], 0)).toBeNull();
  });

  test("agrees with a plain scan of every line, for lists of many shapes", () => {
    for (const shape of [[1], [2, 2, 2], [1, 2, 1, 2, 1, 2, 1], Array.from({ length: 50 }, (_, i) => 1 + (i % 2))]) {
      const layout = layoutItems(shape);
      const expected: number[] = shape.flatMap((height, index) => Array.from({ length: height }, () => index));
      expected.forEach((index, line) => expect(itemAtLine(layout.offsets, shape, line)?.index).toBe(index));
    }
  });
});

describe("lineAtScreenRow", () => {
  // The list starts at screen row 4, is 10 rows tall, and is scrolled 7 lines down.
  const at = (row: number) => lineAtScreenRow(row, 4, 10, 7);

  test("adds the scroll to the row's place within the list", () => {
    expect(at(4)).toBe(7); // the first visible row is line 7 of the column
    expect(at(8)).toBe(11);
    expect(at(13)).toBe(16); // the last visible row
  });

  test("rows above or below the list aren't in it", () => {
    expect(at(3)).toBeNull(); // the header
    expect(at(14)).toBeNull(); // the footer
    expect(at(0)).toBeNull();
  });
});
