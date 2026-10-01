import { afterEach, expect, test } from "bun:test";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInstallCommand } from "../src/update/cli";
import {
  codexAppServerUnit,
  renderCodexAppServerUnit,
} from "../src/update/codex-app-server";
import {
  performInstall,
  renderLaunchpadUnit,
  systemdQuote,
} from "../src/update/install";
import {
  layout,
  readHighWater,
  readSelector,
  swapSelector,
} from "../src/update/layout";
import { type ProcessRunner, runProcess } from "../src/update/self-check";
import {
  detectServiceControl,
  launchpadUnit,
  unitFolder,
  unitMarker,
} from "../src/update/service-control";
import {
  commitOf,
  executable,
  readLegacyRollbackState,
  target,
  writeLegacyRollbackState,
} from "./fixtures/update-world";

let root: string;
afterEach(async () => rm(root, { recursive: true, force: true }));

async function scene(version = "1.0.0") {
  root = await realpath(await mkdtemp(join(tmpdir(), "upd-install-")));
  const downloaded = join(root, "Downloads", "lazurio");
  await mkdir(join(root, "Downloads"));
  await mkdir(join(root, "home"));
  await writeFile(downloaded, executable(version), { mode: 0o755 });
  const commands: string[][] = [];
  // systemctl is recorded and answered; everything else (the staged
  // executable's self-check) really runs.
  const run: ProcessRunner = async (command, timeoutMs, env) => {
    if (command[0] !== "systemctl") return runProcess(command, timeoutMs, env);
    commands.push([...command]);
    return { exitCode: 0, stdout: "" };
  };
  return {
    commands,
    input: {
      base: join(root, "data", "lazurio"),
      executable: downloaded,
      identity: { version, commit: commitOf(version), target },
      platform: "linux",
      env: { HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "config") },
      run,
    },
  };
}

test("install stages the running executable as the first version; repeated, it changes nothing", async () => {
  const { input, commands } = await scene();
  const { base } = input;
  const before = process.umask(0o002);
  try {
    expect(await performInstall(input)).toEqual({
      kind: "installed",
      active: "1.0.0",
      // The standard entry is the directory to put on PATH.
      path: join(root, "home/.local/bin"),
      serviceInstalled: false,
      entry: {
        path: join(root, "home/.local/bin/lazurio"),
        target: join(base, "bin/lazurio"),
        state: "created",
        occupant: null,
        directoryOnPath: false,
        shadowedBy: null,
        next: [
          `Put ${join(root, "home/.local/bin")} on your PATH. Lazurio never edits shell profiles.`,
        ],
      },
    });
  } finally {
    process.umask(before);
  }
  expect(await readlink(join(base, "bin/lazurio"))).toBe(
    "../versions/1.0.0/lazurio",
  );
  // Owner-only whatever the umask; the bytes are final.
  for (const [path, mode] of [
    [base, 0o700],
    [join(base, "bin"), 0o700],
    [join(base, "versions"), 0o700],
    [join(base, "update"), 0o700],
    [join(base, "versions/1.0.0/lazurio"), 0o500],
  ] as const)
    expect([path, (await stat(path)).mode & 0o777]).toEqual([path, mode]);
  expect(await readFile(join(base, "versions/1.0.0/lazurio"))).toEqual(
    await readFile(input.executable),
  );
  // A missing mark means the floor is the active version.
  expect(await readHighWater(base)).toBeNull();
  expect(commands).toEqual([]);

  // A newer download run as `install` never changes the active version:
  // A newer executable over the installation is the offline update
  // (tested below); the same version again changes nothing.
  await writeFile(input.executable, executable("2.0.0"));
  expect(
    await performInstall({
      ...input,
      identity: {
        ...input.identity,
        version: "2.0.0",
        commit: commitOf("2.0.0"),
      },
    }),
  ).toMatchObject({ kind: "updated", from: "1.0.0", to: "2.0.0" });
  expect(await readSelector(base)).toBe("2.0.0");
});

