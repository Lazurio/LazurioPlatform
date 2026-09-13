import { expect, test } from "bun:test";
import {
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
import { withFolderOperationLock } from "../src/folder/lock";

test.skipIf(process.platform === "win32")(
  "process termination leaves a blocking lock instead of unsafe automatic recovery",
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
      await expect(
        withFolderOperationLock(directory, async () => {}),
      ).rejects.toThrow("recovery");
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
      expect(await readdir(directory)).toEqual([]);
      await expect(
        withFolderOperationLock(directory, async () => {
          throw new Error("callback failed");
        }),
      ).rejects.toThrow("callback failed");
      expect(await readdir(directory)).toEqual([]);
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
      ).rejects.toThrow("busy");
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
      ).rejects.toThrow("busy");
      expect(await readdir(join(directory, "abandoned"))).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
