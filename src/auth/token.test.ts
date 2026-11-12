// Tests for src/auth/token.ts: the token requests and the strict checking of Linear's reply.

import { describe, expect, test } from "bun:test";
import { CLIENT_ID, TOKEN_URL } from "./config.ts";
import {
  MAX_EXPIRES_IN_SECONDS,
  MAX_SCOPES,
  MAX_TOKEN_CHARS,
  TOKEN_PATTERN,
  buildCodeExchangeRequest,
  buildRefreshRequest,
  issuedTokensIn,
  parseTokenResponse,
} from "./token.ts";

const NOW = 1_800_000_000_000;

// The shape of a real reply (seen in the issue #66 spike), with made-up token values.
const goodReply = () => ({
  access_token: "access-SECRET",
  token_type: "Bearer",
  expires_in: 86399,
  scope: "issues:create read",
  refresh_token: "refresh-SECRET",
});

// Run the parser and hand back the error message, failing the test if nothing was thrown.
function messageFor(body: unknown): string {
  try {
    parseTokenResponse(body, NOW);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected parseTokenResponse to throw");
}

describe("buildCodeExchangeRequest", () => {
  const request = buildCodeExchangeRequest({
    code: "the-code",
    codeVerifier: "the-verifier",
    redirectUri: "http://127.0.0.1:8976/callback",
  });
  const form = new URLSearchParams(request.body);

  test("posts to Linear's token endpoint as a form", () => {
    expect(request.url).toBe(TOKEN_URL);
    expect(request.headers["content-type"]).toBe("application/x-www-form-urlencoded");
  });

  test("carries everything the code exchange needs", () => {
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code")).toBe("the-code");
    expect(form.get("code_verifier")).toBe("the-verifier");
    expect(form.get("redirect_uri")).toBe("http://127.0.0.1:8976/callback");
    expect(form.get("client_id")).toBe(CLIENT_ID);
  });

  test("never sends a client secret", () => {
    expect(form.has("client_secret")).toBe(false);
  });
});

describe("buildRefreshRequest", () => {
  const request = buildRefreshRequest("old-refresh");
  const form = new URLSearchParams(request.body);

  test("asks for a new access token using only the client ID", () => {
    expect(request.url).toBe(TOKEN_URL);
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("refresh_token")).toBe("old-refresh");
    expect(form.get("client_id")).toBe(CLIENT_ID);
  });

  test("never sends a client secret", () => {
    expect(form.has("client_secret")).toBe(false);
  });
});

describe("parseTokenResponse: a good reply", () => {
  test("keeps the tokens, works out when they expire, and lists the granted scopes", () => {
    expect(parseTokenResponse(goodReply(), NOW)).toEqual({
      accessToken: "access-SECRET",
      refreshToken: "refresh-SECRET",
      expiresAt: NOW + 86399 * 1000,
      scopes: ["issues:create", "read"],
    });
  });

  test("accepts the scopes in any order, and extra ones", () => {
    const tokens = parseTokenResponse({ ...goodReply(), scope: "read write issues:create" }, NOW);
    expect(tokens.scopes).toEqual(["read", "write", "issues:create"]);
  });

  test("accepts 'bearer' in any letter case", () => {
    expect(() => parseTokenResponse({ ...goodReply(), token_type: "bearer" }, NOW)).not.toThrow();
  });

  test("drops scope names that look wrong instead of keeping them", () => {
    const tokens = parseTokenResponse({ ...goodReply(), scope: "read issues:create <script> a‮b" }, NOW);
    expect(tokens.scopes).toEqual(["read", "issues:create"]);
  });
});

