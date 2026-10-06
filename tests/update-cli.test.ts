import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { initializeFolder } from "../src/folder/initialize-folder";
import { executionOs } from "../src/folder/platform";
import { instructionTemplateRevision } from "../src/folder/render";
import { startLaunchpad } from "../src/launchpad/server";
import {
  type CliContext,
  noticeAfterCommand,
  runInstallCommand,
  runUpdateCommand,
  selfCheckCommand,
  versionCommand,
} from "../src/update/cli";
import {
  codexAppServerUnit,
  renderCodexAppServerUnit,
} from "../src/update/codex-app-server";
import { updateErrorCodes } from "../src/update/errors";
import {
  developmentCommit,
  developmentVersion,
  embeddedIdentity,
  nativeTarget,
} from "../src/update/identity";
import { renderLaunchpadUnit } from "../src/update/install";
import { layout } from "../src/update/layout";
import { runProcess } from "../src/update/self-check";
import { launchpadHealth, launchpadUnit } from "../src/update/service-control";
import {
  closeSharedSigstore,
  commitOf,
  createWorld,
  fakeService,
  target,
  type World,
} from "./fixtures/update-world";

let world: World;
afterEach(async () => world?.close());
afterAll(closeSharedSigstore);

const context = (running = "1.0.0"): CliContext => ({
  identity: { version: running, commit: commitOf(running), target },
  platform: process.platform,
  // The per-user base is resolved from HOME: never the real one.
  env: { HOME: world.root, XDG_DATA_HOME: world.root },
  executable: join(world.root, "downloaded-lazurio"),
  environment: world.environment(running),
});
const base = ["--base"];
const run = (args: string[], running?: string) =>
  runUpdateCommand([...args, ...base, world.base], context(running));

test("a source run has the development identity, which sorts below every release", () => {
  expect(embeddedIdentity()).toEqual({
    version: developmentVersion,
    commit: developmentCommit,
    target: nativeTarget(process.platform, process.arch),
  });
  expect(versionCommand([]).stdout).toBe(
    `lazurio ${developmentVersion} (commit ${developmentCommit}, target ${nativeTarget(process.platform, process.arch)})`,
  );
  expect(JSON.parse(versionCommand(["--json"]).stdout ?? "")).toEqual(
    embeddedIdentity(),
  );
  expect(versionCommand(["--unknown"]).code).toBe(2);
});

test("the four exit statuses and one stable code in --json", async () => {
  world = await createWorld();
  await world.release("1.1.0");
  const check = await run(["--check", "--json"]);
  expect(check.code).toBe(10);
  expect(JSON.parse(check.stdout ?? "")).toMatchObject({
    kind: "available",
    latest: "1.1.0",
  });
  expect((await run(["--check"])).stdout).toBe(
    "Lazurio 1.1.0 is available (running 1.0.0). https://github.com/Lazurio/LazurioPlatform/releases/tag/v1.1.0",
  );
  expect(await run([])).toEqual({
    code: 0,
    stdout:
      "Updated from 1.0.0 to 1.1.0. A running Launchpad finishes the update when it restarts.",
  });
  expect(await run(["--check"], "1.1.0")).toEqual({
    code: 0,
    stdout: "Lazurio 1.1.0 is up to date.",
  });
  // A tag and a bare version name the same release; below the floor is refused.
  for (const named of ["v1.0.0", "1.0.0"]) {
    const refused = await run(["--version", named, "--json"], "1.1.0");
    expect(refused.code).toBe(1);
    expect(JSON.parse(refused.stdout ?? "")).toMatchObject({
      kind: "error",
      code: "release-invalid",
      context: { reason: "below-floor" },
    });
  }
  expect(await run(["--version", "1.0.0"], "1.1.0")).toEqual({
    code: 1,
    stderr: "Update failed: release-invalid",
  });
  // There is no way back: rollback is not a command, with or without --auto.
  for (const usage of [
    ["rollback"],
    ["rollback", "--json"],
    ["rollback", "--auto"],
    ["--version", "latest"],
    ["--version", "v1"],
    ["status", "--check"],
    ["--auto"],
    ["recover"],
    ["status", "extra"],
    ["--unknown"],
  ])
    expect([usage, (await run(usage)).code]).toEqual([usage, 2]);
  expect((await runUpdateCommand(["--base", "relative"], context())).code).toBe(
    2,
  );
  // Every code a result can carry is one of the short list.
  expect(updateErrorCodes).toContain("state-invalid");
  expect(updateErrorCodes).toContain("activation-unhealthy");
  expect(updateErrorCodes).not.toContain("rollback-unavailable");
  expect(updateErrorCodes).toHaveLength(15);
});

