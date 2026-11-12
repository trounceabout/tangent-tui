// Tests for src/auth/config.ts and src/auth/authorize.ts: the login address.

import { describe, expect, test } from "bun:test";
import { buildAuthorizeUrl } from "./authorize.ts";
import { CLIENT_ID, REDIRECT_PORTS, redirectUriFor } from "./config.ts";

const params = (url: string) => new URL(url).searchParams;

describe("redirectUriFor", () => {
  test("gives the exact loopback address for each registered port", () => {
    // Linear matches these character for character, so spell them out.
    expect(redirectUriFor(8976)).toBe("http://127.0.0.1:8976/callback");
    expect(redirectUriFor(8977)).toBe("http://127.0.0.1:8977/callback");
    expect(redirectUriFor(8978)).toBe("http://127.0.0.1:8978/callback");
  });

  test("refuses a port that isn't registered with Linear", () => {
    // Issue #66: an unregistered port ends on Linear's "Invalid redirect_uri" page.
    expect(() => redirectUriFor(9123)).toThrow("not registered");
    expect(() => redirectUriFor(0)).toThrow("not registered");
  });

  test("covers every port in the registered list", () => {
    for (const port of REDIRECT_PORTS) expect(() => redirectUriFor(port)).not.toThrow();
  });
});

describe("buildAuthorizeUrl", () => {
  const url = buildAuthorizeUrl({
    redirectUri: redirectUriFor(8976),
    state: "state-123",
    codeChallenge: "challenge-abc",
  });

  test("goes to Linear's authorize endpoint over https", () => {
    const parsed = new URL(url);
    expect(parsed.origin).toBe("https://linear.app");
    expect(parsed.pathname).toBe("/oauth/authorize");
  });

  test("carries the request details Linear needs", () => {
    const p = params(url);
    expect(p.get("response_type")).toBe("code");
    expect(p.get("client_id")).toBe(CLIENT_ID);
    expect(p.get("redirect_uri")).toBe("http://127.0.0.1:8976/callback");
    expect(p.get("state")).toBe("state-123");
  });

  test("asks for the narrow scopes, comma-separated, and never the broad 'write'", () => {
    const scope = params(url).get("scope");
    expect(scope).toBe("read,issues:create");
    expect(scope?.split(",")).not.toContain("write");
  });

  test("uses the S256 fingerprint, not 'plain'", () => {
    const p = params(url);
    expect(p.get("code_challenge")).toBe("challenge-abc");
    expect(p.get("code_challenge_method")).toBe("S256");
  });

  test("always shows the consent screen, so the workspace can be switched", () => {
    expect(params(url).get("prompt")).toBe("consent");
  });

  test("never includes a client secret", () => {
    expect(params(url).has("client_secret")).toBe(false);
  });

  test("escapes the redirect address so it survives inside the query string", () => {
    expect(url).toContain("redirect_uri=http%3A%2F%2F127.0.0.1%3A8976%2Fcallback");
  });
});
