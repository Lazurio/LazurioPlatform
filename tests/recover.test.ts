import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { initializeFolder } from "../src/folder/initialize-folder";
import { executionOs } from "../src/folder/platform";
import type { RecoveryCheck } from "../src/recover/checks";
import {
  exitBroken,
  type RecoverContext,
  runRecoverCommand,
} from "../src/recover/cli";
import { performInstall, renderLaunchpadUnit } from "../src/update/install";
import { layout, versionExecutable } from "../src/update/layout";
import { type ProcessRunner, runProcess } from "../src/update/self-check";
import { launchpadUnit, updateUnit } from "../src/update/service-control";
import { commitOf, executable, target } from "./fixtures/update-world";

// `lazurio recover`: every check against a temporary install base, HOME and
// Folder. The service manager, the health socket, the handover and the
// Machine's own facts are stand-ins; the only real process is the fixture
// executable's self-check. Nothing reaches the network.

let root: string | undefined;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

const detectedAt = "2026-09-28T10:00:00.000Z";
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
}>;

async function createWorld(
  options: Readonly<{ installed?: string | null; folder?: boolean }> = {},
): Promise<World> {
  root = await realpath(await mkdtemp(join(tmpdir(), "rcv-")));
  const home = join(root, "home", "canaryuser");
  await mkdir(home, { recursive: true, mode: 0o700 });
  // Short: the health socket lives under it.
  const base = join(root, "b");
  const installed =
    options.installed === undefined ? "1.0.0" : options.installed;
  if (installed !== null) {
    const source = join(root, "downloaded-lazurio");
    await writeFile(source, executable(installed), { mode: 0o700 });
    const result = await performInstall({
      base,
      executable: source,
      identity: { version: installed, commit: commitOf(installed), target },
      platform: process.platform,
      env: {},
    });
    if (result.kind !== "installed") throw new Error("Fixture install failed");
  }
  const folder = join(home, "Lazurio");
  if (options.folder !== false) await initializeFolder(folder, localProfile);
  return Object.freeze({ root, home, base, folder });
}

type Script = {
  /** `systemctl --user show` of the Launchpad unit; null: the manager fails. */
  show?: string | null;
  journal?: string;
  updateShow?: string;
  updateJournal?: string;
};

/** The service manager as a stand-in; any other command must be the
 * fixture executable under the temporary root. */
function fakeRunner(world: World, script: Script = {}) {
  const calls: string[][] = [];
  const run: ProcessRunner = async (command, timeoutMs, env) => {
    calls.push([...command]);
    const ok = (stdout: string) => ({ exitCode: 0, stdout });
    if (command[0] === "systemctl") {
      if (command[1] === "--version")
        return ok("systemd 255 (255.4-1ubuntu8.4)\n+PAM +AUDIT\n");
      if (command.at(-1) === launchpadUnit)
        return script.show === null || script.show === undefined
          ? { exitCode: 1, stdout: "" }
          : ok(script.show);
      if (command.at(-1) === updateUnit)
        return ok(
          script.updateShow ??
            "LoadState=not-found\nActiveState=inactive\nInvocationID=\n",
        );
    }
    if (command[0] === "journalctl")
      return ok(
        command.some((part) => part.startsWith("_SYSTEMD_INVOCATION_ID="))
          ? (script.updateJournal ?? "")
          : (script.journal ?? ""),
      );
    if (command[0]?.startsWith(world.root))
      return runProcess(command, timeoutMs, env);
    throw new Error(`Unexpected command ${command[0]}`);
  };
  return { run, calls };
}

const machineFacts = (world: World) => async () => ({
  home: world.home,
  user: ["canaryuser"],
  hostname: "canary-box.corp.example",
  kernel: "6.8.0-canary-box",
  arch: "arm64",
  bun: "1.4.2",
});

function context(
  world: World,
  options: Readonly<{
    running?: string;
    platform?: string;
    env?: Record<string, string>;
    run?: ProcessRunner;
    health?: NonNullable<RecoverContext["recovery"]>["health"];
    machineContext?: NonNullable<RecoverContext["recovery"]>["machineContext"];
  }> = {},
): RecoverContext {
  const running = options.running ?? "1.0.0";
  return {
    identity: { version: running, commit: commitOf(running), target },
    platform: options.platform ?? process.platform,
    env: { HOME: world.home, ...options.env },
    executable: join(world.root, "unused"),
    run: options.run ?? fakeRunner(world).run,
    recovery: {
      now: () => new Date(detectedAt),
      machine: machineFacts(world),
      machineContext: options.machineContext ?? (async () => null),
      health: options.health ?? (async () => ({ kind: "none" })),
    },
  };
}

