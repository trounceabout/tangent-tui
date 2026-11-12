// Tests for src/auth/app-session.ts: the real wiring (vault, lock path, saved key, environment).
//
// The Keychain is replaced by a fake that answers per item name, so these NEVER touch the real
// Keychain. The environment variables they change are restored afterwards.

import { type Mock, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { getAuthHeader, loginLockPath } from "./app-session.ts";
import { LoginRequiredError } from "./session.ts";

const HOUR = 60 * 60 * 1000;

// What the saved login looks like in the Keychain: base64url of the versioned JSON blob.
const savedLogin = (expiresAt: number) =>
  Buffer.from(
    JSON.stringify({
      version: 1,
      accessToken: "access-SECRET",
      refreshToken: "refresh-SECRET",
      expiresAt,
      scopes: ["issues:create", "read"],
    }),
  ).toString("base64url");

let spawn: Mock<typeof Bun.spawn>;
let asked: string[]; // which Keychain items were looked up
const saved = { key: process.env.LINEAR_API_KEY, xdg: process.env.XDG_CONFIG_HOME };

// A fake `security`: answers a lookup by item name (the text after -s), exit 44 when there is none.
function fakeKeychain(items: Record<string, string>) {
  spawn = spyOn(Bun, "spawn").mockImplementation(((command: string[]) => {
    const service = command[command.indexOf("-s") + 1] ?? "";
    asked.push(service);
    const stored = items[service];
    return {
      stdout: new Response(stored === undefined ? "" : `${stored}\n`).body,
      stderr: new Response("").body,
      exited: Promise.resolve(stored === undefined ? 44 : 0),
    };
  }) as never);
}

beforeEach(() => {
  asked = [];
  delete process.env.LINEAR_API_KEY;
});
afterEach(() => {
  spawn?.mockRestore();
  if (saved.key === undefined) delete process.env.LINEAR_API_KEY;
  else process.env.LINEAR_API_KEY = saved.key;
  if (saved.xdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = saved.xdg;
});

describe("getAuthHeader", () => {
  test("a saved API key is sent as it is", async () => {
    fakeKeychain({ "linear-api-key": "lin_api_saved" });
    expect(await getAuthHeader()).toBe("lin_api_saved");
  });

  test("a saved browser login is sent as a Bearer token", async () => {
    fakeKeychain({ "tangent-oauth": savedLogin(Date.now() + HOUR) });
    expect(await getAuthHeader()).toBe("Bearer access-SECRET");
  });

  test("a browser login wins over a saved API key, which isn't even looked up", async () => {
    fakeKeychain({ "tangent-oauth": savedLogin(Date.now() + HOUR), "linear-api-key": "lin_api_saved" });
    expect(await getAuthHeader()).toBe("Bearer access-SECRET");
    expect(asked).not.toContain("linear-api-key");
  });

  test("with no saved login, a damaged one is ignored and the API key is used", async () => {
    // (This is also what the app's own tests rely on: their fake Keychain answers every lookup alike.)
    fakeKeychain({ "tangent-oauth": "not-a-login-blob", "linear-api-key": "lin_api_saved" });
    expect(await getAuthHeader()).toBe("lin_api_saved");
  });

  test("the LINEAR_API_KEY variable is used when the Keychain has neither", async () => {
    fakeKeychain({});
    process.env.LINEAR_API_KEY = "lin_api_env";
    expect(await getAuthHeader()).toBe("lin_api_env");
  });

  test("with nothing anywhere it says how to log in", async () => {
    fakeKeychain({});
    await expect(getAuthHeader()).rejects.toBeInstanceOf(LoginRequiredError);
  });

  test("on a system that can't save a login, it never looks for one and the variable still works", async () => {
    fakeKeychain({});
    process.env.LINEAR_API_KEY = "lin_api_env";
    const original = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "linux" });
    try {
      expect(await getAuthHeader()).toBe("lin_api_env");
      expect(asked).not.toContain("tangent-oauth");
    } finally {
      if (original) Object.defineProperty(process, "platform", original);
    }
  });
});

describe("loginLockPath", () => {
  test("sits in the settings folder that XDG_CONFIG_HOME picks, so tests never touch the real one", () => {
    process.env.XDG_CONFIG_HOME = "/somewhere/temporary";
    expect(loginLockPath()).toBe("/somewhere/temporary/tangent/login.lock");
  });

  test("falls back to ~/.config/tangent when XDG_CONFIG_HOME isn't set", () => {
    delete process.env.XDG_CONFIG_HOME;
    expect(loginLockPath().endsWith("/.config/tangent/login.lock")).toBe(true);
  });
});
