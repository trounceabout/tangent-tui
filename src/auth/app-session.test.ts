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
// `unreadable` lists items whose lookup FAILS the way a locked Keychain does (exit 36), as opposed to
// "no such item" (44).
function fakeKeychain(items: Record<string, string>, unreadable: string[] = []) {
  spawn = spyOn(Bun, "spawn").mockImplementation(((command: string[]) => {
    const service = command[command.indexOf("-s") + 1] ?? "";
    asked.push(service);
    const stored = items[service];
    const exitCode = unreadable.includes(service) ? 36 : stored === undefined ? 44 : 0;
    return {
      stdout: new Response(stored === undefined ? "" : `${stored}\n`).body,
      stderr: new Response("").body,
      exited: Promise.resolve(exitCode),
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

  test("a login item that isn't ours at all (not even base64url) is ignored and the API key is used", async () => {
    // Text that is NOT base64url makes the secret store raise a DamagedSecretError; the token store turns
    // that into "not logged in". (An earlier version of this test used text that happened to BE valid
    // base64url, so it never reached that path.)
    fakeKeychain({ "tangent-oauth": "not a login blob!", "linear-api-key": "lin_api_saved" });
    expect(await getAuthHeader()).toBe("lin_api_saved");
  });

  test("a login item that is valid base64url but not our JSON is ignored too", async () => {
    // (This is also what the app's own tests rely on: their fake Keychain answers every lookup alike.)
    fakeKeychain({ "tangent-oauth": "not-a-login-blob", "linear-api-key": "lin_api_saved" });
    expect(await getAuthHeader()).toBe("lin_api_saved");
  });

  test("a damaged login item with no other credential says to log in, not that something broke", async () => {
    fakeKeychain({ "tangent-oauth": "not a login blob!" });
    await expect(getAuthHeader()).rejects.toBeInstanceOf(LoginRequiredError);
  });

  test("a Keychain that can't be read for the API key is an ERROR, not 'Not logged in'", async () => {
    fakeKeychain({}, ["linear-api-key"]);
    const error = await getAuthHeader().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(LoginRequiredError);
    expect((error as Error).message).toContain("Couldn't read the saved API key");
  });

  test("a Keychain that can't be read for the login is an ERROR too, and the API key is not consulted", async () => {
    fakeKeychain({ "linear-api-key": "lin_api_saved" }, ["tangent-oauth"]);
    await expect(getAuthHeader()).rejects.toThrow("Couldn't read");
    expect(asked).not.toContain("linear-api-key");
  });

  test("an empty saved API key counts as none, so the LINEAR_API_KEY variable is used", async () => {
    fakeKeychain({ "linear-api-key": "" });
    process.env.LINEAR_API_KEY = "lin_api_env";
    expect(await getAuthHeader()).toBe("lin_api_env");
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
