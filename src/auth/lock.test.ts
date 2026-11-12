// Tests for src/auth/lock.ts: the lock that keeps two Tangent windows from refreshing at once.
//
// Every test uses its own temporary folder, never the real ~/.config/tangent.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileLock } from "./lock.ts";

let dir: string;
let lockPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tangent-lock-"));
  lockPath = join(dir, "login.lock");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("taking and releasing the lock", () => {
  test("runs the task, returns its result, and leaves nothing behind", async () => {
    const lock = createFileLock(lockPath);
    expect(await lock.withLock(async () => "done")).toBe("done");
    expect(existsSync(lockPath)).toBe(false);
  });

  test("holds the lock while the task runs", async () => {
    const lock = createFileLock(lockPath);
    await lock.withLock(async () => {
      expect(existsSync(lockPath)).toBe(true);
    });
  });

  test("releases the lock even when the task throws, and passes the error on", async () => {
    const lock = createFileLock(lockPath);
    await expect(
      lock.withLock(async () => {
        throw new Error("task failed");
      }),
    ).rejects.toThrow("task failed");
    expect(existsSync(lockPath)).toBe(false);
  });

  test("can be taken again straight after", async () => {
    const lock = createFileLock(lockPath);
    await lock.withLock(async () => {});
    expect(await lock.withLock(async () => "again")).toBe("again");
  });

  test("creates the folder around the lock if it doesn't exist yet", async () => {
    const nested = join(dir, "a", "b", "login.lock");
    expect(await createFileLock(nested).withLock(async () => "ok")).toBe("ok");
  });

  test("the lock is an empty folder: it holds no secrets", async () => {
    await createFileLock(lockPath).withLock(async () => {
      expect(existsSync(lockPath)).toBe(true);
      // a folder with nothing in it
      expect(Bun.spawnSync(["ls", "-A", lockPath]).stdout.toString()).toBe("");
    });
  });
});

describe("only one holder at a time", () => {
  test("many callers at once never overlap", async () => {
    const lock = createFileLock(lockPath, { pollMs: 5 });
    let running = 0;
    let mostAtOnce = 0;
    const order: number[] = [];
    await Promise.all(
      Array.from({ length: 6 }, (_, n) =>
        lock.withLock(async () => {
          running += 1;
          mostAtOnce = Math.max(mostAtOnce, running);
          await sleep(10);
          order.push(n);
          running -= 1;
        }),
      ),
    );
    expect(mostAtOnce).toBe(1);
    expect(order).toHaveLength(6);
  });

  test("a second caller waits for the first to finish, then goes", async () => {
    const lock = createFileLock(lockPath, { pollMs: 5 });
    const events: string[] = [];
    const first = lock.withLock(async () => {
      events.push("first starts");
      await sleep(60);
      events.push("first ends");
    });
    await sleep(10);
    const second = lock.withLock(async () => {
      events.push("second runs");
    });
    await Promise.all([first, second]);
    expect(events).toEqual(["first starts", "first ends", "second runs"]);
  });

  test("gives up with a clear message if another window holds it too long", async () => {
    mkdirSync(lockPath); // another window holds it
    const lock = createFileLock(lockPath, { timeoutMs: 80, pollMs: 10, staleMs: 60_000 });
    let ran = false;
    await expect(
      lock.withLock(async () => {
        ran = true;
      }),
    ).rejects.toThrow("Another Tangent window is refreshing the login");
    expect(ran).toBe(false);
    expect(existsSync(lockPath)).toBe(true); // someone else's lock is left alone
  });
});

describe("a lock left behind by a crashed window", () => {
  test("is removed once it is older than the stale limit, and the task runs", async () => {
    mkdirSync(lockPath);
    const longAgo = new Date(Date.now() - 120_000);
    utimesSync(lockPath, longAgo, longAgo);
    const lock = createFileLock(lockPath, { staleMs: 30_000, timeoutMs: 500, pollMs: 5 });
    expect(await lock.withLock(async () => "ran")).toBe("ran");
    expect(existsSync(lockPath)).toBe(false);
  });

  test("a fresh lock is NOT treated as stale", async () => {
    mkdirSync(lockPath);
    const lock = createFileLock(lockPath, { staleMs: 30_000, timeoutMs: 60, pollMs: 10 });
    await expect(lock.withLock(async () => "x")).rejects.toThrow("Another Tangent window");
  });
});

describe("waiting politely", () => {
  test("pauses between checks instead of spinning", async () => {
    // Another window holds the lock and lets go after 30 ms. With a 200 ms pause between checks
    // we should only notice after about 200 ms. A busy loop would notice at once (and burn CPU).
    mkdirSync(lockPath);
    setTimeout(() => rmSync(lockPath, { recursive: true, force: true }), 30);
    const lock = createFileLock(lockPath, { pollMs: 200, timeoutMs: 3000, staleMs: 60_000 });
    const started = Date.now();
    await lock.withLock(async () => {});
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
  });
});

describe("other problems", () => {
  test("a lock folder that can't be created (no permission) is a real error, not an endless wait", async () => {
    if (process.getuid?.() === 0) return; // root ignores folder permissions, so there is nothing to test
    const locked = join(dir, "readonly");
    mkdirSync(locked);
    chmodSync(locked, 0o555); // can look inside, can't create anything
    try {
      const lock = createFileLock(join(locked, "login.lock"), { timeoutMs: 2000, pollMs: 5 });
      const started = Date.now();
      await expect(lock.withLock(async () => "x")).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(1000); // failed at once, didn't wait out the timeout
    } finally {
      chmodSync(locked, 0o755);
    }
  });

  test("a folder that can't be created is a real error, not an endless wait", async () => {
    const blocker = join(dir, "a-file");
    writeFileSync(blocker, "not a folder");
    const lock = createFileLock(join(blocker, "inside", "login.lock"), { timeoutMs: 200, pollMs: 5 });
    await expect(lock.withLock(async () => "x")).rejects.toThrow();
  });
});
