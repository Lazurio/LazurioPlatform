import { expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  acquireFolderOperationLock,
  withFolderOperationLock,
  withFolderReadLock,
} from "../src/folder/lock";
import { darwinFilesystemName } from "../src/folder/native-lock";

// Qualification by name, not by the boot-assigned darwin type number.
test.skipIf(process.platform !== "darwin")(
  "the lock qualifies APFS by its filesystem name",
  () => {
    expect(darwinFilesystemName(tmpdir())).toBe("apfs");
    expect(darwinFilesystemName("/")).toBe("apfs");
    expect(darwinFilesystemName("/dev")).toBe("devfs");
    expect(() => darwinFilesystemName("/definitely/not/a/path")).toThrow(
      "could not be inspected",
    );
  },
);

test.skipIf(process.platform === "win32")(
  "process termination releases kernel exclusion without deleting persistent evidence",
  async () => {
    const directory = await realpath(
      await mkdtemp(join(tmpdir(), "folder-lock-crash-")),
    );
    try {
      const child = Bun.spawn(
        [
          process.execPath,
          "-e",
          `import { withFolderOperationLock } from ${JSON.stringify(resolve("src/folder/lock.ts"))};
       await withFolderOperationLock(${JSON.stringify(directory)}, async () => { process.exit(23); });`,
        ],
        { stdout: "pipe", stderr: "pipe", env: {} },
      );
      const [code, stderr] = await Promise.all([
        child.exited,
        new Response(child.stderr).text(),
      ]);
      expect(code, stderr).toBe(23);
      expect(await readdir(directory)).toEqual([".operation-lock"]);
      await withFolderOperationLock(directory, async () => {});
      expect(await readdir(join(directory, ".operation-lock"))).toEqual([
        "protocol",
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "invalid protocol is preserved and refusal releases the descriptor",
  async () => {
    const directory = await realpath(
      await mkdtemp(join(tmpdir(), "lock-protocol-")),
    );
    try {
      await withFolderOperationLock(directory, async () => {});
      const path = join(directory, ".operation-lock", "protocol");
      const original = await readFile(path);
      await writeFile(path, "broken");
      await expect(
        withFolderOperationLock(directory, async () => {}),
      ).rejects.toThrow("protocol");
      expect(await readFile(path, "utf8")).toBe("broken");
      await writeFile(path, original);
      await chmod(path, 0o620);
      await expect(
        withFolderOperationLock(directory, async () => {}),
      ).rejects.toThrow("protocol");
      await chmod(path, 0o600);
      await withFolderOperationLock(directory, async () => {});
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "shared lock excludes contenders and releases successful and failed callbacks",
  async () => {
    const directory = await realpath(
      await mkdtemp(join(tmpdir(), "folder-lock-")),
    );
    try {
      let contenders = 0;
      const result = await withFolderOperationLock(
        directory,
        async (assertHeld) => {
          await assertHeld();
          await expect(
            withFolderOperationLock(directory, async () => {
              contenders++;
            }),
          ).rejects.toThrow("busy");
          return "completed";
        },
      );
      expect(result).toBe("completed");
      expect(contenders).toBe(0);
      expect(await readdir(directory)).toEqual([".operation-lock"]);
      await expect(
        withFolderOperationLock(directory, async () => {
          throw new Error("callback failed");
        }),
      ).rejects.toThrow("callback failed");
      expect(await readdir(directory)).toEqual([".operation-lock"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "abandoned or foreign lock is never reclaimed, and unexpected content survives",
  async () => {
    const directory = await realpath(
      await mkdtemp(join(tmpdir(), "folder-lock-")),
    );
    const lock = join(directory, ".operation-lock");
    try {
      await mkdir(lock);
      await expect(
        withFolderOperationLock(directory, async () => {}),
      ).rejects.toThrow();
      await rename(lock, join(directory, "abandoned"));
      await expect(
        withFolderOperationLock(directory, async () => {
          await writeFile(join(lock, "unknown"), "Preserve me");
        }),
      ).rejects.toThrow();
      expect(await readFile(join(lock, "unknown"), "utf8")).toBe("Preserve me");
      await rename(lock, join(directory, "retained"));
      await symlink("abandoned", lock);
      await expect(
        withFolderOperationLock(directory, async () => {}),
      ).rejects.toThrow();
      expect(await readdir(join(directory, "abandoned"))).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "lock is not inherited by an executed consumer",
  async () => {
    const directory = await realpath(
      await mkdtemp(join(tmpdir(), "lock-exec-")),
    );
    let consumerPid: number | undefined;
    try {
      const child = Bun.spawn(
        [
          process.execPath,
          "-e",
          `import { withFolderOperationLock } from ${JSON.stringify(resolve("src/folder/lock.ts"))};
       await withFolderOperationLock(${JSON.stringify(directory)}, async () => {
         const consumer = Bun.spawn(["/bin/sleep", "30"], {stdin:"ignore",stdout:"ignore",stderr:"ignore"});
         console.log(consumer.pid);
         process.exit(23);
       });`,
        ],
        { stdout: "pipe", stderr: "pipe", env: {} },
      );
      const output = await new Response(child.stdout).text();
      expect(await child.exited, await new Response(child.stderr).text()).toBe(
        23,
      );
      consumerPid = Number(output.trim());
      expect(Number.isSafeInteger(consumerPid) && consumerPid > 1).toBe(true);
      process.kill(consumerPid, 0);
      // Free while the consumer still runs (it sleeps 30 s). On Linux, Bun
      // spawns with vfork semantics: the holder resumes, and may exit, before
      // its child's exec has released the close-on-exec descriptor, so on a
      // loaded runner the lock can still read busy for a moment (seen once
      // under parallel test workers). Waiting a bounded 10 s keeps the proof.
      await withFolderReadLock(directory, async () => {}, 10_000);
      process.kill(consumerPid, 0);
    } finally {
      if (consumerPid && consumerPid > 1) process.kill(consumerPid, "SIGKILL");
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "replaced lock fails recheck and release preserves both directories",
  async () => {
    const directory = await realpath(
      await mkdtemp(join(tmpdir(), "lock-replaced-")),
    );
    try {
      const lock = await acquireFolderOperationLock(directory);
      const path = join(directory, ".operation-lock");
      await rename(path, join(directory, "original"));
      await mkdir(path, { mode: 0o700 });
      await expect(lock.assertHeld()).rejects.toThrow("changed");
      await expect(lock.release()).rejects.toThrow("changed");
      expect(await readdir(path)).toEqual([]);
      expect(await readdir(join(directory, "original"))).toEqual(["protocol"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "simultaneous first acquisitions never enter two callbacks",
  async () => {
    const directory = await realpath(
      await mkdtemp(join(tmpdir(), "lock-contenders-")),
    );
    try {
      const results = await Promise.allSettled(
        Array.from({ length: 8 }, () => acquireFolderOperationLock(directory)),
      );
      const winners = results.filter((r) => r.status === "fulfilled");
      expect(winners.length).toBe(1);
      for (const result of winners) await result.value.release();
      // Observers of the not-yet-published marker refuse before taking the
      // native lock, so they cannot strand the successful creator.
      expect(await readdir(directory)).toEqual([".operation-lock"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

// Issue #272: the shell setup cache reads the Folder in the background right
// after a profile change; the person's next change waits for that read.
test.skipIf(process.platform === "win32")(
  "a mutation of this process waits for its own short read, never for another holder",
  async () => {
    const directory = await realpath(
      await mkdtemp(join(tmpdir(), "lock-own-read-")),
    );
    try {
      let releaseRead = () => {};
      const reading = new Promise<void>((resolve) => {
        releaseRead = resolve;
      });
      const order: string[] = [];
      const read = withFolderReadLock(directory, async () => {
        order.push("read");
        await reading;
        order.push("read done");
      });
      await Bun.sleep(30);
      const write = withFolderOperationLock(directory, async () => {
        order.push("write");
      });
      await Bun.sleep(100);
      expect(order).toEqual(["read"]);
      releaseRead();
      await Promise.all([read, write]);
      expect(order).toEqual(["read", "read done", "write"]);

      // Any other holder (here one taken without the read) refuses at once.
      const held = await acquireFolderOperationLock(directory);
      try {
        const started = Date.now();
        await expect(
          withFolderOperationLock(directory, async () => {}),
        ).rejects.toThrow("busy");
        expect(Date.now() - started).toBeLessThan(500);
      } finally {
        await held.release();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "the wait for an own read is bounded, and the mutation then fails as busy",
  async () => {
    const directory = await realpath(
      await mkdtemp(join(tmpdir(), "lock-own-read-bound-")),
    );
    try {
      let releaseRead = () => {};
      const reading = new Promise<void>((resolve) => {
        releaseRead = resolve;
      });
      const read = withFolderReadLock(directory, () => reading);
      await Bun.sleep(30);
      const started = Date.now();
      await expect(
        withFolderOperationLock(directory, async () => {}, 150),
      ).rejects.toThrow("busy");
      expect(Date.now() - started).toBeGreaterThanOrEqual(140);
      releaseRead();
      await read;
      // Free again: a mutation goes through at once.
      await withFolderOperationLock(directory, async () => {});
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
