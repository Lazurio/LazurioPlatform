import { afterEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  performInstall,
  renderLaunchpadUnit,
  renderRollbackUnit,
  systemdQuote,
} from "../src/update/install";
import {
  readHighWater,
  readPrevious,
  readSelector,
  writePending,
} from "../src/update/layout";
import { type ProcessRunner, runProcess } from "../src/update/self-check";
import {
  detectServiceControl,
  launchpadUnit,
  rollbackUnit,
  unitFolder,
} from "../src/update/service-control";
import { performRollback } from "../src/update/update";
import { commitOf, executable, target } from "./fixtures/update-world";

let root: string;
afterEach(async () => rm(root, { recursive: true, force: true }));

async function scene(version = "1.0.0") {
  root = await realpath(await mkdtemp(join(tmpdir(), "upd-install-")));
  const downloaded = join(root, "Downloads", "lazurio");
  await mkdir(join(root, "Downloads"));
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
      path: join(base, "bin"),
      serviceInstalled: false,
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

test("install --service writes the Launchpad unit and the static rollback unit, then enables the service", async () => {
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
    "StartLimitIntervalSec=60",
    "StartLimitBurst=5",
    "OnFailure=lazurio-rollback.service",
    "",
    "[Service]",
    // The SELECTOR: a restart runs whatever version is active.
    `ExecStart=${input.base}/bin/lazurio launchpad --base ${input.base} --folder "${root}/My Lazurio $$HOME 100%%"`,
    "Restart=on-failure",
    "RestartSec=2",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
    "[X-Lazurio]",
    `Folder=${folder}`,
    "",
  ]);
  expect(await readFile(join(units, rollbackUnit), "utf8")).toBe(
    renderRollbackUnit(input.base),
  );
  expect(renderRollbackUnit(input.base).split("\n")).toContain(
    // The PREVIOUS version undoes; it is the one known to work.
    `ExecStart=${input.base}/previous/lazurio update rollback --auto --base ${input.base}`,
  );
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
  // Newer: staged, self-checked, switched, previous recorded, mark raised.
  expect(await performInstall(await staged("1.1.0"))).toEqual({
    kind: "updated",
    from: "1.0.0",
    to: "1.1.0",
    restartRequired: true,
    path: join(base, "bin"),
    serviceInstalled: false,
  });
  expect(await readSelector(base)).toBe("1.1.0");
  expect(await readPrevious(base)).toBe("1.0.0");
  expect(await readHighWater(base)).toBe("1.1.0");
  expect((await readdir(join(base, "versions"))).sort()).toEqual([
    "1.0.0",
    "1.1.0",
  ]);
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
  expect((await readdir(join(base, "versions"))).sort()).toEqual([
    "1.0.0",
    "1.1.0",
  ]);
  // After a rollback the high-water mark is the floor: 1.1.0 again is the
  // retry, 1.0.5 stays refused even though it is above the active version.
  await performRollback({ base, identity: input.identity, service: null });
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

test("the offline update on a supervised installation restarts the installer's unit and undoes when the Launchpad never reports the new version", async () => {
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
  // No Launchpad answers on the health socket, so the activation is undone
  // exactly as `lazurio update` would undo it: switched back, restarted,
  // no high-water mark, and the tree stays usable.
  expect(
    await performInstall({
      ...input,
      executable: file,
      identity: { version: "1.1.0", commit: commitOf("1.1.0"), target },
      service: { folder },
      healthDeadlineMs: 200,
    }),
  ).toMatchObject({ kind: "error", code: "activation-failed" });
  expect(await readSelector(base)).toBe("1.0.0");
  expect(await readHighWater(base)).toBeNull();
  expect(commands.filter((c) => c[2] === "restart").map((c) => c[3])).toEqual([
    launchpadUnit,
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
  expect((await readdir(join(base, "versions"))).sort()).toEqual([
    "1.0.0",
    "1.1.0",
  ]);
  expect(await performInstall(await staged("1.1.0"))).toMatchObject({
    kind: "installed",
    active: "1.1.0",
  });
  // A marker with no selector is a state no crash produces: nothing is
  // staged or switched, the marker and the mark stay for a person to look at.
  await writePending(base, { from: "1.1.0", to: "1.2.0" });
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
  expect((await readdir(join(base, "versions"))).sort()).toEqual([
    "1.0.0",
    "1.1.0",
  ]);
});
