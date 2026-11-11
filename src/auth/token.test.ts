// Tests for src/auth/token.ts: the token requests and the strict checking of Linear's reply.

import { describe, expect, test } from "bun:test";
import { CLIENT_ID, TOKEN_URL } from "./config.ts";
import { buildCodeExchangeRequest, buildRefreshRequest, parseTokenResponse } from "./token.ts";

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
