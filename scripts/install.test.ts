// Tests for install.sh. It is run FOR REAL, as a child process, against a fake release server
// on localhost. Small stand-ins for `uname`, `sysctl` and `curl` are put first on PATH so a
// test can pretend to be an Intel Mac, a Rosetta shell, or Linux. Nothing touches the network
// or the real home folder.
//
// macOS only: the script itself refuses anything else, and it relies on macOS's `shasum`.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const scriptPath = join(root, "install.sh");
const onMac = process.platform === "darwin";

const sha256 = (text: string): string => new Bun.CryptoHasher("sha256").update(text).digest("hex");

// A stand-in for the real binary: a script that reports a version, like the real one does.
const fakeBinary = (label: string): string => `#!/bin/sh\necho "tangent 9.9.9"\n# ${label}\n`;
const ARM = "tangent-darwin-arm64";
const X64 = "tangent-darwin-x64";

type Server = { url: string; requests: string[]; stop: () => void };

// A fake "GitHub release": serves files by name, whatever the folder in the URL, and records
// every path asked for.
function startServer(files: Record<string, string>): Server {
  const requests: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      requests.push(path);
      const body = files[path.split("/").pop() ?? ""];
      return body === undefined ? new Response("not found", { status: 404 }) : new Response(body);
    },
  });
  return { url: `http://localhost:${server.port}/release`, requests, stop: () => void server.stop(true) };
}

// A good release: both binaries, and a SHA256SUMS that matches them.
const goodFiles = (): Record<string, string> => {
  const arm = fakeBinary("arm64");
  const x64 = fakeBinary("x64");
  return { [ARM]: arm, [X64]: x64, SHA256SUMS: `${sha256(arm)}  ${ARM}\n${sha256(x64)}  ${X64}\n` };
};

let work = ""; // a fresh scratch folder for each test
let server: Server | undefined;

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), "tv-install-"));
});
afterEach(async () => {
  server?.stop();
  server = undefined;
  await rm(work, { recursive: true, force: true });
});

type Options = {
  os?: string; // what `uname -s` says (default Darwin)
  arch?: string; // what `uname -m` says (default arm64)
  translated?: boolean; // a Rosetta shell: sysctl proc_translated is 1
  fakeCurl?: boolean; // don't download, just log the arguments curl was given
  shims?: Record<string, string>; // extra stand-in commands: name -> shell script body
  env?: Record<string, string>;
  shell?: string;
  scriptText?: string; // feed this to the shell on stdin instead of running the file
  withServer?: boolean; // point BASE_URL at the server (default true when there is one)
};

