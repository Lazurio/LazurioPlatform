import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  lstat,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { initializeFolder } from "../src/folder/initialize-folder";
import { executionOs } from "../src/folder/platform";
import { startLaunchpad } from "../src/launchpad/server";
import { runModuleCommand } from "../src/modules/module-cli";
import {
  createModuleOperations,
  type ModuleHost,
} from "../src/modules/module-operations";
import { createSessionRunner } from "../src/modules/session-runner";
import { runCatalogCommand } from "../src/organizations/cli";
import type { CliContext } from "../src/update/cli";
import { writeOrganization } from "./fixtures/catalog-folder";
import { createFakeServiceManager } from "./fixtures/fake-service-manager";
import {
  compilePlatform,
  linuxHost,
  runnable,
  undeclaredModule,
} from "./fixtures/module-host";
import {
  mkdirOwnedFixture as mkdir,
  writeOwnedFixture as writeFile,
} from "./fixtures/owned-files";

// The default preparation of issue #97 (decision F25) through its consumers:
// `lazurio module list`, `lazurio module start|status|stop`, the gateway's
// `ensure` and the Launchpad's module routes. A module whose application
// package declares no `lazurio.preparation`, as every real application
// package of the replaced Launchpad, starts after a frozen install from the
// lockfile beside its package; what cannot start for a reason known without
// running anything is not executable in the list, with the same typed reason
// the start answers. The explicit declaration keeps its meaning: the start
// runs its declared check and installs nothing. HOME is a temporary
// directory; the only dependencies are local `file:` packages, so nothing
// needs the network.
const supported = ["darwin", "linux"].includes(process.platform);
const posixTest = test.skipIf(!supported);
let root = "";
let binary = "";
beforeAll(async () => {
  if (!supported) return;
  root = await realpath(await mkdtemp(join(tmpdir(), "default-preparation-")));
  binary = join(root, "platform");
  await compilePlatform(binary);
});
afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

function cliContext(home: string): CliContext {
  return {
    identity: { version: "1.0.0", commit: "0".repeat(40), target: "fixture" },
    platform: process.platform,
    env: { HOME: home },
    executable: join(home, "lazurio"),
    hostedFolder: async () => undefined,
  };
}

// The modules of Organization delta (a `transition` root):
// - ledger: undeclared, its node_modules older than its checkout;
// - notes: the explicit declaration, with a start check that passes;
// - drafts: undeclared, without a lockfile beside its package.
const modules = ["ledger", "notes", "drafts"] as const;

type World = Readonly<{
  folder: string;
  organization: string;
  home: string;
  app: (module: string) => string;
  ports: Readonly<Record<string, number>>;
  manager: ReturnType<typeof createFakeServiceManager>;
  host: (module: string) => ModuleHost;
  list: () => Promise<Record<string, Record<string, unknown>>>;
  run: (
    verb: "start" | "status" | "stop" | "logs",
    module: string,
    app?: string,
  ) => Promise<Record<string, unknown>>;
  ensure: (module: string) => Promise<Record<string, unknown>>;
}>;

