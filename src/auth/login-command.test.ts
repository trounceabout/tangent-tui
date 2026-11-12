// Tests for src/auth/login-command.ts: what `tangent login` does and the exit code it gives.
//
// The browser, the network and the vault are fakes. One test runs the REAL login (src/auth/login.ts)
// and the REAL token store over an in-memory vault, to prove the whole command fits together.

import { describe, expect, test } from "bun:test";
import type { SecretStore } from "../platform/secret-store.ts";
import { GRAPHQL_URL, REVOKE_URL, TOKEN_URL } from "./config.ts";
import { type LoginCommandDeps, runLoginCommand } from "./login-command.ts";
import { type LoginDeps, runLogin } from "./login.ts";
import { createTokenStore } from "./token-store.ts";
import type { Tokens } from "./token.ts";

const TOKENS: Tokens = {
  accessToken: "access-SECRET",
  refreshToken: "refresh-SECRET",
  expiresAt: 1_800_000_086_399,
  scopes: ["issues:create", "read"],
};

function memoryVault() {
  const items = new Map<string, string>();
  const vault: SecretStore = {
    get: async (name) => items.get(name) ?? null,
    set: async (name, value) => {
      items.set(name, value);
    },
    delete: async (name) => {
      items.delete(name);
    },
  };
  return { vault, items };
}

function setup(overrides: Partial<LoginCommandDeps> = {}) {
  const out: string[] = [];
  const errors: string[] = [];
  const opened: string[] = [];
  const { vault, items } = memoryVault();
  // A stand-in for the shared refresh lock that records when it is taken and let go.
  const lockEvents: string[] = [];
  const deps: LoginCommandDeps = {
    print: (line) => out.push(line),
    printError: (line) => errors.push(line),
    openBrowser: (url) => opened.push(url),
    createStore: () => createTokenStore(vault),
    lock: {
      withLock: async (task) => {
        lockEvents.push("lock");
        try {
          return await task();
        } finally {
          lockEvents.push("unlock");
        }
      },
    },
    ...overrides,
  };
  return { deps, out, errors, opened, items, vault, lockEvents };
}

describe("a successful login", () => {
  test("returns exit code 0 and hands the login its own browser, printer and a saver", async () => {
    let received: LoginDeps | undefined;
    const run = setup({
      login: async (deps) => {
        received = deps;
      },
    });
    expect(await runLoginCommand(run.deps)).toBe(0);
    expect(received?.openBrowser).toBe(run.deps.openBrowser);
    expect(received?.print).toBe(run.deps.print);
    expect(run.errors).toHaveLength(0);
  });

  test("the saver it hands over stores the tokens in the vault", async () => {
    const run = setup({
      login: async (deps) => {
        await deps.save(TOKENS);
      },
    });
    await runLoginCommand(run.deps);
    expect(await createTokenStore(run.vault).load()).toEqual(TOKENS);
  });

  test("the real login, token store and command work together end to end", async () => {
    // A fake browser that follows the login link, and a fake Linear that answers the token and workspace requests.
    const fetchFn = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url === TOKEN_URL) {
        return new Response(
          JSON.stringify({ access_token: "access-SECRET", token_type: "Bearer", expires_in: 86399, scope: "issues:create read", refresh_token: "refresh-SECRET" }),
        );
      }
      if (url === GRAPHQL_URL) return new Response(JSON.stringify({ data: { organization: { name: "Acme Corp" } } }));
      throw new Error(`unexpected request to ${url}`);
    }) as unknown as typeof fetch;

    const run = setup({
      openBrowser: (loginUrl) => {
        const link = new URL(loginUrl);
        const redirect = link.searchParams.get("redirect_uri") ?? "";
        const state = link.searchParams.get("state") ?? "";
        setTimeout(() => void fetch(`${redirect}?code=the-code&state=${state}`).catch(() => {}), 0);
      },
      login: (deps) =>
        runLogin({
          ...deps,
          fetchFn,
          now: () => 1_800_000_000_000,
          serverOptions: { ports: [0], redirectUriForPort: (p) => `http://127.0.0.1:${p}/callback`, timeoutMs: 3000 },
        }),
    });
    expect(await runLoginCommand(run.deps)).toBe(0);
    expect(run.out).toContain("Logged in to Acme Corp.");
    const saved = await createTokenStore(run.vault).load();
    expect(saved?.accessToken).toBe("access-SECRET");
    expect(saved?.refreshToken).toBe("refresh-SECRET");
    expect(saved?.expiresAt).toBe(1_800_000_000_000 + 86399 * 1000);
    expect(run.out.join("\n")).not.toContain("SECRET");
  });
});