describe("parseTokenResponse: a bad reply is refused", () => {
  test("not a JSON object", () => {
    for (const bad of [null, undefined, "text", 42, [], [goodReply()]]) {
      expect(messageFor(bad)).toContain("wasn't what we expected");
    }
  });

  test("no access token, or one that isn't text", () => {
    for (const access_token of [undefined, "", 123, null, {}]) {
      expect(messageFor({ ...goodReply(), access_token })).toContain("no access token");
    }
  });

  test("no refresh token (the login would end after a day)", () => {
    for (const refresh_token of [undefined, "", 123, null]) {
      expect(messageFor({ ...goodReply(), refresh_token })).toContain("no refresh token");
    }
  });

  test("a token type other than Bearer", () => {
    for (const token_type of [undefined, "MAC", "", 1]) {
      expect(messageFor({ ...goodReply(), token_type })).toContain("Bearer");
    }
  });

  test("an expiry time that isn't a positive number", () => {
    for (const expires_in of [undefined, 0, -5, "86399", null, Number.POSITIVE_INFINITY, Number.NaN]) {
      expect(messageFor({ ...goodReply(), expires_in })).toContain("expiry");
    }
  });

  test("fewer permissions than Tangent asked for", () => {
    expect(messageFor({ ...goodReply(), scope: "read" })).toContain("issues:create");
    expect(messageFor({ ...goodReply(), scope: "issues:create" })).toContain("read");
    expect(messageFor({ ...goodReply(), scope: undefined })).toContain("permissions");
  });
});

describe("parseTokenResponse: Linear says no", () => {
  test("shows Linear's description of the refusal", () => {
    const message = messageFor({ error: "invalid_grant", error_description: "The code has expired." });
    expect(message).toContain("The code has expired.");
  });

  test("falls back to the short error code when there is no description", () => {
    expect(messageFor({ error: "invalid_request" })).toContain("invalid_request");
  });

  test("cleans control characters out of text from Linear", () => {
    const message = messageFor({ error: "x", error_description: "bad\u001b[31m red‮ text" });
    expect(message).not.toContain("\u001b");
    expect(message).not.toContain("‮");
  });

  test("cuts a very long description short", () => {
    const message = messageFor({ error: "x", error_description: "a".repeat(5000) });
    expect(message.length).toBeLessThan(300);
  });
});

describe("parseTokenResponse: tokens never leak into errors", () => {
  test("a failure (here: missing scope) does not repeat the token values", () => {
    const message = messageFor({ ...goodReply(), scope: "read" });
    expect(message).not.toContain("SECRET");
  });

  test("a refusal does not repeat the token values either", () => {
    const message = messageFor({ ...goodReply(), error: "boom" });
    expect(message).not.toContain("SECRET");
  });
});

