import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initializeFolder,
  initializeHandoverFolder,
} from "../src/folder/initialize-folder";
import { executionOs } from "../src/folder/platform";
import { presetProfile } from "../src/folder/presets";
import type { ApplicationRunner } from "../src/modules/application-runner";
import { runModuleCommand } from "../src/modules/module-cli";
import {
  createModuleOperations,
  type ModuleHost,
} from "../src/modules/module-operations";
import { readModuleApplication } from "../src/modules/read-application";
import { createSessionRunner } from "../src/modules/session-runner";
import type { CliContext } from "../src/update/cli";
import { writeOrganization } from "./fixtures/catalog-folder";
import { createFakeServiceManager } from "./fixtures/fake-service-manager";
import { organizationWithEntry } from "./fixtures/machine-bindings";
import {
  compilePlatform,
  linuxHost,
  runnableModule,
} from "./fixtures/module-host";
import {
  mkdirOwnedFixture as mkdir,
  writeOwnedFixture as writeFile,
} from "./fixtures/owned-files";

// The environment of a started application (decision F26): the names and
// values the replaced Launchpad gave a declared runtime, so that a module
// written for it runs unchanged. The consumer is a fixture application shaped
// like a real one: it binds the entrypoint aliases, allows exactly the
// hostname of `LAZURIO_RUNTIME_EXTERNAL_ORIGIN` as its Host and exactly that
// origin as its `Origin`, and without an origin only loopback hosts. It is
// started through the module operations on a hosted fixture Folder (a Machine
// handover with its `entry`) and on a workstation fixture Folder. Synthetic
// names only; loopback only; HOME and every state directory are temporary.
const supported = ["darwin", "linux"].includes(process.platform);
const posixTest = test.skipIf(!supported);
let root = "";
let binary = "";
beforeAll(async () => {
  if (!supported) return;
  root = await realpath(await mkdtemp(join(tmpdir(), "app-environment-")));
  binary = join(root, "platform");
  await compilePlatform(binary);
});
afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

const machineHost = "vm-1.org.example.test";
const origin = `https://notes.${machineHost}`;

function cliContext(home: string): CliContext {
  return {
    identity: { version: "1.0.0", commit: "0".repeat(40), target: "fixture" },
    platform: process.platform,
    env: { HOME: home },
    executable: join(home, "lazurio"),
    hostedFolder: async () => undefined,
  };
}

async function freePort() {
  const server = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = server.port as number;
  server.stop(true);
  return port;
}

// The fixture application, read by what a real application reads: the
// entrypoint aliases, the auxiliary listener's keyed names and the external
// origin, checked exactly as `new URL(x).origin` prints it.
const strictServer = `
const external = process.env.LAZURIO_RUNTIME_EXTERNAL_ORIGIN;
const hosted = external ? new URL(external) : null;
if (hosted && (hosted.protocol !== "https:" || hosted.origin !== external))
  throw new Error("LAZURIO_RUNTIME_EXTERNAL_ORIGIN is not an exact https origin");
const allowed = hosted ? [hosted.hostname] : ["127.0.0.1", "localhost"];
const fetch = (request) => {
  const hostname = new URL("http://" + request.headers.get("host")).hostname;
  if (!allowed.includes(hostname))
    return new Response('Blocked request. This host ("' + hostname + '") is not allowed.', { status: 403 });
  const from = request.headers.get("origin");
  if (from !== null && from !== (hosted ? hosted.origin : null))
    return new Response("Blocked origin", { status: 403 });
  if (new URL(request.url).pathname === "/env") return Response.json(process.env);
  return new Response("fixture module");
};
Bun.serve({ hostname: process.env.LAZURIO_RUNTIME_HOST, port: Number(process.env.LAZURIO_RUNTIME_PORT), fetch });
if (process.env.LAZURIO_RUNTIME_LISTENER_API_PORT)
  Bun.serve({ hostname: process.env.LAZURIO_RUNTIME_LISTENER_API_HOST, port: Number(process.env.LAZURIO_RUNTIME_LISTENER_API_PORT), fetch });
`;

