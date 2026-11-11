// Tests for src/auth/login.ts: the whole browser login, with a fake browser and a fake Linear.
//
// The callback server is REAL (on a free port); the browser, the network and the token store
// are fakes. Token values contain "SECRET" so a leak into printed text or an error is easy to spot.

import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { CLIENT_ID, GRAPHQL_URL, TOKEN_URL } from "./config.ts";
import { type LoginDeps, runLogin } from "./login.ts";
import type { Tokens } from "./token.ts";

const NOW = 1_800_000_000_000;

const goodTokenReply = {
  access_token: "access-SECRET",
  token_type: "Bearer",
  expires_in: 86399,
  scope: "issues:create read",
  refresh_token: "refresh-SECRET",
};

type Call = { url: string; init: RequestInit };

// A fake Linear. `token` and `graphql` decide how each endpoint answers.
function fakeLinear(
  options: {
    token?: () => Response;
    graphql?: () => Response;
    tokenThrows?: boolean;
    graphqlThrows?: boolean;
  } = {},
) {
  const calls: Call[] = [];
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    if (url === TOKEN_URL) {
      if (options.tokenThrows) throw new Error("network down");
      return options.token ? options.token() : json(goodTokenReply);
    }
    if (url === GRAPHQL_URL) {
      if (options.graphqlThrows) throw new Error("network down");
      return options.graphql ? options.graphql() : json({ data: { organization: { name: "Acme Corp" } } });
    }
    throw new Error(`unexpected request to ${url}`);
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

// A fake browser: follows the login link and sends the redirect Linear would send.
function browser(reply: { code?: string; error?: string } = { code: "the-code" }) {
  const opened: string[] = [];
  const open = (loginUrl: string) => {
    opened.push(loginUrl);
    const link = new URL(loginUrl);
    const redirect = link.searchParams.get("redirect_uri") ?? "";
    const state = link.searchParams.get("state") ?? "";
    const query = reply.error ? `?error=${reply.error}&state=${state}` : `?code=${reply.code}&state=${state}`;
    setTimeout(() => void fetch(redirect + query).catch(() => {}), 0);
  };
  return { open, opened };
}

// Run a login with fakes. Everything that happened is recorded in `events`, in order.
function setup(overrides: Partial<LoginDeps> = {}, linear = fakeLinear(), reply?: Parameters<typeof browser>[0]) {
  const events: string[] = [];
  const lines: string[] = [];
  const saved: Tokens[] = [];
  const fake = browser(reply);
  const deps: LoginDeps = {
    openBrowser: (url) => {
      events.push("open");
      fake.open(url);
    },
    print: (line) => {
      events.push(`print:${line}`);
      lines.push(line);
    },
    save: async (tokens) => {
      events.push("save");
      saved.push(tokens);
    },
    fetchFn: linear.fetchFn,
    now: () => NOW,
    serverOptions: {
      ports: [0],
      redirectUriForPort: (port) => `http://127.0.0.1:${port}/callback`,
      timeoutMs: 3000,
    },
    ...overrides,
  };
  return { deps, events, lines, saved, linear, browser: fake };
}

// What went wrong, as the message the person would see.
async function failureOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected the login to fail");
}