async function recover(
  world: World,
  args: string[],
  options: Parameters<typeof context>[1] = {},
) {
  const output = await runRecoverCommand(
    ["--base", world.base, ...args],
    context(world, options),
  );
  return {
    code: output.code,
    stdout: output.stdout ?? "",
    // Read as an outside observer reads it: untyped JSON.
    json: args.includes("--json") ? JSON.parse(output.stdout ?? "null") : null,
  };
}

const outcomes = (json: { checks: readonly RecoveryCheck[] }) =>
  Object.fromEntries(
    json.checks.map((check) => [
      check.id,
      check.outcome === "failed"
        ? `failed ${check.code}`
        : check.outcome === "skipped"
          ? `skipped ${check.reason}`
          : "ok",
    ]),
  );

async function writeUnit(world: World, folder = world.folder) {
  const directory = join(world.home, ".config", "systemd", "user");
  await mkdir(directory, { recursive: true });
  // The installer's own unit of this base: the marker and this base's exact
  // ExecStart (docs/update.md "State on disk"); anything else is foreign.
  await writeFile(
    join(directory, launchpadUnit),
    renderLaunchpadUnit(world.base, folder),
  );
}

const supervisedLinux = (world: World, script: Script = {}) => ({
  platform: "linux",
  env: { XDG_RUNTIME_DIR: "/run/user/1000" },
  run: fakeRunner(world, script).run,
});

const activeUnit =
  "LoadState=loaded\nActiveState=active\nSubState=running\nResult=success\nNRestarts=0\nExecMainStatus=0\n";

test("a healthy installation: exit 0, the checks, no prompt and no issue", async () => {
  const world = await createWorld();
  const result = await recover(world, ["--folder", world.folder, "--json"]);
  expect(result.code).toBe(0);
  expect(result.json).toMatchObject({
    kind: "recovery",
    verdict: "healthy",
    evidence: null,
    prompt: null,
    issue: null,
  });
  expect(outcomes(result.json)).toEqual({
    "update-state-invalid": "ok",
    "folder-state": "ok",
    "self-check-failed": "ok",
    "launchpad-unit": "skipped no-user-manager",
    "launchpad-health": "skipped not-supervised",
  });
  expect(result.json?.checks[0]).toEqual({
    id: "update-state-invalid",
    rule: "R2",
    outcome: "ok",
    context: {},
  });
  const text = await recover(world, ["--folder", world.folder]);
  expect(text.code).toBe(0);
  expect(text.stdout.split("\n")).toEqual([
    "Lazurio recover: healthy.",
    "ok       update-state-invalid (R2)",
    "ok       folder-state                  revision=1",
    "ok       self-check-failed (R5)        version=1.0.0",
    "skipped  launchpad-unit                no-user-manager",
    "skipped  launchpad-health              not-supervised",
  ]);
});

test("nothing installed is not broken", async () => {
  const world = await createWorld({ installed: null, folder: false });
  const result = await recover(world, ["--json"]);
  expect(result.code).toBe(0);
  expect(result.json?.verdict).toBe("not-installed");
  expect(outcomes(result.json)).toEqual({
    "update-state-invalid": "ok",
    "folder-state": "skipped no-folder",
    "self-check-failed": "skipped not-installed",
    "launchpad-unit": "skipped no-user-manager",
    "launchpad-health": "skipped not-installed",
  });
});

test("R2 update-state-invalid: the path of the state, the distinct exit code", async () => {
  for (const [file, path] of [
    ["high-water", "update/high-water"],
    ["pending.json", "update/pending.json"],
  ] as const) {
    const world = await createWorld();
    await writeFile(join(world.base, "update", file), "not a version\n");
    const result = await recover(world, ["--folder", world.folder, "--json"]);
    expect(result.code).toBe(exitBroken);
    expect(result.json?.verdict).toBe("broken");
    expect(result.json?.checks[0]).toEqual({
      id: "update-state-invalid",
      rule: "R2",
      outcome: "failed",
      code: "state-invalid",
      context: { path },
    });
    expect(result.json?.evidence).toMatchObject({
      schema: "lazurio.recovery.v1",
      check: "update-state-invalid",
      code: "state-invalid",
      context: { path },
      install: {
        active: "1.0.0",
        stateInvalid: path,
        versions: ["1.0.0"],
        legacyMarker: file === "pending.json",
        legacyPrevious: false,
      },
    });
    await rm(world.root, { recursive: true, force: true });
  }
});

