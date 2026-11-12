// Tests for src/auth/callback.ts: the local server that catches Linear's redirect.
//
// These start a REAL server on a free port (port 0 lets the system pick one) and talk to it
// over the loopback network. No browser and no Linear are involved.

import { afterEach, describe, expect, test } from "bun:test";
import { connect } from "node:net";
import { networkInterfaces } from "node:os";
import { type CallbackOptions, type CallbackServer, startCallbackServer } from "./callback.ts";

const STATE = "the-secret-state";
const open: CallbackServer[] = [];
const extras: { stop(force?: boolean): unknown }[] = [];

afterEach(async () => {
  for (const server of open.splice(0)) await server.close();
  for (const extra of extras.splice(0)) await extra.stop(true);
});

// Start a callback server on a free port with a short timeout.
function start(overrides: Partial<CallbackOptions> = {}): CallbackServer {
  const server = startCallbackServer({
    state: STATE,
    ports: [0],
    redirectUriForPort: (port) => `http://127.0.0.1:${port}/callback`,
    timeoutMs: 3000,
    ...overrides,
  });
  open.push(server);
  return server;
}

const url = (server: CallbackServer, query: string, path = "/callback") => `http://127.0.0.1:${server.port}${path}${query}`;

// What the browser does at the end of a real login.
const redirect = (server: CallbackServer, query: string) => fetch(url(server, query));

// Send raw text over a plain connection, so we can forge headers that fetch won't let us.
function rawRequest(port: number, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    let received = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("raw request timed out"));
    }, 3000);
    socket.on("data", (chunk) => {
      received += chunk.toString();
      // The status line and headers are all these tests read. Bun keeps the socket open after a
      // reply, so don't wait for it to end (that only ever timed out).
      if (received.includes("\r\n\r\n")) {
        clearTimeout(timer);
        socket.destroy();
        resolve(received);
      }
    });
    socket.on("end", () => {
      clearTimeout(timer);
      resolve(received);
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.write(text);
  });
}

// Wait until a promise has settled, or give up after a moment (so "still waiting" can be asserted).
async function settledWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  return Promise.race([promise.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms))]);
}

describe("a successful login", () => {
  test("hands over the code and shows a friendly page", async () => {
    const server = start();
    const response = await redirect(server, `?code=abc123&state=${STATE}`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("You're logged in");
    expect(await server.result).toEqual({ kind: "code", code: "abc123" });
  });

  test("builds the redirect address from the port it actually got", () => {
    const server = start();
    expect(server.redirectUri).toBe(`http://127.0.0.1:${server.port}/callback`);
  });

  test("the browser still gets its page when the server is closed right after the code arrives", async () => {
    // The issue #66 spike stopped the server too hard, cutting the response off, and the
    // browser showed "can't connect" even though the login had worked.
    const server = start();
    const pending = redirect(server, `?code=abc&state=${STATE}`);
    await server.result;
    await server.close();
    const response = await pending;
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("You're logged in");
  });
});

describe("only the genuine redirect can end the wait", () => {
  test("a wrong state is refused and the wait goes on", async () => {
    const server = start();
    const stray = await redirect(server, "?code=evil&state=guess");
    expect(stray.status).toBe(400);
    expect(await settledWithin(server.result, 150)).toBe(false);
    await redirect(server, `?code=real&state=${STATE}`);
    expect(await server.result).toEqual({ kind: "code", code: "real" });
  });

  test("a missing state is refused and the wait goes on", async () => {
    const server = start();
    expect((await redirect(server, "?code=evil")).status).toBe(400);
    expect(await settledWithin(server.result, 150)).toBe(false);
  });

  test("other paths and methods are 404 and don't end the wait", async () => {
    const server = start();
    expect((await fetch(url(server, "", "/"))).status).toBe(404);
    expect((await fetch(url(server, "", "/favicon.ico"))).status).toBe(404);
    expect((await fetch(url(server, `?code=x&state=${STATE}`), { method: "POST" })).status).toBe(404);
    expect(await settledWithin(server.result, 150)).toBe(false);
  });

  test("a request that names another host is refused (DNS-rebinding guard)", async () => {
    const server = start();
    const reply = await rawRequest(
      server.port,
      `GET /callback?code=evil&state=${STATE} HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n`,
    );
    expect(reply.startsWith("HTTP/1.1 400")).toBe(true);
    expect(await settledWithin(server.result, 150)).toBe(false);
  });

  test("takes exactly one answer: later requests are 404 and the first result stands", async () => {
    const server = start();
    await redirect(server, `?code=first&state=${STATE}`);
    const again = await redirect(server, `?code=second&state=${STATE}`);
    expect(again.status).toBe(404);
    expect(await server.result).toEqual({ kind: "code", code: "first" });
  });
});

describe("when the login doesn't produce a code", () => {
  test("pressing Cancel on Linear's page is 'denied'", async () => {
    const server = start();
    const response = await redirect(server, `?error=access_denied&state=${STATE}`);
    expect(await response.text()).toContain("Login cancelled");
    expect(await server.result).toEqual({ kind: "denied" });
  });

  test("another error from Linear is passed on, cleaned and cut short", async () => {
    const server = start();
    const nasty = `bad\u001b[31m${"x".repeat(500)}‮`;
    await redirect(server, `?error=${encodeURIComponent(nasty)}&state=${STATE}`);
    const result = await server.result;
    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.error).not.toContain("\u001b");
    expect(result.error).not.toContain("‮");
    expect(result.error.length).toBeLessThanOrEqual(100);
  });

  test("the right state with no code is an error, not a hang", async () => {
    const server = start();
    expect((await redirect(server, `?state=${STATE}`)).status).toBe(400);
    expect((await server.result).kind).toBe("error");
  });

  test("an absurdly long code is refused", async () => {
    const server = start();
    await redirect(server, `?code=${"a".repeat(5000)}&state=${STATE}`);
    expect((await server.result).kind).toBe("error");
  });

  test("gives up after the timeout, and then refuses everything", async () => {
    const server = start({ timeoutMs: 60 });
    expect(await server.result).toEqual({ kind: "timeout" });
    expect((await redirect(server, `?code=late&state=${STATE}`)).status).toBe(404);
  });
});

