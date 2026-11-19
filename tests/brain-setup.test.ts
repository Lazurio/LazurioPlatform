import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brainHttp } from "../src/brain/admin";
import { runBrainCommand } from "../src/brain/cli";
import { readBrainState, writeBrainState } from "../src/brain/keys";
import { meaningPin } from "../src/brain/meaning-pin";
import {
  brainPaths,
  brainPin,
  brainRefreshService,
  brainRefreshTimer,
  brainUnit,
  releaseCommand,
} from "../src/brain/pin";
import { brainSetup, keysAfterVault, type SetupHost } from "../src/brain/setup";
import { endStrayWriters, strayWriters } from "../src/brain/writers";
import type { ToolRunner } from "../src/tools/status";
import type { ProcessRunner } from "../src/update/self-check";
import { unitMarker } from "../src/update/service-control";

// `lazurio brain setup` on a Personal Environment (plan LZD-0033 R11a),
// against stand-ins: Bun and `gbrain init` write what they would, systemctl
// is recorded, and a loopback server plays gbrain once its unit is started.
// Fictional tokens; no user manager, network or real brain is touched.

const brain = {
  up: false,
  timer: false,
  version: brainPin.version,
  admin: "",
  keys: [] as { id: string; name: string; token: string; status: string }[],
};
let server: ReturnType<typeof Bun.serve>;
let base: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      if (!brain.up) return new Response("", { status: 503 });
      const url = new URL(request.url);
      const body =
        request.method === "POST" ? await request.json().catch(() => ({})) : {};
      if (url.pathname === "/health")
        return Response.json({ status: "ok", version: brain.version });
      if (url.pathname === "/mcp") {
        const token = (request.headers.get("authorization") ?? "").replace(
          "Bearer ",
          "",
        );
        return new Response("{}", {
          status: brain.keys.some(
            (k) => k.token === token && k.status === "active",
          )
            ? 200
            : 401,
        });
      }
      if (url.pathname === "/admin/login")
        return body.token === brain.admin
          ? new Response("{}", { headers: { "set-cookie": "admin=1; Path=/" } })
          : new Response("{}", { status: 401 });
      if (url.pathname === "/admin/api/api-keys" && request.method === "GET")
        return Response.json(brain.keys);
      if (url.pathname === "/admin/api/api-keys") {
        const key = {
          id: `id-${brain.keys.length + 1}`,
          name: body.name,
          token: `tok-${brain.keys.length + 1}-${"x".repeat(32)}`,
          status: "active",
        };
        brain.keys.push(key);
        return Response.json({ id: key.id, token: key.token });
      }
      if (url.pathname === "/admin/api/api-keys/revoke")
        return Response.json({});
      return new Response("{}", { status: 404 });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});
afterAll(() => server.stop(true));

