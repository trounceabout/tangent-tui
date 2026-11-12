// Tests for src/auth/token-store.ts: saving and loading the login tokens.
//
// Mostly against an in-memory fake vault. One group runs it on top of the REAL macOS secret
// store code with a fake `security` tool, to prove the two fit together (names, size cap).
// Nothing here touches the real Keychain.

import { describe, expect, test } from "bun:test";
import { DamagedSecretError, type Run, type SecretStore, createMacSecretStore } from "../platform/secret-store.ts";
import { TOKENS_SECRET_NAME, createTokenStore, parseStoredTokens } from "./token-store.ts";
import type { Tokens } from "./token.ts";

const TOKENS: Tokens = {
  accessToken: `lin_oauth_${"a".repeat(64)}`,
  refreshToken: `lin_refresh_${"b".repeat(64)}`,
  expiresAt: 1_800_000_086_399,
  scopes: ["issues:create", "read"],
};

// A vault in memory. `getThrows` makes reading fail, like a locked Keychain.
function memoryVault(options: { getThrows?: boolean; setThrows?: boolean; getDamaged?: boolean } = {}) {
  const items = new Map<string, string>();
  const calls: string[] = [];
  const vault: SecretStore = {
    async get(name) {
      calls.push(`get:${name}`);
      if (options.getThrows) throw new Error("Couldn't read from the Keychain.");
      if (options.getDamaged) throw new DamagedSecretError();
      return items.get(name) ?? null;
    },
    async set(name, value) {
      calls.push(`set:${name}`);
      if (options.setThrows) throw new Error("That secret is too large to store safely.");
      items.set(name, value);
    },
    async delete(name) {
      calls.push(`delete:${name}`);
      items.delete(name);
    },
  };
  return { vault, items, calls };
}

// A valid saved blob, with one thing changed.
const blob = (changes: Record<string, unknown> = {}) => JSON.stringify({ version: 1, ...TOKENS, ...changes });

const messageOf = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected a failure");
};

describe("save and load", () => {
  test("tokens come back exactly as saved", async () => {
    const { vault } = memoryVault();
    const store = createTokenStore(vault);
    await store.save(TOKENS);
    expect(await store.load()).toEqual(TOKENS);
  });

  test("nothing saved means null", async () => {
    expect(await createTokenStore(memoryVault().vault).load()).toBeNull();
  });

  test("saving again replaces the earlier tokens", async () => {
    const store = createTokenStore(memoryVault().vault);
    await store.save(TOKENS);
    await store.save({ ...TOKENS, accessToken: "second-access", expiresAt: 1_900_000_000_000 });
    expect((await store.load())?.accessToken).toBe("second-access");
  });

  test("clear forgets the login, and clearing when there is none is fine", async () => {
    const store = createTokenStore(memoryVault().vault);
    await store.clear();
    await store.save(TOKENS);
    await store.clear();
    expect(await store.load()).toBeNull();
  });

  test("it is stored under one fixed name, as versioned JSON with only the known fields", async () => {
    const { vault, items } = memoryVault();
    await createTokenStore(vault).save(TOKENS);
    expect([...items.keys()]).toEqual([TOKENS_SECRET_NAME]);
    expect(JSON.parse(items.get(TOKENS_SECRET_NAME) ?? "")).toEqual({ version: 1, ...TOKENS });
  });
});

