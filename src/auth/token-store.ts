// src/auth/token-store.ts
// Saves and loads the browser-login tokens, as one blob in the secret store (the OS vault).
// Never a file, never an environment variable. See issue #69.
//
// The blob is read back from somewhere other programs could in principle write to, so loading
// it is as strict as reading Linear's reply: anything that isn't exactly what we saved is
// treated as "not logged in" (null), never trusted and never a crash. That includes an item whose
// text isn't ours at all (a DamagedSecretError from the vault): it is "not logged in" too, so a
// damaged item can't block the API-key fallback. Only a vault we can't READ is an error.

import { DamagedSecretError, type SecretStore } from "../platform/secret-store.ts";
import { MAX_SCOPES, SCOPE_NAME, TOKEN_PATTERN, type Tokens } from "./token.ts";

// The name the tokens are stored under. (A plain `tangent-oauth`: the secret store only
// accepts lowercase letters, digits and . _ - in names.)
export const TOKENS_SECRET_NAME = "tangent-oauth";

// Bumped if the saved shape ever changes. A blob with another version is left alone, not
// deleted: it may have been written by a newer Tangent, which an older one must not destroy.
const FORMAT_VERSION = 1;

// The rules for what a token, a scope and the scope count may look like are NOT repeated here:
// they are the ones token.ts applies to Linear's reply (TOKEN_PATTERN, SCOPE_NAME, MAX_SCOPES), so
// anything we accept from Linear is something we can save, and anything we load was checked by
// the same rules. They keep the whole blob safely under the secret store's size cap: tokens use an
// alphabet that needs no JSON escaping, so the largest allowed blob is about 1,000 bytes (a test
// saves exactly that blob through the real macOS store code).

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isToken = (value: unknown): value is string => typeof value === "string" && TOKEN_PATTERN.test(value);

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
      let text: string | null;
      try {
        text = await secrets.get(TOKENS_SECRET_NAME);
      } catch (error) {
        // An item that isn't ours is "not logged in" (and is left in place, like any unusable blob).
        // Any other error means we couldn't LOOK, which must not pass for a logout.
        if (error instanceof DamagedSecretError) return null;
        throw error;
      }
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