// The Organization `gamma` with the module `notes` in <Folder>, made
// runnable with the strict fixture application: one entrypoint `web`, and
// with `two` an auxiliary listener `api`. With `admin`, a second declared app
// `admin/package.json` (not the default) serving the same entrypoint.
async function notesModule(
  folder: string,
  home: string,
  options: { two?: boolean; admin?: boolean } = {},
) {
  const organization = await writeOrganization(folder, "gamma", {
    slug: "gamma",
    state: "current",
    modules: [{ id: "notes" }],
  });
  const module = join(organization, "workspace", "notes");
  await runnableModule(module, home);
  const web = await freePort();
  const api = await freePort();
  const manifest = JSON.parse(
    await readFile(join(module, "lazurio.module.json"), "utf8"),
  );
  manifest.port_leases = [
    { id: "main", host: "127.0.0.1", port: web },
    ...(options.two ? [{ id: "api", host: "127.0.0.1", port: api }] : []),
  ];
  if (options.two)
    manifest.tcp_port_policy = {
      mode: "exception",
      reason: "fixture: an entrypoint and an auxiliary listener",
    };
  const listeners = [
    {
      id: "web",
      role: "entrypoint",
      lease: "main",
      protocol: "http",
      health: { kind: "tcp" },
    },
    ...(options.two
      ? [
          {
            id: "api",
            role: "auxiliary",
            lease: "api",
            protocol: "http",
            health: { kind: "tcp" },
          },
        ]
      : []),
  ];
  const app = join(module, "app");
  const pkg = JSON.parse(await readFile(join(app, "package.json"), "utf8"));
  pkg.lazurio.runtime.listeners = listeners;
  await writeFile(join(app, "package.json"), JSON.stringify(pkg));
  await writeFile(join(app, "server.ts"), strictServer);
  if (options.admin) {
    // The default preparation (F25): its own package, lockfile and dev script.
    const admin = join(module, "admin");
    await mkdir(join(admin, "dependency"), { recursive: true });
    await writeFile(
      join(admin, "dependency/package.json"),
      JSON.stringify({ name: "fixture-dependency", version: "1.0.0" }),
    );
    await writeFile(
      join(admin, "package.json"),
      JSON.stringify({
        name: "fixture-notes-admin",
        private: true,
        dependencies: { "fixture-dependency": "file:./dependency" },
        scripts: { dev: `"${process.execPath}" --no-env-file server.ts` },
        lazurio: {
          runtime: {
            ...pkg.lazurio.runtime,
            id: "notes-admin",
            title: "notes admin",
            listeners: [listeners[0]],
          },
        },
      }),
    );
    await writeFile(join(admin, "server.ts"), strictServer);
    const install = Bun.spawn(
      [process.execPath, "install", "--lockfile-only"],
      {
        cwd: admin,
        env: { HOME: home, PATH: "/usr/bin:/bin" },
        stdout: "ignore",
        stderr: "ignore",
      },
    );
    expect(await install.exited).toBe(0);
    manifest.apps = ["app/package.json", "admin/package.json"];
  }
  await writeFile(
    join(module, "lazurio.module.json"),
    JSON.stringify(manifest),
  );
  return { organization, module, app, web, api };
}

// A Folder in <parent>: a hosted one records the Machine handover with its
// entry (module origins `https://{module}.<machineHost>`), a workstation one
// has no Machine binding.
async function fixtureFolder(parent: string, place: "hosted" | "local") {
  const folder = join(parent, "Lazurio");
  if (place === "hosted") {
    await mkdir(folder);
    await mkdir(join(folder, "organizations"), { mode: 0o755 });
    const preset = "hosted-organization-personal";
    await initializeHandoverFolder(folder, {
      preset,
      machine: organizationWithEntry(20000, machineHost),
      profile: presetProfile(preset, executionOs(process.platform)),
    });
  } else
    await initializeFolder(folder, {
      os: executionOs(process.platform),
      access: "local",
      purpose: "human",
      locale: "en",
      detail: "concise",
      coordination: "direct",
    });
  const home = join(parent, "home");
  await mkdir(home);
  return { folder, home };
}

// The ambient variables a user manager or a parent process may carry; none of
// them may reach a started application.
const ambient = [
  "HOST=ambient.example.test",
  "PORT=1",
  "NODE_PATH=/ambient/node_modules",
  "LAZURIO_RUNTIME_PORT=2",
  "LAZURIO_RUNTIME_EXTERNAL_ORIGIN=https://stale.example.test",
  "LAZURIO_RUNTIME_LISTENER_STALE_PORT=3",
  "COMPANYASCODE_ORGANIZATION_ROOT=/ambient/organization",
  "SSH_AUTH_SOCK=/run/user/1000/ssh-agent.socket",
];

