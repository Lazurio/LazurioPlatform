import { afterAll, beforeAll, expect, test } from "bun:test";
import { lstat, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeFolder } from "../src/folder/initialize-folder";
import { executionOs } from "../src/folder/platform";
import { startLaunchpad } from "../src/launchpad/server";
import { runModuleCommand } from "../src/modules/module-cli";
import type { ModuleHost } from "../src/modules/module-operations";
import { createSessionRunner } from "../src/modules/session-runner";
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

// Decision F30 (#114, #116) through its consumers: `lazurio module start`
// and `prepare`, and the Launchpad's module routes, over modules whose app
// declares `lazurio.preparation` as the Lazurio Module Standard requires. A
// fresh checkout has a lockfile and no `node_modules`; its start runs the
// declared check, and only when the check fails the Platform's preparation:
// the frozen install from the lockfile beside the package, the declared
// prepare_script, the check again. The real Bun, the compiled process guard
// and the in-memory user manager; the only dependency is a local `file:`
// package, so nothing needs the network.
const supported = ["darwin", "linux"].includes(process.platform);
const posixTest = test.skipIf(!supported);
let root = "";
let binary = "";
beforeAll(async () => {
  if (!supported) return;
  root = await realpath(await mkdtemp(join(tmpdir(), "declared-preparation-")));
  binary = join(root, "platform");
  await compilePlatform(binary);
});
afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

// Ready: the installed dependency and what prepare_script writes. Every run
// of the check leaves a trace, so how often it ran is observable.
const check =
  'import { appendFileSync, existsSync } from "node:fs"; appendFileSync("checks", "c"); process.exit(existsSync("node_modules/fixture-dependency/package.json") && existsSync("prepared") ? 0 : 1);';
// prepare_script runs after the install and never installs itself.
const prepare =
  'import { existsSync } from "node:fs"; if (!existsSync("node_modules/fixture-dependency/package.json")) process.exit(3); await Bun.write("prepared", "yes");';

// The modules of Organization delta:
// - fresh: the standard declaration, a fresh checkout;
// - ready: a check that always passes and a prepare_script that leaves a
//   trace;
// - broken: a prepare_script that fails;
// - unlocked: a package that no longer matches its lockfile;
// - stubborn: a check that still fails after the preparation;
// - plain: no declaration (the default preparation, F25).
const ids = [
  "fresh",
  "ready",
  "broken",
  "unlocked",
  "stubborn",
  "plain",
] as const;
type Id = (typeof ids)[number];

async function world(
  body: (world: {
    folder: string;
    app: (id: Id) => string;
    manager: ReturnType<typeof createFakeServiceManager>;
    run: (
      verb: "start" | "prepare" | "stop" | "status",
      id: Id,
    ) => Promise<Readonly<{ code: number; result: Record<string, unknown> }>>;
    host: (id: Id) => ModuleHost;
    context: CliContext;
  }) => Promise<void>,
) {
  const parent = await realpath(await mkdtemp(join(root, "world-")));
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
      modules: ids.map((id) => ({ id })),
    });
    const home = join(parent, "home");
    await mkdir(home);
    const app = (id: Id) => join(organization, "workspace", id, "app");
    const ports: Record<string, number> = {
      fresh: await runnable(folder, "delta", "fresh", check, prepare),
      ready: await runnable(
        folder,
        "delta",
        "ready",
        "process.exit(0);",
        'await Bun.write("prepared", "yes");',
      ),
      broken: await runnable(
        folder,
        "delta",
        "broken",
        check,
        "process.exit(9);",
      ),
      unlocked: await runnable(folder, "delta", "unlocked", check, prepare),
      stubborn: await runnable(
        folder,
        "delta",
        "stubborn",
        'require("node:fs").appendFileSync("checks", "c"); process.exit(1);',
        prepare,
      ),
      plain: await undeclaredModule(
        join(organization, "workspace", "plain"),
        home,
      ),
    };
    // unlocked: a second local dependency the lockfile does not know.
    const unlocked = JSON.parse(
      await readFile(join(app("unlocked"), "package.json"), "utf8"),
    );
    unlocked.dependencies["fixture-other"] = "file:./other";
    await mkdir(join(app("unlocked"), "other"));
    await writeFile(
      join(app("unlocked"), "other/package.json"),
      JSON.stringify({ name: "fixture-other", version: "1.0.0" }),
    );
    await writeFile(
      join(app("unlocked"), "package.json"),
      JSON.stringify(unlocked),
    );
    const manager = createFakeServiceManager({
      runtimeDirectory: join(parent, "runtime"),
    });
    await mkdir(manager.runtimeDirectory);
    const host = (id: Id) =>
      linuxHost(manager, home, ports[id] as number, binary);
    const context: CliContext = {
      identity: { version: "1.0.0", commit: "0".repeat(40), target: "fixture" },
      platform: process.platform,
      env: { HOME: home },
      executable: join(home, "lazurio"),
      hostedFolder: async () => undefined,
    };
    await body({
      folder,
      app,
      manager,
      host,
      context,
      run: async (verb, id) => {
        const result = await runModuleCommand(
          ["module", verb, `delta/${id}`, "--folder", folder, "--json"],
          context,
          host(id),
        );
        return Object.freeze({
          code: result.code,
          result: result.result as Record<string, unknown>,
        });
      },
    });
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

