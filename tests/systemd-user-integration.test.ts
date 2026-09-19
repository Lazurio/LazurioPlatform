import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createApplicationLifecycle } from "../src/modules/lifecycle";
import {
  createServiceManagerProcess,
  isControlGroupEmpty,
  userManagerState,
} from "../src/modules/service-manager-process";
import {
  applicationUnitName,
  createSystemdUserRunner,
} from "../src/modules/systemd-user-runner";

// REAL systemd user manager, when this Machine has one. Transient units only:
// nothing is written to the account's unit directories, and every unit this test
// creates is stopped and reset again. The manager is reached through its runtime
// directory alone; HOME and the other XDG directories point at a temporary tree.
const runtimeDirectory = process.env.XDG_RUNTIME_DIR ?? "";
const state =
  process.platform === "linux" && runtimeDirectory.startsWith("/")
    ? await userManagerState(createServiceManagerProcess(runtimeDirectory))
    : null;
const available = ["running", "degraded", "starting"].includes(state ?? "");
if (!available)
  console.log(
    `SKIP systemd user service integration: no reachable user service manager (platform ${process.platform}, XDG_RUNTIME_DIR ${runtimeDirectory ? "set" : "unset"}, manager ${state ?? "not answering"}). This is not a failure.`,
  );
const managerTest = test.skipIf(!available);

const saved: Record<string, string | undefined> = {};
let root = "";
beforeAll(async () => {
  if (!available) return;
  root = await realpath(await mkdtemp(join(tmpdir(), "systemd-integration-")));
  for (const name of [
    "HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
  ]) {
    saved[name] = process.env[name];
    process.env[name] = join(root, "account", name.toLowerCase());
  }
});
afterAll(async () => {
  for (const [name, value] of Object.entries(saved))
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  if (root) await rm(root, { recursive: true, force: true });
});

// Arguments the manager must deliver literally, never expand.
const literalArguments = ["$HOME", `$${"{XDG_RUNTIME_DIR}"}`, "%h"];

const selection = {
  company: "Example",
  module: "fixture",
  package: "app/package.json",
};