test("R5 self-check-failed of the active executable, by its reason", async () => {
  const cases: readonly [string, (path: string) => Promise<void>, object][] = [
    [
      "exit",
      (path) => writeFile(path, executable("1.0.0", { healthy: false })),
      { reason: "exit", exitCode: 1 },
    ],
    [
      "identity",
      (path) => writeFile(path, executable("2.0.0")),
      { reason: "identity-mismatch" },
    ],
    [
      "not executable",
      (path) => chmod(path, 0o600),
      { reason: "not-executable" },
    ],
  ];
  for (const [name, damage, context] of cases) {
    const world = await createWorld();
    const path = versionExecutable(world.base, "1.0.0");
    await chmod(join(path, ".."), 0o700);
    await chmod(path, 0o700);
    await damage(path);
    const result = await recover(world, ["--folder", world.folder, "--json"]);
    expect([name, result.code]).toEqual([name, exitBroken]);
    expect([name, result.json?.checks[2]]).toEqual([
      name,
      {
        id: "self-check-failed",
        rule: "R5",
        outcome: "failed",
        code: "self-check-failed",
        context,
      },
    ]);
    expect(result.json?.evidence.check).toBe("self-check-failed");
    await rm(world.root, { recursive: true, force: true });
  }
});

test("the Folder's state as this version reads it", async () => {
  const cases: readonly [string, (world: World) => Promise<void>, string][] = [
    [
      "absent",
      (world) => rm(join(world.folder, ".lazurio"), { recursive: true }),
      "folder-state-absent",
    ],
    [
      "pending",
      (world) => mkdir(join(world.folder, ".lazurio", "transaction")),
      "folder-state-pending",
    ],
    [
      "unrecognized",
      (world) => writeFile(join(world.folder, ".lazurio", "stray"), "x"),
      "folder-state-unrecognized",
    ],
    [
      "unreadable",
      (world) =>
        writeFile(join(world.folder, ".lazurio", "preferences.json"), "{", {
          mode: 0o600,
        }),
      "folder-state-unreadable",
    ],
  ];
  for (const [name, damage, code] of cases) {
    const world = await createWorld();
    await damage(world);
    const result = await recover(world, ["--folder", world.folder, "--json"]);
    expect([name, result.code, result.json?.checks[1].code]).toEqual([
      name,
      exitBroken,
      code,
    ]);
    // A pending transaction still has readable facts.
    if (name === "pending")
      expect(result.json?.evidence.folder).toMatchObject({
        preset: "local",
        machineKind: "workstation",
        pendingTransaction: true,
      });
    await rm(world.root, { recursive: true, force: true });
  }
});

test("the supervised unit through systemctl --user, and its health socket", async () => {
  const unit = (active: string, sub: string, extra = "") =>
    `LoadState=loaded\nActiveState=${active}\nSubState=${sub}\nResult=exit-code\nNRestarts=4\nExecMainStatus=1\n${extra}`;
  const cases: readonly [string | null, string][] = [
    [activeUnit, "ok"],
    [unit("failed", "failed"), "failed unit-failed"],
    [unit("activating", "auto-restart"), "failed unit-restarting"],
    [unit("inactive", "dead"), "failed unit-inactive"],
    ["LoadState=not-found\nActiveState=inactive\n", "failed unit-not-loaded"],
    [unit("maintenance", "x"), "skipped unit-state-unknown"],
    [null, "skipped user-manager-unreachable"],
  ];
  for (const [show, expected] of cases) {
    const world = await createWorld();
    await writeUnit(world);
    const result = await recover(world, ["--json"], {
      ...supervisedLinux(world, { show }),
      health: async () => ({ kind: "version", version: "1.0.0" }),
    });
    expect([show, outcomes(result.json)["launchpad-unit"]]).toEqual([
      show,
      expected,
    ]);
    // The supervised unit's Folder is the one read.
    expect(outcomes(result.json)["folder-state"]).toBe("ok");
    if (expected === "failed unit-failed")
      expect(result.json?.checks[3].context).toEqual({
        activeState: "failed",
        subState: "failed",
        result: "exit-code",
        nRestarts: 4,
        execMainStatus: 1,
      });
    await rm(world.root, { recursive: true, force: true });
  }
  const health: readonly [unknown, string, boolean][] = [
    [{ kind: "version", version: "1.0.0" }, "ok", true],
    [
      { kind: "version", version: "0.9.0" },
      "failed launchpad-version-mismatch",
      true,
    ],
    [
      { kind: "recovery", check: "start-refused", refusal: null },
      "failed launchpad-recovery-mode",
      true,
    ],
    [{ kind: "unexpected" }, "failed launchpad-not-answering", true],
    [{ kind: "none" }, "failed launchpad-not-answering", true],
    [{ kind: "none" }, "skipped not-supervised", false],
    [{ kind: "version", version: "1.0.0" }, "ok", false],
  ];
  for (const [answer, expected, supervised] of health) {
    const world = await createWorld();
    if (supervised) await writeUnit(world);
    const result = await recover(world, ["--folder", world.folder, "--json"], {
      ...supervisedLinux(world, { show: activeUnit }),
      health: async () => answer as never,
    });
    expect([answer, outcomes(result.json)["launchpad-health"]]).toEqual([
      answer,
      expected,
    ]);
    // Without a unit the manager is never asked about one.
    if (!supervised)
      expect(outcomes(result.json)["launchpad-unit"]).toBe(
        "skipped not-supervised",
      );
    await rm(world.root, { recursive: true, force: true });
  }
});