test("install --service writes the one Launchpad unit that always restarts and never ends failed, then enables it", async () => {
  const { input, commands } = await scene();
  const folder = join(root, "My Lazurio $HOME 100%");
  expect(await performInstall({ ...input, service: { folder } })).toMatchObject(
    { kind: "installed", serviceInstalled: true },
  );
  const units = join(root, "config/systemd/user");
  const launchpad = await readFile(join(units, launchpadUnit), "utf8");
  expect(launchpad).toBe(renderLaunchpadUnit(input.base, folder));
  expect(launchpad.split("\n")).toEqual([
    "# Written by `lazurio install`; rewritten by it, so edit a drop-in instead.",
    "[Unit]",
    "Description=Lazurio Launchpad",
    // No start rate limit: the unit never ends `failed`.
    "StartLimitIntervalSec=0",
    "",
    "[Service]",
    // The operator's standard tool path first (F17 addendum).
    "Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin",
    // The SELECTOR: a restart runs whatever version is active.
    `ExecStart=${input.base}/bin/lazurio launchpad --base ${input.base} --folder "${root}/My Lazurio $$HOME 100%%"`,
    "Restart=always",
    "RestartSec=5",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
    "[X-Lazurio]",
    `Folder=${folder}`,
    "",
  ]);
  // One unit and nothing that runs an earlier version.
  expect(await readdir(units)).toEqual([launchpadUnit]);
  expect(launchpad).not.toMatch(/OnFailure|rollback|previous|StartLimitBurst/);
  expect(commands).toEqual([
    ["systemctl", "--user", "daemon-reload"],
    ["systemctl", "--user", "enable", "--now", launchpadUnit],
  ]);

  // The unit is how supervision is detected and where the Folder lives.
  const service = await detectServiceControl({
    base: input.base,
    platform: "linux",
    env: input.env,
    run: input.run,
  });
  expect(service?.folder).toBe(folder);
  expect(unitFolder(launchpad)).toBe(folder);
  commands.length = 0;
  await service?.restartLaunchpad();
  expect(commands).toEqual([
    ["systemctl", "--user", "reset-failed", launchpadUnit],
    ["systemctl", "--user", "restart", launchpadUnit],
  ]);
  // Not supervised: another platform, or no unit.
  expect(
    await detectServiceControl({ ...input, platform: "darwin" }),
  ).toBeNull();
  expect(
    await detectServiceControl({ ...input, env: { HOME: join(root, "x") } }),
  ).toBeNull();

  // Repeating it with another Folder rewrites OUR unit …
  const moved = join(root, "Elsewhere");
  await performInstall({ ...input, service: { folder: moved } });
  expect(unitFolder(await readFile(join(units, launchpadUnit), "utf8"))).toBe(
    moved,
  );
  // … and never a unit of that name someone else wrote.
  await writeFile(
    join(units, launchpadUnit),
    "[Service]\nExecStart=/bin/true\n",
  );
  expect(
    await performInstall({ ...input, service: { folder: moved } }),
  ).toMatchObject({
    kind: "error",
    code: "storage-unavailable",
    context: { reason: "foreign-unit" },
  });
  expect(await readFile(join(units, launchpadUnit), "utf8")).toBe(
    "[Service]\nExecStart=/bin/true\n",
  );
  // … nor treats it as its supervisor: the installation is unsupervised, so an
  // update switches and commits without restarting a unit it did not write.
  expect(
    await detectServiceControl({
      base: input.base,
      platform: "linux",
      env: input.env,
      run: input.run,
    }),
  ).toBeNull();
});

test("the Launchpad unit belongs to the base whose exact ExecStart it carries: another base neither detects it as its supervisor nor rewrites it", async () => {
  const { input, commands } = await scene();
  const a = input.base;
  const b = join(root, "data", "other");
  const folderA = join(root, "Lazurio A");
  const folderB = join(root, "Lazurio B");
  const units = join(root, "config/systemd/user");
  const detect = (base: string) =>
    detectServiceControl({
      base,
      platform: "linux",
      env: input.env,
      run: input.run,
    });
  expect(
    await performInstall({ ...input, service: { folder: folderA } }),
  ).toMatchObject({ kind: "installed", serviceInstalled: true });
  const unitA = await readFile(join(units, launchpadUnit), "utf8");
  expect((await detect(a))?.folder).toBe(folderA);

  // A's marked unit is not B's supervisor: B is unsupervised.
  expect(await detect(b)).toBeNull();
  commands.length = 0;
  // Installing B with its service is refused before B's selector exists …
  expect(
    await performInstall({ ...input, base: b, service: { folder: folderB } }),
  ).toMatchObject({
    kind: "error",
    code: "storage-unavailable",
    context: { stage: "unit", reason: "foreign-unit" },
  });
  expect(await readSelector(b)).toBeNull();
  // … B without a service installs, and touches nothing of A's …
  expect(await performInstall({ ...input, base: b })).toMatchObject({
    kind: "installed",
    active: "1.0.0",
  });
  // … the offline update of B with its service is refused before B's selector
  // changes …
  await writeFile(input.executable, executable("2.0.0"));
  const newer = {
    ...input,
    base: b,
    identity: {
      ...input.identity,
      version: "2.0.0",
      commit: commitOf("2.0.0"),
    },
  };
  expect(
    await performInstall({ ...newer, service: { folder: folderB } }),
  ).toMatchObject({
    code: "storage-unavailable",
    context: { reason: "foreign-unit" },
  });
  expect(await readSelector(b)).toBe("1.0.0");
  // … and without it B is updated unsupervised: A's Launchpad is neither
  // probed nor restarted.
  expect(await performInstall(newer)).toMatchObject({
    kind: "updated",
    from: "1.0.0",
    to: "2.0.0",
    restartRequired: true,
  });
  expect(commands).toEqual([]);
  expect(await readFile(join(units, launchpadUnit), "utf8")).toBe(unitA);
  expect((await detect(a))?.folder).toBe(folderA);

  // B's own marked unit is still B's: detected, and rewritten for another
  // Folder — and then it is not A's.
  await rm(join(units, launchpadUnit));
  expect(
    await performInstall({ ...newer, service: { folder: folderA } }),
  ).toMatchObject({ kind: "installed", serviceInstalled: true });
  expect((await detect(b))?.folder).toBe(folderA);
  expect(
    await performInstall({ ...newer, service: { folder: folderB } }),
  ).toMatchObject({ kind: "installed", serviceInstalled: true });
  expect(await readFile(join(units, launchpadUnit), "utf8")).toBe(
    renderLaunchpadUnit(b, folderB),
  );
  expect((await detect(b))?.folder).toBe(folderB);
  expect(await detect(a)).toBeNull();

  // An unmarked unit (a Machines resident runtime) is neither base's.
  const resident = `[Service]\nExecStart=${a}/bin/lazurio launchpad --base ${a} --folder ${folderA}\n\n[X-Lazurio]\nFolder=${folderA}\n`;
  await writeFile(join(units, launchpadUnit), resident);
  expect(await detect(a)).toBeNull();
  expect(await detect(b)).toBeNull();
  for (const [base, folder] of [
    [a, folderA],
    [b, folderB],
  ] as const)
    expect(
      await performInstall({ ...newer, base, service: { folder } }),
    ).toMatchObject({ context: { reason: "foreign-unit" } });
  expect(await readFile(join(units, launchpadUnit), "utf8")).toBe(resident);
  expect(await readSelector(a)).toBe("1.0.0");
});