test("status is what an observer reads: versions, the age of the last verified check, state-invalid", async () => {
  world = await createWorld();
  await world.release("1.1.0");
  await run(["--check"]);
  const status = JSON.parse((await run(["status", "--json"])).stdout ?? "");
  expect(status).toMatchObject({
    kind: "status",
    running: "1.0.0",
    active: "1.0.0",
    highWater: null,
    supervised: false,
    legacyRollbackState: false,
    stateInvalid: null,
    lastCheck: { latest: "1.1.0" },
    updateAvailable: true,
  });
  expect(Date.parse(status.lastCheck.checkedAt)).toBeGreaterThan(
    Date.now() - 60_000,
  );
  expect(Object.keys(status)).not.toContain("previous");
  const requests = world.origin.requests.length;
  // A marker a v0.1.x updater left and no crash can produce.
  await writeFile(join(world.base, "update", "pending.json"), "garbage");
  expect(await run(["status"])).toMatchObject({ code: 0 });
  expect((await run(["status"])).stdout).toContain(
    "state-invalid: update/pending.json",
  );
  expect(await run([])).toEqual({
    code: 1,
    stderr: "Update failed: state-invalid (update/pending.json)",
  });
  expect(world.origin.requests.length).toBe(requests);
});

test("the notice after other commands comes from last-check.json alone", async () => {
  world = await createWorld();
  // `${XDG_DATA_HOME}/lazurio` is the per-user base on Linux.
  const linux = (running: string): CliContext => ({
    ...context(running),
    platform: "linux",
    env: { HOME: world.root, XDG_DATA_HOME: world.root },
  });
  expect(await noticeAfterCommand(linux("1.0.0"))).toBeNull();
  await mkdir(join(world.root, "lazurio/update"), { recursive: true });
  await writeFile(
    join(world.root, "lazurio/update/last-check.json"),
    JSON.stringify({
      checkedAt: new Date().toISOString(),
      latest: "1.1.0",
      notesUrl: "https://example.com/notes",
    }),
  );
  expect(await noticeAfterCommand(linux("1.0.0"))).toBe(
    "Lazurio 1.1.0 is available (running 1.0.0). Run `lazurio update`. https://example.com/notes",
  );
  expect(await noticeAfterCommand(linux("1.1.0"))).toBeNull();
  expect(world.origin.requests).toEqual([]);
});

test("install and self-check through the command surface", async () => {
  world = await createWorld();
  const fresh = join(world.root, "fresh-base");
  expect(
    await runInstallCommand(["--base", fresh, "--json"], context()),
  ).toMatchObject({ code: 0 });
  expect(
    (await runInstallCommand(["--service", "systemd-user"], context())).code,
  ).toBe(2);
  expect(
    (
      await runInstallCommand(
        ["--service", "launchd", "--folder", "/x"],
        context(),
      )
    ).code,
  ).toBe(2);
  const report = await selfCheckCommand(
    ["--json", "--base", fresh],
    context("1.0.0"),
  );
  expect(JSON.parse(report.stdout ?? "")).toEqual({
    schemaVersion: 1,
    identity: { version: "1.0.0", commit: commitOf("1.0.0"), target },
    fixture: false,
    templateRevision: instructionTemplateRevision,
    base: { active: "1.0.0", highWater: null },
    folder: null,
    launchpad: null,
  });
  // The Launchpad probe needs the Folder it would start against.
  expect(
    (await selfCheckCommand(["--json", "--launchpad"], context())).code,
  ).toBe(2);
  // A Folder this version cannot read fails the check without saying why.
  expect(
    await selfCheckCommand(
      ["--json", "--folder", join(world.root, "no-folder")],
      context(),
    ),
  ).toEqual({ code: 1, stderr: "Self-check failed" });
  // State this version cannot read fails it as well.
  await writeFile(layout(fresh).highWater, "garbage");
  expect(
    (await selfCheckCommand(["--json", "--base", fresh], context())).code,
  ).toBe(1);
});

test.skipIf(process.platform === "win32")(
  "the candidate's Launchpad probe starts read-only against the real Folder and names what refuses it",
  async () => {
    world = await createWorld();
    const folder = join(world.root, "Lazurio");
    await initializeFolder(folder, {
      os: executionOs(process.platform),
      access: "local",
      purpose: "human",
      locale: "en",
      detail: "concise",
      coordination: "direct",
    });
    const state = join(folder, ".lazurio");
    const listing = async () => (await readdir(state)).sort();
    const before = await listing();
    const probe = await selfCheckCommand(
      ["--json", "--base", world.base, "--folder", folder, "--launchpad"],
      context(),
    );
    expect(probe.code).toBe(0);
    expect(JSON.parse(probe.stdout ?? "")).toMatchObject({
      folder: { preferences: 2 },
      launchpad: { probe: "ok" },
    });
    // Nothing was written: no lock taken, no health socket under the base.
    expect(await listing()).toEqual(before);
    expect(await launchpadHealth(world.base)).toBeNull();
    // An interrupted Folder change refuses the start by name, and only that.
    await mkdir(join(state, "transaction"));
    expect(
      await selfCheckCommand(
        ["--json", "--base", world.base, "--folder", folder, "--launchpad"],
        context(),
      ),
    ).toEqual({
      code: 1,
      stdout: JSON.stringify({
        launchpadRefused: "folder-transaction-pending",
      }),
      stderr: "Self-check failed",
    });
  },
);

