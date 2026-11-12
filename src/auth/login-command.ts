// src/auth/login-command.ts
// `tangent login`: what the command does, as a function that returns the exit code, so it can be
// tested without a terminal. index.tsx only calls it (and loads it only for this command, so
// --help and --version never touch the vault or the network). See issue #68.
//
// Two rules so that no login is ever left live at Linear with no copy on this computer:
//  - LOGGING IN AGAIN ENDS THE PREVIOUS LOGIN. Tangent keeps one login at a time, so a new one
//    overwrites the old; the old one is ended at Linear (best effort) after the new one is saved.
//    Otherwise its 30-day refresh token would stay live and `tangent logout` could never end it.
//  - TOKENS WE CAN'T KEEP ARE ENDED. If Linear issued tokens and then they fail our checks or can't
//    be saved, the login hands them to `discard`, which ends them at Linear (best effort).
// Both are best effort: a failure to end something never fails the login.

import { cleanText } from "../linear.ts";
import { openInBrowser } from "../open.ts";
import { createSecretStore } from "../platform/secret-store.ts";
import { loginLockPath } from "./app-session.ts";
import { type RefreshLock, createFileLock } from "./lock.ts";
import { type LoginDeps, runLogin } from "./login.ts";
import { revokeToken } from "./revoke.ts";
import { type TokenStore, createTokenStore } from "./token-store.ts";

export interface LoginCommandDeps {
  print: (line: string) => void;
  printError: (line: string) => void;
  openBrowser: (url: string) => void;
  // Throws on a system that can't save a login (everything but macOS, for now).
  createStore: () => TokenStore;
  // Saving the login happens inside this lock, the one a refresh and a logout also take, so they
  // can never interleave with it (each refresh retires the old refresh token).
  lock: RefreshLock;
  // The network, for ending tokens at Linear. Passed in so tests never touch the real one.
  fetchFn?: typeof fetch;
  // The login itself; passed in so tests can use a fake or a wrapped real one.
  login?: (deps: LoginDeps) => Promise<unknown>;
}

const MAX_MESSAGE_CHARS = 300;

const realDeps = (): LoginCommandDeps => ({
  print: (line) => console.log(line),
  printError: (line) => console.error(line),
  openBrowser: openInBrowser,
  createStore: () => createTokenStore(createSecretStore()),
  lock: createFileLock(loginLockPath()),
});

// Runs the login and returns the process exit code: 0 for logged in, 1 for anything else.
export async function runLoginCommand(deps: LoginCommandDeps = realDeps()): Promise<number> {
  const fail = (error: unknown): number => {
    const message = error instanceof Error ? error.message : "unknown error";
    deps.printError(`tangent: ${cleanText(message).slice(0, MAX_MESSAGE_CHARS)}`);
    return 1;
  };

  // Find out first whether a login can be saved here at all, before opening any browser.
  let store: TokenStore;
  try {
    store = deps.createStore();
  } catch (error) {
    return fail(error);
  }

  const fetchFn = deps.fetchFn ?? fetch;
  // End tokens at Linear, access token first (see logout-command.ts for why that order). Best effort:
  // never throws. Returns true only if neither request failed outright.
  const endTokens = async (tokens: { accessToken?: string; refreshToken?: string }): Promise<boolean> => {
    const outcomes = [
      tokens.accessToken === undefined ? "revoked" : await revokeToken(fetchFn, tokens.accessToken, "access_token"),
      tokens.refreshToken === undefined ? "revoked" : await revokeToken(fetchFn, tokens.refreshToken, "refresh_token"),
    ];
    return !outcomes.includes("failed");
  };

  // Set (inside the lock) when an older login was replaced, and whether it was ended at Linear.
  let previousEnded: boolean | undefined;

  try {
    await (deps.login ?? runLogin)({
      openBrowser: deps.openBrowser,
      print: deps.print,
      fetchFn,
      save: (tokens) =>
        deps.lock.withLock(async () => {
          // What was saved before (a vault we can't read just means there is nothing to end).
          const previous = await store.load().catch(() => null);
          await store.save(tokens); // if this throws, the old login is still valid: leave it alone
          if (previous !== null && previous.refreshToken !== tokens.refreshToken) {
            previousEnded = await endTokens(previous); // the new login is saved; now end the old one
          }
        }),
      discard: async (tokens) => {
        await endTokens(tokens);
      },
    });
    // Said after the login's own messages, and only when it is true.
    if (previousEnded === true) deps.print("Your previous login was ended.");
    return 0;
  } catch (error) {
    return fail(error);
  }
}
