// Tests for src/auth/revoke.ts: ending a login token at Linear.

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { GRAPHQL_URL, REVOKE_URL } from "./config.ts";
import { buildRevokeRequest, probeAccessToken, revokeToken } from "./revoke.ts";

// A server that is slow or stalled. Like a real `fetch`, it gives up when the request's time limit fires.
function slowFetch(options: { hang?: boolean; delayMs?: number; status?: number } = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    await new Promise<void>((resolve, reject) => {
      const timer = options.hang ? undefined : setTimeout(resolve, options.delayMs ?? 0);
      init?.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(init.signal?.reason ?? new Error("aborted"));
      });
    });
    return new Response("", { status: options.status ?? 200 });
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

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

describe("probeAccessToken: does the API still accept the token?", () => {
  test.each([
    [401, "rejected"],
    [200, "accepted"],
    [400, "unknown"],
    [403, "unknown"],
    [429, "unknown"],
    [500, "unknown"],
    [503, "unknown"],
  ])("HTTP %d is %s", async (status, expected) => {
    const { fetchFn } = fakeFetch(status);
    expect(await probeAccessToken(fetchFn, "tok")).toBe(expected as never);
  });

  test("no network is 'unknown', not a crash", async () => {
    const fetchFn = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    expect(await probeAccessToken(fetchFn, "tok")).toBe("unknown");
  });

  test("it makes one read-only request to the API with the token as a Bearer header", async () => {
    const { fetchFn, calls } = fakeFetch(401);
    await probeAccessToken(fetchFn, "tok-SECRET");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(GRAPHQL_URL);
    expect(calls[0]?.init.method).toBe("POST");
    const headers = (calls[0]?.init.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer tok-SECRET");
    const body = String(calls[0]?.init.body);
    expect(body).toContain("viewer"); // the smallest read there is...
    expect(body).not.toContain("mutation"); // ...and never a write
    expect(body).not.toContain("SECRET"); // the token goes in the header, not the query
  });
});

describe("the requests can't stall for ever (logout makes them while holding the refresh lock)", () => {
  test("both carry a time limit", async () => {
    const revoke = fakeFetch(200);
    await revokeToken(revoke.fetchFn, "tok", "access_token");
    expect(revoke.calls[0]?.init.signal).toBeInstanceOf(AbortSignal);
    const probe = fakeFetch(401);
    await probeAccessToken(probe.fetchFn, "tok");
    expect(probe.calls[0]?.init.signal).toBeInstanceOf(AbortSignal);
  });

  test("a stalled revoke is 'failed' (it may still be live), quickly, not a hang", async () => {
    const started = Date.now();
    expect(await revokeToken(slowFetch({ hang: true }).fetchFn, "tok", "refresh_token", 40)).toBe("failed");
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test("a stalled probe is 'unknown', quickly, not a hang", async () => {
    const started = Date.now();
    expect(await probeAccessToken(slowFetch({ hang: true }).fetchFn, "tok", 40)).toBe("unknown");
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test("the DEFAULT limits leave room for a slow but working Linear (they are not a few milliseconds)", async () => {
    expect(await revokeToken(slowFetch({ delayMs: 150, status: 200 }).fetchFn, "tok", "access_token")).toBe("revoked");
    expect(await probeAccessToken(slowFetch({ delayMs: 150, status: 401 }).fetchFn, "tok")).toBe("rejected");
  });

  test("an answer that arrives before the limit still counts", async () => {
    expect(await revokeToken(slowFetch({ delayMs: 20, status: 200 }).fetchFn, "tok", "access_token", 2000)).toBe("revoked");
    expect(await probeAccessToken(slowFetch({ delayMs: 20, status: 401 }).fetchFn, "tok", 2000)).toBe("rejected");
  });
});

describe("the default time limit is exactly 5 seconds (short enough to sit well inside the lock's 30 s)", () => {
  // AbortSignal.timeout(ms) has no readable duration, so spy on the call that creates it.
  const spies: { mockRestore(): void }[] = [];
  afterEach(() => {
    for (const spy of spies.splice(0)) spy.mockRestore();
  });

  test("revokeToken asks for 5000 ms", async () => {
    const spy = spyOn(AbortSignal, "timeout");
    spies.push(spy);
    await revokeToken(fakeFetch(200).fetchFn, "tok", "access_token");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(5000);
  });

  test("probeAccessToken asks for 5000 ms", async () => {
    const spy = spyOn(AbortSignal, "timeout");
    spies.push(spy);
    await probeAccessToken(fakeFetch(401).fetchFn, "tok");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(5000);
  });

  test("a custom limit is used as given", async () => {
    const spy = spyOn(AbortSignal, "timeout");
    spies.push(spy);
    await revokeToken(fakeFetch(200).fetchFn, "tok", "access_token", 1234);
    await probeAccessToken(fakeFetch(401).fetchFn, "tok", 4321);
    expect(spy.mock.calls.map((call) => call[0])).toEqual([1234, 4321]);
  });
});