// The launch the user manager was asked for: its environment, the names it
// unsets, its working directory and its command.
function unitRequest(manager: ReturnType<typeof createFakeServiceManager>) {
  const runs = manager.commands("systemd-run");
  const args = runs.at(-1)?.args ?? [];
  const value = (name: string) =>
    args
      .filter((entry) => entry.startsWith(`${name}=`))
      .map((entry) => entry.slice(name.length + 1));
  const environment: Record<string, string> = {};
  for (const entry of value("--setenv")) {
    const split = entry.indexOf("=");
    expect(Object.hasOwn(environment, entry.slice(0, split))).toBe(false);
    environment[entry.slice(0, split)] = entry.slice(split + 1);
  }
  const unset =
    value("--property")
      .find((entry) => entry.startsWith("UnsetEnvironment="))
      ?.slice("UnsetEnvironment=".length)
      .split(" ") ?? [];
  return {
    count: runs.length,
    environment,
    unset,
    cwd: value("--working-directory")[0] as string,
    command: args.slice(args.indexOf("--") + 1),
  };
}

// Run a unit's definition as the manager would: exactly its command, working
// directory and environment, nothing inherited. Returns a stop function.
async function runUnit(request: ReturnType<typeof unitRequest>, port: number) {
  const child = Bun.spawn(request.command, {
    cwd: request.cwd,
    env: request.environment,
    stdout: "ignore",
    stderr: "ignore",
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await fetch(`http://127.0.0.1:${port}/`);
      break;
    } catch {
      await Bun.sleep(50);
    }
  }
  return async () => {
    child.kill();
    await child.exited;
  };
}

async function ask(port: number, headers: Record<string, string>) {
  const response = await fetch(`http://127.0.0.1:${port}/`, { headers });
  return { status: response.status, body: await response.text() };
}

// The whole environment a declared runtime of `gamma/notes` gets.
function expectedEnvironment(input: {
  home: string;
  path: string;
  organization: string;
  app: string;
  web: number;
  api?: number;
  hosted: boolean;
  id?: string;
}) {
  const id = input.id ?? "notes";
  const listener = (
    name: "web" | "api",
    port: number,
    role: string,
    external: boolean,
  ) => ({
    id: name,
    role,
    allocation: "static",
    host: "127.0.0.1",
    port,
    protocol: "http",
    health: { kind: "tcp" },
    claim: { mode: "exclusive" },
    ...(external ? { external_origin: origin } : {}),
  });
  return {
    HOME: input.home,
    PATH: input.path,
    NODE_ENV: "development",
    ASTRO_DEV_BACKGROUND: "1",
    ASTRO_PREVIEW_BACKGROUND: "1",
    NODE_PATH: join(input.app, "node_modules"),
    COMPANYASCODE_ORGANIZATION_ROOT: input.organization,
    COMPANYASCODE_APP_ID: id,
    COMPANYASCODE_RUNTIME_KEY: id,
    COMPANYASCODE_RUNTIME_SOURCE: "main",
    LAZURIO_RUNTIME_SCHEMA_VERSION: "lazurio.runtime.v1",
    LAZURIO_RUNTIME_APP_ID: id,
    LAZURIO_RUNTIME_ENTRYPOINT_ID: "web",
    LAZURIO_RUNTIME_HOST: "127.0.0.1",
    LAZURIO_RUNTIME_PORT: String(input.web),
    LAZURIO_RUNTIME_LISTENER_WEB_HOST: "127.0.0.1",
    LAZURIO_RUNTIME_LISTENER_WEB_PORT: String(input.web),
    ...(input.api === undefined
      ? {}
      : {
          LAZURIO_RUNTIME_LISTENER_API_HOST: "127.0.0.1",
          LAZURIO_RUNTIME_LISTENER_API_PORT: String(input.api),
        }),
    ...(input.hosted
      ? {
          LAZURIO_RUNTIME_LISTENER_WEB_EXTERNAL_ORIGIN: origin,
          LAZURIO_RUNTIME_EXTERNAL_ORIGIN: origin,
        }
      : {}),
    LAZURIO_RUNTIME_LISTENERS_JSON: [
      listener("web", input.web, "entrypoint", input.hosted),
      ...(input.api === undefined
        ? []
        : [listener("api", input.api, "auxiliary", false)]),
    ],
  };
}

