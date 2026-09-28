import { afterAll, beforeAll, expect, test } from "bun:test";
import { cp, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { initializeHandoverFolder } from "../src/folder/initialize-folder";
import { executionOs } from "../src/folder/platform";
import { presetProfile } from "../src/folder/presets";
import { moduleOrigin } from "../src/launchpad/hosted-entry";
import { startLaunchpad } from "../src/launchpad/server";
import { runModuleCommand } from "../src/modules/module-cli";
import type { ModuleHost } from "../src/modules/module-operations";
import { createSessionRunner } from "../src/modules/session-runner";
import {
  applicationUnitName,
  createSystemdUserRunner,
  readApplicationJournal,
} from "../src/modules/systemd-user-runner";
import type { CliContext } from "../src/update/cli";
import { folderFixture, writeOrganization } from "./fixtures/catalog-folder";
import { createFakeServiceManager } from "./fixtures/fake-service-manager";
import { bindings, organizationWithEntry } from "./fixtures/machine-bindings";
import {
  mkdirOwnedFixture as mkdir,
  writeOwnedFixture as writeFile,
} from "./fixtures/owned-files";

// The module lifecycle of the catalog (launchpad-parity B3): `lazurio module
// start|stop|status|logs` and `/api/modules/<org>/<module>/…` over one core.
// The Linux path runs against the in-memory service manager; the session path
// starts a real synthetic app under the compiled process guard. Synthetic
// Organizations only; nothing touches the account's home or user manager.
const supported = ["darwin", "linux"].includes(process.platform);
const posixTest = test.skipIf(!supported);
let root = "";
// The compiled CLI is the process guard of session apps and of the declared
// start check, as in the installed product.
let binary = "";
beforeAll(async () => {
  if (!supported) return;
  root = await realpath(await mkdtemp(join(tmpdir(), "module-operations-")));
  binary = join(root, "platform");
  const build = Bun.spawn(
    [
      process.execPath,
      "build",
      resolve("src/cli.ts"),
      "--compile",
      "--no-compile-autoload-dotenv",
      "--no-compile-autoload-bunfig",
      "--outfile",
      binary,
    ],
    { stdout: "ignore", stderr: "pipe" },
  );
  const [error, code] = await Promise.all([
    new Response(build.stderr).text(),
    build.exited,
  ]);
  expect(code, error).toBe(0);
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

// A module of the fixture Folder made runnable: an exact Bun, a declared
// start check that passes, a lockfile and a dev script serving the declared
// port. Returns the declared port.
async function runnable(folder: string, directory: string, id: string) {
  const moduleDirectory = join(
    folder,
    "organizations",
    directory,
    "workspace",
    id,
  );
  const manifest = JSON.parse(
    await readFile(join(moduleDirectory, "lazurio.module.json"), "utf8"),
  );
  const port = manifest.port_leases[0].port as number;
  const app = join(moduleDirectory, "app");
  const pkg = JSON.parse(await readFile(join(app, "package.json"), "utf8"));
  pkg.packageManager = `bun@${Bun.version}`;
  // One local dependency, so the lockfile exists.
  pkg.dependencies = { "fixture-dependency": "file:./dependency" };
  await mkdir(join(app, "dependency"));
  await writeFile(
    join(app, "dependency/package.json"),
    JSON.stringify({ name: "fixture-dependency", version: "1.0.0" }),
  );
  pkg.scripts = {
    dev: `"${process.execPath}" --no-env-file server.ts`,
    check: `"${process.execPath}" --no-env-file check.ts`,
  };
  pkg.lazurio.preparation = {
    schema_version: "lazurio.preparation.v1",
    owner_package: "app/package.json",
    check_script: "check",
  };
  await writeFile(join(app, "package.json"), JSON.stringify(pkg));
  await writeFile(join(app, "check.ts"), "process.exit(0);");
  await writeFile(
    join(app, "server.ts"),
    'console.log("synthetic module listening"); Bun.serve({ hostname: process.env.LAZURIO_RUNTIME_LISTENER_WEB_HOST, port: Number(process.env.LAZURIO_RUNTIME_LISTENER_WEB_PORT), fetch: () => new Response("synthetic module") });',
  );
  const install = Bun.spawn([process.execPath, "install", "--lockfile-only"], {
    cwd: app,
    env: { HOME: join(folder, ".."), PATH: "/usr/bin:/bin" },
    stdout: "ignore",
    stderr: "pipe",
  });
  expect(await install.exited).toBe(0);
  return port;
}

// A Linux host over the in-memory user manager: a started unit's main
// process (pid 4242) listens on the declared port and answers its health.
async function linuxHost(
  manager: ReturnType<typeof createFakeServiceManager>,
  home: string,
  port: number,
): Promise<ModuleHost> {
  return {
    platform: "linux",
    home,
    path: "/usr/bin:/bin",
    runtimeDirectory: manager.runtimeDirectory,
    platformExecutable: binary,
    bunExecutable: process.execPath,
    runnerKind: async () => "systemd-user",
    createRunner: (_kind, organizationDirectory) =>
      createSystemdUserRunner({
        organizationDirectory,
        runtimeDirectory: manager.runtimeDirectory,
        run: manager.run,
        controlGroupEmpty: manager.controlGroupEmpty,
        confirmStopMs: 200,
        sleep: () => Bun.sleep(1),
        observeBindings: async () => ({
          kind: "observed",
          bindings: [...manager.units.values()].some(
            (unit) => unit.active === "active",
          )
            ? [
                {
                  pid: 4242,
                  group: 4242,
                  uid: 1000,
                  fd: 3,
                  host: "127.0.0.1",
                  port,
                },
              ]
            : [],
        }),
        probeHealth: async () => ({ kind: "responding", status: 200 }),
        processControlGroup: async (pid) =>
          pid === 4242
            ? `${manager.slice}/${[...manager.units.keys()][0]}`
            : "/user.slice/user-1000.slice/session-3.scope",
      }),
    readJournal: (unit, lines) =>
      readApplicationJournal(manager.run, unit, lines),
  };
}

// Local Launchpad requests with the fragment token, as the page sends them.
function client(app: Awaited<ReturnType<typeof startLaunchpad>>) {
  const url = new URL(app.url);
  const headers = {
    Origin: url.origin,
    Authorization: `Bearer ${url.hash.slice(1)}`,
  };
  const path = (name: string, verb: string) => {
    const [organization, module] = name.split("/") as [string, string];
    return `${url.origin}/api/modules/${encodeURIComponent(organization)}/${encodeURIComponent(module)}/${verb}`;
  };
  return {
    async status(name: string, app?: string) {
      const response = await fetch(
        `${path(name, "status")}${app === undefined ? "" : `?app=${encodeURIComponent(app)}`}`,
        { headers: { Authorization: headers.Authorization } },
      );
      return { code: response.status, body: await response.json() };
    },
    async post(name: string, verb: "start" | "stop", body: unknown = {}) {
      const response = await fetch(path(name, verb), {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return { code: response.status, body: await response.json() };
    },
  };
}

posixTest(
  "refusals are typed and equal in the CLI and over HTTP: ambiguous slug, a module that cannot run, unknown Organization, module and app",
  async () => {
    await folderFixture(async (folder) => {
      const home = join(folder, "..", "home");
      await mkdir(home);
      // A second directory declaring the slug beta makes beta ambiguous.
      const organizations = join(folder, "organizations");
      await cp(join(organizations, "beta"), join(organizations, "beta-copy"), {
        recursive: true,
      });
      const manager = createFakeServiceManager({
        runtimeDirectory: join(folder, "..", "runtime"),
      });
      const host = await linuxHost(manager, home, 1);
      const context = cliContext(home);
      const cli = async (...args: string[]) => {
        const result = await runModuleCommand(
          ["module", ...args, "--folder", folder, "--json"],
          context,
          host,
        );
        return { code: result.code, body: JSON.parse(result.text) };
      };
      const app = await startLaunchpad(
        folder,
        undefined,
        undefined,
        undefined,
        {},
        undefined,
        {},
        host,
      );
      try {
        const http = client(app);
        const cases: [string, string[], Record<string, unknown>][] = [
          [
            "beta/api",
            [],
            {
              reason: "organization-ambiguous",
              organization: "beta",
              candidates: ["beta", "beta-copy"],
            },
          ],
          ["alpha/docs", [], { reason: "no-app", organization: "alpha" }],
          ["alpha/shop", [], { reason: "default-app-invalid", module: "shop" }],
          // A template never runs; an unreadable Organization keeps its
          // reason: neither lists modules to name.
          ["starter/web", [], { reason: "template-not-runtime" }],
          ["broken/web", [], { reason: "organization-conflict" }],
          ["nobody/web", [], { reason: "organization-unknown" }],
          ["alpha/nothing", [], { reason: "module-unknown" }],
          [
            "alpha/web",
            ["--app", "other/package.json"],
            { reason: "app-unknown", app: "other/package.json" },
          ],
          // The default app's fault does not excuse an undeclared named app.
          [
            "alpha/shop",
            ["--app", "app/package.json"],
            { reason: "app-not-runnable" },
          ],
        ];
        for (const [name, extra, expected] of cases)
          for (const verb of ["start", "stop", "status"] as const) {
            const fromCli = await cli(verb, name, ...extra);
            expect(fromCli.code, `${verb} ${name}`).toBe(2);
            expect(fromCli.body, `${verb} ${name}`).toMatchObject({
              kind: "blocked",
              operation: verb,
              ...expected,
            });
            const body = extra.length === 0 ? {} : { app: extra[1] };
            const fromHttp =
              verb === "status"
                ? await http.status(name, extra[1])
                : await http.post(name, verb, body);
            expect(fromHttp.code, `${verb} ${name}`).toBe(409);
            expect(fromHttp.body, `${verb} ${name}`).toEqual(fromCli.body);
          }
        expect(await cli("logs", "alpha/docs")).toMatchObject({
          code: 2,
          body: { kind: "blocked", operation: "logs", reason: "no-app" },
        });
        // Nothing reached the service manager.
        expect(manager.calls).toEqual([]);
        // A name that is not <Organization>/<module> is refused as such.
        expect((await cli("status", "alpha")).body.reason).toBe(
          "module-name-invalid",
        );
        await expect(
          runModuleCommand(["module", "status"], context, host),
        ).rejects.toThrow("Usage");
        await expect(
          runModuleCommand(
            ["module", "stop", "alpha/web", "--lines", "5"],
            context,
            host,
          ),
        ).rejects.toThrow("Usage");
        // Routes: GET only for status, POST only for start and stop.
        const url = new URL(app.url);
        const auth = { Authorization: `Bearer ${url.hash.slice(1)}` };
        expect(
          (
            await fetch(`${url.origin}/api/modules/alpha/web/start`, {
              headers: auth,
            })
          ).status,
        ).toBe(405);
        expect(
          (
            await fetch(`${url.origin}/api/modules/alpha/web/status`, {
              method: "POST",
              headers: {
                ...auth,
                Origin: url.origin,
                "Content-Type": "application/json",
              },
              body: "{}",
            })
          ).status,
        ).toBe(405);
        expect(
          (await fetch(`${url.origin}/api/modules/alpha/web/status`)).status,
        ).toBe(403);
        expect((await http.post("alpha/web", "start", { app: 1 })).code).toBe(
          400,
        );
        expect(
          (await http.post("alpha/web", "start", { extra: true })).code,
        ).toBe(400);
      } finally {
        await app.close();
      }
    });
  },
  30_000,
);

posixTest(
  "Linux: start, status, logs and stop through the user manager, equal from the CLI and the Launchpad, surviving a Launchpad restart",
  async () => {
    await folderFixture(async (folder) => {
      const home = join(folder, "..", "home");
      await mkdir(home);
      const port = await runnable(folder, "alpha_GEN3", "web");
      const manager = createFakeServiceManager({
        runtimeDirectory: join(folder, "..", "runtime"),
      });
      await mkdir(manager.runtimeDirectory);
      const host = await linuxHost(manager, home, port);
      const context = cliContext(home);
      const cli = async (...args: string[]) => {
        const result = await runModuleCommand(
          ["module", ...args, "--folder", folder, "--json"],
          context,
          host,
        );
        return { code: result.code, body: JSON.parse(result.text) };
      };
      const launchpad = () =>
        startLaunchpad(
          folder,
          undefined,
          undefined,
          undefined,
          {},
          undefined,
          {},
          host,
        );
      // Nothing runs yet.
      const stopped = {
        kind: "module",
        operation: "status",
        organization: "alpha",
        module: "web",
        app: "app/package.json",
        runner: "systemd-user",
        survivesLaunchpadRestart: true,
        outcome: "not-managed",
        state: "stopped",
        healthy: false,
        service: null,
        runtime: null,
      };
      expect(await cli("status", "alpha/web")).toEqual({
        code: 0,
        body: stopped,
      });
      const first = await launchpad();
      let invocation = "";
      try {
        const http = client(first);
        expect(await http.status("alpha/web")).toEqual({
          code: 200,
          body: stopped,
        });
        // Start from the page: the module's default app as a transient unit.
        const started = await http.post("alpha/web", "start");
        expect(started.code).toBe(200);
        const unit = applicationUnitName(
          join(folder, "organizations", "alpha_GEN3"),
          { company: "alpha", module: "web", package: "app/package.json" },
        );
        expect(started.body).toMatchObject({
          kind: "module",
          operation: "start",
          outcome: "started",
          state: "running",
          healthy: true,
          service: { unit },
          // A workstation Folder: the loopback address the app listens on.
          runtime: { url: `http://127.0.0.1:${port}/` },
        });
        invocation = started.body.service.invocationId;
        const [run] = manager.commands("systemd-run");
        expect(run?.args).toContain("--property=StandardOutput=journal");
        expect(run?.args).toContain(`--setenv=HOME=${home}`);
        expect(run?.args.at(-4)).toBe(process.execPath);
        // The CLI sees exactly what the page sees.
        const fromCli = await cli("status", "alpha/web");
        const fromHttp = await http.status("alpha/web");
        expect(fromCli.code).toBe(0);
        expect(fromHttp.code).toBe(200);
        expect(fromCli.body).toEqual(fromHttp.body);
        expect(fromCli.body).toMatchObject({
          outcome: "status",
          state: "running",
          healthy: true,
          service: { unit, invocationId: invocation },
          runtime: { url: `http://127.0.0.1:${port}/` },
        });
        // A second start from the CLI finds it running; nothing new starts.
        expect(await cli("start", "alpha/web")).toMatchObject({
          code: 0,
          body: {
            outcome: "already-managed",
            service: { invocationId: invocation },
          },
        });
        expect(manager.commands("systemd-run")).toHaveLength(1);
        manager.log(unit, "synthetic module listening", "request served");
        expect(await cli("logs", "alpha/web", "--lines", "1")).toEqual({
          code: 0,
          body: {
            kind: "module-logs",
            organization: "alpha",
            module: "web",
            app: "app/package.json",
            unit,
            lines: ["request served"],
          },
        });
        expect(
          (
            await runModuleCommand(
              ["module", "logs", "alpha/web", "--folder", folder],
              context,
              host,
            )
          ).text,
        ).toBe("synthetic module listening\nrequest served");
      } finally {
        expect(await first.close()).toEqual({ kind: "closed" });
      }
      // A Launchpad restart leaves the unit alone: the same invocation runs.
      expect(manager.commands("stop")).toEqual([]);
      const second = await launchpad();
      try {
        const http = client(second);
        expect((await http.status("alpha/web")).body).toMatchObject({
          state: "running",
          service: { invocationId: invocation },
        });
        // Stop from the CLI, then the page sees it stopped.
        expect(await cli("stop", "alpha/web")).toEqual({
          code: 0,
          body: {
            ...stopped,
            operation: "stop",
            outcome: "group-stopped",
          },
        });
        expect(await http.status("alpha/web")).toEqual({
          code: 200,
          body: stopped,
        });
        // Stopping again is idempotent; the journal outlives the unit.
        expect((await http.post("alpha/web", "stop")).body).toMatchObject({
          outcome: "not-managed",
          state: "stopped",
        });
        expect((await cli("logs", "alpha/web")).body.lines).toEqual([
          "synthetic module listening",
          "request served",
        ]);
      } finally {
        expect(await second.close()).toEqual({ kind: "closed" });
      }
      // A missing standard Bun refuses the start before any effect.
      const bare = { ...host, bunExecutable: undefined };
      expect(
        (
          await runModuleCommand(
            ["module", "start", "alpha/web", "--folder", folder, "--json"],
            context,
            bare,
          )
        ).result,
      ).toEqual({
        kind: "blocked",
        operation: "start",
        reason: "toolchain-missing",
        organization: "alpha",
        module: "web",
        app: "app/package.json",
        tool: "bun",
        expected: "~/.local/bin/bun",
      });
      expect(manager.commands("systemd-run")).toHaveLength(1);
    });
  },
  60_000,
);

posixTest(
  "hosted: the link is the recorded entry's module origin, never a loopback address; without an entry there is no link",
  async () => {
    for (const recorded of ["entry", "no-entry"] as const) {
      const parent = await realpath(
        await mkdtemp(join(root, `hosted-${recorded}-`)),
      );
      const folder = join(parent, "Lazurio");
      await mkdir(folder);
      await mkdir(join(folder, "organizations"), { mode: 0o755 });
      const preset = "hosted-organization-personal";
      const machine =
        recorded === "entry" ? organizationWithEntry() : bindings.organization;
      await initializeHandoverFolder(folder, {
        preset,
        machine,
        profile: presetProfile(preset, executionOs(process.platform)),
      });
      await writeOrganization(folder, "gamma", {
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
      const host = await linuxHost(manager, home, port);
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
      });
      const status = await run("status", "gamma/notes");
      const template = machine.entry?.moduleOriginTemplate;
      if (recorded === "entry") {
        if (template === undefined) throw new Error("Fixture has an entry");
        // The recorded template with the gateway's label of the id in its slot.
        expect(status).toMatchObject({
          healthy: true,
          runtime: { url: `${moduleOrigin(template, "notes")}/` },
        });
        expect(status).toMatchObject({
          runtime: { url: "https://notes.workspace.example.lazurio.io/" },
        });
      } else
        expect(status).toMatchObject({
          healthy: true,
          runtime: null,
          runtimeReason: "hosted-entry-missing",
        });
      expect(JSON.stringify(status)).not.toContain("127.0.0.1");
      await run("stop", "gamma/notes");
      await rm(parent, { recursive: true, force: true });
    }
  },
  60_000,
);

posixTest(
  "session (macOS): the Launchpad holds the app as its child; the CLI cannot reach it and no output is kept",
  async () => {
    await folderFixture(async (folder) => {
      const home = join(folder, "..", "home");
      await mkdir(home);
      const port = await runnable(folder, "alpha_GEN3", "web");
      const host: ModuleHost = {
        platform: "darwin",
        home,
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
      const context = cliContext(home);
      const app = await startLaunchpad(
        folder,
        undefined,
        undefined,
        undefined,
        {},
        undefined,
        {},
        host,
      );
      let closed = false;
      try {
        const http = client(app);
        const started = await http.post("alpha/web", "start");
        expect(started).toMatchObject({
          code: 200,
          body: {
            outcome: "started",
            runner: "session",
            survivesLaunchpadRestart: false,
            service: null,
          },
        });
        // Readiness is observed, not assumed: poll the status briefly.
        let status = (await http.status("alpha/web")).body;
        for (let attempt = 0; attempt < 50 && !status.healthy; attempt++) {
          await Bun.sleep(100);
          status = (await http.status("alpha/web")).body;
        }
        expect(status).toMatchObject({
          state: "running",
          healthy: true,
          runtime: { url: `http://127.0.0.1:${port}/` },
        });
        expect(await (await fetch(status.runtime.url)).text()).toBe(
          "synthetic module",
        );
        // The CLI is another process: it cannot see or stop a session app.
        for (const verb of ["start", "stop", "status"])
          expect(
            (
              await runModuleCommand(
                ["module", verb, "alpha/web", "--folder", folder, "--json"],
                context,
                host,
              )
            ).result,
          ).toMatchObject({ kind: "blocked", reason: "launchpad-required" });
        expect(
          (
            await runModuleCommand(
              ["module", "logs", "alpha/web", "--folder", folder, "--json"],
              context,
              host,
            )
          ).result,
        ).toMatchObject({ kind: "blocked", reason: "logs-unavailable" });
        // The app ends with its Launchpad.
        expect(await app.close()).toEqual({ kind: "closed" });
        closed = true;
        await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
      } finally {
        if (!closed) await app.close();
      }
    });
  },
  60_000,
);
