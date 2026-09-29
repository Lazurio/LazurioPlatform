import { expect } from "bun:test";
import { readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ModuleHost } from "../../src/modules/module-operations";
import {
  createSystemdUserRunner,
  readApplicationJournal,
} from "../../src/modules/systemd-user-runner";
import type { createFakeServiceManager } from "./fake-service-manager";
import {
  mkdirOwnedFixture as mkdir,
  writeOwnedFixture as writeFile,
} from "./owned-files";

// Where the module lifecycle tests run a module (launchpad-parity B3, B5):
// the compiled CLI as process guard, a module of the catalog's fixture Folder
// made runnable, and a Linux host over the in-memory user manager.

/** The compiled CLI: the process guard of session apps and of the declared
 * start check, as in the installed product. */
export async function compilePlatform(binary: string) {
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
}

/** A module of the fixture Folder made runnable: an exact Bun, a declared
 * start check (`check`, a script body, passing by default), a lockfile and a
 * dev script serving the declared port. Returns the declared port. */
export async function runnable(
  folder: string,
  directory: string,
  id: string,
  check = "process.exit(0);",
) {
  return runnableModule(
    join(folder, "organizations", directory, "workspace", id),
    join(folder, ".."),
    check,
  );
}

/** `runnable` for any module directory, such as a Personalspace module;
 * `home` is the HOME of the lockfile install. */
export async function runnableModule(
  moduleDirectory: string,
  home: string,
  check = "process.exit(0);",
) {
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
  await writeFile(join(app, "check.ts"), check);
  await writeFile(
    join(app, "server.ts"),
    'console.log("synthetic module listening"); Bun.serve({ hostname: process.env.LAZURIO_RUNTIME_LISTENER_WEB_HOST, port: Number(process.env.LAZURIO_RUNTIME_LISTENER_WEB_PORT), fetch: () => new Response("synthetic module") });',
  );
  const install = Bun.spawn([process.execPath, "install", "--lockfile-only"], {
    cwd: app,
    env: { HOME: home, PATH: "/usr/bin:/bin" },
    stdout: "ignore",
    stderr: "pipe",
  });
  expect(await install.exited).toBe(0);
  return port;
}

/** A module shaped like a real application package that the replaced
 * Launchpad started (issue #97): `lazurio.runtime` with a dev script, its own
 * `bun.lock` beside its package.json and one local `file:` dependency, and
 * neither `lazurio.preparation` nor `packageManager`. Its dev script serves
 * the installed dependency's marker. With `stale`, `node_modules` holds an
 * earlier install of the dependency (1.0.0, `installed-earlier`) than the
 * checkout now has (2.0.0, `current`), as after a pull without an install.
 * `home` is the HOME of the fixture's own installs. Returns the declared
 * port. */
export async function undeclaredModule(
  moduleDirectory: string,
  home: string,
  options: { stale?: boolean } = {},
) {
  const manifest = JSON.parse(
    await readFile(join(moduleDirectory, "lazurio.module.json"), "utf8"),
  );
  const port = manifest.port_leases[0].port as number;
  const app = join(moduleDirectory, "app");
  const pkg = JSON.parse(await readFile(join(app, "package.json"), "utf8"));
  pkg.private = true;
  pkg.dependencies = { "fixture-dependency": "file:./dependency" };
  pkg.scripts = { dev: `"${process.execPath}" --no-env-file server.ts` };
  delete pkg.packageManager;
  delete pkg.lazurio.preparation;
  await writeFile(join(app, "package.json"), JSON.stringify(pkg));
  await writeFile(
    join(app, "server.ts"),
    'import { marker } from "fixture-dependency"; Bun.serve({ hostname: process.env.LAZURIO_RUNTIME_LISTENER_WEB_HOST, port: Number(process.env.LAZURIO_RUNTIME_LISTENER_WEB_PORT), fetch: () => new Response(marker) });',
  );
  const dependency = async (version: string, marker: string) => {
    // New files, never rewritten in place: Bun may hard-link a local
    // package's files into node_modules (issue #93).
    await rm(join(app, "dependency"), { recursive: true, force: true });
    await mkdir(join(app, "dependency"));
    await writeFile(
      join(app, "dependency/package.json"),
      JSON.stringify({ name: "fixture-dependency", version, main: "index.js" }),
    );
    await writeFile(
      join(app, "dependency/index.js"),
      `export const marker = ${JSON.stringify(marker)};\n`,
    );
  };
  const install = async (...args: string[]) => {
    const run = Bun.spawn([process.execPath, "install", ...args], {
      cwd: app,
      env: { HOME: home, PATH: "/usr/bin:/bin" },
      stdout: "ignore",
      stderr: "pipe",
    });
    const [error, code] = await Promise.all([
      new Response(run.stderr).text(),
      run.exited,
    ]);
    expect(code, error).toBe(0);
  };
  if (options.stale) {
    await dependency("1.0.0", "installed-earlier");
    await install();
  }
  await dependency("2.0.0", "current");
  await install("--lockfile-only");
  return port;
}

/** A Linux host over the in-memory user manager: a started unit's main
 * process (pid 4242) listens on the declared port and answers its health. */
export function linuxHost(
  manager: ReturnType<typeof createFakeServiceManager>,
  home: string,
  port: number,
  binary: string,
): ModuleHost {
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
