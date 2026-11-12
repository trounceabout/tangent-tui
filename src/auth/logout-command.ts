// src/auth/logout-command.ts
// `tangent logout`: end the browser login at Linear AND forget it on this computer. Returns the
// process exit code so it can be tested without a terminal. See issue #70.
//
// Order matters, and each step has a reason:
//  1. Take the refresh lock for the whole job. A refresh in another window rotates the tokens;
//     if it ran while we revoke, we would end the OLD tokens and leave the new ones live.
//  2. Load the saved login. If the vault can't be read we stop: nothing is changed.
//  3. Revoke the refresh token (the long-lived one), then the access token.
//  4. Revoke BEFORE deleting. If the command dies in between, a dead login left on this computer
//     is cleaned up automatically later; the other way round would leave a live token at Linear
//     with no local copy to ever end it.
//  5. Always delete the local copy, even if revoking failed: the person asked to log out.
//  6. If Linear couldn't be reached, say so and exit 1: a live 30-day refresh token must not
//     look like a clean success, and the message says where to end it by hand.
// Nothing printed ever contains a token. Lines are short so they don't wrap in a narrow pane.

import { cleanText } from "../linear.ts";
import { createSecretStore } from "../platform/secret-store.ts";
import { loginLockPath } from "./app-session.ts";
import { type RefreshLock, createFileLock } from "./lock.ts";
import { type RevokeOutcome, revokeToken } from "./revoke.ts";
import { type TokenStore, createTokenStore } from "./token-store.ts";

export interface LogoutCommandDeps {
  print: (line: string) => void;
  printError: (line: string) => void;
  // Throws on a system that can't save a login (everything but macOS, for now).
  createStore: () => TokenStore;
  lock: RefreshLock;
  fetchFn?: typeof fetch;
  env: Record<string, string | undefined>;
}

const MAX_DETAIL_CHARS = 200;

const realDeps = (): LogoutCommandDeps => ({
  print: (line) => console.log(line),
  printError: (line) => console.error(line),
  createStore: () => createTokenStore(createSecretStore()),
  lock: createFileLock(loginLockPath()),
  env: process.env,
});

const detailOf = (error: unknown): string =>
  cleanText(error instanceof Error ? error.message : "unknown error").slice(0, MAX_DETAIL_CHARS);

// Where to end a login by hand, for when we couldn't.
const BY_HAND = ["Remove Tangent in Linear:", "Settings > Security & access >", "Authorized applications."];

export async function runLogoutCommand(deps: LogoutCommandDeps = realDeps()): Promise<number> {
  const { print, printError, env } = deps;

  // Print a message to stderr; the first line carries the program's name, like login's errors.
  const fail = (...lines: string[]): number => {
    lines.forEach((line, index) => printError(index === 0 ? `tangent: ${line}` : line));
    return 1;
  };

  // If LINEAR_API_KEY is set, Tangent falls back to it after a logout: say so.
  const noteOtherCredential = () => {
    if (env.LINEAR_API_KEY?.trim()) print("LINEAR_API_KEY is set, so Tangent will use that.");
  };

  // Can a login even be saved here? If not there is nothing to log out of.
  let store: TokenStore;
  try {
    store = deps.createStore();
  } catch {
    print("No saved login on this computer.");
    print("(Saving a login isn't supported on this system.)");
    noteOtherCredential();
    return 0;
  }

  async function logoutLocked(): Promise<number> {
    let tokens: Awaited<ReturnType<TokenStore["load"]>>;
    try {
      tokens = await store.load();
    } catch (error) {
      return fail("Couldn't read your saved login.", detailOf(error), "Nothing was changed.");
    }

    // No usable login. An explicit logout still removes whatever is saved (a damaged blob, or one
    // from a newer Tangent): the automatic loader never deletes those, but you asked.
    if (tokens === null) {
      try {
        await store.clear();
      } catch (error) {
        return fail("Couldn't remove what is saved.", detailOf(error));
      }
      print("You weren't logged in.");
      noteOtherCredential();
      return 0;
    }

    const fetchFn = deps.fetchFn ?? fetch;
    const refresh: RevokeOutcome = await revokeToken(fetchFn, tokens.refreshToken, "refresh_token");
    const access: RevokeOutcome = await revokeToken(fetchFn, tokens.accessToken, "access_token");
    // If either answer was "couldn't tell", the token may still be live at Linear.
    const unconfirmed = refresh === "failed" || access === "failed";

    let removed = true;
    try {
      await store.clear();
    } catch {
      removed = false;
    }

    if (!removed) {
      return unconfirmed
        ? fail("Couldn't remove your login from the", "Keychain, or confirm that Linear ended it.", ...BY_HAND)
        : fail("Couldn't remove your login from the", "Keychain. It was ended at Linear, so it no", "longer works.");
    }
    if (unconfirmed) {
      return fail("Removed your login from this computer,", "but couldn't confirm Linear ended it.", "To be sure:", ...BY_HAND);
    }

    print("Logged out.");
    if (refresh === "already-gone" && access === "already-gone") {
      print("Linear had already ended this login.");
      print("It is now removed from this computer.");
    } else {
      print("Your login was ended at Linear and");
      print("removed from this computer.");
    }
    noteOtherCredential();
    return 0;
  }

  try {
    return await deps.lock.withLock(logoutLocked);
  } catch (error) {
    // The lock couldn't be taken (another window is busy for too long), or something unexpected.
    return fail(detailOf(error));
  }
}
