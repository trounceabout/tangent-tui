// src/auth/lock.ts
// A lock shared by every Tangent window on this computer, so only one at a time refreshes the
// login. See issue #69.
//
// Why it matters: every refresh gives back a NEW refresh token and retires the old one. Two
// windows refreshing at once could each save a different token, and one of them would have
// kept a dead one. So the refresh happens inside this lock, and the second window checks again
// once it gets in (it will usually find the first window already did the job).
//
// The lock is a folder. Inside it is one small file holding a random id that says whose lock it is.
// It holds no secrets. Four rules keep two windows from ever holding it at once:
//
//  0. IT APPEARS AND DISAPPEARS WHOLE. The folder is built in a temporary place with its owner file
//     already inside, then moved into position with ONE rename. A rename onto an existing,
//     non-empty folder fails, so exactly one window can create it, and nobody can ever see a lock
//     with no owner. It is removed the same way (renamed out of the way, THEN deleted), never with a
//     recursive delete in place: that passes through a moment where the folder is EMPTY, and a
//     rename onto an empty folder succeeds, so another window could slip in and then have its
//     owner file deleted from under it.
//
//  1. OWNER-CHECKED RELEASE. A holder only removes the lock if its own id is still inside. If its
//     lock was taken over (it was suspended, say), it leaves the new owner's lock alone.
//  2. A BUSY HOLDER STAYS FRESH. While the task runs, the holder touches the folder every
//     `heartbeatMs`. "Stale" therefore means "nobody has touched it for `staleMs`", not "held for a
//     long time", so a slow but alive window (a slow network, a Keychain prompt) keeps its lock.
//  3. GATED TAKEOVER. Only one window at a time may clear a stale lock: it first takes a second,
//     short-lived "takeover" folder, and LOOKS AGAIN inside it before removing anything. With many
//     windows polling at once, several can see the same stale lock, but only the first through the
//     gate acts on it; the rest, once through, find it already cleared or fresh and leave it alone.
//     (Clearing it without a gate let a late window delete the fresh lock an early one had just made.)
//  4. EVERY PATH THROUGH THE WAIT LOOP reaches the timeout (it is checked at the top of each turn)
//     and, unless it made progress, the pause. A persistent problem therefore times out; it can
//     never spin forever.
//
// Left over: a window suspended for longer than `staleMs` (a laptop asleep mid-refresh) can have its
// lock taken over while it is still alive. On waking, its release leaves the new owner's lock alone
// (rule 1), but for that moment two windows may both refresh. Linear lets the same refresh token be
// retried for 30 minutes, which is what makes that survivable.

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface RefreshLock {
  // Run `task` while holding the lock. The lock is always released afterwards, even if `task` throws.
  withLock<T>(task: () => Promise<T>): Promise<T>;
}

export interface LockOptions {
  staleMs?: number; // a lock nobody has touched for this long is assumed to be left by a crashed window
  timeoutMs?: number; // how long to wait for another window before giving up
  pollMs?: number; // how often to check while waiting
  // How often a holder touches its lock while its task runs. Default: a third of `staleMs`. 0 turns
  // it off (only for tests that need a lock to go stale while it is held).
  heartbeatMs?: number;
}

