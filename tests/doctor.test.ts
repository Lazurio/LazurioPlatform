import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
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
import { join, resolve } from "node:path";
import {
  type DoctorContext,
  exitAttention,
  runDoctorCommand,
} from "../src/doctor/cli";
import {
  type DoctorCheck,
  doctorCheckIds,
  doctorContextRules,
  doctorReasons,
} from "../src/doctor/doctor";
import {
  initializeFolder,
  initializeHandoverFolder,
} from "../src/folder/initialize-folder";
import { executionOs } from "../src/folder/platform";
import { presetProfile } from "../src/folder/presets";
import { machineBinding } from "../src/machine/binding";
import { parseMachineContext } from "../src/machine/context";
import { exitBroken } from "../src/recover/cli";
import type { ToolRunner } from "../src/tools/status";
import { performInstall } from "../src/update/install";
import { type ProcessRunner, runProcess } from "../src/update/self-check";
import { writeOrganization } from "./fixtures/catalog-folder";
import { handoverEntry } from "./fixtures/machine-bindings";
import organizationContext from "./fixtures/machine-context.json";
import { commitOf, executable, target } from "./fixtures/update-world";

// `lazurio doctor`: every check against a temporary install base, HOME and
// Folder. The tools are stand-in files on a temporary PATH answered by a fake
// runner; the service manager, the health socket and the handover are
// stand-ins; the only real process is the fixture executable's self-check.
// Nothing reaches the network.

let root: string | undefined;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

const localProfile = {
  os: executionOs(process.platform),
  access: "local",
  purpose: "human",
  locale: "en",
  detail: "concise",
  coordination: "direct",
} as const;

type World = Readonly<{
  root: string;
  home: string;
  base: string;
  folder: string;
  bin: string;
}>;