test("a service is refused where there is no systemd user manager, and when it refuses", async () => {
  const { input } = await scene();
  const folder = join(root, "Lazurio");
  expect(
    await performInstall({ ...input, platform: "darwin", service: { folder } }),
  ).toMatchObject({ code: "target-unsupported" });
  expect(
    await performInstall({ ...input, service: { folder: "relative/Folder" } }),
  ).toMatchObject({
    code: "storage-unavailable",
    context: { stage: "folder" },
  });
  // Refused before anything was created.
  expect(await readSelector(input.base)).toBeNull();
  expect(
    await performInstall({
      ...input,
      service: { folder },
      run: async () => ({ exitCode: 1, stdout: "" }),
    }),
  ).toMatchObject({ code: "activation-failed", context: { stage: "service" } });
  // The product is installed and usable; the same command completes it.
  expect(await readSelector(input.base)).toBe("1.0.0");
  expect(await performInstall({ ...input, service: { folder } })).toMatchObject(
    { kind: "installed", serviceInstalled: true },
  );
});

test("an ExecStart argument survives systemd's splitting, specifiers, variables and escapes", () => {
  expect(systemdQuote("/plain/path-1.0_x@y:z=+")).toBe(
    "/plain/path-1.0_x@y:z=+",
  );
  expect(systemdQuote('/a b/"c"\\d')).toBe('"/a b/\\"c\\"\\\\d"');
  expect(systemdQuote("/100%/$HOME")).toBe('"/100%%/$$HOME"');
  for (const refused of ["", "/a\nb", "/a\u0000b"])
    expect(() => systemdQuote(refused)).toThrow();
});

