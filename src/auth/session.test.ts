// Tests for src/auth/session.ts: which credential to send, and keeping a browser login fresh.
//
// The token store and Linear are fakes. The lock is the REAL one, in a temporary folder (never the
// real ~/.config/tangent), so the "two windows at once" tests exercise the real thing.
// Token values contain "SECRET" so a leak into an error message is easy to spot.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLIENT_ID, TOKEN_URL } from "./config.ts";
import { REFRESH_MARGIN_MS } from "./expiry.ts";
import { createFileLock } from "./lock.ts";
import { LoginRequiredError, type SessionDeps, getAuthorization } from "./session.ts";
import type { TokenStore } from "./token-store.ts";
import type { Tokens } from "./token.ts";

const NOW = 1_800_000_000_000;
const HOUR = 60 * 60 * 1000;

const tokensExpiringIn = (ms: number, suffix = "old"): Tokens => ({
  accessToken: `access-${suffix}-SECRET`,
  refreshToken: `refresh-${suffix}-SECRET`,
  expiresAt: NOW + ms,
  scopes: ["issues:create", "read"],
});

const goodRefreshReply = {
  access_token: "access-new-SECRET",
  token_type: "Bearer",
  expires_in: 86399,
  scope: "issues:create read",
  refresh_token: "refresh-new-SECRET",
};

let dir: string;
let lockPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tangent-session-"));
  lockPath = join(dir, "login.lock");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// A token store in memory. `loadQueue` lets a test make successive loads return different things
// (to simulate another window changing the login in between). `events` records what was done.
function fakeStore(
  initial: Tokens | null,
  options: { loadQueue?: (Tokens | null)[]; loadThrows?: boolean; saveThrows?: boolean } = {},
) {
  let saved = initial;
  const events: string[] = [];
  const queue = options.loadQueue ? [...options.loadQueue] : undefined;
  const store: TokenStore = {
    async load() {
      events.push("load");
      if (options.loadThrows) throw new Error("Couldn't read from the Keychain.");
      if (queue) return (queue.length > 1 ? queue.shift() : queue[0]) ?? null;
      return saved;
    },
    async save(tokens) {
      events.push("save");
      if (options.saveThrows) throw new Error("the Keychain is locked SECRET-DETAIL");
      saved = tokens;
    },
    async clear() {
      events.push("clear");
      saved = null;
    },
  };
  return { store, events, current: () => saved };
}

type Call = { url: string; body: string };
// A fake Linear for the refresh request. `reply` builds each response; `throws` simulates no network.
function fakeLinear(reply: () => Response = () => new Response(JSON.stringify(goodRefreshReply)), throws = false) {
  const calls: Call[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), body: String(init?.body) });
    if (throws) throw new Error("network down");
    return reply();
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function setup(
  store: ReturnType<typeof fakeStore> | null,
  options: { linear?: ReturnType<typeof fakeLinear>; apiKey?: string | null; env?: Record<string, string | undefined> } = {},
) {
  const linear = options.linear ?? fakeLinear();
  const apiKeyReads: number[] = [];
  // The real lock, wrapped so tests can see how often it was taken.
  const realLock = createFileLock(lockPath, { pollMs: 5 });
  const lockTaken: number[] = [];
  const deps: SessionDeps = {
    tokenStore: store?.store ?? null,
    lock: {
      withLock: (task) => {
        lockTaken.push(1);
        return realLock.withLock(task);
      },
    },
    readApiKey: async () => {
      apiKeyReads.push(1);
      return options.apiKey ?? null;
    },
    env: options.env ?? {},
    fetchFn: linear.fetchFn,
    now: () => NOW,
  };
  return { deps, linear, apiKeyReads, lockTaken };
}

const messageOf = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected a failure");
};