test("the health socket is asked over its Unix socket", async () => {
  const { askHealth } = await import("../src/recover/observe");
  const world = await createWorld({ folder: false });
  expect(await askHealth(world.base)).toEqual({ kind: "none" });
  for (const [response, expected] of [
    [
      () => Response.json({ version: "1.0.0" }),
      { kind: "version", version: "1.0.0" },
    ],
    [
      () =>
        Response.json(
          { mode: "recovery", check: "start-refused" },
          { status: 503 },
        ),
      { kind: "recovery", check: "start-refused", refusal: null },
    ],
    [
      // The answer of a Launchpad in Recovery mode (health-socket.ts).
      () =>
        Response.json(
          {
            mode: "recovery",
            check: "start-refused",
            reason: "folder-transaction-pending",
          },
          { status: 503 },
        ),
      {
        kind: "recovery",
        check: "start-refused",
        refusal: "folder-transaction-pending",
      },
    ],
    [
      // A reason that is not even an id is not read.
      () =>
        Response.json(
          { mode: "recovery", check: "start-refused", reason: "Not An Id!" },
          { status: 503 },
        ),
      { kind: "recovery", check: "start-refused", refusal: null },
    ],
    [() => Response.json({ version: "not a version" }), { kind: "unexpected" }],
    [() => new Response("<html>", { status: 200 }), { kind: "unexpected" }],
  ] as const) {
    const server = Bun.serve({
      unix: layout(world.base).healthSocket,
      fetch: response,
    });
    try {
      expect(await askHealth(world.base)).toEqual(expected);
    } finally {
      await server.stop(true);
      await rm(layout(world.base).healthSocket, { force: true });
    }
  }
});

test("a Launchpad in Recovery mode: the issue says why its start was refused", async () => {
  const world = await createWorld();
  const recovering = (check: string, refusal: string) =>
    recover(world, ["--folder", world.folder, "--json"], {
      health: async () => ({ kind: "recovery", check, refusal }),
    });
  const pending = await recovering(
    "start-refused",
    "folder-transaction-pending",
  );
  expect(pending.code).toBe(exitBroken);
  expect(pending.json.evidence).toMatchObject({
    check: "launchpad-health",
    code: "launchpad-recovery-mode",
    context: { check: "start-refused", refusal: "folder-transaction-pending" },
  });
  expect(pending.json.issue.kind).toBe("prepared");
  const body: string = pending.json.issue.body;
  expect(body).toContain('"check":"start-refused"');
  expect(body).toContain('"refusal":"folder-transaction-pending"');
  // Two refusals are two faults: two fingerprints, two issues.
  const unreadable = await recovering(
    "start-refused",
    "folder-state-unreadable",
  );
  expect(unreadable.json.evidence.context.refusal).toBe(
    "folder-state-unreadable",
  );
  expect(unreadable.json.evidence.fingerprint).not.toBe(
    pending.json.evidence.fingerprint,
  );
  // A refusal or check the product does not define leaves nowhere.
  const unknown = await recovering("from-the-future", "not-a-refusal");
  expect(unknown.json.evidence.context).toEqual({});
  expect(unknown.stdout).not.toContain("not-a-refusal");
  expect(unknown.stdout).not.toContain("from-the-future");
  const known = await recovering("start-refused", "not-a-refusal");
  expect(known.json.evidence.context).toEqual({ check: "start-refused" });
  expect(known.json.issue.body).not.toContain("not-a-refusal");
});