async function createWorld(
  options: Readonly<{
    hosted?: boolean;
    tools?: readonly string[];
    locale?: "cs" | "en";
    folderName?: string;
  }> = {},
): Promise<World> {
  root = await realpath(await mkdtemp(join(tmpdir(), "doc-")));
  const home = join(root, "home", "canaryuser");
  await mkdir(home, { recursive: true, mode: 0o700 });
  const base = join(root, "b");
  const source = join(root, "downloaded-lazurio");
  await writeFile(source, executable("1.0.0"), { mode: 0o700 });
  const installed = await performInstall({
    base,
    executable: source,
    identity: { version: "1.0.0", commit: commitOf("1.0.0"), target },
    platform: process.platform,
    env: {},
  });
  if (installed.kind !== "installed") throw new Error("Fixture install failed");
  const folder = join(home, options.folderName ?? "Lazurio");
  if (options.hosted) {
    await mkdir(join(folder, "organizations"), {
      recursive: true,
      mode: 0o700,
    });
    await initializeHandoverFolder(folder, {
      preset: "hosted-organization-personal",
      machine: recordedBinding(),
      profile: presetProfile(
        "hosted-organization-personal",
        executionOs(process.platform),
      ),
    });
  } else
    await initializeFolder(folder, {
      ...localProfile,
      locale: options.locale ?? "en",
    });
  // The operator's tools: files on PATH; the runner answers for them.
  const bin = join(root, "bin");
  await mkdir(bin);
  for (const tool of options.tools ?? ["gh", "composio"])
    await writeFile(join(bin, tool), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return Object.freeze({ root, home, base, folder, bin });
}

// The handover of an Organization work VM of one operator with its entry.
const { team: _, ...withoutTeam } = organizationContext.owner;
const handoverDocument = (name = organizationContext.machine.name) => ({
  ...organizationContext,
  machine: { ...organizationContext.machine, name },
  owner: withoutTeam,
  entry: handoverEntry("workspace.example.lazurio.io"),
});
const digestOf = (document: unknown) =>
  createHash("sha256").update(JSON.stringify(document)).digest("hex");
function recordedBinding() {
  const document = handoverDocument();
  return machineBinding(
    parseMachineContext(Buffer.from(JSON.stringify(document))),
    digestOf(document),
  );
}

const toolRun: ToolRunner = async (command) => {
  const name = command[0]?.split("/").at(-1);
  return {
    exitCode: 0,
    stdout: name === "gh" ? "gh version 2.63.0 (2026-01-01)\n" : "0.7.1\n",
    stderr: "",
  };
};

// Any command but the fixture executable's self-check is refused.
const processRun =
  (world: World): ProcessRunner =>
  async (command, timeoutMs, env) => {
    if (command[0]?.startsWith(world.root))
      return runProcess(command, timeoutMs, env);
    throw new Error(`Unexpected command ${command[0]}`);
  };

function context(
  world: World,
  options: Readonly<{
    path?: string;
    toolRun?: ToolRunner;
    health?: NonNullable<DoctorContext["recovery"]>["health"];
    machineContext?: NonNullable<DoctorContext["recovery"]>["machineContext"];
  }> = {},
): DoctorContext {
  return {
    identity: { version: "1.0.0", commit: commitOf("1.0.0"), target },
    platform: process.platform,
    env: { HOME: world.home, PATH: options.path ?? world.bin },
    executable: join(world.root, "unused"),
    run: processRun(world),
    toolRun: options.toolRun ?? toolRun,
    recovery: {
      now: () => new Date("2026-09-28T10:00:00.000Z"),
      machine: async () => ({
        home: world.home,
        user: ["canaryuser"],
        hostname: "canary-box.corp.example",
        kernel: "6.8.0",
        arch: "arm64",
        bun: "1.4.2",
      }),
      machineContext: options.machineContext ?? (async () => null),
      health: options.health ?? (async () => ({ kind: "none" })),
    },
  };
}

async function doctor(
  world: World,
  args: string[] = [],
  options: Parameters<typeof context>[1] = {},
) {
  const run = (extra: string[]) =>
    runDoctorCommand(
      ["--base", world.base, "--folder", world.folder, ...args, ...extra],
      context(world, options),
    );
  const [json, human] = await Promise.all([run(["--json"]), run([])]);
  return {
    code: json.code,
    humanCode: human.code,
    stdout: json.stdout ?? "",
    human: human.stdout ?? "",
    // Read as an outside observer reads it: untyped JSON.
    json: JSON.parse(json.stdout ?? "null"),
  };
}

const subject = (check: DoctorCheck) => {
  const context = check.context ?? {};
  return [context.tool, context.organization, context.module]
    .filter((value) => value !== undefined)
    .join("/");
};
const outcomes = (json: { checks: readonly DoctorCheck[] }) =>
  json.checks.map((check) =>
    [
      check.id,
      subject(check),
      check.outcome,
      ...(check.reason === undefined ? [] : [check.reason]),
    ]
      .filter((part) => part !== "")
      .join(" "),
  );
const find = (
  json: { checks: readonly DoctorCheck[] },
  id: string,
  name?: string,
) =>
  json.checks.find(
    (check) =>
      check.id === id && (name === undefined || subject(check) === name),
  );

/** Tier 1 as recover's tests hold it: every id and reason from the product's
 * own lists, every context value inside its rule, and no string anywhere that
 * is a path, a sentence or a value of this Machine. */
function expectTierOne(stdout: string, world: World) {
  const json = JSON.parse(stdout);
  expect(Object.keys(json).sort()).toEqual([
    "checks",
    "kind",
    "locale",
    "verdict",
  ]);
  for (const check of json.checks as DoctorCheck[]) {
    expect(doctorCheckIds).toContain(check.id);
    if (check.reason !== undefined)
      expect(doctorReasons).toContain(check.reason);
    for (const [key, value] of Object.entries(check.context ?? {}))
      expect([key, doctorContextRules[key]?.(value)]).toEqual([key, true]);
  }
  const strings: string[] = [];
  const walk = (value: unknown) => {
    if (typeof value === "string") strings.push(value);
    else if (value && typeof value === "object")
      for (const entry of Object.values(value)) walk(entry);
  };
  walk(json);
  for (const value of strings)
    expect([value, /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value)]).toEqual([
      value,
      true,
    ]);
  for (const forbidden of [world.root, world.home, "canary", tmpdir()])
    expect(stdout.toLowerCase()).not.toContain(forbidden.toLowerCase());
}

/** The human text has one row per JSON check, in order, with the same id,
 * outcome, subject and reason. */
function expectSameAnswer(human: string, json: { checks: DoctorCheck[] }) {
  const rows = human
    .split("\n")
    .filter((line) => line.startsWith("  "))
    .map((line) => line.trim().split(/\s+/));
  expect(rows.length).toBe(json.checks.length);
  json.checks.forEach((check, index) => {
    const row = rows[index] ?? [];
    expect(row.slice(0, 2)).toEqual([check.outcome, check.id]);
    const name = subject(check);
    if (name !== "") expect(row).toContain(name);
    if (check.reason !== undefined) expect(row).toContain(check.reason);
  });
}