// The offline update (docs/update.md "Offline update"): a newer executable
// run over an existing installation takes the update contract's own steps,
// never the network, and never goes below the floor.
test("install from a newer executable over an existing installation is the offline update; equal is unchanged; lower or below the floor is refused", async () => {
  const { input } = await scene("1.0.0");
  const { base } = input;
  const staged = async (
    version: string,
    options: { healthy?: boolean } = {},
  ) => {
    const file = join(root, "Downloads", `lazurio-${version}`);
    await writeFile(file, executable(version, options), { mode: 0o755 });
    return {
      ...input,
      executable: file,
      identity: { version, commit: commitOf(version), target },
    };
  };
  expect(await performInstall(input)).toMatchObject({
    kind: "installed",
    active: "1.0.0",
  });
  // Newer: staged, self-checked, switched, mark raised; only it is kept.
  expect(await performInstall(await staged("1.1.0"))).toEqual({
    kind: "updated",
    from: "1.0.0",
    to: "1.1.0",
    restartRequired: true,
    path: join(root, "home/.local/bin"),
    serviceInstalled: false,
    entry: expect.objectContaining({ state: "present" }),
  });
  expect(await readSelector(base)).toBe("1.1.0");
  expect(await readHighWater(base)).toBe("1.1.0");
  expect((await readdir(join(base, "versions"))).sort()).toEqual(["1.1.0"]);
  // Equal: unchanged.
  expect(await performInstall(await staged("1.1.0"))).toMatchObject({
    kind: "installed",
    active: "1.1.0",
  });
  // Lower than active: refused below the floor, nothing moved.
  expect(await performInstall(await staged("1.0.5"))).toMatchObject({
    kind: "error",
    code: "release-invalid",
    context: { resource: "version", reason: "below-floor" },
  });
  expect(await readSelector(base)).toBe("1.1.0");
  expect(await readHighWater(base)).toBe("1.1.0");
  // A version that fails its self-check is removed and nothing is switched.
  expect(
    await performInstall(await staged("1.2.0", { healthy: false })),
  ).toMatchObject({ kind: "error", code: "self-check-failed" });
  expect(await readSelector(base)).toBe("1.1.0");
  expect((await readdir(join(base, "versions"))).sort()).toEqual(["1.1.0"]);
  // An installation an older release rolled back sits below its mark: the
  // mark is the floor, so 1.1.0 again is allowed and 1.0.5 stays refused
  // even though it is above the active version.
  await performInstall(input);
  await swapSelector(base, "1.0.0");
  expect(await readSelector(base)).toBe("1.0.0");
  expect(await performInstall(await staged("1.0.5"))).toMatchObject({
    kind: "error",
    code: "release-invalid",
    context: { resource: "version", reason: "below-floor" },
  });
  expect(await performInstall(await staged("1.1.0"))).toMatchObject({
    kind: "updated",
    from: "1.0.0",
    to: "1.1.0",
  });
  expect(await readSelector(base)).toBe("1.1.0");
});

test("the offline update on a supervised installation restarts the installer's unit; a Launchpad that never reports the new version is activation-unhealthy and nothing is undone", async () => {
  const { input, commands } = await scene("1.0.0");
  const { base } = input;
  const folder = join(root, "Lazurio");
  await mkdir(folder);
  expect(await performInstall({ ...input, service: { folder } })).toMatchObject(
    { kind: "installed", active: "1.0.0" },
  );
  const file = join(root, "Downloads", "lazurio-1.1.0");
  await writeFile(file, executable("1.1.0"), { mode: 0o755 });
  commands.length = 0;
  // No Launchpad answers on the health socket: the switch stays, the mark
  // follows it, and the result says so.
  expect(
    await performInstall({
      ...input,
      executable: file,
      identity: { version: "1.1.0", commit: commitOf("1.1.0"), target },
      service: { folder },
      healthDeadlineMs: 200,
    }),
  ).toMatchObject({
    kind: "error",
    code: "activation-unhealthy",
    context: { from: "1.0.0", to: "1.1.0" },
  });
  expect(await readSelector(base)).toBe("1.1.0");
  expect(await readHighWater(base)).toBe("1.1.0");
  expect(commands.filter((c) => c[2] === "restart").map((c) => c[3])).toEqual([
    launchpadUnit,
  ]);
});