const OWNER_FILE = "owner";
// Short, and it says what to do. (Over 50 columns would wrap in a narrow pane.)
const BUSY_MESSAGE = "Another Tangent window is busy. Try again soon.";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createFileLock(path: string, options: LockOptions = {}): RefreshLock {
  const { staleMs = 30_000, timeoutMs = 15_000, pollMs = 50 } = options;
  const heartbeatMs = options.heartbeatMs ?? Math.max(10, Math.floor(staleMs / 3));

  const ownerFile = join(path, OWNER_FILE);
  // Is the lock at `path` still ours? (Reads the id inside; any problem means "no".)
  const stillOurs = async (owner: string): Promise<boolean> => (await readFile(ownerFile, "utf8").catch(() => null)) === owner;

  // Remove a lock folder atomically: move it out of the way with one rename, THEN delete it. (A
  // recursive delete in place would leave the folder empty for a moment; see rule 0.) Throws if the
  // folder isn't there. Failing to delete the moved folder is ignored: it is already out of the way.
  async function moveAside(target: string): Promise<void> {
    const grave = `${target}.gone.${randomUUID()}`;
    await rename(target, grave);
    await rm(grave, { recursive: true, force: true }).catch(() => {});
  }

  // Try to create the lock. True if we now hold it, false if someone else does.
  async function tryCreate(owner: string): Promise<boolean> {
    // Build the whole lock (folder + owner file) somewhere private, then move it into place.
    const building = `${path}.new.${owner}`;
    await mkdir(building); // a failure here (no permission, no parent) is a real error: let it out
    try {
      await writeFile(join(building, OWNER_FILE), owner);
      await rename(building, path); // atomic; fails if a lock is already there
      return true;
    } catch (error) {
      await rm(building, { recursive: true, force: true }).catch(() => {});
      const code = (error as NodeJS.ErrnoException).code;
      // "Something is already there": another window holds it (or the path is occupied by something
      // that isn't a folder). Either way we don't hold it; the caller waits.
      if (code === "EEXIST" || code === "ENOTEMPTY" || code === "ENOTDIR" || code === "EISDIR" || code === "EACCES" || code === "EPERM") {
        return false;
      }
      throw error;
    }
  }

  // Clear a lock we have seen to be stale. True if it was cleared (so creating one is worth trying
  // at once), false if we couldn't or shouldn't. Only one window at a time gets to try (the gate).
  const gatePath = `${path}.takeover`;
  async function clearStaleLock(): Promise<boolean> {
    try {
      await mkdir(gatePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // Another window is clearing it. If ITS gate has been left for ages (it crashed), clear that.
      const gate = await stat(gatePath).catch(() => undefined);
      if (gate && Date.now() - gate.mtimeMs > staleMs) await rm(gatePath, { recursive: true, force: true }).catch(() => {});
      return false;
    }
    try {
      // Look again INSIDE the gate: the lock may have been cleared, or a fresh one made, since we looked.
      const again = await stat(path).catch(() => undefined);
      if (!again || Date.now() - again.mtimeMs <= staleMs) return false;
      await moveAside(path);
      return true;
    } catch {
      return false; // couldn't remove it: wait, and the timeout will end it if it never clears
    } finally {
      await rm(gatePath, { recursive: true, force: true }).catch(() => {});
    }
  }

  async function acquire(): Promise<string> {
    await mkdir(dirname(path), { recursive: true });
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      // Checked at the top of EVERY turn, so no path through this loop can run past the timeout.
      if (Date.now() > deadline) throw new Error(BUSY_MESSAGE);

      const owner = randomUUID();
      if (await tryCreate(owner)) return owner;

      // Someone holds it. If nobody has touched it for too long, take it over and try at once.
      const looked = await stat(path).catch(() => undefined); // undefined: it was released, or can't be read
      if (looked && Date.now() - looked.mtimeMs > staleMs && (await clearStaleLock())) continue;

      await sleep(pollMs);
    }
  }

  return {
    async withLock(task) {
      const owner = await acquire();
      // While the task runs, keep touching the lock so a slow task isn't mistaken for a dead one.
      const beat =
        heartbeatMs > 0
          ? setInterval(() => {
              void (async () => {
                if (await stillOurs(owner)) {
                  const now = new Date();
                  await utimes(path, now, now).catch(() => {});
                }
              })();
            }, heartbeatMs)
          : undefined;
      beat?.unref?.();
      try {
        return await task();
      } finally {
        clearInterval(beat);
        // Only remove the lock if it is still ours: if it was taken over, leave the new owner's alone.
        if (await stillOurs(owner)) await moveAside(path).catch(() => {});
      }
    },
  };
}
