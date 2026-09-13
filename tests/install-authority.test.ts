import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  inspectInstallAuthority,
  verifyInstallAuthority,
} from "../src/modules/install-authority";

test.skipIf(!["darwin", "linux"].includes(process.platform))(
  "install authority pins exact owner, package hooks and opaque lock bytes without ancestor fallback",
  async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "install-authority-")),
    );
    const checkout = join(root, "checkout");
    const owner = join(checkout, "app");
    await mkdir(checkout, { mode: 0o700 });
    await mkdir(owner, { mode: 0o700 });
    const pkg = {
      packageManager: "bun@1.4.2",
      scripts: { preinstall: "fixture-only" },
      dependencies: {},
    };
    const packageFile = join(owner, "package.json");
    const lock = join(owner, "bun.lock");
    try {
      await writeFile(packageFile, JSON.stringify(pkg));
      await writeFile(join(checkout, "bun.lock"), "parent must not substitute");
      await expect(inspectInstallAuthority(checkout, owner)).rejects.toThrow(
        "lockfile",
      );
      await writeFile(lock, "// opaque fixture, not a validated lock\n{}");
      const snapshot = await inspectInstallAuthority(checkout, owner);
      expect(await verifyInstallAuthority(snapshot)).toBe(true);
      expect(snapshot.packageManager).toBe("bun@1.4.2");
      expect(Object.isFrozen(snapshot.manifest.scripts)).toBe(true);
      pkg.scripts.preinstall = "different";
      await writeFile(packageFile, JSON.stringify(pkg));
      expect(await verifyInstallAuthority(snapshot)).toBe(false);
      pkg.scripts.preinstall = "fixture-only";
      await writeFile(packageFile, JSON.stringify(pkg));
      await writeFile(lock, "changed lock");
      expect(await verifyInstallAuthority(snapshot)).toBe(false);
      await writeFile(lock, "// opaque fixture, not a validated lock\n{}");
      await writeFile(join(owner, "bun.lockb"), "ambiguous");
      await expect(inspectInstallAuthority(checkout, owner)).rejects.toThrow(
        "One explicit",
      );
      await rm(join(owner, "bun.lockb"));
      await rename(owner, join(checkout, "retained"));
      await mkdir(owner, { mode: 0o700 });
      await writeFile(packageFile, JSON.stringify(pkg));
      await writeFile(lock, "// opaque fixture, not a validated lock\n{}");
      expect(await verifyInstallAuthority(snapshot)).toBe(false);
      await expect(inspectInstallAuthority(checkout, root)).rejects.toThrow(
        "outside",
      );
      await rm(lock);
      await symlink(join(checkout, "bun.lock"), lock);
      await expect(inspectInstallAuthority(checkout, owner)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
