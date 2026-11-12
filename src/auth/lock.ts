// src/auth/lock.ts
// A lock shared by every Tangent window on this computer, so only one at a time refreshes the
// login. See issue #69.
//
// Why it matters: every refresh gives back a NEW refresh token and retires the old one. Two
// windows refreshing at once could each save a different token, and one of them would have
// kept a dead one. So the refresh happens inside this lock, and the second window checks again
// once it gets in (it will usually find the first window already did the job).
//
// The lock is an empty folder: creating a folder either works or fails because it exists,
// atomically, on every system. It holds no secrets. A crashed window can leave one behind, so
// a lock older than `staleMs` is treated as abandoned and removed.

import { mkdir, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";

export interface RefreshLock {
  // Run `task` while holding the lock. The lock is always released afterwards, even if `task` throws.
  withLock<T>(task: () => Promise<T>): Promise<T>;
}

export interface LockOptions {
  staleMs?: number; // a lock older than this is assumed to be left by a crashed window
  timeoutMs?: number; // how long to wait for another window before giving up
  pollMs?: number; // how often to check while waiting
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createFileLock(path: string, options: LockOptions = {}): RefreshLock {
  const { staleMs = 30_000, timeoutMs = 15_000, pollMs = 50 } = options;

  async function acquire(): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        await mkdir(path); // fails with EEXIST if another window holds the lock
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      // Someone holds it. If it looks abandoned, clear it and try again straight away.
      let abandoned = false;
      try {
        abandoned = Date.now() - (await stat(path)).mtimeMs > staleMs;
      } catch {
        // It was released between our two checks, or can't be read. Either way, fall through to
        // the wait below (never loop here without a pause and a timeout, or a persistent
        // problem would spin forever).
      }
      if (abandoned) {
        await rm(path, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > deadline) throw new Error("Another Tangent window is refreshing the login. Try again in a moment.");
      await sleep(pollMs);
    }
  }

  return {
    async withLock(task) {
      await acquire();
      try {
        return await task();
      } finally {
        await rm(path, { recursive: true, force: true });
      }
    },
  };
}
