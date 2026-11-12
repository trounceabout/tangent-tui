// src/cli.ts
// Command-line arguments: `tangent --help`, `--version` and `login`.
// Pure functions only (no printing, no exiting), so they are easy to test.
// index.tsx calls these first and decides what to print and when to quit.

// The arguments the person typed, from process.argv, process.argv0 on its own.
//
// Normally that's argv.slice(2). But in a compiled binary (Bun 1.2.21), running it with NO
// arguments puts the binary's own path in as a fake first argument: argv is
// ["bun", "/$bunfs/root/tangent", "./tangent"]. Left alone, plain
// `tangent` would fail with "Unknown option: ./tangent". The fake one is
// always exactly argv0, and only shows up when there is nothing else, so we drop it then.
// Compiled binaries are recognised by their script living under /$bunfs/.
export function userArgs(argv: string[], argv0: string): string[] {
  const args = argv.slice(2);
  const compiled = argv[1]?.startsWith("/$bunfs/") ?? false;
  return compiled && args.length === 1 && args[0] === argv0 ? [] : args;
}

// What the command line is asking for.
export type CliAction =
  | { action: "run" } // no arguments: start the app
  | { action: "login" } // `tangent login`: log in with the browser
  | { action: "help" }
  | { action: "version" }
  | { action: "error"; message: string };

// Looks at the arguments (process.argv.slice(2)) and says what to do.
// Help and version win over everything else, so `tangent --bogus --help`
// shows the help instead of complaining. Any other argument is an error: a typo like
// `--versoin` must not silently open the full-screen app.
export function parseArgs(args: string[]): CliAction {
  if (args.includes("--help") || args.includes("-h")) return { action: "help" };
  if (args.includes("--version") || args.includes("-v")) return { action: "version" };

  // `login` is the one command. Anything after it is a mistake, never a silent login.
  if (args[0] === "login") {
    const extra = args[1];
    if (extra !== undefined) return { action: "error", message: `Unknown option: ${extra}. Try --help.` };
    return { action: "login" };
  }

  const unknown = args[0];
  if (unknown !== undefined) {
    return { action: "error", message: `Unknown option: ${unknown}. Try --help.` };
  }
  return { action: "run" };
}

// `tangent 0.1.0`
export const versionText = (version: string): string => `tangent ${version}`;

// Kept under 80 columns per line, so it reads well in a narrow pane.
export const helpText = (): string =>
  [
    "tangent: your Linear issues from every active cycle, in the terminal.",
    "",
    "Usage:",
    "  tangent [options]",
    "  tangent login",
    "",
    "Commands:",
    "  login           Log in with your browser (no API key needed)",
    "",
    "Options:",
    "  -h, --help      Show this help and exit",
    "  -v, --version   Show the version and exit",
    "",
    "Environment:",
    "  LINEAR_API_KEY=key  A personal API key, used when you haven't logged in",
    "  TANGENT_DRY_RUN=1   Try every screen; nothing is sent to Linear",
    "  TANGENT_MOUSE=0     Start with the mouse off (press m to toggle)",
    "",
    "Inside the app, press ? to see every key.",
  ].join("\n");
