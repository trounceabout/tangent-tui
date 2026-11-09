// index.tsx: the entry point. Starts the app full-screen.
// alternateScreen: true takes over the whole pane like vim or lazygit, and
// restores whatever was in the terminal before when you quit.

import { render } from "ink";
import { App } from "./src/app.tsx";

render(<App />, { alternateScreen: true });