// The environment with its listener JSON parsed, for exact comparison.
function readable(environment: Record<string, string>) {
  const { LAZURIO_RUNTIME_LISTENERS_JSON: listeners, ...rest } = environment;
  return {
    ...rest,
    LAZURIO_RUNTIME_LISTENERS_JSON:
      listeners === undefined ? undefined : JSON.parse(listeners),
  };
}

posixTest(
  "hosted (user manager): the unit carries the replaced Launchpad's runtime environment exactly, the entrypoint alone gets the external origin, and the application accepts its own hostname and refuses any other",
  async () => {
    const parent = await realpath(await mkdtemp(join(root, "hosted-")));
    const { folder, home } = await fixtureFolder(parent, "hosted");
    const { organization, app, web, api } = await notesModule(folder, home, {
      two: true,
    });
    const manager = createFakeServiceManager({
      runtimeDirectory: join(parent, "runtime"),
      managerEnvironment: ["HOME=/home/admin", "PATH=/usr/bin", ...ambient],
    });
    await mkdir(manager.runtimeDirectory);
    const host = linuxHost(manager, home, [web, api], binary);
    const run = async (...args: string[]) =>
      (
        await runModuleCommand(
          ["module", ...args, "--folder", folder, "--json"],
          cliContext(home),
          host,
        )
      ).result;
    expect(await run("start", "gamma/notes")).toMatchObject({
      outcome: "started",
      healthy: true,
      runtime: { url: `${origin}/` },
    });
    const request = unitRequest(manager);
    expect(readable(request.environment)).toEqual(
      expectedEnvironment({
        home,
        path: "/usr/bin:/bin",
        organization,
        app,
        web,
        api,
        hosted: true,
      }),
    );
    // The origin is exactly `runtime.url` without its slash.
    expect(request.environment.LAZURIO_RUNTIME_EXTERNAL_ORIGIN).toBe(
      new URL(`${origin}/`).origin,
    );
    // Every ambient name the manager holds is unset unless declared.
    for (const name of [
      "HOST",
      "PORT",
      "LAZURIO_RUNTIME_LISTENER_STALE_PORT",
      "SSH_AUTH_SOCK",
    ])
      expect(request.unset).toContain(name);
    // The application, run exactly as the manager runs the unit.
    const stop = await runUnit(request, web);
    try {
      expect(await ask(web, { Host: `notes.${machineHost}` })).toEqual({
        status: 200,
        body: "fixture module",
      });
      expect(
        await ask(web, { Host: `notes.${machineHost}`, Origin: origin }),
      ).toEqual({ status: 200, body: "fixture module" });
      const wrong = await ask(web, { Host: "other.example.test" });
      expect(wrong.status).toBe(403);
      expect(wrong.body).toContain("Blocked request");
      expect((await ask(web, { Host: `127.0.0.1:${web}` })).status).toBe(403);
      expect(
        (
          await ask(web, {
            Host: `notes.${machineHost}`,
            Origin: "https://other.example.test",
          })
        ).status,
      ).toBe(403);
    } finally {
      await stop();
    }
    await run("stop", "gamma/notes");
    await rm(parent, { recursive: true, force: true });
  },
  60_000,
);

