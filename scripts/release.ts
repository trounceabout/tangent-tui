// scripts/release.ts
// The small checks the release workflow runs, kept here (not as shell inside the YAML) so
// they can be tested. Nothing in src/ imports this.
//
//   bun scripts/release.ts check-tag v0.1.0   does the tag match package.json's version?
//   bun scripts/release.ts prerelease v0.1.0-rc.1   prints "true" or "false"
//   bun scripts/release.ts sums dist          prints SHA256SUMS for every binary in dist/

import { join } from "node:path";
import { TARGET_NAMES, binaryName } from "./build.ts";

// A release tag is v<major>.<minor>.<patch>, optionally with a pre-release part like -rc.1.
const TAG = /^v(\d+\.\d+\.\d+)(-[0-9A-Za-z.-]+)?$/;

// Returns an error message, or null when the tag is fine. The tag must look like a version AND
// equal the version in package.json: otherwise `tangent --version` would disagree
// with the release it came from.
export function checkTag(tag: string, packageVersion: string): string | null {
  if (!TAG.test(tag)) return `"${tag}" is not a release tag like v1.2.3 or v1.2.3-rc.1`;
  if (tag !== `v${packageVersion}`) {
    return `Tag ${tag} does not match package.json version ${packageVersion}. Bump the version (npm version) and tag again.`;
  }
  return null;
}

// Tags with a pre-release part (v1.2.3-rc.1) are published as pre-releases.
export const isPrerelease = (tag: string): boolean => TAG.exec(tag)?.[2] !== undefined;

// SHA-256 of a file, as lowercase hex.
async function sha256(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(await Bun.file(path).arrayBuffer());
  return hasher.digest("hex");
}

// The text of a SHA256SUMS file: one `<hash>  <name>` line per binary (two spaces, which is
// the format `shasum -a 256 -c` and `sha256sum -c` read). Names are plain file names, not
// paths, because that's how people will have them after downloading.
// Throws if any expected binary is missing, so a half-built release can't be published.
export async function sha256Sums(dir: string): Promise<string> {
  const lines: string[] = [];
  for (const name of TARGET_NAMES.map(binaryName)) {
    const path = join(dir, name);
    if (!(await Bun.file(path).exists())) throw new Error(`Missing binary: ${path}`);
    lines.push(`${await sha256(path)}  ${name}`);
  }
  return lines.join("\n") + "\n";
}

// Only when run directly, not when a test imports the functions above.
if (import.meta.main) {
  const [command, arg] = Bun.argv.slice(2);
  try {
    if (command === "check-tag" && arg) {
      const pkg = await Bun.file(join(import.meta.dir, "..", "package.json")).json();
      const problem = checkTag(arg, pkg.version);
      if (problem) throw new Error(problem);
      console.log(`Tag ${arg} matches package.json.`);
    } else if (command === "prerelease" && arg) {
      console.log(String(isPrerelease(arg)));
    } else if (command === "sums" && arg) {
      process.stdout.write(await sha256Sums(arg));
    } else {
      throw new Error("Usage: release.ts check-tag <tag> | prerelease <tag> | sums <dir>");
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