// Every path under the root with its kind, mode, size and modification time;
// a file also with the SHA-256 of its bytes, a link with its target. Equal
// before and after is byte identity of the whole tree.
async function tree(directory: string): Promise<string[]> {
  const entries = await readdir(directory, {
    recursive: true,
    withFileTypes: true,
  });
  return Promise.all(
    entries.map(async (entry) => {
      const path = join(entry.parentPath, entry.name);
      const info = await lstat(path).catch(() => null);
      if (info === null) return `${path} vanished`;
      const facts = `${path} ${info.mode.toString(8)} ${info.size} ${info.mtimeMs}`;
      if (info.isSymbolicLink()) return `${facts} -> ${await readlink(path)}`;
      if (info.isFile())
        return `${facts} sha256:${createHash("sha256")
          .update(await readFile(path))
          .digest("hex")}`;
      return facts;
    }),
  ).then((lines) => lines.sort());
}

test("a healthy Environment: ok, exit 0, every group, the same answer in both forms, nothing written", async () => {
  const world = await createWorld();
  await writeOrganization(world.folder, "alpha", {
    slug: "alpha",
    state: "current",
    modules: [{ id: "web" }],
  });
  const before = await tree(world.root);
  const result = await doctor(world);
  expect(await tree(world.root)).toEqual(before);
  expect([result.code, result.humanCode]).toEqual([0, 0]);
  expect(result.json.verdict).toBe("ok");
  expect(outcomes(result.json)).toEqual([
    "update-state ok",
    "product-version ok",
    "self-check ok",
    "update-available skipped never-checked",
    "folder-refresh ok",
    "template-revision ok",
    "folder-state ok",
    "machine-binding skipped not-hosted",
    "tool gh ok",
    "tool composio ok",
    "tool wacli skipped not-enabled",
    "tool gogcli skipped not-enabled",
    "tool neon skipped not-enabled",
    "catalog ok",
    "organization alpha ok",
    "module alpha/web ok",
    "launchpad-unit skipped no-user-manager",
    "launchpad-health skipped not-supervised",
    "machine-entry skipped not-hosted",
  ]);
  expect(find(result.json, "tool", "gh")).toEqual({
    id: "tool",
    outcome: "ok",
    context: { tool: "gh", tier: "required", toolVersion: "2.63.0" },
  });
  expect(find(result.json, "folder-state")?.context).toEqual({
    revision: 1,
    preset: "local",
    machineKind: "workstation",
  });
  expectTierOne(result.stdout, world);
  expectSameAnswer(result.human, result.json);
  const lines = result.human.split("\n");
  expect(lines[0]).toBe("Lazurio doctor: ok.");
  expect(lines).toContain("Organizations and modules");
  expect(
    lines.some((line) => /^ {2}ok\s+module\s+alpha\/web$/.test(line)),
  ).toBe(true);
  expect(lines.at(-1)).toBe("Read only; nothing was changed.");
});

test("a pending Folder transaction is broken: exit 3, the tools still read", async () => {
  const world = await createWorld();
  await mkdir(join(world.folder, ".lazurio", "transaction"));
  const before = await tree(world.root);
  const result = await doctor(world);
  expect(await tree(world.root)).toEqual(before);
  expect([result.code, result.humanCode]).toEqual([exitBroken, exitBroken]);
  expect(result.json.verdict).toBe("broken");
  expect(find(result.json, "folder-state")).toEqual({
    id: "folder-state",
    outcome: "fail",
    reason: "folder-state-pending",
    context: { preset: "local", machineKind: "workstation" },
  });
  // The tool selection cannot be read under the lock: the catalog's tiers.
  expect(find(result.json, "tool", "gh")?.outcome).toBe("ok");
  expectTierOne(result.stdout, world);
  expectSameAnswer(result.human, result.json);
  expect(result.human.split("\n")[0]).toBe(
    "Lazurio doctor: broken; lazurio recover prepares the repair.",
  );
});