describe("saving takes the shared lock", () => {
  test("the tokens are saved while the lock is held, never outside it", async () => {
    const events: string[] = [];
    const run = setup({
      createStore: () => ({
        load: async () => null,
        save: async () => {
          events.push("save");
        },
        clear: async () => {},
      }),
      lock: {
        withLock: async (task) => {
          events.push("lock");
          try {
            return await task();
          } finally {
            events.push("unlock");
          }
        },
      },
      login: async (deps) => {
        await deps.save(TOKENS);
      },
    });
    expect(await runLoginCommand(run.deps)).toBe(0);
    expect(events).toEqual(["lock", "save", "unlock"]);
  });

  test("the lock is let go even when saving fails", async () => {
    const run = setup({
      createStore: () => ({
        load: async () => null,
        save: async () => {
          throw new Error("Couldn't save to the Keychain.");
        },
        clear: async () => {},
      }),
      login: async (deps) => {
        await deps.save(TOKENS);
      },
    });
    expect(await runLoginCommand(run.deps)).toBe(1);
    expect(run.lockEvents).toEqual(["lock", "unlock"]);
  });

  test("a lock that can't be taken fails the login with that reason, and saves nothing", async () => {
    const run = setup({
      lock: {
        withLock: async () => {
          throw new Error("Another Tangent window is refreshing the login. Try again in a moment.");
        },
      },
      login: async (deps) => {
        await deps.save(TOKENS);
      },
    });
    expect(await runLoginCommand(run.deps)).toBe(1);
    expect(run.errors[0]).toContain("Another Tangent window");
    expect(await createTokenStore(run.vault).load()).toBeNull();
  });
});

describe("when the login fails", () => {
  test("returns exit code 1 and prints the reason on stderr, not stdout", async () => {
    const run = setup({
      login: async () => {
        throw new Error("Login cancelled.");
      },
    });
    expect(await runLoginCommand(run.deps)).toBe(1);
    expect(run.errors).toEqual(["tangent: Login cancelled."]);
    expect(run.out).toHaveLength(0);
  });

  test("a failure that isn't an Error still gives a readable message", async () => {
    const run = setup({
      login: async () => {
        throw "just a string";
      },
    });
    expect(await runLoginCommand(run.deps)).toBe(1);
    expect(run.errors).toEqual(["tangent: unknown error"]);
  });

  test("control characters are cleaned out and a long message is cut short", async () => {
    const run = setup({
      login: async () => {
        throw new Error(`bad\u001b[31m red‮ ${"x".repeat(2000)}`);
      },
    });
    await runLoginCommand(run.deps);
    const line = run.errors[0] ?? "";
    expect(line).not.toContain("\u001b");
    expect(line).not.toContain("‮");
    expect(line.length).toBeLessThan(320);
  });

  test("a failed save (the vault refuses) fails the command with that reason", async () => {
    const run = setup({
      createStore: () =>
        createTokenStore({
          get: async () => null,
          set: async () => {
            throw new Error("Couldn't save to the Keychain.");
          },
          delete: async () => {},
        }),
      login: async (deps) => {
        await deps.save(TOKENS);
      },
    });
    expect(await runLoginCommand(run.deps)).toBe(1);
    expect(run.errors[0]).toContain("Couldn't save to the Keychain.");
  });
});

