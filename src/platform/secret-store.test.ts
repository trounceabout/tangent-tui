// Tests for src/platform/secret-store.ts: keeping a secret in the system vault.
//
// A fake `security` tool stands in for the real one, so these NEVER touch your Keychain.
// The fake copies the real tool's behavior that matters: it takes commands over stdin, it
// echoes a bad command back in its error text (which could contain the secret), and it
// cuts an over-long stdin line, which is what the size cap protects against.

import { describe, expect, test } from "bun:test";
import {
  DamagedSecretError,
  ACCOUNT,
  MAX_STORED_CHARS,
  type Run,
  type RunResult,
  createMacSecretStore,
  createSecretStore,
  defaultRun,
} from "./secret-store.ts";

const SECRET = '{"accessToken":"access-SECRET","note":"é ☃ \\"quoted\\" \\\\ back"}';

type Call = { command: string[]; stdin?: string };

// A fake macOS `security`. Items live in a Map; every call is recorded.
function fakeSecurity(options: { cutLinesAt?: number; failAdd?: boolean; ignoreAdd?: boolean; findExit?: number; storedText?: string } = {}) {
  const items = new Map<string, string>(); // name -> stored text
  const calls: Call[] = [];
  const run: Run = async (command, opts = {}): Promise<RunResult> => {
    calls.push({ command, stdin: opts.stdin });
    const [tool, sub] = command;
    if (tool === "security" && sub === "-i") {
      let line = (opts.stdin ?? "").split("\n")[0] ?? "";
      if (options.cutLinesAt !== undefined) line = line.slice(0, options.cutLinesAt); // the real tool cuts here
      if (options.failAdd) return { exitCode: 1, stdout: "", stderr: `security: unknown command "${line.slice(-60)}"` };
      const name = /-s (\S+)/.exec(line)?.[1] ?? "";
      const hex = /-X (\S+)/.exec(line)?.[1] ?? "";
      if (!options.ignoreAdd) items.set(name, Buffer.from(hex, "hex").toString("ascii"));
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (sub === "find-generic-password") {
      if (options.findExit !== undefined) return { exitCode: options.findExit, stdout: "", stderr: "" };
      const name = command[command.indexOf("-s") + 1] ?? "";
      const stored = options.storedText ?? items.get(name);
      return stored === undefined ? { exitCode: 44, stdout: "", stderr: "not found" } : { exitCode: 0, stdout: `${stored}\n`, stderr: "" };
    }
    if (sub === "delete-generic-password") {
      const name = command[command.indexOf("-s") + 1] ?? "";
      return items.delete(name) ? { exitCode: 0, stdout: "", stderr: "" } : { exitCode: 44, stdout: "", stderr: "not found" };
    }
    throw new Error(`unexpected command: ${command.join(" ")}`);
  };
  return { run, calls, items };
}

const messageOf = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected a failure");
};

describe("set and get", () => {
  test("a secret goes in and comes back identical, including quotes, unicode and backslashes", async () => {
    const fake = fakeSecurity();
    const store = createMacSecretStore(fake.run);
    await store.set("tangent-oauth", SECRET);
    expect(await store.get("tangent-oauth")).toBe(SECRET);
  });

  test("setting again replaces the old value", async () => {
    const store = createMacSecretStore(fakeSecurity().run);
    await store.set("tangent-oauth", "first");
    await store.set("tangent-oauth", "second");
    expect(await store.get("tangent-oauth")).toBe("second");
  });

  test("nothing stored means null, not an error", async () => {
    expect(await createMacSecretStore(fakeSecurity().run).get("tangent-oauth")).toBeNull();
  });

  test("two names don't mix", async () => {
    const store = createMacSecretStore(fakeSecurity().run);
    await store.set("tangent-oauth", "one");
    await store.set("other-thing", "two");
    expect(await store.get("tangent-oauth")).toBe("one");
    expect(await store.get("other-thing")).toBe("two");
  });
});

describe("the account name", () => {
  test("is 'tangent', and is what every lookup, write and delete uses", async () => {
    expect(ACCOUNT).toBe("tangent");
    const fake = fakeSecurity();
    const store = createMacSecretStore(fake.run);
    await store.set("tangent-oauth", "v");
    await store.get("tangent-oauth");
    await store.delete("tangent-oauth");
    const write = fake.calls.find((call) => call.stdin !== undefined)?.stdin ?? "";
    expect(write).toContain(`-a ${ACCOUNT} `);
    for (const call of fake.calls.filter((call) => call.stdin === undefined)) {
      expect(call.command[call.command.indexOf("-a") + 1]).toBe(ACCOUNT);
    }
  });
});

