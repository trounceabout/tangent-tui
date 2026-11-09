// src/cli.ts
// Command-line arguments: `terminal-velocity --help` and `--version`.
// Pure functions only (no printing, no exiting), so they are easy to test.
// index.tsx calls these first and decides what to print and when to quit.

// The arguments the person typed, from process.argv, process.argv0 on its own.
//
// Normally that's argv.slice(2). But in a compiled binary (Bun 1.2.21), running it with NO
// arguments puts the binary's own path in as a fake first argument: argv is
// ["bun", "/$bunfs/root/terminal-velocity", "./terminal-velocity"]. Left alone, plain
// `terminal-velocity` would fail with "Unknown option: ./terminal-velocity". The fake one is
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
  | { action: "help" }
  | { action: "version" }
  | { action: "error"; message: string };

// Looks at the arguments (process.argv.slice(2)) and says what to do.
// Help and version win over everything else, so `terminal-velocity --bogus --help`
// shows the help instead of complaining. Any other argument is an error: a typo like
// `--versoin` must not silently open the full-screen app.
export function parseArgs(args: string[]): CliAction {
  if (args.includes("--help") || args.includes("-h")) return { action: "help" };
  if (args.includes("--version") || args.includes("-v")) return { action: "version" };

  const unknown = args[0];
  if (unknown !== undefined) {
    return { action: "error", message: `Unknown option: ${unknown}. Try --help.` };
  }
  return { action: "run" };
}

// `terminal-velocity 0.1.0`
export const versionText = (version: string): string => `terminal-velocity ${version}`;

// Kept under 80 columns per line, so it reads well in a narrow pane.
export const helpText = (): string =>
  [
    "terminal-velocity: your Linear issues from every active cycle, in the terminal.",
    "",
    "Usage:",
    "  terminal-velocity [options]",
    "",
    "Options:",
    "  -h, --help      Show this help and exit",
    "  -v, --version   Show the version and exit",
    "",
    "Environment:",
    "  TERMINAL_VELOCITY_DRY_RUN=1   Try every screen; nothing is sent to Linear",
    "  TERMINAL_VELOCITY_MOUSE=0     Start with the mouse off (press m to toggle)",
    "",
    "Inside the app, press ? to see every key.",
  ].join("\n");
