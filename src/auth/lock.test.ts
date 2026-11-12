// Tests for src/auth/lock.ts: the lock that keeps two Tangent windows from refreshing at once.
//
// Every test uses its own temporary folder, never the real ~/.config/tangent.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
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

// A lock held by another window, the way a real one looks: a folder WITH its owner file inside.
// (An empty folder is not a realistic lock: a rename onto an empty folder succeeds.)
function heldByAnotherWindow(path: string = lockPath) {
  mkdirSync(path);
  writeFileSync(join(path, "owner"), "another-window");
}

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

  test("the lock folder holds one small file with a random id, and no secrets", async () => {
    const seen: string[] = [];
    for (let i = 0; i < 2; i++) {
      await createFileLock(lockPath).withLock(async () => {
        expect(readdirSync(lockPath)).toEqual(["owner"]);
        seen.push(readFileSync(join(lockPath, "owner"), "utf8"));
      });
    }
    expect(seen[0]).toMatch(/^[0-9a-f-]{36}$/); // a random id (a UUID), nothing else
    expect(seen[1]).not.toBe(seen[0]); // a different one each time
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
    heldByAnotherWindow();
    const lock = createFileLock(lockPath, { timeoutMs: 80, pollMs: 10, staleMs: 60_000 });
    let ran = false;
    await expect(
      lock.withLock(async () => {
        ran = true;
      }),
    ).rejects.toThrow("Another Tangent window is busy");
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
    heldByAnotherWindow();
    const lock = createFileLock(lockPath, { staleMs: 30_000, timeoutMs: 60, pollMs: 10 });
    await expect(lock.withLock(async () => "x")).rejects.toThrow("Another Tangent window");
  });
});

describe("the lock stays ours: owner-checked release", () => {
  test("a holder whose lock was taken over leaves the new owner's lock alone, and nobody gets in beside the new owner", async () => {
    // A has no heartbeat, so its long task lets its lock go stale and B takes it over. B keeps its
    // lock fresh. When A finally finishes, A must NOT delete B's lock, or C would get in beside B.
    const quiet = createFileLock(lockPath, { staleMs: 100, pollMs: 5, timeoutMs: 3000, heartbeatMs: 0 });
    const busy = createFileLock(lockPath, { staleMs: 100, pollMs: 5, timeoutMs: 3000, heartbeatMs: 30 });
    const events: string[] = [];
    const A = quiet.withLock(async () => {
      events.push("A in");
      await sleep(400);
      events.push("A done");
    });
    await sleep(10);
    const B = busy.withLock(async () => {
      events.push("B in");
      await sleep(600);
      events.push("B done");
    });
    await A; // A releases here, while B (which took over at about 100 ms) still runs until about 700 ms
    expect(existsSync(lockPath)).toBe(true); // B's lock is still there
    const C = busy.withLock(async () => {
      events.push("C in");
    });
    await Promise.all([B, C]);
    expect(events.indexOf("B in")).toBeGreaterThan(events.indexOf("A in")); // B really did take over from A
    expect(events.indexOf("C in")).toBeGreaterThan(events.indexOf("B done")); // and C waited for B
  });

  test("an ordinary release removes the lock", async () => {
    await createFileLock(lockPath).withLock(async () => {});
    expect(existsSync(lockPath)).toBe(false);
  });
});

