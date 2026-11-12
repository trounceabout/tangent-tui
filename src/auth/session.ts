// src/auth/session.ts
// "Which credential do I send to Linear right now?" and keeping a browser login fresh.
// See issue #69. This is the credential path.
//
// getAuthorization() returns the value for the `Authorization` header:
//   `Bearer <token>` for a browser login, or the raw key for a personal API key.
// The order is: browser login, then the saved API key, then the LINEAR_API_KEY variable.
//
// Rules for a browser login (each one is covered by a test):
//  - Refresh a few minutes BEFORE the access token dies (isDueForRefresh).
//  - Refreshing happens inside the shared lock, and is checked again once the lock is ours:
//    every refresh retires the old refresh token, so two windows must never both do it.
//  - The refresh request has a time limit, well under the lock's stale limit, so a stalled request
//    can't hold the lock (and every other window) until it is taken from us.
//  - If Linear REJECTS the refresh, the login is dead: clear it (so we don't hit Linear with a
//    dead token on every request) and fall back to the API key or variable, if there is one. But if
//    a NEWER login was saved while we were talking to Linear, use that one instead.
//  - If the refresh merely FAILS (network down or stalled, Linear erroring, a 200 reply we can't use),
//    keep everything as it is. If the access token hasn't expired yet, carry on using it; if it has,
//    say so. Linear lets the same refresh token be retried for 30 minutes if a reply was lost, so a
//    later try is safe.
//  - A refresh that works but can't be SAVED is an error, never silent: the old refresh token is
//    gone, so the new one would be lost.
//  - Error messages never contain a token.

import { isDueForRefresh } from "./expiry.ts";
import type { RefreshLock } from "./lock.ts";
import type { TokenStore } from "./token-store.ts";
import { type Tokens, buildRefreshRequest, parseTokenResponse } from "./token.ts";

// Nothing usable to log in with. The message says what to do about it.
export class LoginRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LoginRequiredError";
  }
}

export interface SessionDeps {
  tokenStore: TokenStore | null; // null where logins can't be saved (an unsupported system)
  lock: RefreshLock;
  readApiKey: () => Promise<string | null>; // the saved personal API key, or null if there isn't one
  env: Record<string, string | undefined>;
  fetchFn?: typeof fetch;
  now?: () => number;
  // How long the refresh request may take (default 8 seconds). Tests make it short.
  refreshTimeoutMs?: number;
}

// Well under the lock's 30 second stale limit (and its heartbeat keeps a busy holder fresh anyway).
const DEFAULT_REFRESH_TIMEOUT_MS = 8_000;

type Refreshed = { kind: "ok"; tokens: Tokens } | { kind: "ended" };

const bearer = (tokens: Tokens): string => `Bearer ${tokens.accessToken}`;

// Does this reply explain a refusal? ({ error, error_description } is how Linear says no.)
const explainsRefusal = (body: unknown): boolean =>
  typeof body === "object" && body !== null && typeof (body as { error?: unknown }).error === "string";

async function refreshLogin(deps: SessionDeps, store: TokenStore): Promise<Refreshed> {
  const { lock, fetchFn = fetch, now = Date.now } = deps;
  const refreshTimeoutMs = deps.refreshTimeoutMs ?? DEFAULT_REFRESH_TIMEOUT_MS;

  return lock.withLock(async (): Promise<Refreshed> => {
    // We may have waited for another window. Look again: it has probably done the job already.
    const current = await store.load();
    if (current === null) return { kind: "ended" }; // logged out while we waited
    if (!isDueForRefresh(current, now())) return { kind: "ok", tokens: current };

    // A failure that isn't Linear saying no: carry on with the token we have if it still works.
    const keepGoing = (message: string): Refreshed => {
      if (now() < current.expiresAt) return { kind: "ok", tokens: current };
      throw new Error(message);
    };

    const request = buildRefreshRequest(current.refreshToken);
    let response: Response;
    try {
      response = await fetchFn(request.url, {
        method: "POST",
        headers: request.headers,
        body: request.body,
        signal: AbortSignal.timeout(refreshTimeoutMs),
      });
    } catch {
      return keepGoing("Couldn't reach Linear to refresh your login. Check your connection and try again.");
    }
    const body: unknown = await response.json().catch(() => undefined);

    if (!response.ok) {
      // Only an explained refusal (400 or 401 with { error }) means the login is dead.
      // An error page or a 5xx is Linear having trouble, not Linear saying no.
      if ((response.status === 400 || response.status === 401) && explainsRefusal(body)) {
        const latest = await store.load().catch(() => null);
        // A different, still-fresh login was saved while we were talking to Linear (someone ran
        // `tangent login`): that one is valid, so use it rather than reporting the login as ended.
        if (latest !== null && latest.refreshToken !== current.refreshToken && !isDueForRefresh(latest, now())) {
          return { kind: "ok", tokens: latest };
        }
        // Otherwise clear the dead login, unless what is saved is no longer the one we tried.
        if (latest !== null && latest.refreshToken === current.refreshToken) await store.clear().catch(() => {});
        return { kind: "ended" };
      }
      return keepGoing(`Linear's login service answered HTTP ${response.status}. Try again in a moment.`);
    }

    // A 200 reply we can't use (an error page, missing fields, tokens that fail our checks) is Linear
    // having trouble, like a 5xx: it leaves what is saved alone, and a token that still works is kept.
    let tokens: Tokens;
    try {
      tokens = parseTokenResponse(body, now());
    } catch (error) {
      return keepGoing(error instanceof Error ? error.message : "Linear's reply couldn't be used.");
    }
    try {
      await store.save(tokens);
    } catch {
      throw new Error("Refreshed your login but couldn't save it. Run `tangent login` again if this keeps happening.");
    }
    return { kind: "ok", tokens };
  });
}

export async function getAuthorization(deps: SessionDeps): Promise<string> {
  const now = deps.now ?? Date.now;
  let loginEnded = false;

  // 1. A browser login.
  const tokens = deps.tokenStore ? await deps.tokenStore.load() : null;
  if (deps.tokenStore && tokens) {
    if (!isDueForRefresh(tokens, now())) return bearer(tokens);
    const outcome = await refreshLogin(deps, deps.tokenStore);
    if (outcome.kind === "ok") return bearer(outcome.tokens);
    loginEnded = true; // dead: fall through to the other credentials
  }

  // 2. A saved personal API key (sent as it is, with no "Bearer").
  const savedKey = await deps.readApiKey();
  if (savedKey) return savedKey;

  // 3. The LINEAR_API_KEY variable.
  const envKey = deps.env.LINEAR_API_KEY?.trim();
  if (envKey) return envKey;

  throw new LoginRequiredError(
    loginEnded
      ? "Your Linear login has ended. Run `tangent login` to log in again."
      : "Not logged in. Run `tangent login`, or set LINEAR_API_KEY.",
  );
}
