// src/auth/revoke.ts
// Ending a login token at Linear, so that logging out really ends it and doesn't just forget it
// on this computer. Pure apart from the one request it is handed a `fetch` for. See issue #70.
//
// The request is the one in Linear's docs: POST the token in the `token` form field. The issue #66
// spike showed it works with no client secret and no Authorization header.
//
// The answer is one of three, and the caller needs to tell the last two apart:
//   "revoked"      Linear ended it.
//   "already-gone" Linear says the token is already dead (400 or 401): nothing left to end.
//   "failed"       We couldn't tell: no network, Linear erroring, anything unexpected. The token
//                  may still be live, so the caller must say so rather than pretend it's done.
// A token value is never put in any result or message.

import { REVOKE_URL } from "./config.ts";
import type { TokenRequest } from "./token.ts";

export type RevokeHint = "access_token" | "refresh_token";
export type RevokeOutcome = "revoked" | "already-gone" | "failed";

export function buildRevokeRequest(token: string, hint: RevokeHint): TokenRequest {
  const body = new URLSearchParams({ token, token_type_hint: hint });
  return { url: REVOKE_URL, headers: { "content-type": "application/x-www-form-urlencoded" }, body: body.toString() };
}

export async function revokeToken(fetchFn: typeof fetch, token: string, hint: RevokeHint): Promise<RevokeOutcome> {
  const request = buildRevokeRequest(token, hint);
  let response: Response;
  try {
    response = await fetchFn(request.url, { method: "POST", headers: request.headers, body: request.body });
  } catch {
    return "failed"; // no network
  }
  if (response.ok) return "revoked";
  // Linear answers 400 or 401 when it can't revoke the token because it no longer exists or
  // no longer works. For a logout that is the state we wanted.
  if (response.status === 400 || response.status === 401) return "already-gone";
  return "failed"; // a 5xx, rate limiting, or something we didn't expect
}