posixTest(
  "session runner: the application process itself receives the environment on a hosted Folder, and answers its own hostname only",
  async () => {
    const parent = await realpath(await mkdtemp(join(root, "session-")));
    const { folder, home } = await fixtureFolder(parent, "hosted");
    const { organization, app, web } = await notesModule(folder, home);
    const launches: Record<string, string>[] = [];
    const host: ModuleHost = {
      platform: "darwin",
      home,
      path: "/usr/bin:/bin",
      runtimeDirectory: undefined,
      platformExecutable: binary,
      bunExecutable: process.execPath,
      runnerKind: async () => "session",
      createRunner: () => {
        const runner = createSessionRunner(binary);
        const recording: ApplicationRunner = {
          ...runner,
          start: (request) => {
            launches.push({ ...request.launch.env });
            return runner.start(request);
          },
        };
        return recording;
      },
      readJournal: async () => {
        throw new Error("A session app has no journal");
      },
    };
    const operations = createModuleOperations({
      folder,
      owner: "launchpad",
      host,
    });
    try {
      expect(await operations.start("gamma/notes")).toMatchObject({
        outcome: "started",
        runner: "session",
      });
      let status = await operations.status("gamma/notes");
      for (
        let attempt = 0;
        attempt < 50 && !(status.kind === "module" && status.healthy);
        attempt++
      ) {
        await Bun.sleep(100);
        status = await operations.status("gamma/notes");
      }
      expect(status).toMatchObject({
        healthy: true,
        runtime: { url: `${origin}/` },
      });
      const expected = expectedEnvironment({
        home,
        path: "/usr/bin:/bin",
        organization,
        app,
        web,
        hosted: true,
      });
      expect(launches.map(readable)).toEqual([expected]);
      // What the process holds: every variable of the launch with its value
      // (Bun's `run` prepends the package's .bin directories to PATH and adds
      // its own npm_* names), and none of the ambient names.
      const response = await fetch(`http://127.0.0.1:${web}/env`, {
        headers: { Host: `notes.${machineHost}` },
      });
      expect(response.status).toBe(200);
      const received = (await response.json()) as Record<string, string>;
      const launch = launches[0] as Record<string, string>;
      for (const [name, value] of Object.entries(launch))
        if (name !== "PATH") expect(received[name], name).toBe(value);
      expect(received.PATH?.endsWith(launch.PATH as string)).toBe(true);
      for (const name of ["HOST", "PORT", "SSH_AUTH_SOCK"])
        expect(Object.hasOwn(received, name), name).toBe(false);
      expect(
        Object.keys(received).filter((name) =>
          name.startsWith("LAZURIO_RUNTIME_"),
        ),
      ).toEqual(
        Object.keys(launch).filter((name) =>
          name.startsWith("LAZURIO_RUNTIME_"),
        ),
      );
      expect((await ask(web, { Host: `notes.${machineHost}` })).status).toBe(
        200,
      );
      expect((await ask(web, { Host: "other.example.test" })).status).toBe(403);
    } finally {
      expect(await operations.close()).toEqual({ kind: "closed" });
    }
    await rm(parent, { recursive: true, force: true });
  },
  60_000,
);

posixTest(
  "workstation: no external origin anywhere; the application answers loopback and refuses the hosted name",
  async () => {
    const parent = await realpath(await mkdtemp(join(root, "local-")));
    const { folder, home } = await fixtureFolder(parent, "local");
    const { organization, app, web, api } = await notesModule(folder, home, {
      two: true,
    });
    const manager = createFakeServiceManager({
      runtimeDirectory: join(parent, "runtime"),
      managerEnvironment: ["HOME=/home/admin", "PATH=/usr/bin", ...ambient],
    });
    await mkdir(manager.runtimeDirectory);
    const host = linuxHost(manager, home, [web, api], binary);
    expect(
      (
        await runModuleCommand(
          ["module", "start", "gamma/notes", "--folder", folder, "--json"],
          cliContext(home),
          host,
        )
      ).result,
    ).toMatchObject({
      outcome: "started",
      runtime: { url: `http://127.0.0.1:${web}/` },
    });
    const request = unitRequest(manager);
    expect(readable(request.environment)).toEqual(
      expectedEnvironment({
        home,
        path: "/usr/bin:/bin",
        organization,
        app,
        web,
        api,
        hosted: false,
      }),
    );
    const stop = await runUnit(request, web);
    try {
      expect((await ask(web, { Host: `127.0.0.1:${web}` })).status).toBe(200);
      expect((await ask(web, { Host: `notes.${machineHost}` })).status).toBe(
        403,
      );
    } finally {
      await stop();
    }
    await rm(parent, { recursive: true, force: true });
  },
  60_000,
);

