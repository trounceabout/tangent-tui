#!/usr/bin/env bun
// index.tsx: the entry point. Starts the app full-screen.
//
// Command line: `terminal-velocity --help` and `--version` are handled FIRST, before the UI
// is even loaded (that's why ink and the app are imported with `await import` further down,
// not at the top). The argument rules live in src/cli.ts.
//
// alternateScreen: true takes over the whole pane like vim or lazygit, and
// restores whatever was in the terminal before when you quit.
//
// Mouse: a filter sits between the real keyboard and Ink. It pulls mouse reports out of
// the input (Ink would drop them) and hands them to the app through MouseContext.
// TERMINAL_VELOCITY_MOUSE=0 starts with the mouse off (the `m` key switches it back on).
// exitHooks makes sure the terminal's mouse mode is switched off however we exit.

import pkg from "./package.json";
import { helpText, parseArgs, versionText } from "./src/cli.ts";

const cli = parseArgs(process.argv.slice(2));
if (cli.action === "help") {
  console.log(helpText());
  process.exit(0);
}
if (cli.action === "version") {
  console.log(versionText(pkg.version));
  process.exit(0);
}
if (cli.action === "error") {
  console.error(cli.message);
  process.exit(2);
}

// Only now load the UI.
const { render } = await import("ink");
const { App } = await import("./src/app.tsx");
const { mouseStartsOff } = await import("./src/env.ts");
const { createMouseInput } = await import("./src/mouse.ts");
const { MouseContext, mouseApiFor } = await import("./src/mouse-context.ts");

const mouse = createMouseInput(process.stdin, process.stdout, {
  enabled: !mouseStartsOff(),
  exitHooks: true,
});

const app = render(
  <MouseContext.Provider value={mouseApiFor(mouse)}>
    <App />
  </MouseContext.Provider>,
  { stdin: mouse.stdin as never, alternateScreen: true },
);

await app.waitUntilExit();
mouse.close(); // mouse reporting off, before the shell gets the terminal back