describe("the secret never appears in a command line", () => {
  test("not when writing: it goes in over stdin as one hex-encoded line", async () => {
    const fake = fakeSecurity();
    await createMacSecretStore(fake.run).set("tangent-oauth", SECRET);
    const write = fake.calls.find((call) => call.stdin !== undefined);
    expect(write?.command).toEqual(["security", "-i"]);
    for (const call of fake.calls) {
      const argv = call.command.join(" ");
      expect(argv).not.toContain("SECRET");
      expect(argv).not.toContain(Buffer.from(SECRET).toString("base64url"));
    }
    // One command on one line, and the value is hex (so it can't contain a space or a newline).
    expect(write?.stdin?.endsWith("\n")).toBe(true);
    expect(write?.stdin?.trimEnd().includes("\n")).toBe(false);
    expect(write?.stdin).toMatch(/^add-generic-password -U -a tangent -s tangent-oauth -X [0-9a-f]+\n$/);
  });

  test("not when reading either", async () => {
    const fake = fakeSecurity();
    const store = createMacSecretStore(fake.run);
    await store.set("tangent-oauth", SECRET);
    fake.calls.length = 0;
    await store.get("tangent-oauth");
    expect(fake.calls[0]?.command.join(" ")).not.toContain("SECRET");
    expect(fake.calls[0]?.command).toEqual(["security", "find-generic-password", "-s", "tangent-oauth", "-a", "tangent", "-w"]);
  });
});

describe("names are checked before anything runs", () => {
  const bad = ["", "has space", "new\nline", 'quo"te', "semi;colon", "-leading-dash", "UPPER", "a".repeat(64), "back`tick", "x -X deadbeef"];

  test("a name that could change the command is refused", async () => {
    for (const name of bad) {
      const fake = fakeSecurity();
      const store = createMacSecretStore(fake.run);
      expect(await messageOf(store.set(name, "v"))).toContain("not a valid secret name");
      expect(await messageOf(store.get(name))).toContain("not a valid secret name");
      expect(await messageOf(store.delete(name))).toContain("not a valid secret name");
      expect(fake.calls).toHaveLength(0);
    }
  });

  test("ordinary names are accepted", async () => {
    const store = createMacSecretStore(fakeSecurity().run);
    for (const name of ["tangent-oauth", "a", "tangent.oauth_2", "0abc"]) await store.set(name, "v");
  });
});

describe("the size cap", () => {
  test("the cap is 1700 stored characters (the number the line-length limit was measured against)", () => {
    expect(MAX_STORED_CHARS).toBe(1700);
  });

  test("the boundary: 1275 bytes (exactly 1700 stored characters) is accepted, ONE byte more is refused without running anything", async () => {
    // Stored text is base64url: 3 bytes become 4 characters, so 1275 bytes is exactly 1700 characters
    // and 1276 bytes is 1702. Literal numbers on purpose: a test built from the constant moves with it.
    const fits = fakeSecurity();
    await createMacSecretStore(fits.run).set("tangent-oauth", "x".repeat(1275));
    expect(fits.calls.length).toBeGreaterThan(0);

    const tooBig = fakeSecurity();
    const message = await messageOf(createMacSecretStore(tooBig.run).set("tangent-oauth", "x".repeat(1276)));
    expect(message).toContain("too large");
    expect(tooBig.calls).toHaveLength(0);
  });

  test("a value far over the cap is refused too", async () => {
    const tooBig = fakeSecurity();
    expect(await messageOf(createMacSecretStore(tooBig.run).set("tangent-oauth", "x".repeat(5000)))).toContain("too large");
    expect(tooBig.calls).toHaveLength(0);
  });

  test("the longest line we would send stays well under the tool's 4 KB cut-off", async () => {
    const fake = fakeSecurity();
    // The longest allowed name (63 characters) plus the largest allowed value (1275 bytes): the worst case.
    await createMacSecretStore(fake.run).set("a".repeat(63), "x".repeat(1275));
    const line = fake.calls.find((call) => call.stdin !== undefined)?.stdin ?? "";
    expect(line.length).toBeLessThan(3600); // about 3,500; the tool's cut-off is about 4,096
    expect(line.length).toBeGreaterThan(3400); // and it really is the worst case, not a short line
  });
});

