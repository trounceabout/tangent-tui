// Tests for src/cli.ts: what `tangent` does with its command-line arguments.

import { describe, expect, test } from "bun:test";
import { helpText, parseArgs, userArgs, versionText } from "./cli.ts";

describe("userArgs", () => {
  test("normally it is everything after the script", () => {
    expect(userArgs(["bun", "index.tsx", "--help"], "bun")).toEqual(["--help"]);
    expect(userArgs(["bun", "index.tsx"], "bun")).toEqual([]);
  });

  test("a compiled binary keeps real arguments", () => {
    expect(userArgs(["bun", "/$bunfs/root/tv", "--version"], "./tv")).toEqual(["--version"]);
  });

  // The Bun quirk: with no arguments, a compiled binary's argv gets its own path as an extra.
  test.each([["./tv"], ["/usr/local/bin/tangent"], ["tangent"]])(
    "a compiled binary's own path (%s) is not an argument",
    (path) => {
      expect(userArgs(["bun", "/$bunfs/root/tv", path], path)).toEqual([]);
    },
  );

  test("only the exact fake one is dropped: a different single argument stays", () => {
    expect(userArgs(["bun", "/$bunfs/root/tv", "--bogus"], "./tv")).toEqual(["--bogus"]);
  });

  test("outside a compiled binary nothing is dropped, even if it equals argv0", () => {
    expect(userArgs(["bun", "index.tsx", "bun"], "bun")).toEqual(["bun"]);
  });
});

describe("parseArgs", () => {
  test("no arguments starts the app", () => {
    expect(parseArgs([])).toEqual({ action: "run" });
  });

  test.each([["--help"], ["-h"]])("%s shows the help", (flag) => {
    expect(parseArgs([flag])).toEqual({ action: "help" });
  });

  test.each([["--version"], ["-v"]])("%s shows the version", (flag) => {
    expect(parseArgs([flag])).toEqual({ action: "version" });
  });

  test("an unknown option is an error that names it, never a silent start", () => {
    expect(parseArgs(["--versoin"])).toEqual({
      action: "error",
      message: "Unknown option: --versoin. Try --help.",
    });
  });

  test("a stray word is an error too", () => {
    expect(parseArgs(["hello"]).action).toBe("error");
  });

  test("help wins over an unknown option and over --version", () => {
    expect(parseArgs(["--bogus", "--help"])).toEqual({ action: "help" });
    expect(parseArgs(["--version", "--help"])).toEqual({ action: "help" });
  });

  test("version wins over an unknown option", () => {
    expect(parseArgs(["--bogus", "-v"])).toEqual({ action: "version" });
  });
});

describe("versionText", () => {
  test("is the command name and the version", () => {
    expect(versionText("1.2.3")).toBe("tangent 1.2.3");
  });
});

describe("helpText", () => {
  test("lists both flags and both environment switches", () => {
    const text = helpText();
    for (const word of ["--help", "--version", "TERMINAL_VELOCITY_DRY_RUN", "TERMINAL_VELOCITY_MOUSE"]) {
      expect(text).toContain(word);
    }
  });

  test("no line is wider than 80 columns", () => {
    for (const line of helpText().split("\n")) {
      expect(Bun.stringWidth(line)).toBeLessThanOrEqual(80);
    }
  });
});

// The real entry point, run as a child process. No Linear, Keychain or terminal is touched,
// because help, version and errors all exit before the UI is loaded.
describe("index.tsx as a command", () => {
  const run = async (...args: string[]) => {
    const proc = Bun.spawn(["bun", "index.tsx", ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, code };
  };

  test("--version prints the version from package.json and exits 0", async () => {
    const pkg = await Bun.file("package.json").json();
    const { stdout, code } = await run("--version");
    expect(stdout.trim()).toBe(`tangent ${pkg.version}`);
    expect(code).toBe(0);
  });

  test("--help prints the usage and exits 0", async () => {
    const { stdout, code } = await run("--help");
    expect(stdout).toContain("Usage:");
    expect(code).toBe(0);
  });

  test("an unknown option goes to stderr and exits 2", async () => {
    const { stdout, stderr, code } = await run("--bogus");
    expect(stderr).toContain("Unknown option: --bogus");
    expect(stdout).toBe("");
    expect(code).toBe(2);
  });
});
