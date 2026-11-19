import { describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrainHttp } from "../src/brain/admin";
import { readBrainState, writeBrainState } from "../src/brain/keys";
import { brainPaths, brainRefreshTimer, brainUnit } from "../src/brain/pin";
import {
  convergeVault,
  type VaultHost,
  type VaultObservation,
  vaultDeclarationOf,
  vaultPlan,
} from "../src/brain/vault";
import type { ToolRunner } from "../src/tools/status";
import type { ProcessRunner } from "../src/update/self-check";

// The brain onto the person's vault (plan LZD-0033 R11a), the decision and
// the rebuild Machines' `Vault` makes today, against stand-ins: gh, git and
// gbrain answer what they would, the brain's HTTP API is a function, and
// systemctl is recorded. Fictional repositories and tokens; no network.

const repo = "bob-example/bob-example-gbrain";

describe("the vault's declaration", () => {
  const ps = "/f/personalspace/bob-example_GEN3";
  const declared = {
    owner: { github_username: "bob-example" },
    repository: { github_repo: "bob-example/bob-example_GEN3" },
    gbrain: { repository: { github_repo: repo } },
  };
  test("one Personalspace that names its own private vault", () => {
    expect(vaultDeclarationOf([[ps, declared]])).toEqual({
      state: "declared",
      personalspace: ps,
      repo,
    });
  });
  test("nothing, two, unreadable, a shape it does not know, or not the owner's", () => {
    expect(vaultDeclarationOf([]).state).toBe("none");
    expect(vaultDeclarationOf([[ps, { owner: {} }]]).state).toBe("none");
    expect(
      vaultDeclarationOf([
        [ps, declared],
        [`${ps}2`, declared],
      ]).state,
    ).toBe("ambiguous");
    expect(vaultDeclarationOf([[ps, null]]).state).toBe("unreadable");
    expect(
      vaultDeclarationOf([
        [ps, { ...declared, gbrain: { repository: { github_repo: "x" } } }],
      ]).state,
    ).toBe("unknown-shape");
    expect(
      vaultDeclarationOf([
        [
          ps,
          {
            ...declared,
            gbrain: { repository: { github_repo: "alena-example/gbrain" } },
          },
        ],
      ]).state,
    ).toBe("foreign-owner");
    expect(
      vaultDeclarationOf([
        [
          ps,
          {
            ...declared,
            gbrain: {
              repository: { github_repo: "bob-example/bob-example_GEN3" },
            },
          },
        ],
      ]).state,
    ).toBe("foreign-owner");
  });
});

const vaultDir = "/f/personalspace/bob-example_GEN3/gbrain";
const seen = (over: Partial<VaultObservation> = {}): VaultObservation => ({
  declaration: {
    state: "declared",
    personalspace: "/f/personalspace/bob-example_GEN3",
    repo,
  },
  githubSignedIn: true,
  repoSeen: true,
  repoPrivate: true,
  gitReaches: true,
  remoteBranch: "main",
  pages: 0,
  defaultPath: null,
  vaultDir,
  vaultExists: false,
  vaultIsGit: false,
  vaultOrigin: null,
  vaultClean: false,
  onCommit: false,
  durability: null,
  timer: false,
  otherClients: [],
  ...over,
});
const onVault = {
  defaultPath: vaultDir,
  vaultExists: true,
  vaultIsGit: true,
  vaultOrigin: `https://github.com/${repo}.git`,
};