describe("failures are errors, never silent", () => {
  test("a write the tool reports as failed", async () => {
    const store = createMacSecretStore(fakeSecurity({ failAdd: true }).run);
    expect(await messageOf(store.set("tangent-oauth", SECRET))).toContain("Couldn't save");
  });

  test("a write that the tool says worked but didn't store (caught by reading it back)", async () => {
    const store = createMacSecretStore(fakeSecurity({ ignoreAdd: true }).run);
    expect(await messageOf(store.set("tangent-oauth", SECRET))).toContain("Couldn't verify");
  });

  test("a write that was cut short (caught by reading it back)", async () => {
    const store = createMacSecretStore(fakeSecurity({ cutLinesAt: 80 }).run);
    expect(await messageOf(store.set("tangent-oauth", SECRET))).toContain("Couldn't verify");
  });

  test("a read that fails for any reason other than 'not found'", async () => {
    const store = createMacSecretStore(fakeSecurity({ findExit: 36 }).run);
    expect(await messageOf(store.get("tangent-oauth"))).toContain("Couldn't read");
  });

  test("stored text that isn't plain base64url is a DamagedSecretError, not a secret", async () => {
    // (Text that merely LOOKS like base64url is accepted here; the token store checks the JSON.)
    for (const storedText of ["not base64url!!", "has space", "<script>", "a=b", ""]) {
      const store = createMacSecretStore(fakeSecurity({ storedText }).run);
      const error = await store.get("tangent-oauth").then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(DamagedSecretError);
      expect((error as Error).message).toContain("damaged");
    }
  });

  test("a vault that can't be read is NOT a DamagedSecretError (callers treat the two differently)", async () => {
    const store = createMacSecretStore(fakeSecurity({ findExit: 36 }).run);
    const error = await store.get("tangent-oauth").then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(DamagedSecretError);
  });

  test("an item that isn't there is null, not an error of either kind", async () => {
    expect(await createMacSecretStore(fakeSecurity().run).get("tangent-oauth")).toBeNull();
  });
});

describe("error messages never leak the secret", () => {
  test("not even when the tool's own error text echoes the command back", async () => {
    // The real tool prints `unknown command "<the hex>"`; our message must not repeat any of it.
    const fake = fakeSecurity({ failAdd: true });
    const message = await messageOf(createMacSecretStore(fake.run).set("tangent-oauth", SECRET));
    const hex = Buffer.from(Buffer.from(SECRET).toString("base64url")).toString("hex");
    expect(message).not.toContain("SECRET");
    expect(message).not.toContain(hex.slice(-20));
  });

  test("not when the value is too large", async () => {
    const message = await messageOf(createMacSecretStore(fakeSecurity().run).set("tangent-oauth", `SECRET${"x".repeat(5000)}`));
    expect(message).not.toContain("SECRET");
  });
});

describe("delete", () => {
  test("removes the secret", async () => {
    const store = createMacSecretStore(fakeSecurity().run);
    await store.set("tangent-oauth", "v");
    await store.delete("tangent-oauth");
    expect(await store.get("tangent-oauth")).toBeNull();
  });

  test("removing one that isn't there is fine", async () => {
    await createMacSecretStore(fakeSecurity().run).delete("tangent-oauth");
  });
});

describe("createSecretStore", () => {
  test("gives the macOS store on macOS", () => {
    expect(createSecretStore("darwin", fakeSecurity().run)).toBeDefined();
  });

  test("says clearly that other systems aren't supported yet", () => {
    expect(() => createSecretStore("linux")).toThrow("isn't supported on linux yet");
    expect(() => createSecretStore("win32")).toThrow("isn't supported on win32 yet");
  });
});

describe("defaultRun (the real process runner, with harmless commands)", () => {
  test("sends stdin to the program and returns its output", async () => {
    const result = await defaultRun(["cat"], { stdin: "hello there\n" });
    expect(result).toEqual({ exitCode: 0, stdout: "hello there\n", stderr: "" });
  });

  test("reports a failing exit code and what the program said on stderr", async () => {
    const result = await defaultRun(["sh", "-c", "echo oops >&2; exit 3"]);
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain("oops");
  });

  test("with no stdin given, the program gets none", async () => {
    const result = await defaultRun(["cat"]);
    expect(result.stdout).toBe("");
  });
});