test("a retained high-water mark is the floor even when the selector is missing: a lower executable is refused, the marked version repairs the selector", async () => {
  const { input } = await scene("1.0.0");
  const { base } = input;
  const staged = async (version: string) => {
    const file = join(root, "Downloads", `lazurio-${version}`);
    await writeFile(file, executable(version), { mode: 0o755 });
    return {
      ...input,
      executable: file,
      identity: { version, commit: commitOf(version), target },
    };
  };
  await performInstall(input);
  expect(await performInstall(await staged("1.1.0"))).toMatchObject({
    kind: "updated",
    to: "1.1.0",
  });
  expect(await readHighWater(base)).toBe("1.1.0");
  // External damage: the selector is gone, the durable mark is not.
  await rm(join(base, "bin", "lazurio"));
  expect(await readSelector(base)).toBeNull();
  expect(await performInstall(await staged("1.0.0"))).toMatchObject({
    kind: "error",
    code: "release-invalid",
    context: { resource: "version", reason: "below-floor" },
  });
  expect(await readSelector(base)).toBeNull();
  expect(await readHighWater(base)).toBe("1.1.0");
  // The marked version (or a newer one) repairs the selector; the mark stays.
  expect(await performInstall(await staged("1.1.0"))).toMatchObject({
    kind: "installed",
    active: "1.1.0",
  });
  expect(await readSelector(base)).toBe("1.1.0");
  expect(await readHighWater(base)).toBe("1.1.0");
  // With a mark the tree is an existing installation: the repairing
  // executable proves itself first; a failing self-check removes what was
  // placed and switches nothing.
  await rm(join(base, "bin", "lazurio"));
  const unhealthy = join(root, "Downloads", "lazurio-1.2.0-unhealthy");
  await writeFile(unhealthy, executable("1.2.0", { healthy: false }), {
    mode: 0o755,
  });
  expect(
    await performInstall({
      ...input,
      executable: unhealthy,
      identity: { version: "1.2.0", commit: commitOf("1.2.0"), target },
    }),
  ).toMatchObject({ kind: "error", code: "self-check-failed" });
  expect(await readSelector(base)).toBeNull();
  expect(await readHighWater(base)).toBe("1.1.0");
  expect((await readdir(join(base, "versions"))).sort()).toEqual(["1.1.0"]);
  expect(await performInstall(await staged("1.1.0"))).toMatchObject({
    kind: "installed",
    active: "1.1.0",
  });
  // A marker a v0.1.x updater left, with no selector, is a state no crash
  // produces: nothing is staged or switched, the marker and the mark stay
  // for a person to look at.
  await writeLegacyRollbackState(base, {
    pending: '{"from":"1.1.0","to":"1.2.0"}\n',
  });
  await rm(join(base, "bin", "lazurio"));
  expect(await performInstall(await staged("1.3.0"))).toMatchObject({
    kind: "error",
    code: "state-invalid",
    context: { path: "update/pending.json" },
  });
  expect(await readSelector(base)).toBeNull();
  expect(await readHighWater(base)).toBe("1.1.0");
  expect(await readFile(join(base, "update", "pending.json"), "utf8")).toBe(
    '{"from":"1.1.0","to":"1.2.0"}\n',
  );
  expect((await readdir(join(base, "versions"))).sort()).toEqual(["1.1.0"]);
});

test("install over an installation with the rollback unit and a previous version converges it forward: marker finished, rollback unit deleted, Launchpad unit rewritten, previous removed", async () => {
  const { input, commands } = await scene("1.0.0");
  const { base } = input;
  const folder = join(root, "Lazurio");
  await mkdir(folder);
  await performInstall({ ...input, service: { folder } });
  const file = join(root, "Downloads", "lazurio-1.1.0");
  await writeFile(file, executable("1.1.0"), { mode: 0o755 });
  const staged = {
    ...input,
    executable: file,
    identity: { version: "1.1.0", commit: commitOf("1.1.0"), target },
  };
  // 1.1.0 staged next to 1.0.0; then, by hand, what a v0.1.x supervised
  // activation that crashed after its switch left: selector on `to`,
  // `previous` on `from`, the marker, and the v0.1.x units.
  expect(
    await performInstall({ ...staged, healthDeadlineMs: 200 }),
  ).toMatchObject({ code: "activation-unhealthy" });
  await mkdir(join(base, "versions", "1.0.0"));
  await copyFile(input.executable, join(base, "versions", "1.0.0", "lazurio"));
  await swapSelector(base, "1.1.0");
  await writeLegacyRollbackState(base, {
    previous: "1.0.0",
    pending: '{"from":"1.0.0","to":"1.1.0"}\n',
  });
  const units = join(root, "config/systemd/user");
  await writeFile(
    join(units, launchpadUnit),
    [
      unitMarker,
      "[Unit]",
      "Description=Lazurio Launchpad",
      "StartLimitIntervalSec=60",
      "StartLimitBurst=5",
      "OnFailure=lazurio-rollback.service",
      "",
      "[Service]",
      `ExecStart=${base}/bin/lazurio launchpad --base ${base} --folder ${folder}`,
      "Restart=on-failure",
      "RestartSec=2",
      "",
      "[Install]",
      "WantedBy=default.target",
      "",
      "[X-Lazurio]",
      `Folder=${folder}`,
      "",
    ].join("\n"),
  );
  await writeFile(
    join(units, "lazurio-rollback.service"),
    `${unitMarker}\n[Service]\nType=oneshot\nExecStart=${base}/previous/lazurio update rollback --auto --base ${base}\n`,
  );
  commands.length = 0;
  // The same version again, without --service: nothing to install, but the
  // leftovers are converged. No Launchpad answers, and still nothing goes
  // back to 1.0.0.
  expect(await performInstall(staged)).toMatchObject({
    kind: "installed",
    active: "1.1.0",
  });
  expect(await readSelector(base)).toBe("1.1.0");
  expect(await readHighWater(base)).toBe("1.1.0");
  expect(await readLegacyRollbackState(base)).toEqual({
    previous: null,
    pending: null,
  });
  expect((await readdir(join(base, "versions"))).sort()).toEqual(["1.1.0"]);
  expect(await readdir(units)).toEqual([launchpadUnit]);
  expect(await readFile(join(units, launchpadUnit), "utf8")).toBe(
    renderLaunchpadUnit(base, folder),
  );
  // Reread, never restarted.
  expect(commands).toEqual([["systemctl", "--user", "daemon-reload"]]);
});

