// Tests for scripts/release.ts and a policy check on .github/workflows/release.yml.
//
// We can't run the workflow without pushing a real tag, so the logic lives in release.ts
// (tested for real below) and the workflow file is checked for the safety properties that
// matter: what triggers it, what it may do, and that nothing untrusted reaches a shell.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TARGET_NAMES, binaryName } from "./build.ts";
import { checkTag, isPrerelease, sha256Sums } from "./release.ts";

const root = join(import.meta.dir, "..");

describe("checkTag", () => {
  test("accepts a tag that matches the package version", () => {
    expect(checkTag("v0.1.0", "0.1.0")).toBeNull();
    expect(checkTag("v1.2.3-rc.1", "1.2.3-rc.1")).toBeNull();
  });

  test("rejects a tag that does not match the version, and says how to fix it", () => {
    const problem = checkTag("v0.2.0", "0.1.0");
    expect(problem).toContain("does not match package.json version 0.1.0");
    expect(problem).toContain("npm version");
  });

  test("a pre-release tag does not match a plain version", () => {
    expect(checkTag("v0.1.0-rc.1", "0.1.0")).not.toBeNull();
  });

  test.each([["0.1.0"], ["v1"], ["v1.2"], ["release-1.0.0"], ["v1.2.3-"], ["v1.2.3 "], ["v1.2.3;ls"], [""]])(
    "rejects %p as not a release tag",
    (tag) => {
      expect(checkTag(tag, "1.2.3")).toContain("is not a release tag");
    },
  );
});

describe("isPrerelease", () => {
  test("a tag with a pre-release part is a pre-release", () => {
    expect(isPrerelease("v0.2.0-rc.1")).toBe(true);
    expect(isPrerelease("v1.0.0-beta")).toBe(true);
  });

  test("a plain version is not", () => {
    expect(isPrerelease("v0.2.0")).toBe(false);
  });

  test("something that isn't a tag at all is not a pre-release either", () => {
    expect(isPrerelease("nope-1")).toBe(false);
  });
});

