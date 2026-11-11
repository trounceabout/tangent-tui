// src/auth/callback.ts
// The small web server that catches Linear's redirect at the end of a browser login.
// It runs only for the few seconds a login takes. See issue #68.
//
// Anything on this computer can send a request to the port it listens on, so it is strict:
//  - it listens on 127.0.0.1 ONLY, never on the network;
//  - it checks the Host header, so a web page can't reach it through a DNS-rebinding trick;
//  - a request with the wrong `state` is refused and the wait CONTINUES. Only the genuine
//    redirect carries our secret `state`, so a stray request can't cancel your login;
//  - it takes exactly one answer, then refuses everything else;
//  - its pages are fixed text: nothing from the URL is ever repeated back.

import { cleanText } from "../linear.ts";
import { REDIRECT_PORTS, redirectUriFor } from "./config.ts";

// How the wait ended.
export type CallbackResult =
  | { kind: "code"; code: string } // the login worked: trade this code for tokens
  | { kind: "denied" } // the person pressed Cancel on Linear's consent screen
  | { kind: "error"; error: string } // Linear sent another error (already cleaned)
  | { kind: "timeout" }; // nobody finished in time

export interface CallbackServer {
  readonly port: number;
  readonly redirectUri: string; // put this in the login address
  readonly result: Promise<CallbackResult>; // settles once, when the wait ends
  close(): Promise<void>; // stop listening, after any answer in flight has been sent
}

export interface CallbackOptions {
  state: string; // the secret from createState(); the redirect must carry it back
  timeoutMs?: number;
  // The two below exist so tests can use a free port. Real code leaves them alone.
  ports?: readonly number[];
  redirectUriForPort?: (port: number) => string;
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_CODE_CHARS = 2000;
const MAX_ERROR_CHARS = 100;

// A tiny fixed page for the browser. `message` is always one of our own strings.
function page(message: string, status = 200): Response {
  const html =
    '<!doctype html><meta charset="utf-8"><title>Tangent</title>' +
    '<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem">' +
    `<h1>Tangent</h1><p>${message}</p></body>`;
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      // Ask the browser not to keep the connection open, so shutting down is never held up.
      connection: "close",
    },
  });
}

const notFound = (): Response => new Response("Not found", { status: 404, headers: { connection: "close" } });

// Start listening on the first free registered port. Throws if none is free.
export function startCallbackServer(options: CallbackOptions): CallbackServer {
  const {
    state,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    ports = REDIRECT_PORTS,
    redirectUriForPort = redirectUriFor,
  } = options;

  let done = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settle!: (result: CallbackResult) => void;
  const result = new Promise<CallbackResult>((resolve) => {
    settle = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
  });

  let server: ReturnType<typeof Bun.serve> | undefined;
  const handle = (req: Request): Response => {
    const url = new URL(req.url);
    if (done || req.method !== "GET" || url.pathname !== "/callback") return notFound();

    // The browser must be talking to us by our own loopback address. A page on the internet
    // that points its own name at 127.0.0.1 would arrive with a different Host.
    if (req.headers.get("host") !== `127.0.0.1:${server?.port}`) return page("Bad request.", 400);

    // Not our login: refuse it and keep waiting for the real one.
    if (url.searchParams.get("state") !== state) {
      return page("This login link doesn't match. Run `tangent login` again.", 400);
    }

    const error = url.searchParams.get("error");
    if (error !== null) {
      if (error === "access_denied") {
        settle({ kind: "denied" });
        return page("Login cancelled. You can close this tab.");
      }
      settle({ kind: "error", error: cleanText(error).slice(0, MAX_ERROR_CHARS) });
      return page("Linear reported a problem. You can close this tab and check your terminal.", 400);
    }

    const code = url.searchParams.get("code");
    if (!code || code.length > MAX_CODE_CHARS) {
      settle({ kind: "error", error: "Linear sent no usable login code." });
      return page("Linear didn't send a login code. You can close this tab and check your terminal.", 400);
    }

    settle({ kind: "code", code });
    return page("You're logged in. You can close this tab and go back to your terminal.");
  };

  for (const port of ports) {
    try {
      server = Bun.serve({ hostname: "127.0.0.1", port, fetch: handle });
      break;
    } catch {
      // That port is busy (or not allowed); try the next one.
    }
  }
  if (!server) {
    const which = ports.length === 1 ? `port ${ports[0]}` : `ports ${ports.join(", ")}`;
    throw new Error(`Couldn't listen on ${which} of 127.0.0.1. Close whatever is using ${ports.length === 1 ? "it" : "them"} and try again.`);
  }

  const bound = server; // fixed for the closures below
  timer = setTimeout(() => settle({ kind: "timeout" }), timeoutMs);
  timer.unref?.();

  return {
    port: bound.port ?? 0,
    redirectUri: redirectUriForPort(bound.port ?? 0),
    result,
    // `stop()` without `true` lets a response already on its way finish, so the browser always
    // gets its "you can close this tab" page (stopping hard cut it off in the issue #66 spike).
    close: async () => {
      clearTimeout(timer);
      await bound.stop();
    },
  };
}
