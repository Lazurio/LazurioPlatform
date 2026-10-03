import { afterAll, beforeAll, expect, test } from "bun:test";
import { lstat, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeFolder } from "../src/folder/initialize-folder";
import { executionOs } from "../src/folder/platform";
import { startLaunchpad } from "../src/launchpad/server";
import { runModuleCommand } from "../src/modules/module-cli";
import {
  createModuleOperations,
  type ModuleHost,
} from "../src/modules/module-operations";
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

// Decision F32 (#114, #116) through its consumers: `lazurio module start`
// and `prepare`, and the Launchpad's module routes, over modules whose app
// declares `lazurio.preparation` as the Lazurio Module Standard requires. A
// fresh checkout has a lockfile and no `node_modules`; its start runs the
// frozen install from the lockfile beside the package (a no-op when
// node_modules matches it), the declared check, and only when the check fails
// the declared prepare_script and the check again. The real Bun, the compiled
// process guard, the in-memory user manager and a session Launchpad; the only
// dependency is a local `file:` package, so nothing needs the network.
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
// - stale: node_modules installed for an earlier lockfile (as after a pull
//   that added or bumped a dependency) and a check that passes anyway;
// - broken: a prepare_script that fails;
// - unlocked: a package that no longer matches its lockfile;
// - stubborn: a check that still fails after the preparation;
// - plain: no declaration (the default preparation, F25).
const ids = [
  "fresh",
  "ready",
  "stale",
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
      stale: await undeclaredModule(
        join(organization, "workspace", "stale"),
        home,
        { stale: true },
      ),
    };
    // stale: the standard declaration over the earlier install, with a check
    // that passes on it and a prepare_script that leaves a trace.
    const stale = JSON.parse(
      await readFile(join(app("stale"), "package.json"), "utf8"),
    );
    stale.scripts.check = `"${process.execPath}" --no-env-file -e "process.exit(0)"`;
    stale.scripts["prepare:app"] =
      `"${process.execPath}" --no-env-file -e "require('node:fs').writeFileSync('prepared', 'yes')"`;
    stale.lazurio.preparation = {
      schema_version: "lazurio.preparation.v1",
      owner_package: "app/package.json",
      check_script: "check",
      prepare_script: "prepare:app",
    };
    await writeFile(join(app("stale"), "package.json"), JSON.stringify(stale));
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
  "a declared preparation's start installs, checks, runs prepare_script only when the check fails, and names the step that failed",
  async () => {
    await world(async ({ app, manager, run }) => {
      const where = (module: Id) => ({ organization: "delta", module });
      const units = () => manager.commands("systemd-run").length;

      // fresh: install, check fails, prepare_script, check passes, start.
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
      // Prepared: the next start's install changes nothing, one check, no
      // prepare_script.
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

      // ready: the install comes first (decision F32); a check that passes
      // after it means no prepare_script.
      expect((await run("start", "ready")).result).toMatchObject({
        outcome: "started",
        healthy: true,
      });
      expect(
        await exists(join(app("ready"), "node_modules/fixture-dependency")),
      ).toBe(true);
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

      // unlocked: the frozen install failed; neither the check nor
      // prepare_script ran.
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
      expect(await traces(app("unlocked"), "checks")).toBe("");

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

const servedDependency = async (app: string) =>
  JSON.parse(
    await readFile(
      join(app, "node_modules/fixture-dependency/package.json"),
      "utf8",
    ),
  ).version;

// The failure of #114's last comment: a check that passes on a tree installed
// for an earlier lockfile. The start's install repairs it before the check,
// so the real app (a child of the Launchpad session) serves the dependency
// the lockfile pins, and prepare_script does not run.
posixTest(
  "a stale tree whose check passes is installed by the start and the app serves the current dependency",
  async () => {
    await world(async ({ folder, app, host }) => {
      expect(await servedDependency(app("stale"))).toBe("1.0.0");
      const session: ModuleHost = {
        ...host("stale"),
        platform: "darwin",
        runtimeDirectory: undefined,
        runnerKind: async () => "session",
        createRunner: () => createSessionRunner(binary),
        readJournal: async () => {
          throw new Error("A session app has no journal");
        },
      };
      const launchpad = await startLaunchpad(
        folder,
        undefined,
        undefined,
        undefined,
        {},
        undefined,
        {},
        undefined,
        session,
      );
      try {
        const url = new URL(launchpad.url);
        const headers = {
          Origin: url.origin,
          Authorization: `Bearer ${url.hash.slice(1)}`,
        };
        const route = (verb: string) =>
          `${url.origin}/api/modules/delta/stale/${verb}`;
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
        const port = JSON.parse(
          await readFile(join(app("stale"), "../lazurio.module.json"), "utf8"),
        ).port_leases[0].port;
        expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe(
          "current",
        );
        expect(await servedDependency(app("stale"))).toBe("2.0.0");
        expect(await exists(join(app("stale"), "prepared"))).toBe(false);
        const stopped = await fetch(route("stop"), {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: "{}",
        });
        expect(await stopped.json()).toMatchObject({
          outcome: "group-stopped",
        });
      } finally {
        expect(await launchpad.close()).toEqual({ kind: "closed" });
      }
    });
  },
  120_000,
);

// Decision F32 point 2: the Launchpad's routes answer within their deadline,
// counted from naming the module, so a start that waits in the Organization's
// queue behind another operation (or for a lock, or installs) still gets an
// answer before the transport gives up; the operation goes on. Shortened
// budgets: a preparation whose check takes 4 s holds the queue, answers are
// due after 0.5 s. (The in-memory user manager runs one app at a time, so the
// queue is held by a preparation, which starts nothing.)
posixTest(
  "the routes' deadline covers the queue: a start waiting behind another operation answers start-pending in time, goes on, and the route says 202",
  async () => {
    await world(async ({ folder, app, host, manager }) => {
      await writeFile(
        join(app("ready"), "check.ts"),
        "await Bun.sleep(4000); process.exit(0);",
      );
      const operations = createModuleOperations({
        folder,
        owner: "launchpad",
        host: host("fresh"),
      });
      try {
        const began = performance.now();
        const holding = operations.prepare(
          "delta/ready",
          {},
          { answerWithinMs: 500 },
        );
        await Bun.sleep(100);
        const queued = operations.start(
          "delta/fresh",
          {},
          { answerWithinMs: 500 },
        );
        const [first, second] = await Promise.all([holding, queued]);
        // Both answered while the preparation's check still held the queue.
        expect(performance.now() - began).toBeLessThan(3_000);
        expect(first).toMatchObject({
          kind: "module",
          operation: "prepare",
          module: "ready",
          outcome: "prepare-pending",
          state: "stopped",
        });
        expect(second).toMatchObject({
          kind: "module",
          operation: "start",
          module: "fresh",
          outcome: "start-pending",
          state: "stopped",
          healthy: false,
        });
        expect(await exists(join(app("ready"), "prepared"))).toBe(false);
        // Both go on: the preparation ends, then the queued start installs,
        // prepares and starts its app.
        let status = await operations.status("delta/fresh");
        for (
          let attempt = 0;
          attempt < 600 && !(status.kind === "module" && status.healthy);
          attempt++
        ) {
          await Bun.sleep(100);
          status = await operations.status("delta/fresh");
        }
        expect(status).toMatchObject({ state: "running", healthy: true });
        expect(await traces(app("ready"), "prepared")).toBe("yes");
        expect(manager.commands("systemd-run")).toHaveLength(1);
        expect(await operations.stop("delta/fresh")).toMatchObject({
          outcome: "group-stopped",
        });
        // Without a deadline (the CLI's way) the call waits for the result.
        expect(await operations.prepare("delta/ready")).toMatchObject({
          outcome: "prepared",
        });
      } finally {
        expect(await operations.close()).toEqual({ kind: "closed" });
      }
      const host2 = host("ready");
      // The route: 202 with the pending answer, then the app runs.
      const launchpad = await startLaunchpad(
        folder,
        undefined,
        undefined,
        undefined,
        { moduleAnswerWithinMs: 500 },
        undefined,
        {},
        undefined,
        host2,
      );
      try {
        const url = new URL(launchpad.url);
        const headers = {
          Origin: url.origin,
          Authorization: `Bearer ${url.hash.slice(1)}`,
        };
        const route = (verb: string) =>
          `${url.origin}/api/modules/delta/ready/${verb}`;
        const started = await fetch(route("start"), {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: "{}",
        });
        expect(started.status).toBe(202);
        expect(await started.json()).toMatchObject({
          kind: "module",
          operation: "start",
          outcome: "start-pending",
        });
        let status: Record<string, unknown> = {};
        for (let attempt = 0; attempt < 600 && !status.healthy; attempt++) {
          status = await (
            await fetch(route("status"), {
              headers: { Authorization: headers.Authorization },
            })
          ).json();
          if (!status.healthy) await Bun.sleep(100);
        }
        expect(status).toMatchObject({ state: "running", healthy: true });
        const stopped = await fetch(route("stop"), {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: "{}",
        });
        expect(await stopped.json()).toMatchObject({
          outcome: "group-stopped",
        });
      } finally {
        expect(await launchpad.close()).toEqual({ kind: "closed" });
      }
    });
  },
  120_000,
);
