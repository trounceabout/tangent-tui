// Tests for src/auth/logout-command.ts: what `tangent logout` does, in what order, and its exit code.
//
// The vault, the lock, the network and the printing are all fakes, sharing one event log so the
// ORDER of steps can be checked. One test uses the real lock in a temp folder. Token values contain
// "SECRET" so a leak into anything printed is easy to spot.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REVOKE_URL } from "./config.ts";
import { createFileLock } from "./lock.ts";
import { type LogoutCommandDeps, runLogoutCommand } from "./logout-command.ts";
import type { TokenStore } from "./token-store.ts";
import type { Tokens } from "./token.ts";

const TOKENS: Tokens = {
  accessToken: "access-SECRET",
  refreshToken: "refresh-SECRET",
  expiresAt: 1_800_000_086_399,
  scopes: ["issues:create", "read"],
};

type Revoke = { token: string; hint: string };

function setup(
  options: {
    tokens?: Tokens | null;
    loadThrows?: boolean;
    clearThrows?: boolean;
    createStoreThrows?: boolean;
    // What Linear answers for each kind of token (default 200). "network" means no answer at all.
    refreshAnswer?: number | "network";
    accessAnswer?: number | "network";
    lockThrows?: string;
    env?: Record<string, string | undefined>;
  } = {},
) {
  const events: string[] = [];
  const out: string[] = [];
  const errors: string[] = [];
  const revokes: Revoke[] = [];
  let saved: Tokens | null = options.tokens === undefined ? TOKENS : options.tokens;

  const store: TokenStore = {
    async load() {
      events.push("load");
      if (options.loadThrows) throw new Error("Couldn't read from the Keychain.");
      return saved;
    },
    async save(tokens) {
      saved = tokens;
    },
    async clear() {
      events.push("clear");
      if (options.clearThrows) throw new Error("the Keychain is locked SECRET-DETAIL");
      saved = null;
    },
  };

  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const form = new URLSearchParams(String(init?.body));
    const hint = form.get("token_type_hint") ?? "";
    revokes.push({ token: form.get("token") ?? "", hint });
    events.push(`revoke:${hint}`);
    expect(String(input)).toBe(REVOKE_URL);
    const answer = hint === "refresh_token" ? (options.refreshAnswer ?? 200) : (options.accessAnswer ?? 200);
    if (answer === "network") throw new Error("network down");
    return new Response("", { status: answer });
  }) as unknown as typeof fetch;

  const deps: LogoutCommandDeps = {
    print: (line) => out.push(line),
    printError: (line) => errors.push(line),
    createStore: () => {
      if (options.createStoreThrows) throw new Error("Saving a login isn't supported on linux yet.");
      return store;
    },
    lock: {
      withLock: async (task) => {
        events.push("lock");
        if (options.lockThrows) {
          events.push("unlock");
          throw new Error(options.lockThrows);
        }
        try {
          return await task();
        } finally {
          events.push("unlock");
        }
      },
    },
    fetchFn,
    env: options.env ?? {},
  };
  return { deps, events, out, errors, revokes, saved: () => saved };
}

const everything = (run: ReturnType<typeof setup>) => [...run.out, ...run.errors].join("\n");

describe("a normal logout", () => {
  test("exits 0 and says it was ended at Linear and removed from this computer", async () => {
    const run = setup();
    expect(await runLogoutCommand(run.deps)).toBe(0);
    expect(run.out.join(" ")).toContain("Logged out.");
    expect(run.out.join(" ")).toContain("ended at Linear and removed from this computer");
    expect(run.errors).toHaveLength(0);
    expect(run.saved()).toBeNull();
  });

  test("steps happen in this order: lock, load, revoke refresh, revoke access, delete, unlock", async () => {
    const run = setup();
    await runLogoutCommand(run.deps);
    expect(run.events).toEqual(["lock", "load", "revoke:refresh_token", "revoke:access_token", "clear", "unlock"]);
  });

  test("it revokes the right token for each kind, with nothing else sent", async () => {
    const run = setup();
    await runLogoutCommand(run.deps);
    expect(run.revokes).toEqual([
      { token: "refresh-SECRET", hint: "refresh_token" },
      { token: "access-SECRET", hint: "access_token" },
    ]);
  });

  test("revoking comes BEFORE deleting, so a crash in between can't leave a live token with no copy", async () => {
    const run = setup();
    await runLogoutCommand(run.deps);
    expect(run.events.indexOf("revoke:access_token")).toBeLessThan(run.events.indexOf("clear"));
  });

  test("a refresh already revoked by the first call (access answers 'already gone') still counts as a clean logout", async () => {
    // Revoking the refresh token ends the whole login, so the access token often answers 400/401 afterwards.
    const run = setup({ accessAnswer: 401 });
    expect(await runLogoutCommand(run.deps)).toBe(0);
    expect(run.out.join(" ")).toContain("ended at Linear and removed");
  });
});

