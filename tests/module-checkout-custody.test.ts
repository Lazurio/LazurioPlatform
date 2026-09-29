import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import * as fsPromises from "node:fs/promises";
import {
  chmod,
  chown,
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
import { initializeFolder } from "../src/folder/initialize-folder";
import { executionOs } from "../src/folder/platform";
import { runModuleCommand } from "../src/modules/module-cli";
import { createModuleOperations } from "../src/modules/module-operations";
import { runCatalogCommand } from "../src/organizations/cli";
import type { CliContext } from "../src/update/cli";
import { writeOrganization } from "./fixtures/catalog-folder";
import { createFakeServiceManager } from "./fixtures/fake-service-manager";
import { compilePlatform, linuxHost, runnable } from "./fixtures/module-host";
import {
  mkdirOwnedFixture as mkdir,
  writeOwnedFixture as writeFile,
} from "./fixtures/owned-files";

// The checkout rule of decision F23 through its consumers: `lazurio module
// list`, `lazurio module start|status` and the gateway's `ensure` on one
// runnable module of a synthetic Organization, over the in-memory user
// manager. Accepted: permission bits (umask 022, 002, 000) and hard links of
// the operator's checkout. Refused, with the rule and the module-relative
// file instead of `operation-failed`: a symlinked or oversized declaration,
// a symlinked install input, another account's file.
const supported = ["darwin", "linux"].includes(process.platform);
const posixTest = test.skipIf(!supported);
let root = "";
let binary = "";
beforeAll(async () => {
  if (!supported) return;
  root = await realpath(await mkdtemp(join(tmpdir(), "checkout-custody-")));
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

type World = Readonly<{
  parent: string;
  organization: string;
  module: string;
  list: () => Promise<Record<string, unknown>>;
  run: (verb: "start" | "status" | "stop") => Promise<Record<string, unknown>>;
  ensure: () => Promise<Record<string, unknown>>;
  started: () => number;
}>;

// A Folder with Organization gamma and its runnable module notes, whose app
// has one local `file:` dependency (app/dependency), as Bun installs them.
async function world(name: string, body: (world: World) => Promise<void>) {
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
    const organization = await writeOrganization(folder, "gamma", {
      slug: "gamma",
      state: "current",
      modules: [{ id: "notes" }],
    });
    const port = await runnable(folder, "gamma", "notes");
    const home = join(parent, "home");
    await mkdir(home);
    const manager = createFakeServiceManager({
      runtimeDirectory: join(parent, "runtime"),
    });
    await mkdir(manager.runtimeDirectory);
    const host = linuxHost(manager, home, port, binary);
    const context = cliContext(home);
    await body({
      parent,
      organization,
      module: join(organization, "workspace", "notes"),
      list: async () => {
        const result = await runCatalogCommand(
          ["module", "list", "gamma", "--folder", folder, "--json"],
          context,
        );
        const modules = (result.result as { modules: unknown[] }).modules;
        expect(modules).toHaveLength(1);
        return modules[0] as Record<string, unknown>;
      },
      run: async (verb) =>
        (
          await runModuleCommand(
            ["module", verb, "gamma/notes", "--folder", folder, "--json"],
            context,
            host,
          )
        ).result as Record<string, unknown>,
      ensure: async () => {
        const operations = createModuleOperations({
          folder,
          owner: "launchpad",
          host,
        });
        try {
          return (await operations.ensure("notes", {
            mayStart: true,
            waitMs: 2_000,
            pollMs: 10,
          })) as Record<string, unknown>;
        } finally {
          await operations.close();
        }
      },
      started: () => manager.commands("systemd-run").length,
    });
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

// The module runs from the start and from the gateway's ensure.
async function expectRuns(world: World) {
  expect(await world.list()).toMatchObject({ executable: true });
  expect(await world.run("start")).toMatchObject({
    kind: "module",
    outcome: "started",
    healthy: true,
  });
  expect(await world.run("stop")).toMatchObject({ outcome: "group-stopped" });
  expect(await world.ensure()).toMatchObject({
    kind: "module",
    operation: "ensure",
    healthy: true,
  });
  expect(await world.run("stop")).toMatchObject({ outcome: "group-stopped" });
}

// A refused declaration: not executable in the list, and every operation
// refused before any effect with the same rule and file.
async function expectDeclarationRefused(
  world: World,
  reason: string,
  file: string,
) {
  const where = { organization: "gamma", module: "notes" };
  expect(await world.list()).toMatchObject({
    executable: false,
    reason,
    file,
  });
  for (const verb of ["start", "status"] as const)
    expect(await world.run(verb)).toEqual({
      kind: "blocked",
      operation: verb,
      reason,
      ...where,
      file,
    });
  expect(await world.ensure()).toEqual({
    kind: "blocked",
    operation: "ensure",
    reason,
    ...where,
    file,
  });
  expect(world.started()).toBe(0);
}

const declarations = (world: World) => [
  join(world.organization, "lazurio.organization.json"),
  join(world.organization, "modules.manifest.json"),
  join(world.module, "lazurio.module.json"),
  join(world.module, "app/package.json"),
  join(world.module, "app/dependency/package.json"),
  join(world.module, "app/bun.lock"),
];

posixTest(
  "permission bits are not a reason: a checkout made under umask 022, 002 or 000 runs",
  async () => {
    for (const mode of [0o644, 0o664, 0o666])
      await world(`mode-${mode.toString(8)}`, async (world) => {
        for (const path of declarations(world)) await chmod(path, mode);
        await expectRuns(world);
      });
  },
  120_000,
);

posixTest(
  "the link count is not a reason: a hard-linked owner package.json and a hard-linked local dependency package.json run",
  async () => {
    await world("owner-linked", async (world) => {
      await link(
        join(world.module, "app/package.json"),
        join(world.parent, "owner-alias.json"),
      );
      await expectRuns(world);
    });
    // What an earlier `bun install` leaves: the local package's files
    // hard-linked into node_modules (issue #93).
    await world("dependency-linked", async (world) => {
      const installed = join(
        world.module,
        "app/node_modules/fixture-dependency",
      );
      await mkdir(installed, { recursive: true });
      await link(
        join(world.module, "app/dependency/package.json"),
        join(installed, "package.json"),
      );
      await link(
        join(world.module, "app/dependency/package.json"),
        join(world.parent, "third-link.json"),
      );
      await expectRuns(world);
    });
  },
  120_000,
);

posixTest(
  "a symlinked lazurio.module.json is refused as declaration-not-regular, named by its module-relative file",
  async () => {
    await world("module-symlink", async (world) => {
      const path = join(world.module, "lazurio.module.json");
      await rename(path, join(world.parent, "outside.json"));
      await symlink(join(world.parent, "outside.json"), path);
      await expectDeclarationRefused(
        world,
        "declaration-not-regular",
        "lazurio.module.json",
      );
    });
  },
  60_000,
);

posixTest(
  "an oversized app package.json is refused as declaration-too-large",
  async () => {
    await world("app-large", async (world) => {
      const path = join(world.module, "app/package.json");
      const pkg = JSON.parse(await readFile(path, "utf8"));
      await writeFile(
        path,
        JSON.stringify({ ...pkg, description: " ".repeat(1024 * 1024) }),
      );
      await expectDeclarationRefused(
        world,
        "declaration-too-large",
        "app/package.json",
      );
    });
  },
  60_000,
);

posixTest(
  "a refused install input is not a declaration: the list says executable, the start and ensure refuse with its rule and file, never operation-failed",
  async () => {
    await world("dependency-symlink", async (world) => {
      const path = join(world.module, "app/dependency/package.json");
      await rename(path, join(world.parent, "dependency.json"));
      await symlink(join(world.parent, "dependency.json"), path);
      expect(await world.list()).toMatchObject({ executable: true });
      const refused = {
        kind: "blocked",
        operation: "start",
        reason: "declaration-not-regular",
        organization: "gamma",
        module: "notes",
        app: "app/package.json",
        file: "app/dependency/package.json",
      };
      expect(await world.run("start")).toEqual(refused);
      expect(await world.ensure()).toEqual(refused);
      expect(world.started()).toBe(0);
    });
  },
  60_000,
);

posixTest(
  "a refused Organization document names its rule and file on the Organization and on the module's operations",
  async () => {
    await world("organization-symlink", async (world) => {
      const path = join(world.organization, "modules.manifest.json");
      await rename(path, join(world.parent, "modules.json"));
      await symlink(join(world.parent, "modules.json"), path);
      const result = await runCatalogCommand(
        [
          "organization",
          "list",
          "--folder",
          join(world.parent, "Lazurio"),
          "--json",
        ],
        cliContext(join(world.parent, "home")),
      );
      const organizations = (
        result.result as { organizations: Record<string, unknown>[] }
      ).organizations;
      expect(
        organizations.find((entry) => entry.directory === "gamma"),
      ).toMatchObject({
        executable: false,
        reason: "declaration-not-regular",
        file: "modules.manifest.json",
      });
      expect(await world.run("start")).toEqual({
        kind: "blocked",
        operation: "start",
        reason: "declaration-not-regular",
        organization: "gamma",
        module: "notes",
        file: "modules.manifest.json",
      });
    });
  },
  60_000,
);

// Only root can give a file to another account; elsewhere the rule is
// tested over a faked stat and another expected owner
// (checkout-file-custody.test.ts).
test.skipIf(!supported || process.getuid?.() !== 0)(
  "another account's declaration is refused as declaration-owner",
  async () => {
    await world("owner-other", async (world) => {
      await chown(join(world.module, "app/package.json"), 1, 1);
      await expectDeclarationRefused(
        world,
        "declaration-owner",
        "app/package.json",
      );
    });
  },
  60_000,
);

// ---- A checkout made the way `git clone` makes it under umask 002 ----------

async function git(cwd: string, ...args: string[]) {
  const run = Bun.spawn(
    [
      "/bin/sh",
      "-c",
      'umask 002; exec /usr/bin/git -c user.name=fixture -c user.email=fixture@example.invalid -c init.defaultBranch=main "$@"',
      "fixture-git",
      ...args,
    ],
    {
      cwd,
      env: { PATH: "/usr/bin:/bin", HOME: cwd, GIT_CONFIG_NOSYSTEM: "1" },
      stdout: "ignore",
      stderr: "pipe",
    },
  );
  const [error, code] = await Promise.all([
    new Response(run.stderr).text(),
    run.exited,
  ]);
  expect(code, error).toBe(0);
}

type Clone = Readonly<{
  folder: string;
  organization: string;
  list: () => Promise<Record<string, Record<string, unknown>>>;
  run: (
    verb: "start" | "stop",
    module: string,
  ) => Promise<Record<string, unknown>>;
  ensure: (module: string) => Promise<Record<string, unknown>>;
}>;

// Organization gamma with two runnable modules, committed in a source
// repository and cloned into the Folder by Git under umask 002: every
// directory 0775, every file 0664. Module notes then gets what an earlier
// `bun install` leaves: a group-writable node_modules holding its local
// `file:` dependency, whose package.json is hard-linked into it.
async function cloned(name: string, body: (clone: Clone) => Promise<void>) {
  const parent = await realpath(await mkdtemp(join(root, `${name}-`)));
  try {
    const source = join(parent, "source");
    await mkdir(source);
    await writeOrganization(source, "gamma", {
      slug: "gamma",
      state: "current",
      modules: [{ id: "notes" }, { id: "board" }],
    });
    const ports: Record<string, number> = {};
    for (const id of ["notes", "board"])
      ports[id] = await runnable(source, "gamma", id);
    const repository = join(source, "organizations", "gamma");
    await git(repository, "init", "-q");
    await git(repository, "add", "-A");
    await git(repository, "commit", "-q", "-m", "fixture");
    const folder = join(parent, "Lazurio");
    await initializeFolder(folder, {
      os: executionOs(process.platform),
      access: "local",
      purpose: "human",
      locale: "en",
      detail: "concise",
      coordination: "direct",
    });
    const organization = join(folder, "organizations", "gamma");
    await git(parent, "clone", "-q", repository, organization);
    const app = join(organization, "workspace", "notes", "app");
    await git(app, "status", "--short");
    const installed = join(app, "node_modules", "fixture-dependency");
    const make = Bun.spawn(
      [
        "/bin/sh",
        "-c",
        'umask 002; exec /bin/mkdir -p "$1"',
        "mkdir",
        installed,
      ],
      { stdout: "ignore", stderr: "ignore" },
    );
    expect(await make.exited).toBe(0);
    await link(
      join(app, "dependency", "package.json"),
      join(installed, "package.json"),
    );
    // The fixture is what it claims to be.
    const mode = async (path: string) => (await lstat(path)).mode & 0o777;
    for (const directory of [
      organization,
      join(organization, "workspace"),
      join(organization, "workspace", "notes"),
      app,
      join(app, "dependency"),
      join(app, "node_modules"),
      installed,
    ])
      expect(await mode(directory)).toBe(0o775);
    for (const file of [
      join(organization, "lazurio.organization.json"),
      join(organization, "modules.manifest.json"),
      join(organization, "workspace", "notes", "lazurio.module.json"),
      join(app, "package.json"),
      join(app, "bun.lock"),
      join(app, "dependency", "package.json"),
    ])
      expect(await mode(file)).toBe(0o664);
    expect((await lstat(join(installed, "package.json"))).nlink).toBe(2);
    const home = join(parent, "home");
    await mkdir(home);
    const context = cliContext(home);
    // One in-memory user manager per module: its fake listener is the
    // module's declared port.
    const hosts: Record<string, ReturnType<typeof linuxHost>> = {};
    for (const id of ["notes", "board"]) {
      const manager = createFakeServiceManager({
        runtimeDirectory: join(parent, `runtime-${id}`),
      });
      await mkdir(manager.runtimeDirectory);
      hosts[id] = linuxHost(manager, home, ports[id] as number, binary);
    }
    const host = (id: string) => {
      const found = hosts[id];
      if (found === undefined) throw new Error("Unknown fixture module");
      return found;
    };
    await body({
      folder,
      organization,
      list: async () => {
        const result = await runCatalogCommand(
          ["module", "list", "gamma", "--folder", folder, "--json"],
          context,
        );
        const modules = (
          result.result as { modules: Record<string, unknown>[] }
        ).modules;
        return Object.fromEntries(
          modules.map((entry) => [entry.module as string, entry]),
        );
      },
      run: async (verb, id) =>
        (
          await runModuleCommand(
            ["module", verb, `gamma/${id}`, "--folder", folder, "--json"],
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
            waitMs: 2_000,
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

posixTest(
  "a checkout cloned by Git under umask 002, with a hard-linked local dependency and a group-writable node_modules, runs every module",
  async () => {
    await cloned("umask-002", async (clone) => {
      const organizations = (
        await runCatalogCommand(
          ["organization", "list", "--folder", clone.folder, "--json"],
          cliContext(join(clone.folder, "..", "home")),
        )
      ).result as { organizations: Record<string, unknown>[] };
      expect(organizations.organizations).toMatchObject([
        { directory: "gamma", organization: "gamma", executable: true },
      ]);
      const modules = await clone.list();
      for (const id of ["notes", "board"]) {
        expect(modules[id]).toMatchObject({ executable: true });
        expect(await clone.run("start", id)).toMatchObject({
          kind: "module",
          outcome: "started",
          healthy: true,
        });
        expect(await clone.run("stop", id)).toMatchObject({
          outcome: "group-stopped",
        });
        expect(await clone.ensure(id)).toMatchObject({
          kind: "module",
          operation: "ensure",
          healthy: true,
        });
        expect(await clone.run("stop", id)).toMatchObject({
          outcome: "group-stopped",
        });
      }
    });
  },
  120_000,
);

posixTest(
  "the same checkout with one module directory owned by another account: that module is refused as directory-owner, the other still starts",
  async () => {
    await cloned("umask-002-foreign", async (clone) => {
      // A faked stat: only root can give a directory to another account.
      const foreign = join(clone.organization, "workspace", "board");
      const original = fsPromises.lstat;
      const spy = spyOn(fsPromises, "lstat").mockImplementation((async (
        path: Parameters<typeof original>[0],
        options?: Parameters<typeof original>[1],
      ) => {
        const stat = await original(path, options as undefined);
        if (path === foreign)
          Object.defineProperty(stat, "uid", { value: stat.uid + 1 });
        return stat;
      }) as typeof original);
      try {
        const modules = await clone.list();
        expect(modules.board).toMatchObject({
          executable: false,
          reason: "directory-owner",
          file: ".",
        });
        expect(modules.notes).toMatchObject({ executable: true });
        const refused = {
          kind: "blocked",
          reason: "directory-owner",
          organization: "gamma",
          module: "board",
          file: ".",
        };
        expect(await clone.run("start", "board")).toEqual({
          ...refused,
          operation: "start",
        });
        expect(await clone.ensure("board")).toEqual({
          ...refused,
          operation: "ensure",
        });
        expect(await clone.run("start", "notes")).toMatchObject({
          outcome: "started",
          healthy: true,
        });
        expect(await clone.run("stop", "notes")).toMatchObject({
          outcome: "group-stopped",
        });
      } finally {
        spy.mockRestore();
      }
    });
  },
  120_000,
);
