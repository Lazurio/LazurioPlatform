import { expect, test } from "bun:test";
import {
  chmod,
  link,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { preflightBunPreparation } from "../src/modules/bun-preparation";
import {
  inspectInstallAuthority,
  verifyInstallAuthority,
} from "../src/modules/install-authority";
import { inspectPatchInputs } from "../src/modules/patch-inputs";
import {
  mkdirOwnedFixture as mkdir,
  writeOwnedFixture as writeFile,
} from "./fixtures/owned-files";

for (const [parentRelative, reference] of [
  ["parent", ".."],
  ["", ".."],
  ["parent", "../"],
  ["", "../"],
] as const) {
  test.skipIf(!["darwin", "linux"].includes(process.platform))(
    `terminal parent ${reference} dependency captures ${parentRelative || "owner root"}`,
    async () => {
      const root = await realpath(
        await mkdtemp(join(tmpdir(), "parent-input-")),
      );
      const home = await realpath(
        await mkdtemp(join(tmpdir(), "parent-tools-")),
      );
      try {
        const parent = join(root, parentRelative);
        const child = join(parent, "child");
        await mkdir(child, { recursive: true });
        await writeFile(
          join(root, "package.json"),
          JSON.stringify({
            name: "owner",
            version: "1.0.0",
            packageManager: "bun@1.4.2",
            dependencies: {
              child: `file:./${parentRelative ? `${parentRelative}/` : ""}child`,
            },
          }),
        );
        if (parentRelative)
          await writeFile(
            join(parent, "package.json"),
            JSON.stringify({
              name: "parent",
              version: "1.0.0",
              main: "index.js",
            }),
          );
        await writeFile(join(parent, "index.js"), "export const value = 1;");
        await writeFile(
          join(child, "package.json"),
          JSON.stringify({
            name: "child",
            version: "1.0.0",
            dependencies: { parent: `file:${reference}` },
          }),
        );
        const installed = Bun.spawnSync({
          cmd: [
            process.execPath,
            "--no-env-file",
            "install",
            "--ignore-scripts",
            "--backend",
            "copyfile",
          ],
          cwd: root,
          env: { HOME: home, PATH: "/usr/bin:/bin" },
          stdout: "pipe",
          stderr: "pipe",
          timeout: 10_000,
        });
        expect(installed.exitCode, installed.stderr.toString()).toBe(0);
        expect(
          await readFile(
            join(root, "node_modules/child/node_modules/parent/index.js"),
            "utf8",
          ),
        ).toBe("export const value = 1;");
        await chmod(join(root, "bun.lock"), 0o600);
        const before = await inspectInstallAuthority(root, root);
        expect(await verifyInstallAuthority(before)).toBe(true);
        await writeFile(join(parent, "index.js"), "export const value = 2;");
        expect(await verifyInstallAuthority(before)).toBe(false);
        await writeFile(
          join(child, "package.json"),
          JSON.stringify({
            name: "child",
            version: "1.0.0",
            dependencies: {
              outside: `file:${parentRelative ? "../../.." : "../.."}${reference.endsWith("/") ? "/" : ""}`,
            },
          }),
        );
        await expect(inspectInstallAuthority(root, root)).rejects.toThrow(
          "Local dependency escapes its owner",
        );
      } finally {
        await rm(root, { recursive: true, force: true });
        await rm(home, { recursive: true, force: true });
      }
    },
    20_000,
  );
}

for (const [dependencyField, reference] of [
  ["dependencies", "../second"],
  ["devDependencies", "../second"],
  ["dependencies", "../second/"],
  ["devDependencies", "../second/"],
] as const) {
  test.skipIf(!["darwin", "linux"].includes(process.platform))(
    `transitive local ${dependencyField} ${reference} content invalidates install authority`,
    async () => {
      const root = await realpath(
        await mkdtemp(join(tmpdir(), "transitive-input-")),
      );
      try {
        await mkdir(join(root, "first"));
        await mkdir(join(root, "second"));
        await writeFile(
          join(root, "package.json"),
          JSON.stringify({
            packageManager: "bun@1.4.2",
            dependencies: { first: "file:./first" },
          }),
        );
        await writeFile(
          join(root, "first/package.json"),
          JSON.stringify({
            name: "first",
            version: "1.0.0",
            [dependencyField]: { second: `file:${reference}` },
          }),
        );
        await writeFile(
          join(root, "second/package.json"),
          JSON.stringify({
            name: "second",
            version: "1.0.0",
            main: "index.js",
          }),
        );
        await writeFile(
          join(root, "second/index.js"),
          "export const value = 1;",
        );
        const installed = Bun.spawnSync({
          cmd: [
            process.execPath,
            "--no-env-file",
            "install",
            "--ignore-scripts",
            "--backend",
            "copyfile",
          ],
          cwd: root,
          env: { HOME: root, PATH: "/usr/bin:/bin" },
          stdout: "pipe",
          stderr: "pipe",
        });
        expect(installed.exitCode, installed.stderr.toString()).toBe(0);
        expect(
          await readFile(
            join(root, "node_modules/first/node_modules/second/index.js"),
            "utf8",
          ),
        ).toBe("export const value = 1;");
        await chmod(join(root, "bun.lock"), 0o600);
        const before = await inspectInstallAuthority(root, root);
        expect(await verifyInstallAuthority(before)).toBe(true);
        await writeFile(
          join(root, "second/index.js"),
          "export const value = 2;",
        );
        expect(await verifyInstallAuthority(before)).toBe(false);
        // Inventory must terminate for a graph cycle without dropping either input.
        await writeFile(
          join(root, "second/package.json"),
          JSON.stringify({
            name: "second",
            version: "1.0.0",
            dependencies: { first: "file:../first" },
          }),
        );
        const cyclic = await inspectInstallAuthority(root, root);
        expect(await verifyInstallAuthority(cyclic)).toBe(true);
        await writeFile(
          join(root, "second/index.js"),
          "export const value = 3;",
        );
        expect(await verifyInstallAuthority(cyclic)).toBe(false);
        await writeFile(
          join(root, "second/package.json"),
          JSON.stringify({
            name: "second",
            version: "1.0.0",
            dependencies: { outside: "file:../../outside" },
          }),
        );
        await expect(inspectInstallAuthority(root, root)).rejects.toThrow(
          "Local dependency escapes its owner",
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
}

test.skipIf(!["darwin", "linux"].includes(process.platform))(
  "prototype-named patch and local files remain explicit snapshot inputs",
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "named-input-")));
    try {
      await writeFile(
        join(root, "package.json"),
        JSON.stringify({
          packageManager: "bun@1.4.2",
          dependencies: { fixture: "file:./__proto__" },
          patchedDependencies: { fixture: "__proto__" },
        }),
      );
      await writeFile(join(root, "bun.lock"), "opaque fixture lock");
      await writeFile(join(root, "__proto__"), "first");
      const before = await inspectInstallAuthority(root, root);
      expect(Object.hasOwn(before.patchInputs, "__proto__")).toBe(true);
      expect(Object.hasOwn(before.localDependencyInputs, "__proto__")).toBe(
        true,
      );
      await writeFile(join(root, "__proto__"), "second");
      expect(await verifyInstallAuthority(before)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(!["darwin", "linux"].includes(process.platform))(
  "local dependency content changes invalidate install authority without manifest changes",
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "local-input-")));
    try {
      await mkdir(join(root, "dependency"));
      await writeFile(
        join(root, "package.json"),
        JSON.stringify({
          packageManager: "bun@1.4.2",
          dependencies: { fixture: "file:./dependency" },
        }),
      );
      await writeFile(join(root, "bun.lock"), "opaque fixture lock");
      await writeFile(
        join(root, "dependency/package.json"),
        JSON.stringify({
          name: "fixture",
          version: "1.0.0",
          main: "index.js",
        }),
      );
      const source = join(root, "dependency/index.js");
      await writeFile(source, "export const value = 1;");
      const before = await inspectInstallAuthority(root, root);
      expect(await verifyInstallAuthority(before)).toBe(true);
      await writeFile(source, "export const value = 2;");
      expect(await verifyInstallAuthority(before)).toBe(false);
      await writeFile(source, "export const value = 1;");
      expect(await verifyInstallAuthority(before)).toBe(true);
      const extra = join(root, "dependency/extra.js");
      await writeFile(extra, "export const extra = true;");
      expect(await verifyInstallAuthority(before)).toBe(false);
      await rm(extra);
      expect(await verifyInstallAuthority(before)).toBe(true);
      await rm(source);
      expect(await verifyInstallAuthority(before)).toBe(false);
      await symlink(join(root, "package.json"), source);
      expect(await verifyInstallAuthority(before)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(!["darwin", "linux"].includes(process.platform))(
  "patch bytes are install inputs even when package and lock stay unchanged",
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "patch-input-")));
    try {
      await mkdir(join(root, "patches"));
      await writeFile(
        join(root, "package.json"),
        JSON.stringify({
          packageManager: "bun@1.4.2",
          patchedDependencies: { "fixture@1.0.0": "patches/fixture.patch" },
        }),
      );
      await writeFile(join(root, "bun.lock"), "opaque fixture lock");
      const patch = join(root, "patches/fixture.patch");
      await writeFile(patch, "original patch bytes");
      const before = await inspectInstallAuthority(root, root);
      expect(await verifyInstallAuthority(before)).toBe(true);
      await writeFile(patch, "changed patch bytes");
      expect(await verifyInstallAuthority(before)).toBe(false);
      await writeFile(patch, "original patch bytes");
      expect(await verifyInstallAuthority(before)).toBe(true);
      await chmod(patch, 0o666);
      expect(await verifyInstallAuthority(before)).toBe(false);
      await chmod(patch, 0o600);
      const alias = join(root, "alias.patch");
      await link(patch, alias);
      expect(await verifyInstallAuthority(before)).toBe(false);
      await rm(alias);
      await rename(patch, alias);
      expect(await verifyInstallAuthority(before)).toBe(false);
      await symlink(alias, patch);
      expect(await verifyInstallAuthority(before)).toBe(false);
      await rm(patch);
      await rename(alias, patch);
      await rename(join(root, "patches"), join(root, "retained-patches"));
      await symlink(join(root, "retained-patches"), join(root, "patches"));
      expect(await verifyInstallAuthority(before)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("patch declaration refuses invalid paths and accessors before filesystem inspection", async () => {
  for (const path of [
    "",
    "/outside.patch",
    "../outside.patch",
    "a/../b",
    "./patch",
    "a//b",
    "a\\b",
    "C:/patch",
    ".git/patch",
    "node_modules/patch",
    "a\nb",
  ]) {
    await expect(
      inspectPatchInputs("/must-not-inspect", { fixture: path }),
    ).rejects.toThrow("Owner-relative patch path required");
  }
  for (const value of [null, [], "patch", { fixture: 1 }]) {
    await expect(
      inspectPatchInputs("/must-not-inspect", value),
    ).rejects.toThrow();
  }
  let called = false;
  await expect(
    inspectPatchInputs("/must-not-inspect", {
      get fixture() {
        called = true;
        return "patch";
      },
    }),
  ).rejects.toThrow("Patch path required");
  expect(called).toBe(false);
});

test.skipIf(!["darwin", "linux"].includes(process.platform))(
  "install authority rejects duplicate package declarations without changing package or lock",
  async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "install-duplicates-")),
    );
    const file = join(root, "package.json");
    const lock = join(root, "bun.lock");
    try {
      const valid =
        '{"packageManager":"bun@1.4.2","scripts":{"preinstall":"fixture"}}';
      await writeFile(file, valid);
      await writeFile(lock, "opaque fixture lock");
      const before = await inspectInstallAuthority(root, root);
      for (const source of [
        '{"packageManager":"private-marker","packageManager":"bun@1.4.2"}',
        '{"packageManager":"bun@1.4.2","scripts":{"preinstall":"private-marker","preinstall":"fixture"}}',
        '{"packageManager":"bun@1.4.2","scripts":{"preinstall":"private-marker","pre\\u0069nstall":"fixture"}}',
        '{"packageManager":"bun@1.4.2","dependencies":{"fixture":"one","fixture":"two"}}',
      ]) {
        await writeFile(file, source);
        await expect(inspectInstallAuthority(root, root)).rejects.toThrow(
          "Duplicate JSON declaration member",
        );
        let postconditionCalled = false;
        await expect(
          preflightBunPreparation({
            checkout: root,
            owner: root,
            executable: join(root, "must-not-execute"),
            platformExecutable: join(root, "must-not-execute-platform"),
            env: { HOME: root },
            timeoutMs: 1000,
            verifyPrepared: async () => {
              postconditionCalled = true;
              return true;
            },
          }),
        ).rejects.toThrow("Duplicate JSON declaration member");
        expect(postconditionCalled).toBe(false);
        expect(await verifyInstallAuthority(before)).toBe(false);
        expect(await readFile(file, "utf8")).toBe(source);
        expect(await readFile(lock, "utf8")).toBe("opaque fixture lock");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

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
      const home = join(root, "home");
      const xdg = join(root, "xdg");
      await mkdir(home, { mode: 0o700 });
      await mkdir(xdg, { mode: 0o700 });
      const env = { HOME: home, XDG_CONFIG_HOME: xdg, PATH: "/usr/bin:/bin" };
      const globalSnapshot = await inspectInstallAuthority(
        checkout,
        owner,
        env,
      );
      for (const directory of [home, xdg]) {
        for (const name of [".npmrc", ".bunfig.toml"]) {
          const file = join(directory, name);
          await writeFile(file, "# synthetic global configuration\n");
          expect(await verifyInstallAuthority(globalSnapshot)).toBe(false);
          const configured = await inspectInstallAuthority(
            checkout,
            owner,
            env,
          );
          expect(await verifyInstallAuthority(configured)).toBe(true);
          await writeFile(file, "# changed synthetic configuration\n");
          expect(await verifyInstallAuthority(configured)).toBe(false);
          await rm(file);
          expect(await verifyInstallAuthority(configured)).toBe(false);
        }
      }
      expect(await verifyInstallAuthority(globalSnapshot)).toBe(true);
      await expect(
        inspectInstallAuthority(checkout, owner, { HOME: "relative" }),
      ).rejects.toThrow();
      await expect(
        inspectInstallAuthority(checkout, owner, {
          ...env,
          NPM_CONFIG_USERCONFIG: join(home, "alternate"),
        }),
      ).rejects.toThrow();
      for (const directory of [checkout, owner]) {
        for (const name of [".npmrc", "bunfig.toml"]) {
          const file = join(directory, name);
          await writeFile(file, "fixture configuration");
          expect(await verifyInstallAuthority(snapshot)).toBe(false);
          const configured = await inspectInstallAuthority(checkout, owner);
          expect(await verifyInstallAuthority(configured)).toBe(true);
          await writeFile(file, "changed configuration");
          expect(await verifyInstallAuthority(configured)).toBe(false);
          await rm(file);
          expect(await verifyInstallAuthority(configured)).toBe(false);
          expect(await verifyInstallAuthority(snapshot)).toBe(true);
        }
      }
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
