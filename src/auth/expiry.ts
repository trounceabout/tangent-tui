// src/auth/expiry.ts
// "Is it time to get a fresh access token?" Pure: the time is passed in, so tests can pin it.
// See issue #67.

import type { Tokens } from "./token.ts";

// Refresh a little BEFORE the access token dies, so a request that is already on its way
// doesn't arrive with a token that just expired. Linear's tokens last about 24 hours.
export const REFRESH_MARGIN_MS = 5 * 60 * 1000;

// True once we are inside the margin before expiry, or already past it.
export function isDueForRefresh(tokens: Pick<Tokens, "expiresAt">, now: number, marginMs: number = REFRESH_MARGIN_MS): boolean {
  return now >= tokens.expiresAt - marginMs;
}