describe("a browser login that is still fresh", () => {
  test("is sent as a Bearer token, with no network, no lock and no other credential read", async () => {
    const fake = fakeStore(tokensExpiringIn(HOUR));
    const run = setup(fake, { apiKey: "saved-key", env: { LINEAR_API_KEY: "env-key" } });
    expect(await getAuthorization(run.deps)).toBe("Bearer access-old-SECRET");
    expect(run.linear.calls).toHaveLength(0);
    expect(run.apiKeyReads).toHaveLength(0);
    expect(run.lockTaken).toHaveLength(0); // the lock is only for refreshing, never for ordinary requests
    expect(fake.events).toEqual(["load"]); // one look at the store, nothing else
  });

  test("just outside the refresh margin is still used as it is", async () => {
    const fake = fakeStore(tokensExpiringIn(REFRESH_MARGIN_MS + 1000));
    const run = setup(fake);
    expect(await getAuthorization(run.deps)).toBe("Bearer access-old-SECRET");
    expect(run.linear.calls).toHaveLength(0);
    expect(run.lockTaken).toHaveLength(0);
  });
});

describe("refreshing a login that is due", () => {
  test("gets a new token, saves it, and returns it", async () => {
    const fake = fakeStore(tokensExpiringIn(60_000));
    const run = setup(fake);
    expect(await getAuthorization(run.deps)).toBe("Bearer access-new-SECRET");
    expect(fake.current()?.refreshToken).toBe("refresh-new-SECRET");
    expect(fake.current()?.expiresAt).toBe(NOW + 86399 * 1000);
    expect(run.linear.calls).toHaveLength(1);
  });

  test("a token already inside the five-minute margin counts as due", async () => {
    const fake = fakeStore(tokensExpiringIn(REFRESH_MARGIN_MS - 1000));
    const run = setup(fake);
    expect(await getAuthorization(run.deps)).toBe("Bearer access-new-SECRET");
  });

  test("sends the old refresh token and the client ID, never a client secret", async () => {
    const run = setup(fakeStore(tokensExpiringIn(60_000)));
    await getAuthorization(run.deps);
    const call = run.linear.calls[0];
    expect(call?.url).toBe(TOKEN_URL);
    const form = new URLSearchParams(call?.body);
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("refresh_token")).toBe("refresh-old-SECRET");
    expect(form.get("client_id")).toBe(CLIENT_ID);
    expect(form.has("client_secret")).toBe(false);
  });

  test("an expired token is refreshed too", async () => {
    const run = setup(fakeStore(tokensExpiringIn(-HOUR)));
    expect(await getAuthorization(run.deps)).toBe("Bearer access-new-SECRET");
  });

  test("the lock is released afterwards", async () => {
    const run = setup(fakeStore(tokensExpiringIn(60_000)));
    await getAuthorization(run.deps);
    expect(existsSync(lockPath)).toBe(false);
  });
});

describe("two windows at once", () => {
  test("five simultaneous requests cause exactly ONE refresh, and all get the new token", async () => {
    const fake = fakeStore(tokensExpiringIn(60_000));
    const run = setup(fake);
    const headers = await Promise.all(Array.from({ length: 5 }, () => getAuthorization(run.deps)));
    expect(run.linear.calls).toHaveLength(1);
    expect(new Set(headers)).toEqual(new Set(["Bearer access-new-SECRET"]));
  });

  test("a window that waited for the lock finds the work already done and doesn't refresh again", async () => {
    // First look: due. By the time the lock is ours, another window has saved a fresh login.
    const fake = fakeStore(null, { loadQueue: [tokensExpiringIn(60_000), tokensExpiringIn(HOUR, "fresh")] });
    const run = setup(fake);
    expect(await getAuthorization(run.deps)).toBe("Bearer access-fresh-SECRET");
    expect(run.linear.calls).toHaveLength(0);
  });

  test("a login that was cleared while we waited falls through to the other credentials", async () => {
    const fake = fakeStore(null, { loadQueue: [tokensExpiringIn(60_000), null] });
    const run = setup(fake, { apiKey: "saved-key" });
    expect(await getAuthorization(run.deps)).toBe("saved-key");
    expect(run.linear.calls).toHaveLength(0);
  });
});

