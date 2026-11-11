// src/auth/login.ts
// The whole browser login, start to finish. See issue #68.
//
// Everything it touches from outside is passed in (the browser, the printing, the network,
// and where the tokens get saved), so tests can run it with fakes: no real browser, no real
// Linear, and nothing written anywhere.
//
// Order of events: start the local server, tell the person what to look for, open the browser,
// wait for Linear's redirect, trade the code for tokens, read the workspace name back, SAVE the
// tokens, and only then say "Logged in". Tokens are never printed and never put in an error.

import { cleanText } from "../linear.ts";
import { type CallbackOptions, startCallbackServer } from "./callback.ts";
import { buildAuthorizeUrl } from "./authorize.ts";
import { GRAPHQL_URL } from "./config.ts";
import { codeChallengeFor, createCodeVerifier, createState } from "./pkce.ts";
import { type Tokens, buildCodeExchangeRequest, parseTokenResponse } from "./token.ts";

export interface LoginDeps {
  openBrowser: (url: string) => void;
  print: (line: string) => void;
  save: (tokens: Tokens) => Promise<void>; // the token store (issue #69)
  fetchFn?: typeof fetch;
  now?: () => number;
  // Lets tests use a free port and a short wait. Real code leaves this alone.
  serverOptions?: Pick<CallbackOptions, "ports" | "redirectUriForPort" | "timeoutMs">;
}

export interface LoginResult {
  workspace: string | undefined; // undefined if we couldn't read it (the login still worked)
}

const MAX_WORKSPACE_CHARS = 100;
const MAX_DETAIL_CHARS = 200;

// Ask Linear which workspace this token belongs to, so a wrong pick is obvious at once.
// A failure here never fails the login: the tokens are fine, we just can't name the workspace.
async function fetchWorkspaceName(fetchFn: typeof fetch, accessToken: string): Promise<string | undefined> {
  try {
    const response = await fetchFn(GRAPHQL_URL, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ query: "{ organization { name } }" }),
    });
    if (!response.ok) return undefined;
    const json = (await response.json()) as { data?: { organization?: { name?: unknown } } };
    const name = json.data?.organization?.name;
    if (typeof name !== "string") return undefined;
    const clean = cleanText(name).trim().slice(0, MAX_WORKSPACE_CHARS);
    return clean === "" ? undefined : clean;
  } catch {
    return undefined;
  }
}

export async function runLogin(deps: LoginDeps): Promise<LoginResult> {
  const { openBrowser, print, save, fetchFn = fetch, now = Date.now, serverOptions } = deps;

  const codeVerifier = createCodeVerifier();
  const state = createState();

  // Throws (with a clear message) if no registered port is free. Nothing has been shown yet.
  const server = startCallbackServer({ state, ...serverOptions });
  const redirectUri = server.redirectUri;
  const loginUrl = buildAuthorizeUrl({ redirectUri, state, codeChallenge: codeChallengeFor(codeVerifier) });

  let outcome: Awaited<typeof server.result>;
  try {
    print("Opening Linear in your browser to log in...");
    print("");
    // Linear's page picks the workspace the browser used last. Its only switcher is a small
    // dropdown, so say where it is BEFORE the person approves.
    print("Before you approve, check the workspace name at the top left of the page.");
    print("Wrong one? Use the dropdown there to switch, then approve.");
    print("");
    print("If the browser didn't open, visit this address:");
    print(loginUrl);
    try {
      openBrowser(loginUrl);
    } catch {
      // The address is on screen above; the person can open it by hand.
    }
    outcome = await server.result;
  } finally {
    await server.close();
  }

  if (outcome.kind === "denied") throw new Error("Login cancelled.");
  if (outcome.kind === "timeout") throw new Error("Timed out waiting for the login. Run `tangent login` to try again.");
  if (outcome.kind === "error") throw new Error(`Linear reported a problem: ${outcome.error}`);

  // Trade the code for tokens.
  const request = buildCodeExchangeRequest({ code: outcome.code, codeVerifier, redirectUri });
  let response: Response;
  try {
    response = await fetchFn(request.url, { method: "POST", headers: request.headers, body: request.body });
  } catch {
    throw new Error("Couldn't reach Linear to finish the login. Check your connection and try again.");
  }
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    // Linear explains a refusal in the body ({ error, error_description }); parseTokenResponse
    // turns that into a readable error. But an error PAGE (not JSON, e.g. a 502 from a proxy)
    // has nothing to explain, so report the HTTP status instead.
    const explains = typeof body === "object" && body !== null && typeof (body as { error?: unknown }).error === "string";
    if (explains) parseTokenResponse(body, now());
    throw new Error(`Linear's login service answered HTTP ${response.status}.`);
  }
  const tokens = parseTokenResponse(body, now());

  const workspace = await fetchWorkspaceName(fetchFn, tokens.accessToken);

  try {
    await save(tokens);
  } catch (error) {
    const detail = cleanText(error instanceof Error ? error.message : "unknown error").slice(0, MAX_DETAIL_CHARS);
    throw new Error(`Couldn't save the login: ${detail}`);
  }

  print("");
  print(workspace ? `Logged in to ${workspace}.` : "Logged in. (Couldn't read the workspace name.)");
  print("To use a different workspace, run `tangent login` again and pick it in the");
  print("dropdown at the top left of Linear's page.");
  return { workspace };
}
