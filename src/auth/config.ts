// src/auth/config.ts
// The fixed facts about Tangent's registered Linear OAuth app. Constants and one tiny
// helper only: no network, no terminal. See issues #66 (what we learned) and #67.

// Tangent's OAuth app ID. This is a PUBLIC identifier (it appears in the login URL), not a
// secret. The app is public and uses PKCE, so there is deliberately NO client secret in this
// codebase, and none is needed.
export const CLIENT_ID = "9b09e03638d1cb465942cf349090915e";

// Linear's login endpoints.
export const AUTHORIZE_URL = "https://linear.app/oauth/authorize";
export const TOKEN_URL = "https://api.linear.app/oauth/token";
export const REVOKE_URL = "https://api.linear.app/oauth/revoke";
export const GRAPHQL_URL = "https://api.linear.app/graphql";

// What Tangent asks to do. `read` is the default and always present; `issues:create` is what
// Linear describes as "create and update issues" (all Tangent changes: status, priority,
// estimate). Narrower than `write`, so a leaked token can do less. PROVISIONAL: confirm with a
// real update on a throwaway issue (issue #66, question 3) before relying on it.
export const SCOPES = ["read", "issues:create"] as const;

// Linear matches redirect addresses EXACTLY, port included (found in issue #66: an
// unregistered port is rejected with "Invalid redirect_uri parameter"). These are the ports
// registered on the app, tried in order. Adding a port here means adding it in Linear too.
export const REDIRECT_PORTS = [8976, 8977, 8978] as const;

// The redirect address for one of the registered ports. `127.0.0.1`, never `localhost`,
// because the registered addresses must match character for character. Refuses any other
// port, so a typo fails here and not on Linear's error page.
export function redirectUriFor(port: number): string {
  if (!(REDIRECT_PORTS as readonly number[]).includes(port)) {
    throw new Error(`Port ${port} is not registered with Linear (registered: ${REDIRECT_PORTS.join(", ")}).`);
  }
  return `http://127.0.0.1:${port}/callback`;
}
