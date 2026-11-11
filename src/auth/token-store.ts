// src/auth/token-store.ts
// Saves and loads the browser-login tokens, as one blob in the secret store (the OS vault).
// Never a file, never an environment variable. See issue #69.
//
// The blob is read back from somewhere other programs could in principle write to, so loading
// it is as strict as reading Linear's reply: anything that isn't exactly what we saved is
// treated as "not logged in" (null), never trusted and never a crash.

import type { SecretStore } from "../platform/secret-store.ts";
import type { Tokens } from "./token.ts";

// The name the tokens are stored under. (A plain `tangent-oauth`: the secret store only
// accepts lowercase letters, digits and . _ - in names.)
export const TOKENS_SECRET_NAME = "tangent-oauth";

// Bumped if the saved shape ever changes. A blob with another version is left alone, not
// deleted: it may have been written by a newer Tangent, which an older one must not destroy.
const FORMAT_VERSION = 1;

// Limits that keep the whole blob safely under the secret store's size cap (a test checks that
// the largest allowed blob still fits). Linear's tokens are about 75 characters, so this is generous.
const MAX_TOKEN_CHARS = 300;
const MAX_SCOPES = 8;
const SCOPE_NAME = /^[A-Za-z0-9:_.-]{1,40}$/; // the same rule token.ts applies to Linear's reply

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isToken = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= MAX_TOKEN_CHARS;

// Is this exactly a well-formed Tokens? Used both before saving and after loading.
function isValidTokens(value: unknown): value is Tokens {
  if (!isObject(value)) return false;
  const { accessToken, refreshToken, expiresAt, scopes } = value;
  return (
    isToken(accessToken) &&
    isToken(refreshToken) &&
    typeof expiresAt === "number" &&
    Number.isFinite(expiresAt) &&
    expiresAt > 0 &&
    Array.isArray(scopes) &&
    scopes.length <= MAX_SCOPES &&
    scopes.every((scope) => typeof scope === "string" && SCOPE_NAME.test(scope))
  );
}

// Text -> Tokens, or null if it isn't a well-formed blob of ours. Pure, so it is easy to test.
export function parseStoredTokens(text: string): Tokens | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(data) || data.version !== FORMAT_VERSION || !isValidTokens(data)) return null;
  // Copy only the fields we know, so nothing extra that was in the blob is carried along.
  return { accessToken: data.accessToken, refreshToken: data.refreshToken, expiresAt: data.expiresAt, scopes: [...data.scopes] };
}

export interface TokenStore {
  // The saved tokens, or null if there are none or what is saved isn't usable. Throws only if
  // the vault itself can't be read (locked, unavailable).
  load(): Promise<Tokens | null>;
  // Save the tokens, replacing any earlier ones. Throws if they are malformed or can't be stored.
  save(tokens: Tokens): Promise<void>;
  // Forget the saved login (a no-op if there isn't one).
  clear(): Promise<void>;
}

export function createTokenStore(secrets: SecretStore): TokenStore {
  return {
    async load() {
      const text = await secrets.get(TOKENS_SECRET_NAME);
      return text === null ? null : parseStoredTokens(text);
    },

    async save(tokens) {
      // Check before storing, so garbage is never saved as if it were a login.
      if (!isValidTokens(tokens)) throw new Error("Those login tokens aren't in a form Tangent can store safely.");
      const blob = {
        version: FORMAT_VERSION,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
        scopes: tokens.scopes,
      };
      await secrets.set(TOKENS_SECRET_NAME, JSON.stringify(blob));
    },

    async clear() {
      await secrets.delete(TOKENS_SECRET_NAME);
    },
  };
}
