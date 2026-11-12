// Tests for src/auth/login-command.ts: what `tangent login` does and the exit code it gives.
//
// The browser, the network and the vault are fakes. One test runs the REAL login (src/auth/login.ts)
// and the REAL token store over an in-memory vault, to prove the whole command fits together.

import { describe, expect, test } from "bun:test";
import type { SecretStore } from "../platform/secret-store.ts";
import { GRAPHQL_URL, TOKEN_URL } from "./config.ts";
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
  const deps: LoginCommandDeps = {
    print: (line) => out.push(line),
    printError: (line) => errors.push(line),
    openBrowser: (url) => opened.push(url),
    createStore: () => createTokenStore(vault),
    ...overrides,
  };
  return { deps, out, errors, opened, items, vault };
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