async function runInstall(options: Options = {}) {
  const { os = "Darwin", arch = "arm64", translated = false, fakeCurl = false, env = {}, shell = "sh" } = options;
  const home = join(work, "home");
  const shims = join(work, "shims");
  const tmpDir = join(work, "tmp");
  const curlLog = join(work, "curl.log");
  await Promise.all([mkdir(home, { recursive: true }), mkdir(shims, { recursive: true }), mkdir(tmpDir, { recursive: true })]);

  const shim = async (name: string, body: string) => {
    await writeFile(join(shims, name), `#!/bin/sh\n${body}\n`);
    await chmod(join(shims, name), 0o755);
  };
  await shim("uname", `case "$1" in -s) echo ${os} ;; -m) echo ${arch} ;; esac`);
  await shim("sysctl", translated ? "echo 1" : "echo 0");
  if (fakeCurl) await shim("curl", `echo "$@" >> "${curlLog}"\nexit 22`);
  for (const [name, body] of Object.entries(options.shims ?? {})) await shim(name, body);

  const environment: Record<string, string> = {
    HOME: home,
    TMPDIR: tmpDir,
    PATH: `${shims}:/usr/bin:/bin:/usr/sbin:/sbin`,
    ...(server && options.withServer !== false ? { TANGENT_BASE_URL: server.url } : {}),
    ...env,
  };
  const proc = Bun.spawn(options.scriptText === undefined ? [shell, scriptPath] : [shell], {
    env: environment,
    stdin: options.scriptText === undefined ? "ignore" : new Blob([options.scriptText]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const installDir = environment.TANGENT_INSTALL_DIR ?? join(home, ".local", "bin");
  const curlCalls = (await Bun.file(curlLog).exists()) ? await Bun.file(curlLog).text() : "";
  return { stdout, stderr, code, home, tmpDir, installed: join(installDir, "tangent"), installDir, curlCalls };
}

const exists = (path: string) => Bun.file(path).exists();
const run = async (path: string) => {
  const proc = Bun.spawn([path, "--version"], { stdout: "pipe", stderr: "pipe" });
  return { out: (await new Response(proc.stdout).text()).trim(), code: await proc.exited };
};

describe.skipIf(!onMac)("install.sh", () => {
  describe("a good release", () => {
    test("installs a working command into ~/.local/bin and says so", async () => {
      server = startServer(goodFiles());
      const r = await runInstall();
      expect(r.code).toBe(0);
      expect(r.stderr).toContain("Installed tangent 9.9.9");
      expect(await run(r.installed)).toEqual({ out: "tangent 9.9.9", code: 0 });
    });

    test("downloads the binary for this Mac and the checksum list", async () => {
      server = startServer(goodFiles());
      await runInstall();
      expect(server.requests.sort()).toEqual([`/release/${ARM}`, "/release/SHA256SUMS"].sort());
    });

    // The same script runs under macOS's /bin/sh (bash) and a strict POSIX shell (dash).
    test.each(["sh", "bash", ...(Bun.which("dash") ? ["dash"] : [])])("works under %s", async (shell) => {
      server = startServer(goodFiles());
      const r = await runInstall({ shell });
      expect(r.code).toBe(0);
      expect(await exists(r.installed)).toBe(true);
    });

    test("puts the command in TANGENT_INSTALL_DIR when asked", async () => {
      server = startServer(goodFiles());
      const dir = join(work, "elsewhere", "bin");
      const r = await runInstall({ env: { TANGENT_INSTALL_DIR: dir } });
      expect(r.code).toBe(0);
      expect(r.installed).toBe(join(dir, "tangent"));
      expect(await exists(r.installed)).toBe(true);
    });

    test("the OLD setting name TERMINAL_VELOCITY_INSTALL_DIR still works", async () => {
      server = startServer(goodFiles());
      const dir = join(work, "legacy", "bin");
      const r = await runInstall({ env: { TERMINAL_VELOCITY_INSTALL_DIR: dir } });
      expect(r.code).toBe(0);
      expect(await exists(join(dir, "tangent"))).toBe(true);
    });

    test("replaces an older install", async () => {
      server = startServer(goodFiles());
      const dir = join(work, "home", ".local", "bin");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "tangent"), "#!/bin/sh\necho old\n");
      await chmod(join(dir, "tangent"), 0o755);
      const r = await runInstall();
      expect(r.code).toBe(0);
      expect((await run(r.installed)).out).toBe("tangent 9.9.9");
    });

    test("leaves no staging file behind in the install folder", async () => {
      server = startServer(goodFiles());
      const r = await runInstall();
      expect(await readdir(r.installDir)).toEqual(["tangent"]);
    });

    test("cleans up its temporary folder", async () => {
      server = startServer(goodFiles());
      const r = await runInstall();
      expect(await readdir(r.tmpDir)).toEqual([]);
    });
  });

  describe("which build it picks", () => {
    test.each([
      ["an Apple Silicon Mac", "arm64", false, ARM],
      ["an Intel Mac", "x86_64", false, X64],
      // A terminal running under Rosetta says x86_64 even on an Apple Silicon Mac.
      ["a Rosetta shell on Apple Silicon", "x86_64", true, ARM],
    ])("%s", async (_label, arch, translated, expected) => {
      server = startServer(goodFiles());
      const r = await runInstall({ arch, translated });
      expect(r.code).toBe(0);
      expect(server.requests).toContain(`/release/${expected}`);
      expect(server.requests.filter((p) => p.includes("tangent-"))).toHaveLength(1);
    });

    test("an unsupported processor is refused before any download", async () => {
      server = startServer(goodFiles());
      const r = await runInstall({ arch: "i686" });
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("unsupported processor: i686");
      expect(server.requests).toEqual([]);
    });

    test("Linux is refused with a pointer to why, before any download", async () => {
      server = startServer(goodFiles());
      const r = await runInstall({ os: "Linux" });
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("only runs on macOS for now");
      expect(r.stderr).toContain("#7");
      expect(server.requests).toEqual([]);
      expect(await exists(r.installed)).toBe(false);
    });
  });

  describe("a bad download installs nothing", () => {
    test("a checksum that doesn't match", async () => {
      const files = goodFiles();
      files.SHA256SUMS = `${sha256("something else")}  ${ARM}\n`;
      server = startServer(files);
      const r = await runInstall();
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("checksum does not match");
      expect(await exists(r.installed)).toBe(false);
    });

    test("a binary that was changed after the checksums were made", async () => {
      const files = goodFiles();
      files[ARM] = fakeBinary("tampered");
      server = startServer(files);
      const r = await runInstall();
      expect(r.code).not.toBe(0);
      expect(await exists(r.installed)).toBe(false);
    });

    test("a checksum list with no entry for this binary", async () => {
      const files = goodFiles();
      files.SHA256SUMS = `${sha256(files[X64] ?? "")}  ${X64}\n`; // only the other Mac's entry
      server = startServer(files);
      const r = await runInstall();
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain(`no entry for ${ARM}`);
      expect(await exists(r.installed)).toBe(false);
    });

    // The entry must be for exactly this file name, not one that merely contains it.
    test("an entry for a differently named file doesn't count", async () => {
      const files = goodFiles();
      files.SHA256SUMS = `${sha256(files[ARM] ?? "")}  ${ARM}.old\n`;
      server = startServer(files);
      const r = await runInstall();
      expect(r.code).not.toBe(0);
      expect(await exists(r.installed)).toBe(false);
    });

    test("a missing file on the server (404)", async () => {
      const files = goodFiles();
      delete files[ARM];
      server = startServer(files);
      const r = await runInstall();
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("could not download");
      expect(await exists(r.installed)).toBe(false);
    });

    test("a failed install leaves the old version working", async () => {
      const files = goodFiles();
      files.SHA256SUMS = `${sha256("nope")}  ${ARM}\n`;
      server = startServer(files);
      const dir = join(work, "home", ".local", "bin");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "tangent"), '#!/bin/sh\necho "tangent 0.0.1"\n');
      await chmod(join(dir, "tangent"), 0o755);
      const r = await runInstall();
      expect(r.code).not.toBe(0);
      expect((await run(r.installed)).out).toBe("tangent 0.0.1");
    });

    // The checksum only shows the file arrived intact. Running it is the one check that macOS
    // will really start it (a bad signature or the wrong build gets it killed).
    test.each([
      ["exits with an error", "#!/bin/sh\nexit 1\n"],
      ["prints nothing", "#!/bin/sh\nexit 0\n"],
    ])("a binary that %s is refused, even with a matching checksum", async (_label, body) => {
      server = startServer({
        [ARM]: body,
        [X64]: body,
        SHA256SUMS: `${sha256(body)}  ${ARM}\n${sha256(body)}  ${X64}\n`,
      });
      const r = await runInstall();
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("does not run");
      expect(r.stderr).not.toContain("Installed");
      expect(await exists(r.installed)).toBe(false);
      expect(await readdir(r.installDir)).toEqual([]); // and no staging file is left behind
    });

    test("a binary that doesn't run never replaces a working install", async () => {
      const body = "#!/bin/sh\nexit 1\n";
      server = startServer({ [ARM]: body, [X64]: body, SHA256SUMS: `${sha256(body)}  ${ARM}\n${sha256(body)}  ${X64}\n` });
      const dir = join(work, "home", ".local", "bin");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "tangent"), '#!/bin/sh\necho "tangent 0.0.1"\n');
      await chmod(join(dir, "tangent"), 0o755);
      const r = await runInstall();
      expect(r.code).not.toBe(0);
      expect((await run(r.installed)).out).toBe("tangent 0.0.1");
      expect(await readdir(r.installDir)).toEqual(["tangent"]);
    });

    // If copying, chmod or the final rename fails, the half-installed hidden file must not stay
    // in the person's install folder.
    test.each([["chmod"], ["mv"]])("a failing %s leaves no staging file behind", async (command) => {
      server = startServer(goodFiles());
      const r = await runInstall({ shims: { [command]: "exit 1" } });
      expect(r.code).not.toBe(0);
      expect((await readdir(r.installDir)).filter((name) => name.startsWith(".tangent."))).toEqual([]);
      expect(await exists(r.installed)).toBe(false);
    });

    test("cleans up its temporary folder even when it fails", async () => {
      const files = goodFiles();
      files.SHA256SUMS = `${sha256("nope")}  ${ARM}\n`;
      server = startServer(files);
      const r = await runInstall();
      expect(r.code).not.toBe(0);
      expect(await readdir(r.tmpDir)).toEqual([]);
    });
  });

  describe("choosing a release", () => {
    // The real GitHub URL can't be used in a test, so a stand-in curl records what it was asked for.
    test("the latest release by default, over https only", async () => {
      const r = await runInstall({ fakeCurl: true });
      expect(r.code).not.toBe(0);
      expect(r.curlCalls).toContain(
        `https://github.com/trounceabout/tangent-tui/releases/latest/download/${ARM}`,
      );
      expect(r.curlCalls).toContain("--proto =https");
      // --proto only limits the first request. Redirects (GitHub's downloads redirect) are
      // limited by --proto-redir, which by default also lets plain http through.
      expect(r.curlCalls).toContain("--proto-redir =https");
    });

    test("a named release", async () => {
      const r = await runInstall({ fakeCurl: true, env: { TANGENT_VERSION: "v0.1.0" } });
      expect(r.curlCalls).toContain(
        `https://github.com/trounceabout/tangent-tui/releases/download/v0.1.0/${ARM}`,
      );
    });

    test("a bad version set through the OLD name is refused, and the error names both settings", async () => {
      const r = await runInstall({ fakeCurl: true, env: { TERMINAL_VELOCITY_VERSION: "main" } });
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("TERMINAL_VELOCITY_VERSION");
      expect(r.curlCalls).toBe("");
    });

    test("the OLD setting names still work (version and base URL)", async () => {
      const version = await runInstall({ fakeCurl: true, env: { TERMINAL_VELOCITY_VERSION: "v0.1.0" } });
      expect(version.curlCalls).toContain("/releases/download/v0.1.0/");
      const base = await runInstall({ fakeCurl: true, env: { TERMINAL_VELOCITY_BASE_URL: "http://localhost:1/x" } });
      expect(base.curlCalls).toContain(`http://localhost:1/x/${ARM}`);
    });

    test("a pre-release tag is accepted", async () => {
      const r = await runInstall({ fakeCurl: true, env: { TANGENT_VERSION: "v0.2.0-rc.1" } });
      expect(r.curlCalls).toContain("/releases/download/v0.2.0-rc.1/");
    });

    // The version goes into a URL, so anything that isn't a plain tag is refused before curl runs.
    test.each([["1.0.0"], ["main"], ["v1.0.0/../../x"], ["v1.0.0?x=1"], ["v1.0.0;ls"], ["v1 0"], ["../v1.0.0"]])(
      "refuses the version %p without downloading anything",
      async (version) => {
        const r = await runInstall({ fakeCurl: true, env: { TANGENT_VERSION: version } });
        expect(r.code).not.toBe(0);
        expect(r.stderr).toContain("TANGENT_VERSION (or TERMINAL_VELOCITY_VERSION) must");
        expect(r.curlCalls).toBe("");
      },
    );

    test("pointing BASE_URL at a test server allows http, and says so to curl", async () => {
      const r = await runInstall({ fakeCurl: true, env: { TANGENT_BASE_URL: "http://localhost:1/x" } });
      expect(r.curlCalls).toContain("--proto =http,https");
      expect(r.curlCalls).toContain("--proto-redir =http,https");
      expect(r.curlCalls).toContain(`http://localhost:1/x/${ARM}`);
    });
  });

  describe("PATH hint", () => {
    test("is shown when the install folder isn't on PATH", async () => {
      server = startServer(goodFiles());
      const r = await runInstall();
      expect(r.stderr).toContain("is not on your PATH");
      expect(r.stderr).toContain(`export PATH="${r.installDir}:$PATH"`);
    });

    test("is not shown when it already is", async () => {
      server = startServer(goodFiles());
      const dir = join(work, "home", ".local", "bin");
      const r = await runInstall({ env: { PATH: `${join(work, "shims")}:${dir}:/usr/bin:/bin:/usr/sbin:/sbin` } });
      expect(r.code).toBe(0);
      expect(r.stderr).not.toContain("not on your PATH");
    });
  });

  describe("the script itself", () => {
    const source = () => Bun.file(scriptPath).text();

    // `curl ... | sh` can be cut off anywhere. Everything is inside main(), called on the last
    // line, so a half script is a syntax error (or only defines functions) and does nothing.
    // Cut it every 100 characters and check that none of the pieces downloads or installs.
    test("a download cut off ANYWHERE runs nothing", async () => {
      server = startServer(goodFiles());
      const text = await source();
      const mainStart = text.indexOf("main() {");
      expect(mainStart).toBeGreaterThan(0);
      let cuts = 0;
      for (let end = 100; end < text.length - 20; end += 100) {
        const r = await runInstall({ scriptText: text.slice(0, end) });
        expect(await exists(r.installed)).toBe(false);
        // Cut inside main's body: the shell can't even parse it, so it must report failure.
        if (end > mainStart + "main() {".length) expect(r.code).not.toBe(0);
        cuts++;
      }
      expect(cuts).toBeGreaterThan(20);
      expect(server.requests).toEqual([]);
    });

    test("works when piped into sh, the way people will really run it", async () => {
      server = startServer(goodFiles());
      const r = await runInstall({ scriptText: await source() });
      expect(r.code).toBe(0);
      expect(await exists(r.installed)).toBe(true);
    });

    test("stops at the first error, never asks for sudo, and ends by calling main", async () => {
      const text = await source();
      expect(text).toContain("set -eu");
      expect(text.replace(/^\s*#.*$/gm, "")).not.toContain("sudo"); // comments may mention it
      expect(text.trimEnd().split("\n").pop()).toBe('main "$@"');
    });

    test("is executable and starts with a shebang", async () => {
      expect((await Bun.file(scriptPath).stat()).mode & 0o111).not.toBe(0);
      expect((await source()).startsWith("#!/bin/sh\n")).toBe(true);
    });

    test.skipIf(!Bun.which("shellcheck"))("passes shellcheck", async () => {
      const proc = Bun.spawn(["shellcheck", "-s", "sh", scriptPath], { stdout: "pipe", stderr: "pipe" });
      expect(await new Response(proc.stdout).text()).toBe("");
      expect(await proc.exited).toBe(0);
    });
  });
});

