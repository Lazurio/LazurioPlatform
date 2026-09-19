import { afterEach, expect, test } from "bun:test";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUpdateFixture } from "../scripts/update-fixture";
import { resolveInstallBase } from "../src/update/base";
import { updateErrors } from "../src/update/errors";
import {
  controlFile,
  identityOf,
  installVersion,
  type ProductBinary,
  productBinary,
  setControl,
  target,
} from "./helpers/update-product";

// REAL journeys: compiled executables A, B and C with different embedded
// versions, the signed loopback repository, and the product driven only
// through its command line — `bin/lazurio update` starts the real worker from
// the real previous executable. The executables are the TEST-ONLY product
// (tests/fixtures/update-product.ts), whose faults are switched by a control
// file; product code has no test hook.
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await setControl(null);
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function journey(
  options: {
    installedIdentity?: Record<string, unknown>;
    /** Leave the base absent: the test installs through the product. */
    bare?: boolean;
  } = {},
) {
  const a = await productBinary("1.0.0");
  const b = await productBinary("1.1.0");
  const fixture = createUpdateFixture({ executionTarget: target });
  const root = await realpath(await mkdtemp(join(tmpdir(), "update-journey-")));
  cleanups.push(async () => {
    await fixture.stop();
    await rm(root, { recursive: true, force: true });
  });
  // Where the product itself resolves its base for this HOME, so a command
  // without `--base` — the Launchpad — finds the same installation.
  const base = resolveInstallBase({
    platform: process.platform,
    env: {},
    homedir: root,
  }) as string;
  const bootstrap = join(root, "root.json");
  await writeFile(bootstrap, fixture.bootstrapRoot, { mode: 0o600 });
  if (!options.bare)
    await installVersion(base, a, options.installedIdentity ?? identityOf(a));
  const publish = (binary: ProductBinary, sequence: number) => {
    fixture.addArtifact({
      bytes: binary.bytes,
      version: binary.version,
      identity: identityOf(binary),
    });
    fixture.release("stable", {
      sequence,
      version: binary.version,
      artifactSha256: binary.sha256,
    });
  };
  const origins = [
    "--metadata-url",
    fixture.metadataBaseUrl,
    "--target-url",
    fixture.targetBaseUrl,
    "--channel",
    "stable",
    "--base",
    base,
    "--loopback-fixture",
  ];
  let trusted = false;
  /** Run the SELECTED product, exactly as a person would. */
  const spawn = (args: string[]) =>
    Bun.spawn([join(base, "bin", "lazurio"), ...args], {
      env: { HOME: root },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  const lazurio = async (args: string[]) => {
    const child = spawn(args);
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { code, stdout: stdout.trim(), stderr: stderr.trim() };
  };
  const updateArguments = (extra: string[] = []) => {
    const args = [
      "update",
      "--json",
      ...extra,
      ...origins,
      ...(trusted ? [] : ["--bootstrap-root", bootstrap]),
    ];
    trusted = true;
    return args;
  };
  const update = async (extra: string[] = []) => {
    const result = await lazurio(updateArguments(extra));
    return { code: result.code, result: JSON.parse(result.stdout) };
  };
  const selected = async () =>
    (await readlink(join(base, "bin", "lazurio"))).split("/")[2];
  const runningVersion = async () =>
    JSON.parse((await lazurio(["--version", "--json"])).stdout).version;
  const observed = async () =>
    JSON.parse(await readFile(join(base, "update", "observed.json"), "utf8"));
  const status = async () =>
    JSON.parse(
      (await lazurio(["update", "status", "--json", "--base", base])).stdout,
    );
  const updateEntries = async () =>
    (await readdir(join(base, "update"))).sort();
  const versions = async () => (await readdir(join(base, "versions"))).sort();
  const artifactDownloads = (binary: ProductBinary) =>
    fixture.rangeRequests.filter((request) =>
      request.path.endsWith(`${binary.sha256}.lazurio`),
    ).length;
  return {
    a,
    b,
    fixture,
    origins,
    bootstrap,
    root,
    base,
    publish,
    spawn,
    lazurio,
    update,
    updateArguments,
    selected,
    runningVersion,
    observed,
    status,
    updateEntries,
    versions,
    artifactDownloads,
  };
}

const settledEntries = [
  "activation.lock",
  "lock",
  "observed.json",
  "previous.json",
];

test("A→B: the selector is switched, the new version answers through it, nothing transient remains, and the previous version is kept; rollback and a repeated update use the same path", async () => {
  const j = await journey();
  j.publish(j.b, 1);
  expect(await j.runningVersion()).toBe("1.0.0");
  const progress = await j.lazurio(
    j.updateArguments().filter((argument) => argument !== "--json"),
  );
  expect(progress).toMatchObject({ code: 0, stdout: "Updated to 1.1.0." });
  expect(progress.stderr).toContain("Downloading 1.1.0: 100 %");
  expect(progress.stderr).toContain("Activating 1.1.0…");
  expect(await j.selected()).toBe(j.b.name);
  expect(await j.runningVersion()).toBe("1.1.0");
  // No record, no scratch; the previous version is retained and remembered.
  expect(await j.updateEntries()).toEqual(settledEntries);
  expect(await j.versions()).toEqual([j.a.name, j.b.name].sort());
  expect(
    JSON.parse(await readFile(join(j.base, "update", "previous.json"), "utf8")),
  ).toEqual({ schemaVersion: 1, name: j.a.name });
  expect(await j.observed()).toMatchObject({
    status: "up-to-date",
    selected: { version: "1.1.0", artifactSha16: j.b.sha256.slice(0, 16) },
    available: null,
    lastHealthyActivation: { version: "1.1.0" },
    downloadPercent: null,
    error: null,
    canRetry: false,
  });
  // The new version checks for itself and finds nothing to do.
  expect(await j.update()).toEqual({
    code: 0,
    result: { kind: "up-to-date", version: "1.1.0" },
  });
  // Rollback is an activation of `previous` through the same worker path.
  const back = await j.lazurio([
    "update",
    "rollback",
    "--json",
    "--base",
    j.base,
  ]);
  expect(JSON.parse(back.stdout)).toEqual({
    kind: "rolled-back",
    version: "1.0.0",
    from: "1.1.0",
  });
  expect(await j.runningVersion()).toBe("1.0.0");
  expect(await j.updateEntries()).toEqual(settledEntries);
  expect(await j.observed()).toMatchObject({
    selected: { version: "1.0.0" },
    lastHealthyActivation: { version: "1.0.0" },
    error: null,
  });
  // Updating again activates the retained bytes; they are re-verified, not
  // downloaded a second time.
  expect(j.artifactDownloads(j.b)).toBe(1);
  expect(await j.update()).toMatchObject({
    code: 0,
    result: { kind: "updated", version: "1.1.0", previous: "1.0.0" },
  });
  expect(j.artifactDownloads(j.b)).toBe(1);
  expect(await j.runningVersion()).toBe("1.1.0");
}, 120_000);

test("--download-only stages and stops; the next update activates; retention keeps active and previous only", async () => {
  const j = await journey();
  const c = await productBinary("1.2.0");
  j.publish(j.b, 1);
  expect(await j.update(["--download-only"])).toEqual({
    code: 0,
    result: { kind: "ready", version: "1.1.0", staged: j.b.name },
  });
  expect(await j.selected()).toBe(j.a.name);
  expect(await j.observed()).toMatchObject({
    status: "ready",
    available: { version: "1.1.0" },
    selected: { version: "1.0.0" },
  });
  expect(await j.update()).toMatchObject({ result: { kind: "updated" } });
  j.publish(c, 2);
  expect(await j.update()).toMatchObject({
    result: { kind: "updated", version: "1.2.0", previous: "1.1.0" },
  });
  expect(await j.runningVersion()).toBe("1.2.0");
  expect(await j.versions()).toEqual([j.b.name, c.name].sort());
  expect(await j.updateEntries()).toEqual(settledEntries);
}, 120_000);

test("a candidate that fails its self-check is never staged; the explicit retry runs the whole gate again", async () => {
  const j = await journey();
  j.publish(j.b, 1);
  await setControl("self-check-fails");
  expect(await j.update()).toEqual({
    code: updateErrors["self-check-failed"].exit,
    result: {
      kind: "error",
      code: "self-check-failed",
      context: { reason: "exit", exitCode: 1 },
    },
  });
  expect(await j.versions()).toEqual([j.a.name]);
  expect(await j.selected()).toBe(j.a.name);
  expect(
    (await j.updateEntries()).some((name) => name.startsWith("scratch-")),
  ).toBe(false);
  expect(await j.observed()).toMatchObject({
    status: "error",
    error: { code: "self-check-failed" },
    canRetry: true,
    available: { version: "1.1.0" },
    selected: { version: "1.0.0" },
  });
  await setControl(null);
  expect(await j.update()).toMatchObject({
    code: 0,
    result: { kind: "updated", version: "1.1.0" },
  });
  expect(j.artifactDownloads(j.b)).toBe(2);
}, 120_000);

test("a candidate that stages but does not confirm is rolled back automatically, with a typed error, and the same command works once it can", async () => {
  const j = await journey();
  j.publish(j.b, 1);
  await setControl("self-check-fails-via-selector");
  expect(await j.update()).toEqual({
    code: updateErrors["activation-failed"].exit,
    result: {
      kind: "error",
      code: "activation-failed",
      context: { reason: "self-check", rolledBackTo: "1.0.0" },
    },
  });
  // Back on a working version; no half state; the candidate stays staged.
  expect(await j.selected()).toBe(j.a.name);
  expect(await j.runningVersion()).toBe("1.0.0");
  expect(await j.updateEntries()).toEqual(
    settledEntries.filter((name) => name !== "previous.json"),
  );
  expect(await j.versions()).toEqual([j.a.name, j.b.name].sort());
  expect(await j.status()).toMatchObject({
    status: "error",
    error: { code: "activation-failed", context: { rolledBackTo: "1.0.0" } },
    canRetry: true,
    selected: { version: "1.0.0" },
    available: { version: "1.1.0" },
    lastHealthyActivation: null,
  });
  await setControl(null);
  expect(await j.update()).toMatchObject({
    code: 0,
    result: { kind: "updated", version: "1.1.0" },
  });
  expect(await j.runningVersion()).toBe("1.1.0");
  expect(await j.observed()).toMatchObject({
    status: "up-to-date",
    error: null,
  });
}, 120_000);

for (const scenario of [
  {
    stall: "worker-stalls-before-swap",
    phase: "switching",
    during: "1.0.0",
    afterwards: null,
    end: "1.0.0",
  },
  {
    stall: "worker-stalls-after-swap",
    phase: "switching",
    during: "1.1.0",
    afterwards: null,
    end: "1.0.0",
  },
  // `confirming`: the next start finishes the activation when the candidate
  // confirms, and undoes it when it does not.
  {
    stall: "worker-stalls-confirming",
    phase: "confirming",
    during: "1.1.0",
    afterwards: null,
    end: "1.1.0",
  },
  {
    stall: "worker-stalls-confirming",
    phase: "confirming",
    during: "1.1.0",
    afterwards: "self-check-fails-via-selector",
    end: "1.0.0",
  },
] as const)
  test(`kill -9 of the caller and of the worker (${scenario.stall}${scenario.afterwards ? `, then ${scenario.afterwards}` : ""}): the next start converges to ${scenario.end} and repeating it changes nothing`, async () => {
    const j = await journey();
    j.publish(j.b, 1);
    await setControl(scenario.stall);
    const caller = j.spawn(j.updateArguments());
    const reached = `${await controlFile()}.reached`;
    let worker = 0;
    for (let waited = 0; worker === 0 && waited < 60_000; waited += 50) {
      worker = Number(await readFile(reached, "utf8").catch(() => "0"));
      if (worker === 0) await Bun.sleep(50);
    }
    expect(worker).toBeGreaterThan(1);
    // The caller dies first: the worker is outside its process group and is
    // still there afterwards.
    caller.kill("SIGKILL");
    await caller.exited;
    expect(() => process.kill(worker, 0)).not.toThrow();
    process.kill(worker, "SIGKILL");
    for (let waited = 0; waited < 10_000; waited += 20) {
      try {
        process.kill(worker, 0);
        await Bun.sleep(20);
      } catch {
        break;
      }
    }
    // The half state a crash leaves: a record, and the selector wherever the
    // worker got to.
    expect(
      JSON.parse(
        await readFile(join(j.base, "update", "activation.json"), "utf8"),
      ),
    ).toMatchObject({
      phase: scenario.phase,
      previous: j.a.name,
      candidate: j.b.name,
    });
    expect(await j.selected()).toBe(
      scenario.during === "1.1.0" ? j.b.name : j.a.name,
    );
    await setControl(scenario.afterwards);
    // ANY start converges — every command does, silently unless it acted.
    // Through the selector this runs whatever the crash left selected.
    const any = await j.lazurio(["--version"]);
    expect(any.code).toBe(0);
    expect(any.stderr).toBe(
      scenario.end === "1.1.0"
        ? `Lazurio finished an interrupted update: ${j.b.name} is active.`
        : `Lazurio undid an interrupted update: ${j.a.name} is active. Run \`lazurio update\` to try again.`,
    );
    expect((await j.lazurio(["--version"])).stderr).toBe("");
    const first = await j.status();
    const confirmed = scenario.end === "1.1.0";
    expect(first).toMatchObject(
      confirmed
        ? {
            status: "up-to-date",
            error: null,
            selected: { version: "1.1.0" },
            lastHealthyActivation: { version: "1.1.0" },
          }
        : {
            status: "error",
            error: {
              code: "activation-interrupted",
              context: { phase: scenario.phase, rolledBackTo: "1.0.0" },
            },
            canRetry: true,
            selected: { version: "1.0.0" },
          },
    );
    expect(await j.runningVersion()).toBe(scenario.end);
    expect(await j.updateEntries()).toEqual(
      confirmed
        ? settledEntries
        : settledEntries.filter((name) => name !== "previous.json"),
    );
    // Idempotent: another start finds nothing to do and changes nothing.
    const second = await j.status();
    expect({ ...second, observedAt: "", selected: null }).toEqual({
      ...first,
      observedAt: "",
      selected: null,
    });
    expect(await j.runningVersion()).toBe(scenario.end);
    // And the explicit retry is simply the same command.
    await setControl(null);
    expect(await j.update()).toMatchObject({
      code: 0,
      result: confirmed
        ? { kind: "up-to-date", version: "1.1.0" }
        : { kind: "updated", version: "1.1.0" },
    });
    expect(await j.runningVersion()).toBe("1.1.0");
  }, 120_000);

test("two concurrent updates: one activates, the other is told busy or finds it done, and nothing is corrupted", async () => {
  const j = await journey();
  j.publish(j.b, 1);
  // Trust first, so that both runs start from the same established state.
  await j.lazurio(["update", "--check", ...j.updateArguments().slice(2)]);
  const runs = await Promise.all(
    [j.updateArguments(), j.updateArguments()].map(async (args) => {
      const child = j.spawn(args);
      const stdout = await new Response(child.stdout).text();
      return { code: await child.exited, result: JSON.parse(stdout) };
    }),
  );
  const kinds = runs.map((run) => run.result.kind).sort();
  expect(kinds).toContain("updated");
  const other = runs.find((run) => run.result.kind !== "updated");
  expect(other).toBeDefined();
  expect(
    other?.result.kind === "up-to-date" ||
      (other?.result.kind === "error" && other.result.code === "busy"),
  ).toBe(true);
  expect(await j.runningVersion()).toBe("1.1.0");
  expect(await j.updateEntries()).toEqual(settledEntries);
  expect(await j.versions()).toEqual([j.a.name, j.b.name].sort());
  expect(await j.status()).toMatchObject({
    status: "up-to-date",
    error: null,
    selected: { version: "1.1.0" },
  });
}, 120_000);

test("rollback is refused when the previous version cannot read the current state schemas", async () => {
  const a = await productBinary("1.0.0");
  // A's signed identity says it reads only a schema the current product does
  // not write: going back to it would strand the Folder state.
  const j = await journey({
    installedIdentity: identityOf(a, {
      schemas: { preferences: [7], manifest: [1] },
    }),
  });
  j.publish(j.b, 1);
  expect(await j.update()).toMatchObject({ result: { kind: "updated" } });
  const refused = await j.lazurio([
    "update",
    "rollback",
    "--json",
    "--base",
    j.base,
  ]);
  expect(refused.code).toBe(updateErrors["rollback-unavailable"].exit);
  expect(JSON.parse(refused.stdout)).toEqual({
    kind: "error",
    code: "rollback-unavailable",
    context: { reason: "schema", version: "1.0.0" },
  });
  expect(await j.runningVersion()).toBe("1.1.0");
  expect(await j.updateEntries()).toEqual(settledEntries);
}, 120_000);

test("a Launchpad started from the selected version announces its readiness with its own digest and withdraws it at a clean exit", async () => {
  const j = await journey();
  const folder = join(j.root, "Lazurio");
  expect(
    (
      await j.lazurio([
        "folder-init",
        "--folder",
        folder,
        ...["access", "local", "purpose", "human", "locale", "en"].map(
          (value, index) => (index % 2 === 0 ? `--${value}` : value),
        ),
        "--detail",
        "concise",
        "--coordination",
        "direct",
      ])
    ).code,
  ).toBe(0);
  const launchpad = j.spawn(["launchpad", "--folder", folder]);
  const readiness = join(j.base, "update", "launchpad-readiness.json");
  try {
    const reader = launchpad.stdout.getReader();
    const { value } = await reader.read();
    reader.releaseLock();
    expect(JSON.parse(new TextDecoder().decode(value)).url).toContain(
      "http://127.0.0.1:",
    );
    const announced = JSON.parse(await readFile(readiness, "utf8"));
    expect(announced).toMatchObject({
      schemaVersion: 1,
      artifactSha256: j.a.sha256,
      pid: launchpad.pid,
    });
    expect(Date.parse(announced.startedAt)).toBeLessThanOrEqual(Date.now());
  } finally {
    launchpad.kill("SIGTERM");
  }
  expect(await launchpad.exited).toBe(0);
  await expect(readFile(readiness, "utf8")).rejects.toThrow();
}, 120_000);

test("fresh HOME: a downloaded executable installs ITSELF after proving its bytes against signed metadata, then updates and rolls back like any installation", async () => {
  const j = await journey({ bare: true });
  // Both versions are signed artifacts; the channel already offers 1.1.0.
  j.fixture.addArtifact({
    bytes: j.a.bytes,
    version: j.a.version,
    identity: identityOf(j.a),
  });
  j.publish(j.b, 1);
  // What a person has after the HTTPS download: a file somewhere.
  const downloaded = join(j.root, "Downloads", "lazurio");
  await mkdir(join(j.root, "Downloads"));
  await copyFile(j.a.path, downloaded);
  const run = async (executable: string, args: string[]) => {
    const child = Bun.spawn([executable, ...args], {
      env: { HOME: j.root },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(child.stdout).text();
    return { code: await child.exited, stdout: stdout.trim() };
  };
  // A tampered download proves nothing and installs nothing.
  const tampered = join(j.root, "Downloads", "tampered");
  await writeFile(tampered, Buffer.concat([j.a.bytes, Buffer.from("x")]), {
    mode: 0o755,
  });
  const install = ["install", "--json", "--bootstrap-root", j.bootstrap];
  const refused = await run(tampered, [...install, ...j.origins]);
  expect(refused.code).toBe(updateErrors["unverified-executable"].exit);
  expect(JSON.parse(refused.stdout)).toMatchObject({
    code: "unverified-executable",
  });
  await expect(readdir(j.base)).rejects.toThrow();

  const installed = await run(downloaded, [...install, ...j.origins]);
  expect(JSON.parse(installed.stdout)).toEqual({
    kind: "installed",
    version: "1.0.0",
    name: j.a.name,
    path: join(j.base, "bin"),
    service: { kind: "none" },
    available: "1.1.0",
  });
  expect(installed.code).toBe(0);
  expect(await j.selected()).toBe(j.a.name);
  expect(await j.runningVersion()).toBe("1.0.0");
  for (const directory of ["", "bin", "versions", "trust", "update"])
    expect((await lstat(join(j.base, directory))).mode & 0o777).toBe(0o700);
  expect(await j.observed()).toMatchObject({
    status: "available",
    selected: { version: "1.0.0" },
    available: { version: "1.1.0" },
  });
  expect(
    JSON.parse((await run(downloaded, [...install, ...j.origins])).stdout),
  ).toMatchObject({ code: "already-installed" });
  // From here on it is an ordinary installation. Trust exists, so the update
  // needs no bootstrap root.
  const update = await j.lazurio(["update", "--json", ...j.origins]);
  expect(JSON.parse(update.stdout)).toEqual({
    kind: "updated",
    version: "1.1.0",
    previous: "1.0.0",
  });
  expect(await j.runningVersion()).toBe("1.1.0");
  const back = await j.lazurio(["update", "rollback", "--json"]);
  expect(JSON.parse(back.stdout)).toMatchObject({
    kind: "rolled-back",
    version: "1.0.0",
  });
  expect(await j.runningVersion()).toBe("1.0.0");
}, 120_000);