describe("a busy holder stays fresh (the heartbeat)", () => {
  test("a task much longer than the stale limit is never mistaken for a dead one", async () => {
    const lock = createFileLock(lockPath, { staleMs: 100, pollMs: 5, timeoutMs: 3000 }); // heartbeat on by default
    const events: string[] = [];
    const A = lock.withLock(async () => {
      events.push("A in");
      await sleep(500); // five times the stale limit
      events.push("A out");
    });
    await sleep(20);
    const B = lock.withLock(async () => {
      events.push("B in");
    });
    await Promise.all([A, B]);
    expect(events).toEqual(["A in", "A out", "B in"]); // B waited; it never took over A's live lock
  });

  test("the heartbeat really does touch the lock", async () => {
    const lock = createFileLock(lockPath, { staleMs: 3000, heartbeatMs: 25 });
    await lock.withLock(async () => {
      const first = statSync(lockPath).mtimeMs;
      await sleep(150);
      expect(statSync(lockPath).mtimeMs).toBeGreaterThan(first);
    });
  });

  test("a holder whose lock was replaced does not keep the NEW owner's lock fresh", async () => {
    // Simulate a takeover while A is alive: swap the lock folder for another window's, long untouched.
    const lock = createFileLock(lockPath, { staleMs: 60_000, heartbeatMs: 20 });
    await lock.withLock(async () => {
      rmSync(lockPath, { recursive: true, force: true });
      heldByAnotherWindow();
      const longAgo = new Date(Date.now() - 50_000);
      utimesSync(lockPath, longAgo, longAgo);
      await sleep(150); // several heartbeats
      expect(Date.now() - statSync(lockPath).mtimeMs).toBeGreaterThan(40_000); // still as old as we made it
    });
    expect(existsSync(lockPath)).toBe(true); // and A's release left the other window's lock alone
  });

  test("with the heartbeat off, a long task does go stale and gets taken over (the tests above rely on this)", async () => {
    const lock = createFileLock(lockPath, { staleMs: 100, pollMs: 5, timeoutMs: 3000, heartbeatMs: 0 });
    const events: string[] = [];
    const A = lock.withLock(async () => {
      events.push("A in");
      await sleep(300);
      events.push("A out");
    });
    await sleep(10);
    const B = lock.withLock(async () => {
      events.push("B in");
    });
    await Promise.all([A, B]);
    expect(events).toEqual(["A in", "B in", "A out"]); // B got in while A was still running
  });
});