test("a Folder state without its lock is not given one: taking the lock would create it", async () => {
  const world = await createWorld();
  await rm(join(world.folder, ".lazurio", ".operation-lock"), {
    recursive: true,
  });
  const before = await tree(world.root);
  const result = await doctor(world);
  expect(await tree(world.root)).toEqual(before);
  expect(result.code).toBe(exitBroken);
  expect(find(result.json, "folder-state")?.reason).toBe(
    "folder-state-unrecognized",
  );
  expect(find(result.json, "tool", "gh")?.outcome).toBe("ok");
});

test("free text in a Folder name, an Organization directory or a tool's version line leaves nowhere", async () => {
  const world = await createWorld({ folderName: "IncidentOrchid-Lazurio" });
  await mkdir(join(world.folder, "organizations", "Acme IncidentOrchid"));
  const result = await doctor(world, [], {
    toolRun: async (command) => ({
      exitCode: 0,
      stdout:
        command[0]?.split("/").at(-1) === "gh"
          ? "gh version 2.63.0-versionincidentorchid (2026-01-01)\n"
          : "0.7.1+incidentorchid\n",
      stderr: "",
    }),
  });
  // The check keeps its outcome; the version is omitted.
  expect(find(result.json, "tool", "gh")).toEqual({
    id: "tool",
    outcome: "ok",
    context: { tool: "gh", tier: "required" },
  });
  expect(find(result.json, "tool", "composio")?.context).toEqual({
    tool: "composio",
    tier: "recommended",
  });
  expect(find(result.json, "organization", "invalid")?.outcome).toBe("warn");
  for (const text of [result.stdout, result.human])
    expect(text.toLowerCase()).not.toContain("incidentorchid");
  expectTierOne(result.stdout, world);
  expectSameAnswer(result.human, result.json);
});

test("a missing required tool fails, a missing recommended one needs attention", async () => {
  const world = await createWorld({ tools: ["composio"] });
  const missingGh = await doctor(world);
  expect(missingGh.code).toBe(exitBroken);
  expect(find(missingGh.json, "tool", "gh")).toEqual({
    id: "tool",
    outcome: "fail",
    reason: "required-missing",
    context: { tool: "gh", tier: "required" },
  });
  const missingComposio = await doctor(world, [], {
    path: join(world.root, "nothing"),
  });
  expect(find(missingComposio.json, "tool", "composio")).toEqual({
    id: "tool",
    outcome: "warn",
    reason: "recommended-missing",
    context: { tool: "composio", tier: "recommended" },
  });
  expectTierOne(missingComposio.stdout, world);
  expectSameAnswer(missingComposio.human, missingComposio.json);
});

test("a module that is not executable needs attention with its typed reason", async () => {
  const world = await createWorld();
  await writeOrganization(world.folder, "alpha", {
    slug: "alpha",
    state: "current",
    modules: [{ id: "web" }, { id: "shop", broken: true }],
  });
  // A directory that is not a readable Organization, under a name that is
  // not an identifier: named `invalid`, never as itself.
  await mkdir(join(world.folder, "organizations", "Acme Customer Plan"));
  const result = await doctor(world);
  expect([result.code, result.humanCode]).toEqual([
    exitAttention,
    exitAttention,
  ]);
  expect(result.json.verdict).toBe("attention");
  expect(find(result.json, "module", "alpha/shop")).toEqual({
    id: "module",
    outcome: "warn",
    reason: "default-app-invalid",
    context: { organization: "alpha", module: "shop" },
  });
  expect(find(result.json, "module", "alpha/web")?.outcome).toBe("ok");
  expect(find(result.json, "organization", "invalid")).toEqual({
    id: "organization",
    outcome: "warn",
    reason: "canonical-documents-required",
    context: { organization: "invalid", state: "missing" },
  });
  expect(find(result.json, "catalog")?.context).toEqual({
    organizations: 2,
    modules: 2,
  });
  expect(result.stdout).not.toContain("Acme");
  expect(result.human).not.toContain("Acme");
  expectTierOne(result.stdout, world);
  expectSameAnswer(result.human, result.json);
});