// The README quotes the install command and the settings by name. These checks stop the
// README and the script drifting apart (they don't need a Mac).
describe("README install section", () => {
  const readme = () => Bun.file(join(root, "README.md")).text();
  const script = () => Bun.file(scriptPath).text();

  test("shows the same curl command that install.sh's own header shows", async () => {
    const command = /curl -fsSL (https:\/\/raw\.githubusercontent\.com\/\S+\/install\.sh)/;
    const fromScript = command.exec(await script())?.[1];
    const fromReadme = command.exec(await readme())?.[1];
    expect(fromScript).toBe("https://raw.githubusercontent.com/trounceabout/tangent-tui/main/install.sh");
    expect(fromReadme).toBe(fromScript);
  });

  test("every TANGENT_* install setting the README names is real", async () => {
    const section = ((await readme()).split("## Install")[1] ?? "").split("## Requirements")[0] ?? "";
    expect(section.length).toBeGreaterThan(500); // really found the Install section
    const named = new Set(section.match(/TANGENT_[A-Z_]+/g) ?? []);
    expect([...named].sort()).toEqual(["TANGENT_INSTALL_DIR", "TANGENT_VERSION"]);
    const code = await script();
    for (const name of named) expect(code).toContain(`${name}:-`);
  });

  test("the file names it tells people to download are the ones the build produces", async () => {
    const section = (await readme()).split("### Check what you downloaded")[0] ?? "";
    for (const name of [ARM, X64]) expect(section).toContain(name);
  });
});