describe("a successful login", () => {
  test("saves the tokens and says which workspace it connected to", async () => {
    const run = setup();
    const result = await runLogin(run.deps);
    expect(result).toEqual({ workspace: "Acme Corp" });
    expect(run.saved).toEqual([
      {
        accessToken: "access-SECRET",
        refreshToken: "refresh-SECRET",
        expiresAt: NOW + 86399 * 1000,
        scopes: ["issues:create", "read"],
      },
    ]);
    expect(run.lines).toContain("Logged in to Acme Corp.");
  });

  test("tells the person how to switch workspaces, before and after", async () => {
    const run = setup();
    await runLogin(run.deps);
    // The messages are split over short lines, so compare them as one run of text.
    const text = run.lines.join(" ");
    expect(text).toContain("check the workspace name shown at the top left");
    expect(text).toContain("dropdown there to switch");
    expect(text).toContain("run `tangent login` again");
  });

  test("keeps every line short enough for a narrow pane (the address excepted)", async () => {
    // A 64-column pane wrapped the longer wording mid-sentence on a real run.
    const run = setup();
    await runLogin(run.deps);
    for (const line of run.lines) {
      if (line.startsWith("https://")) continue; // the address can't be shortened
      expect(line.length).toBeLessThanOrEqual(50);
    }
  });

  test("shows the workspace hint BEFORE the browser opens and saves BEFORE saying logged in", async () => {
    const run = setup();
    await runLogin(run.deps);
    const at = (needle: string) => run.events.findIndex((event) => event.includes(needle));
    expect(at("Before you approve")).toBeGreaterThanOrEqual(0);
    expect(at("Before you approve")).toBeLessThan(at("open"));
    expect(at("save")).toBeLessThan(at("Logged in to"));
  });

  test("opens the login address with the registered app, narrow scopes and S256", async () => {
    const run = setup();
    await runLogin(run.deps);
    const link = new URL(run.browser.opened[0] ?? "");
    expect(link.origin + link.pathname).toBe("https://linear.app/oauth/authorize");
    expect(link.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(link.searchParams.get("scope")).toBe("read,issues:create");
    expect(link.searchParams.get("code_challenge_method")).toBe("S256");
  });

  test("trades the code using a verifier that matches the challenge in the login address", async () => {
    // This is the heart of PKCE: the verifier sent at the end must hash to the challenge
    // sent at the start, or Linear refuses.
    const run = setup();
    await runLogin(run.deps);
    const link = new URL(run.browser.opened[0] ?? "");
    const exchange = run.linear.calls.find((call) => call.url === TOKEN_URL);
    const form = new URLSearchParams(String(exchange?.init.body));
    expect(form.get("code")).toBe("the-code");
    expect(form.get("redirect_uri")).toBe(link.searchParams.get("redirect_uri"));
    const verifier = form.get("code_verifier") ?? "";
    expect(createHash("sha256").update(verifier).digest("base64url")).toBe(link.searchParams.get("code_challenge") ?? "");
    expect(form.has("client_secret")).toBe(false);
  });

  test("asks for the workspace name with the token as a Bearer header", async () => {
    const run = setup();
    await runLogin(run.deps);
    const query = run.linear.calls.find((call) => call.url === GRAPHQL_URL);
    const headers = (query?.init.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer access-SECRET");
  });

  test("frees the port afterwards", async () => {
    const run = setup();
    await runLogin(run.deps);
    const port = Number(new URL(new URL(run.browser.opened[0] ?? "").searchParams.get("redirect_uri") ?? "").port);
    const again = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("ok") });
    expect(again.port).toBe(port);
    await again.stop(true);
  });
});

describe("the workspace name", () => {
  test("a failed lookup does not fail the login", async () => {
    const run = setup({}, fakeLinear({ graphql: () => new Response("nope", { status: 500 }) }));
    const result = await runLogin(run.deps);
    expect(result).toEqual({ workspace: undefined });
    expect(run.saved).toHaveLength(1);
    expect(run.lines).toContain("Logged in. (Couldn't read the workspace name.)");
  });

  test("a lookup that throws (network drops after the code exchange) does not fail the login either", async () => {
    const run = setup({}, fakeLinear({ graphqlThrows: true }));
    expect(await runLogin(run.deps)).toEqual({ workspace: undefined });
    expect(run.saved).toHaveLength(1);
  });

  test("a reply that isn't what we expect gives no name, and the login still works", async () => {
    const replies = [
      () => new Response("<html>not json</html>"),
      () => new Response(JSON.stringify({ data: null })),
      () => new Response(JSON.stringify({ data: { organization: { name: 42 } } })),
      () => new Response(JSON.stringify({ data: { organization: { name: "   " } } })),
    ];
    for (const graphql of replies) {
      const run = setup({}, fakeLinear({ graphql }));
      expect(await runLogin(run.deps)).toEqual({ workspace: undefined });
      expect(run.saved).toHaveLength(1);
    }
  });

  test("is cleaned of control characters and cut short", async () => {
    const nasty = `Acme\u001b[31m‮${"x".repeat(500)}`;
    const linear = fakeLinear({ graphql: () => new Response(JSON.stringify({ data: { organization: { name: nasty } } })) });
    const run = setup({}, linear);
    const { workspace } = await runLogin(run.deps);
    expect(workspace).not.toContain("\u001b");
    expect(workspace).not.toContain("‮");
    expect((workspace ?? "").length).toBeLessThanOrEqual(100);
  });
});