async function world(
  name: string,
  more: { id: string; lockfile?: boolean }[],
  body: (world: World) => Promise<void>,
) {
  const parent = await realpath(await mkdtemp(join(root, `${name}-`)));
  try {
    const folder = join(parent, "Lazurio");
    await initializeFolder(folder, {
      os: executionOs(process.platform),
      access: "local",
      purpose: "human",
      locale: "en",
      detail: "concise",
      coordination: "direct",
    });
    const organization = await writeOrganization(folder, "delta", {
      slug: "delta",
      state: "transition",
      modules: [
        { id: "ledger" },
        { id: "notes" },
        { id: "drafts", lockfile: false },
        ...more,
      ],
    });
    const home = join(parent, "home");
    await mkdir(home);
    const module = (id: string) => join(organization, "workspace", id);
    const ports: Record<string, number> = {
      ledger: await undeclaredModule(module("ledger"), home, { stale: true }),
      notes: await runnable(folder, "delta", "notes"),
    };
    for (const id of ["drafts", ...more.map((entry) => entry.id)])
      ports[id] = JSON.parse(
        await readFile(join(module(id), "lazurio.module.json"), "utf8"),
      ).port_leases[0].port;
    const manager = createFakeServiceManager({
      runtimeDirectory: join(parent, "runtime"),
    });
    await mkdir(manager.runtimeDirectory);
    const host = (id: string) =>
      linuxHost(manager, home, ports[id] as number, binary);
    const context = cliContext(home);
    await body({
      folder,
      organization,
      home,
      app: (id) => join(module(id), "app"),
      ports,
      manager,
      host,
      list: async () => {
        const result = await runCatalogCommand(
          ["module", "list", "delta", "--folder", folder, "--json"],
          context,
        );
        const rows = (result.result as { modules: Record<string, unknown>[] })
          .modules;
        return Object.fromEntries(rows.map((row) => [row.module, row]));
      },
      run: async (verb, id, app) =>
        (
          await runModuleCommand(
            [
              "module",
              verb,
              `delta/${id}`,
              "--folder",
              folder,
              "--json",
              ...(app === undefined ? [] : ["--app", app]),
            ],
            context,
            host(id),
          )
        ).result as Record<string, unknown>,
      ensure: async (id) => {
        const operations = createModuleOperations({
          folder,
          owner: "launchpad",
          host: host(id),
        });
        try {
          return (await operations.ensure(id, {
            mayStart: true,
            waitMs: 20_000,
            pollMs: 10,
          })) as Record<string, unknown>;
        } finally {
          await operations.close();
        }
      },
    });
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

const installed = async (app: string) =>
  JSON.parse(
    await readFile(
      join(app, "node_modules/fixture-dependency/package.json"),
      "utf8",
    ),
  ).version;

posixTest(
  "an undeclared module is executable and its start repairs a stale install from its lockfile; one without a lockfile is not executable and every operation names why; the explicit declaration is unchanged",
  async () => {
    await world("journey", [], async (world) => {
      const where = (module: string) => ({ organization: "delta", module });
      const rows = await world.list();
      expect(Object.keys(rows)).toEqual([...modules]);
      expect(rows.ledger).toMatchObject({ executable: true });
      expect(rows.ledger).not.toHaveProperty("reason");
      expect(rows.notes).toMatchObject({ executable: true });
      expect(rows.drafts).toMatchObject({
        executable: false,
        reason: "preparation-lockfile-missing",
        file: "app/package.json",
      });

      // ledger: the start installs from the lockfile, then starts.
      const ledger = world.app("ledger");
      const pkg = await readFile(join(ledger, "package.json"), "utf8");
      const lock = await readFile(join(ledger, "bun.lock"), "utf8");
      expect(await installed(ledger)).toBe("1.0.0");
      expect(await world.run("start", "ledger")).toMatchObject({
        kind: "module",
        operation: "start",
        ...where("ledger"),
        app: "app/package.json",
        outcome: "started",
        healthy: true,
      });
      expect(await installed(ledger)).toBe("2.0.0");
      expect(await readFile(join(ledger, "package.json"), "utf8")).toBe(pkg);
      expect(await readFile(join(ledger, "bun.lock"), "utf8")).toBe(lock);
      expect(await world.run("status", "ledger")).toMatchObject({
        kind: "module",
        operation: "status",
        state: "running",
        healthy: true,
      });
      expect(await world.run("stop", "ledger")).toMatchObject({
        outcome: "group-stopped",
      });
      // The gateway's ensure takes the same path.
      expect(await world.ensure("ledger")).toMatchObject({
        kind: "module",
        operation: "ensure",
        ...where("ledger"),
        healthy: true,
      });
      expect(await world.run("stop", "ledger")).toMatchObject({
        outcome: "group-stopped",
      });
      const units = world.manager.commands("systemd-run").length;
      expect(units).toBe(2);

      // drafts: its start refused before any effect, with the list's reason
      // and file.
      const refused = {
        reason: "preparation-lockfile-missing",
        ...where("drafts"),
        file: "app/package.json",
      };
      expect(await world.run("start", "drafts")).toEqual({
        kind: "blocked",
        operation: "start",
        ...refused,
      });
      // Reading the state never depends on the preparation.
      expect(await world.run("status", "drafts")).toMatchObject({
        kind: "module",
        operation: "status",
        state: "stopped",
      });
      expect(await world.ensure("drafts")).toEqual({
        kind: "blocked",
        operation: "ensure",
        ...refused,
      });
      await expect(
        lstat(join(world.app("drafts"), "node_modules")),
      ).rejects.toThrow();
      // The terminal names the reason, the file and what to do.
      const [line, explanation] = (
        await runModuleCommand(
          ["module", "start", "delta/drafts", "--folder", world.folder],
          cliContext(world.home),
          world.host("drafts"),
        )
      ).text.split("\n");
      expect(line).toBe(
        "delta/drafts: preparation-lockfile-missing (app/package.json)",
      );
      expect(explanation).toContain("bun.lock");

      // notes: the explicit declaration's start runs its check and installs
      // nothing.
      expect(await world.run("start", "notes")).toMatchObject({
        kind: "module",
        outcome: "started",
        healthy: true,
      });
      await expect(
        lstat(join(world.app("notes"), "node_modules")),
      ).rejects.toThrow();
      expect(await world.run("stop", "notes")).toMatchObject({
        outcome: "group-stopped",
      });
      expect(world.manager.commands("systemd-run")).toHaveLength(units + 1);
    });
  },
  120_000,
);

// A variant of ledger: its application package changed as `change` says,
// with its own lockfile otherwise as the fixture wrote it.
async function variant(
  world: World,
  id: string,
  change: (pkg: Record<string, unknown>) => void,
) {
  await undeclaredModule(join(world.app(id), ".."), world.home);
  const path = join(world.app(id), "package.json");
  const pkg = JSON.parse(await readFile(path, "utf8"));
  change(pkg);
  await writeFile(path, JSON.stringify(pkg));
}

posixTest(
  "what is known without running anything is not executable in the list, with the reason the start answers; what only the start can know is refused by it with a typed reason, never operation-failed",
  async () => {
    const more = [
      "unsupported",
      "outside",
      "unchecked",
      "pinned",
      "unlocked",
    ].map((id) => ({ id }));
    await world("reasons", more, async (world) => {
      // packageManager names another package manager: the install authority
      // runs Bun only.
      await variant(world, "unsupported", (pkg) => {
        pkg.packageManager = "npm@10.0.0";
      });
      // A local dependency that leaves the Organization's checkout (from
      // workspace/outside/app, four levels up is organizations/).
      await variant(world, "outside", (pkg) => {
        pkg.dependencies = { "fixture-shared": "file:../../../../shared" };
      });
      // The explicit declaration names a check script the package lacks.
      await variant(world, "unchecked", (pkg) => {
        (pkg.lazurio as Record<string, unknown>).preparation = {
          schema_version: "lazurio.preparation.v1",
          owner_package: "app/package.json",
          check_script: "check",
        };
      });
      // An exact Bun the Machine's Bun is not.
      await variant(world, "pinned", (pkg) => {
        pkg.packageManager = "bun@0.0.1";
      });
      // A dependency added after the lockfile was written: the frozen
      // install refuses to change the lockfile.
      await variant(world, "unlocked", (pkg) => {
        pkg.dependencies = {
          ...(pkg.dependencies as Record<string, string>),
          "fixture-extra": "file:./dependency",
        };
      });
      const rows = await world.list();
      const known = {
        unsupported: "preparation-package-manager-unsupported",
        outside: "preparation-dependency-outside-owner",
        unchecked: "preparation-script-missing",
      };
      for (const [id, reason] of Object.entries(known)) {
        expect(rows[id]).toMatchObject({
          executable: false,
          reason,
          file: "app/package.json",
        });
        expect(await world.run("start", id)).toEqual({
          kind: "blocked",
          operation: "start",
          reason,
          organization: "delta",
          module: id,
          file: "app/package.json",
        });
      }
      const onlyTheStart = {
        pinned: ["preparation-toolchain-mismatch", "app/package.json"],
        unlocked: ["preparation-install-failed", "app/bun.lock"],
      };
      for (const [id, [reason, file]] of Object.entries(onlyTheStart)) {
        expect(rows[id]).toMatchObject({ executable: true });
        expect(await world.run("start", id)).toEqual({
          kind: "blocked",
          operation: "start",
          reason,
          organization: "delta",
          module: id,
          app: "app/package.json",
          file,
        });
      }
      expect(world.manager.commands("systemd-run")).toHaveLength(0);
    });
  },
  120_000,
);

posixTest(
  "the Launchpad's session start (macOS) installs the undeclared module's stale dependencies and the app serves the current one",
  async () => {
    await world("session", [], async (world) => {
      const host: ModuleHost = {
        platform: "darwin",
        home: world.home,
        path: "/usr/bin:/bin",
        runtimeDirectory: undefined,
        platformExecutable: binary,
        bunExecutable: process.execPath,
        runnerKind: async () => "session",
        createRunner: () => createSessionRunner(binary),
        readJournal: async () => {
          throw new Error("A session app has no journal");
        },
      };
      const app = await startLaunchpad(
        world.folder,
        undefined,
        undefined,
        undefined,
        {},
        undefined,
        {},
        undefined,
        host,
      );
      try {
        const url = new URL(app.url);
        const headers = {
          Origin: url.origin,
          Authorization: `Bearer ${url.hash.slice(1)}`,
        };
        const route = (verb: string) =>
          `${url.origin}/api/modules/delta/ledger/${verb}`;
        const started = await fetch(route("start"), {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: "{}",
        });
        expect(started.status).toBe(200);
        expect(await started.json()).toMatchObject({
          outcome: "started",
          runner: "session",
        });
        let status: Record<string, unknown> = {};
        for (let attempt = 0; attempt < 100 && !status.healthy; attempt++) {
          status = await (
            await fetch(route("status"), {
              headers: { Authorization: headers.Authorization },
            })
          ).json();
          if (!status.healthy) await Bun.sleep(100);
        }
        expect(status).toMatchObject({ state: "running", healthy: true });
        expect(
          await (await fetch(`http://127.0.0.1:${world.ports.ledger}/`)).text(),
        ).toBe("current");
        expect(await installed(world.app("ledger"))).toBe("2.0.0");
        // Without its lockfile the running app is still read and stopped;
        // only a start depends on its preparation.
        await rm(join(world.app("ledger"), "bun.lock"));
        const stopped = await fetch(route("stop"), {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: "{}",
        });
        expect(stopped.status).toBe(200);
        expect(await stopped.json()).toMatchObject({
          outcome: "group-stopped",
          state: "stopped",
        });
      } finally {
        expect(await app.close()).toEqual({ kind: "closed" });
      }
    });
  },
  120_000,
);

// An application of a module in the shape of the real ones that share a
// contracts package of the Organization's root repository: its package is
// `app/v3/package.json`, undeclared, depending on `reference`. Its lockfile
// is written while the dependency is the Organization's contracts package,
// then the reference is set.
async function contractsApplication(
  world: World,
  id: string,
  reference: string,
) {
  const module = join(world.organization, "workspace", id);
  const manifestPath = join(module, "lazurio.module.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.apps = ["app/v3/package.json"];
  manifest.default_app = "app/v3/package.json";
  await writeFile(manifestPath, JSON.stringify(manifest));
  const pkg = JSON.parse(
    await readFile(join(module, "app/package.json"), "utf8"),
  );
  await rm(join(module, "app/package.json"));
  await rm(join(module, "app/bun.lock"));
  const app = join(module, "app/v3");
  await mkdir(app);
  pkg.private = true;
  pkg.scripts = { dev: `"${process.execPath}" --no-env-file server.ts` };
  pkg.dependencies = {
    "@fixture/v1": "file:../../../../launchpad/contracts/v1",
  };
  await writeFile(join(app, "package.json"), JSON.stringify(pkg));
  await writeFile(
    join(app, "server.ts"),
    'import { contract } from "@fixture/v1"; Bun.serve({ hostname: process.env.LAZURIO_RUNTIME_LISTENER_WEB_HOST, port: Number(process.env.LAZURIO_RUNTIME_LISTENER_WEB_PORT), fetch: () => new Response(contract) });',
  );
  const install = Bun.spawn([process.execPath, "install", "--lockfile-only"], {
    cwd: app,
    env: { HOME: world.home, PATH: "/usr/bin:/bin" },
    stdout: "ignore",
    stderr: "pipe",
  });
  const [error, code] = await Promise.all([
    new Response(install.stderr).text(),
    install.exited,
  ]);
  expect(code, error).toBe(0);
  pkg.dependencies = { "@fixture/v1": reference };
  await writeFile(join(app, "package.json"), JSON.stringify(pkg));
  return app;
}

posixTest(
  "a local dependency in the same Organization checkout, outside the module's repository, is installed by the default preparation; one that leaves the Organization, passes a symlink or does not exist is refused by its reason",
  async () => {
    const more = ["orders", "leaving", "linked", "absent"].map((id) => ({
      id,
    }));
    await world("contracts", more, async (world) => {
      // The Organization root repository's contracts package.
      const contracts = join(world.organization, "launchpad/contracts/v1");
      await mkdir(contracts, { recursive: true });
      await writeFile(
        join(contracts, "package.json"),
        JSON.stringify({
          name: "@fixture/v1",
          version: "1.0.0",
          main: "index.js",
        }),
      );
      await writeFile(
        join(contracts, "index.js"),
        'export const contract = "contract-v1";\n',
      );
      await symlink(
        join(world.organization, "launchpad/contracts"),
        join(world.organization, "launchpad/linked"),
      );
      // A directory of the Folder beside the Organization, with a package.
      const beside = join(world.folder, "organizations/outside/v1");
      await mkdir(beside, { recursive: true });
      await writeFile(
        join(beside, "package.json"),
        JSON.stringify({ name: "@fixture/v1", version: "1.0.0" }),
      );
      const orders = await contractsApplication(
        world,
        "orders",
        "file:../../../../launchpad/contracts/v1",
      );
      await contractsApplication(
        world,
        "leaving",
        "file:../../../../../outside/v1",
      );
      await contractsApplication(
        world,
        "linked",
        "file:../../../../launchpad/linked/v1",
      );
      await contractsApplication(
        world,
        "absent",
        "file:../../../../launchpad/contracts/v9",
      );
      const rows = await world.list();
      expect(rows.orders).toMatchObject({
        executable: true,
        defaultApp: "app/v3/package.json",
      });
      expect(rows.orders).not.toHaveProperty("reason");
      const refused: Record<string, [string, string]> = {
        leaving: [
          "preparation-dependency-outside-owner",
          "app/v3/package.json",
        ],
        linked: ["directory-not-regular", "launchpad/linked"],
        absent: ["preparation-dependency-missing", "app/v3/package.json"],
      };
      for (const [id, [reason, file]] of Object.entries(refused)) {
        expect(rows[id]).toMatchObject({ executable: false, reason, file });
        expect(await world.run("start", id)).toEqual({
          kind: "blocked",
          operation: "start",
          reason,
          organization: "delta",
          module: id,
          file,
        });
        expect(await world.ensure(id)).toEqual({
          kind: "blocked",
          operation: "ensure",
          reason,
          organization: "delta",
          module: id,
          file,
        });
      }
      expect(world.manager.commands("systemd-run")).toHaveLength(0);

      // orders starts: the contracts package is installed from the
      // Organization's root repository, nothing of it is changed.
      const source = await readFile(join(contracts, "package.json"), "utf8");
      expect(await world.run("start", "orders")).toMatchObject({
        kind: "module",
        outcome: "started",
        healthy: true,
      });
      expect(
        JSON.parse(
          await readFile(
            join(orders, "node_modules/@fixture/v1/package.json"),
            "utf8",
          ),
        ).version,
      ).toBe("1.0.0");
      expect(await readFile(join(contracts, "package.json"), "utf8")).toBe(
        source,
      );
      expect(await world.run("stop", "orders")).toMatchObject({
        outcome: "group-stopped",
      });
      expect(await world.ensure("orders")).toMatchObject({
        kind: "module",
        operation: "ensure",
        healthy: true,
      });
      expect(await world.run("stop", "orders")).toMatchObject({
        outcome: "group-stopped",
      });
    });
  },
  120_000,
);

posixTest(
  "status, logs and stop of a running module do not depend on its preparation: after its lockfile is gone they work, and only a start or ensure is refused by the reason",
  async () => {
    await world("lockfile-gone", [], async (world) => {
      expect(await world.run("start", "ledger")).toMatchObject({
        outcome: "started",
        healthy: true,
      });
      await rm(join(world.app("ledger"), "bun.lock"));
      expect((await world.list()).ledger).toMatchObject({
        executable: false,
        reason: "preparation-lockfile-missing",
        file: "app/package.json",
        preparationRefused: true,
      });
      expect(await world.run("status", "ledger")).toMatchObject({
        kind: "module",
        operation: "status",
        state: "running",
        healthy: true,
      });
      expect(await world.run("logs", "ledger")).toMatchObject({
        kind: "module-logs",
        module: "ledger",
      });
      // The gateway still reaches the running app.
      expect(await world.ensure("ledger")).toMatchObject({
        kind: "module",
        operation: "ensure",
        healthy: true,
      });
      expect(await world.run("stop", "ledger")).toMatchObject({
        kind: "module",
        outcome: "group-stopped",
        state: "stopped",
      });
      const refused = {
        reason: "preparation-lockfile-missing",
        organization: "delta",
        module: "ledger",
        file: "app/package.json",
      };
      expect(await world.run("start", "ledger")).toEqual({
        kind: "blocked",
        operation: "start",
        ...refused,
      });
      expect(await world.ensure("ledger")).toEqual({
        kind: "blocked",
        operation: "ensure",
        ...refused,
      });
      expect(world.manager.commands("systemd-run")).toHaveLength(1);
    });
  },
  120_000,
);

// One declared application package of a module: its package.json with the
// runtime declaration of the module's fixture app, one local dependency and
// its own lockfile beside it.
async function applicationPackage(
  world: World,
  module: string,
  pkgPath: string,
  dependencies: Record<string, string> = {
    "fixture-dependency": "file:./dependency",
  },
) {
  const root = join(world.organization, "workspace", module);
  const runtime = JSON.parse(
    await readFile(join(root, "app/package.json"), "utf8").catch(async () =>
      readFile(join(root, ".fixture-runtime.json"), "utf8"),
    ),
  ).lazurio;
  await writeFile(
    join(root, ".fixture-runtime.json"),
    JSON.stringify({ lazurio: runtime }),
  );
  const directory = dirname(join(root, pkgPath));
  await mkdir(directory, { recursive: true });
  for (const reference of Object.values(dependencies)) {
    const target = join(directory, reference.slice("file:".length));
    await mkdir(target, { recursive: true });
    await writeFile(
      join(target, "package.json"),
      JSON.stringify({
        name: `fixture-${relative(root, target).replaceAll("/", "-")}`,
        version: "1.0.0",
      }),
    );
  }
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({
      name: `fixture-${module}-${relative(root, directory).replaceAll("/", "-") || "root"}`,
      private: true,
      dependencies,
      scripts: { dev: `"${process.execPath}" --no-env-file server.ts` },
      lazurio: runtime,
    }),
  );
  const install = Bun.spawn([process.execPath, "install", "--lockfile-only"], {
    cwd: directory,
    env: { HOME: world.home, PATH: "/usr/bin:/bin" },
    stdout: "ignore",
    stderr: "pipe",
  });
  const [error, code] = await Promise.all([
    new Response(install.stderr).text(),
    install.exited,
  ]);
  expect(code, error).toBe(0);
}

// The module's declared apps and default app.
async function declareApps(
  world: World,
  module: string,
  apps: string[],
  defaultApp: string,
) {
  const path = join(
    world.organization,
    "workspace",
    module,
    "lazurio.module.json",
  );
  const manifest = JSON.parse(await readFile(path, "utf8"));
  manifest.apps = apps;
  manifest.default_app = defaultApp;
  await writeFile(path, JSON.stringify(manifest));
}

posixTest(
  "application packages of one module that contain one another are refused by the default preparation; sibling packages, one with a local package inside it, start",
  async () => {
    const more = ["nested", "siblings"].map((id) => ({ id }));
    await world("overlap", more, async (world) => {
      // nested: an app at the module root and one under app/v2.
      await applicationPackage(world, "nested", "package.json");
      await applicationPackage(world, "nested", "app/v2/package.json");
      await rm(join(world.app("nested"), "package.json"));
      await rm(join(world.app("nested"), "bun.lock"));
      await declareApps(
        world,
        "nested",
        ["package.json", "app/v2/package.json"],
        "package.json",
      );
      // siblings: app/v1, app/v2, app/v3, the last with a local package in
      // its own directory, as the real modules have them.
      for (const version of ["v1", "v2"])
        await applicationPackage(
          world,
          "siblings",
          `app/${version}/package.json`,
        );
      await applicationPackage(world, "siblings", "app/v3/package.json", {
        "fixture-shared": "file:./packages/shared",
      });
      await rm(join(world.app("siblings"), "package.json"));
      await rm(join(world.app("siblings"), "bun.lock"));
      await declareApps(
        world,
        "siblings",
        ["app/v1/package.json", "app/v2/package.json", "app/v3/package.json"],
        "app/v3/package.json",
      );
      const rows = await world.list();
      expect(rows.nested).toMatchObject({
        executable: false,
        reason: "preparation-applications-overlap",
        file: "package.json",
      });
      expect(rows.siblings).toMatchObject({ executable: true });
      expect(rows.siblings).not.toHaveProperty("reason");
      expect(await world.run("start", "nested")).toEqual({
        kind: "blocked",
        operation: "start",
        reason: "preparation-applications-overlap",
        organization: "delta",
        module: "nested",
        file: "package.json",
      });
      // The nested app is refused too: its directory is inside another's.
      expect(await world.run("start", "nested", "app/v2/package.json")).toEqual(
        {
          kind: "blocked",
          operation: "start",
          reason: "preparation-applications-overlap",
          organization: "delta",
          module: "nested",
          app: "app/v2/package.json",
          file: "app/v2/package.json",
        },
      );
      expect(world.manager.commands("systemd-run")).toHaveLength(0);
      expect(await world.run("start", "siblings")).toMatchObject({
        kind: "module",
        app: "app/v3/package.json",
        outcome: "started",
      });
      expect(
        JSON.parse(
          await readFile(
            join(
              world.app("siblings"),
              "v3/node_modules/fixture-shared/package.json",
            ),
            "utf8",
          ),
        ).version,
      ).toBe("1.0.0");
      expect(await world.run("stop", "siblings")).toMatchObject({
        outcome: "group-stopped",
      });
    });
  },
  120_000,
);

posixTest(
  "the catalog applies the start's rules read-only: a symlinked lockfile or package manager configuration, a dangling symlink as a local dependency and a missing declared owner are not executable, with the start's reason and file",
  async () => {
    const more = ["linklock", "dangling", "ownerless", "npmrc"].map((id) => ({
      id,
    }));
    await world("read-only-rules", more, async (world) => {
      await variant(world, "linklock", () => {});
      const lock = join(world.app("linklock"), "bun.lock");
      await writeFile(join(world.home, "elsewhere.lock"), await readFile(lock));
      await rm(lock);
      await symlink(join(world.home, "elsewhere.lock"), lock);
      await variant(world, "dangling", (pkg) => {
        pkg.dependencies = { "fixture-dependency": "file:./dependency-link" };
      });
      await symlink(
        join(world.app("dangling"), "nowhere"),
        join(world.app("dangling"), "dependency-link"),
      );
      await variant(world, "ownerless", (pkg) => {
        (pkg.lazurio as Record<string, unknown>).preparation = {
          schema_version: "lazurio.preparation.v1",
          owner_package: "missing/package.json",
          check_script: "check",
        };
      });
      // The checkout's package manager configuration the install reads.
      await variant(world, "npmrc", () => {});
      await writeFile(join(world.home, "elsewhere.npmrc"), "");
      await symlink(
        join(world.home, "elsewhere.npmrc"),
        join(world.app("npmrc"), ".npmrc"),
      );
      const rows = await world.list();
      const expected: Record<string, [string, string]> = {
        linklock: ["declaration-not-regular", "app/bun.lock"],
        npmrc: ["declaration-not-regular", "app/.npmrc"],
        dangling: ["directory-not-regular", "app/dependency-link"],
        ownerless: ["preparation-owner-invalid", "missing/package.json"],
      };
      for (const [id, [reason, file]] of Object.entries(expected)) {
        expect(rows[id]).toMatchObject({ executable: false, reason, file });
        expect(await world.run("start", id)).toEqual({
          kind: "blocked",
          operation: "start",
          reason,
          organization: "delta",
          module: id,
          file,
        });
      }
      expect(world.manager.commands("systemd-run")).toHaveLength(0);
    });
  },
  120_000,
);