describe("Linear says the login is dead", () => {
  const rejection = () => json({ error: "invalid_grant", error_description: "refresh token is invalid" }, 400);

  test("the dead login is cleared, and a saved API key takes over", async () => {
    const fake = fakeStore(tokensExpiringIn(60_000));
    const run = setup(fake, { linear: fakeLinear(rejection), apiKey: "saved-key" });
    expect(await getAuthorization(run.deps)).toBe("saved-key");
    expect(fake.events).toContain("clear");
    expect(fake.current()).toBeNull();
  });

  test("with no other credential it says the login has ended and what to do", async () => {
    const run = setup(fakeStore(tokensExpiringIn(60_000)), { linear: fakeLinear(rejection) });
    const message = await messageOf(getAuthorization(run.deps));
    expect(message).toContain("login has ended");
    expect(message).toContain("tangent login");
  });

  test("it is a LoginRequiredError", async () => {
    const run = setup(fakeStore(tokensExpiringIn(60_000)), { linear: fakeLinear(rejection) });
    await expect(getAuthorization(run.deps)).rejects.toBeInstanceOf(LoginRequiredError);
  });

  test("a 401 with an explanation counts as dead too", async () => {
    const fake = fakeStore(tokensExpiringIn(60_000));
    const run = setup(fake, { linear: fakeLinear(() => json({ error: "invalid_token" }, 401)), env: { LINEAR_API_KEY: "env-key" } });
    expect(await getAuthorization(run.deps)).toBe("env-key");
    expect(fake.events).toContain("clear");
  });

  test("a newer login saved while we were talking to Linear is NOT cleared", async () => {
    // Loads: (1) outside the lock, (2) inside the lock, (3) after the refusal: a different login by then.
    const fake = fakeStore(null, {
      loadQueue: [tokensExpiringIn(60_000), tokensExpiringIn(60_000), tokensExpiringIn(HOUR, "newer")],
    });
    const run = setup(fake, { linear: fakeLinear(rejection), apiKey: "saved-key" });
    await getAuthorization(run.deps);
    expect(fake.events).not.toContain("clear");
  });
});

describe("Linear is merely having trouble (nothing is thrown away)", () => {
  test("no network, access token still valid: carries on with it", async () => {
    const fake = fakeStore(tokensExpiringIn(60_000)); // inside the margin but not expired
    const run = setup(fake, { linear: fakeLinear(undefined, true) });
    expect(await getAuthorization(run.deps)).toBe("Bearer access-old-SECRET");
    expect(fake.events).not.toContain("clear");
    expect(fake.events).not.toContain("save");
  });

  test("no network, access token expired: says so, and keeps the login for a later try", async () => {
    const fake = fakeStore(tokensExpiringIn(-HOUR));
    const run = setup(fake, { linear: fakeLinear(undefined, true), apiKey: "saved-key" });
    expect(await messageOf(getAuthorization(run.deps))).toContain("Couldn't reach Linear");
    expect(fake.events).not.toContain("clear");
    expect(fake.current()?.accessToken).toBe("access-old-SECRET");
  });

  test("an error page (503, not JSON): expired token means an error, still nothing cleared", async () => {
    const fake = fakeStore(tokensExpiringIn(-HOUR));
    const run = setup(fake, { linear: fakeLinear(() => new Response("<html>down</html>", { status: 503 })) });
    expect(await messageOf(getAuthorization(run.deps))).toContain("HTTP 503");
    expect(fake.events).not.toContain("clear");
  });

  test("an error page with a token that is still valid: carries on", async () => {
    const run = setup(fakeStore(tokensExpiringIn(60_000)), { linear: fakeLinear(() => new Response("x", { status: 503 })) });
    expect(await getAuthorization(run.deps)).toBe("Bearer access-old-SECRET");
  });

  test("a 400 that doesn't explain itself is trouble, not proof the login is dead", async () => {
    const fake = fakeStore(tokensExpiringIn(-HOUR));
    const run = setup(fake, { linear: fakeLinear(() => new Response("bad request", { status: 400 })) });
    await expect(getAuthorization(run.deps)).rejects.toThrow("HTTP 400");
    expect(fake.events).not.toContain("clear");
  });

  test("a reply with no refresh token is an error and saves nothing", async () => {
    const noRefresh = () => json({ ...goodRefreshReply, refresh_token: undefined });
    const fake = fakeStore(tokensExpiringIn(-HOUR));
    const run = setup(fake, { linear: fakeLinear(noRefresh) });
    expect(await messageOf(getAuthorization(run.deps))).toContain("no refresh token");
    expect(fake.events).not.toContain("save");
  });

  test("a reply with too few permissions is an error and saves nothing", async () => {
    const narrow = () => json({ ...goodRefreshReply, scope: "read" });
    const fake = fakeStore(tokensExpiringIn(-HOUR));
    const run = setup(fake, { linear: fakeLinear(narrow) });
    expect(await messageOf(getAuthorization(run.deps))).toContain("issues:create");
    expect(fake.events).not.toContain("save");
  });
});

