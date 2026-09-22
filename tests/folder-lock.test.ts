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
      await withFolderOperationLock(directory, async () => {});
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