describe("Linear had already ended the login", () => {
  test("both tokens answer 'already gone': exit 0, and it says so", async () => {
    const run = setup({ refreshAnswer: 400, accessAnswer: 401 });
    expect(await runLogoutCommand(run.deps)).toBe(0);
    expect(run.out.join(" ")).toContain("already ended");
    expect(run.saved()).toBeNull();
  });
});

describe("Linear can't be reached or won't say (the login may still be live)", () => {
  test("no network: the local copy is STILL deleted, but it exits 1 and says where to end it by hand", async () => {
    const run = setup({ refreshAnswer: "network", accessAnswer: "network" });
    expect(await runLogoutCommand(run.deps)).toBe(1);
    expect(run.events).toContain("clear");
    expect(run.saved()).toBeNull();
    const text = run.errors.join(" ");
    expect(text).toContain("couldn't confirm Linear ended it");
    expect(text).toContain("Authorized applications");
    expect(run.out.join(" ")).not.toContain("Logged out");
  });

  test("Linear erroring (503) on the refresh token is the same", async () => {
    const run = setup({ refreshAnswer: 503 });
    expect(await runLogoutCommand(run.deps)).toBe(1);
    expect(run.saved()).toBeNull();
  });

  test("failing only on the access token is NOT a clean logout either", async () => {
    const run = setup({ accessAnswer: 500 });
    expect(await runLogoutCommand(run.deps)).toBe(1);
    expect(run.errors.join(" ")).toContain("couldn't confirm");
  });
});

describe("when the local copy can't be removed", () => {
  test("after a confirmed revoke: exit 1, and it says the login no longer works", async () => {
    const run = setup({ clearThrows: true });
    expect(await runLogoutCommand(run.deps)).toBe(1);
    expect(run.errors.join(" ")).toContain("no longer works");
    expect(run.errors.join(" ")).not.toContain("SECRET");
  });

  test("and Linear wasn't reached either: says so, and where to end it by hand", async () => {
    const run = setup({ clearThrows: true, refreshAnswer: "network" });
    expect(await runLogoutCommand(run.deps)).toBe(1);
    expect(run.errors.join(" ")).toContain("confirm that Linear ended it");
    expect(run.errors.join(" ")).toContain("Authorized applications");
  });
});

describe("when there is nothing to log out of", () => {
  test("no saved login: says so, exits 0, and makes no network request", async () => {
    const run = setup({ tokens: null });
    expect(await runLogoutCommand(run.deps)).toBe(0);
    expect(run.out.join(" ")).toContain("You weren't logged in");
    expect(run.revokes).toHaveLength(0);
  });

  test("it still clears whatever is saved (a damaged or newer-version blob the loader leaves alone)", async () => {
    const run = setup({ tokens: null });
    await runLogoutCommand(run.deps);
    expect(run.events).toContain("clear");
  });

  test("a system that can't save a login: exit 0, no lock, no network", async () => {
    const run = setup({ createStoreThrows: true });
    expect(await runLogoutCommand(run.deps)).toBe(0);
    expect(run.out.join(" ")).toContain("No saved login on this computer");
    expect(run.events).toHaveLength(0);
    expect(run.revokes).toHaveLength(0);
  });
});

describe("when something goes wrong before anything is changed", () => {
  test("a vault that can't be read: exit 1, nothing revoked or deleted, lock let go", async () => {
    const run = setup({ loadThrows: true });
    expect(await runLogoutCommand(run.deps)).toBe(1);
    expect(run.errors.join(" ")).toContain("Couldn't read your saved login");
    expect(run.errors.join(" ")).toContain("Nothing was changed");
    expect(run.revokes).toHaveLength(0);
    expect(run.events).not.toContain("clear");
    expect(run.events.at(-1)).toBe("unlock");
  });

  test("the lock can't be taken: exit 1 with that reason, and nothing is touched", async () => {
    const run = setup({ lockThrows: "Another Tangent window is refreshing the login. Try again in a moment." });
    expect(await runLogoutCommand(run.deps)).toBe(1);
    expect(run.errors.join(" ")).toContain("Another Tangent window");
    expect(run.revokes).toHaveLength(0);
    expect(run.saved()).toEqual(TOKENS);
  });
});

