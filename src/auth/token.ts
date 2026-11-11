// src/auth/token.ts
// The two requests that swap a login code (or a refresh token) for tokens, and the strict
// checking of Linear's reply. Pure: it builds requests and judges replies, it never sends
// anything. See issue #67.
//
// Linear's reply is untrusted input, like issue text elsewhere in this app: every field is
// checked, any text from Linear goes through cleanText(), and a token value is NEVER put in
// an error message (an error can end up on screen or in a log).

import { cleanText } from "../linear.ts";
import { CLIENT_ID, SCOPES, TOKEN_URL } from "./config.ts";

// What we keep from a successful login.
export interface Tokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // when the access token stops working, in milliseconds since 1970
  scopes: string[]; // what Linear actually granted
}

export interface TokenRequest {
  url: string;
  headers: Record<string, string>;
  body: string; // form-encoded
}

const FORM_HEADERS = { "content-type": "application/x-www-form-urlencoded" };

// Trade the code from the browser for tokens. `client_id` + `code_verifier` take the place
// of a client secret (PKCE), so there is deliberately no `client_secret` here.
export function buildCodeExchangeRequest(args: { code: string; codeVerifier: string; redirectUri: string }): TokenRequest {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: args.code,
    redirect_uri: args.redirectUri, // must be the same one used in the login address
    client_id: CLIENT_ID,
    code_verifier: args.codeVerifier,
  });
  return { url: TOKEN_URL, headers: FORM_HEADERS, body: body.toString() };
}

// Get a new access token. For a PKCE login Linear wants only the client ID. The reply holds a
// NEW refresh token; the old one must be replaced (see issue #69).
export function buildRefreshRequest(refreshToken: string): TokenRequest {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
  });
  return { url: TOKEN_URL, headers: FORM_HEADERS, body: body.toString() };
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// A scope name is short and plain (`read`, `issues:create`). Anything odd is dropped.
const SCOPE_NAME = /^[A-Za-z0-9:_.-]{1,40}$/;
const MAX_ERROR_CHARS = 200;

// Turn Linear's JSON reply into Tokens, or throw an Error whose message is safe to show.
// `now` is passed in (not read from the clock) so tests can pin the time.
export function parseTokenResponse(body: unknown, now: number): Tokens {
  if (!isObject(body)) throw new Error("Linear's reply wasn't what we expected.");

  // Linear reports a refusal as { error, error_description }.
  if (typeof body.error === "string") {
    const detail = typeof body.error_description === "string" ? body.error_description : body.error;
    throw new Error(`Linear refused the request: ${cleanText(detail).slice(0, MAX_ERROR_CHARS)}`);
  }

  const accessToken = body.access_token;
  if (typeof accessToken !== "string" || accessToken === "") throw new Error("Linear's reply had no access token.");

  // Without a refresh token the login would end after about a day, so treat its absence as a failure.
  const refreshToken = body.refresh_token;
  if (typeof refreshToken !== "string" || refreshToken === "") {
    throw new Error("Linear's reply had no refresh token, so the login would end after a day.");
  }

  // We send the token as `Bearer <token>`, so that is the only kind we accept.
  if (typeof body.token_type !== "string" || body.token_type.toLowerCase() !== "bearer") {
    throw new Error("Linear's reply wasn't a Bearer token.");
  }

  const expiresIn = body.expires_in;
  if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new Error("Linear's reply had no valid expiry time.");
  }

  // The reply lists the granted scopes separated by spaces (the request used commas).
  const granted = (typeof body.scope === "string" ? body.scope.split(/\s+/) : []).filter((scope) => SCOPE_NAME.test(scope));
  const missing = SCOPES.filter((scope) => !granted.includes(scope));
  if (missing.length > 0) {
    throw new Error(`Linear didn't grant the permissions Tangent needs: ${missing.join(", ")}.`);
  }

  return { accessToken, refreshToken, expiresAt: now + expiresIn * 1000, scopes: granted };
}