describe("a refresh that works but can't be saved", () => {
  test("is an error, not a silent success (the old refresh token is gone)", async () => {
    const run = setup(fakeStore(tokensExpiringIn(60_000), { saveThrows: true }));
    const message = await messageOf(getAuthorization(run.deps));
    expect(message).toContain("couldn't save it");
    expect(message).not.toContain("SECRET");
    expect(existsSync(lockPath)).toBe(false); // the lock is still released
  });
});

describe("no browser login", () => {
  test("a saved API key is sent as it is, with no Bearer", async () => {
    const run = setup(fakeStore(null), { apiKey: "lin_api_saved" });
    expect(await getAuthorization(run.deps)).toBe("lin_api_saved");
  });

  test("the LINEAR_API_KEY variable is next, trimmed", async () => {
    const run = setup(fakeStore(null), { env: { LINEAR_API_KEY: "  lin_api_env \n" } });
    expect(await getAuthorization(run.deps)).toBe("lin_api_env");
  });

  test("the saved key beats the variable", async () => {
    const run = setup(fakeStore(null), { apiKey: "saved", env: { LINEAR_API_KEY: "env" } });
    expect(await getAuthorization(run.deps)).toBe("saved");
  });

  test("an empty or blank variable is ignored", async () => {
    for (const value of ["", "   ", undefined]) {
      const run = setup(fakeStore(null), { env: { LINEAR_API_KEY: value } });
      await expect(getAuthorization(run.deps)).rejects.toBeInstanceOf(LoginRequiredError);
    }
  });

  test("with nothing at all it says how to log in", async () => {
    const run = setup(fakeStore(null));
    const message = await messageOf(getAuthorization(run.deps));
    expect(message).toContain("Not logged in");
    expect(message).toContain("tangent login");
    expect(message).toContain("LINEAR_API_KEY");
  });

  test("where logins can't be saved (no token store) the API key still works", async () => {
    const run = setup(null, { apiKey: "saved" });
    expect(await getAuthorization(run.deps)).toBe("saved");
  });
});

describe("the order of credentials", () => {
  test("a browser login beats a saved key and the variable, and they aren't even read", async () => {
    const run = setup(fakeStore(tokensExpiringIn(HOUR)), { apiKey: "saved", env: { LINEAR_API_KEY: "env" } });
    expect(await getAuthorization(run.deps)).toBe("Bearer access-old-SECRET");
    expect(run.apiKeyReads).toHaveLength(0);
  });
});

describe("when the vault can't be read", () => {
  test("it is an error, not 'not logged in' (a locked Keychain must not look like a logout)", async () => {
    const run = setup(fakeStore(null, { loadThrows: true }), { apiKey: "saved" });
    expect(await messageOf(getAuthorization(run.deps))).toContain("Couldn't read from the Keychain");
  });
});

describe("tokens never leak into error messages", () => {
  test("not across any of the failures above", async () => {
    const failures: SessionDeps[] = [
      setup(fakeStore(tokensExpiringIn(-HOUR)), { linear: fakeLinear(undefined, true) }).deps,
      setup(fakeStore(tokensExpiringIn(-HOUR)), { linear: fakeLinear(() => new Response("x", { status: 500 })) }).deps,
      setup(fakeStore(tokensExpiringIn(-HOUR)), { linear: fakeLinear(() => json({ ...goodRefreshReply, scope: "read" })) }).deps,
      setup(fakeStore(tokensExpiringIn(60_000), { saveThrows: true })).deps,
      setup(fakeStore(tokensExpiringIn(60_000)), { linear: fakeLinear(() => json({ error: "invalid_grant" }, 400)) }).deps,
    ];
    for (const deps of failures) {
      const message = await messageOf(getAuthorization(deps));
      expect(message).not.toContain("SECRET");
    }
  });
});
