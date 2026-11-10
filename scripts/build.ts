// scripts/build.ts
// Builds the single-file binaries that the install script and the GitHub Release hand out.
//
//   bun run build                  both macOS binaries, into dist/
//   bun run build darwin-arm64     just one
//
// Each binary has Bun and the whole app inside it, so people don't need Bun installed.
// This is a build tool, not part of the app: nothing in src/ imports it.

import { mkdir } from "node:fs/promises";
import { join } from "node:path";

// One entry per platform we ship. `bunTarget` is Bun's own name for the platform.
// To add Linux later (see issue #7), add its entries here; nothing else needs to change.
export const TARGETS = {
  "darwin-arm64": { bunTarget: "bun-darwin-arm64" },
  // "baseline" is the x64 build that doesn't need AVX instructions. Without it the binary
  // can crash on older Intel Macs and under Rosetta. For a text UI the speed difference
  // doesn't matter.
  "darwin-x64": { bunTarget: "bun-darwin-x64-baseline" },
} as const;

export type TargetName = keyof typeof TARGETS;
export const TARGET_NAMES = Object.keys(TARGETS) as TargetName[];

// The file name a release uses for a target, e.g. tangent-darwin-arm64.
// The install script builds the same name, so change both together.
export const binaryName = (target: TargetName): string => `tangent-${target}`;

// Turns command-line words into a list of targets. No words means all of them.
// An unknown word throws, so a typo can't quietly build nothing.
export function resolveTargets(args: string[]): TargetName[] {
  if (args.length === 0) return TARGET_NAMES;
  return args.map((arg) => {
    // hasOwn, not `in`: `in` also finds inherited names like "toString".
    if (!Object.hasOwn(TARGETS, arg)) {
      throw new Error(`Unknown target "${arg}". Known targets: ${TARGET_NAMES.join(", ")}`);
    }
    return arg as TargetName;
  });
}

// Ink (the terminal UI library) can connect to React DevTools, but only when DEV=true, and
// it loads that package on demand. We don't install it. The compiler still needs SOMETHING
// to bundle for that import, and `--external` isn't enough: the binary then crashes at
// startup looking for the package. So we hand it an empty stand-in. Nothing ever calls it.
const stubDevtools: Bun.BunPlugin = {
  name: "stub-react-devtools-core",
  setup(build) {
    build.onResolve({ filter: /^react-devtools-core$/ }, () => ({
      path: "react-devtools-core",
      namespace: "stub",
    }));
    build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
      contents: "export default {};",
      loader: "js",
    }));
  },
};

// Compiling edits the file after the linker signed it, which leaves the macOS signature
// invalid, and macOS then kills the binary. Signing again with `-` ("ad-hoc", no
// certificate) makes it valid. It does NOT make Gatekeeper trust a browser download; see the
// README's Install section.
async function adHocSign(file: string): Promise<void> {
  const proc = Bun.spawn(["codesign", "--force", "--sign", "-", file], { stdout: "ignore", stderr: "pipe" });
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`codesign failed for ${file}: ${stderr.trim()}`);
}

// Builds the given targets into `outDir`. Returns the files it wrote.
export async function build(targets: TargetName[], outDir: string): Promise<string[]> {
  // codesign only exists on macOS. Fail early with a clear message rather than ship
  // binaries that macOS will refuse to run.
  if (process.platform !== "darwin") {
    throw new Error("The macOS binaries must be built on macOS (they are re-signed with codesign).");
  }
  await mkdir(outDir, { recursive: true });

  const written: string[] = [];
  for (const target of targets) {
    const outfile = join(outDir, binaryName(target));
    const result = await Bun.build({
      entrypoints: [join(import.meta.dir, "..", "index.tsx")],
      plugins: [stubDevtools],
      compile: { target: TARGETS[target].bunTarget, outfile },
    });
    if (!result.success) {
      throw new Error(`Build failed for ${target}:\n${result.logs.map(String).join("\n")}`);
    }
    await adHocSign(outfile);
    written.push(outfile);
  }
  return written;
}

// Only when run directly (`bun scripts/build.ts`), not when a test imports the helpers above.
if (import.meta.main) {
  try {
    const files = await build(resolveTargets(Bun.argv.slice(2)), join(import.meta.dir, "..", "dist"));
    for (const file of files) console.log(`built ${file}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