describe("parseTokenResponse: tokens, expiry and scopes must be safe to keep", () => {
  // Each of these used to be ACCEPTED, then failed later at "couldn't save the login" (after Linear had
  // already issued the tokens) or, worse, made every request throw an error that quotes the token.
  const refused: [string, Record<string, unknown>][] = [
    ["an access token with a line break", { access_token: "abc\r\nSECRET" }],
    ["an access token with a newline", { access_token: "abc\nSECRET" }],
    ["an access token with a space", { access_token: "abc SECRET" }],
    ["an access token outside Latin-1", { access_token: "abc\u20acSECRET" }],
    ["an access token with a zero-width space", { access_token: "abc\u200bSECRET" }],
    ["an access token with a quote", { access_token: 'abc"SECRET' }],
    ["an access token with a backslash", { access_token: "abc\\SECRET" }],
    ["an access token that is too long", { access_token: "a".repeat(MAX_TOKEN_CHARS + 1) }],
    ["a refresh token with a line break", { refresh_token: "abc\r\nSECRET" }],
    ["a refresh token outside Latin-1", { refresh_token: "abc\u20acSECRET" }],
    ["a 1,000,000-character refresh token", { refresh_token: "r".repeat(1_000_000) }],
    ["a refresh token that is too long", { refresh_token: "r".repeat(MAX_TOKEN_CHARS + 1) }],
    ["an expiry of Number.MAX_VALUE (which would make expiresAt Infinity)", { expires_in: Number.MAX_VALUE }],
    ["an expiry beyond a year", { expires_in: MAX_EXPIRES_IN_SECONDS + 1 }],
    ["more scopes than Tangent keeps", { scope: `issues:create read ${Array.from({ length: MAX_SCOPES }, (_, i) => `extra${i}`).join(" ")}` }],
  ];

  test.each(refused)("refuses %s", (_label, change) => {
    const message = messageFor({ ...goodReply(), ...change });
    expect(message).not.toContain("SECRET");
    expect(message.length).toBeGreaterThan(0);
  });

  test("the messages for a bad token name which token, and never repeat it", () => {
    expect(messageFor({ ...goodReply(), access_token: "bad\nSECRET" })).toContain("access token");
    expect(messageFor({ ...goodReply(), refresh_token: "bad\nSECRET" })).toContain("refresh token");
  });

  test("the limits sit exactly where they say: the largest allowed values are accepted", () => {
    const biggest = {
      ...goodReply(),
      access_token: "a".repeat(MAX_TOKEN_CHARS),
      refresh_token: "r".repeat(MAX_TOKEN_CHARS),
      expires_in: MAX_EXPIRES_IN_SECONDS,
      scope: `issues:create read ${Array.from({ length: MAX_SCOPES - 2 }, (_, i) => `extra${i}`).join(" ")}`,
    };
    const tokens = parseTokenResponse(biggest, NOW);
    expect(tokens.accessToken).toHaveLength(MAX_TOKEN_CHARS);
    expect(tokens.scopes).toHaveLength(MAX_SCOPES);
    expect(Number.isFinite(tokens.expiresAt)).toBe(true);
  });

  test("every character the Bearer-token alphabet allows is accepted", () => {
    const alphabet = "ABCxyz019._~+/=-";
    expect(TOKEN_PATTERN.test(alphabet)).toBe(true);
    expect(parseTokenResponse({ ...goodReply(), access_token: alphabet, refresh_token: alphabet }, NOW).accessToken).toBe(alphabet);
  });

  test("a token that really looks like Linear's is accepted", () => {
    const real = `lin_oauth_${"0123456789abcdef".repeat(4)}`;
    expect(parseTokenResponse({ ...goodReply(), access_token: real }, NOW).accessToken).toBe(real);
  });
});

describe("issuedTokensIn: what Linear issued, even if we refuse to use it", () => {
  test("finds both tokens in a good reply", () => {
    expect(issuedTokensIn(goodReply())).toEqual({ accessToken: "access-SECRET", refreshToken: "refresh-SECRET" });
  });

  test("still finds tokens we would REFUSE (so they can be ended at Linear)", () => {
    const body = { ...goodReply(), access_token: "bad\nSECRET", scope: "read" };
    expect(() => parseTokenResponse(body, NOW)).toThrow();
    expect(issuedTokensIn(body)).toEqual({ accessToken: "bad\nSECRET", refreshToken: "refresh-SECRET" });
  });

  test("finds only what is there", () => {
    expect(issuedTokensIn({ access_token: "only-access" })).toEqual({ accessToken: "only-access" });
    expect(issuedTokensIn({ refresh_token: "only-refresh" })).toEqual({ refreshToken: "only-refresh" });
    expect(issuedTokensIn({})).toEqual({});
  });

  test("ignores anything that isn't a plain, sane string", () => {
    expect(issuedTokensIn({ access_token: 123, refresh_token: { a: 1 } })).toEqual({});
    expect(issuedTokensIn({ access_token: "", refresh_token: null })).toEqual({});
    expect(issuedTokensIn({ access_token: "a".repeat(5000), refresh_token: "r".repeat(4096) })).toEqual({ refreshToken: "r".repeat(4096) });
  });

  test("not an object at all gives nothing, never a crash", () => {
    for (const body of [null, undefined, "text", 42, [], [goodReply()]]) expect(issuedTokensIn(body)).toEqual({});
  });
});
