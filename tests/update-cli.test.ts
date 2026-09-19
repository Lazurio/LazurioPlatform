import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUpdateFixture } from "../scripts/update-fixture";
import { runUpdateCommand } from "../src/update/cli";
import { updateErrors } from "../src/update/errors";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function scenario() {
  const fixture = createUpdateFixture({ executionTarget: "linux-x64" });
  const root = await realpath(await mkdtemp(join(tmpdir(), "update-cli-")));
  cleanups.push(async () => {
    await fixture.stop();
    await rm(root, { recursive: true });
  });
  const bootstrap = join(root, "root.json");
  await writeFile(bootstrap, fixture.bootstrapRoot, { mode: 0o600 });
  const base = join(root, "base");
  const environment = {
    identity: { version: "1.0.0", commit: "b".repeat(40), target: "linux-x64" },
    clock: () => new Date("2026-09-19T10:00:00.000Z"),
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
  const run = (args: string[]) => runUpdateCommand(args, environment);
  return { fixture, base, bootstrap, origins, run };
}

test("update --check exits 10 when an update is available, 0 when up to date, and status reads the observation offline", async () => {
  const { fixture, base, bootstrap, origins, run } = await scenario();
  fixture.release("stable", { sequence: 1, version: "1.2.0" });
  const first = await run([
    "--check",
    "--json",
    "--bootstrap-root",
    bootstrap,
    ...origins,
  ]);
  expect(first.code).toBe(10);
  expect(JSON.parse(first.stdout)).toMatchObject({
    kind: "available",
    version: "1.2.0",
    sequence: 1,
  });
  const human = await run(["--check", ...origins]);
  expect(human).toEqual({
    code: 10,
    stdout:
      "Update available: 1.2.0 (channel sequence 1). Nothing was downloaded.",
    stderr: "",
  });
  fixture.requests.length = 0;
  const status = await run(["status", "--json", "--base", base]);
  expect(status.code).toBe(0);
  expect(JSON.parse(status.stdout)).toMatchObject({
    status: "available",
    available: { version: "1.2.0" },
  });
  expect((await run(["status", "--base", base])).stdout).toContain(
    "Status: available",
  );
  expect(fixture.requests).toEqual([]);
  const current = await runUpdateCommand(["--check", ...origins], {
    identity: { version: "1.2.0", commit: "b".repeat(40), target: "linux-x64" },
  });
  expect(current).toEqual({
    code: 0,
    stdout: "Up to date: 1.2.0.",
    stderr: "",
  });
});

test("every refusal prints its stable code and exits with that code's distinct status", async () => {
  const { fixture, base, bootstrap, origins, run } = await scenario();
  fixture.release("stable", { sequence: 1, version: "1.2.0" });
  // `update` and `update rollback` act on an installation. Without a selector
  // there is none: refused before the network, and no base was created.
  for (const args of [origins, ["rollback", "--base", base]])
    expect(await run(args)).toEqual({
      code: 34,
      stdout: "",
      stderr: "Update failed: not-installed",
    });
  expect(fixture.requests).toEqual([]);
  expect(await readdir(join(base, ".."))).not.toContain("base");
  expect(await run(["--check", ...origins])).toMatchObject({
    code: 25,
    stderr: "Update failed: trust-missing",
  });
  await run(["--check", "--bootstrap-root", bootstrap, ...origins]);
  const conflict = await run([
    "--check",
    "--json",
    "--bootstrap-root",
    bootstrap,
    ...origins,
  ]);
  expect(conflict.code).toBe(26);
  expect(JSON.parse(conflict.stdout)).toEqual({
    kind: "error",
    code: "trust-conflict",
    context: {},
  });
  await fixture.stop();
  expect(await run(["--check", ...origins])).toMatchObject({
    code: 20,
    stderr: "Update failed: network-unavailable",
  });
  for (const args of [
    ["--check"],
    ["--check", ...origins, "--channel", "stable"],
    [
      "--check",
      ...origins.map((value) => (value === "stable" ? "pilot" : value)),
    ],
    ["--check", ...origins.filter((value) => value !== "--loopback-fixture")],
    ["--check", "--bootstrap-root", join(base, "absent"), ...origins],
    [
      "--check",
      ...origins.map((value) => (value === base ? "relative" : value)),
    ],
    ["status", "--check", "--base", base],
    ["status", "extra"],
    ["rollback", "--check", "--base", base],
    ["rollback", "--download-only", "--base", base],
    ["--check", "--download-only", ...origins],
    ["--service", "launchd", ...origins],
    ["--service", "systemd-user", ...origins],
    ["--service", "systemd-user", "--unit", "../evil", ...origins],
    ["--folder", "relative", ...origins],
    ["--unknown"],
  ])
    expect(await run(args)).toMatchObject({
      code: 2,
      stderr: "Update failed: invalid-request",
    });
  // The internal worker always answers its caller in JSON.
  expect(await run(["apply-worker", "--base", base])).toEqual({
    code: 2,
    stdout: '{"kind":"error","code":"invalid-request","context":{}}',
    stderr: "",
  });
  // Exit statuses are a contract: distinct per code and never 0 or 10.
  const statuses = Object.values(updateErrors).map((entry) => entry.exit);
  expect(new Set(statuses).size).toBe(statuses.length);
  expect(statuses.some((status) => [0, 10].includes(status))).toBe(false);
});

test("status without any state reports a rebuilt idle observation and creates nothing", async () => {
  const { base, run } = await scenario();
  const status = await run(["status", "--json", "--base", base]);
  expect(status.code).toBe(0);
  expect(JSON.parse(status.stdout)).toMatchObject({
    status: "idle",
    operationId: null,
    selected: null,
  });
  expect(await readdir(join(base, ".."))).not.toContain("base");
});
