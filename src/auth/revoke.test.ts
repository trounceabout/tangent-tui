// Tests for src/auth/revoke.ts: ending a login token at Linear.

import { describe, expect, test } from "bun:test";
import { REVOKE_URL } from "./config.ts";
import { buildRevokeRequest, revokeToken } from "./revoke.ts";

// A fake fetch that answers with a fixed status and records what it was asked.
function fakeFetch(status: number, body = "") {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response(body, { status });
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

describe("buildRevokeRequest", () => {
  const request = buildRevokeRequest("tok-SECRET", "refresh_token");
  const form = new URLSearchParams(request.body);

  test("posts to Linear's revoke endpoint as a form", () => {
    expect(request.url).toBe(REVOKE_URL);
    expect(request.headers["content-type"]).toBe("application/x-www-form-urlencoded");
  });

  test("carries the token and says which kind it is", () => {
    expect(form.get("token")).toBe("tok-SECRET");
    expect(form.get("token_type_hint")).toBe("refresh_token");
    expect(new URLSearchParams(buildRevokeRequest("a", "access_token").body).get("token_type_hint")).toBe("access_token");
  });

  test("never sends a client secret", () => {
    expect(form.has("client_secret")).toBe(false);
  });

  test("a token with characters that need escaping survives the form encoding", () => {
    const awkward = "a b&c=d+e/f%g";
    expect(new URLSearchParams(buildRevokeRequest(awkward, "access_token").body).get("token")).toBe(awkward);
  });
});

describe("revokeToken: what Linear's answer means", () => {
  test.each([
    [200, "revoked"],
    [204, "revoked"],
    [400, "already-gone"],
    [401, "already-gone"],
    [403, "failed"],
    [404, "failed"],
    [429, "failed"],
    [500, "failed"],
    [502, "failed"],
    [503, "failed"],
  ])("HTTP %d is %s", async (status, expected) => {
    const { fetchFn } = fakeFetch(status);
    expect(await revokeToken(fetchFn, "tok", "refresh_token")).toBe(expected as never);
  });

  test("the answer's body is ignored: a 200 with rubbish is still revoked, and a 502 error page is still a failure", async () => {
    expect(await revokeToken(fakeFetch(200, "<html>whatever</html>").fetchFn, "tok", "access_token")).toBe("revoked");
    expect(await revokeToken(fakeFetch(502, '{"revoked":true}').fetchFn, "tok", "access_token")).toBe("failed");
  });

  test("no network is a failure, not a crash", async () => {
    const fetchFn = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    expect(await revokeToken(fetchFn, "tok", "refresh_token")).toBe("failed");
  });
});

describe("revokeToken: what it sends", () => {
  test("one POST to the revoke endpoint with the token and its hint", async () => {
    const { fetchFn, calls } = fakeFetch(200);
    await revokeToken(fetchFn, "tok-SECRET", "access_token");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(REVOKE_URL);
    expect(calls[0]?.init.method).toBe("POST");
    const form = new URLSearchParams(String(calls[0]?.init.body));
    expect(form.get("token")).toBe("tok-SECRET");
    expect(form.get("token_type_hint")).toBe("access_token");
  });

  test("no Authorization header: the token in the body is all Linear needs", async () => {
    const { fetchFn, calls } = fakeFetch(200);
    await revokeToken(fetchFn, "tok", "refresh_token");
    const headers = (calls[0]?.init.headers ?? {}) as Record<string, string>;
    expect(Object.keys(headers).map((key) => key.toLowerCase())).not.toContain("authorization");
  });
});
