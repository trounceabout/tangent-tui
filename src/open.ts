// src/open.ts
// Opens a link in the default browser using macOS's `open` command.

export function openInBrowser(url: string): void {
  // The URL comes from an API response, so only ever open plain web links.
  if (!url.startsWith("https://")) return;
  // Fire and forget: we don't wait for the browser, and we discard its output so
  // nothing gets printed over the full-screen app.
  Bun.spawn(["open", url], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
}