// Every private value planted in every source; none may reach the body.
const canaries = {
  user: "canaryuser",
  host: "canary-box",
  organizations: ["Acme-Canary", "globex-canary"],
  repositories: ["moonshot-canary", "ledger-canary"],
  // The checkout directory is not the GitHub login (`<Owner>_GEN3`): these
  // are known only from each Organization's declaration.
  declaredLogins: ["AcmeCanary", "GlobexCanary"],
  declaredRoots: ["acme-root", "globex-root"],
  login: "canary-login",
  tailnetIp: "100.64.0.77",
  ipv6: "fd7a:115c:a1e0::77",
  email: "canary@corp.example",
  lazurioHost: "launchpad.canary-vm.acme-canary.lazurio.io",
  handoverOrganization: "handover-canary-org",
  handoverRepository: "HandoverCanary/infra-canary",
};
const sessionToken = "5a".repeat(32);
const tokens = [
  `ghp_${"Zz09".repeat(9)}`,
  `github_pat_${"q".repeat(40)}`,
  "uak_canarycanary",
  ["-----BEGIN OPENSSH", "PRIVATE KEY-----"].join(" "),
  "Bearer canarybearer",
  sessionToken,
];

async function cannedWorld() {
  const world = await createWorld();
  for (const organization of canaries.organizations)
    for (const repository of canaries.repositories)
      await mkdir(
        join(
          world.folder,
          "organizations",
          organization,
          "workspace",
          repository,
        ),
        { recursive: true },
      );
  const [acme, globex] = canaries.organizations;
  const [acmeLogin, globexLogin] = canaries.declaredLogins;
  const [acmeRoot, globexRoot] = canaries.declaredRoots;
  await writeFile(
    join(world.folder, "organizations", `${acme}`, "lazurio.organization.json"),
    JSON.stringify({
      organization: { forge_binding: { locator: acmeLogin } },
      root_repository: { locator: `${acmeLogin}/${acmeRoot}` },
    }),
    { mode: 0o600 },
  );
  await writeFile(
    join(world.folder, "organizations", `${globex}`, "company.gen3.json"),
    JSON.stringify({
      company: {
        github_org: globexLogin,
        repository: `git@github.com:${globexLogin}/${globexRoot}.git`,
      },
    }),
    { mode: 0o600 },
  );
  await writeUnit(world);
  const journal = [
    `Started Lazurio Launchpad for ${world.folder} on ${canaries.host}.`,
    `{"url":"http://127.0.0.1:41234/#${sessionToken}","scope":"local-development-profile-panel"}`,
    `lazurio 1.0.0 (commit ${commitOf("1.0.0")}, target ${target})`,
    `error: ${world.folder}/organizations/${canaries.organizations[0]}/workspace/${canaries.repositories[0]}: EACCES`,
    `user ${canaries.user} at ${canaries.tailnetIp} and ${canaries.ipv6}`,
    `mail ${canaries.email}; entry https://${canaries.lazurioHost}`,
    `gh: signed in as ${canaries.login}`,
    `handover ${canaries.handoverOrganization} ${canaries.handoverRepository}`,
    `git@github.com:${acmeLogin}/${acmeRoot}.git: fetch failed`,
    `remote https://github.com/${globexLogin}/${globexRoot} denied`,
    ...tokens.map((token) => `tool said ${token}`),
    "Main process exited, code=exited, status=1/FAILURE",
  ].join("\n");
  return { world, journal };
}

const handoverContext = async () => {
  const organization = (await import("./fixtures/machine-context.json"))
    .default;
  return {
    context: {
      ...organization,
      owner: {
        ...organization.owner,
        organization: canaries.handoverOrganization,
        // The GitHub login is known from the handover only (docs/recovery.md).
        assignment: {
          kind: "operator",
          github_login: canaries.login,
          github_id: 424242,
        },
      },
      host: {
        ...organization.host,
        custody_repository: canaries.handoverRepository,
      },
    } as never,
    digest: "d".repeat(64),
  };
};

