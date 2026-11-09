// index.tsx: the entry point. Starts the app full-screen.
// alternateScreen: true takes over the whole pane like vim or lazygit, and
// restores whatever was in the terminal before when you quit.
//
// Mouse: a filter sits between the real keyboard and Ink. It pulls mouse reports out of
// the input (Ink would drop them) and hands them to the app through MouseContext.
// LINEAR_TUI_MOUSE=0 starts with the mouse off (the `m` key switches it back on).
// exitHooks makes sure the terminal's mouse mode is switched off however we exit.

import { render } from "ink";
import { App } from "./src/app.tsx";
import { createMouseInput } from "./src/mouse.ts";
import { MouseContext, mouseApiFor } from "./src/mouse-context.ts";

const mouse = createMouseInput(process.stdin, process.stdout, {
  enabled: process.env.LINEAR_TUI_MOUSE !== "0",
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