describe("taking over a stale lock", () => {
  const leaveStaleLock = () => {
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, "owner"), "a-window-that-crashed");
    const longAgo = new Date(Date.now() - 60_000);
    utimesSync(lockPath, longAgo, longAgo);
  };

  test("many windows finding the same stale lock at once: only one at a time gets in, round after round", async () => {
    for (let round = 0; round < 15; round++) {
      leaveStaleLock();
      const lock = createFileLock(lockPath, { staleMs: 1000, pollMs: 2, timeoutMs: 5000, heartbeatMs: 0 });
      let inside = 0;
      let most = 0;
      await Promise.all(
        Array.from({ length: 8 }, () =>
          lock.withLock(async () => {
            inside += 1;
            most = Math.max(most, inside);
            await sleep(5);
            inside -= 1;
          }),
        ),
      );
      expect(most).toBe(1);
      expect(existsSync(lockPath)).toBe(false);
    }
  });

  test("the stale folder is removed, leaving nothing behind next to the lock", async () => {
    leaveStaleLock();
    await createFileLock(lockPath, { staleMs: 1000 }).withLock(async () => {});
    expect(readdirSync(dir)).toEqual([]);
  });

  test("a stale lock whose contents can't be deleted is still moved out of the way, so it doesn't block anyone", async () => {
    if (process.getuid?.() === 0) return; // root ignores folder permissions
    leaveStaleLock();
    chmodSync(lockPath, 0o555); // its owner file can't be deleted, but the folder itself can be moved
    try {
      const lock = createFileLock(lockPath, { staleMs: 1000, pollMs: 5, timeoutMs: 1000 });
      expect(await lock.withLock(async () => "got in")).toBe("got in");
    } finally {
      for (const name of readdirSync(dir)) {
        const left = join(dir, name);
        try {
          chmodSync(left, 0o755); // so the temp folder can be cleaned up afterwards
        } catch {
          // already gone
        }
      }
    }
  });

  test("a stale lock behind a takeover gate that never opens times out cleanly: it never spins", async () => {
    leaveStaleLock();
    mkdirSync(`${lockPath}.takeover`); // another window sits in the gate for ever (and keeps it fresh)
    const lock = createFileLock(lockPath, { staleMs: 60_000, pollMs: 5, timeoutMs: 200 });
    const started = Date.now();
    await expect(lock.withLock(async () => "x")).rejects.toThrow("Another Tangent window is busy");
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test("only one window at a time may clear a stale lock: while another holds the takeover gate, this one waits", async () => {
    leaveStaleLock();
    const gate = `${lockPath}.takeover`;
    mkdirSync(gate); // another window is in the middle of clearing it
    const lock = createFileLock(lockPath, { staleMs: 60_000, pollMs: 5, timeoutMs: 3000 });
    const events: string[] = [];
    const waiting = lock.withLock(async () => {
      events.push("in");
    });
    await sleep(120);
    expect(events).toEqual([]); // still waiting: the gate is held, so it did not clear the stale lock itself
    expect(existsSync(lockPath)).toBe(true); // and the stale lock is still there
    rmSync(gate, { recursive: true }); // the other window finishes
    await waiting;
    expect(events).toEqual(["in"]);
  });

  test("a gate left behind by a window that crashed is itself cleared once it is stale", async () => {
    leaveStaleLock();
    const gate = `${lockPath}.takeover`;
    mkdirSync(gate);
    const longAgo = new Date(Date.now() - 120_000);
    utimesSync(gate, longAgo, longAgo);
    const lock = createFileLock(lockPath, { staleMs: 1000, pollMs: 5, timeoutMs: 3000 });
    expect(await lock.withLock(async () => "got in")).toBe("got in");
    expect(readdirSync(dir)).toEqual([]);
  });

  test("a lock is only cleared if it is STILL stale inside the gate (one touched in the gap is left alone)", async () => {
    // The waiter sees the lock stale; in the gap before it reaches the gate, the (not actually dead)
    // holder touches it. Looking again inside the gate must notice, and leave it alone.
    leaveStaleLock();
    const lock = createFileLock(lockPath, {
      staleMs: 1000, // longer than the timeout, so it can't go stale again before we give up
      pollMs: 5,
      timeoutMs: 300,
      onSeenStale: () => {
        const now = new Date();
        utimesSync(lockPath, now, now);
      },
    });
    await expect(lock.withLock(async () => "stole a live lock")).rejects.toThrow("Another Tangent window is busy");
    expect(existsSync(lockPath)).toBe(true);
    expect(readFileSync(join(lockPath, "owner"), "utf8")).toBe("a-window-that-crashed"); // untouched
  });

  test("the same gap with a lock that is really dead: it is cleared and the waiter gets in", async () => {
    leaveStaleLock();
    let seen = 0;
    const lock = createFileLock(lockPath, { staleMs: 1000, pollMs: 5, timeoutMs: 2000, onSeenStale: () => void seen++ });
    expect(await lock.withLock(async () => "got in")).toBe("got in");
    expect(seen).toBeGreaterThan(0); // the hook really ran in the gap
  });
});

describe("a lock path that can be created but not read", () => {
  test("a dangling symlink there (it exists, yet looking at it fails) times out instead of spinning", async () => {
    symlinkSync(join(dir, "nowhere"), lockPath);
    const lock = createFileLock(lockPath, { staleMs: 60_000, pollMs: 5, timeoutMs: 150 });
    const started = Date.now();
    await expect(lock.withLock(async () => "x")).rejects.toThrow("Another Tangent window is busy");
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("the message", () => {
  test("is short enough for a narrow pane and says what to do", async () => {
    heldByAnotherWindow();
    const lock = createFileLock(lockPath, { timeoutMs: 40, pollMs: 5, staleMs: 60_000 });
    const message = await lock.withLock(async () => "x").then(
      () => "",
      (error: Error) => error.message,
    );
    expect(message.length).toBeLessThanOrEqual(50);
    expect(message).toContain("Try again");
  });
});

describe("waiting politely", () => {
  test("pauses between checks instead of spinning", async () => {
    // Another window holds the lock and lets go after 30 ms. With a 200 ms pause between checks
    // we should only notice after about 200 ms. A busy loop would notice at once (and burn CPU).
    heldByAnotherWindow();
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
