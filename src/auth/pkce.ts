// src/auth/pkce.ts
// The random values and the fingerprint that browser login (OAuth) needs.
// Pure functions: no network, no terminal, nothing stored. See issue #67.
//
// PKCE ("pixy", RFC 7636) in one paragraph: before sending you to the browser we invent a
// random secret, the VERIFIER, and send Linear only its SHA-256 fingerprint, the CHALLENGE.
// When we later trade the login code for tokens we must reveal the verifier. A program that
// merely steals the code from the redirect can't redeem it without the verifier, which is
// why a public app like this one needs no client secret.

import { createHash, randomBytes } from "node:crypto";

// A fresh code verifier. 32 random bytes written as base64url is 43 characters (the standard
// allows 43 to 128) using only A-Z a-z 0-9 - _ , which is what the standard allows.
export function createCodeVerifier(): string {
  return randomBytes(32).toString("base64url");
}

// The challenge for a verifier: base64url(SHA-256(verifier)). We always use this "S256"
// method, never "plain" (which would send the secret itself).
export function codeChallengeFor(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

// A fresh `state` value. It travels to Linear and back unchanged; we check it matches so a
// stray request to our local port can't pose as the login. 16 random bytes is plenty.
export function createState(): string {
  return randomBytes(16).toString("base64url");
}
