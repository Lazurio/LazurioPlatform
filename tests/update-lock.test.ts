import { expect, test } from "bun:test";
import { mkdtemp, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UpdateFailure } from "../src/update/errors";
import { acquireUpdateLock } from "../src/update/lock";

async function directory() {
  return realpath(await mkdtemp(join(tmpdir(), "update-lock-")));
}

test("the lock excludes, waits up to its timeout, and reports busy as a typed failure", async () => {
  const root = await directory();
  try {
    const path = join(root, "lock");
    const first = await acquireUpdateLock(path, { timeoutMs: 0 });
    const refused = await acquireUpdateLock(path, { timeoutMs: 120 }).catch(
      (error) => error,
    );
    expect(refused).toBeInstanceOf(UpdateFailure);
    expect((refused as UpdateFailure).failure.code).toBe("busy");
    const waiting = acquireUpdateLock(path, { timeoutMs: 5_000 });
    await new Promise((resolve) => setTimeout(resolve, 120));
    await first.release();
    await first.release(); // idempotent
    const second = await waiting;
    await second.release();
  } finally {
    await rm(root, { recursive: true });
  }
});

test("initialization cannot be interrupted into a wedge: any pre-existing lock file content is acceptable", async () => {
  const root = await directory();
  try {
    const path = join(root, "lock");
    // Whatever a killed process left behind — empty, partial, foreign bytes —
    // the content is never read, so there is nothing to recover.
    for (const leftover of ["", "lazurio-dir", "\u0000\u0001garbage"]) {
      await writeFile(path, leftover);
      const lock = await acquireUpdateLock(path, { timeoutMs: 0 });
      await lock.release();
    }
  } finally {
    await rm(root, { recursive: true });
  }
});

test("a lock file replaced while another process holds the old inode does not create a second lock domain for the holder of the new path", async () => {
  const root = await directory();
  try {
    const path = join(root, "lock");
    const stale = await acquireUpdateLock(path, { timeoutMs: 0 });
    await rename(path, join(root, "moved-away"));
    // The path now names a new inode; acquisition binds to what the path
    // names NOW and verifies that identity after locking.
    const current = await acquireUpdateLock(path, { timeoutMs: 0 });
    const contender = await acquireUpdateLock(path, { timeoutMs: 100 }).catch(
      (error) => error,
    );
    expect(contender).toBeInstanceOf(UpdateFailure);
    await current.release();
    await stale.release();
  } finally {
    await rm(root, { recursive: true });
  }
});

test("a SIGKILLed holder releases the lock immediately: no stale state, no recovery step", async () => {
  const root = await directory();
  const path = join(root, "lock");
  const holder = Bun.spawn(
    [
      process.execPath,
      new URL("./fixtures/update-lock-holder.ts", import.meta.url).pathname,
      path,
    ],
    { stdout: "pipe", stderr: "inherit" },
  );
  try {
    const reader = holder.stdout.getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toContain("held");
    const refused = await acquireUpdateLock(path, { timeoutMs: 100 }).catch(
      (error) => error,
    );
    expect(refused).toBeInstanceOf(UpdateFailure);
    holder.kill("SIGKILL");
    await holder.exited;
    const lock = await acquireUpdateLock(path, { timeoutMs: 2_000 });
    await lock.release();
  } finally {
    holder.kill("SIGKILL");
    await rm(root, { recursive: true });
  }
}, 15_000);
