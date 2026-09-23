import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { initializeFolder } from "../src/folder/initialize-folder";
import { executionOs } from "../src/folder/platform";
import { startLaunchpad } from "../src/launchpad/server";
import {
  type CliContext,
  noticeAfterCommand,
  runInstallCommand,
  runUpdateCommand,
  selfCheckCommand,
  versionCommand,
} from "../src/update/cli";
import { updateErrorCodes } from "../src/update/errors";
import {
  developmentCommit,
  developmentVersion,
  embeddedIdentity,
  nativeTarget,
} from "../src/update/identity";
import { layout, setPrevious } from "../src/update/layout";
import { launchpadHealth } from "../src/update/service-control";
import {
  closeSharedSigstore,
  commitOf,
  createWorld,
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
  const rollback = await run(["rollback", "--json"], "1.1.0");
  expect([rollback.code, JSON.parse(rollback.stdout ?? "")]).toEqual([
    0,
    { kind: "rolled-back", from: "1.1.0", to: "1.0.0" },
  ]);
  expect(await run(["rollback", "--auto"])).toEqual({
    code: 0,
    stdout: "Interrupted activation: none.",
  });
  for (const usage of [
    ["--version", "latest"],
    ["--version", "v1"],
    ["status", "--check"],
    ["rollback", "--version", "v1.1.0"],
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
    previous: null,
    highWater: null,
    supervised: false,
    pending: null,
    stateInvalid: null,
    lastCheck: { latest: "1.1.0" },
    updateAvailable: true,
  });
  expect(Date.parse(status.lastCheck.checkedAt)).toBeGreaterThan(
    Date.now() - 60_000,
  );
  const requests = world.origin.requests.length;
  await writeFile(layout(world.base).pending, "garbage");
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
  // --upgrade: the same version changes nothing; below the floor is one
  // stable code with exit 1, and nothing changes.
  expect(
    await runInstallCommand(["--base", fresh, "--upgrade"], context()),
  ).toEqual({
    code: 0,
    stdout: `Lazurio 1.0.0 is installed. Put ${join(fresh, "bin")} on your PATH.`,
  });
  const below = await runInstallCommand(
    ["--base", fresh, "--upgrade", "--json"],
    context("0.9.0"),
  );
  expect(below.code).toBe(1);
  expect(JSON.parse(below.stdout ?? "")).toEqual({
    kind: "error",
    code: "release-invalid",
    context: { resource: "version", reason: "below-floor" },
  });
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
  await setPrevious(fresh, "1.0.0");
  const report = await selfCheckCommand(
    ["--json", "--base", fresh],
    context("1.0.0"),
  );
  expect(JSON.parse(report.stdout ?? "")).toEqual({
    schemaVersion: 1,
    identity: { version: "1.0.0", commit: commitOf("1.0.0"), target },
    fixture: false,
    base: { active: "1.0.0", previous: "1.0.0", highWater: null },
    folder: null,
  });
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
  "the installed Launchpad reports its version on the health socket and commits a switched activation",
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
    // Power was lost after the switch to 1.0.0 from an older version.
    await setPrevious(world.base, "0.9.0");
    await writeFile(
      layout(world.base).pending,
      JSON.stringify({ from: "0.9.0", to: "1.0.0" }),
    );
    expect(await launchpadHealth(world.base)).toBeNull();
    const app = await startLaunchpad(folder, undefined, undefined, {
      base: world.base,
      version: "1.0.0",
      commitDelayMs: 300,
    });
    try {
      expect(await launchpadHealth(world.base)).toBe("1.0.0");
      // Reported at once; committed only after it stayed up for a while.
      expect(await Bun.file(layout(world.base).pending).exists()).toBe(true);
      // Only one Launchpad serves an install base.
      await expect(
        startLaunchpad(folder, undefined, undefined, {
          base: world.base,
          version: "1.0.0",
        }),
      ).rejects.toThrow();
      for (let attempt = 0; attempt < 100; attempt++) {
        if (!(await Bun.file(layout(world.base).pending).exists())) break;
        await Bun.sleep(20);
      }
      const status = JSON.parse((await run(["status", "--json"])).stdout ?? "");
      expect(status).toMatchObject({ pending: null, highWater: "1.0.0" });
    } finally {
      await app.close();
    }
    expect(await launchpadHealth(world.base)).toBeNull();
  },
);
