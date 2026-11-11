// Tests for src/auth/pkce.ts: the random values and the fingerprint for browser login.

import { describe, expect, test } from "bun:test";
import { codeChallengeFor, createCodeVerifier, createState } from "./pkce.ts";

// Characters the PKCE standard allows in a verifier (and that base64url produces).
const URL_SAFE = /^[A-Za-z0-9_-]+$/;

describe("codeChallengeFor", () => {
  test("matches the worked example in RFC 7636 appendix B", () => {
    // The standard publishes a sample verifier and the challenge it must produce, so this
    // fails if the hash, the encoding or the padding is wrong.
    expect(codeChallengeFor("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  test("is URL-safe with no '=' padding", () => {
    expect(codeChallengeFor(createCodeVerifier())).toMatch(URL_SAFE);
  });

  test("is not the verifier itself (that would be the insecure 'plain' method)", () => {
    const verifier = createCodeVerifier();
    expect(codeChallengeFor(verifier)).not.toBe(verifier);
  });
});

describe("createCodeVerifier", () => {
  test("is 43 URL-safe characters, inside the 43 to 128 the standard allows", () => {
    const verifier = createCodeVerifier();
    expect(verifier).toHaveLength(43);
    expect(verifier).toMatch(URL_SAFE);
  });

  test("is different every time", () => {
    const verifiers = new Set(Array.from({ length: 50 }, () => createCodeVerifier()));
    expect(verifiers.size).toBe(50);
  });
});

describe("createState", () => {
  test("is URL-safe and long enough to guess-proof (22 characters)", () => {
    const state = createState();
    expect(state).toHaveLength(22);
    expect(state).toMatch(URL_SAFE);
  });

  test("is different every time", () => {
    const states = new Set(Array.from({ length: 50 }, () => createState()));
    expect(states.size).toBe(50);
  });
});
