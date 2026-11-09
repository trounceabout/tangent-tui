// src/testing.ts
// Helpers shared by the *.test.ts files. Not part of the app itself.
//
// The tests use made-up data and a fake network, never the real Linear or the
// Keychain, so they are fast, repeatable, and runnable by anyone who clones the repo.

import type { Issue } from "./linear.ts";

// A plain, valid issue. Pass only the fields a test cares about.
export function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    identifier: "PD-1",
    title: "A title",
    url: "https://linear.app/example/issue/PD-1",
    priority: 3,
    state: { name: "Todo", type: "unstarted", position: 1, color: "#e2e2e2" },
    cycle: { number: 1, endsAt: "2026-11-23T05:00:00.000Z", team: { key: "PD" } },
    dueDate: null,
    estimate: null,
    labels: { nodes: [] },
    team: { key: "PD", issueEstimationType: "tShirt" },
    ...overrides,
  };
}

// Shorthand for labels: labels("CPQ", "Bug") -> the shape Issue.labels expects.
export const labels = (...names: string[]): Issue["labels"] => ({
  nodes: names.map((name) => ({ name, color: "#4cb782" })),
});

// What the fake network saw for one request.
export type SeenRequest = {
  query: string;
  variables: Record<string, unknown>;
  headers: Record<string, string>;
};

// Replace the global `fetch` with a fake for one test. `respond` gets each request
// and returns either a plain object (sent back as JSON) or a ready-made Response.
// Returns a function that puts the real fetch back; call it in afterEach.
export function mockFetch(respond: (request: SeenRequest) => unknown): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { query: string; variables: Record<string, unknown> };
    const result = respond({
      query: body.query,
      variables: body.variables,
      headers: { ...(init?.headers as Record<string, string> | undefined) },
    });
    return result instanceof Response ? result : new Response(JSON.stringify(result));
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

// Control characters written as code so the test files stay readable.
export const ESC = "\u001b";
export const BEL = "\u0007";
// True if `text` contains any control character or bidi override.
export const hasControlChars = (text: string): boolean => /\p{Cc}|[‎‏‪-‮⁦-⁩]/u.test(text);