describe("the pages never echo what the URL said", () => {
  test("script text in the query string does not appear in the page", async () => {
    const server = start();
    const evil = "<script>alert(1)</script>";
    const response = await redirect(server, `?error=${encodeURIComponent(evil)}&state=${STATE}`);
    const html = await response.text();
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("alert(1)");
  });
});

describe("closing", () => {
  test("close() before any answer settles the result as 'closed' instead of leaving it pending", async () => {
    const server = start();
    await server.close();
    expect(await settledWithin(server.result, 200)).toBe(true);
    expect(await server.result).toEqual({ kind: "closed" });
  });

  test("close() after an answer leaves that answer alone", async () => {
    const server = start();
    await redirect(server, `?code=abc&state=${STATE}`);
    await server.close();
    expect(await server.result).toEqual({ kind: "code", code: "abc" });
  });

  test("close() after a timeout leaves the timeout alone", async () => {
    const server = start({ timeoutMs: 30 });
    expect(await server.result).toEqual({ kind: "timeout" });
    await server.close();
    expect(await server.result).toEqual({ kind: "timeout" });
  });

  test("closing twice is fine", async () => {
    const server = start();
    await server.close();
    await server.close();
  });

  test("no longer listens once closed", async () => {
    const server = start();
    const port = server.port;
    await server.close();
    const again = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("ok") });
    extras.push(again);
    expect(again.port).toBe(port);
  });

  test("if working out the redirect address throws, the server is stopped before the error leaves", async () => {
    let listeningOn = 0;
    expect(() =>
      startCallbackServer({
        state: STATE,
        ports: [0],
        redirectUriForPort: (port) => {
          listeningOn = port;
          throw new Error("no address for this port");
        },
      }),
    ).toThrow("no address for this port");
    expect(listeningOn).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 50)); // stop(true) is fire-and-forget
    const again = Bun.serve({ hostname: "127.0.0.1", port: listeningOn, fetch: () => new Response("ok") });
    extras.push(again);
    expect(again.port).toBe(listeningOn); // the port is free again, so nothing was left listening
  });
});

describe("where it listens", () => {
  test("only on the loopback address, not on the network", async () => {
    // Find this machine's own non-loopback IPv4 address, if it has one. A server that listened
    // on every interface would answer there; ours must refuse the connection.
    const external = Object.values(networkInterfaces())
      .flat()
      .find((address) => address?.family === "IPv4" && !address.internal);
    if (!external) return; // no network interface to test against (e.g. an offline sandbox)
    const server = start();
    // The loopback address must really answer (this used to pass only by timing out)...
    const viaLoopback = await rawRequest(server.port, `GET / HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\n\r\n`);
    expect(viaLoopback.startsWith("HTTP/1.1 404")).toBe(true);
    // ...and the machine's own network address must not.
    const viaNetwork = await new Promise<string>((resolve) => {
      const socket = connect(server.port, external.address);
      socket.on("connect", () => {
        socket.destroy();
        resolve("connected");
      });
      socket.on("error", () => resolve("refused"));
    });
    expect(viaNetwork).toBe("refused");
  });

  test("moves on to the next port when one is busy", async () => {
    const blocker = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("busy") });
    extras.push(blocker);
    const server = start({ ports: [blocker.port ?? 0, 0] });
    expect(server.port).not.toBe(blocker.port);
  });

  test("says so clearly when every port is busy", () => {
    const blocker = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("busy") });
    extras.push(blocker);
    expect(() => startCallbackServer({ state: STATE, ports: [blocker.port ?? 0] })).toThrow("Couldn't listen on port");
  });
});
