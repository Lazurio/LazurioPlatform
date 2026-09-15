import { expect, test } from "bun:test";
import { mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { acquireFolderOperationLock } from "../src/folder/lock";
import { acquireRetainedOperationLock } from "../src/folder/retained-lock";
import { createOwnerOperations } from "../src/modules/owner-operations";

test.skipIf(process.platform === "win32")(
  "retained and kernel protocols never admit independent locks for the same owner",
  async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "lock-protocols-")),
    );
    try {
      const retained = await acquireRetainedOperationLock(root);
      await expect(acquireFolderOperationLock(root)).rejects.toThrow(
        "recovery",
      );
      await retained.release();
      const native = await acquireFolderOperationLock(root);
      await expect(acquireRetainedOperationLock(root)).rejects.toThrow("busy");
      await native.release();
      await expect(acquireRetainedOperationLock(root)).rejects.toThrow("busy");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "dependency owner death does not authorize a new writer",
  async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "dependency-death-")),
    );
    try {
      const child = Bun.spawn(
        [
          process.execPath,
          "-e",
          `import {createOwnerOperations} from ${JSON.stringify(resolve("src/modules/owner-operations.ts"))};
       await createOwnerOperations().run(${JSON.stringify(root)}, async () => process.exit(23));`,
        ],
        { env: {}, stdout: "pipe", stderr: "pipe" },
      );
      expect(await child.exited, await new Response(child.stderr).text()).toBe(
        23,
      );
      const owner = createOwnerOperations();
      try {
        await expect(
          owner.run(root, async () => {
            throw new Error("must not enter");
          }),
        ).rejects.toThrow("busy");
        await expect(acquireFolderOperationLock(root)).rejects.toThrow(
          "recovery",
        );
        expect(await readdir(join(root, ".operation-lock"))).toEqual([]);
      } finally {
        await owner.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
