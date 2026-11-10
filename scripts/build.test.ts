// Tests for scripts/build.ts: the single-file binaries.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TARGETS, TARGET_NAMES, binaryName, build, resolveTargets } from "./build.ts";

describe("resolveTargets", () => {
  test("no arguments means every target", () => {
    expect(resolveTargets([])).toEqual(["darwin-arm64", "darwin-x64"]);
  });

  test("named targets are returned in the order given", () => {
    expect(resolveTargets(["darwin-x64"])).toEqual(["darwin-x64"]);
    expect(resolveTargets(["darwin-x64", "darwin-arm64"])).toEqual(["darwin-x64", "darwin-arm64"]);
  });

  test("an unknown target throws and lists the real ones, so a typo can't build nothing", () => {
    expect(() => resolveTargets(["darwin-arm46"])).toThrow('Unknown target "darwin-arm46"');
    expect(() => resolveTargets(["linux-x64"])).toThrow("darwin-arm64, darwin-x64");
  });

  // "toString" and friends exist on every object, so a plain `in` check would let them through.
  test("object built-ins are not targets", () => {
    expect(() => resolveTargets(["toString"])).toThrow("Unknown target");
  });
});

describe("targets", () => {
  test("release file names are terminal-velocity-<os>-<arch>", () => {
    expect(TARGET_NAMES.map(binaryName)).toEqual(["terminal-velocity-darwin-arm64", "terminal-velocity-darwin-x64"]);
  });

  // The install script picks the file by name. A baseline x64 binary runs on older Intel Macs
  // and under Rosetta, where the standard one can crash.
  test("the x64 build is Bun's baseline variant", () => {
    expect(TARGETS["darwin-x64"].bunTarget).toBe("bun-darwin-x64-baseline");
  });
});

// The real thing: compile, then run the result. It only runs on an Apple Silicon Mac, because
// that's the one binary the machine can execute (and codesign only exists on macOS).
describe.skipIf(process.platform !== "darwin" || process.arch !== "arm64")("a compiled binary", () => {
  let dir = "";
  let file = "";
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  test("is built, correctly signed, and runs", async () => {
    dir = await mkdtemp(join(tmpdir(), "tv-build-"));
    const written = await build(["darwin-arm64"], dir);
    file = written[0] ?? "";
    expect(file).toBe(join(dir, "terminal-velocity-darwin-arm64"));

    // macOS kills a binary whose signature is invalid, so check it explicitly.
    const sign = Bun.spawn(["codesign", "-v", file], { stdout: "ignore", stderr: "pipe" });
    expect(await sign.exited).toBe(0);

    // --version, --help and errors exit before the UI loads, so this needs no terminal.
    const pkg = await Bun.file(join(import.meta.dir, "..", "package.json")).json();
    const version = Bun.spawn([file, "--version"], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    expect((await new Response(version.stdout).text()).trim()).toBe(`terminal-velocity ${pkg.version}`);
    expect(await version.exited).toBe(0);
  }, 60_000);

  // Bun 1.2.21 quirk: with NO arguments, a compiled binary's argv contains its own path, which
  // used to be read as an unknown option. Flags alone never showed it. With no terminal the
  // app stops at Ink's raw-mode check, which is fine: we only care that it got past the
  // argument check. (The timer is a guard so a hang can't stall the suite.)
  test("started with no arguments, it does not mistake its own path for an option", async () => {
    const proc = Bun.spawn([file], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const timer = setTimeout(() => proc.kill(), 5_000);
    const stderr = await new Response(proc.stderr).text();
    await proc.exited;
    clearTimeout(timer);
    expect(stderr).not.toContain("Unknown option");
  }, 15_000);

  // Ink loads its DevTools package on demand. Without our stand-in for it the binary
  // either fails to build or dies at startup.
  test("starts without the optional React DevTools package", async () => {
    const help = Bun.spawn([file, "--help"], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const [out, err] = await Promise.all([new Response(help.stdout).text(), new Response(help.stderr).text()]);
    expect(err).not.toContain("react-devtools-core");
    expect(out).toContain("Usage:");
    expect(await help.exited).toBe(0);
  });
});

test("building on a non-macOS machine is refused with a clear message", async () => {
  if (process.platform === "darwin") return; // only meaningful elsewhere
  await expect(build(["darwin-arm64"], tmpdir())).rejects.toThrow("must be built on macOS");
});