describe("the vault's decision", () => {
  test("an empty brain off the vault is rebuilt; a clean checkout is moved aside first", () => {
    expect(vaultPlan(seen())).toEqual({
      action: "rebuild",
      reason: "empty-brain",
      moveAside: false,
    });
    expect(
      vaultPlan(
        seen({
          vaultExists: true,
          vaultIsGit: true,
          vaultOrigin: `git@github.com:${repo}.git`,
          vaultClean: true,
        }),
      ),
    ).toEqual({ action: "rebuild", reason: "empty-brain", moveAside: true });
  });
  test("a brain on the vault switches on what is missing, or is connected", () => {
    expect(vaultPlan(seen({ ...onVault, durability: false }))).toEqual({
      action: "ensure",
      reason: "connected",
      missing: ["onCommit", "durability", "timer"],
    });
    expect(
      vaultPlan(
        seen({ ...onVault, durability: true, onCommit: true, timer: true }),
      ),
    ).toEqual({ action: "nothing", reason: "connected" });
  });
  test("what a person decides is only reported, never changed", () => {
    expect(vaultPlan(seen({ pages: 12 }))).toEqual({
      action: "stop",
      reason: "pages-off-vault",
    });
    expect(
      vaultPlan(
        seen({
          vaultExists: true,
          vaultIsGit: true,
          vaultOrigin: `https://github.com/${repo}.git`,
          vaultClean: false,
        }),
      ),
    ).toEqual({ action: "stop", reason: "checkout-not-clean" });
    expect(vaultPlan(seen({ repoPrivate: false }))).toEqual({
      action: "stop",
      reason: "not-private",
    });
    expect(vaultPlan(seen({ otherClients: ["claude-desktop"] }))).toEqual({
      action: "stop",
      reason: "other-client",
    });
    expect(vaultPlan(seen({ otherClients: null })).reason).toBe(
      "clients-unlisted",
    );
    expect(vaultPlan(seen({ pages: null })).reason).toBe("page-count");
    expect(
      vaultPlan(seen({ ...onVault, durability: false, gitReaches: false })),
    ).toEqual({ action: "stop", reason: "git-prompt" });
  });
  test("it waits for a declaration, the person's sign-in and the vault's first branch", () => {
    expect(vaultPlan(seen({ declaration: { state: "none" } })).reason).toBe(
      "not-declared",
    );
    expect(vaultPlan(seen({ githubSignedIn: false }))).toEqual({
      action: "waits",
      reason: "github-sign-in",
    });
    expect(vaultPlan(seen({ remoteBranch: null }))).toEqual({
      action: "waits",
      reason: "no-branch",
    });
  });
});