test("canaries in every source never reach the issue body, which passes the gate", async () => {
  const { world, journal } = await cannedWorld();
  const failedUnit =
    "LoadState=loaded\nActiveState=activating\nSubState=auto-restart\nResult=exit-code\nNRestarts=12\nExecMainStatus=1\n";
  const result = await recover(world, ["--json"], {
    ...supervisedLinux(world, {
      show: failedUnit,
      journal,
      updateShow: `LoadState=loaded\nActiveState=failed\nInvocationID=${"e".repeat(32)}\n`,
      // Tier 1: an id is kept; a path, a message and an odd key are not.
      updateJournal: `{"kind":"error","code":"self-check-failed","context":{"reason":"exit","exitCode":1,"note":"${world.home}","message":"cannot read the Folder","up":"../x","bad key":"exit"}}`,
    }),
    machineContext: handoverContext,
  });
  expect(result.code).toBe(exitBroken);
  const { evidence, issue, prompt } = result.json ?? {};
  expect(evidence.check).toBe("launchpad-unit");
  expect(evidence.code).toBe("unit-restarting");
  expect(evidence.failed).toEqual(["launchpad-unit", "launchpad-health"]);
  expect(evidence.platform).toEqual({
    os: "linux",
    // Only the numbers of the release: its suffix is free-form.
    kernel: "6.8.0",
    arch: "arm64",
    systemd: 255,
    bun: "1.4.2",
  });
  expect(evidence.unit.lastUpdateFailure).toEqual({
    code: "self-check-failed",
    context: { reason: "exit", exitCode: 1 },
  });
  expect(issue.kind).toBe("prepared");
  expect(issue.repository).toBe("Lazurio/LazurioPlatform");
  const leaving = [
    issue.title,
    issue.body,
    decodeURIComponent(issue.link),
  ].join("\n");
  const forbidden = [
    world.root,
    world.home,
    world.folder,
    canaries.user,
    canaries.host,
    ...canaries.organizations,
    ...canaries.repositories,
    ...canaries.declaredLogins,
    ...canaries.declaredRoots,
    canaries.login,
    canaries.tailnetIp,
    canaries.ipv6,
    canaries.email,
    canaries.lazurioHost,
    canaries.handoverOrganization,
    ...canaries.handoverRepository.split("/"),
    ...tokens,
    "canary",
  ];
  for (const value of forbidden) {
    expect([
      value,
      leaving.toLowerCase().includes(value.toLowerCase()),
    ]).toEqual([value, false]);
    // The prompt carries the same sanitized evidence.
    const evidenceInPrompt = prompt.slice(prompt.indexOf("```json"));
    expect(
      evidenceInPrompt
        .slice(0, evidenceInPrompt.indexOf("\n```\n"))
        .toLowerCase(),
    ).not.toContain(value.toLowerCase());
  }
  // The body's JSON is the evidence without its journal, as printed.
  const { journal: _, ...fields } = evidence;
  expect(
    JSON.parse(/```json\n([\s\S]*?)\n```/.exec(issue.body)?.[1] ?? ""),
  ).toEqual(fields);
  expect(Buffer.byteLength(issue.body)).toBeLessThanOrEqual(6 * 1024);
  expect(issue.title).toBe(
    `Recovery: launchpad-unit (unit-restarting) on ${target} [${evidence.fingerprint}]`,
  );
  expect(evidence.fingerprint).toMatch(/^rf-[0-9a-f]{12}$/);
  expect(issue.search).toEqual([
    "gh",
    "issue",
    "list",
    "--repo",
    "Lazurio/LazurioPlatform",
    "--state",
    "all",
    "--search",
    `"${evidence.fingerprint}" in:title`,
  ]);
  expect(issue.create).toEqual([
    "gh",
    "issue",
    "create",
    "--repo",
    "Lazurio/LazurioPlatform",
    "--title",
    issue.title,
    "--body-file",
    "-",
  ]);
  expect(issue.shell).toBe(
    `gh issue create --repo Lazurio/LazurioPlatform --title '${issue.title}' --body-file - <<'LAZURIO_RECOVERY_BODY'\n${issue.body}LAZURIO_RECOVERY_BODY`,
  );
  expect(issue.bodyInLink).toBe(issue.link.includes("&body="));
  expect(
    issue.link.startsWith(
      "https://github.com/Lazurio/LazurioPlatform/issues/new?title=",
    ),
  ).toBe(true);
  // The shell text is what a POSIX shell reads: the title survives quoting
  // and the here-document delivers the body unchanged.
  const shell = Bun.spawnSync(
    ["/bin/sh", "-c", issue.shell.replace(/^gh issue create .*? <</, "cat <<")],
    { env: {}, stdout: "pipe" },
  );
  expect(new TextDecoder().decode(shell.stdout)).toBe(issue.body);
});

test("--json keeps the sanitized journal on this Machine; the issue never carries it", async () => {
  const { world, journal } = await cannedWorld();
  const result = await recover(world, ["--json"], {
    ...supervisedLinux(world, {
      show: "LoadState=loaded\nActiveState=failed\nSubState=failed\nResult=exit-code\nNRestarts=3\nExecMainStatus=1\n",
      journal,
    }),
  });
  expect(result.code).toBe(exitBroken);
  const { evidence, issue, prompt } = result.json ?? {};
  // Tier 2 is in the local output, sanitized: the product's own commit
  // survives, withheld lines are marked, known values are placeholders.
  const lines: string[] = evidence.journal.split("\n");
  expect(lines).toContain("Started Lazurio Launchpad for <folder> on <host>.");
  expect(lines).toContain(
    `lazurio 1.0.0 (commit ${commitOf("1.0.0")}, target ${target})`,
  );
  expect(lines).toContain("[line withheld]");
  expect(lines).toContain("Main process exited, code=exited, status=1/FAILURE");
  expect(evidence.journal).not.toContain(world.folder);
  // Tier 1 leaves: not one journal line in the title, body, command or link.
  expect(issue.kind).toBe("prepared");
  const leaving = [
    issue.title,
    issue.body,
    issue.shell,
    decodeURIComponent(issue.link),
  ].join("\n");
  for (const line of lines)
    expect([line, leaving.includes(line)]).toEqual([line, false]);
  expect(leaving).not.toContain('"journal"');
  // The prompt names it as tier 2 and does not carry it either.
  expect(prompt).toContain("`evidence.journal`");
  for (const line of lines) expect(prompt.includes(line)).toBe(false);
});

