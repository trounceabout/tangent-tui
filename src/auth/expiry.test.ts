// Tests for src/auth/expiry.ts: when to get a fresh access token.

import { describe, expect, test } from "bun:test";
import { REFRESH_MARGIN_MS, isDueForRefresh } from "./expiry.ts";

const EXPIRES_AT = 1_800_000_000_000;
const tokens = { expiresAt: EXPIRES_AT };

describe("isDueForRefresh", () => {
  test("not due while there is plenty of time left", () => {
    expect(isDueForRefresh(tokens, EXPIRES_AT - 60 * 60 * 1000)).toBe(false);
  });

  test("not due one millisecond before the margin starts", () => {
    expect(isDueForRefresh(tokens, EXPIRES_AT - REFRESH_MARGIN_MS - 1)).toBe(false);
  });

  test("due exactly when the margin starts", () => {
    expect(isDueForRefresh(tokens, EXPIRES_AT - REFRESH_MARGIN_MS)).toBe(true);
  });

  test("due inside the margin, at expiry, and after it", () => {
    expect(isDueForRefresh(tokens, EXPIRES_AT - 1000)).toBe(true);
    expect(isDueForRefresh(tokens, EXPIRES_AT)).toBe(true);
    expect(isDueForRefresh(tokens, EXPIRES_AT + 24 * 60 * 60 * 1000)).toBe(true);
  });

  test("the margin is five minutes", () => {
    expect(REFRESH_MARGIN_MS).toBe(300_000);
  });

  test("a different margin can be passed in", () => {
    expect(isDueForRefresh(tokens, EXPIRES_AT - 1000, 500)).toBe(false);
    expect(isDueForRefresh(tokens, EXPIRES_AT - 500, 500)).toBe(true);
  });

  test("a margin bigger than the token's whole life means always due", () => {
    expect(isDueForRefresh({ expiresAt: 1000 }, 0, 10_000)).toBe(true);
  });
});
