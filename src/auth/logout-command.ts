// src/auth/logout-command.ts
// `tangent logout`: end the browser login at Linear AND forget it on this computer. Returns the
// process exit code so it can be tested without a terminal. See issue #70.
//
// Order matters, and each step has a reason:
//  1. Take the refresh lock for the whole job. A refresh in another window rotates the tokens;
//     if it ran while we revoke, we would end the OLD tokens and leave the new ones live.
//  2. Load the saved login. If the vault can't be read we stop: nothing is changed.
//  3. Revoke the ACCESS token first, then the refresh token. The order is not a detail: a real run
//     against Linear showed that revoking the refresh token first makes Linear stop recognising
//     the access token (its revoke answered 401), yet the API kept accepting that token for the
//     rest of its day, while the message claimed it was ended.
//  3b. Then ask the API whether it still accepts the old access token (probeAccessToken). Linear's
//     revoke answers are ambiguous, so this is the only real confirmation. And Linear takes a
//     moment to STOP accepting a revoked token (a real run: HTTP 200 a few milliseconds after the
//     revoke, 401 a moment later), so if the API still accepts it we keep asking for a few
//     seconds before concluding it is really still live.
//  4. Revoke BEFORE deleting. If the command dies in between, a dead login left on this computer
//     is cleaned up automatically later; the other way round would leave a live token at Linear
//     with no local copy to ever end it.
//  5. Always delete the local copy, even if revoking failed: the person asked to log out.
//  6. If Linear couldn't be reached, say so and exit 1: a live 30-day refresh token must not
//     look like a clean success, and the message says where to end it by hand.
// Nothing printed ever contains a token. Lines are short so they don't wrap in a narrow pane.

import { cleanText, getApiKey } from "../linear.ts";
import { createSecretStore } from "../platform/secret-store.ts";
import { loginLockPath } from "./app-session.ts";
import { type RefreshLock, createFileLock } from "./lock.ts";
import { type ProbeOutcome, type RevokeOutcome, probeAccessToken, revokeToken } from "./revoke.ts";
import { type TokenStore, createTokenStore } from "./token-store.ts";

export interface LogoutCommandDeps {
  print: (line: string) => void;
  printError: (line: string) => void;
  // Throws on a system that can't save a login (everything but macOS, for now).
  createStore: () => TokenStore;
  lock: RefreshLock;
  fetchFn?: typeof fetch;
  env: Record<string, string | undefined>;
  // The saved personal API key, or null if there is none (it throws if the Keychain can't be read).
  // REQUIRED, so a test that forgets it is a compile error and can't reach the real Keychain.
  readApiKey: () => Promise<string | null>;
  // How to wait between checks, and what time it is. Passed in so tests don't really wait.
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const MAX_DETAIL_CHARS = 200;

// Linear stops accepting a revoked token a moment AFTER it says it revoked it. So when the API
// still accepts the token we ask again every PROBE_EVERY_MS, until PROBE_WINDOW_MS of REAL time
// have passed (measured on the clock, not by counting waits, so slow requests can't stretch it),
// before deciding it is really still live. The whole job runs inside the refresh lock, so it has
// to be bounded: each request also has its own 5 second limit (revoke.ts).
const PROBE_EVERY_MS = 500;
const PROBE_WINDOW_MS = 8000;
const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const realDeps = (): LogoutCommandDeps => ({
  print: (line) => console.log(line),
  printError: (line) => console.error(line),
  createStore: () => createTokenStore(createSecretStore()),
  lock: createFileLock(loginLockPath()),
  env: process.env,
  readApiKey: getApiKey,
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

  // After a logout Tangent falls back to a saved API key, then to LINEAR_API_KEY (in that order, like
  // getAuthorization). Say which one, so a logout that leaves Tangent working as you isn't a surprise.
  const noteOtherCredential = async () => {
    const savedKey = await deps.readApiKey().catch(() => null); // can't read it: just say nothing
    if (savedKey) {
      print("A saved API key is in your Keychain,");
      print("so Tangent will use that.");
    } else if (env.LINEAR_API_KEY?.trim()) {
      print("LINEAR_API_KEY is set, so Tangent will use that.");
    }
  };

  // Can a login even be saved here? If not there is nothing to log out of.
  let store: TokenStore;
  try {
    store = deps.createStore();
  } catch {
    print("No saved login on this computer.");
    print("(Saving a login isn't supported on this system.)");
    await noteOtherCredential();
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
      await noteOtherCredential();
      return 0;
    }

    const fetchFn = deps.fetchFn ?? fetch;
    // Access token FIRST (see the note at the top), then the refresh token.
    const access: RevokeOutcome = await revokeToken(fetchFn, tokens.accessToken, "access_token");
    const refresh: RevokeOutcome = await revokeToken(fetchFn, tokens.refreshToken, "refresh_token");
    // Don't trust Linear's revoke answers alone: ask the API whether the old access token still works.
    // If it still does, give Linear a few seconds to catch up before believing it.
    const sleep = deps.sleep ?? defaultSleep;
    const now = deps.now ?? Date.now;
    let probe: ProbeOutcome = await probeAccessToken(fetchFn, tokens.accessToken);
    if (probe === "accepted") print("Checking that Linear ended it...");
    const startedChecking = now();
    while (probe === "accepted" && now() - startedChecking < PROBE_WINDOW_MS) {
      await sleep(PROBE_EVERY_MS);
      probe = await probeAccessToken(fetchFn, tokens.accessToken);
    }
    // The access token counts as ended if the API refuses it, or if we couldn't ask but Linear said
    // outright that it revoked it. A 400/401 from the revoke endpoint is NOT enough on its own.
    const accessEnded = probe === "rejected" || (probe === "unknown" && access === "revoked");
    // If anything may still be live at Linear, we say so (and exit 1) instead of claiming success.
    //
    // KNOWN RESIDUAL RISK: the REFRESH token is only confirmed by Linear's own revoke answer, where
    // "already-gone" (400 or 401) is accepted. Revoking the access token first normally ends the whole
    // login, so the refresh token then answers 401 (seen in real runs). But a 400 for an unrelated
    // reason (say a malformed request) would also be accepted. The risk is narrow (it needs the access
    // token to have expired too, or the answer to be wrong), and there is no safe way to test the
    // refresh token directly (using it would rotate it). Linear's real answer bodies are not yet known.
    const unconfirmed = refresh === "failed" || access === "failed" || !accessEnded;

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
      return fail(
        "Removed your login from this computer,",
        probe === "accepted" ? "but Linear still accepts its access token." : "but couldn't confirm Linear ended it.",
        "To be sure:",
        ...BY_HAND,
      );
    }

    print("Logged out.");
    if (refresh === "already-gone" && access === "already-gone") {
      print("Linear had already ended this login.");
      print("It is now removed from this computer.");
    } else {
      print("Your login was ended at Linear and");
      print("removed from this computer.");
    }
    await noteOtherCredential();
    return 0;
  }

  try {
    return await deps.lock.withLock(logoutLocked);
  } catch (error) {
    // The lock couldn't be taken (another window is busy for too long), or something unexpected. The
    // reason goes on its own line so every line stays under the 50 columns a narrow pane shows.
    return fail("Couldn't log out.", detailOf(error));
  }
}
