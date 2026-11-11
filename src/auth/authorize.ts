// src/auth/authorize.ts
// Builds the address that sends you to Linear's consent screen. Pure: it only builds a
// string, it never opens a browser or touches the network. See issue #67.

import { AUTHORIZE_URL, CLIENT_ID, SCOPES } from "./config.ts";

export interface AuthorizeParams {
  redirectUri: string; // one of the registered ones, from redirectUriFor()
  state: string; // from createState()
  codeChallenge: string; // from codeChallengeFor(verifier)
}

// The URL to open in the browser.
//  - `scope` is comma-separated here (Linear's rule for this request; the token reply uses spaces).
//  - `code_challenge_method=S256`: the fingerprint method, never "plain".
//  - `prompt=consent` makes Linear always show the consent screen, which is where its
//    workspace switcher lives. Without it, a returning user is signed in to whichever
//    workspace they used last and never gets the chance to switch.
//  - No client secret, on purpose: PKCE replaces it.
export function buildAuthorizeUrl({ redirectUri, state, codeChallenge }: AuthorizeParams): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", SCOPES.join(","));
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("prompt", "consent");
  return url.toString();
}