describe("LINEAR_API_KEY", () => {
  test("if it is set, a successful logout says Tangent will use it", async () => {
    const run = setup({ env: { LINEAR_API_KEY: "lin_api_env" } });
    await runLogoutCommand(run.deps);
    expect(run.out.join(" ")).toContain("LINEAR_API_KEY is set");
  });

  test("so does 'you weren't logged in'", async () => {
    const run = setup({ tokens: null, env: { LINEAR_API_KEY: "lin_api_env" } });
    await runLogoutCommand(run.deps);
    expect(run.out.join(" ")).toContain("LINEAR_API_KEY is set");
  });

  test("a blank or missing variable isn't mentioned", async () => {
    for (const value of ["", "   ", undefined]) {
      const run = setup({ env: { LINEAR_API_KEY: value } });
      await runLogoutCommand(run.deps);
      expect(run.out.join(" ")).not.toContain("LINEAR_API_KEY");
    }
  });
});

describe("the lock", () => {
  const scenarios = [
    ["a normal logout", {}],
    ["no network", { refreshAnswer: "network" as const }],
    ["a failed delete", { clearThrows: true }],
    ["a vault that can't be read", { loadThrows: true }],
    ["nothing saved", { tokens: null }],
  ] as const;

  test.each(scenarios)("is let go after %s", async (_label, options) => {
    const run = setup(options);
    await runLogoutCommand(run.deps);
    expect(run.events[0]).toBe("lock");
    expect(run.events.at(-1)).toBe("unlock");
  });

  describe("the real lock, in a temp folder", () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "tangent-logout-"));
    });
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    test("another window holding it too long fails the logout with a clear message and changes nothing", async () => {
      const lockPath = join(dir, "login.lock");
      mkdirSync(lockPath); // another window holds it
      const run = setup();
      run.deps.lock = createFileLock(lockPath, { timeoutMs: 80, pollMs: 10, staleMs: 60_000 });
      expect(await runLogoutCommand(run.deps)).toBe(1);
      expect(run.errors.join(" ")).toContain("Another Tangent window");
      expect(run.revokes).toHaveLength(0);
      expect(run.saved()).toEqual(TOKENS);
    });
  });
});

describe("what is printed", () => {
  const scenarios = [
    ["a normal logout", {}],
    ["already ended", { refreshAnswer: 400, accessAnswer: 400 }],
    ["no network", { refreshAnswer: "network" as const, accessAnswer: "network" as const }],
    ["a failed delete", { clearThrows: true }],
    ["a failed delete and no network", { clearThrows: true, refreshAnswer: "network" as const }],
    ["nothing saved", { tokens: null }],
    ["a vault that can't be read", { loadThrows: true }],
  ] as const;

  test.each(scenarios)("never contains a token or a vault's error detail (%s)", async (_label, options) => {
    const run = setup(options);
    await runLogoutCommand(run.deps);
    expect(everything(run)).not.toContain("SECRET");
  });

  test.each(scenarios)("keeps every line short enough for a narrow pane (%s)", async (_label, options) => {
    const run = setup(options);
    await runLogoutCommand(run.deps);
    for (const line of [...run.out, ...run.errors]) {
      expect(line.length).toBeLessThanOrEqual(50);
    }
  });

  test("errors go to stderr and carry the program's name on their first line", async () => {
    const run = setup({ refreshAnswer: "network" });
    await runLogoutCommand(run.deps);
    expect(run.errors[0]?.startsWith("tangent: ")).toBe(true);
    expect(run.errors.slice(1).every((line) => !line.startsWith("tangent: "))).toBe(true);
  });

  test("a vault error's text is cleaned and cut short", async () => {
    const run = setup({ loadThrows: true });
    // Swap in a store whose error is nasty.
    run.deps.createStore = () => ({
      load: async () => {
        throw new Error(`bad\u001b[31m red‮ ${"x".repeat(2000)}`);
      },
      save: async () => {},
      clear: async () => {},
    });
    await runLogoutCommand(run.deps);
    const line = run.errors[0] ?? "";
    expect(line).not.toContain("\u001b");
    expect(line).not.toContain("‮");
    expect(line.length).toBeLessThan(320);
  });
});