posixTest(
  "hosted: a non-default app and a Folder without a recorded entry get no origin; a Folder whose state cannot be read refuses the start",
  async () => {
    const parent = await realpath(await mkdtemp(join(root, "hosted-none-")));
    const { folder, home } = await fixtureFolder(parent, "hosted");
    const { organization, module, web } = await notesModule(folder, home, {
      admin: true,
    });
    const manager = createFakeServiceManager({
      runtimeDirectory: join(parent, "runtime"),
    });
    await mkdir(manager.runtimeDirectory);
    const host = linuxHost(manager, home, web, binary);
    const run = async (...args: string[]) =>
      (
        await runModuleCommand(
          ["module", ...args, "--folder", folder, "--json"],
          cliContext(home),
          host,
        )
      ).result;
    // The gateway serves the module's hostname for its default app only.
    expect(
      await run("start", "gamma/notes", "--app", "admin/package.json"),
    ).toMatchObject({
      outcome: "started",
      runtime: null,
      runtimeReason: "hosted-app-not-default",
    });
    expect(readable(unitRequest(manager).environment)).toEqual(
      expectedEnvironment({
        home,
        path: "/usr/bin:/bin",
        organization,
        app: join(module, "admin"),
        web,
        hosted: false,
        id: "notes-admin",
      }),
    );
    await run("stop", "gamma/notes", "--app", "admin/package.json");
    // A Folder whose state cannot be read is not taken for a workstation:
    // nothing starts.
    const preferences = join(folder, ".lazurio", "preferences.json");
    const recorded = await readFile(preferences, "utf8");
    await writeFile(preferences, "{ not json");
    const before = manager.commands("systemd-run").length;
    expect(await run("start", "gamma/notes")).toMatchObject({
      kind: "blocked",
      operation: "start",
      reason: "folder-state-unreadable",
    });
    expect(manager.commands("systemd-run")).toHaveLength(before);
    await writeFile(preferences, recorded);
    await rm(parent, { recursive: true, force: true });
  },
  60_000,
);

posixTest(
  "hosted: an application an older release started keeps its environment until it is stopped; the next start carries the origin",
  async () => {
    const parent = await realpath(await mkdtemp(join(root, "hosted-older-")));
    const { folder, home } = await fixtureFolder(parent, "hosted");
    const { organization, module, app, web } = await notesModule(folder, home);
    const manager = createFakeServiceManager({
      runtimeDirectory: join(parent, "runtime"),
    });
    await mkdir(manager.runtimeDirectory);
    const host = linuxHost(manager, home, web, binary);
    const run = async (...args: string[]) =>
      (
        await runModuleCommand(
          ["module", ...args, "--folder", folder, "--json"],
          cliContext(home),
          host,
        )
      ).result;
    // The unit exactly as the previous release defined it: HOME, PATH and the
    // keyed entrypoint host and port, from the same declaration.
    const plan = await readModuleApplication(module, "app/package.json");
    if (plan.kind !== "declared-runtime-plan") throw new Error("Fixture plan");
    const older = {
      HOME: home,
      PATH: "/usr/bin:/bin",
      LAZURIO_RUNTIME_LISTENER_WEB_HOST: "127.0.0.1",
      LAZURIO_RUNTIME_LISTENER_WEB_PORT: String(web),
    };
    const runner = host.createRunner("systemd-user", organization);
    expect(
      await runner.start({
        application: {
          company: "gamma",
          module: "notes",
          package: "app/package.json",
        },
        launch: {
          executable: process.execPath,
          cwd: app,
          args: ["--no-env-file", "run", "dev"],
          env: older,
        },
        declarationDigest: plan.declarationDigest,
        ports: [web],
      }),
    ).toEqual({ kind: "started" });
    // Recognized as this application's unit, not foreign: its status is read
    // and a start finds it running and starts nothing.
    expect(await run("status", "gamma/notes")).toMatchObject({
      state: "running",
      healthy: true,
    });
    expect(await run("start", "gamma/notes")).toMatchObject({
      outcome: "already-managed",
    });
    expect(unitRequest(manager)).toMatchObject({
      count: 1,
      environment: older,
    });
    // Stop, then start: the new unit carries the whole environment.
    expect(await run("stop", "gamma/notes")).toMatchObject({
      outcome: "group-stopped",
    });
    expect(await run("start", "gamma/notes")).toMatchObject({
      outcome: "started",
    });
    const renewed = unitRequest(manager);
    expect(renewed.count).toBe(2);
    expect(readable(renewed.environment)).toEqual(
      expectedEnvironment({
        home,
        path: "/usr/bin:/bin",
        organization,
        app,
        web,
        hosted: true,
      }),
    );
    await run("stop", "gamma/notes");
    await rm(parent, { recursive: true, force: true });
  },
  60_000,
);
