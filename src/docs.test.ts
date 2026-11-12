// Tests that README.md and SECURITY.md say what the code does. The text is hand-written, so these
// stop it drifting: they read the real settings (scopes, ports, vault item names, the commands in
// `--help`) and check the docs name every one of them.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { REDIRECT_PORTS, SCOPES } from "./auth/config.ts";
import { TOKENS_SECRET_NAME } from "./auth/token-store.ts";
import { helpText } from "./cli.ts";

const root = join(import.meta.dir, "..");
const read = (file: string) => Bun.file(join(root, file)).text();

// The text of one "## Heading" section, up to the next "## " heading.
function section(text: string, heading: string): string {
  const start = text.indexOf(`\n## ${heading}\n`);
  expect(start).toBeGreaterThan(-1);
  const rest = text.slice(start + 1);
  const next = rest.indexOf("\n## ", 3);
  return next === -1 ? rest : rest.slice(0, next);
}

// The command names in `tangent --help`'s "Commands:" list.
function helpCommands(): string[] {
  const lines = helpText().split("\n");
  const from = lines.indexOf("Commands:");
  const names: string[] = [];
  for (const line of lines.slice(from + 1)) {
    if (line.trim() === "") break;
    const name = line.trim().split(/\s+/)[0];
    if (name) names.push(name);
  }
  return names;
}

describe("README.md", () => {
  test("documents every command that --help lists", async () => {
    const readme = await read("README.md");
    const commands = helpCommands();
    expect(commands).toEqual(["login", "logout"]); // if a command is added, document it, then update this
    for (const name of commands) expect(readme).toContain(`tangent ${name}`);
  });

  test("the Run section lists every command, not just a mention somewhere else", async () => {
    const run = section(await read("README.md"), "Run");
    for (const name of helpCommands()) expect(run).toContain(`tangent ${name}`);
  });

  test("names every permission the login asks for", async () => {
    const readme = await read("README.md");
    for (const scope of SCOPES) expect(readme).toContain(`\`${scope}\``);
  });

  test("Setup leads with the browser login command; the API key comes after, as the fallback", async () => {
    const setup = section(await read("README.md"), "Setup");
    // The login command itself, in its own code block (other mentions of it don't count).
    const login = setup.indexOf("```sh\ntangent login\n```");
    const apiKey = setup.indexOf("security add-generic-password");
    expect(login).toBeGreaterThan(-1);
    expect(apiKey).toBeGreaterThan(-1);
    expect(login).toBeLessThan(apiKey);
    expect(setup).toContain("LINEAR_API_KEY");
  });

  test("Setup tells people to check the workspace and how to switch", async () => {
    const setup = section(await read("README.md"), "Setup");
    expect(setup).toContain("workspace name at the top left");
    expect(setup).toContain("dropdown");
    expect(setup).toContain("Logged in to");
  });

  test("Requirements no longer demands an API key", async () => {
    const requirements = section(await read("README.md"), "Requirements");
    expect(requirements).toContain("A Linear account");
    expect(requirements).not.toContain("personal API key (Linear");
  });

  test("the old 'store your API key once' setup step is gone", async () => {
    expect(await read("README.md")).not.toContain("Store your API key in the macOS Keychain once, after installing");
  });

  test("Uninstall says to log out first, and how to clean up by hand", async () => {
    const readme = await read("README.md");
    expect(readme).toContain("Log out first");
    expect(readme).toContain(`security delete-generic-password -s ${TOKENS_SECRET_NAME} -a tangent`);
    expect(readme).toContain("Authorized applications");
  });
});

describe("SECURITY.md", () => {
  test("names every permission the login asks for, and the broader one it doesn't", async () => {
    const security = await read("SECURITY.md");
    for (const scope of SCOPES) expect(security).toContain(`\`${scope}\``);
    expect(security).toContain("does not ask for admin access or the broader `write` permission");
  });

  test("names every port the local redirect may use", async () => {
    const security = await read("SECURITY.md");
    const listed = REDIRECT_PORTS.map(String);
    for (const port of listed) expect(security).toContain(port);
  });

  test("names where the login is kept, and the API key's vault item", async () => {
    const security = await read("SECURITY.md");
    expect(security).toContain(TOKENS_SECRET_NAME);
    expect(security).toContain("linear-api-key");
    expect(security).toContain("LINEAR_API_KEY");
  });

  test("says how to end a login, by command and in Linear, in the bullet about ending it", async () => {
    const security = await read("SECURITY.md");
    const ending = security.split("\n").find((line) => line.startsWith("- **Ending it.**")) ?? "";
    expect(ending).toContain("`tangent logout`");
    expect(ending).toContain("Authorized applications");
  });

  test("still promises that credentials are never written to a file, env var or log", async () => {
    expect(await read("SECURITY.md")).toContain("never written to a file, an environment variable or a log");
  });

  test("no longer describes the API key as the way Tangent logs in", async () => {
    expect(await read("SECURITY.md")).not.toContain("talks to Linear with **your personal API key**");
  });
});
