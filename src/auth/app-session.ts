// src/auth/app-session.ts
// The real wiring for getAuthorization(): this computer's vault, the shared lock, the saved API
// key and the environment. Everything else in src/auth/ takes these as parameters; this is the
// one place that picks the real ones. See issue #69.

import { join } from "node:path";
import { getApiKey } from "../linear.ts";
import { createSecretStore } from "../platform/secret-store.ts";
import { settingsDir } from "../settings.ts";
import { createFileLock } from "./lock.ts";
import { getAuthorization } from "./session.ts";
import { type TokenStore, createTokenStore } from "./token-store.ts";

// Where the refresh lock lives: next to the settings, in the folder that XDG_CONFIG_HOME picks
// (so tests that point it at a temp folder never touch the real one). It holds no secrets.
export const loginLockPath = (): string => join(settingsDir(), "login.lock");

// The token store for this computer, or null where logins can't be saved (every system except
// macOS for now). Null just means "no browser login here": the API key still works.
function tokenStoreForThisComputer(): TokenStore | null {
  try {
    return createTokenStore(createSecretStore());
  } catch {
    return null;
  }
}

// The value for the `Authorization` header: `Bearer <token>` for a browser login, or the raw
// personal API key. Pass the result straight to fetchIssues, updateIssue and friends.
export function getAuthHeader(): Promise<string> {
  return getAuthorization({
    tokenStore: tokenStoreForThisComputer(),
    lock: createFileLock(loginLockPath()),
    // null means there is no saved key. A Keychain that can't be READ throws, so the person sees that
    // problem and not "Not logged in".
    readApiKey: getApiKey,
    env: process.env,
  });
}