describe("loading something that isn't ours", () => {
  test("extra fields in the saved blob are not carried along", () => {
    // Built as text: a real "__proto__" key in JSON becomes an own property when parsed.
    const withExtras = blob({ evil: "x" }).replace(/}$/, ',"__proto__":{"admin":true}}');
    const loaded = parseStoredTokens(withExtras);
    expect(loaded).toEqual(TOKENS);
    expect(Object.keys(loaded ?? {}).sort()).toEqual(["accessToken", "expiresAt", "refreshToken", "scopes"]);
  });

  const badBlobs: [string, string][] = [
    ["not JSON", "this is not json"],
    ["empty text", ""],
    ["JSON null", "null"],
    ["a number", "42"],
    ["a list", "[1,2,3]"],
    ["a string", '"hello"'],
    ["no version", JSON.stringify(TOKENS)],
    ["another version", blob({ version: 2 })],
    ["version as text", blob({ version: "1" })],
    ["no access token", blob({ accessToken: undefined })],
    ["empty access token", blob({ accessToken: "" })],
    ["access token not text", blob({ accessToken: 123 })],
    ["access token too long", blob({ accessToken: "x".repeat(301) })],
    ["access token with a line break", blob({ accessToken: "abc\r\nSECRET" })],
    ["access token with a space", blob({ accessToken: "abc SECRET" })],
    ["access token outside Latin-1", blob({ accessToken: "abc\u20acSECRET" })],
    ["access token with a quote", blob({ accessToken: 'abc"SECRET' })],
    ["access token with a backslash", blob({ accessToken: "abc\\SECRET" })],
    ["no refresh token", blob({ refreshToken: undefined })],
    ["empty refresh token", blob({ refreshToken: "" })],
    ["refresh token not text", blob({ refreshToken: { a: 1 } })],
    ["refresh token too long", blob({ refreshToken: "x".repeat(301) })],
    ["refresh token with a line break", blob({ refreshToken: "abc\r\nSECRET" })],
    ["refresh token outside Latin-1", blob({ refreshToken: "abc\u20acSECRET" })],
    ["no expiry", blob({ expiresAt: undefined })],
    ["expiry as text", blob({ expiresAt: "1800000086399" })],
    ["expiry zero", blob({ expiresAt: 0 })],
    ["expiry negative", blob({ expiresAt: -5 })],
    ["expiry null", blob({ expiresAt: null })],
    ["scopes missing", blob({ scopes: undefined })],
    ["scopes not a list", blob({ scopes: "read" })],
    ["a scope that isn't text", blob({ scopes: ["read", 7] })],
    ["a scope with a space", blob({ scopes: ["read write"] })],
    ["a scope with odd characters", blob({ scopes: ["<script>"] })],
    ["a scope that is too long", blob({ scopes: ["a".repeat(41)] })],
    ["too many scopes", blob({ scopes: Array.from({ length: 9 }, (_, i) => `s${i}`) })],
  ];

  test.each(badBlobs)("%s is treated as not logged in", (_label, text) => {
    expect(parseStoredTokens(text)).toBeNull();
  });

  test("the strict checks don't reject a good blob (so the table above is meaningful)", () => {
    expect(parseStoredTokens(blob())).toEqual(TOKENS);
  });

  test("a blob from another version is left alone, not deleted", async () => {
    const { vault, items } = memoryVault();
    items.set(TOKENS_SECRET_NAME, blob({ version: 2 }));
    expect(await createTokenStore(vault).load()).toBeNull();
    expect(items.get(TOKENS_SECRET_NAME)).toBe(blob({ version: 2 }));
  });

  test("a damaged blob is left alone too (the next login simply replaces it)", async () => {
    const { vault, items } = memoryVault();
    items.set(TOKENS_SECRET_NAME, "garbage");
    expect(await createTokenStore(vault).load()).toBeNull();
    expect(items.get(TOKENS_SECRET_NAME)).toBe("garbage");
  });
});

describe("an item in the vault that isn't ours", () => {
  test("a DamagedSecretError from the vault is 'not logged in' (null), not an error", async () => {
    const store = createTokenStore(memoryVault({ getDamaged: true }).vault);
    expect(await store.load()).toBeNull();
  });

  test("a vault that can't be read is still an error, never 'not logged in'", async () => {
    const store = createTokenStore(memoryVault({ getThrows: true }).vault);
    expect(await messageOf(store.load())).toContain("Couldn't read");
  });

  test("end to end through the real macOS store code: text that isn't base64url is null, and is left in place", async () => {
    const items = new Map<string, string>([[TOKENS_SECRET_NAME, "7b22 not base64url!"]]);
    const run: Run = async (command) => {
      const name = command[command.indexOf("-s") + 1] ?? "";
      const stored = items.get(name);
      return stored === undefined ? { exitCode: 44, stdout: "", stderr: "" } : { exitCode: 0, stdout: `${stored}\n`, stderr: "" };
    };
    expect(await createTokenStore(createMacSecretStore(run)).load()).toBeNull();
    expect(items.get(TOKENS_SECRET_NAME)).toBe("7b22 not base64url!");
  });

  test("a saved login replaces a damaged one", async () => {
    const { vault, items } = memoryVault();
    items.set(TOKENS_SECRET_NAME, "garbage");
    const store = createTokenStore(vault);
    await store.save(TOKENS);
    expect(await store.load()).toEqual(TOKENS);
  });
});

