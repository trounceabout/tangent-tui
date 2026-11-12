// src/auth/login-command.ts
// `tangent login`: what the command does, as a function that returns the exit code, so it can be
// tested without a terminal. index.tsx only calls it (and loads it only for this command, so
// --help and --version never touch the vault or the network). See issue #68.

import { cleanText } from "../linear.ts";
import { openInBrowser } from "../open.ts";
import { createSecretStore } from "../platform/secret-store.ts";
import { loginLockPath } from "./app-session.ts";
import { type RefreshLock, createFileLock } from "./lock.ts";
import { type LoginDeps, runLogin } from "./login.ts";
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

  try {
    await (deps.login ?? runLogin)({
      openBrowser: deps.openBrowser,
      print: deps.print,
      save: (tokens) => deps.lock.withLock(() => store.save(tokens)),
    });
    return 0;
  } catch (error) {
    return fail(error);
  }
}