test.skipIf(process.platform === "win32")(
  "hosted: the recorded binding against the live handover, by reason only",
  async () => {
    const world = await createWorld({ hosted: true });
    const recorded = digestOf(handoverDocument());
    const live = (document: unknown, digest: string) => async () => ({
      context: document as never,
      digest,
    });
    const same = await doctor(world, [], {
      machineContext: live(handoverDocument(), recorded),
    });
    expect(find(same.json, "machine-binding")).toEqual({
      id: "machine-binding",
      outcome: "ok",
      context: { machineKind: "workspace-vm" },
    });
    expect(find(same.json, "machine-entry")).toEqual({
      id: "machine-entry",
      outcome: "ok",
    });
    const rewritten = "d".repeat(64);
    const changed = await doctor(world, [], {
      machineContext: live(handoverDocument(), rewritten),
    });
    expect(changed.code).toBe(exitAttention);
    expect(find(changed.json, "machine-binding")).toEqual({
      id: "machine-binding",
      outcome: "warn",
      reason: "handover-changed",
    });
    const other = await doctor(world, [], {
      machineContext: live(handoverDocument("other-vm"), rewritten),
    });
    expect(find(other.json, "machine-binding")?.reason).toBe(
      "machine-identity-changed",
    );
    const absent = await doctor(world);
    expect(find(absent.json, "machine-binding")?.reason).toBe(
      "handover-unreadable",
    );
    for (const result of [same, changed, other, absent]) {
      for (const digest of [recorded, rewritten]) {
        expect(result.stdout).not.toContain(digest);
        expect(result.human).not.toContain(digest);
      }
      expect(result.stdout).not.toContain("other-vm");
      expectTierOne(result.stdout, world);
      expectSameAnswer(result.human, result.json);
    }
  },
);

test("the Launchpad's health answer: Recovery mode is broken, said as an id", async () => {
  const world = await createWorld();
  const result = await doctor(world, [], {
    health: async () => ({
      kind: "recovery",
      check: "folder-state",
      refusal: null,
    }),
  });
  expect(result.code).toBe(exitBroken);
  expect(find(result.json, "launchpad-health")).toEqual({
    id: "launchpad-health",
    outcome: "fail",
    reason: "launchpad-recovery-mode",
    context: { check: "folder-state", answer: "recovery" },
  });
  expectSameAnswer(result.human, result.json);
});

test("a verified newer release needs attention; Czech by the Folder's locale", async () => {
  const world = await createWorld({ locale: "cs" });
  await writeFile(
    join(world.base, "update", "last-check.json"),
    JSON.stringify({
      checkedAt: "2026-09-28T09:00:00.000Z",
      latest: "1.1.0",
      notesUrl: "https://example.invalid/notes",
    }),
  );
  const result = await doctor(world);
  expect(result.code).toBe(exitAttention);
  expect(result.json.locale).toBe("cs");
  expect(find(result.json, "update-available")).toEqual({
    id: "update-available",
    outcome: "warn",
    reason: "update-available",
    context: { active: "1.0.0", latest: "1.1.0" },
  });
  const lines = result.human.split("\n");
  expect(lines[0]).toBe("Lazurio doctor: vyžaduje pozornost.");
  expect(lines).toContain("Produkt");
  expect(lines.at(-1)).toBe("Jen čtení; nic se nezměnilo.");
  expectTierOne(result.stdout, world);
});

test("usage: options of this command only, once, an absolute Folder", async () => {
  const world = await createWorld();
  for (const args of [
    ["extra"],
    ["--folder", "relative"],
    ["--folder", `${world.folder}/../Lazurio`],
    ["--json", "--json"],
    ["--check"],
    ["--base", "relative"],
  ]) {
    const output = await runDoctorCommand(args, context(world));
    expect([args, output.code, output.stderr]).toEqual([
      args,
      2,
      "Usage: doctor [--folder <absolute Folder>] [--sign-in] [--json]",
    ]);
  }
});

test("lazurio doctor runs from the command line with a temporary home", async () => {
  const world = await createWorld();
  const child = Bun.spawn(
    [
      process.execPath,
      resolve("src/cli.ts"),
      "doctor",
      "--base",
      world.base,
      "--folder",
      world.folder,
      "--json",
    ],
    {
      // Only the stand-in tools: nothing of this computer's can answer.
      env: { HOME: world.home, PATH: world.bin },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [code, stdout] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
  ]);
  // A source run is 0.0.0-development and not the active 1.0.0: attention,
  // and the stand-in tools answer no version.
  expect(code).toBe(exitAttention);
  const json = JSON.parse(stdout);
  expect(json.verdict).toBe("attention");
  expect(find(json, "product-version")).toMatchObject({
    outcome: "warn",
    reason: "running-not-active",
    context: { active: "1.0.0" },
  });
  expectTierOne(stdout, world);
});
