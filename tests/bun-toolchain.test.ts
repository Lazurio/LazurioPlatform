import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectBunToolchain } from "../src/modules/bun-toolchain";

test.skipIf(!["darwin", "linux"].includes(process.platform))(
  "toolchain observes actual selected Bun with an explicit empty environment and refuses mismatches",
  async () => {
    const cwd = await realpath(await mkdtemp(join(tmpdir(), "bun-toolchain-")));
    try {
      const request = {
        executable: process.execPath,
        cwd,
        env: {},
        packageManager: `bun@${Bun.version}`,
      };
      expect(await inspectBunToolchain(request)).toEqual({
        kind: "toolchain-observed",
        executable: process.execPath,
        packageManager: request.packageManager,
      });
      expect(
        await inspectBunToolchain({ ...request, packageManager: "bun@0.0.0" }),
      ).toEqual({
        kind: "toolchain-mismatch",
        expected: "bun@0.0.0",
        actual: `bun@${Bun.version}`,
      });
      expect(
        await inspectBunToolchain({
          ...request,
          executable: join(cwd, "missing"),
        }),
      ).toEqual({ kind: "toolchain-unavailable" });
      for (const packageManager of [
        "bun",
        "bun@latest",
        "bun@^1.4.2",
        "bun@1.4.2\n",
        "node@22.0.0",
      ])
        await expect(
          inspectBunToolchain({ ...request, packageManager }),
        ).rejects.toThrow();
      await expect(
        inspectBunToolchain({ ...request, executable: "bun" }),
      ).rejects.toThrow();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
);