// The operator's Codex app-server daemon at boot on a hosted Machine
// (decision F29, docs/update.md "State on disk"): a second installer unit,
// written only with the service on the declared operator's account, that
// never fails the installation and is never restarted or stopped by it.
const hostedOperator = async () => true;

const codexUnitLines = [
  "# Written by `lazurio install`; rewritten by it, so edit a drop-in instead.",
  "[Unit]",
  "Description=Codex app-server daemon (operator's Codex)",
  // No Codex, no start and no failure.
  "ConditionFileIsExecutable=%h/.local/bin/codex",
  "",
  "[Service]",
  "Type=oneshot",
  "RemainAfterExit=yes",
  // The daemon's processes are Codex's to stop.
  "KillMode=process",
  "Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin",
  "ExecStart=%h/.local/bin/codex app-server daemon start",
  "ExecStop=-%h/.local/bin/codex app-server daemon stop",
  "TimeoutStartSec=60",
  "",
  "[Install]",
  "WantedBy=default.target",
  "",
];

test("install --service on a hosted Machine also writes, enables and starts the Codex app-server unit; repeated or as the offline update it writes nothing and never restarts or stops it", async () => {
  const { input, commands } = await scene();
  const folder = join(root, "Lazurio");
  await mkdir(folder);
  const units = join(root, "config/systemd/user");
  expect(
    await performInstall({
      ...input,
      service: { folder },
      hosted: hostedOperator,
    }),
  ).toMatchObject({
    kind: "installed",
    serviceInstalled: true,
    codexAppServer: { state: "enabled" },
  });
  const text = await readFile(join(units, codexAppServerUnit), "utf8");
  expect(text).toBe(renderCodexAppServerUnit());
  expect(text.split("\n")).toEqual(codexUnitLines);
  // Nothing orders it against the Launchpad, and no private /tmp hides the
  // daemon's socket from a client session.
  expect(text).not.toMatch(
    /After=|Before=|Requires=|Wants=|PrivateTmp|Restart=/,
  );
  expect((await readdir(units)).sort()).toEqual(
    [codexAppServerUnit, launchpadUnit].sort(),
  );
  // After the Launchpad's unit, and never a restart or a stop.
  expect(commands).toEqual([
    ["systemctl", "--user", "daemon-reload"],
    ["systemctl", "--user", "enable", "--now", launchpadUnit],
    ["systemctl", "--user", "daemon-reload"],
    ["systemctl", "--user", "enable", codexAppServerUnit],
    ["systemctl", "--user", "start", codexAppServerUnit],
  ]);
  const written = await stat(join(units, codexAppServerUnit));

  // Repeated: the same bytes are not rewritten and not reloaded for it;
  // `start` of an active unit changes nothing.
  commands.length = 0;
  expect(
    await performInstall({
      ...input,
      service: { folder },
      hosted: hostedOperator,
    }),
  ).toMatchObject({ kind: "installed", codexAppServer: { state: "enabled" } });
  expect((await stat(join(units, codexAppServerUnit))).mtimeMs).toBe(
    written.mtimeMs,
  );
  expect(commands).toEqual([
    ["systemctl", "--user", "daemon-reload"],
    ["systemctl", "--user", "enable", "--now", launchpadUnit],
    ["systemctl", "--user", "enable", codexAppServerUnit],
    ["systemctl", "--user", "start", codexAppServerUnit],
  ]);

  // The offline update restarts the Launchpad (its own unit) and nothing of
  // Codex's.
  const file = join(root, "Downloads", "lazurio-1.1.0");
  await writeFile(file, executable("1.1.0"), { mode: 0o755 });
  commands.length = 0;
  await performInstall({
    ...input,
    executable: file,
    identity: { version: "1.1.0", commit: commitOf("1.1.0"), target },
    service: { folder },
    hosted: hostedOperator,
    healthDeadlineMs: 200,
  });
  expect(await readSelector(input.base)).toBe("1.1.0");
  expect(
    commands.filter(
      (command) =>
        command.includes(codexAppServerUnit) &&
        !["enable", "start"].includes(command[2] ?? ""),
    ),
  ).toEqual([]);
  expect(commands.filter((command) => command[2] === "restart")).toEqual([
    ["systemctl", "--user", "restart", launchpadUnit],
  ]);

  // The migration of the former rollback deletes its own unit by name and
  // leaves this one.
  await writeFile(
    join(units, "lazurio-rollback.service"),
    `${unitMarker}\n[Service]\nType=oneshot\nExecStart=${input.base}/previous/lazurio update rollback --auto --base ${input.base}\n`,
  );
  await performInstall({
    ...input,
    executable: file,
    identity: { version: "1.1.0", commit: commitOf("1.1.0"), target },
  });
  expect((await readdir(units)).sort()).toEqual(
    [codexAppServerUnit, launchpadUnit].sort(),
  );
  expect(await readFile(join(units, codexAppServerUnit), "utf8")).toBe(text);
});