test("a Folder-recorded template revision that is a path leaves as `invalid`, nowhere as itself", async () => {
  const world = await createWorld();
  const manifest = join(world.folder, ".lazurio", "instructions.json");
  const recorded = JSON.parse(await Bun.file(manifest).text());
  await writeFile(
    manifest,
    JSON.stringify({ ...recorded, templateRevision: "/srv/UniqueCustomer" }),
    { mode: 0o600 },
  );
  await writeFile(join(world.base, "update", "high-water"), "x");
  const json = await recover(world, ["--folder", world.folder, "--json"]);
  const human = await recover(world, ["--folder", world.folder]);
  expect(json.code).toBe(exitBroken);
  expect(human.code).toBe(exitBroken);
  const { evidence, issue, prompt } = json.json ?? {};
  expect(evidence.check).toBe("update-state-invalid");
  expect(evidence.folder.recordedTemplateRevision).toBe("invalid");
  expect(issue.kind).toBe("prepared");
  for (const text of [
    issue.title,
    issue.body,
    issue.shell,
    issue.link,
    decodeURIComponent(issue.link),
    prompt,
    json.stdout,
    human.stdout,
  ])
    expect(text).not.toContain("UniqueCustomer");
});

test("a free-text key of the update unit's journal leaves nowhere; its reason does", async () => {
  const { world } = await cannedWorld();
  const script = {
    show: "LoadState=loaded\nActiveState=failed\nSubState=failed\nResult=exit-code\nNRestarts=3\nExecMainStatus=1\n",
    updateShow: `LoadState=loaded\nActiveState=failed\nInvocationID=${"e".repeat(32)}\n`,
    updateJournal:
      '{"kind":"error","code":"self-check-failed","context":{"message":"IncidentOrchid","reason":"exit"}}',
  };
  const json = await recover(world, ["--json"], supervisedLinux(world, script));
  const human = await recover(world, [], supervisedLinux(world, script));
  expect(json.code).toBe(exitBroken);
  const { evidence, issue, prompt } = json.json ?? {};
  expect(evidence.unit.lastUpdateFailure).toEqual({
    code: "self-check-failed",
    context: { reason: "exit" },
  });
  expect(issue.kind).toBe("prepared");
  expect(issue.body).toContain('"reason":"exit"');
  for (const text of [
    issue.title,
    issue.body,
    issue.shell,
    decodeURIComponent(issue.link),
    prompt,
    json.stdout,
    human.stdout,
  ])
    expect(text).not.toContain("IncidentOrchid");
});

test("an id-shaped value outside the product's own list leaves nowhere; a known reason does", async () => {
  const { world } = await cannedWorld();
  const script = {
    show: "LoadState=loaded\nActiveState=failed\nSubState=failed\nResult=exit-code\nNRestarts=3\nExecMainStatus=1\n",
    updateShow: `LoadState=loaded\nActiveState=failed\nInvocationID=${"e".repeat(32)}\n`,
  };
  const run = (reason: string) => ({
    ...script,
    updateJournal: `{"kind":"error","code":"self-check-failed","context":{"reason":"${reason}","stage":"incidentorchid","resource":"incidentorchid","check":"incidentorchid","activeState":"incidentorchid","reported":"1.0.0-incidentorchid"}}`,
  });
  const json = await recover(
    world,
    ["--json"],
    supervisedLinux(world, run("incidentorchid")),
  );
  const human = await recover(
    world,
    [],
    supervisedLinux(world, run("incidentorchid")),
  );
  expect(json.code).toBe(exitBroken);
  const { evidence, issue, prompt } = json.json ?? {};
  expect(evidence.unit.lastUpdateFailure).toEqual({
    code: "self-check-failed",
    context: {},
  });
  expect(issue.kind).toBe("prepared");
  for (const text of [
    issue.title,
    issue.body,
    issue.shell,
    issue.link,
    decodeURIComponent(issue.link),
    prompt,
    json.stdout,
    human.stdout,
  ])
    expect(text.toLowerCase()).not.toContain("incidentorchid");
  // A reason the product emits survives.
  const known = await recover(
    world,
    ["--json"],
    supervisedLinux(world, run("exit")),
  );
  expect(known.json?.evidence.unit.lastUpdateFailure.context).toEqual({
    reason: "exit",
  });
  expect(known.json?.issue.body).toContain('"reason":"exit"');
});

