import { afterEach, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import {
  lstat,
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
import { createUpdateFixture } from "../scripts/update-fixture";
import { DistributionTransport } from "../src/distribution/transport";
import { readUpdateConfig } from "../src/update/config";
import {
  type InstallInput,
  performInstall,
  renderLaunchpadUnit,
  systemdQuote,
  userUnitDirectory,
} from "../src/update/install";
import { readObserved } from "../src/update/observed";
import type { ProcessRunner } from "../src/update/self-check";

// The installer against the signed loopback repository. The "executable" is
// synthetic bytes and the staged copy's self-check is an injected runner; the
// compiled journey (update-journey.test.ts) installs a real one.
const target = "linux-x64";
const identity = { version: "1.0.0", commit: "c".repeat(40), target };
const clock = () => new Date("2026-09-19T10:00:00.000Z");
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function scenario() {
  const fixture = createUpdateFixture({ executionTarget: target });
  const root = await realpath(await mkdtemp(join(tmpdir(), "update-install-")));
  cleanups.push(async () => {
    await fixture.stop();
    await rm(root, { recursive: true, force: true });
  });
  const executable = join(root, "downloaded-lazurio");
  const bytes = randomBytes(4096);
  await writeFile(executable, bytes, { mode: 0o755 });
  const published = fixture.addArtifact({ bytes, version: "1.0.0" });
  fixture.release("stable", {
    sequence: 1,
    version: "1.0.0",
    artifactSha256: published.sha256,
  });
  const base = join(root, "home", ".local", "share", "lazurio");
  const commands: string[][] = [];
  const failing = new Set<string>();
  const run: ProcessRunner = async (command) => {
    commands.push([...command]);
    if (command[0] === "systemctl")
      return { exitCode: failing.has(command[2] ?? "") ? 1 : 0, stdout: "" };
    // The staged copy answers its self-check with the embedded identity.
    return {
      exitCode: 0,
      stdout: JSON.stringify({ schemaVersion: 1, identity, folder: null }),
    };
  };
  const install = (overrides: Partial<InstallInput> = {}) =>
    performInstall({
      base,
      metadataBaseUrl: fixture.metadataBaseUrl,
      targetBaseUrl: fixture.targetBaseUrl,
      channel: "stable",
      identity,
      bootstrapRoot: fixture.bootstrapRoot,
      transport: new DistributionTransport(
        [fixture.origin],
        10_000,
        new AbortController().signal,
        true,
      ),
      clock,
      lockTimeoutMs: 5_000,
      executable,
      platform: "linux",
      env: { HOME: join(root, "home"), PATH: "/usr/bin", SECRET: "x" },
      run,
      ...overrides,
    });
  const unitDirectory = join(root, "home", ".config", "systemd", "user");
  const service = {
    unit: "lazurio-launchpad.service",
    unitDirectory,
    folder: join(root, "home", "Lazurio"),
  };
  const nothingCreated = async () => {
    await expect(lstat(join(root, "home"))).rejects.toThrow();
  };
  return {
    fixture,
    root,
    base,
    bytes,
    executable,
    published,
    install,
    commands,
    failing,
    service,
    unitDirectory,
    nothingCreated,
  };
}

const mode = async (path: string) => (await lstat(path)).mode & 0o777;

for (const umask of [0o002, 0o077])
  test(`install lays out an owner-only base with explicit modes under umask ${umask.toString(8).padStart(3, "0")}, selects the verified copy of itself and records what it decided`, async () => {
    const s = await scenario();
    const previous = process.umask(umask);
    let result: Awaited<ReturnType<typeof s.install>>;
    try {
      result = await s.install();
    } finally {
      process.umask(previous);
    }
    const name = `1.0.0+${s.published.sha256.slice(0, 16)}`;
    expect(result).toEqual({
      kind: "installed",
      version: "1.0.0",
      name,
      path: join(s.base, "bin"),
      service: { kind: "none" },
      available: null,
    });
    for (const directory of [
      "",
      "bin",
      "versions",
      `versions/${name}`,
      "trust",
      "update",
    ])
      expect([directory, await mode(join(s.base, directory))]).toEqual([
        directory,
        0o700,
      ]);
    expect(await mode(join(s.base, "versions", name, "lazurio"))).toBe(0o500);
    expect(await mode(join(s.base, "versions", name, "identity.json"))).toBe(
      0o400,
    );
    expect(await readlink(join(s.base, "bin", "lazurio"))).toBe(
      `../versions/${name}/lazurio`,
    );
    expect(
      (await readFile(join(s.base, "versions", name, "lazurio"))).equals(
        s.bytes,
      ),
    ).toBe(true);
    // The original is left where the person put it.
    expect((await stat(s.executable)).size).toBe(s.bytes.length);
    expect((await readdir(join(s.base, "update"))).sort()).toEqual([
      "config.json",
      "lock",
      "observed.json",
    ]);
    expect(await readUpdateConfig(s.base)).toEqual({
      service: { kind: "none" },
      folder: null,
    });
    expect(await readObserved(s.base, clock())).toMatchObject({
      status: "up-to-date",
      selected: { version: "1.0.0" },
      available: null,
      error: null,
    });
    // Once. Versions change through `lazurio update`.
    expect(await s.install()).toEqual({
      kind: "error",
      code: "already-installed",
      context: {},
    });
  });

test("an executable that cannot prove itself installs nothing: unsigned bytes, a foreign identity, no network, an existing selector of any kind", async () => {
  const s = await scenario();
  // Bytes the repository never signed (a tampered or a development build).
  const tampered = join(s.root, "tampered");
  await writeFile(tampered, Buffer.concat([s.bytes, Buffer.from("x")]));
  expect(await s.install({ executable: tampered })).toEqual({
    kind: "error",
    code: "unverified-executable",
    context: { reason: "unsigned" },
  });
  await s.nothingCreated();
  expect(await s.install({ executable: join(s.root, "absent") })).toMatchObject(
    { code: "unverified-executable", context: { reason: "unreadable" } },
  );
  // Signed bytes, but not the identity compiled into this executable.
  for (const [embedded, reason] of [
    [{ ...identity, version: "1.0.1" }, "version"],
    [{ ...identity, target: "linux-arm64" }, "target"],
    [{ ...identity, commit: "d".repeat(40) }, "commit"],
  ] as const) {
    expect(await s.install({ identity: embedded })).toEqual({
      kind: "error",
      code: reason === "target" ? "target-unsupported" : "identity-invalid",
      context:
        reason === "target"
          ? { channel: "stable", target: "linux-arm64" }
          : { reason },
    });
    await s.nothingCreated();
  }
  // A staged copy that does not answer as itself.
  expect(
    await s.install({ run: async () => ({ exitCode: 3, stdout: "" }) }),
  ).toMatchObject({ code: "self-check-failed" });
  await s.nothingCreated();
  // An existing base keeps what it had — verified trust — and gains nothing.
  await s.fixture.stop();
  expect(await s.install()).toMatchObject({ code: "network-unavailable" });
  await s.nothingCreated();
  await mkdir(join(s.base, "bin"), { recursive: true });
  await writeFile(join(s.base, "bin", "lazurio"), "someone else's");
  expect(await s.install()).toMatchObject({ code: "already-installed" });
  expect(await readdir(s.base)).toEqual(["bin"]);
});

test("the Launchpad unit is a pure function of the decision; arguments survive systemd's quoting rules", () => {
  expect(
    renderLaunchpadUnit({
      base: "/home/u/.local/share/lazurio",
      service: {
        unit: "lazurio-launchpad.service",
        unitDirectory: "/home/u/.config/systemd/user",
        folder: "/home/u/Lazurio",
      },
    }),
  ).toBe(`# Written by \`lazurio install\`. \`lazurio update\` restarts this unit by name.
[Unit]
Description=Lazurio Launchpad

[Service]
ExecStart=/home/u/.local/share/lazurio/bin/lazurio launchpad --base /home/u/.local/share/lazurio --folder /home/u/Lazurio
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
`);
  expect(
    renderLaunchpadUnit({
      base: "/b",
      service: {
        unit: "x.service",
        unitDirectory: "/u",
        folder: '/home/u/My "Lazurio" 100% $HOME\\dir',
        organizationDirectory: "/home/u/Org",
        bunExecutable: "/opt/bun",
      },
    }),
  ).toContain(
    'ExecStart=/b/bin/lazurio launchpad --base /b --folder "/home/u/My \\"Lazurio\\" 100%% $$HOME\\\\dir" --organization-directory /home/u/Org --bun-executable /opt/bun\n',
  );
  for (const hostile of ["", "a\nExecStartPre=/bin/evil", "a\u0000b"])
    expect(() => systemdQuote(hostile)).toThrow();
  expect(userUnitDirectory({ HOME: "/home/u" })).toBe(
    "/home/u/.config/systemd/user",
  );
  expect(userUnitDirectory({ HOME: "/home/u", XDG_CONFIG_HOME: "/c" })).toBe(
    "/c/systemd/user",
  );
  expect(userUnitDirectory({ HOME: "relative" })).toBeUndefined();
});

test("install --service writes, enables and starts its own unit, records the service for the updater, and never touches a unit it did not write", async () => {
  const s = await scenario();
  // A hosting engine's resident unit of the same name: refused before
  // anything else happens.
  await mkdir(s.unitDirectory, { recursive: true });
  const foreign = join(s.unitDirectory, s.service.unit);
  await writeFile(foreign, "[Service]\nExecStart=/opt/legacy/resident\n");
  expect(await s.install({ service: s.service })).toEqual({
    kind: "error",
    code: "unit-conflict",
    context: { unit: "lazurio-launchpad.service" },
  });
  expect(await readFile(foreign, "utf8")).toContain("/opt/legacy/resident");
  await expect(lstat(s.base)).rejects.toThrow();
  expect(s.commands).toEqual([]);
  // Not Linux, a unit name that is not one, a relative Folder.
  for (const overrides of [
    { platform: "darwin" },
    { service: { ...s.service, unit: "../x.service" } },
    { service: { ...s.service, folder: "Lazurio" } },
  ])
    expect(await s.install({ service: s.service, ...overrides })).toMatchObject(
      { code: "invalid-request", context: { option: "service" } },
    );

  // The service manager refuses: the whole installation is undone.
  const unit = { ...s.service, unit: "lazurio-qualify.service" };
  const unitFile = join(s.unitDirectory, unit.unit);
  s.failing.add("enable");
  expect(await s.install({ service: unit })).toEqual({
    kind: "error",
    code: "service-failed",
    context: { command: "enable" },
  });
  await expect(lstat(unitFile)).rejects.toThrow();
  await expect(lstat(s.base)).rejects.toThrow();
  expect(await readFile(foreign, "utf8")).toContain("/opt/legacy/resident");
  s.failing.clear();
  s.commands.length = 0;

  expect(await s.install({ service: unit })).toMatchObject({
    kind: "installed",
    service: { kind: "systemd-user", unit: unit.unit },
  });
  expect(await readFile(unitFile, "utf8")).toBe(
    renderLaunchpadUnit({ base: s.base, service: unit }),
  );
  expect(s.commands.filter((command) => command[0] === "systemctl")).toEqual([
    ["systemctl", "--user", "daemon-reload"],
    ["systemctl", "--user", "enable", "--now", unit.unit],
  ]);
  // What `lazurio update` reads instead of flags.
  expect(await readUpdateConfig(s.base)).toEqual({
    service: { kind: "systemd-user", unit: unit.unit },
    folder: unit.folder,
  });
  // Damaged or absent, the record means "no service, no Folder": never an error.
  await writeFile(join(s.base, "update", "config.json"), "{ not json");
  expect(await readUpdateConfig(s.base)).toEqual({
    service: { kind: "none" },
    folder: null,
  });
});