async function host(
  options: Readonly<{
    installFails?: boolean;
    existingUnit?: string;
    /** Other units of the brain's names, by name. */
    existingUnits?: Readonly<Record<string, string>>;
    /** A brain already here (its config). */
    existingBrain?: boolean;
    noHandover?: boolean;
  }> = {},
) {
  const root = await mkdtemp(join(tmpdir(), "brain-setup-"));
  const paths = brainPaths(join(root, "home"));
  const globalUnits = join(root, "etc-systemd-user");
  await mkdir(globalUnits, { recursive: true });
  // Machines' mark of C1: they hand the brain over on this host.
  const handover = join(root, "brain-handover");
  if (!options.noHandover) await writeFile(handover, "");
  if (options.existingUnit !== undefined) {
    await mkdir(paths.units, { recursive: true });
    await writeFile(join(paths.units, brainUnit), options.existingUnit);
  }
  for (const [name, text] of Object.entries(options.existingUnits ?? {})) {
    await mkdir(paths.units, { recursive: true });
    await writeFile(join(paths.units, name), text);
  }
  if (options.existingBrain) {
    await mkdir(paths.brain, { recursive: true });
    await writeFile(join(paths.brain, "config.json"), '{"brain":"theirs"}');
  }
  brain.up = false;
  brain.timer = false;
  brain.keys = [];
  const calls: string[][] = [];
  /** systemctl verbs that fail, changeable between runs. */
  const failing = new Set<string>();
  const run: ToolRunner = async (command, _timeout, env) => {
    calls.push([...command]);
    if (command[1] === "add") {
      if (options.installFails) return { exitCode: 1, stdout: "", stderr: "" };
      const dir = env.BUN_INSTALL as string;
      const pkg = join(dir, "install", "global", "node_modules", "gbrain");
      await mkdir(pkg, { recursive: true });
      await writeFile(
        join(pkg, "package.json"),
        JSON.stringify({ version: brainPin.version }),
      );
      await mkdir(join(dir, "bin"), { recursive: true });
      await writeFile(join(dir, "bin", "gbrain"), "#!/bin/sh\n", {
        mode: 0o755,
      });
    } else if (command[1] === "init") {
      await mkdir(paths.brain, { recursive: true });
      await writeFile(join(paths.brain, "config.json"), "{}");
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  const service: ProcessRunner = async (command) => {
    calls.push([...command]);
    if (failing.has(command[2] as string))
      return { exitCode: 1, stdout: "", stderr: "" };
    if (command[2] === "stop" && command[3] === brainUnit) brain.up = false;
    if (command.includes(brainRefreshTimer)) {
      if (command[2] === "stop") brain.timer = false;
      if (command[2] === "start" || command.includes("--now"))
        brain.timer = true;
    }
    if (command[2] === "is-active") {
      const on = command.at(-1) === brainUnit ? brain.up : brain.timer;
      return {
        exitCode: on ? 0 : 3,
        stdout: on ? "active\n" : "inactive\n",
        stderr: "",
      };
    }
    if (command[2] === "start" && command[3] === brainUnit) {
      // gbrain does not start without its owner credential, or on a brain
      // a run left half migrated.
      const admin = await readFile(paths.adminToken, "utf8").catch(() => null);
      const config = await readFile(
        join(paths.brain, "config.json"),
        "utf8",
      ).catch(() => null);
      if (admin === null || config === null || config.includes("half"))
        return { exitCode: 1, stdout: "", stderr: "" };
      brain.admin = admin.trim();
      brain.up = true;
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  const setupHost: SetupHost = {
    async context() {
      return { kind: "supported" };
    },
    paths,
    globalUnits,
    handover,
    async health() {
      if (!brain.up) return null;
      return brain.version;
    },
    run,
    service,
    http: brainHttp,
    bun: "/fake/bun",
    // No Personalspace declares a vault yet: the brain stays local.
    vault: {
      folder: join(paths.home, "Lazurio"),
      gh: undefined,
    },
    idle: async () => true,
    env: { HOME: paths.home, PATH: "/usr/bin:/bin" },
    base,
    tries: 3,
    waitMs: 1,
  };
  return { setupHost, paths, calls, failing };
}

describe("brain setup", () => {
  test("a Personal Environment without a brain gets the pinned release, a brain, Lazurio's units and the keys", async () => {
    const { setupHost, paths, calls } = await host();
    const result = await brainSetup(setupHost);
    expect(result.server).toBe("installed");
    expect(result.keys).toEqual({
      launchpad: "minted",
      executor: "minted",
      probe: "minted",
    });
    expect(result.vault).toBe("local");
    expect(result.status).toMatchObject({ state: "running", owner: "lazurio" });
    // Bun installs the pinned commit into its own directory, no root.
    expect(calls.find((c) => c[1] === "add")).toEqual([
      "/fake/bun",
      "add",
      "--global",
      `github:${brainPin.repository}#${brainPin.commit}`,
    ]);
    // The brain is created by the pinned release, without embeddings.
    expect(calls.find((c) => c[1] === "init")).toEqual([
      releaseCommand(paths, brainPin.commit),
      "init",
      "--pglite",
      "--no-embedding",
      "--non-interactive",
    ]);
    // The owner credential: 0600, 64 hex characters, never in a unit.
    expect((await stat(paths.adminToken)).mode & 0o777).toBe(0o600);
    const unit = await readFile(join(paths.units, brainUnit), "utf8");
    expect(unit.startsWith(unitMarker)).toBe(true);
    expect(unit).toContain(
      `exec ${releaseCommand(paths, brainPin.commit)} serve --http --bind 127.0.0.1 --port 3131`,
    );
    expect(unit).not.toContain(brain.admin);
    expect(
      calls
        .filter((c) => c[0] === "systemctl" && !c[2]?.startsWith("is-"))
        .map((c) => c.slice(2)),
    ).toEqual([["daemon-reload"], ["enable", brainUnit], ["start", brainUnit]]);
    expect((await readBrainState(paths)).release).toEqual({
      commit: brainPin.commit,
      version: brainPin.version,
      command: releaseCommand(paths, brainPin.commit),
      source: "lazurio",
    });
  });

  test("a second run changes nothing and keeps every key", async () => {
    const { setupHost } = await host();
    await brainSetup(setupHost);
    const again = await brainSetup(setupHost);
    expect(again.server).toBe("running");
    expect(again.keys).toEqual({
      launchpad: "kept",
      executor: "kept",
      probe: "kept",
    });
  });

  test("until Machines mark the handover on this host, nothing is installed, taken over or minted", async () => {
    const { setupHost, calls, paths } = await host({ noHandover: true });
    const result = await brainSetup(setupHost);
    expect(result).toMatchObject({
      server: "waits-machines",
      status: { state: "not-installed", handover: false },
    });
    expect(calls).toEqual([]);
    expect(
      await stat(paths.units).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  });

  test("a key the brain will not mint makes setup not finished: exit 1", async () => {
    const { setupHost, paths } = await host();
    await brainSetup(setupHost);
    // The owner credential no longer opens a session, and the handed-over
    // key stops working: nothing can be minted.
    await writeFile(paths.adminToken, `${"0".repeat(64)}\n`);
    for (const key of brain.keys) key.status = "revoked";
    const result = await runBrainCommand(["setup"], {
      identity: {} as never,
      platform: "linux",
      env: {},
      executable: "lazurio",
      host: setupHost,
    });
    expect(result.stdout).toContain("key launchpad failed");
    expect(result.code).toBe(1);
  });

  test("a brain already here without a unit is reported, never started or changed", async () => {
    const { setupHost, paths, calls } = await host({ existingBrain: true });
    const result = await brainSetup(setupHost);
    expect(result).toMatchObject({
      server: "existing-brain",
      status: { state: "not-installed", brain: true },
    });
    expect(calls).toEqual([]);
    expect(await readFile(join(paths.brain, "config.json"), "utf8")).toBe(
      '{"brain":"theirs"}',
    );
    expect((await readBrainState(paths)).install).toBeUndefined();
  });

  for (const verb of ["daemon-reload", "enable", "start"])
    test(`an install stopped at ${verb} is resumed by the next run, every step again, and only then recorded`, async () => {
      const { setupHost, paths, calls, failing } = await host();
      failing.add(verb);
      const first = await brainSetup(setupHost);
      expect(first.server).toBe("failed");
      const state = await readBrainState(paths);
      // The brain created under the journal is Lazurio's own: not reported
      // as someone else's, and no release recorded yet.
      expect(state.install?.commit).toBe(brainPin.commit);
      expect(state.release).toBeUndefined();
      failing.clear();
      brain.up = false;
      calls.length = 0;
      const again = await brainSetup(setupHost);
      expect(again.server).toBe("installed");
      expect(
        calls
          .filter((c) => c[0] === "systemctl" && !c[2]?.startsWith("is-"))
          .map((c) => c.slice(2)),
      ).toEqual([
        ["daemon-reload"],
        ["enable", brainUnit],
        ["start", brainUnit],
      ]);
      // The brain is not created twice.
      expect(calls.some((c) => c[1] === "init")).toBe(false);
      const after = await readBrainState(paths);
      expect(after.install).toBeUndefined();
      expect(after.release?.commit).toBe(brainPin.commit);
      expect((await brainSetup(setupHost)).server).toBe("running");
    });

  test("a failed install stops before anything is written or started", async () => {
    const { setupHost, paths, calls } = await host({ installFails: true });
    const result = await brainSetup(setupHost);
    expect(result).toMatchObject({ server: "failed", step: "install" });
    expect(calls.some((c) => c[0] === "systemctl")).toBe(false);
    expect(
      await stat(join(paths.units, brainUnit)).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  });

  test("the interim installer's brain waits for its owner's takeover; a foreign unit is left alone", async () => {
    const interim = `[Service]\nExecStart=/bin/bash -c 'GBRAIN_ADMIN_BOOTSTRAP_TOKEN="$$(cat %h/.gbrain/serve/admin-token)" exec %h/.bun/bin/gbrain serve --http --bind 127.0.0.1 --port 3131 --public-url http://127.0.0.1:3131'\n`;
    const a = await host({ existingUnit: interim });
    expect((await brainSetup(a.setupHost)).server).toBe("waits-takeover");
    expect(a.calls).toEqual([]);
    const b = await host({ existingUnit: "[Service]\nExecStart=/opt/other\n" });
    expect((await brainSetup(b.setupHost)).server).toBe("foreign");
    expect(b.calls).toEqual([]);
  });

  test("a refresh service or timer nobody of these wrote, or one unreadable, leaves the brain alone before anything is installed", async () => {
    for (const name of [brainRefreshService, brainRefreshTimer]) {
      const other = await host({
        existingUnits: { [name]: "[Service]\nExecStart=/opt/other\n" },
      });
      expect((await brainSetup(other.setupHost)).server).toBe("foreign");
      expect(other.calls).toEqual([]);
      expect(await readFile(join(other.paths.units, name), "utf8")).toBe(
        "[Service]\nExecStart=/opt/other\n",
      );
      // A Lazurio marker on it changes nothing.
      const marked = await host({
        existingUnits: {
          [name]: `${unitMarker}\n[Service]\nExecStart=/opt/other\n`,
        },
      });
      expect((await brainSetup(marked.setupHost)).server).toBe("foreign");
      expect(marked.calls).toEqual([]);
    }
    if (process.getuid?.() === 0) return;
    const hidden = await host({
      existingUnits: { [brainRefreshTimer]: "[Timer]\n" },
    });
    await chmod(join(hidden.paths.units, brainRefreshTimer), 0o000);
    const result = await brainSetup(hidden.setupHost);
    await chmod(join(hidden.paths.units, brainRefreshTimer), 0o644);
    expect(result.server).toBe("foreign");
    expect(result.status).toMatchObject({ owner: "unreadable" });
    expect(hidden.calls).toEqual([]);
  });
});

describe("keys after the vault's step", () => {
  const done = { state: "done", at: "2026-11-19T01:00:00.000Z" };
  test("a rebuild that succeeded and was followed by a failed durability or timer still gets its keys", () => {
    for (const failure of ["stop:durability-not-on", "stop:timer-not-on"])
      expect(keysAfterVault(failure as never, undefined, done)).toBe(true);
    expect(
      keysAfterVault(
        "stop:durability,timer-not-on",
        { ...done, at: "x" },
        done,
      ),
    ).toBe(true);
  });
  test("a recovered or rolled-back rebuild gets its keys; an unchanged record does not", () => {
    expect(keysAfterVault("stop:rebuild-interrupted", done, done)).toBe(true);
    expect(keysAfterVault("connected", done, done)).toBe(false);
    expect(keysAfterVault("stop:durability-not-on", done, done)).toBe(false);
    expect(keysAfterVault("local", undefined, undefined)).toBe(false);
  });
});

describe("what a dead run left, before the brain starts", () => {
  const at = "2026-11-19T00:00:00.000Z";

  test("a rebuild that died with ~/.gbrain moved to its copy: setup brings it back before starting anything", async () => {
    const { setupHost, paths } = await host();
    await brainSetup(setupHost);
    // The run died in `moving`: the brain (its owner credential with it) is
    // only in its copy, so its server cannot start.
    const backup = ".gbrain.bak-20261119T000000Z";
    await rename(paths.brain, join(paths.home, backup));
    brain.up = false;
    await writeBrainState(paths, {
      ...(await readBrainState(paths)),
      vault: {
        rebuild: {
          state: "moving",
          at,
          backup,
          vaultDir: join(paths.home, "vault"),
          moveAside: false,
        },
      },
    });
    const result = await brainSetup(setupHost);
    expect(result.server).toBe("running");
    expect(await readFile(join(paths.brain, "config.json"), "utf8")).toBe("{}");
    expect((await readBrainState(paths)).vault?.rebuild?.state).toBe(
      "restored-after-interrupted",
    );
    expect(brain.up && brain.timer).toBe(true);
  });

  test("a switch to search by meaning that died half migrated: the copy comes back though the brain does not start", async () => {
    const { setupHost, paths } = await host();
    await brainSetup(setupHost);
    const backup = ".gbrain.bak-meaning-20261119T000000Z";
    await cp(paths.brain, join(paths.home, backup), { recursive: true });
    await writeFile(join(paths.brain, "config.json"), '{"half":true}');
    brain.up = false;
    await writeBrainState(paths, {
      ...(await readBrainState(paths)),
      meaningAttempt: {
        provider: meaningPin.provider,
        result: "started",
        at,
        backup,
      },
    });
    const result = await brainSetup(setupHost);
    expect(result.server).toBe("running");
    expect(await readFile(join(paths.brain, "config.json"), "utf8")).toBe("{}");
    expect((await readBrainState(paths)).meaningAttempt).toMatchObject({
      result: "restored",
      reason: "interrupted",
    });
  });

  test("a takeover whose way back failed waits for a person, even where Lazurio's unit is in place", async () => {
    const { setupHost, paths, calls } = await host();
    await brainSetup(setupHost);
    await writeBrainState(paths, {
      ...(await readBrainState(paths)),
      takeover: { consent: at, state: "restore-failed-reload", at },
    });
    brain.up = false;
    calls.length = 0;
    const result = await brainSetup(setupHost);
    expect(result).toMatchObject({
      server: "takeover-refused",
      takeover: "restore-failed:reload",
    });
    expect(calls.some((c) => c[2] === "start" || c[1] === "add")).toBe(false);
  });

  // The person's brain runs only on a Remote Environment on Linux (`lazurio
  // brain` is `unsupported` elsewhere), and stray writers are found in
  // /proc: the test runs where that is.
  test.skipIf(process.platform !== "linux")(
    "a gbrain command a dead run left still writing is ended before setup goes on",
    async () => {
      const { setupHost, paths } = await host();
      await brainSetup(setupHost);
      // An embedding of Lazurio's release, in its own process group, as a
      // killed setup leaves it.
      const command = releaseCommand(paths, brainPin.commit);
      const writer = spawn(
        process.execPath,
        ["-e", "setInterval(() => {}, 1000)", command, "embed", "--stale"],
        { detached: true, stdio: "ignore" },
      );
      const ended = new Promise((resolve) => writer.once("exit", resolve));
      const gone = () => writer.exitCode !== null || writer.signalCode !== null;
      // Every wait is bounded well inside the test's own limit (Bun's limit
      // does not cancel the test nor run its `finally`), so a hang fails
      // here and the writer is still killed and reaped.
      const within = <T>(ms: number, what: string, promise: Promise<T>) =>
        Promise.race([
          promise,
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error(`${what}: no end in ${ms} ms`)),
              ms,
            ),
          ),
        ]);
      try {
        await new Promise((resolve) => setTimeout(resolve, 200));
        const result = await within(8_000, "setup", brainSetup(setupHost));
        expect(result.server).toBe("running");
        await within(2_000, "the writer's end", ended);
        expect(gone()).toBe(true);
      } finally {
        if (!gone()) {
          try {
            process.kill(-(writer.pid as number), "SIGKILL");
          } catch {
            writer.kill("SIGKILL");
          }
          await within(2_000, "the writer's reaping", ended).catch(
            () => undefined,
          );
        }
      }
    },
    20_000,
  );

  test("where there is no /proc to read, no writer is found and nothing waits", async () => {
    const paths = brainPaths(await mkdtemp(join(tmpdir(), "brain-writers-")));
    const proc = join(paths.home, "no-proc");
    expect(await strayWriters(paths, proc)).toEqual([]);
    expect(await endStrayWriters(paths, { proc, graceMs: 10 })).toBe(true);
  });
});