test("the Codex app-server unit is converged on a supervised base of a hosted Machine, with or without --service; an unsupervised base is left alone", async () => {
  const { input, commands } = await scene();
  const folder = join(root, "Lazurio");
  await mkdir(folder);
  const units = join(root, "config/systemd/user");
  let asked = 0;
  const counted = async () => {
    asked++;
    return true;
  };
  // Unsupervised (no Launchpad unit of this base): nothing is written, the
  // hosted context is not asked and the result has no such key.
  const unsupervised = await performInstall({ ...input, hosted: counted });
  expect(unsupervised.kind).toBe("installed");
  expect(Object.keys(unsupervised)).not.toContain("codexAppServer");
  expect(asked).toBe(0);
  expect(commands).toEqual([]);
  // A workstation (or an unreadable hosted context): the Launchpad only.
  expect(await performInstall({ ...input, service: { folder } })).toMatchObject(
    {
      kind: "installed",
      serviceInstalled: true,
      codexAppServer: { state: "skipped-not-hosted" },
    },
  );
  expect(await readdir(units)).toEqual([launchpadUnit]);
  expect(commands.some((command) => command.includes(codexAppServerUnit))).toBe(
    false,
  );
  // An Environment switched before this release: the Machines apply raises
  // the pin with `install --base` and no --service. The supervised base
  // gets the unit; serviceInstalled stays false.
  commands.length = 0;
  const converged = await performInstall({ ...input, hosted: counted });
  expect(converged).toMatchObject({
    kind: "installed",
    serviceInstalled: false,
    codexAppServer: { state: "enabled" },
  });
  expect(asked).toBe(1);
  expect(await readFile(join(units, codexAppServerUnit), "utf8")).toBe(
    renderCodexAppServerUnit(),
  );
  expect(commands).toEqual([
    ["systemctl", "--user", "daemon-reload"],
    ["systemctl", "--user", "enable", codexAppServerUnit],
    ["systemctl", "--user", "start", codexAppServerUnit],
  ]);
  // Another base of this account is not supervised by that unit: untouched.
  commands.length = 0;
  const other = await performInstall({
    ...input,
    base: join(root, "data", "other"),
    hosted: counted,
  });
  expect(Object.keys(other)).not.toContain("codexAppServer");
  expect(commands).toEqual([]);
});

test.skipIf(process.platform === "win32")(
  "the offline update without --service on a supervised hosted base converges the Codex unit and restarts only the Launchpad",
  async () => {
    const { input, commands } = await scene();
    const folder = join(root, "Lazurio");
    await mkdir(folder);
    const units = join(root, "config/systemd/user");
    // Switched before this release: the Launchpad unit only.
    await performInstall({ ...input, service: { folder } });
    expect(await readdir(units)).toEqual([launchpadUnit]);
    // The restarted Launchpad reports the new version on its health socket.
    const health = Bun.serve({
      unix: layout(input.base).healthSocket,
      fetch: () => Response.json({ version: "1.1.0" }),
    });
    try {
      const file = join(root, "Downloads", "lazurio-1.1.0");
      await writeFile(file, executable("1.1.0"), { mode: 0o755 });
      commands.length = 0;
      expect(
        await performInstall({
          ...input,
          executable: file,
          identity: { version: "1.1.0", commit: commitOf("1.1.0"), target },
          hosted: hostedOperator,
        }),
      ).toMatchObject({
        kind: "updated",
        from: "1.0.0",
        to: "1.1.0",
        restartRequired: false,
        serviceInstalled: false,
        codexAppServer: { state: "enabled" },
      });
    } finally {
      health.stop(true);
    }
    expect(await readFile(join(units, codexAppServerUnit), "utf8")).toBe(
      renderCodexAppServerUnit(),
    );
    expect(commands).toEqual([
      ["systemctl", "--user", "reset-failed", launchpadUnit],
      ["systemctl", "--user", "restart", launchpadUnit],
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "enable", codexAppServerUnit],
      ["systemctl", "--user", "start", codexAppServerUnit],
    ]);
  },
);