const exists = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  );
const traces = async (app: string, file: string) =>
  (await exists(join(app, file)))
    ? await readFile(join(app, file), "utf8")
    : "";

posixTest(
  "a declared preparation's start checks, prepares only when the check fails, and names the step that failed",
  async () => {
    await world(async ({ app, manager, run }) => {
      const where = (module: Id) => ({ organization: "delta", module });
      const units = () => manager.commands("systemd-run").length;

      // fresh: check fails, install, prepare_script, check passes, start.
      const fresh = app("fresh");
      const pkg = await readFile(join(fresh, "package.json"), "utf8");
      const lock = await readFile(join(fresh, "bun.lock"), "utf8");
      expect(await exists(join(fresh, "node_modules"))).toBe(false);
      expect(await run("start", "fresh")).toMatchObject({
        code: 0,
        result: {
          kind: "module",
          operation: "start",
          ...where("fresh"),
          outcome: "started",
          healthy: true,
        },
      });
      expect(
        await exists(
          join(fresh, "node_modules/fixture-dependency/package.json"),
        ),
      ).toBe(true);
      expect(await traces(fresh, "prepared")).toBe("yes");
      expect(await traces(fresh, "checks")).toBe("cc");
      expect(await readFile(join(fresh, "package.json"), "utf8")).toBe(pkg);
      expect(await readFile(join(fresh, "bun.lock"), "utf8")).toBe(lock);
      expect(units()).toBe(1);
      // Prepared: the next start checks once and touches nothing.
      expect((await run("stop", "fresh")).result).toMatchObject({
        outcome: "group-stopped",
      });
      await rm(join(fresh, "prepared"));
      await writeFile(join(fresh, "prepared"), "kept");
      expect((await run("start", "fresh")).result).toMatchObject({
        outcome: "started",
      });
      expect(await traces(fresh, "checks")).toBe("ccc");
      expect(await traces(fresh, "prepared")).toBe("kept");
      expect((await run("stop", "fresh")).result).toMatchObject({
        outcome: "group-stopped",
      });

      // ready: a passing check means no install and no prepare_script.
      expect((await run("start", "ready")).result).toMatchObject({
        outcome: "started",
        healthy: true,
      });
      expect(await exists(join(app("ready"), "node_modules"))).toBe(false);
      expect(await exists(join(app("ready"), "prepared"))).toBe(false);
      expect((await run("stop", "ready")).result).toMatchObject({
        outcome: "group-stopped",
      });
      expect(units()).toBe(3);

      // broken: installed, its prepare_script failed, nothing started.
      expect(await run("start", "broken")).toEqual({
        code: 2,
        result: {
          kind: "blocked",
          operation: "start",
          reason: "preparation-script-failed",
          ...where("broken"),
          app: "app/package.json",
          file: "app/package.json",
        },
      });
      expect(
        await exists(join(app("broken"), "node_modules/fixture-dependency")),
      ).toBe(true);
      expect(await traces(app("broken"), "checks")).toBe("c");

      // unlocked: the frozen install failed; prepare_script never ran.
      expect(await run("start", "unlocked")).toEqual({
        code: 2,
        result: {
          kind: "blocked",
          operation: "start",
          reason: "preparation-install-failed",
          ...where("unlocked"),
          app: "app/package.json",
          file: "app/bun.lock",
        },
      });
      expect(await exists(join(app("unlocked"), "prepared"))).toBe(false);
      expect(await traces(app("unlocked"), "checks")).toBe("c");

      // stubborn: prepared, yet its check still fails.
      expect(await run("start", "stubborn")).toEqual({
        code: 2,
        result: {
          kind: "blocked",
          operation: "start",
          reason: "prerequisites-not-ready",
          ...where("stubborn"),
          app: "app/package.json",
        },
      });
      expect(await traces(app("stubborn"), "prepared")).toBe("yes");
      expect(await traces(app("stubborn"), "checks")).toBe("cc");
      expect(units()).toBe(3);

      // fresh again, now with a second app nested in its directory (F25
      // point 6): a start whose check fails never installs beneath it.
      await rm(join(fresh, "node_modules"), { recursive: true });
      await mkdir(join(fresh, "inner"));
      await writeFile(join(fresh, "inner/package.json"), pkg);
      const manifestPath = join(fresh, "../lazurio.module.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      manifest.apps = ["app/package.json", "app/inner/package.json"];
      await writeFile(manifestPath, JSON.stringify(manifest));
      expect((await run("start", "fresh")).result).toEqual({
        kind: "blocked",
        operation: "start",
        reason: "preparation-applications-overlap",
        ...where("fresh"),
        app: "app/package.json",
        file: "app/package.json",
      });
      expect(await exists(join(fresh, "node_modules"))).toBe(false);
      expect(units()).toBe(3);
    });
  },
  120_000,
);

posixTest(
  "lazurio module prepare prepares without starting, whatever the check says, never beneath a running app, and answers like the Launchpad route",
  async () => {
    await world(async ({ folder, app, manager, run, host, context }) => {
      // ready: its check passes, yet an explicit preparation installs and
      // runs prepare_script; nothing starts.
      expect(await run("prepare", "ready")).toMatchObject({
        code: 0,
        result: {
          kind: "module",
          operation: "prepare",
          organization: "delta",
          module: "ready",
          outcome: "prepared",
          state: "stopped",
          healthy: false,
        },
      });
      expect(
        await exists(join(app("ready"), "node_modules/fixture-dependency")),
      ).toBe(true);
      expect(await traces(app("ready"), "prepared")).toBe("yes");
      expect(manager.commands("systemd-run")).toHaveLength(0);
      // The default preparation (F25) is its frozen install.
      expect((await run("prepare", "plain")).result).toMatchObject({
        outcome: "prepared",
      });
      expect(
        await exists(join(app("plain"), "node_modules/fixture-dependency")),
      ).toBe(true);
      // A failing step is named as at the start.
      expect((await run("prepare", "broken")).result).toMatchObject({
        kind: "blocked",
        operation: "prepare",
        reason: "preparation-script-failed",
        file: "app/package.json",
      });
      expect((await run("prepare", "unlocked")).result).toMatchObject({
        reason: "preparation-install-failed",
        file: "app/bun.lock",
      });
      expect((await run("prepare", "stubborn")).result).toMatchObject({
        reason: "prerequisites-not-ready",
      });
      // Running: the app itself is never prepared beneath, and another app
      // of the Organization keeps the explicit preparation waiting.
      expect((await run("start", "ready")).result).toMatchObject({
        outcome: "started",
      });
      expect(await run("prepare", "ready")).toMatchObject({
        code: 2,
        result: { reason: "application-running" },
      });
      expect((await run("prepare", "fresh")).result).toMatchObject({
        reason: "other-app-managed",
      });
      expect(await exists(join(app("fresh"), "node_modules"))).toBe(false);
      // The route answers the CLI's object.
      const launchpad = await startLaunchpad(
        folder,
        undefined,
        undefined,
        undefined,
        {},
        undefined,
        {},
        undefined,
        host("ready"),
      );
      try {
        const url = new URL(launchpad.url);
        const response = await fetch(
          `${url.origin}/api/modules/delta/ready/prepare`,
          {
            method: "POST",
            headers: {
              Origin: url.origin,
              Authorization: `Bearer ${url.hash.slice(1)}`,
              "Content-Type": "application/json",
            },
            body: "{}",
          },
        );
        expect(response.status).toBe(409);
        expect(await response.json()).toEqual(
          (await run("prepare", "ready")).result,
        );
      } finally {
        expect(await launchpad.close()).toEqual({ kind: "closed" });
      }
      expect((await run("stop", "ready")).result).toMatchObject({
        outcome: "group-stopped",
      });
      // A refusal before any effect is named and leaves no retained record:
      // the next preparation is not waiting for a recovery.
      const stubborn = JSON.parse(
        await readFile(join(app("stubborn"), "package.json"), "utf8"),
      );
      const pinned = stubborn.packageManager;
      stubborn.packageManager = "bun@0.0.1";
      await writeFile(
        join(app("stubborn"), "package.json"),
        JSON.stringify(stubborn),
      );
      expect((await run("prepare", "stubborn")).result).toMatchObject({
        reason: "preparation-toolchain-mismatch",
        file: "app/package.json",
      });
      expect(await exists(join(app("stubborn"), ".operation-lock"))).toBe(
        false,
      );
      stubborn.packageManager = pinned;
      await writeFile(
        join(app("stubborn"), "package.json"),
        JSON.stringify(stubborn),
      );
      expect((await run("prepare", "stubborn")).result).toMatchObject({
        reason: "prerequisites-not-ready",
      });
      // Apps owned by the Launchpad session: the CLI cannot see them.
      const session: ModuleHost = {
        ...host("fresh"),
        platform: "darwin",
        runtimeDirectory: undefined,
        runnerKind: async () => "session",
        createRunner: () => createSessionRunner(binary),
      };
      const refused = await runModuleCommand(
        ["module", "prepare", "delta/fresh", "--folder", folder, "--json"],
        context,
        session,
      );
      expect(refused.result).toMatchObject({
        kind: "blocked",
        operation: "prepare",
        reason: "launchpad-required",
      });
      // The terminal names the reason and what to do.
      const text = (
        await runModuleCommand(
          ["module", "start", "delta/broken", "--folder", folder],
          context,
          host("broken"),
        )
      ).text.split("\n");
      expect(text[0]).toBe(
        "delta/broken: preparation-script-failed (app/package.json)",
      );
      expect(text[1]).toContain("prepare_script");
    });
  },
  120_000,
);
