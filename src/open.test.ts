// Tests for src/open.ts: opening a link in the browser.
//
// These replace Bun.spawn with a spy, so NO real browser is ever launched.

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Mock } from "bun:test";
import { openInBrowser } from "./open.ts";

let spawn: Mock<typeof Bun.spawn>;
beforeEach(() => {
  spawn = spyOn(Bun, "spawn").mockImplementation((() => ({})) as never);
});
afterEach(() => {
  spawn.mockRestore();
});

describe("openInBrowser", () => {
  test("opens an https link with macOS `open`, passing the URL as one argument", () => {
    openInBrowser("https://linear.app/acme/issue/PD-1/x");
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0]?.[0]).toEqual(["open", "https://linear.app/acme/issue/PD-1/x"]);
  });

  test("throws away the child's output so nothing prints over the full-screen app", () => {
    openInBrowser("https://linear.app/x");
    expect(spawn.mock.calls[0]?.[1]).toMatchObject({ stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  });

  // SECURITY: the URL comes from an API response, so only plain web links may be opened.
  test.each([
    ["http (not https)", "http://example.com"],
    ["a file path", "file:///etc/hosts"],
    ["javascript:", "javascript:alert(1)"],
    ["an app link", "slack://open"],
    ["a bare command", "-a Calculator"],
    ["nothing", ""],
  ])("refuses %s", (_name, url) => {
    openInBrowser(url);
    expect(spawn).not.toHaveBeenCalled();
  });
});
