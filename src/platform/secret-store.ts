// src/platform/secret-store.ts
// Where Tangent keeps a secret (the browser-login tokens) between runs: the operating
// system's own vault, never a file. One small interface, one implementation per OS. This
// file has macOS (the Keychain); Linux (secret-service) and Windows come later (#56, #62).
// See issue #69. This is the credential path, so read the rules below before changing it.
//
// Rules, each one learned the hard way or checked by a test:
//  - A secret is NEVER put on a command line (other programs can read those). It goes in
//    over stdin: `security -i` reads its commands from stdin.
//  - `security -i` reads one COMMAND per line and cuts a line at about 4 KB, then runs the
//    rest as a new command. So the line is capped well below that, and anything bigger is
//    refused instead of being cut.
//  - The `name` is pasted into that command, so it is checked against a strict pattern first
//    (no spaces, quotes or newlines), or a bad name could smuggle in a second command.
//  - `security find-generic-password -w` returns non-ASCII values as hex. So the value is stored
//    pre-encoded as base64url (always plain ASCII) and decoded on the way out.
//  - After a write we read it back and compare, so a cut-off or failed write is an error and
//    never a silent success.
//  - Error messages never include the secret, the tool's output or its error text (the tool
//    echoes part of a bad command back, which could contain the secret).

// What `get` throws when there IS an item but its contents aren't something we wrote (text that
// isn't base64url: hex from a non-ASCII value, an empty password, an item another program wrote).
// It is its own class so callers can treat "damaged" differently from "the vault couldn't be read":
// the first just means there is no usable secret here, the second means we couldn't look.
export class DamagedSecretError extends Error {
  constructor() {
    super("The saved login in the Keychain is damaged.");
    this.name = "DamagedSecretError";
  }
}

export interface SecretStore {
  // The secret stored under `name`, or null if there is none. Throws a DamagedSecretError if the
  // stored data isn't ours, and an ordinary Error if the vault can't be read.
  get(name: string): Promise<string | null>;
  // Store (or replace) the secret. Throws unless it was stored and read back identically.
  set(name: string, value: string): Promise<void>;
  // Remove the secret. Removing one that isn't there is fine.
  delete(name: string): Promise<void>;
}

// How we run an outside program. Passed in so tests never touch the real Keychain.
export type RunResult = { exitCode: number; stdout: string; stderr: string };
export type Run = (command: string[], options?: { stdin?: string }) => Promise<RunResult>;

export const defaultRun: Run = async (command, options = {}) => {
  const proc = Bun.spawn(command, {
    stdin: options.stdin === undefined ? "ignore" : new Blob([options.stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
};

const ACCOUNT = "tangent"; // every Tangent item uses this fixed account name
const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,62}$/; // lowercase, digits, . _ - ; can't start with "-"
const NOT_FOUND = 44; // `security`'s exit code for "no such item"

// The longest stored text we accept. The measured limit is a stdin line of about 4 KB, and the
// line is roughly 100 characters plus twice the stored text, so 1700 keeps it near 3.5 KB.
// A real login blob is about 350 characters.
export const MAX_STORED_CHARS = 1700;

function checkName(name: string): string {
  if (!NAME_PATTERN.test(name)) throw new Error("That is not a valid secret name.");
  return name;
}

export function createMacSecretStore(run: Run = defaultRun): SecretStore {
  const store: SecretStore = {
    async get(name) {
      checkName(name);
      const result = await run(["security", "find-generic-password", "-s", name, "-a", ACCOUNT, "-w"]);
      if (result.exitCode === NOT_FOUND) return null;
      if (result.exitCode !== 0) throw new Error("Couldn't read from the Keychain.");
      const stored = result.stdout.trim();
      // Only plain base64url is valid. Anything else (hex from a non-ASCII value, an
      // item someone else wrote) is damaged data, not a secret of ours.
      if (!/^[A-Za-z0-9_-]+$/.test(stored)) throw new DamagedSecretError();
      return Buffer.from(stored, "base64url").toString("utf8");
    },

    async set(name, value) {
      checkName(name);
      const encoded = Buffer.from(value, "utf8").toString("base64url");
      if (encoded.length > MAX_STORED_CHARS) throw new Error("That secret is too large to store safely.");
      const hex = Buffer.from(encoded, "ascii").toString("hex");
      // One command on one line, sent over stdin so the secret is never in a command line.
      const line = `add-generic-password -U -a ${ACCOUNT} -s ${name} -X ${hex}\n`;
      const result = await run(["security", "-i"], { stdin: line });
      if (result.exitCode !== 0) throw new Error("Couldn't save to the Keychain.");
      // Read it back: a cut-off or ignored write must be an error, not a silent success.
      const back = await store.get(name).catch(() => null);
      if (back !== value) throw new Error("Couldn't verify what was saved to the Keychain.");
    },

    async delete(name) {
      checkName(name);
      const result = await run(["security", "delete-generic-password", "-s", name, "-a", ACCOUNT]);
      if (result.exitCode !== 0 && result.exitCode !== NOT_FOUND) throw new Error("Couldn't remove from the Keychain.");
    },
  };
  return store;
}

// The store for this computer. Only macOS so far; Linux and Windows are tracked in #56 and #62.
export function createSecretStore(platform: string = process.platform, run: Run = defaultRun): SecretStore {
  if (platform === "darwin") return createMacSecretStore(run);
  throw new Error(`Saving a login isn't supported on ${platform} yet. Use a LINEAR_API_KEY instead.`);
}
