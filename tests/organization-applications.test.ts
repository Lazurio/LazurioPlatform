import { expect, test } from "bun:test";
import {
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
import { initializeFolder } from "../src/folder/initialize-folder";
import { executionOs } from "../src/folder/platform";
import { startLaunchpad } from "../src/launchpad/server";
import { inspectPreparationBinding } from "../src/modules/preparation-binding";
import {
  readOrganizationApplications,
  resolveOrganizationApplication,
} from "../src/organizations/read-applications";
import { readCanonicalDocuments } from "../src/organizations/read-documents";

const posixTest = test.skipIf(!["darwin", "linux"].includes(process.platform));

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
        await writeFile(inventoryPath, JSON.stringify(inventory));
        expect(await request("status")).toEqual({ kind: "denied" });
        // A removed declaration does not remove the application or user's files.
        expect(await readFile(join(appDirectory, "user-work"), "utf8")).toBe(
          "keep my draft",
        );
      } finally {
        owner.kill("SIGTERM");
        expect(await owner.exited).toBe(0);
      }
    });
  },
  30_000,
);

posixTest(
  "local application selection is resolved afresh from declared inventory",
  async () => {
    await fixture(async (root, inventory) => {
      const selection = {
        company: "fixture",
        module: "web",
        package: "app/package.json",
      };
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
      await writeFile(
        join(root, "modules.manifest.json"),
        JSON.stringify(inventory),
      );
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
      const selection = {
        company: "fixture",
        module: "web",
        package: "app/package.json",
      };
      inventory.module_slots.push({ path: "workspace/web", slug: "web" });
      await writeFile(
        join(root, "modules.manifest.json"),
        JSON.stringify(inventory),
      );
      await expect(
        resolveOrganizationApplication(root, selection),
      ).rejects.toThrow();
      inventory.module_slots.pop();
      await writeFile(
        join(root, "modules.manifest.json"),
        JSON.stringify(inventory),
      );
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
        await rm(join(root, "lazurio.organization.json"));
        expect(await (await call("/api/apps/discover", {})).json()).toEqual({
          kind: "canonical-documents-required",
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
async function fixture(
  run: (
    root: string,
    inventory: {
      company: string;
      github_org: string;
      module_slots: { path: string; slug?: string }[];
    },
  ) => Promise<void>,
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
      JSON.stringify(canonical),
    );
    await writeFile(
      join(root, "modules.manifest.json"),
      JSON.stringify(inventory),
    );
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
  "canonical application inspection observes declared apps without executing, scanning DBs or reading legacy state",
  async () => {
    await fixture(async (root) => {
      // A hostile/unreadable legacy reference is irrelevant to canonical acquisition.
      await symlink(
        "/nonexistent-legacy-fixture",
        join(root, "company.gen3.json"),
      );
      expect(await readCanonicalDocuments(root)).not.toHaveProperty("legacy");
      const before = await readFile(
        join(root, "workspace/web/app/package.json"),
      );
      expect(await readOrganizationApplications(root)).toEqual({
        kind: "applications-observed",
        company: "fixture",
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
      });
      expect(
        await readFile(join(root, "workspace/web/app/package.json")),
      ).toEqual(before);
      await rm(join(root, "lazurio.organization.json"));
      expect(await readOrganizationApplications(root)).toEqual({
        kind: "canonical-documents-required",
      });
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
      await writeFile(
        join(root, "modules.manifest.json"),
        JSON.stringify(inventory),
      );
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
      await writeFile(
        join(root, "modules.manifest.json"),
        JSON.stringify(inventory),
      );
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
    await fixture(async (root) => {
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
      await rm(join(root, "lazurio.organization.json"));
      expect(await run()).toEqual({
        code: 2,
        value: { kind: "canonical-documents-required" },
      });
    });
  },
);