describe("when the login can't finish", () => {
  test("pressing Cancel on Linear's page: nothing is saved and no tokens are requested", async () => {
    const run = setup({}, fakeLinear(), { error: "access_denied" });
    expect(await failureOf(runLogin(run.deps))).toBe("Login cancelled.");
    expect(run.saved).toHaveLength(0);
    expect(run.linear.calls).toHaveLength(0);
  });

  test("another error from Linear's page is passed on", async () => {
    const run = setup({}, fakeLinear(), { error: "server_error" });
    expect(await failureOf(runLogin(run.deps))).toContain("server_error");
    expect(run.saved).toHaveLength(0);
  });

  test("nobody finishes in time: says how to try again", async () => {
    const run = setup({
      openBrowser: () => {}, // a browser that never comes back
      serverOptions: { ports: [0], redirectUriForPort: (p) => `http://127.0.0.1:${p}/callback`, timeoutMs: 80 },
    });
    const message = await failureOf(runLogin(run.deps));
    expect(message).toContain("Timed out");
    expect(message).toContain("tangent login");
    expect(run.saved).toHaveLength(0);
  });

  test("Linear refuses the code: shows its reason, saves nothing", async () => {
    const refusal = () => new Response(JSON.stringify({ error: "invalid_grant", error_description: "The code has expired." }), { status: 400 });
    const run = setup({}, fakeLinear({ token: refusal }));
    expect(await failureOf(runLogin(run.deps))).toContain("The code has expired.");
    expect(run.saved).toHaveLength(0);
  });

  test("Linear's login service is down (not JSON): reports the HTTP status", async () => {
    const run = setup({}, fakeLinear({ token: () => new Response("<html>oops</html>", { status: 502 }) }));
    expect(await failureOf(runLogin(run.deps))).toContain("HTTP 502");
    expect(run.saved).toHaveLength(0);
  });

  test("no network for the code exchange", async () => {
    const run = setup({}, fakeLinear({ tokenThrows: true }));
    expect(await failureOf(runLogin(run.deps))).toContain("Couldn't reach Linear");
    expect(run.saved).toHaveLength(0);
  });

  test("a reply with too few permissions is refused", async () => {
    const narrow = () => new Response(JSON.stringify({ ...goodTokenReply, scope: "read" }));
    const run = setup({}, fakeLinear({ token: narrow }));
    expect(await failureOf(runLogin(run.deps))).toContain("issues:create");
    expect(run.saved).toHaveLength(0);
  });

  test("every registered port busy: says so before any browser opens", async () => {
    const blocker = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("busy") });
    try {
      const run = setup({
        serverOptions: { ports: [blocker.port ?? 0], redirectUriForPort: (p) => `http://127.0.0.1:${p}/callback`, timeoutMs: 1000 },
      });
      expect(await failureOf(runLogin(run.deps))).toContain("Couldn't listen");
      expect(run.browser.opened).toHaveLength(0);
      expect(run.lines).toHaveLength(0);
    } finally {
      await blocker.stop(true);
    }
  });

  test("the token store fails: says so and does not claim success", async () => {
    const run = setup({
      save: async () => {
        throw new Error("the Keychain is locked");
      },
    });
    const message = await failureOf(runLogin(run.deps));
    expect(message).toContain("Couldn't save the login");
    expect(message).toContain("the Keychain is locked");
    expect(run.lines.join("\n")).not.toContain("Logged in");
  });

  test("frees the port after a failure too", async () => {
    const run = setup({}, fakeLinear(), { error: "access_denied" });
    await failureOf(runLogin(run.deps));
    const port = Number(new URL(new URL(run.browser.opened[0] ?? "").searchParams.get("redirect_uri") ?? "").port);
    const again = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("ok") });
    expect(again.port).toBe(port);
    await again.stop(true);
  });
});

describe("when the browser can't be opened", () => {
  test("the address is printed, and the login still works if it is opened by hand", async () => {
    const run = setup({
      openBrowser: () => {
        throw new Error("no browser");
      },
    });
    const login = runLogin(run.deps);
    // The person copies the printed address into a browser; this stands in for that.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const printed = run.lines.find((line) => line.startsWith("https://linear.app/oauth/authorize"));
    expect(printed).toBeDefined();
    const link = new URL(printed ?? "");
    const redirect = link.searchParams.get("redirect_uri") ?? "";
    await fetch(`${redirect}?code=by-hand&state=${link.searchParams.get("state")}`);
    expect(await login).toEqual({ workspace: "Acme Corp" });
    expect(run.saved).toHaveLength(1);
  });
});

describe("tokens never leak", () => {
  test("not into anything printed, and not into error messages", async () => {
    const ok = setup();
    await runLogin(ok.deps);
    expect(ok.lines.join("\n")).not.toContain("SECRET");

    const failing = setup({}, fakeLinear({ token: () => new Response(JSON.stringify({ ...goodTokenReply, scope: "read" })) }));
    const message = await failureOf(runLogin(failing.deps));
    expect(message).not.toContain("SECRET");
    expect(failing.lines.join("\n")).not.toContain("SECRET");
  });
});
