// src/auth/revoke.ts
// Ending a login token at Linear, so that logging out really ends it and doesn't just forget it
// on this computer. Pure apart from the one request it is handed a `fetch` for. See issue #70.
//
// The request is the one in Linear's docs: POST the token in the `token` form field. The issue #66
// spike showed it works with no client secret and no Authorization header.
//
// The answer is one of three, and the caller needs to tell the last two apart:
//   "revoked"      Linear ended it.
//   "already-gone" Linear answered 400 or 401, which it says means it can't revoke the token.
//   "failed"       We couldn't tell: no network, Linear erroring, anything unexpected. The token
//                  may still be live, so the caller must say so rather than pretend it's done.
// A token value is never put in any result or message.
//
// BEWARE: "already-gone" is NOT proof the token is dead. A real run against Linear (issue #70)
// revoked the refresh token first, then got a 401 for the access token, which the API went on
// accepting for the rest of its day. So don't trust these answers alone: probeAccessToken() asks
// the API itself whether it still accepts the token, and a logout should confirm with it.

import { GRAPHQL_URL, REVOKE_URL } from "./config.ts";
import type { TokenRequest } from "./token.ts";

// How long one request may take. Logout makes these calls while it holds the refresh lock, so a
// stalled request must not outlast it: a request that times out counts as "couldn't tell" (failed
// or unknown), exactly like no network.
const REQUEST_TIMEOUT_MS = 5_000;

export type RevokeHint = "access_token" | "refresh_token";
export type RevokeOutcome = "revoked" | "already-gone" | "failed";

export function buildRevokeRequest(token: string, hint: RevokeHint): TokenRequest {
  const body = new URLSearchParams({ token, token_type_hint: hint });
  return { url: REVOKE_URL, headers: { "content-type": "application/x-www-form-urlencoded" }, body: body.toString() };
}

export async function revokeToken(
  fetchFn: typeof fetch,
  token: string,
  hint: RevokeHint,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<RevokeOutcome> {
  const request = buildRevokeRequest(token, hint);
  let response: Response;
  try {
    response = await fetchFn(request.url, {
      method: "POST",
      headers: request.headers,
      body: request.body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return "failed"; // no network, or it stalled past the time limit
  }
  if (response.ok) return "revoked";
  // Linear answers 400 or 401 when it can't revoke the token. That usually means it is already
  // dead, but NOT always (see the note at the top), so a logout must confirm with probeAccessToken().
  if (response.status === 400 || response.status === 401) return "already-gone";
  return "failed"; // a 5xx, rate limiting, or something we didn't expect
}

// "rejected"  the API says the token no longer works (HTTP 401): it really is dead.
// "accepted"  the API still takes it: logging out did NOT end it (it lives until it expires).
// "unknown"   we couldn't tell: no network, or an answer we didn't expect.
export type ProbeOutcome = "rejected" | "accepted" | "unknown";

// Ask the API whether it still accepts this access token, with the smallest read-only query there
// is (`viewer { id }`). This is the only reliable way to confirm a revoke, because the revoke
// endpoint's own answers are ambiguous (see the note at the top).
export async function probeAccessToken(
  fetchFn: typeof fetch,
  accessToken: string,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<ProbeOutcome> {
  let response: Response;
  try {
    response = await fetchFn(GRAPHQL_URL, {
      method: "POST",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "content-type": "application/json", Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ query: "{ viewer { id } }" }),
    });
  } catch {
    return "unknown"; // no network, or it stalled past the time limit
  }
  if (response.status === 401) return "rejected";
  if (response.ok) return "accepted";
  return "unknown"; // a 5xx, rate limiting, or something we didn't expect
}
