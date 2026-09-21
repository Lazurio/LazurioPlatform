import { expect, test } from "bun:test";
import {
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  rmdir,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { initializeFolder } from "../src/folder/initialize-folder";
import { executionOs } from "../src/folder/platform";
import { startLaunchpad } from "../src/launchpad/server";
import { createApplicationCoordination } from "../src/modules/application-coordination";
import { createApplicationLifecycle } from "../src/modules/lifecycle";
import {
  localApplicationAdapters,
  serviceApplicationAdapters,
} from "../src/modules/local-application-adapters";
import { createOwnerOperations } from "../src/modules/owner-operations";
import { inspectPreparationBinding } from "../src/modules/preparation-binding";
import { createSessionRunner } from "../src/modules/session-runner";
import {
  applicationCoordinationLockFile,
  createSystemdUserRunner,
} from "../src/modules/systemd-user-runner";
import { expectedLegacyProjection } from "../src/organizations/legacy-projection";
import {
  readOrganizationApplications,
  resolveOrganizationApplication,
} from "../src/organizations/read-applications";
import { createFakeServiceManager } from "./fixtures/fake-service-manager";
import {
  mkdirOwnedFixture as mkdir,
  writeOwnedFixture as writeFile,
} from "./fixtures/owned-files";

const posixTest = test.skipIf(!["darwin", "linux"].includes(process.platform));

posixTest(
  "local coordinator retains exclusion after incomplete or throwing shutdown",
  async () => {
    await fixture(async (root) => {
      const appDirectory = join(root, "workspace/web/app");
      const packagePath = join(appDirectory, "package.json");
      const pkg = JSON.parse(await readFile(packagePath, "utf8"));
      pkg.packageManager = `bun@${Bun.version}`;
      pkg.dependencies = { "fixture-dependency": "file:./dependency" };
      await mkdir(join(appDirectory, "dependency"));
      await writeFile(
        join(appDirectory, "dependency/package.json"),
        JSON.stringify({ name: "fixture-dependency", version: "1.0.0" }),
      );
      pkg.scripts.check = "must not execute in this coordination test";
      pkg.lazurio.preparation = {
        schema_version: "lazurio.preparation.v1",
        owner_package: "app/package.json",
        check_script: "check",
      };
      await writeFile(packagePath, JSON.stringify(pkg));
      const env = { HOME: root, PATH: "/usr/bin:/bin" };
      const install = Bun.spawn(
        [process.execPath, "install", "--lockfile-only"],
        {
          cwd: appDirectory,
          env,
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      expect(await install.exited).toBe(0);
      const adapters = localApplicationAdapters({
        organizationDirectory: root,
        bunExecutable: process.execPath,
        platformExecutable: process.execPath,
        environment: env,
        runner: createSessionRunner(process.execPath),
      });
      const coordinate = adapters.coordinateMutation;
      if (!coordinate) throw new Error("Expected local coordinator");
      const competitor = createOwnerOperations();
      try {
        await coordinate(
          { company: "fixture", module: "web", package: "app/package.json" },
          async () => "held",
        );
        expect(
          await coordinate(null, async () => ({ kind: "incomplete" })),
        ).toEqual({ kind: "incomplete" });
        await expect(
          competitor.run(appDirectory, async () => "unsafe"),
        ).rejects.toThrow("busy");
        await expect(
          coordinate(null, async () => {
            throw new Error("cleanup failed");
          }),
        ).rejects.toThrow("cleanup failed");
        await expect(
          competitor.run(appDirectory, async () => "unsafe"),
        ).rejects.toThrow("busy");
        await coordinate(null, async () => ({ kind: "closed" }));
        expect(await competitor.run(appDirectory, async () => "released")).toBe(
          "released",
        );
      } finally {
        await coordinate(null, async () => ({ kind: "closed" }));
        await competitor.close();
      }
    });
  },
);

posixTest(
  "compiled CLI composes declared local preparation and application lifecycle",
  async () => {
    await fixture(async (root) => {
      const appDirectory = join(root, "workspace/web/app");
      const home = join(root, "home");
      await mkdir(home, { mode: 0o700 });
      const env = {
        HOME: home,
        PATH: "/usr/bin:/bin",
      };
      const reservation = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: () => new Response("fixture"),
      });
      const port = reservation.port;
      await reservation.stop(true);
      const manifestPath = join(root, "workspace/web/lazurio.module.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      manifest.port_leases[0].port = port;
      await writeFile(manifestPath, JSON.stringify(manifest));
      const packagePath = join(appDirectory, "package.json");
      const pkg = JSON.parse(await readFile(packagePath, "utf8"));
      pkg.packageManager = `bun@${Bun.version}`;
      pkg.dependencies = { "fixture-dependency": "file:./dependency" };
      await mkdir(join(appDirectory, "dependency"));
      await writeFile(
        join(appDirectory, "dependency/package.json"),
        JSON.stringify({ name: "fixture-dependency", version: "1.0.0" }),
      );
      pkg.scripts = {
        dev: "bun run server.ts",
        prepare: "bun run prepare.ts",
        check: "bun run check.ts",
      };
      pkg.lazurio.preparation = {
        schema_version: "lazurio.preparation.v1",
        owner_package: "app/package.json",
        prepare_script: "prepare",
        check_script: "check",
      };
      await writeFile(packagePath, JSON.stringify(pkg));
      await writeFile(
        join(appDirectory, "prepare.ts"),
        'await Bun.write("prepared", "fixture-ready");',
      );
      await writeFile(
        join(appDirectory, "check.ts"),
        'process.exit(await Bun.file("prepared").exists() ? 0 : 1);',
      );
      await writeFile(
        join(appDirectory, "server.ts"),
        `if(process.env.LAZURIO_RUNTIME_LISTENER_WEB_HOST!=="127.0.0.1"||process.env.LAZURIO_RUNTIME_LISTENER_WEB_PORT!=="${port}") process.exit(1); Bun.serve({hostname:process.env.LAZURIO_RUNTIME_LISTENER_WEB_HOST,port:Number(process.env.LAZURIO_RUNTIME_LISTENER_WEB_PORT),fetch:()=>new Response("fixture-ready")});`,
      );
      const install = Bun.spawn(
        [process.execPath, "install", "--lockfile-only"],
        { cwd: appDirectory, env, stdout: "pipe", stderr: "pipe" },
      );
      expect(await install.exited).toBe(0);
      await inspectPreparationBinding(
        join(root, "workspace/web"),
        "app/package.json",
        env,
      );
      const folder = join(root, "Folder");
      await initializeFolder(folder, {
        os: executionOs(process.platform),
        access: "local",
        purpose: "human",
        locale: "en",
        detail: "concise",
        coordination: "direct",
      });
      const binary = join(root, "cli");
      const build = Bun.spawn(
        [
          process.execPath,
          "build",
          "src/cli.ts",
          "--compile",
          "--no-compile-autoload-dotenv",
          "--no-compile-autoload-bunfig",
          "--outfile",
          binary,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      expect(await build.exited).toBe(0);
      const owner = Bun.spawn(
        [
          binary,
          "launchpad",
          "--folder",
          folder,
          "--organization-directory",
          root,
          "--bun-executable",
          process.execPath,
        ],
        { env, stdout: "pipe", stderr: "pipe" },
      );
      const competitor = createOwnerOperations();
      try {
        const reader = owner.stdout.getReader();
        const first = await reader.read();
        const sessionUrl = JSON.parse(
          new TextDecoder().decode(first.value),
        ).url;
        reader.releaseLock();
        const request = async (operation: string) => {
          const child = Bun.spawn([binary, "app-request"], {
            env,
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe",
          });
          child.stdin.write(
            JSON.stringify({
              sessionUrl,
              operation,
              selection: {
                company: "fixture",
                module: "web",
                package: "app/package.json",
              },
            }),
          );
          child.stdin.end();
          const result = JSON.parse(await new Response(child.stdout).text());
          await child.exited;
          return result;
        };
        expect(await request("start")).toEqual({
          kind: "prerequisites-not-ready",
        });
        expect(await request("prepare")).toEqual({ kind: "prepared" });
        expect(await request("start")).toMatchObject({ kind: "started" });
        expect(await request("status")).toMatchObject({
          kind: "status",
          observedHealthy: true,
        });
        expect(await (await fetch(`http://127.0.0.1:${port}`)).text()).toBe(
          "fixture-ready",
        );
        // The real compiled owner keeps exclusion after start returns; an
        // independent process must not mutate the app's live dependencies.
        await expect(
          competitor.run(appDirectory, async () => "unsafe"),
        ).rejects.toThrow("busy");
        const lockBefore = await readFile(join(appDirectory, "bun.lock"));
        await writeFile(join(appDirectory, "user-work"), "keep my draft");
        await writeFile(
          join(appDirectory, "node_modules/stale-fixture"),
          "derived",
        );
        expect(await request("clean-prepare")).toEqual({ kind: "prepared" });
        expect(await request("status")).toEqual({ kind: "not-managed" });
        expect(await readFile(join(appDirectory, "user-work"), "utf8")).toBe(
          "keep my draft",
        );
        expect(await readFile(join(appDirectory, "bun.lock"))).toEqual(
          lockBefore,
        );
        expect(
          await Bun.file(
            join(appDirectory, "node_modules/stale-fixture"),
          ).exists(),
        ).toBe(false);
        expect(await request("start")).toMatchObject({ kind: "started" });
        expect(await request("stop")).toMatchObject({ kind: "group-stopped" });
        const inventoryPath = join(root, "modules.manifest.json");
        const inventory = JSON.parse(await readFile(inventoryPath, "utf8"));
        inventory.module_slots = [];
        await writeInventory(root, inventory);
        expect(await request("status")).toEqual({ kind: "denied" });
        // A removed declaration does not remove the application or user's files.
        expect(await readFile(join(appDirectory, "user-work"), "utf8")).toBe(
          "keep my draft",
        );
      } finally {
        owner.kill("SIGTERM");
        expect(await owner.exited).toBe(0);
        try {
          expect(
            await competitor.run(appDirectory, async () => "released"),
          ).toBe("released");
        } finally {
          await competitor.close();
        }
      }
    });
  },
  30_000,
);

posixTest(
  "local application selection is resolved afresh from declared inventory",
  async () => {
    await fixture(async (root, inventory) => {
      expect(await resolveOrganizationApplication(root, selection)).toEqual({
        moduleDirectory: join(root, "workspace/web"),
      });
      for (const invalid of [
        { ...selection, company: "other" },
        { ...selection, module: "source" },
        { ...selection, module: "missing" },
        { ...selection, package: "../../package.json" },
        { ...selection, directory: join(root, "workspace/web") },
        { ...selection, executable: "/usr/bin/false" },
      ])
        await expect(
          resolveOrganizationApplication(root, invalid),
        ).rejects.toThrow();
      inventory.module_slots = inventory.module_slots.filter(
        (slot) => slot.slug !== "web",
      );
      await writeInventory(root, inventory);
      await expect(
        resolveOrganizationApplication(root, selection),
      ).rejects.toThrow();
      // An existing valid module on disk is not an implicit inventory entry.
      expect(
        await readFile(join(root, "workspace/web/lazurio.module.json"), "utf8"),
      ).toContain("web");
    });
  },
);

posixTest(
  "local selection refuses conflicted declarations and replaced runtime",
  async () => {
    await fixture(async (root, inventory) => {
      inventory.module_slots.push({ path: "workspace/web", slug: "web" });
      await writeInventory(root, inventory);
      await expect(
        resolveOrganizationApplication(root, selection),
      ).rejects.toThrow();
      inventory.module_slots.pop();
      await writeInventory(root, inventory);
      await writeFile(join(root, "workspace/web/app/package.json"), "{}");
      await expect(
        resolveOrganizationApplication(root, selection),
      ).rejects.toThrow();
    });
  },
);

posixTest(
  "authenticated Launchpad discovery uses only its configured directory and never grants application control",
  async () => {
    await fixture(async (root) => {
      const folder = join(root, "Folder");
      await initializeFolder(folder, {
        os: executionOs(process.platform),
        access: "local",
        purpose: "human",
        locale: "en",
        detail: "concise",
        coordination: "direct",
      });
      const app = await startLaunchpad(folder, undefined, {
        organizationDirectory: root,
      });
      const session = new URL(app.url);
      const headers = {
        "Content-Type": "application/json",
        Origin: session.origin,
        Authorization: `Bearer ${session.hash.slice(1)}`,
      };
      const call = (path: string, body: unknown, override = {}) =>
        fetch(new URL(path, session), {
          method: "POST",
          headers: { ...headers, ...override },
          body: JSON.stringify(body),
        });
      try {
        expect(
          (await call("/api/apps/discover", {}, { Authorization: "" })).status,
        ).toBe(403);
        expect(
          (
            await call(
              "/api/apps/discover",
              {},
              { Origin: "https://foreign.invalid" },
            )
          ).status,
        ).toBe(403);
        expect(
          (
            await call("/api/apps/discover", {
              directory: "/not-a-permitted-target",
            })
          ).status,
        ).toBe(400);
        expect(await (await call("/api/apps/discover", {})).json()).toEqual(
          await readOrganizationApplications(root),
        );
        expect(
          (
            await call("/api/apps/start", {
              company: "fixture",
              module: "web",
              package: "app/package.json",
            })
          ).status,
        ).toBe(503);
        // A legacy-only root (projection without canonical) is not runnable
        // either; both end as canonical-documents-required.
        await rm(join(root, "lazurio.organization.json"));
        expect(await (await call("/api/apps/discover", {})).json()).toEqual({
          kind: "canonical-documents-required",
          resolution: { state: "legacy", issues: [] },
        });
        await rm(join(root, "company.gen3.json"));
        expect(await (await call("/api/apps/discover", {})).json()).toEqual({
          kind: "canonical-documents-required",
          resolution: { state: "missing", issues: [] },
        });
      } finally {
        expect((await app.close()).kind).toBe("closed");
      }
    });
  },
);
const canonical = {
  schema_version: "lazurio.organization.v1",
  kind: "organization",
  organization: {
    slug: "fixture",
    display_name: "Fixture",
    metadata: {},
    forge_binding: {
      forge: "github",
      locator: "Fixture",
      binding_state: "unverified",
    },
  },
  manifests: { modules: "modules.manifest.json" },
  extensions: { legacy: {} },
  compatibility: {
    legacy_projection: {
      path: "company.gen3.json",
      algorithm: "sha256-canonical-json-v1",
      sha256: `sha256:${"0".repeat(64)}`,
    },
  },
};
type Inventory = {
  company: string;
  github_org: string;
  module_slots: { path: string; slug?: string }[];
};
// Contract-valid canonical document: the declared projection digest must equal
// the deterministic projection of the same declarations (upstream `current`
// gate). A placeholder digest is a `conflict`, not a usable Organization.
function declared(document: typeof canonical, inventory: Inventory) {
  return {
    ...document,
    compatibility: {
      legacy_projection: {
        ...document.compatibility.legacy_projection,
        sha256: expectedLegacyProjection(document, inventory).hash,
      },
    },
  };
}
const verified = {
  ...canonical,
  organization: {
    ...canonical.organization,
    forge_binding: {
      forge: "github",
      locator: "Fixture",
      binding_state: "verified",
      organization_id: "1",
    },
  },
  root_repository: {
    forge: "github",
    locator: "Fixture/Fixture_GEN3",
    binding_state: "verified",
    repository_id: "2",
    default_branch: "main",
  },
};
const selection = {
  company: "fixture",
  module: "web",
  package: "app/package.json",
};
// Inventory edits change the deterministic projection, so the canonical digest
// is regenerated with them; editing only the inventory would be a stale digest.
async function writeInventory(root: string, inventory: Inventory) {
  await writeFile(
    join(root, "modules.manifest.json"),
    JSON.stringify(inventory),
  );
  const document = declared(canonical, inventory);
  await writeFile(
    join(root, "lazurio.organization.json"),
    JSON.stringify(document),
  );
  await writeProjection(root, document, inventory);
}
// Interim admission executes only the parity-valid `transition` state (root
// contract, decision 0145), so a runnable fixture root carries the exact
// generated projection next to the canonical manifest.
async function writeProjection(
  root: string,
  document: typeof canonical,
  inventory: Inventory,
) {
  await writeFile(
    join(root, "company.gen3.json"),
    JSON.stringify(expectedLegacyProjection(document, inventory).projection),
  );
}
async function fixture(
  run: (root: string, inventory: Inventory) => Promise<void>,
) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "organization-applications-")),
  );
  const inventory = {
    company: "fixture",
    github_org: "Fixture",
    module_slots: [
      { path: "workspace/web", slug: "web" },
      { path: "workspace/web/db" },
      { path: "productionspace/source", slug: "source" },
    ],
  };
  try {
    await writeFile(
      join(root, "lazurio.organization.json"),
      JSON.stringify(declared(canonical, inventory)),
    );
    await writeInventory(root, inventory);
    await mkdir(join(root, "workspace/web/app"), { recursive: true });
    await writeFile(
      join(root, "workspace/web/lazurio.module.json"),
      JSON.stringify({
        schema_version: "lazurio.module.v1",
        id: "web",
        company: "fixture",
        tcp_port_policy: { mode: "single" },
        port_leases: [{ id: "main", host: "127.0.0.1", port: 4100 }],
        apps: ["app/package.json"],
        default_app: "app/package.json",
      }),
    );
    await writeFile(
      join(root, "workspace/web/app/package.json"),
      JSON.stringify({
        name: "fixture-web",
        scripts: { dev: "must never execute" },
        lazurio: {
          runtime: {
            schema_version: "lazurio.runtime.v1",
            id: "web",
            title: "Web",
            company: "fixture",
            module: "web",
            surface: "internal",
            dev_script: "dev",
            tags: [],
            listeners: [
              {
                id: "web",
                role: "entrypoint",
                lease: "main",
                protocol: "http",
                health: { kind: "http", path: "/" },
              },
            ],
          },
        },
      }),
    );
    await run(root, inventory);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

posixTest(
  "transition root is observed without executing or scanning DBs; canonical-only current is inspection-only; a hostile legacy projection is a fail-closed conflict, never ignored",
  async () => {
    await fixture(async (root) => {
      const before = await readFile(
        join(root, "workspace/web/app/package.json"),
      );
      const observed = {
        kind: "applications-observed",
        company: "fixture",
        resolution: { state: "transition", issues: [] },
        admission: "executable",
        issues: [],
        warnings: [],
        entries: [
          {
            module: "web",
            path: "workspace/web",
            kind: "module-observed",
            defaultApp: "app/package.json",
            apps: [{ package: "app/package.json", kind: "runtime-declared" }],
          },
        ],
      } as const;
      expect(await readOrganizationApplications(root)).toEqual(observed);
      expect(await resolveOrganizationApplication(root, selection)).toEqual({
        moduleDirectory: join(root, "workspace/web"),
      });
      // Canonical-only `current` stays readable but is not executable until the
      // finalization gate of decision 0145 has run; a valid digest proves the
      // projection content, not that the projection may already be gone.
      await rm(join(root, "company.gen3.json"));
      const current = {
        ...observed,
        resolution: { state: "current", issues: [] },
        admission: "inspection-only",
      } as const;
      expect(await readOrganizationApplications(root)).toEqual(current);
      expect(
        await readOrganizationApplications(root, { admission: "executable" }),
      ).toEqual({
        kind: "organization-not-executable",
        resolution: { state: "current", issues: [] },
      });
      await expect(
        resolveOrganizationApplication(root, selection),
      ).rejects.toThrow("Selected Organization unavailable");
      // An unreadable legacy projection is a conflict under the root contract
      // (any present document invalid), not an irrelevant file: it ends before
      // descendants are inspected and before executable selection.
      await symlink(
        "/nonexistent-legacy-fixture",
        join(root, "company.gen3.json"),
      );
      const conflict = {
        kind: "organization-conflict",
        resolution: {
          state: "conflict",
          issues: ["legacy_document_unreadable"],
        },
      } as const;
      expect(await readOrganizationApplications(root)).toEqual(conflict);
      expect(
        await readOrganizationApplications(root, { admission: "executable" }),
      ).toEqual(conflict);
      await expect(
        resolveOrganizationApplication(root, selection),
      ).rejects.toThrow("Selected Organization unavailable");
      expect(
        await readFile(join(root, "workspace/web/app/package.json")),
      ).toEqual(before);
      await rm(join(root, "company.gen3.json"));
      expect(await readOrganizationApplications(root)).toEqual(current);
      await rm(join(root, "lazurio.organization.json"));
      expect(await readOrganizationApplications(root)).toEqual({
        kind: "canonical-documents-required",
        resolution: { state: "missing", issues: [] },
      });
    });
  },
);

posixTest(
  "transition parity admits; drift, conflict, stale digest, malformed projection and missing inventory refuse before descendant inspection",
  async () => {
    await fixture(async (root, inventory) => {
      const document = declared(verified, inventory);
      await writeFile(
        join(root, "lazurio.organization.json"),
        JSON.stringify(document),
      );
      const projection = expectedLegacyProjection(document, inventory)
        .projection as Record<string, unknown> & {
        company: Record<string, unknown>;
      };
      const admitted = async (state: string) => {
        expect(await readOrganizationApplications(root)).toMatchObject({
          kind: "applications-observed",
          resolution: { state, issues: [] },
          admission: "executable",
          entries: [{ kind: "module-observed" }],
        });
        expect(await resolveOrganizationApplication(root, selection)).toEqual({
          moduleDirectory: join(root, "workspace/web"),
        });
      };
      // Canonical-only `current` is not executable in this interim (decision
      // 0145 finalization gate), even though it is a valid canonical root.
      await rm(join(root, "company.gen3.json"));
      expect(
        await readOrganizationApplications(root, { admission: "executable" }),
      ).toEqual({
        kind: "organization-not-executable",
        resolution: { state: "current", issues: [] },
      });
      await expect(
        resolveOrganizationApplication(root, selection),
      ).rejects.toThrow("Selected Organization unavailable");
      // Exact generated projection: parity proven, formatting is not drift.
      await writeFile(
        join(root, "company.gen3.json"),
        JSON.stringify(projection, null, 2),
      );
      await admitted("transition");
      const { default_branch: _branch, ...company } = projection.company;
      const { organization_kind: _kind, ...withoutKind } = projection;
      const cases = [
        {
          name: "projection drift",
          legacy: JSON.stringify({ ...projection, company }),
          resolution: {
            state: "projection_drift",
            issues: ["legacy_projection_drift"],
          },
        },
        {
          // Absent organization_kind defaults to organization upstream: a
          // repairable drift of the projection, never a conflict.
          name: "absent organization_kind",
          legacy: JSON.stringify(withoutKind),
          resolution: {
            state: "projection_drift",
            issues: ["legacy_projection_drift"],
          },
        },
        {
          // Parseable but structurally invalid projection: normalized before any
          // state is assigned, so it is a conflict with the upstream issue codes.
          name: "structurally invalid projection",
          legacy: JSON.stringify({}),
          resolution: {
            state: "conflict",
            issues: [
              "legacy_manifest_schema_unsupported",
              "legacy_organization_identity_invalid",
            ],
          },
        },
        {
          name: "semantic conflict",
          legacy: JSON.stringify({
            ...projection,
            company: { ...projection.company, display_name: "Other" },
          }),
          resolution: {
            state: "conflict",
            issues: ["normalized_semantics_conflict"],
          },
        },
        {
          name: "malformed projection",
          legacy: "{ not json",
          resolution: {
            state: "conflict",
            issues: ["legacy_document_unreadable"],
          },
        },
      ] as const;
      const refused = async (workspaceInspectable: boolean) => {
        for (const item of cases) {
          await writeFile(join(root, "company.gen3.json"), item.legacy);
          const executable = await readOrganizationApplications(root, {
            admission: "executable",
          });
          expect(executable).toEqual(
            item.resolution.state === "conflict"
              ? { kind: "organization-conflict", resolution: item.resolution }
              : {
                  kind: "organization-not-executable",
                  resolution: item.resolution,
                },
          );
          expect(executable).not.toHaveProperty("entries");
          await expect(
            resolveOrganizationApplication(root, selection),
          ).rejects.toThrow("Selected Organization unavailable");
          const inspection = await readOrganizationApplications(root);
          if (item.resolution.state === "conflict")
            expect(inspection).toEqual(executable);
          else
            expect(inspection).toMatchObject({
              kind: "applications-observed",
              admission: "inspection-only",
              resolution: item.resolution,
              entries: [
                {
                  kind: workspaceInspectable
                    ? "module-observed"
                    : "module-unavailable",
                },
              ],
            });
        }
      };
      await refused(true);
      // Executable results are identical when descendants cannot be inspected
      // at all: the refusal happens before any child is touched.
      await rm(join(root, "workspace"), { recursive: true });
      await symlink("/nonexistent-workspace-fixture", join(root, "workspace"));
      await refused(false);
      await rm(join(root, "company.gen3.json"));
      // A canonical edit without regenerated digest is stale, not `current`.
      await writeFile(
        join(root, "lazurio.organization.json"),
        JSON.stringify({
          ...document,
          organization: { ...document.organization, display_name: "Edited" },
        }),
      );
      const stale = {
        kind: "organization-conflict",
        resolution: {
          state: "conflict",
          issues: ["canonical_projection_hash_invalid"],
        },
      } as const;
      expect(await readOrganizationApplications(root)).toEqual(stale);
      await expect(
        resolveOrganizationApplication(root, selection),
      ).rejects.toThrow("Selected Organization unavailable");
      await writeFile(
        join(root, "lazurio.organization.json"),
        JSON.stringify(document),
      );
      await rm(join(root, "modules.manifest.json"));
      expect(await readOrganizationApplications(root)).toEqual({
        kind: "organization-conflict",
        resolution: { state: "conflict", issues: ["modules_manifest_missing"] },
      });
      await expect(
        resolveOrganizationApplication(root, selection),
      ).rejects.toThrow("Selected Organization unavailable");
    });
  },
);

posixTest(
  "lifecycle admission refuses non-executable and unresolvable roots before lock, preparation, script start or any write",
  async () => {
    await fixture(async (root, inventory) => {
      const appDirectory = join(root, "workspace/web/app");
      const document = declared(verified, inventory);
      await writeFile(
        join(root, "lazurio.organization.json"),
        JSON.stringify(document),
      );
      const projection = expectedLegacyProjection(document, inventory)
        .projection as Record<string, unknown> & {
        company: Record<string, unknown>;
      };
      const packagePath = join(appDirectory, "package.json");
      const pkg = JSON.parse(await readFile(packagePath, "utf8"));
      pkg.packageManager = `bun@${Bun.version}`;
      pkg.dependencies = { "fixture-dependency": "file:./dependency" };
      await mkdir(join(appDirectory, "dependency"));
      await writeFile(
        join(appDirectory, "dependency/package.json"),
        JSON.stringify({ name: "fixture-dependency", version: "1.0.0" }),
      );
      pkg.scripts = {
        dev: "bun run touch.ts started",
        prepare: "bun run touch.ts prepared",
        check: "bun run touch.ts checked",
      };
      pkg.lazurio.preparation = {
        schema_version: "lazurio.preparation.v1",
        owner_package: "app/package.json",
        prepare_script: "prepare",
        check_script: "check",
      };
      await writeFile(packagePath, JSON.stringify(pkg));
      await writeFile(
        join(appDirectory, "touch.ts"),
        'await Bun.write("marker-".concat(process.argv[2]), "executed");',
      );
      const home = join(root, "home");
      await mkdir(home, { mode: 0o700 });
      const env = { HOME: home, PATH: "/usr/bin:/bin" };
      // The guarded install/prepare processes need the real Platform executable.
      const platformExecutable = join(root, "platform-cli");
      const build = Bun.spawn(
        [
          process.execPath,
          "build",
          "src/cli.ts",
          "--compile",
          "--no-compile-autoload-dotenv",
          "--no-compile-autoload-bunfig",
          "--outfile",
          platformExecutable,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      expect(await build.exited).toBe(0);
      const install = Bun.spawn(
        [process.execPath, "install", "--lockfile-only"],
        { cwd: appDirectory, env, stdout: "pipe", stderr: "pipe" },
      );
      expect(await install.exited).toBe(0);
      const snapshot = async () =>
        JSON.stringify([
          (await readdir(appDirectory)).sort(),
          (await readdir(join(root, "workspace/web"))).sort(),
          (await readdir(root)).sort(),
        ]);
      const lifecycles: ReturnType<typeof createApplicationLifecycle>[] = [];
      try {
        for (const [name, legacy] of [
          ["projection drift", JSON.stringify({ ...projection, company: {} })],
          [
            "semantic conflict",
            JSON.stringify({
              ...projection,
              company: { ...projection.company, display_name: "Other" },
            }),
          ],
          ["malformed projection", "{ not json"],
        ] as const) {
          const { default_branch: _branch, ...company } = projection.company;
          await writeFile(
            join(root, "company.gen3.json"),
            name === "projection drift"
              ? JSON.stringify({ ...projection, company })
              : legacy,
          );
          const expectedState =
            name === "projection drift" ? "projection_drift" : "conflict";
          expect(
            await readOrganizationApplications(root, {
              admission: "executable",
            }),
          ).toMatchObject({ resolution: { state: expectedState } });
          const before = await snapshot();
          const lifecycle = createApplicationLifecycle(
            localApplicationAdapters({
              organizationDirectory: root,
              bunExecutable: process.execPath,
              platformExecutable,
              environment: env,
              runner: createSessionRunner(platformExecutable),
            }),
          );
          lifecycles.push(lifecycle);
          expect(await lifecycle.prepare(selection)).toEqual({
            kind: "denied",
          });
          expect(await lifecycle.prepare(selection, "clean-prepare")).toEqual({
            kind: "denied",
          });
          expect(await lifecycle.start(selection)).toEqual({ kind: "denied" });
          // Nothing was prepared, started or written, and no owner lock was
          // taken: an independent owner can still acquire the app directory.
          expect(await snapshot()).toBe(before);
          const competitor = createOwnerOperations();
          try {
            expect(await competitor.run(appDirectory, async () => "free")).toBe(
              "free",
            );
          } finally {
            await competitor.close();
          }
        }
        // Resolver unavailable (no Organization documents observable) refuses too.
        const absent = createApplicationLifecycle(
          localApplicationAdapters({
            organizationDirectory: join(root, "absent"),
            bunExecutable: process.execPath,
            platformExecutable,
            environment: env,
            runner: createSessionRunner(platformExecutable),
          }),
        );
        lifecycles.push(absent);
        expect(await absent.prepare(selection)).toEqual({ kind: "denied" });
        expect(await absent.start(selection)).toEqual({ kind: "denied" });
        // The same lifecycle over the same declarations passes admission once
        // the projection is the exact generated one: the gate was the refusal.
        await writeFile(
          join(root, "company.gen3.json"),
          JSON.stringify(projection),
        );
        const admitted = createApplicationLifecycle(
          localApplicationAdapters({
            organizationDirectory: root,
            bunExecutable: process.execPath,
            platformExecutable,
            environment: env,
            runner: createSessionRunner(platformExecutable),
          }),
        );
        lifecycles.push(admitted);
        expect(await admitted.prepare(selection)).toEqual({ kind: "prepared" });
        expect(
          await readFile(join(appDirectory, "marker-prepared"), "utf8"),
        ).toBe("executed");
      } finally {
        for (const lifecycle of lifecycles) await lifecycle.close();
      }
    });
  },
  30_000,
);

posixTest(
  "template roots are observable declarations but never executable Organization selections",
  async () => {
    await fixture(async (root, inventory) => {
      expect(await resolveOrganizationApplication(root, selection)).toEqual({
        moduleDirectory: join(root, "workspace/web"),
      });
      await rm(join(root, "company.gen3.json"));
      await writeFile(
        join(root, "lazurio.organization.json"),
        JSON.stringify(declared({ ...canonical, kind: "template" }, inventory)),
      );
      const before = await readFile(
        join(root, "workspace/web/app/package.json"),
      );
      const template = {
        kind: "template-not-runtime",
        resolution: { state: "current", issues: [] },
      } as const;
      expect(await readOrganizationApplications(root)).toEqual(template);
      await expect(
        resolveOrganizationApplication(root, selection),
      ).rejects.toThrow("Selected Organization unavailable");
      expect(
        await readFile(join(root, "workspace/web/app/package.json")),
      ).toEqual(before);
      // A template result must not depend on inspecting its module descendants.
      await rm(join(root, "workspace"), { recursive: true });
      await symlink("/nonexistent-template-fixture", join(root, "workspace"));
      expect(await readOrganizationApplications(root)).toEqual(template);
    });
  },
);

posixTest(
  "conflicted slots are quarantined, missing siblings do not hide healthy modules, and runtime failure is not readiness",
  async () => {
    await fixture(async (root, inventory) => {
      inventory.module_slots.push({
        path: "workspace/missing",
        slug: "missing",
      });
      await writeInventory(root, inventory);
      const result = await readOrganizationApplications(root);
      expect(result).toMatchObject({
        kind: "applications-observed",
        entries: [{ kind: "module-observed" }, { kind: "module-unavailable" }],
      });
      await writeFile(join(root, "workspace/web/app/package.json"), "{}");
      expect(await readOrganizationApplications(root)).toMatchObject({
        entries: [
          { apps: [{ kind: "invalid-runtime" }] },
          { kind: "module-unavailable" },
        ],
      });
      inventory.module_slots.push({
        path: "workspace/web",
        slug: "conflicting",
      });
      await writeInventory(root, inventory);
      expect(await readOrganizationApplications(root)).toMatchObject({
        entries: [
          { kind: "declaration-conflict" },
          { kind: "module-unavailable" },
          { kind: "declaration-conflict" },
        ],
      });
    });
  },
);

posixTest(
  "foreign module identities and linked parents are refused without following another tree",
  async () => {
    await fixture(async (root) => {
      const path = join(root, "workspace/web/lazurio.module.json");
      const manifest = JSON.parse(await readFile(path, "utf8"));
      await writeFile(path, JSON.stringify({ ...manifest, company: "other" }));
      expect(await readOrganizationApplications(root)).toMatchObject({
        entries: [{ kind: "module-unavailable" }],
      });
      await rm(join(root, "workspace"), { recursive: true });
      await symlink("/nonexistent-workspace-fixture", join(root, "workspace"));
      expect(await readOrganizationApplications(root)).toMatchObject({
        entries: [{ kind: "module-unavailable" }],
      });
    });
  },
);

posixTest(
  "compiled CLI exposes canonical local observation and refuses missing canonical state",
  async () => {
    await fixture(async (root, inventory) => {
      const executable = join(root, "fixture-cli");
      const build = Bun.spawn(
        [
          process.execPath,
          "build",
          "src/cli.ts",
          "--compile",
          "--no-compile-autoload-dotenv",
          "--no-compile-autoload-bunfig",
          "--outfile",
          executable,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      expect(await build.exited).toBe(0);
      const run = async () => {
        const child = Bun.spawn(
          [executable, "organization-inspect", "--directory", root],
          { env: { PATH: "/usr/bin:/bin" }, stdout: "pipe", stderr: "pipe" },
        );
        return {
          code: await child.exited,
          value: JSON.parse(await new Response(child.stdout).text()),
        };
      };
      expect(await run()).toMatchObject({
        code: 0,
        value: { kind: "applications-observed" },
      });
      await rm(join(root, "company.gen3.json"));
      await writeFile(
        join(root, "lazurio.organization.json"),
        JSON.stringify(declared({ ...canonical, kind: "template" }, inventory)),
      );
      expect(await run()).toEqual({
        code: 2,
        value: {
          kind: "template-not-runtime",
          resolution: { state: "current", issues: [] },
        },
      });
      await rm(join(root, "lazurio.organization.json"));
      expect(await run()).toEqual({
        code: 2,
        value: {
          kind: "canonical-documents-required",
          resolution: { state: "missing", issues: [] },
        },
      });
    });
  },
);

// Service-owned applications over the REAL local composition (root admission,
// preparation binding, retained owner lock, coordination lock) and an in-memory
// service manager that outlives every lifecycle instance, like the real one.
async function serviceFixture(
  run: (context: {
    root: string;
    appDirectory: string;
    lockFile: string;
    manager: ReturnType<typeof createFakeServiceManager>;
    owner: (options?: {
      cleanup?: "closed" | "incomplete";
    }) => ReturnType<typeof createApplicationLifecycle>;
    // The pure CLI path: no Launchpad, no toolchain, no preparation binding.
    direct: () => ReturnType<typeof createApplicationLifecycle>;
  }) => Promise<void>,
) {
  await fixture(async (root) => {
    const runtime = await realpath(
      await mkdtemp(join(tmpdir(), "application-coordination-")),
    );
    try {
      const appDirectory = join(root, "workspace/web/app");
      const packagePath = join(appDirectory, "package.json");
      const pkg = JSON.parse(await readFile(packagePath, "utf8"));
      pkg.packageManager = `bun@${Bun.version}`;
      pkg.dependencies = { "fixture-dependency": "file:./dependency" };
      await mkdir(join(appDirectory, "dependency"));
      await writeFile(
        join(appDirectory, "dependency/package.json"),
        JSON.stringify({ name: "fixture-dependency", version: "1.0.0" }),
      );
      pkg.scripts.check = "must not execute in this coordination test";
      pkg.lazurio.preparation = {
        schema_version: "lazurio.preparation.v1",
        owner_package: "app/package.json",
        check_script: "check",
      };
      await writeFile(packagePath, JSON.stringify(pkg));
      const env = { HOME: root, PATH: "/usr/bin:/bin" };
      const install = Bun.spawn(
        [process.execPath, "install", "--lockfile-only"],
        { cwd: appDirectory, env, stdout: "pipe", stderr: "pipe" },
      );
      expect(await install.exited).toBe(0);
      const manager = createFakeServiceManager({ runtimeDirectory: runtime });
      const lockFile = applicationCoordinationLockFile(runtime, root);
      const runner = () =>
        createSystemdUserRunner({
          organizationDirectory: root,
          runtimeDirectory: runtime,
          run: manager.run,
          controlGroupEmpty: manager.controlGroupEmpty,
          observeBindings: async () => ({ kind: "observed", bindings: [] }),
        });
      const direct = () =>
        createApplicationLifecycle(
          serviceApplicationAdapters({
            organizationDirectory: root,
            runner: runner(),
            coordination: createApplicationCoordination({
              lockFile,
              timeoutMs: 200,
            }),
          }),
        );
      const owner = (options: { cleanup?: "closed" | "incomplete" } = {}) => {
        const local = localApplicationAdapters({
          organizationDirectory: root,
          bunExecutable: process.execPath,
          platformExecutable: process.execPath,
          environment: env,
          runner: runner(),
          coordination: createApplicationCoordination({
            lockFile,
            timeoutMs: 200,
          }),
        });
        if (!local.coordinateMutation) throw new Error("Expected coordinator");
        const preparation = async () => ({
          run: async () => ({ kind: "prepared" as const }),
          close: async () => ({ kind: options.cleanup ?? ("closed" as const) }),
        });
        // Real admission and real exclusion; no script or install is executed.
        return createApplicationLifecycle({
          runner: local.runner,
          authorize: local.authorize,
          coordinateMutation: local.coordinateMutation,
          prepareLaunch: async (_plan, cwd) => ({
            executable: process.execPath,
            args: ["run", "dev"],
            cwd,
            env: { PATH: "/usr/bin:/bin" },
          }),
          preflightPreparation: preparation,
        });
      };
      await run({ root, appDirectory, lockFile, manager, owner, direct });
    } finally {
      await rm(runtime, { recursive: true, force: true });
    }
  });
}
const serviceSelection = {
  company: "fixture",
  module: "web",
  package: "app/package.json",
};

posixTest(
  "an owner killed while holding the coordination lock never blocks the next owner",
  async () => {
    await serviceFixture(async ({ appDirectory, lockFile, manager, owner }) => {
      const first = owner();
      expect(await first.start(serviceSelection)).toEqual({ kind: "started" });
      // Application operations leave no owner record on the dependency tree.
      expect(await readdir(appDirectory)).not.toContain(".operation-lock");
      // Another process is inside a coordinated operation and never finishes it.
      const holder = Bun.spawn(
        [
          process.execPath,
          "-e",
          `import {createApplicationCoordination} from ${JSON.stringify(resolve("src/modules/application-coordination.ts"))};
           await createApplicationCoordination({ lockFile: ${JSON.stringify(lockFile)} }).run(async () => {
             console.log("held");
             await new Promise(() => {});
           });`,
        ],
        { env: {}, stdout: "pipe", stderr: "ignore" },
      );
      const reader = holder.stdout.getReader();
      let output = "";
      while (!output.includes("held")) {
        const chunk = await reader.read();
        if (chunk.done) break;
        output += new TextDecoder().decode(chunk.value);
      }
      expect(output).toContain("held");
      // While that process lives, the exclusion is real, bounded and typed...
      expect(await first.stop(serviceSelection)).toEqual({
        kind: "coordination-busy",
      });
      // ...and reading never needs it.
      expect(await first.status(serviceSelection)).toMatchObject({
        kind: "status",
        state: "running",
      });
      expect(manager.units.size).toBe(1);
      holder.kill("SIGKILL");
      await holder.exited;
      // A NEW owner, no recovery step: stop and start simply work.
      const second = owner();
      expect(await second.stop(serviceSelection)).toEqual({
        kind: "group-stopped",
      });
      expect(await second.start(serviceSelection)).toEqual({ kind: "started" });
      expect(await second.stop(serviceSelection)).toEqual({
        kind: "group-stopped",
      });
      expect(await readdir(appDirectory)).not.toContain(".operation-lock");
      expect((await readFile(lockFile)).byteLength).toBe(0);
      expect(await first.close()).toEqual({ kind: "closed" });
      expect(await second.close()).toEqual({ kind: "closed" });
    });
  },
  30_000,
);

posixTest(
  "a preparation that died still requires explicit recovery, but never blocks stop or status",
  async () => {
    await serviceFixture(async ({ appDirectory, manager, owner }) => {
      const first = owner();
      expect(await first.start(serviceSelection)).toEqual({ kind: "started" });
      expect(await first.close()).toEqual({ kind: "closed" });
      // A dependency transaction whose owner dies mid-way keeps its record.
      const dying = Bun.spawn(
        [
          process.execPath,
          "-e",
          `import {createOwnerOperations} from ${JSON.stringify(resolve("src/modules/owner-operations.ts"))};
           await createOwnerOperations().run(${JSON.stringify(appDirectory)}, async () => process.exit(23));`,
        ],
        { env: {}, stdout: "ignore", stderr: "ignore" },
      );
      expect(await dying.exited).toBe(23);
      expect(await readdir(appDirectory)).toContain(".operation-lock");
      const second = owner();
      expect(await second.status(serviceSelection)).toMatchObject({
        kind: "status",
        state: "running",
      });
      expect(await second.stop(serviceSelection)).toEqual({
        kind: "group-stopped",
      });
      // Owner death never authorizes a new writer, nor an application start on a
      // tree that may be half-installed.
      expect(await second.prepare(serviceSelection)).toEqual({
        kind: "preparation-recovery-required",
      });
      expect(await second.start(serviceSelection)).toEqual({
        kind: "preparation-recovery-required",
      });
      expect(manager.units.size).toBe(0);
      expect(await readdir(appDirectory)).toContain(".operation-lock");
      // Explicit operator recovery, outside the product.
      await rmdir(join(appDirectory, ".operation-lock"));
      expect(await second.start(serviceSelection)).toEqual({ kind: "started" });
      expect(await second.prepare(serviceSelection)).toEqual({
        kind: "application-running",
      });
      expect(await readdir(appDirectory)).not.toContain(".operation-lock");
      expect(await second.stop(serviceSelection)).toEqual({
        kind: "group-stopped",
      });
      // A completed transaction with confirmed cleanup releases its record...
      expect(await second.prepare(serviceSelection)).toEqual({
        kind: "prepared",
      });
      expect(await readdir(appDirectory)).not.toContain(".operation-lock");
      const competitor = createOwnerOperations();
      expect(await competitor.run(appDirectory, async () => "entered")).toBe(
        "entered",
      );
      await competitor.close();
      // ...while unconfirmed cleanup keeps it, for this owner and everyone else.
      const unconfirmed = owner({ cleanup: "incomplete" });
      expect(await unconfirmed.prepare(serviceSelection)).toEqual({
        kind: "preparation-cleanup-required",
      });
      expect(await readdir(appDirectory)).toContain(".operation-lock");
      expect(await second.start(serviceSelection)).toEqual({
        kind: "preparation-recovery-required",
      });
      expect(await unconfirmed.start(serviceSelection)).toEqual({
        kind: "preparation-cleanup-required",
      });
      expect(await second.close()).toEqual({ kind: "closed" });
    });
  },
  30_000,
);

posixTest(
  "session composition keeps the retained owner lock and refuses a coordination lock",
  async () => {
    await fixture(async (root) => {
      expect(() =>
        localApplicationAdapters({
          organizationDirectory: root,
          bunExecutable: process.execPath,
          platformExecutable: process.execPath,
          environment: { HOME: root, PATH: "/usr/bin:/bin" },
          runner: createSessionRunner(process.execPath),
          coordination: createApplicationCoordination({
            lockFile: join(root, "coordination.lock"),
          }),
        }),
      ).toThrow("owner-surviving");
    });
  },
);

posixTest(
  "status and stop work without a Launchpad for service-owned applications only",
  async () => {
    await serviceFixture(async ({ root, manager, owner, direct }) => {
      const launchpad = owner();
      expect(await launchpad.start(serviceSelection)).toEqual({
        kind: "started",
      });
      expect(await launchpad.close()).toEqual({ kind: "closed" });
      const cli = direct();
      expect(await cli.status(serviceSelection)).toMatchObject({
        kind: "status",
        runner: "systemd-user",
        state: "running",
      });
      // Same admission as everywhere else; nothing can be launched or prepared.
      expect(
        await cli.status({ ...serviceSelection, module: "unknown" }),
      ).toEqual({ kind: "denied" });
      await expect(cli.start(serviceSelection)).rejects.toThrow("directly");
      await expect(cli.prepare(serviceSelection)).rejects.toThrow("directly");
      expect(manager.units.size).toBe(1);
      expect(await cli.stop(serviceSelection)).toEqual({
        kind: "group-stopped",
      });
      expect(await cli.stop(serviceSelection)).toEqual({ kind: "not-managed" });
      expect(await cli.close()).toEqual({ kind: "closed" });
      expect(() =>
        serviceApplicationAdapters({
          organizationDirectory: root,
          runner: createSessionRunner(process.execPath),
          coordination: createApplicationCoordination({
            lockFile: join(root, "unused.lock"),
          }),
        }),
      ).toThrow("Launchpad");
    });
  },
  30_000,
);