describe("on a system that can't save a login", () => {
  test("says so and exits 1 before any browser opens or the login even starts", async () => {
    let loginStarted = false;
    const run = setup({
      createStore: () => {
        throw new Error("Saving a login isn't supported on linux yet. Use a LINEAR_API_KEY instead.");
      },
      login: async () => {
        loginStarted = true;
      },
    });
    expect(await runLoginCommand(run.deps)).toBe(1);
    expect(run.errors).toEqual(["tangent: Saving a login isn't supported on linux yet. Use a LINEAR_API_KEY instead."]);
    expect(loginStarted).toBe(false);
    expect(run.opened).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Ending tokens so none is left live at Linear with no copy here.

const OLD: Tokens = { accessToken: "old-access-SECRET", refreshToken: "old-refresh-SECRET", expiresAt: 1_800_000_086_399, scopes: ["issues:create", "read"] };
const NEW: Tokens = { accessToken: "new-access-SECRET", refreshToken: "new-refresh-SECRET", expiresAt: 1_800_000_086_399, scopes: ["issues:create", "read"] };

type Revoke = { token: string; hint: string };

// A fake Linear for the whole login: it answers the code exchange and the workspace lookup, and RECORDS
// every revoke. `order` (if given) is appended to as revokes happen, to check when they happen.
function fakeLinear(options: { revokeAnswer?: number | "network"; accessRevokeAnswer?: number; tokenReply?: Record<string, unknown>; order?: string[] } = {}) {
  const revokes: Revoke[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === REVOKE_URL) {
      const form = new URLSearchParams(String(init?.body));
      const hint = form.get("token_type_hint") ?? "";
      revokes.push({ token: form.get("token") ?? "", hint });
      options.order?.push(`revoke:${hint}`);
      if (options.revokeAnswer === "network") throw new Error("network down");
      const status = hint === "access_token" && options.accessRevokeAnswer !== undefined ? options.accessRevokeAnswer : (options.revokeAnswer ?? 200);
      return new Response("", { status });
    }
    if (url === TOKEN_URL) {
      return new Response(
        JSON.stringify(options.tokenReply ?? { access_token: "issued-access-SECRET", token_type: "Bearer", expires_in: 86399, scope: "issues:create read", refresh_token: "issued-refresh-SECRET" }),
      );
    }
    if (url === GRAPHQL_URL) return new Response(JSON.stringify({ data: { organization: { name: "Acme Corp" } } }));
    throw new Error(`unexpected request to ${url}`);
  }) as unknown as typeof fetch;
  return { fetchFn, revokes };
}

// A fake browser that completes the login by following the link (for the end-to-end tests).
const followLink = (loginUrl: string) => {
  const link = new URL(loginUrl);
  const redirect = link.searchParams.get("redirect_uri") ?? "";
  const state = link.searchParams.get("state") ?? "";
  setTimeout(() => void fetch(`${redirect}?code=the-code&state=${state}`).catch(() => {}), 0);
};
const realLogin = (deps: LoginDeps) =>
  runLogin({ ...deps, now: () => 1_800_000_000_000, serverOptions: { ports: [0], redirectUriForPort: (p) => `http://127.0.0.1:${p}/callback`, timeoutMs: 3000 } });

describe("logging in again ends the previous login", () => {
  test("the old tokens are revoked AFTER the new ones are saved, inside the lock, access token first; the new ones never", async () => {
    const order: string[] = [];
    const linear = fakeLinear({ order });
    const run = setup({
      fetchFn: linear.fetchFn,
      lock: {
        withLock: async (task) => {
          order.push("lock");
          try {
            return await task();
          } finally {
            order.push("unlock");
          }
        },
      },
      createStore: () => {
        const real = createTokenStore(run.vault);
        return {
          load: async () => {
            order.push("load");
            return real.load();
          },
          save: async (tokens) => {
            order.push("save");
            return real.save(tokens);
          },
          clear: () => real.clear(),
        };
      },
      login: async (deps) => {
        await deps.save(NEW);
        deps.print("Logged in to Acme Corp.");
      },
    });
    await createTokenStore(run.vault).save(OLD);
    expect(await runLoginCommand(run.deps)).toBe(0);
    expect(order).toEqual(["lock", "load", "save", "revoke:access_token", "revoke:refresh_token", "unlock"]);
    expect(linear.revokes).toEqual([
      { token: "old-access-SECRET", hint: "access_token" },
      { token: "old-refresh-SECRET", hint: "refresh_token" },
    ]);
    expect((await createTokenStore(run.vault).load())?.accessToken).toBe("new-access-SECRET"); // the new login is what is saved
  });

  test("it says so after the login's own messages, and only then", async () => {
    const run = setup({
      fetchFn: fakeLinear().fetchFn,
      login: async (deps) => {
        await deps.save(NEW);
        deps.print("Logged in to Acme Corp.");
      },
    });
    await createTokenStore(run.vault).save(OLD);
    await runLoginCommand(run.deps);
    expect(run.out).toEqual(["Logged in to Acme Corp.", "Your previous login was ended."]);
  });

  test("with no previous login there is nothing to end: no request, no extra line", async () => {
    const linear = fakeLinear();
    const run = setup({
      fetchFn: linear.fetchFn,
      login: async (deps) => {
        await deps.save(NEW);
      },
    });
    expect(await runLoginCommand(run.deps)).toBe(0);
    expect(linear.revokes).toHaveLength(0);
    expect(run.out.join(" ")).not.toContain("previous");
  });

  test("saving the SAME login again ends nothing (it would end the login just saved)", async () => {
    const linear = fakeLinear();
    const run = setup({
      fetchFn: linear.fetchFn,
      login: async (deps) => {
        await deps.save(OLD);
      },
    });
    await createTokenStore(run.vault).save(OLD);
    await runLoginCommand(run.deps);
    expect(linear.revokes).toHaveLength(0);
  });

  test("if saving the new login FAILS, the old login is left alone (it is still the one that works)", async () => {
    const linear = fakeLinear();
    const run = setup({
      fetchFn: linear.fetchFn,
      createStore: () => ({
        load: async () => OLD,
        save: async () => {
          throw new Error("the Keychain is locked");
        },
        clear: async () => {},
      }),
      login: async (deps) => {
        await deps.save(NEW);
      },
    });
    expect(await runLoginCommand(run.deps)).toBe(1);
    expect(linear.revokes).toHaveLength(0);
  });

  test("a vault that can't be read means there is nothing to end, and the login still goes ahead", async () => {
    const linear = fakeLinear();
    const run = setup({
      fetchFn: linear.fetchFn,
      createStore: () => ({
        load: async () => {
          throw new Error("Couldn't read from the Keychain.");
        },
        save: async () => {},
        clear: async () => {},
      }),
      login: async (deps) => {
        await deps.save(NEW);
      },
    });
    expect(await runLoginCommand(run.deps)).toBe(0);
    expect(linear.revokes).toHaveLength(0);
  });

  test("failing to end the old login never fails the new one, and doesn't claim it was ended", async () => {
    for (const options of [{ revokeAnswer: "network" as const }, { accessRevokeAnswer: 500 }, { revokeAnswer: 503 }]) {
      const run = setup({
        fetchFn: fakeLinear(options).fetchFn,
        login: async (deps) => {
          await deps.save(NEW);
          deps.print("Logged in.");
        },
      });
      await createTokenStore(run.vault).save(OLD);
      expect(await runLoginCommand(run.deps)).toBe(0);
      expect(run.out).toEqual(["Logged in."]); // no "previous login was ended"
      expect((await createTokenStore(run.vault).load())?.accessToken).toBe("new-access-SECRET");
    }
  });

  test("an old login that Linear had already ended counts as ended", async () => {
    const run = setup({
      fetchFn: fakeLinear({ revokeAnswer: 401 }).fetchFn,
      login: async (deps) => {
        await deps.save(NEW);
      },
    });
    await createTokenStore(run.vault).save(OLD);
    await runLoginCommand(run.deps);
    expect(run.out).toContain("Your previous login was ended.");
  });

  test("end to end with the REAL login: the new login is saved and the old one is revoked at Linear", async () => {
    const linear = fakeLinear();
    const run = setup({ fetchFn: linear.fetchFn, openBrowser: followLink, login: realLogin });
    await createTokenStore(run.vault).save(OLD);
    expect(await runLoginCommand(run.deps)).toBe(0);
    const saved = await createTokenStore(run.vault).load();
    expect(saved?.accessToken).toBe("issued-access-SECRET");
    expect(linear.revokes.map((r) => r.token)).toEqual(["old-access-SECRET", "old-refresh-SECRET"]);
    expect(run.out.join("\n")).not.toContain("SECRET");
  });
});

describe("tokens Linear issued but we can't keep are ended (the discard hook)", () => {
  test("the hook revokes what it is given: access token first, then refresh token", async () => {
    const linear = fakeLinear();
    const run = setup({
      fetchFn: linear.fetchFn,
      login: async (deps) => {
        await deps.discard?.({ accessToken: "a-SECRET", refreshToken: "r-SECRET" });
      },
    });
    await runLoginCommand(run.deps);
    expect(linear.revokes).toEqual([
      { token: "a-SECRET", hint: "access_token" },
      { token: "r-SECRET", hint: "refresh_token" },
    ]);
  });

  test("it revokes only what is there", async () => {
    const linear = fakeLinear();
    const run = setup({
      fetchFn: linear.fetchFn,
      login: async (deps) => {
        await deps.discard?.({ refreshToken: "only-refresh" });
        await deps.discard?.({});
      },
    });
    await runLoginCommand(run.deps);
    expect(linear.revokes).toEqual([{ token: "only-refresh", hint: "refresh_token" }]);
  });

  test("a hook whose requests fail doesn't throw", async () => {
    const run = setup({
      fetchFn: fakeLinear({ revokeAnswer: "network" }).fetchFn,
      login: async (deps) => {
        await deps.discard?.({ accessToken: "a", refreshToken: "r" });
      },
    });
    expect(await runLoginCommand(run.deps)).toBe(0);
  });

  test("end to end with the REAL login: saving fails after Linear issued tokens, so those exact tokens are revoked", async () => {
    const linear = fakeLinear();
    const run = setup({
      fetchFn: linear.fetchFn,
      openBrowser: followLink,
      login: realLogin,
      createStore: () => ({
        load: async () => null,
        save: async () => {
          throw new Error("the Keychain is locked");
        },
        clear: async () => {},
      }),
    });
    expect(await runLoginCommand(run.deps)).toBe(1);
    expect(run.errors.join(" ")).toContain("Couldn't save the login");
    expect(run.errors.join(" ")).not.toContain("SECRET");
    expect(linear.revokes).toEqual([
      { token: "issued-access-SECRET", hint: "access_token" },
      { token: "issued-refresh-SECRET", hint: "refresh_token" },
    ]);
  });

  test("end to end with the REAL login: tokens that fail our checks are revoked, nothing is saved, and none is printed", async () => {
    const linear = fakeLinear({
      tokenReply: { access_token: "bad\nSECRET", token_type: "Bearer", expires_in: 86399, scope: "issues:create read", refresh_token: "good-refresh-SECRET" },
    });
    const run = setup({ fetchFn: linear.fetchFn, openBrowser: followLink, login: realLogin });
    expect(await runLoginCommand(run.deps)).toBe(1);
    expect(await createTokenStore(run.vault).load()).toBeNull();
    expect(linear.revokes).toEqual([
      { token: "bad\nSECRET", hint: "access_token" },
      { token: "good-refresh-SECRET", hint: "refresh_token" },
    ]);
    expect(`${run.out.join("\n")}\n${run.errors.join("\n")}`).not.toContain("SECRET");
  });

  test("nothing is revoked when the login succeeds, or the person cancels", async () => {
    const ok = fakeLinear();
    const done = setup({ fetchFn: ok.fetchFn, openBrowser: followLink, login: realLogin });
    expect(await runLoginCommand(done.deps)).toBe(0);
    expect(ok.revokes).toHaveLength(0); // no previous login, nothing refused
    const cancelled = fakeLinear();
    const run = setup({
      fetchFn: cancelled.fetchFn,
      login: async () => {
        throw new Error("Login cancelled.");
      },
    });
    expect(await runLoginCommand(run.deps)).toBe(1);
    expect(cancelled.revokes).toHaveLength(0);
  });
});