test("the fingerprint names one fault across releases", async () => {
  const fingerprints = new Map<string, string>();
  for (const [running, path] of [
    ["1.0.0", "high-water"],
    ["1.1.0", "high-water"],
    ["1.0.0", "pending.json"],
  ] as const) {
    const world = await createWorld({ installed: running });
    await writeFile(join(world.base, "update", path), "x");
    const result = await recover(world, ["--folder", world.folder, "--json"], {
      running,
    });
    fingerprints.set(`${running} ${path}`, result.json?.evidence.fingerprint);
    await rm(world.root, { recursive: true, force: true });
  }
  expect(fingerprints.get("1.0.0 high-water")).toBe(
    fingerprints.get("1.1.0 high-water") as string,
  );
  expect(fingerprints.get("1.0.0 high-water")).not.toBe(
    fingerprints.get("1.0.0 pending.json") as string,
  );
});

test("the human form: checks, the prompt, where the issue goes and that nothing was filed", async () => {
  const { world, journal } = await cannedWorld();
  const result = await recover(world, [], {
    ...supervisedLinux(world, {
      show: "LoadState=loaded\nActiveState=failed\nSubState=failed\nResult=start-limit-hit\nNRestarts=5\nExecMainStatus=1\n",
      journal,
    }),
  });
  expect(result.code).toBe(exitBroken);
  const lines = result.stdout.split("\n");
  expect(lines.slice(0, 6)).toEqual([
    "Lazurio recover: broken.",
    "ok       update-state-invalid (R2)",
    "ok       folder-state                  revision=1",
    "ok       self-check-failed (R5)        version=1.0.0",
    "failed   launchpad-unit                unit-failed activeState=failed subState=failed result=start-limit-hit nRestarts=5 execMainStatus=1",
    "failed   launchpad-health              launchpad-not-answering reason=no-answer",
  ]);
  expect(result.stdout).toContain(
    "Prompt for the repair agent (it stays on this Machine):",
  );
  expect(result.stdout).toContain(
    "**Task:** Lazurio on this Machine needs a repair",
  );
  expect(result.stdout).toContain(
    "Issue for the public repository Lazurio/LazurioPlatform. This command filed nothing; filing is the repair agent's act under the standing mandate for issues (root decision 0163).",
  );
  expect(result.stdout).toContain(
    "Search for a duplicate first: gh issue list --repo Lazurio/LazurioPlatform --state all --search '\"rf-",
  );
  expect(result.stdout).toContain(
    "gh issue create --repo Lazurio/LazurioPlatform --title 'Recovery: launchpad-unit (unit-failed)",
  );
  expect(result.stdout).toContain(
    "\nWithout gh: https://github.com/Lazurio/LazurioPlatform/issues/new?title=",
  );
});

test("usage: options of this command only, an absolute Folder, cs or en", async () => {
  const world = await createWorld({ folder: false });
  for (const args of [
    ["extra"],
    ["--locale", "de"],
    ["--folder", "relative"],
    ["--folder", `${world.root}/../x`],
    ["--unknown"],
    ["--check"],
  ]) {
    const output = await runRecoverCommand(
      ["--base", world.base, ...args],
      context(world),
    );
    expect([
      args,
      output.code,
      output.stderr?.startsWith("Usage: recover"),
    ]).toEqual([args, 2, true]);
  }
  expect(
    (await runRecoverCommand(["--base", "relative"], context(world))).code,
  ).toBe(2);
});

test("lazurio recover runs from the command line with a temporary home", async () => {
  const world = await createWorld();
  const child = Bun.spawn(
    [
      process.execPath,
      resolve("src/cli.ts"),
      "recover",
      "--base",
      world.base,
      "--folder",
      world.folder,
      "--json",
    ],
    {
      // No PATH: nothing of this computer's tools can answer.
      env: { HOME: world.home, PATH: "" },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [code, stdout] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
  ]);
  // A source run is 0.0.0-development; the active fixture reports 1.0.0 and
  // is judged against the active version, so the installation is healthy.
  expect(code).toBe(0);
  expect(JSON.parse(stdout)).toMatchObject({ verdict: "healthy" });
});