async function stand(
  options: Readonly<{
    fail?: string;
    idle?: boolean;
    /** The server ignores a stop (systemd says it still runs). */
    neverStops?: boolean;
  }> = {},
) {
  const root = await mkdtemp(join(tmpdir(), "brain-vault-"));
  const paths = brainPaths(join(root, "home"));
  const folder = join(paths.home, "Lazurio");
  const ps = join(folder, "personalspace", "bob-example_GEN3");
  await mkdir(ps, { recursive: true });
  await writeFile(
    join(ps, "personal.gen3.json"),
    JSON.stringify({
      owner: { github_username: "bob-example" },
      gbrain: { repository: { github_repo: repo } },
    }),
  );
  // The brain Lazurio made at install, empty, with its credential and keys.
  await mkdir(join(paths.brain, "serve"), { recursive: true });
  await writeFile(join(paths.brain, "config.json"), '{"before":true}');
  await writeFile(paths.adminToken, "a".repeat(64));
  await writeFile(
    paths.probeKey,
    JSON.stringify({ url: "http://127.0.0.1:3131", token: "p".repeat(32) }),
  );
  const brain = {
    pages: 0,
    defaultPath: null as string | null,
    up: true,
    timer: false,
  };
  const calls: string[][] = [];
  const run: ToolRunner = async (command) => {
    calls.push([...command]);
    const ok = { exitCode: 0, stdout: "", stderr: "" };
    const [tool, ...args] = command;
    if (tool === "/fake/gh") {
      if (args[0] === "repo")
        return {
          ...ok,
          stdout: JSON.stringify({
            nameWithOwner: repo,
            visibility: "PRIVATE",
          }),
        };
      return ok;
    }
    if (tool === "git") {
      const verb = args.find((a) =>
        ["ls-remote", "fetch", "ls-tree", "remote"].includes(a),
      );
      if (verb !== undefined && verb === options.fail)
        return { ...ok, exitCode: 128 };
      if (verb === "ls-remote")
        return { ...ok, stdout: "ref: refs/heads/main\tHEAD\nabc\tHEAD\n" };
      // Nothing of gbrain's own is tracked by the vault.
      if (args.includes("ls-files")) return { ...ok, exitCode: 1 };
      if (verb === "ls-tree")
        return { ...ok, stdout: "notes/a.md\nREADME.md\n" };
      return ok;
    }
    // gbrain
    if (args[0] === "init") {
      await mkdir(join(paths.brain, "serve"), { recursive: true });
      await writeFile(join(paths.brain, "config.json"), '{"vault":true}');
      const at = args[args.indexOf("--content-root") + 1] as string;
      await mkdir(join(at, ".git"), { recursive: true });
      await writeFile(join(at, "README.md"), "gbrain's own");
      brain.defaultPath = at;
      return ok;
    }
    if (args[0] === "sources" && args[1] === "writer" && args[2] === "status")
      return {
        ...ok,
        stdout: `banner\n${JSON.stringify({ admin_state: 3, bindings: [{ git_durability: "enabled", git_durability_state: "on" }] })}`,
      };
    return ok;
  };
  const service: ProcessRunner = async (command) => {
    calls.push([...command]);
    const verb = command[2];
    if (verb === options.fail) return { exitCode: 1, stdout: "", stderr: "" };
    const unit = command.slice(3).find((a) => !a.startsWith("-"));
    const isTimer = unit === brainRefreshTimer;
    if (verb === "stop") {
      if (isTimer) brain.timer = false;
      else if (!options.neverStops) brain.up = false;
    }
    if (verb === "start") {
      if (isTimer) brain.timer = true;
      else brain.up = true;
    }
    if (verb === "enable") brain.timer = true;
    if (verb === "is-active") {
      const on = isTimer ? brain.timer : brain.up;
      return {
        exitCode: on ? 0 : 3,
        stdout: on ? "active\n" : "inactive\n",
        stderr: "",
      };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  const http: BrainHttp = async (method, url, body) => {
    if (!brain.up) return null;
    const path = new URL(url).pathname;
    if (path === "/health")
      return {
        status: 200,
        body: JSON.stringify({ status: "ok", version: "1" }),
      };
    if (path === "/admin/login")
      return { status: 200, body: "{}", cookie: "admin=1" };
    if (path === "/admin/api/agents")
      return {
        status: 200,
        body: JSON.stringify([
          {
            name: "lazurio-brain-probe",
            auth_type: "api_key",
            status: "active",
          },
          {
            name: "lazurio-executor-brain",
            auth_type: "api_key",
            status: "active",
          },
          { name: "old-client", auth_type: "oauth", status: "revoked" },
        ]),
      };
    if (path === "/mcp" && method === "POST") {
      const name = (body as { params: { name: string } }).params.name;
      const value =
        name === "get_brain_identity"
          ? { page_count: brain.pages }
          : {
              sources: [
                { id: "default", local_path: brain.defaultPath ?? paths.brain },
              ],
            };
      return {
        status: 200,
        body: `event: message\ndata: ${JSON.stringify({ result: { content: [{ text: JSON.stringify(value) }] } })}\n\n`,
      };
    }
    return { status: 404, body: "{}" };
  };
  const host: VaultHost = {
    paths,
    folder,
    command: "/fake/gbrain",
    gh: "/fake/gh",
    run,
    service,
    http,
    base: "http://127.0.0.1:3131",
    env: { HOME: paths.home, PATH: "/usr/bin:/bin" },
    idle: async () => options.idle ?? true,
    now: () => new Date("2026-11-18T23:30:00Z"),
    tries: 2,
    waitMs: 1,
  };
  return { host, paths, calls, brain, vault: join(ps, "gbrain") };
}

describe("the vault's connection", () => {
  test("an empty brain is made again on the vault, with a copy and its owner credential kept", async () => {
    const { host, paths, calls, vault } = await stand();
    expect(await convergeVault(host)).toBe("rebuilt");
    // The brain before is kept whole beside it.
    const backup = join(paths.home, ".gbrain.bak-20261118T233000Z");
    expect(await readFile(join(backup, "config.json"), "utf8")).toBe(
      '{"before":true}',
    );
    expect(await readFile(paths.adminToken, "utf8")).toBe("a".repeat(64));
    // gbrain's own README the vault tracks went into the copy, not lost.
    expect(await readFile(join(backup, "content-root-README.md"), "utf8")).toBe(
      "gbrain's own",
    );
    const gits = calls.filter((c) => c[0] === "git");
    expect(gits).toContainEqual([
      "git",
      "-C",
      vault,
      "remote",
      "add",
      "origin",
      `https://github.com/${repo}.git`,
    ]);
    // git reaches the vault with the person's gh, in this repository only.
    expect(gits).toContainEqual([
      "git",
      "-C",
      vault,
      "config",
      "--local",
      "--add",
      "credential.https://github.com.helper",
      "!/fake/gh auth git-credential",
    ]);
    expect(gits).toContainEqual([
      "git",
      "-C",
      vault,
      "checkout",
      "-q",
      "-B",
      "main",
      "origin/main",
    ]);
    expect(
      calls.some((c) => c[1] === "sources" && c.includes("git-durability")),
    ).toBe(true);
    expect(calls).toContainEqual([
      "systemctl",
      "--user",
      "enable",
      "--now",
      brainRefreshTimer,
    ]);
    const exclude = await readFile(
      join(vault, ".git", "info", "exclude"),
      "utf8",
    ).catch(() => "");
    expect(exclude).toContain("/AGENTS.md");
    expect((await readBrainState(paths)).vault).toMatchObject({
      repo,
      rebuild: { state: "done", backup: ".gbrain.bak-20261118T233000Z" },
    });
  });

  test("a failed fetch brings the brain before back whole and keeps the attempt aside", async () => {
    const { host, paths, calls, brain } = await stand({ fail: "fetch" });
    expect(await convergeVault(host)).toBe("stop:rebuild-fetch");
    expect(await readFile(join(paths.brain, "config.json"), "utf8")).toBe(
      '{"before":true}',
    );
    expect(await readFile(paths.adminToken, "utf8")).toBe("a".repeat(64));
    const home = await readdir(paths.home);
    expect(home).toContain(".gbrain.failed-20261118T233000Z");
    expect(home.some((name) => name.startsWith(".gbrain.bak-"))).toBe(false);
    // Back up: the server answers and its timer refreshes again.
    expect(calls).toContainEqual(["systemctl", "--user", "start", brainUnit]);
    expect(brain.up && brain.timer).toBe(true);
    expect((await readBrainState(paths)).vault?.rebuild?.state).toBe(
      "restored-after-fetch",
    );
  });

  test("while Buddy works, nothing stops: the next run tries again", async () => {
    const { host, paths, calls } = await stand({ idle: false });
    expect(await convergeVault(host)).toBe("waits");
    expect(calls.some((c) => c[0] === "systemctl" && c[2] === "stop")).toBe(
      false,
    );
    expect(await readFile(join(paths.brain, "config.json"), "utf8")).toBe(
      '{"before":true}',
    );
  });

  test("a server that does not stop is never moved under it", async () => {
    const { host, paths, calls } = await stand({ fail: "stop" });
    expect(await convergeVault(host)).toBe("stop:rebuild-stop");
    expect(await readFile(join(paths.brain, "config.json"), "utf8")).toBe(
      '{"before":true}',
    );
    expect(calls.some((c) => c[1] === "init")).toBe(false);
  });

  // A run that died at each stage of a rebuild: the next run brings the
  // brain before back, the server and its timer up, before anything else.
  const interrupted = async (
    stage: "stopping" | "moving" | "started",
    options: Readonly<{ neverStops?: boolean }> = {},
  ) => {
    const s = await stand(options);
    const backup = join(s.paths.home, ".gbrain.bak-20261118T230000Z");
    if (stage !== "stopping") await rename(s.paths.brain, backup);
    if (stage === "started") {
      // rebuildCore had made a new brain and begun the vault's checkout.
      await mkdir(join(s.paths.brain, "serve"), { recursive: true });
      await writeFile(join(s.paths.brain, "config.json"), '{"vault":true}');
      await mkdir(join(s.vault, ".git"), { recursive: true });
    }
    s.brain.up = false;
    s.brain.timer = false;
    await writeBrainState(s.paths, {
      vault: {
        repo,
        rebuild: {
          state: stage,
          at: "2026-11-18T23:00:00.000Z",
          backup: ".gbrain.bak-20261118T230000Z",
          vaultDir: s.vault,
          moveAside: false,
        },
      },
    });
    return { ...s, backup };
  };

  for (const stage of ["stopping", "moving", "started"] as const)
    test(`a rebuild interrupted at ${stage} is recovered by the next run: the brain before back, server and timer up`, async () => {
      const { host, paths, calls, brain } = await interrupted(stage);
      expect(await convergeVault(host)).toBe("stop:rebuild-interrupted");
      expect(await readFile(join(paths.brain, "config.json"), "utf8")).toBe(
        '{"before":true}',
      );
      expect(brain.up && brain.timer).toBe(true);
      expect(calls.some((c) => c[1] === "init")).toBe(false);
      expect((await readBrainState(paths)).vault?.rebuild?.state).toBe(
        "restored-after-interrupted",
      );
      if (stage === "started")
        expect(await readdir(paths.home)).toContain(
          ".gbrain.failed-20261118T233000Z",
        );
    });

  test("a recovery whose server systemd does not confirm stopped moves nothing and keeps the journal", async () => {
    const { host, paths, brain } = await interrupted("started", {
      neverStops: true,
    });
    brain.up = true;
    const before = await readFile(paths.state, "utf8");
    expect(await convergeVault(host)).toBe("stop:rebuild-recover-not-stopped");
    expect(await readFile(join(paths.brain, "config.json"), "utf8")).toBe(
      '{"vault":true}',
    );
    expect(await readFile(paths.state, "utf8")).toBe(before);
  });

  test("a rollback after a failed step moves nothing while the server still runs, and the next run finishes it", async () => {
    const s = await stand({ fail: "fetch" });
    // The server stops for the rebuild, then ignores the rollback's stop.
    const service = s.host.service;
    let stops = 0;
    const host = {
      ...s.host,
      service: async (command: readonly string[]) => {
        if (command[2] === "stop" && command[3] === brainUnit) stops++;
        if (stops > 1 && command[2] === "stop" && command[3] === brainUnit) {
          // Something started it again in between, and it does not stop.
          s.brain.up = true;
          return { exitCode: 1, stdout: "", stderr: "" };
        }
        return service(command, 60_000);
      },
    } as VaultHost;
    expect(await convergeVault(host)).toBe("stop:rebuild-fetch");
    // The server runs again and does not stop: nothing moved.
    expect(await readFile(join(s.paths.brain, "config.json"), "utf8")).toBe(
      '{"vault":true}',
    );
    expect((await readBrainState(s.paths)).vault?.rebuild?.state).toBe(
      "started",
    );
    // A later run whose stop works brings the brain before back.
    expect(await convergeVault(s.host)).toBe("stop:rebuild-interrupted");
    expect(await readFile(join(s.paths.brain, "config.json"), "utf8")).toBe(
      '{"before":true}',
    );
  });

  test("a brain that could not be brought back waits for a person: nothing is touched", async () => {
    const { host, paths, calls } = await stand();
    await writeBrainState(paths, {
      vault: {
        repo,
        rebuild: {
          state: "restore-failed-after-fetch",
          at: "2026-11-18T23:00:00.000Z",
        },
      },
    });
    expect(await convergeVault(host)).toBe("stop:rebuild-restore-failed");
    expect(
      calls.filter(
        (c) => c[0] === "systemctl" && !["is-active"].includes(c[2] as string),
      ),
    ).toEqual([]);
    // Only reads: nothing created, fetched or checked out.
    expect(
      calls.some(
        (c) => c[1] === "init" || c.includes("fetch") || c.includes("checkout"),
      ),
    ).toBe(false);
  });

  test("a brain with pages off the vault is a person's decision", async () => {
    const { host, brain, calls } = await stand();
    brain.pages = 5;
    expect(await convergeVault(host)).toBe("stop:pages-off-vault");
    expect(calls.some((c) => c[0] === "systemctl" && c[2] === "stop")).toBe(
      false,
    );
  });
});