test.skipIf(process.platform === "win32")(
  "the installed Launchpad reports its version on the health socket; there is nothing to commit",
  async () => {
    world = await createWorld();
    const folder = join(world.root, "Lazurio");
    await initializeFolder(folder, {
      os: executionOs(process.platform),
      access: "local",
      purpose: "human",
      locale: "en",
      detail: "concise",
      coordination: "direct",
    });
    expect(await launchpadHealth(world.base)).toBeNull();
    const before = (await readdir(layout(world.base).update)).sort();
    const app = await startLaunchpad(folder, undefined, undefined, {
      base: world.base,
      version: "1.0.0",
    });
    try {
      expect(await launchpadHealth(world.base)).toBe("1.0.0");
      // Only one Launchpad serves an install base.
      await expect(
        startLaunchpad(folder, undefined, undefined, {
          base: world.base,
          version: "1.0.0",
        }),
      ).rejects.toThrow();
      // It writes no update state of its own: only its socket appears.
      expect((await readdir(layout(world.base).update)).sort()).toEqual(
        [...before, "launchpad.sock"].sort(),
      );
    } finally {
      await app.close();
    }
    expect(await launchpadHealth(world.base)).toBeNull();
  },
);

// Decision F29: `lazurio update` converges the Codex app-server unit of a
// supervised base in a Remote Environment, so an Environment switched before
// this release gets it without --service; it never restarts or stops it.
test("lazurio update converges the Codex app-server unit on a supervised hosted base, up to date or updated, and leaves an unsupervised base alone", async () => {
  world = await createWorld();
  await world.release("1.1.0");
  const folder = join(world.root, "Lazurio");
  await mkdir(folder);
  const config = join(world.root, "config");
  const units = join(config, "systemd", "user");
  const commands: string[][] = [];
  const service = fakeService(world.base, { folder });
  const linux = (
    running: string,
    hostedFolder: () => Promise<string | undefined>,
  ): CliContext => ({
    ...context(running),
    platform: "linux",
    env: {
      HOME: world.root,
      XDG_DATA_HOME: world.root,
      XDG_CONFIG_HOME: config,
    },
    run: async (command, timeoutMs, env) => {
      if (command[0] !== "systemctl")
        return runProcess(command, timeoutMs, env);
      commands.push([...command]);
      return { exitCode: 0, stdout: "" };
    },
    hostedFolder,
    environment: world.environment(running, { service }),
  });
  const update = async (running: string, hosted = true) =>
    JSON.parse(
      (
        await runUpdateCommand(
          ["--base", world.base, "--json"],
          linux(running, async () => (hosted ? folder : undefined)),
        )
      ).stdout ?? "",
    );

  // Unsupervised: no key, nothing written, the service manager not asked.
  const unsupervised = await update("1.0.0");
  expect(unsupervised).toMatchObject({ kind: "updated", to: "1.1.0" });
  expect(Object.keys(unsupervised)).not.toContain("codexAppServer");
  expect(commands).toEqual([]);
  await expect(readdir(units)).rejects.toThrow();

  // Supervised by this base's Launchpad unit, switched before this release.
  await mkdir(units, { recursive: true });
  await writeFile(
    join(units, launchpadUnit),
    renderLaunchpadUnit(world.base, folder),
  );
  expect(await update("1.1.0", false)).toMatchObject({
    kind: "up-to-date",
    codexAppServer: { state: "skipped-not-hosted" },
  });
  expect(commands).toEqual([]);
  expect(await update("1.1.0")).toMatchObject({
    kind: "up-to-date",
    codexAppServer: { state: "enabled" },
  });
  expect(await readFile(join(units, codexAppServerUnit), "utf8")).toBe(
    renderCodexAppServerUnit(),
  );
  expect(commands).toEqual([
    ["systemctl", "--user", "daemon-reload"],
    ["systemctl", "--user", "enable", codexAppServerUnit],
    ["systemctl", "--user", "start", codexAppServerUnit],
  ]);

  // An update: the Launchpad restarts (its service), the Codex unit is only
  // ensured again — identical text, no reload, never a restart or a stop.
  await world.release("1.2.0");
  commands.length = 0;
  const restarts = service.restarts;
  expect(await update("1.1.0")).toMatchObject({
    kind: "updated",
    from: "1.1.0",
    to: "1.2.0",
    codexAppServer: { state: "enabled" },
  });
  expect(service.restarts).toBe(restarts + 1);
  expect(commands).toEqual([
    ["systemctl", "--user", "enable", codexAppServerUnit],
    ["systemctl", "--user", "start", codexAppServerUnit],
  ]);

  // A failing start is reported and the update is still a success.
  const failing = await runUpdateCommand(["--base", world.base], {
    ...linux("1.2.0", async () => folder),
    run: async (command, timeoutMs, env) =>
      command[0] === "systemctl" && command[2] === "start"
        ? { exitCode: 1, stdout: "" }
        : command[0] === "systemctl"
          ? { exitCode: 0, stdout: "" }
          : runProcess(command, timeoutMs, env),
  });
  expect(failing.code).toBe(0);
  expect(failing.stdout).toContain("Lazurio 1.2.0 is up to date.");
  expect(failing.stdout).toContain(
    "The Codex app-server daemon is not set up to start with this Environment",
  );
});
