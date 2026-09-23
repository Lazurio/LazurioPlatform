import { afterEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
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
  layout,
  raiseHighWater,
  readHighWater,
  readPending,
  readPrevious,
  readSelector,
  setPrevious,
  swapSelector,
} from "../src/update/layout";
import { type ProcessRunner, runProcess } from "../src/update/self-check";
import {
  detectServiceControl,
  launchpadUnit,
  rollbackUnit,
  unitFolder,
} from "../src/update/service-control";
import {
  commitOf,
  executable,
  fakeService,
  target,
} from "./fixtures/update-world";

let root: string;
afterEach(async () => rm(root, { recursive: true, force: true }));

async function scene(version = "1.0.0") {
  root = await realpath(await mkdtemp(join(tmpdir(), "upd-install-")));
  const downloaded = join(root, "Downloads", "lazurio");
  await mkdir(join(root, "Downloads"));
  await writeFile(downloaded, executable(version), { mode: 0o755 });
  const commands: string[][] = [];
  const run: ProcessRunner = async (command) => {
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
  // versions change through `lazurio update`, which verifies.
  await writeFile(input.executable, executable("2.0.0"));
  expect(
    await performInstall({
      ...input,
      identity: { ...input.identity, version: "2.0.0" },
    }),
  ).toMatchObject({ kind: "installed", active: "1.0.0" });
  expect(await readSelector(base)).toBe("1.0.0");
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

/** A newer release delivered as a file, run as `install --upgrade`. The
 * candidate's own self-check runs for real; systemctl never does. */
async function delivered(
  input: Awaited<ReturnType<typeof scene>>["input"],
  version: string,
  options: Parameters<typeof executable>[1] = {},
) {
  const file = join(root, "Downloads", `lazurio-${version}`);
  await writeFile(file, executable(version, options), { mode: 0o755 });
  const run: ProcessRunner = (command, timeoutMs, env) =>
    command[0] === "systemctl"
      ? Promise.resolve({ exitCode: 0, stdout: "" })
      : runProcess(command, timeoutMs, env);
  return {
    ...input,
    executable: file,
    identity: { version, commit: commitOf(version), target },
    upgrade: true,
    run,
  };
}

test.skipIf(process.platform === "win32")(
  "install --upgrade moves an existing installation forward to the running executable, without the network",
  async () => {
    const { input } = await scene();
    const { base } = input;
    // Without an installation it is exactly `install`.
    expect(
      await performInstall({ ...(await delivered(input, "1.0.0")) }),
    ).toMatchObject({ kind: "installed", active: "1.0.0" });

    const upgrade = await delivered(input, "1.1.0");
    expect(await performInstall(upgrade)).toEqual({
      kind: "upgraded",
      from: "1.0.0",
      to: "1.1.0",
      path: join(base, "bin"),
      serviceInstalled: false,
      // Unsupervised: the switch is the commit.
      restartRequired: true,
    });
    expect(await readSelector(base)).toBe("1.1.0");
    // The version it left stays the rollback target, and the commit raised
    // the floor of every later path.
    expect(await readPrevious(base)).toBe("1.0.0");
    expect(await readHighWater(base)).toBe("1.1.0");
    expect(await readPending(base)).toBeNull();
    expect(await readFile(join(base, "versions/1.1.0/lazurio"))).toEqual(
      await readFile(upgrade.executable),
    );
    expect((await stat(join(base, "versions/1.0.0/lazurio"))).isFile()).toBe(
      true,
    );

    // The same version again changes nothing.
    expect(await performInstall(upgrade)).toMatchObject({
      kind: "installed",
      active: "1.1.0",
    });
    expect(await readPrevious(base)).toBe("1.0.0");
  },
);

test.skipIf(process.platform === "win32")(
  "install --upgrade never goes below the floor; the high-water retry after a rollback is allowed",
  async () => {
    const { input } = await scene("2.0.0");
    const { base } = input;
    await performInstall(input);
    const refused = {
      kind: "error",
      code: "release-invalid",
      context: { resource: "version", reason: "below-floor" },
    } as const;
    // Below the active version.
    expect(await performInstall(await delivered(input, "1.9.0"))).toEqual(
      refused,
    );
    expect(await readSelector(base)).toBe("2.0.0");
    expect(await readPrevious(base)).toBeNull();

    // After a rollback from 3.0.0 the floor is the high-water mark: 2.5.0 is
    // refused although it is newer than the active version …
    await performInstall(await delivered(input, "3.0.0"));
    await swapSelector(base, "2.0.0");
    await setPrevious(base, "2.0.0");
    await raiseHighWater(base, "3.0.0");
    expect(await performInstall(await delivered(input, "2.5.0"))).toEqual(
      refused,
    );
    expect(await readSelector(base)).toBe("2.0.0");
    // … and exactly the mark is the retry, as for an exact tag.
    expect(await performInstall(await delivered(input, "3.0.0"))).toMatchObject(
      { kind: "upgraded", from: "2.0.0", to: "3.0.0" },
    );
    expect(await readSelector(base)).toBe("3.0.0");
  },
);

test.skipIf(process.platform === "win32")(
  "install --upgrade refuses a candidate that fails its own self-check and keeps the active version",
  async () => {
    const { input } = await scene();
    const { base } = input;
    await performInstall(input);
    expect(
      await performInstall(await delivered(input, "1.1.0", { healthy: false })),
    ).toMatchObject({ kind: "error", code: "self-check-failed" });
    expect(await readSelector(base)).toBe("1.0.0");
    expect(await readPrevious(base)).toBeNull();
    // What this call placed is removed again; nothing was switched.
    expect(
      await stat(join(base, "versions/1.1.0")).catch(() => null),
    ).toBeNull();
    expect(await readHighWater(base)).toBeNull();
  },
);

test.skipIf(process.platform === "win32")(
  "install --upgrade on a supervised installation restarts, commits when healthy and undoes when not",
  async () => {
    const { input } = await scene();
    const { base } = input;
    await performInstall(input);
    const healthy = fakeService(base);
    expect(
      await performInstall({
        ...(await delivered(input, "1.1.0")),
        supervisor: healthy,
      }),
    ).toMatchObject({ kind: "upgraded", to: "1.1.0", restartRequired: false });
    expect(healthy.restarts).toBe(1);
    expect(await readHighWater(base)).toBe("1.1.0");

    const unhealthy = fakeService(base, { unhealthy: ["1.2.0"] });
    expect(
      await performInstall({
        ...(await delivered(input, "1.2.0")),
        supervisor: unhealthy,
        healthDeadlineMs: 50,
      }),
    ).toMatchObject({
      kind: "error",
      code: "activation-failed",
      context: { from: "1.1.0", to: "1.2.0" },
    });
    // Undone: the previous version runs again and the floor did not rise.
    expect(await readSelector(base)).toBe("1.1.0");
    expect(unhealthy.running).toBe("1.1.0");
    expect(await readHighWater(base)).toBe("1.1.0");
    expect(await readPending(base)).toBeNull();
  },
);

test.skipIf(process.platform === "win32")(
  "install --upgrade reconciles an interrupted activation before it decides",
  async () => {
    const { input } = await scene();
    const { base } = input;
    await performInstall(input);
    // A crash between the switch to 1.1.0 and its commit: the selector names
    // 1.1.0, `previous` 1.0.0 and the marker says so.
    const upgrade = await delivered(input, "1.1.0");
    await mkdir(join(base, "versions/1.1.0"));
    await writeFile(
      join(base, "versions/1.1.0/lazurio"),
      await readFile(upgrade.executable),
      { mode: 0o500 },
    );
    await setPrevious(base, "1.0.0");
    await swapSelector(base, "1.1.0");
    await writeFile(
      layout(base).pending,
      `${JSON.stringify({ from: "1.0.0", to: "1.1.0" })}\n`,
    );
    // The Launchpad does not report 1.1.0, so the marker is undone first;
    // then the same activation runs again and commits.
    const service = fakeService(base);
    expect(
      await performInstall({ ...upgrade, supervisor: service }),
    ).toMatchObject({ kind: "upgraded", from: "1.0.0", to: "1.1.0" });
    expect(service.restarts).toBe(2);
    expect(await readSelector(base)).toBe("1.1.0");
    expect(await readHighWater(base)).toBe("1.1.0");
    expect(await readPending(base)).toBeNull();
  },
);