describe("saving bad tokens", () => {
  const badTokens: [string, Tokens][] = [
    ["an empty access token", { ...TOKENS, accessToken: "" }],
    ["an access token that is too long", { ...TOKENS, accessToken: "x".repeat(301) }],
    ["an access token with a line break", { ...TOKENS, accessToken: "abc\nSECRET" }],
    ["a refresh token outside Latin-1", { ...TOKENS, refreshToken: "abc\u20acSECRET" }],
    ["an empty refresh token", { ...TOKENS, refreshToken: "" }],
    ["an expiry that isn't a number", { ...TOKENS, expiresAt: Number.NaN }],
    ["an expiry in the infinite future", { ...TOKENS, expiresAt: Number.POSITIVE_INFINITY }],
    ["an expiry of zero", { ...TOKENS, expiresAt: 0 }],
    ["a scope with a space", { ...TOKENS, scopes: ["read write"] }],
    ["too many scopes", { ...TOKENS, scopes: Array.from({ length: 9 }, (_, i) => `s${i}`) }],
  ];

  test.each(badTokens)("refuses %s, and never touches the vault", async (_label, tokens) => {
    const { vault, calls } = memoryVault();
    expect(await messageOf(createTokenStore(vault).save(tokens))).toContain("can store safely");
    expect(calls).toHaveLength(0);
  });
});

describe("when the vault itself fails", () => {
  test("a vault that can't be read is an error, not 'not logged in'", async () => {
    const store = createTokenStore(memoryVault({ getThrows: true }).vault);
    expect(await messageOf(store.load())).toContain("Couldn't read");
  });

  test("a vault that can't store is an error", async () => {
    const store = createTokenStore(memoryVault({ setThrows: true }).vault);
    expect(await messageOf(store.save(TOKENS))).toContain("too large");
  });
});

describe("on top of the real macOS secret store code", () => {
  // A compact fake `security`, enough to run createMacSecretStore end to end.
  function fakeSecurity(): Run {
    const items = new Map<string, string>();
    return async (command, options = {}) => {
      const sub = command[1];
      const name = command[command.indexOf("-s") + 1] ?? "";
      if (sub === "-i") {
        const line = options.stdin ?? "";
        items.set(/-s (\S+)/.exec(line)?.[1] ?? "", Buffer.from(/-X (\S+)/.exec(line)?.[1] ?? "", "hex").toString("ascii"));
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (sub === "find-generic-password") {
        const stored = items.get(name);
        return stored === undefined ? { exitCode: 44, stdout: "", stderr: "" } : { exitCode: 0, stdout: `${stored}\n`, stderr: "" };
      }
      return items.delete(name) ? { exitCode: 0, stdout: "", stderr: "" } : { exitCode: 44, stdout: "", stderr: "" };
    };
  }

  test("a normal login round-trips (so the name and format are accepted)", async () => {
    const store = createTokenStore(createMacSecretStore(fakeSecurity()));
    await store.save(TOKENS);
    expect(await store.load()).toEqual(TOKENS);
    await store.clear();
    expect(await store.load()).toBeNull();
  });

  test("the largest tokens the store allows still fit under the secret store's size cap", async () => {
    // If someone raises the token limits without checking the cap, this fails.
    // Every character is one that JSON has to treat specially IF it were allowed (a slash, a plus, an
    // equals sign): the alphabet is chosen so none of them is escaped, which is what makes the size
    // predictable. (A rule allowing quotes or backslashes would double those characters and break this.)
    const biggest: Tokens = {
      accessToken: "/+=".repeat(100),
      refreshToken: "=+/".repeat(100),
      expiresAt: 9_007_199_254_740_991, // the largest safe integer: the longest a number can be
      scopes: Array.from({ length: 8 }, () => "a:._-".repeat(8)),
    };
    const store = createTokenStore(createMacSecretStore(fakeSecurity()));
    await store.save(biggest);
    expect(await store.load()).toEqual(biggest);
    // And the saved text is comfortably inside the secret store's 1,700-character cap.
    const asJson = JSON.stringify({ version: 1, ...biggest });
    expect(Buffer.from(asJson).toString("base64url").length).toBeLessThan(1500);
  });
});