managerTest(
  "a real user service survives its owner, is rediscovered by identity and stops with its control group",
  async () => {
    const reservation = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("unrelated"),
    });
    const port = reservation.port as number;
    await reservation.stop(true);
    const organization = join(root, "Organization");
    const moduleDirectory = join(organization, "workspace/fixture");
    await mkdir(join(moduleDirectory, "app"), { recursive: true, mode: 0o700 });
    await writeFile(
      join(moduleDirectory, "lazurio.module.json"),
      JSON.stringify({
        schema_version: "lazurio.module.v1",
        id: "fixture",
        company: "Example",
        tcp_port_policy: { mode: "single" },
        port_leases: [{ id: "main", host: "127.0.0.1", port }],
        apps: ["app/package.json"],
        default_app: "app/package.json",
      }),
      { mode: 0o600 },
    );
    await writeFile(
      join(moduleDirectory, "app/package.json"),
      JSON.stringify({
        scripts: { dev: "fixture" },
        lazurio: {
          runtime: {
            schema_version: "lazurio.runtime.v1",
            id: "fixture-app",
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
                health: { kind: "http", path: "/" },
              },
            ],
          },
        },
      }),
      { mode: 0o600 },
    );
    const run = createServiceManagerProcess(runtimeDirectory);
    const unit = applicationUnitName(organization, selection);
    let exit: string | null = null;
    const owner = () =>
      createApplicationLifecycle({
        runner: createSystemdUserRunner({
          organizationDirectory: organization,
          runtimeDirectory,
          run,
        }),
        authorize: async () => ({ moduleDirectory }),
        prepareLaunch: async (_plan, cwd) => ({
          executable: process.execPath,
          args: [
            "--no-env-file",
            resolve("tests/fixtures/service-app.ts"),
            ...literalArguments,
          ],
          cwd,
          env: {
            PATH: "/usr/bin:/bin",
            HOME: join(root, "application-home"),
            FIXTURE_PORT: String(port),
            ...(exit === null ? {} : { FIXTURE_EXIT: exit }),
          },
        }),
        preflightPreparation: async () => ({
          run: async () => ({ kind: "prepared" as const }),
          close: async () => ({ kind: "closed" as const }),
        }),
      });
    const show = async (property: string) =>
      (
        await run(
          "systemctl",
          ["--user", "show", "--value", `--property=${property}`, "--", unit],
          { timeoutMs: 5000 },
        )
      ).stdout.trim();
    const healthy = async (lifecycle: ReturnType<typeof owner>) => {
      const deadline = performance.now() + 15_000;
      let status = await lifecycle.status(selection);
      while (
        !(status.kind === "status" && status.observedHealthy) &&
        performance.now() < deadline
      ) {
        await Bun.sleep(100);
        status = await lifecycle.status(selection);
      }
      return status;
    };
    const first = owner();
    try {
      expect(await first.start(selection)).toEqual({ kind: "started" });
      const started = await healthy(first);
      expect(started).toMatchObject({
        kind: "status",
        runner: "systemd-user",
        survivesLaunchpadRestart: true,
        state: "running",
        observedHealthy: true,
        service: { unit, activeState: "active" },
      });
      if (started.kind !== "status" || !("service" in started))
        throw new Error("Expected service identity");
      const invocation = started.service?.invocationId;
      expect(invocation).toMatch(/^[0-9a-f]{32}$/);
      expect(await show("InvocationID")).toBe(invocation as string);
      const evidence = (await (
        await fetch(`http://127.0.0.1:${port}/evidence`)
      ).json()) as {
        environment: string[];
        arguments: string[];
        descendant: number;
        umask: string;
      };
      // The declared environment plus the manager's invocation id, nothing else:
      // no session bus, no agent socket, no login environment.
      expect(evidence.environment).toEqual([
        "FIXTURE_PORT",
        "HOME",
        "INVOCATION_ID",
        "PATH",
      ]);
      expect(evidence.arguments).toEqual(literalArguments);
      expect(evidence.umask).toBe("77");
      const controlGroup = await show("ControlGroup");
      expect(await isControlGroupEmpty(controlGroup)).toBe(false);
      expect(await first.start(selection)).toEqual({ kind: "already-managed" });
      expect(await first.prepare(selection)).toEqual({
        kind: "application-running",
      });

      // The owner goes away; the application does not.
      expect(await first.close()).toEqual({ kind: "closed" });
      expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe(
        "synthetic service application",
      );

      const second = owner();
      const rediscovered = await healthy(second);
      expect(rediscovered).toMatchObject({
        kind: "status",
        observedHealthy: true,
        service: { invocationId: invocation },
      });
      expect(await second.entrypoint(selection)).toEqual({
        kind: "local-entrypoint",
        url: `http://127.0.0.1:${port}/`,
      });
      expect(await second.stop(selection)).toEqual({ kind: "group-stopped" });
      expect(await second.status(selection)).toEqual({ kind: "not-managed" });
      expect(await isControlGroupEmpty(controlGroup)).toBe(true);
      // The descendant left the process group but not the control group.
      expect(() => process.kill(evidence.descendant, 0)).toThrow();
      await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();

      // A crashed application is reported with the manager's result, not
      // resurrected; the next Start clears the failed record itself.
      exit = "3";
      expect(await second.start(selection)).toEqual({ kind: "started" });
      const deadline = performance.now() + 10_000;
      let ended = await second.status(selection);
      while (
        !(ended.kind === "status" && ended.state === "ended") &&
        performance.now() < deadline
      ) {
        await Bun.sleep(100);
        ended = await second.status(selection);
      }
      expect(ended).toMatchObject({
        kind: "status",
        state: "ended",
        result: "exit-code",
        observedHealthy: false,
      });
      expect(await show("ActiveState")).toBe("failed");
      exit = null;
      expect(await second.start(selection)).toEqual({ kind: "started" });
      const restarted = await healthy(second);
      expect(restarted).toMatchObject({ observedHealthy: true });
      if (restarted.kind !== "status" || !("service" in restarted))
        throw new Error("Expected service identity");
      expect(restarted.service?.invocationId).not.toBe(invocation);
      expect(await second.stop(selection)).toEqual({ kind: "group-stopped" });
      expect(await second.close()).toEqual({ kind: "closed" });
    } finally {
      await run("systemctl", ["--user", "stop", "--", unit], {
        timeoutMs: 20_000,
      });
      await run("systemctl", ["--user", "reset-failed", "--", unit], {
        timeoutMs: 5000,
      });
    }
    expect(await show("LoadState")).toBe("not-found");
  },
  90_000,
);