describe("sha256Sums", () => {
  let dir = "";
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  const names = TARGET_NAMES.map(binaryName);

  test("writes one line per binary that `shasum -c` accepts", async () => {
    dir = await mkdtemp(join(tmpdir(), "tv-sums-"));
    for (const [i, name] of names.entries()) await writeFile(join(dir, name), `binary number ${i}`);
    await writeFile(join(dir, "SHA256SUMS"), await sha256Sums(dir));

    const sums = await Bun.file(join(dir, "SHA256SUMS")).text();
    expect(sums.trim().split("\n")).toHaveLength(names.length);
    for (const name of names) expect(sums).toContain(`  ${name}\n`); // two spaces, plain file names

    // The real consumer: the same tool the install script will use.
    const check = Bun.spawn(["shasum", "-a", "256", "-c", "SHA256SUMS"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    expect(await check.exited).toBe(0);
  });

  test("a changed file no longer verifies (the check is real)", async () => {
    await writeFile(join(dir, names[0] ?? ""), "tampered");
    const check = Bun.spawn(["shasum", "-a", "256", "-c", "SHA256SUMS"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    expect(await check.exited).not.toBe(0);
  });

  test("refuses to write sums when a binary is missing, so a half-built release can't ship", async () => {
    const half = await mkdtemp(join(tmpdir(), "tv-sums-half-"));
    try {
      await writeFile(join(half, names[0] ?? ""), "only one");
      await expect(sha256Sums(half)).rejects.toThrow("Missing binary");
    } finally {
      await rm(half, { recursive: true, force: true });
    }
  });
});

describe("release.ts as a command", () => {
  const run = async (...args: string[]) => {
    const proc = Bun.spawn(["bun", "scripts/release.ts", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, code };
  };

  test("check-tag passes for the current package version and fails for another", async () => {
    const pkg = await Bun.file(join(root, "package.json")).json();
    expect((await run("check-tag", `v${pkg.version}`)).code).toBe(0);
    const wrong = await run("check-tag", "v99.0.0");
    expect(wrong.code).toBe(1);
    expect(wrong.stderr).toContain("does not match");
  });

  test("prerelease prints true or false", async () => {
    expect((await run("prerelease", "v1.0.0-rc.1")).stdout.trim()).toBe("true");
    expect((await run("prerelease", "v1.0.0")).stdout.trim()).toBe("false");
  });

  test("an unknown command is a usage error", async () => {
    const result = await run("publish-everything");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Usage:");
  });
});

// Policy: the workflow file itself. These are the properties that make a release workflow
// safe to leave in a public repo.
describe("release workflow", () => {
  type Step = { uses?: string; run?: string; name?: string; with?: Record<string, unknown> };
  type Workflow = {
    // YAML reads a bare `on` as the boolean true, so Bun.YAML names this key "true".
    true: { push: { tags: string[] } } & Record<string, unknown>;
    permissions: Record<string, string>;
    jobs: { release: { permissions: Record<string, string>; steps: Step[]; "runs-on": string } };
  };
  let wf: Workflow;
  let text = "";
  const load = async () => {
    text = await Bun.file(join(root, ".github/workflows/release.yml")).text();
    wf = Bun.YAML.parse(text) as Workflow;
  };
  const steps = () => wf.jobs.release.steps;

  test("runs only when a version tag is pushed", async () => {
    await load();
    expect(Object.keys(wf.true)).toEqual(["push"]);
    expect(wf.true.push.tags).toEqual(["v*"]);
  });

  test("has no permissions by default; the job gets exactly the three it needs", () => {
    expect(wf.permissions).toEqual({});
    expect(wf.jobs.release.permissions).toEqual({
      contents: "write",
      "id-token": "write",
      attestations: "write",
    });
  });

  test("every action is pinned to a full 40-character commit SHA, not a movable tag", () => {
    const uses = steps().flatMap((s) => (s.uses ? [s.uses] : []));
    expect(uses.length).toBeGreaterThanOrEqual(3);
    for (const u of uses) expect(u).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
  });

  // ${{ ... }} inside a shell script is pasted in BEFORE the shell runs, so a crafted tag name
  // could run commands. Values must go through env: instead.
  test("no ${{ }} expression is pasted into a shell script", () => {
    const scripts = steps().flatMap((s) => (s.run ? [s.run] : []));
    expect(scripts.length).toBeGreaterThan(5);
    for (const script of scripts) expect(script).not.toContain("${{");
  });

  test("Bun is pinned to an exact version, not 'latest'", () => {
    const setup = steps().find((s) => s.uses?.startsWith("oven-sh/setup-bun@"));
    expect(String(setup?.with?.["bun-version"])).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("lint, typecheck and tests all run before anything is built", () => {
    const at = (needle: string) => steps().findIndex((s) => s.run === needle);
    const build = at("bun run build");
    expect(build).toBeGreaterThan(-1);
    for (const check of ["bun run lint", "bun run typecheck", "bun test"]) {
      expect(at(check)).toBeGreaterThan(-1);
      expect(at(check)).toBeLessThan(build);
    }
  });

  test("the tag checks run before the build too", () => {
    const first = (needle: string) => steps().findIndex((s) => s.run?.includes(needle));
    const build = first("bun run build");
    expect(first("merge-base --is-ancestor")).toBeLessThan(build);
    expect(first("check-tag")).toBeLessThan(build);
    expect(first("merge-base --is-ancestor")).toBeGreaterThan(-1);
    expect(first("check-tag")).toBeGreaterThan(-1);
  });

  test("the release is created from an existing tag, with checksums and attestations", () => {
    const publish = steps().find((s) => s.run?.includes("gh release create"));
    expect(publish?.run).toContain("--verify-tag");
    expect(publish?.run).toContain("dist/SHA256SUMS");
    for (const name of TARGET_NAMES.map(binaryName)) expect(publish?.run).toContain(`dist/${name}`);
    expect(steps().some((s) => s.uses?.startsWith("actions/attest-build-provenance@"))).toBe(true);
  });

  test("runs on macOS, because the binaries are re-signed with codesign", () => {
    expect(wf.jobs.release["runs-on"]).toStartWith("macos");
  });
});