test("a Codex app-server unit the installer did not write is left unchanged and the installation still succeeds", async () => {
  const { input, commands } = await scene();
  const folder = join(root, "Lazurio");
  await mkdir(folder);
  const units = join(root, "config/systemd/user");
  await mkdir(units, { recursive: true });
  const own = "[Service]\nExecStart=/usr/bin/true\n";
  await writeFile(join(units, codexAppServerUnit), own);
  expect(
    await performInstall({
      ...input,
      service: { folder },
      hosted: hostedOperator,
    }),
  ).toMatchObject({
    kind: "installed",
    serviceInstalled: true,
    codexAppServer: {
      state: "foreign-unit",
      next: expect.stringContaining(codexAppServerUnit),
    },
  });
  expect(await readFile(join(units, codexAppServerUnit), "utf8")).toBe(own);
  expect(commands.some((command) => command.includes(codexAppServerUnit))).toBe(
    false,
  );
  // A masked unit is a person's decision too.
  await rm(join(units, codexAppServerUnit));
  await symlink("/dev/null", join(units, codexAppServerUnit));
  expect(
    await performInstall({
      ...input,
      service: { folder },
      hosted: hostedOperator,
    }),
  ).toMatchObject({ codexAppServer: { state: "foreign-unit" } });
  expect(await readlink(join(units, codexAppServerUnit))).toBe("/dev/null");
});

test("a failing enable or start of the Codex app-server unit is reported and never fails the installation or the Launchpad", async () => {
  const { input } = await scene();
  const folder = join(root, "Lazurio");
  await mkdir(folder);
  const units = join(root, "config/systemd/user");
  for (const [refused, step] of [
    ["enable", "enable"],
    ["start", "start"],
    ["timeout", "start"],
  ] as const) {
    const commands: string[][] = [];
    const run: ProcessRunner = async (command, timeoutMs, env) => {
      if (command[0] !== "systemctl")
        return runProcess(command, timeoutMs, env);
      commands.push([...command]);
      if (command.at(-1) === codexAppServerUnit) {
        if (refused === "timeout" && command[2] === "start") return "timeout";
        if (command[2] === refused) return { exitCode: 1, stdout: "" };
      }
      return { exitCode: 0, stdout: "" };
    };
    expect(
      await performInstall({
        ...input,
        service: { folder },
        hosted: hostedOperator,
        run,
      }),
    ).toMatchObject({
      kind: "installed",
      active: "1.0.0",
      serviceInstalled: true,
      codexAppServer: { state: "failed", step, next: expect.any(String) },
    });
    // The Launchpad's unit was enabled and started first.
    expect(commands[1]).toEqual([
      "systemctl",
      "--user",
      "enable",
      "--now",
      launchpadUnit,
    ]);
    expect(await readFile(join(units, codexAppServerUnit), "utf8")).toBe(
      renderCodexAppServerUnit(),
    );
  }
  // An unwritable unit directory for it: failed at the unit, installed.
  await rm(join(units, codexAppServerUnit));
  await mkdir(join(units, codexAppServerUnit));
  await writeFile(join(units, codexAppServerUnit, "x"), "");
  expect(
    await performInstall({
      ...input,
      service: { folder },
      hosted: hostedOperator,
    }),
  ).toMatchObject({
    kind: "installed",
    codexAppServer: { state: "failed", step: "unit" },
  });
});

test("lazurio install asks the hosted context and says what became of the Codex app-server unit", async () => {
  const { input } = await scene();
  const folder = join(root, "Lazurio");
  await mkdir(folder);
  let asked = 0;
  const cli = (hostedFolder: () => Promise<string | undefined>) => ({
    identity: input.identity,
    platform: "linux",
    env: input.env,
    executable: input.executable,
    run: input.run,
    hostedFolder: () => {
      asked++;
      return hostedFolder();
    },
  });
  const service = ["--service", "systemd-user", "--folder", folder];
  const hosted = await runInstallCommand(
    ["--base", input.base, ...service, "--json"],
    cli(async () => folder),
  );
  expect(JSON.parse(hosted.stdout ?? "")).toMatchObject({
    kind: "installed",
    serviceInstalled: true,
    codexAppServer: { state: "enabled" },
  });
  const human = await runInstallCommand(
    ["--base", input.base, ...service],
    cli(async () => folder),
  );
  expect(human.stdout).toContain(
    "The Codex app-server daemon starts with this Environment (lazurio-codex-app-server.service).",
  );
  // No declared operator, or a context that cannot be read: not hosted.
  for (const hostedFolder of [
    async () => undefined,
    async () => {
      throw new Error("handover unreadable");
    },
  ])
    expect(
      JSON.parse(
        (
          await runInstallCommand(
            ["--base", input.base, ...service, "--json"],
            cli(hostedFolder),
          )
        ).stdout ?? "",
      ),
    ).toMatchObject({ codexAppServer: { state: "skipped-not-hosted" } });
  // Without the service on a base its Launchpad unit does not supervise, it
  // is not asked at all.
  asked = 0;
  await runInstallCommand(
    ["--base", join(root, "data", "other"), "--json"],
    cli(async () => folder),
  );
  expect(asked).toBe(0);
});
