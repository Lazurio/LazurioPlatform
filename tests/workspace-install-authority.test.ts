import { expect, test } from "bun:test";
import { chmod, link, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  inspectInstallAuthority,
  verifyInstallAuthority,
} from "../src/modules/install-authority";
import { inspectWorkspaceInputs } from "../src/modules/workspace-inputs";
import {
  mkdirOwnedFixture as mkdir,
  writeOwnedFixture as writeFile,
} from "./fixtures/owned-files";

test.skipIf(!["darwin", "linux"].includes(process.platform))(
  "workspace inventory captures additions and removals but excludes declared nonmembers",
  async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "workspace-inventory-")),
    );
    try {
      await mkdir(join(root, "packages"));
      const patterns = ["packages/*", "!packages/excluded"];
      const empty = await inspectWorkspaceInputs(root, patterns);
      await mkdir(join(root, "packages/web"));
      await writeFile(join(root, "packages/web/package.json"), "{}");
      const added = await inspectWorkspaceInputs(root, patterns);
      expect(added).not.toEqual(empty);
      await mkdir(join(root, "packages/excluded"));
      await writeFile(
        join(root, "packages/excluded/package.json"),
        "not even parsed",
      );
      expect(await inspectWorkspaceInputs(root, patterns)).toEqual(added);
      await chmod(join(root, "packages/excluded"), 0o777);
      await mkdir(join(root, "packages/web/src"));
      await chmod(join(root, "packages/web/src"), 0o777);
      // Neither an excluded leaf nor nonmatching descendants are inspected.
      expect(await inspectWorkspaceInputs(root, patterns)).toEqual(added);
      await chmod(join(root, "packages/excluded"), 0o700);
      await chmod(join(root, "packages/web/src"), 0o700);
      await rm(join(root, "packages/web/package.json"));
      expect(await inspectWorkspaceInputs(root, patterns)).toEqual(empty);
      // No traversal through a linked member to another directory.
      await mkdir(join(root, "outside"));
      await writeFile(join(root, "outside/package.json"), "{}");
      await symlink(join(root, "outside"), join(root, "packages/linked"));
      expect(await inspectWorkspaceInputs(root, patterns)).toEqual(empty);
      await symlink(
        join(root, "outside/package.json"),
        join(root, "packages/web/package.json"),
      );
      await expect(inspectWorkspaceInputs(root, patterns)).rejects.toThrow(
        "Regular workspace manifest",
      );
      await rm(join(root, "packages/web/package.json"));
      expect(Object.isFrozen(empty)).toBe(true);
      for (const reserved of [".git", "node_modules"]) {
        await mkdir(join(root, reserved));
        await writeFile(
          join(root, reserved, "package.json"),
          "untrusted metadata",
        );
        await chmod(join(root, reserved), 0o777);
      }
      // Broad patterns still cannot read derived dependencies or Git metadata.
      const broad = await inspectWorkspaceInputs(root, ["**"]);
      expect(
        Object.keys(broad).some(
          (key) => key.includes("node_modules") || key.includes(".git"),
        ),
      ).toBe(false);
    } finally {
      await rm(root, { recursive: true });
    }
  },
);

test.skipIf(!["darwin", "linux"].includes(process.platform))(
  "workspace member manifest changes invalidate captured install inputs",
  async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "workspace-authority-")),
    );
    try {
      await mkdir(join(root, "packages/web"), { recursive: true });
      await writeFile(
        join(root, "package.json"),
        JSON.stringify({
          name: "fixture-owner",
          packageManager: "bun@1.4.2",
          workspaces: ["packages/*"],
        }),
      );
      // This reader treats lock bytes as opaque; no installation is performed.
      await writeFile(join(root, "bun.lock"), "fixture lock");
      const member = join(root, "packages/web/package.json");
      await writeFile(member, JSON.stringify({ name: "fixture-web" }));
      const before = await inspectInstallAuthority(root, root);
      expect(await verifyInstallAuthority(before)).toBe(true);
      await writeFile(
        member,
        JSON.stringify({
          name: "fixture-web",
          scripts: { postinstall: "changed member hook" },
        }),
      );
      expect(await verifyInstallAuthority(before)).toBe(false);
      const changed = await inspectInstallAuthority(root, root);
      // Same bytes and permissions are insufficient if another path can mutate
      // the manifest (for example a local dependency hardlinked by Bun).
      await link(member, join(root, "manifest-alias"));
      expect(await verifyInstallAuthority(changed)).toBe(false);
      await expect(inspectInstallAuthority(root, root)).rejects.toThrow(
        "Unsafe declaration file",
      );
    } finally {
      await rm(root, { recursive: true });
    }
  },
);
