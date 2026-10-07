import { expect, spyOn, test } from "bun:test";
import * as fsPromises from "node:fs/promises";
import {
  chmod,
  link,
  lstat,
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
import { runFrozenInstallProcess } from "../src/modules/frozen-install-process";
import {
  inspectInstallAuthority,
  verifyInstallAuthority,
} from "../src/modules/install-authority";
import { inspectPatchInputs } from "../src/modules/patch-inputs";
import { checkoutRefusal } from "../src/providers/checkout-custody";
import {
  mkdirOwnedFixture as mkdir,
  writeOwnedFixture as writeFile,
} from "./fixtures/owned-files";
import { runChild } from "./fixtures/run-child";

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
        const installed = await runChild(
          [
            process.execPath,
            "--no-env-file",
            "install",
            "--ignore-scripts",
            "--backend",
            "copyfile",
          ],
          {
            cwd: root,
            env: { HOME: home, PATH: "/usr/bin:/bin" },
            timeout: 10_000,
          },
        );
        expect(installed.exitCode, installed.stderr).toBe(0);
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
        const installed = await runChild(
          [
            process.execPath,
            "--no-env-file",
            "install",
            "--ignore-scripts",
            "--backend",
            "copyfile",
          ],
          { cwd: root, env: { HOME: root, PATH: "/usr/bin:/bin" } },
        );
        expect(installed.exitCode, installed.stderr).toBe(0);
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
      // Permission bits and the link count of the operator's checkout are
      // not install inputs (decision F23): the same bytes stay the same input.
      await chmod(patch, 0o666);
      expect(await verifyInstallAuthority(before)).toBe(true);
      await chmod(patch, 0o600);
      const alias = join(root, "alias.patch");
      await link(patch, alias);
      expect(await verifyInstallAuthority(before)).toBe(true);
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

test.skipIf(!["darwin", "linux"].includes(process.platform))(
  "the Bun lockfile has the lockfile bound: 1 MiB + 1 byte is an install input, 16 MiB + 1 byte is refused as declaration-too-large (decision F23)",
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "lock-bound-")));
    try {
      await writeFile(
        join(root, "package.json"),
        JSON.stringify({
          packageManager: "bun@1.4.2",
          dependencies: { fixture: "1.0.0" },
        }),
      );
      const lock = join(root, "bun.lock");
      await writeFile(lock, Buffer.alloc(1024 * 1024 + 1, 32));
      expect((await inspectInstallAuthority(root, root)).lockfile).toBe(
        "bun.lock",
      );
      await writeFile(lock, Buffer.alloc(16 * 1024 * 1024 + 1, 32));
      const error = await inspectInstallAuthority(root, root).then(
        () => null,
        (thrown: unknown) => thrown,
      );
      expect(checkoutRefusal(error, root)).toEqual({
        reason: "declaration-too-large",
        file: "bun.lock",
      });
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

test.skipIf(!["darwin", "linux"].includes(process.platform))(
  "the owner's package names its Bun or none, and its one lockfile is beside it; every refusal is typed with the package it concerns (decision F25)",
  async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "install-owner-")),
    );
    const file = join(root, "package.json");
    const refused = (reason: string, path = file) =>
      expect(inspectInstallAuthority(root, root)).rejects.toMatchObject({
        reason,
        path,
      });
    // Something to install, never installed here: the lockfile rule
    // (issue #253: a package with nothing to install has no lockfile).
    const dependencies = { fixture: "1.0.0" };
    try {
      // No packageManager: the operator's Bun, whichever version it is.
      await writeFile(file, JSON.stringify({ name: "owner", dependencies }));
      await refused("preparation-lockfile-missing");
      await writeFile(join(root, "bun.lock"), "");
      await refused("preparation-lockfile-missing");
      await writeFile(join(root, "bun.lock"), "opaque fixture lock");
      expect((await inspectInstallAuthority(root, root)).packageManager).toBe(
        null,
      );
      await writeFile(join(root, "bun.lockb"), "opaque binary lock");
      await refused("preparation-lockfile-ambiguous");
      await rm(join(root, "bun.lockb"));
      for (const packageManager of ["npm@10.0.0", "bun@latest", "bun", 7]) {
        await writeFile(
          file,
          JSON.stringify({ name: "owner", packageManager, dependencies }),
        );
        await refused("preparation-package-manager-unsupported");
      }
      await writeFile(
        file,
        JSON.stringify({
          name: "owner",
          packageManager: "bun@1.4.2",
          dependencies,
        }),
      );
      expect((await inspectInstallAuthority(root, root)).packageManager).toBe(
        "bun@1.4.2",
      );
      await writeFile(
        file,
        JSON.stringify({
          name: "owner",
          dependencies: { shared: "file:../shared" },
        }),
      );
      await refused("preparation-dependency-outside-owner");
      await writeFile(file, "[]");
      await refused("preparation-owner-invalid");
      expect(await readFile(join(root, "bun.lock"), "utf8")).toBe(
        "opaque fixture lock",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(!["darwin", "linux"].includes(process.platform))(
  "with a dependency boundary, a local dependency outside the owner but inside the boundary is an install input; the boundary itself, beyond it and a missing one are refused (decision F25)",
  async () => {
    const boundary = await realpath(
      await mkdtemp(join(tmpdir(), "install-boundary-")),
    );
    const owner = join(boundary, "workspace/module/app/v3");
    const checkout = join(boundary, "workspace/module");
    const contracts = join(boundary, "launchpad/contracts/v1");
    const file = join(owner, "package.json");
    const write = (reference: string) =>
      writeFile(
        file,
        JSON.stringify({
          name: "owner",
          dependencies: { contracts: reference },
        }),
      );
    try {
      await mkdir(owner, { recursive: true });
      await mkdir(contracts, { recursive: true });
      await writeFile(
        join(contracts, "package.json"),
        JSON.stringify({ name: "contracts", version: "1.0.0" }),
      );
      await writeFile(join(owner, "bun.lock"), "opaque fixture lock");
      await write("file:../../../../launchpad/contracts/v1");
      // Without the boundary the owner is the limit, as before.
      await expect(
        inspectInstallAuthority(checkout, owner),
      ).rejects.toMatchObject({
        reason: "preparation-dependency-outside-owner",
        path: file,
      });
      const before = await inspectInstallAuthority(
        checkout,
        owner,
        undefined,
        boundary,
      );
      expect(await verifyInstallAuthority(before)).toBe(true);
      await writeFile(
        join(contracts, "package.json"),
        JSON.stringify({ name: "contracts", version: "2.0.0" }),
      );
      expect(await verifyInstallAuthority(before)).toBe(false);
      for (const [reference, reason] of [
        ["file:../../../..", "preparation-dependency-outside-owner"],
        ["file:../../../../..", "preparation-dependency-outside-owner"],
        [
          "file:../../../../launchpad/contracts/v9",
          "preparation-dependency-missing",
        ],
      ] as const) {
        await write(reference);
        await expect(
          inspectInstallAuthority(checkout, owner, undefined, boundary),
        ).rejects.toMatchObject({ reason, path: file });
      }
    } finally {
      await rm(boundary, { recursive: true, force: true });
    }
  },
);

// Issue #253: a package that declares nothing for Bun to install. Bun writes
// no lockfile for one (`No packages! Deleted empty lockfile`) and its frozen
// install refuses any lockfile beside one, so it is prepared without a
// lockfile and without an install; every other package keeps the rule.

test.skipIf(!["darwin", "linux"].includes(process.platform))(
  "a package that declares nothing to install needs no lockfile; the verdict is bound to its exact bytes and the configuration, and a dependency added later is under the lockfile rule (issue #253)",
  async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "nothing-to-install-")),
    );
    const file = join(root, "package.json");
    // Empty members and scripts that `bun install` does not run declare
    // nothing to install.
    const pkg = {
      name: "owner",
      packageManager: "bun@1.4.2",
      scripts: { dev: "fixture", build: "fixture" },
      dependencies: {},
      devDependencies: {},
    };
    try {
      await writeFile(file, JSON.stringify(pkg));
      const snapshot = await inspectInstallAuthority(root, root);
      expect(snapshot).toMatchObject({
        lockfile: null,
        lockDigest: null,
        packageManager: "bun@1.4.2",
      });
      expect(await verifyInstallAuthority(snapshot)).toBe(true);
      // The same members in other bytes are another package.
      await writeFile(file, JSON.stringify(pkg, null, 2));
      expect(await verifyInstallAuthority(snapshot)).toBe(false);
      await writeFile(file, JSON.stringify(pkg));
      expect(await verifyInstallAuthority(snapshot)).toBe(true);
      // The package manager configuration stays an input of the observation.
      await writeFile(join(root, "bunfig.toml"), "[install]\n");
      expect(await verifyInstallAuthority(snapshot)).toBe(false);
      await rm(join(root, "bunfig.toml"));
      expect(await verifyInstallAuthority(snapshot)).toBe(true);
      // A dependency added later: no longer what was observed, and under the
      // lockfile rule until its lockfile is there.
      await writeFile(
        file,
        JSON.stringify({ ...pkg, dependencies: { fixture: "1.0.0" } }),
      );
      expect(await verifyInstallAuthority(snapshot)).toBe(false);
      await expect(inspectInstallAuthority(root, root)).rejects.toMatchObject({
        reason: "preparation-lockfile-missing",
        path: file,
      });
      await writeFile(join(root, "bun.lock"), "opaque fixture lock");
      const locked = await inspectInstallAuthority(root, root);
      expect(locked.lockfile).toBe("bun.lock");
      expect(locked.lockDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(await verifyInstallAuthority(snapshot)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(!["darwin", "linux"].includes(process.platform))(
  "a dependency of any kind, any workspaces, what applies to dependencies, a script bun install runs and a member of another shape keep the lockfile rule; empty members declare nothing to install (issue #253)",
  async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "install-members-")),
    );
    const file = join(root, "package.json");
    const write = (members: Record<string, unknown>) =>
      writeFile(file, JSON.stringify({ name: "owner", ...members }));
    try {
      for (const members of [
        { dependencies: { fixture: "1.0.0" } },
        { dependencies: { fixture: "file:./fixture" } },
        { devDependencies: { fixture: "1.0.0" } },
        { optionalDependencies: { fixture: "1.0.0" } },
        { peerDependencies: { fixture: "1.0.0" } },
        { workspaces: [] },
        { workspaces: { packages: [] } },
        { overrides: { fixture: "1.0.0" } },
        { resolutions: { fixture: "1.0.0" } },
        { catalog: { fixture: "1.0.0" } },
        { catalogs: { tools: {} } },
        { patchedDependencies: { "fixture@1.0.0": "patches/fixture.patch" } },
        { bundleDependencies: ["fixture"] },
        { bundledDependencies: true },
        { trustedDependencies: ["fixture"] },
        ...[
          "preinstall",
          "install",
          "postinstall",
          "preprepare",
          "prepare",
          "postprepare",
        ].map((script) => ({ scripts: { dev: "fixture", [script]: "" } })),
        // A member of another shape is never taken for an empty one.
        { dependencies: [] },
        { dependencies: null },
        { overrides: "fixture" },
        { trustedDependencies: {} },
        { scripts: [] },
        { scripts: "fixture" },
      ]) {
        await write(members);
        await expect(
          inspectInstallAuthority(root, root),
          JSON.stringify(members),
        ).rejects.toMatchObject({
          reason: "preparation-lockfile-missing",
          path: file,
        });
      }
      for (const members of [
        {},
        {
          dependencies: {},
          devDependencies: {},
          optionalDependencies: {},
          peerDependencies: {},
        },
        {
          overrides: {},
          resolutions: {},
          catalog: {},
          catalogs: {},
          patchedDependencies: {},
        },
        {
          bundleDependencies: [],
          bundledDependencies: [],
          trustedDependencies: [],
        },
        { scripts: {} },
        // Scripts that `bun install` does not run.
        {
          scripts: {
            dev: "fixture",
            build: "fixture",
            test: "fixture",
            prepack: "fixture",
            prepublishOnly: "fixture",
            postuninstall: "fixture",
          },
        },
        // What selects the toolchain or describes the package installs
        // nothing.
        {
          packageManager: "bun@1.4.2",
          private: true,
          type: "module",
          bin: { owner: "cli.js" },
          engines: { bun: ">=1.4.2" },
        },
      ]) {
        await write(members);
        expect(
          (await inspectInstallAuthority(root, root)).lockfile,
          JSON.stringify(members),
        ).toBeNull();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(!["darwin", "linux"].includes(process.platform))(
  "a lockfile beside a package that declares nothing to install is refused by its own name as preparation-lockfile-unused, never followed or changed (issue #253)",
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "unused-lock-")));
    const file = join(root, "package.json");
    const lock = join(root, "bun.lock");
    const refusedAs = (name: string) =>
      expect(inspectInstallAuthority(root, root)).rejects.toMatchObject({
        reason: "preparation-lockfile-unused",
        path: join(root, name),
      });
    try {
      // Left over from a removed dependency: written by Bun while the
      // package had it, then the dependency was removed by hand.
      await mkdir(join(root, "dependency"));
      await writeFile(
        join(root, "dependency/package.json"),
        JSON.stringify({ name: "fixture-dependency", version: "1.0.0" }),
      );
      await writeFile(
        file,
        JSON.stringify({
          name: "owner",
          dependencies: { "fixture-dependency": "file:./dependency" },
        }),
      );
      const written = await runChild(
        [process.execPath, "--no-env-file", "install", "--lockfile-only"],
        { cwd: root, env: { HOME: root, PATH: "/usr/bin:/bin" } },
      );
      expect(written.exitCode, written.stderr).toBe(0);
      const leftover = await readFile(lock, "utf8");
      await writeFile(file, JSON.stringify({ name: "owner" }));
      await refusedAs("bun.lock");
      expect(await readFile(lock, "utf8")).toBe(leftover);
      // Written by hand with no packages, which Bun's frozen install
      // refuses too; empty; both; only the binary one; a dangling symlink.
      await writeFile(
        lock,
        `${JSON.stringify({ lockfileVersion: 1, workspaces: { "": { name: "owner" } }, packages: {} })}\n`,
      );
      await refusedAs("bun.lock");
      await writeFile(lock, "");
      await refusedAs("bun.lock");
      await writeFile(join(root, "bun.lockb"), "opaque binary lock");
      await refusedAs("bun.lock");
      await rm(lock);
      await refusedAs("bun.lockb");
      await rm(join(root, "bun.lockb"));
      await symlink(join(root, "nowhere"), lock);
      await refusedAs("bun.lock");
      await rm(lock);
      expect((await inspectInstallAuthority(root, root)).lockfile).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(!["darwin", "linux"].includes(process.platform))(
  "with nothing to install the owner's package and the checkout's package manager configuration keep the checkout's file rule, reason and file (decision F23, issue #253)",
  async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "nothing-custody-")),
    );
    const owner = join(root, "app");
    const file = join(owner, "package.json");
    const pkg = JSON.stringify({ name: "owner" });
    const refusal = async () =>
      checkoutRefusal(
        await inspectInstallAuthority(root, owner).then(
          () => null,
          (thrown: unknown) => thrown,
        ),
        root,
      );
    try {
      await mkdir(owner);
      await writeFile(file, pkg);
      expect((await inspectInstallAuthority(root, owner)).lockfile).toBeNull();
      // A symlinked package is never read through.
      await writeFile(join(root, "outside.json"), pkg);
      await rm(file);
      await symlink(join(root, "outside.json"), file);
      expect(await refusal()).toEqual({
        reason: "declaration-not-regular",
        file: "app/package.json",
      });
      await rm(file);
      await writeFile(
        file,
        JSON.stringify({ name: "owner", description: " ".repeat(1024 * 1024) }),
      );
      expect(await refusal()).toEqual({
        reason: "declaration-too-large",
        file: "app/package.json",
      });
      // Another account's package: a faked stat, only root can chown.
      await writeFile(file, pkg);
      const original = fsPromises.lstat;
      const spy = spyOn(fsPromises, "lstat").mockImplementation((async (
        path: Parameters<typeof original>[0],
        options?: Parameters<typeof original>[1],
      ) => {
        const stat = await original(path, options as undefined);
        if (path === file)
          Object.defineProperty(stat, "uid", { value: stat.uid + 1 });
        return stat;
      }) as typeof original);
      try {
        expect(await refusal()).toEqual({
          reason: "declaration-owner",
          file: "app/package.json",
        });
      } finally {
        spy.mockRestore();
      }
      // A duplicate member never decides that there is nothing to install.
      await writeFile(
        file,
        '{"name":"owner","dependencies":{"fixture":"1.0.0"},"dependencies":{}}',
      );
      await expect(inspectInstallAuthority(root, owner)).rejects.toThrow(
        "Duplicate JSON declaration member",
      );
      await writeFile(file, pkg);
      // The checkout's package manager configuration, down to the owner.
      for (const name of [
        ".npmrc",
        "bunfig.toml",
        "app/.npmrc",
        "app/bunfig.toml",
      ]) {
        const path = join(root, name);
        await symlink(join(root, "outside.json"), path);
        expect(await refusal()).toEqual({
          reason: "declaration-not-regular",
          file: name,
        });
        await rm(path);
        await writeFile(path, "#".repeat(1024 * 1024 + 1));
        expect(await refusal()).toEqual({
          reason: "declaration-too-large",
          file: name,
        });
        await rm(path);
      }
      expect((await inspectInstallAuthority(root, owner)).lockfile).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(!["darwin", "linux"].includes(process.platform))(
  "with nothing to install the preparation starts no process but the toolchain's version probe and writes nothing; a dependency added before its run leaves it unprepared (issue #253)",
  async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "nothing-prepared-")),
    );
    const checkout = join(root, "checkout");
    const owner = join(checkout, "app");
    const file = join(owner, "package.json");
    const home = join(root, "home");
    // A Bun that answers its version and records every call: an install,
    // or any process the preparation started with it, would be a call.
    const bun = join(root, "tools/bun");
    const calls = join(root, "tools/calls");
    const unused = join(root, "must-not-execute-platform");
    const pkg = {
      name: "owner",
      packageManager: "bun@1.4.2",
      scripts: { dev: "fixture" },
    };
    const preparation = (cleanInstall: boolean) =>
      preflightBunPreparation({
        checkout,
        owner,
        executable: bun,
        platformExecutable: unused,
        env: { HOME: home },
        timeoutMs: 10_000,
        cleanInstall,
        verifyPrepared: async () => true,
      });
    const prepare = async (cleanInstall: boolean, before?: () => unknown) => {
      const prepared = await preparation(cleanInstall);
      try {
        await before?.();
        return await prepared.run(new AbortController().signal);
      } finally {
        expect(await prepared.close()).toEqual({ kind: "closed" });
      }
    };
    const called = async () =>
      new Set((await readFile(calls, "utf8")).split("\n").filter(Boolean));
    try {
      await mkdir(owner, { recursive: true });
      await mkdir(home);
      await mkdir(join(root, "tools"));
      await writeFile(
        bun,
        `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\nif [ "$1" = --version ]; then printf '1.4.2\\n'; exit 0; fi\nexit 97\n`,
        { mode: 0o700 },
      );
      await writeFile(file, JSON.stringify(pkg));
      expect(await prepare(false)).toEqual({ kind: "prepared" });
      expect(await called()).toEqual(new Set(["--version"]));
      // Bun's install, frozen or not, leaves node_modules even when it
      // installs nothing; here there is none.
      await expect(lstat(join(owner, "node_modules"))).rejects.toThrow();
      expect(await readFile(file, "utf8")).toBe(JSON.stringify(pkg));
      // A clean preparation removes what an earlier install left behind
      // and installs nothing.
      await mkdir(join(owner, "node_modules/left-over"), { recursive: true });
      expect(await prepare(true)).toEqual({ kind: "prepared" });
      await expect(lstat(join(owner, "node_modules"))).rejects.toThrow();
      expect(await called()).toEqual(new Set(["--version"]));
      // A dependency added between the preflight and the run: what was
      // observed changed, so nothing is prepared, and nothing installed.
      expect(
        await prepare(false, () =>
          writeFile(
            file,
            JSON.stringify({ ...pkg, dependencies: { fixture: "1.0.0" } }),
          ),
        ),
      ).toEqual({ kind: "preparation-failed" });
      expect(await called()).toEqual(new Set(["--version"]));
      await expect(lstat(join(owner, "node_modules"))).rejects.toThrow();
      // The frozen install itself never runs without the owner's lockfile.
      await writeFile(file, JSON.stringify(pkg));
      await expect(
        runFrozenInstallProcess({
          authority: await inspectInstallAuthority(checkout, owner, {
            HOME: home,
          }),
          executable: bun,
          platformExecutable: unused,
          env: { HOME: home },
          timeoutMs: 10_000,
        }),
      ).rejects.toThrow("lockfile");
      expect(await called()).toEqual(new Set(["--version"]));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
