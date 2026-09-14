import { expect, test } from "bun:test";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectPreparationBinding } from "../src/modules/preparation-binding";
import { readModuleApplication } from "../src/modules/read-application";

const posixTest = test.skipIf(process.platform === "win32");

async function fixture(
  run: (root: string, pkg: Record<string, unknown>) => Promise<void>,
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "module-reader-")));
  const pkg = {
    name: "fixture-app",
    scripts: { dev: "never executed" },
    lazurio: {
      runtime: {
        schema_version: "lazurio.runtime.v1",
        id: "fixture-web",
        title: "Fixture",
        company: "Example",
        module: "fixture",
        surface: "internal",
        dev_script: "dev",
        tags: [],
        listeners: [
          {
            id: "web",
            role: "entrypoint",
            lease: "main",
            protocol: "http",
            health: { kind: "http", path: "/health" },
          },
        ],
      },
    },
  };
  try {
    await mkdir(join(root, "app"));
    await writeFile(
      join(root, "lazurio.module.json"),
      JSON.stringify({
        schema_version: "lazurio.module.v1",
        id: "fixture",
        company: "Example",
        tcp_port_policy: { mode: "single" },
        port_leases: [{ id: "main", host: "127.0.0.1", port: 4100 }],
        apps: ["app/package.json"],
        default_app: "app/package.json",
      }),
    );
    await writeFile(join(root, "app/package.json"), JSON.stringify(pkg));
    await run(root, pkg);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

posixTest(
  "preparation binding accepts an explicit self-owned package and requires its optional script",
  async () => {
    await fixture(async (root, pkg) => {
      const application = {
        ...pkg,
        packageManager: "bun@1.4.2",
        scripts: {
          ...(pkg.scripts as Record<string, string>),
          "check:data": "never executed",
          "prepare:data": "never executed",
        },
        lazurio: {
          ...(pkg.lazurio as Record<string, unknown>),
          preparation: {
            schema_version: "lazurio.preparation.v1",
            owner_package: "app/package.json",
            check_script: "check:data",
            prepare_script: "prepare:data",
          },
        },
      };
      const path = join(root, "app/package.json");
      await writeFile(path, JSON.stringify(application));
      await expect(
        inspectPreparationBinding(root, "app/package.json"),
      ).rejects.toThrow("lockfile");
      await writeFile(join(root, "app/bun.lock"), "opaque local lock");
      const observed = await inspectPreparationBinding(
        root,
        "app/package.json",
      );
      expect(observed.workspaceMember).toBe(false);
      expect(observed.authority.owner).toBe(join(root, "app"));
      const changed = {
        ...application,
        scripts: { dev: "never executed", "check:data": "never executed" },
      };
      const bytes = JSON.stringify(changed);
      await writeFile(path, bytes);
      await expect(
        inspectPreparationBinding(root, "app/package.json"),
      ).rejects.toThrow("Explicit declared module preparation script");
      expect(await readFile(path, "utf8")).toBe(bytes);
    });
  },
);

posixTest(
  "preparation binding resolves explicit owner scripts and refuses unrelated or excluded packages",
  async () => {
    await fixture(async (root, pkg) => {
      await expect(
        inspectPreparationBinding(root, "app/package.json"),
      ).rejects.toThrow("Explicit preparation");
      const owner = {
        packageManager: "bun@1.4.2",
        scripts: { "check:data": "never executed" },
        workspaces: ["app"],
      };
      const application = {
        ...pkg,
        lazurio: {
          ...(pkg.lazurio as Record<string, unknown>),
          preparation: {
            schema_version: "lazurio.preparation.v1",
            owner_package: "package.json",
            check_script: "check:data",
          },
        },
      };
      const bytes = JSON.stringify(application);
      await writeFile(join(root, "app/package.json"), bytes);
      await writeFile(join(root, "package.json"), JSON.stringify(owner));
      await writeFile(join(root, "bun.lock"), "opaque fixture lock");
      const binding = await inspectPreparationBinding(root, "app/package.json");
      expect(binding.authority.owner).toBe(root);
      expect(binding.workspaceMember).toBe(true);
      expect(await readFile(join(root, "app/package.json"), "utf8")).toBe(
        bytes,
      );
      for (const workspaces of [[], ["other"], ["*", "!app"]]) {
        await writeFile(
          join(root, "package.json"),
          JSON.stringify({ ...owner, workspaces }),
        );
        await expect(
          inspectPreparationBinding(root, "app/package.json"),
        ).rejects.toThrow("not a declared member");
      }
      await writeFile(
        join(root, "package.json"),
        JSON.stringify({ ...owner, scripts: {} }),
      );
      await expect(
        inspectPreparationBinding(root, "app/package.json"),
      ).rejects.toThrow("Explicit declared module preparation script");
      expect(await readFile(join(root, "app/package.json"), "utf8")).toBe(
        bytes,
      );
      expect(await readFile(join(root, "bun.lock"), "utf8")).toBe(
        "opaque fixture lock",
      );
    });
  },
);

posixTest(
  "module reader observes explicit preparation and refuses malformed declarations without execution",
  async () => {
    await fixture(async (root, pkg) => {
      const initial = await readModuleApplication(root);
      if (initial.kind !== "declared-runtime-plan")
        throw new Error("Missing runtime");
      expect(initial.preparation).toBeNull();
      const preparation = {
        schema_version: "lazurio.preparation.v1" as const,
        owner_package: "app/package.json",
        prepare_script: "prepare:data",
        check_script: "check:data",
      };
      const path = join(root, "app/package.json");
      const updated = {
        ...pkg,
        lazurio: { ...(pkg.lazurio as Record<string, unknown>), preparation },
      };
      const bytes = JSON.stringify(updated);
      await writeFile(path, bytes);
      const observed = await readModuleApplication(root);
      if (observed.kind !== "declared-runtime-plan")
        throw new Error("Missing runtime");
      expect(observed.preparation).toEqual(preparation);
      expect(observed.declarationDigest).not.toBe(initial.declarationDigest);
      expect(await readFile(path, "utf8")).toBe(bytes);
      updated.lazurio.preparation.owner_package = "../package.json";
      const invalid = JSON.stringify(updated);
      await writeFile(path, invalid);
      await expect(readModuleApplication(root)).rejects.toThrow();
      expect(await readFile(path, "utf8")).toBe(invalid);
    });
  },
);

posixTest(
  "read-only declared app selection tolerates ordinary package metadata",
  async () => {
    await fixture(async (root) => {
      const before = await readFile(join(root, "app/package.json"));
      const result = await readModuleApplication(root);
      expect(result.kind).toBe("declared-runtime-plan");
      if (result.kind === "declared-runtime-plan")
        expect(result.listeners[0]?.port).toBe(4100);
      expect(await readFile(join(root, "app/package.json"))).toEqual(before);
      expect(await readModuleApplication(root, "other/package.json")).toEqual({
        kind: "blocked",
        reason: "app-not-declared",
      });
    });
  },
);
posixTest(
  "module reader refuses linked files and intermediate directories",
  async () => {
    for (const mode of ["symlink", "hardlink", "directory"])
      await fixture(async (root) => {
        const path = join(root, "app/package.json");
        await writeFile(join(root, "outside.json"), await readFile(path));
        await rm(path);
        if (mode === "directory") {
          await rm(join(root, "app"), { recursive: true });
          await mkdir(join(root, "actual"));
          await writeFile(
            join(root, "actual/package.json"),
            await readFile(join(root, "outside.json")),
          );
          await symlink(join(root, "actual"), join(root, "app"));
        } else if (mode === "symlink")
          await symlink(join(root, "outside.json"), path);
        else await link(join(root, "outside.json"), path);
        await expect(readModuleApplication(root)).rejects.toThrow();
      });
  },
);
posixTest(
  "module reader refuses malformed, oversized and shared-write declarations",
  async () => {
    for (const bytes of [
      Buffer.from([0xff]),
      Buffer.from("{broken"),
      Buffer.alloc(1024 * 1024 + 1, 32),
    ])
      await fixture(async (root) => {
        await writeFile(join(root, "app/package.json"), bytes);
        await expect(readModuleApplication(root)).rejects.toThrow();
      });
    await fixture(async (root) => {
      await chmod(join(root, "app/package.json"), 0o666);
      await expect(readModuleApplication(root)).rejects.toThrow();
    });
  },
);
posixTest("module reader does not silently adopt legacy apps", async () => {
  await fixture(async (root, pkg) => {
    await writeFile(
      join(root, "app/package.json"),
      JSON.stringify({ ...pkg, companyascode: { app: {} } }),
    );
    await expect(readModuleApplication(root)).rejects.toThrow("Legacy app");
  });
});

posixTest(
  "filesystem declaration cannot substitute another module identity",
  async () => {
    await fixture(async (root, pkg) => {
      const lazurio = pkg.lazurio as { runtime: Record<string, unknown> };
      await writeFile(
        join(root, "app/package.json"),
        JSON.stringify({
          ...pkg,
          lazurio: { runtime: { ...lazurio.runtime, company: "OtherOrg" } },
        }),
      );
      await expect(readModuleApplication(root)).rejects.toThrow(
        "identity mismatch",
      );
    });
  },
);

test.skipIf(process.platform !== "win32")(
  "Windows reader refuses before filesystem access",
  async () => {
    await expect(readModuleApplication("not-a-real-path")).rejects.toThrow(
      "Unqualified module reader platform",
    );
  },
);
