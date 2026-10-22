import { Database, constants as sqliteFlags } from "bun:sqlite";
import { expect, test } from "bun:test";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buddyChat,
  buddyChatSettings,
  reconcileBuddyChatSettings,
} from "../src/buddy/chat";
import { runBuddyCommand } from "../src/buddy/cli";
import { buddyRulesPath } from "../src/folder/outputs";
import { initializeMachineFolder } from "../src/machine/cli";
import type { ToolsEnvironment } from "../src/tools/overview";
import type { ToolRunner } from "../src/tools/status";
import type { CliContext } from "../src/update/cli";
import { bindings } from "./fixtures/machine-bindings";

// Buddy's chat in Lazurio (decision F61): the settings of his own T3 Code in
// ~/.t3-buddy that Lazurio owns, in T3 Code's keys and shapes
// (Lazurio/t3code packages/contracts settings.ts and providerInstance.ts,
// packages/provider-acp-registry settings.ts), written only on the user's
// Osobní Prostředí with Buddy's layer and Hermes's ACP server ready, beside
// everything else the file holds. Example names only.

const paths = { home: "/home/ada", hermes: "/home/ada/.local/bin/hermes" };

// What Lazurio owns, exactly as T3 Code decodes it: an ACP instance with a
// local command, its two variables, and the two built-in instances T3 Code
// turns on by itself, off.
const owned = {
  continueThreadsAfterServerUpdate: false,
  enableAgentBrowserAccess: false,
  providerInstances: {
    buddy: {
      driver: "acpRegistry",
      displayName: "Buddy",
      enabled: true,
      environment: [
        { name: "HERMES_HOME", value: "/home/ada/.hermes", sensitive: false },
        { name: "LAZURIO_BUDDY_CHANNEL", value: "t3", sensitive: false },
      ],
      config: {
        source: "local",
        commandPath: "/home/ada/.local/bin/hermes",
        commandArgs: ["acp"],
      },
    },
    codex: { driver: "codex", enabled: false },
    claudeAgent: { driver: "claudeAgent", enabled: false },
  },
} as const;

test("Lazurio's members of Buddy's T3 settings: the instance buddy runs hermes acp with its two variables, Codex and Claude are off, no turn continues by itself, no T3 browser for agents", () => {
  expect(buddyChatSettings(paths)).toEqual(owned);
  expect(reconcileBuddyChatSettings({}, paths)).toEqual(owned);
});

test("every member Lazurio does not own stays: the user's settings, other instances, Buddy's own variables, configuration and colour; an instance turned off keeps all but enabled", () => {
  const current = {
    favorites: [{ provider: "buddy", model: "default" }],
    continueThreadsAfterServerUpdate: true,
    providerInstances: {
      opencode: { driver: "opencode", enabled: true },
      codex: {
        driver: "codex",
        enabled: true,
        config: { binaryPath: "/usr/bin/codex" },
      },
      buddy: {
        driver: "acpRegistry",
        accentColor: "violet",
        displayName: "Rex",
        enabled: false,
        environment: [
          { name: "HERMES_DEBUG", value: "1", sensitive: false },
          {
            name: "LAZURIO_BUDDY_CHANNEL",
            value: "telegram",
            sensitive: false,
          },
        ],
        config: {
          source: "registry",
          agentId: "hermes",
          customModels: ["x"],
          // T3 Code reads a false here as off, whatever `enabled` says.
          enabled: false,
        },
      },
    },
  };
  const next = reconcileBuddyChatSettings(current, paths);
  expect(next).toEqual({
    favorites: [{ provider: "buddy", model: "default" }],
    continueThreadsAfterServerUpdate: false,
    enableAgentBrowserAccess: false,
    providerInstances: {
      opencode: { driver: "opencode", enabled: true },
      codex: {
        driver: "codex",
        enabled: false,
        config: { binaryPath: "/usr/bin/codex" },
      },
      buddy: {
        driver: "acpRegistry",
        accentColor: "violet",
        displayName: "Buddy",
        enabled: true,
        environment: [
          { name: "HERMES_DEBUG", value: "1", sensitive: false },
          ...owned.providerInstances.buddy.environment,
        ],
        config: {
          source: "local",
          agentId: "hermes",
          customModels: ["x"],
          commandPath: "/home/ada/.local/bin/hermes",
          commandArgs: ["acp"],
        },
      },
      claudeAgent: { driver: "claudeAgent", enabled: false },
    },
  });
  // Once in place, nothing more changes.
  expect(reconcileBuddyChatSettings(next, paths)).toEqual(next);
});

// ---- On an Environment -----------------------------------------------------

const posix = test.skipIf(process.platform === "win32");
const noChoices = {
  preset: undefined,
  locale: "cs",
  detail: undefined,
  coordination: undefined,
} as const;

/** The user's home with a Folder initialized from `machine`'s handover, and
 * Hermes's command where its installer puts it. */
async function environment(machine = bindings.personal) {
  const home = await realpath(await mkdtemp(join(tmpdir(), "buddy-chat-")));
  const folder = join(home, "Lazurio");
  await mkdir(folder, { mode: 0o700 });
  await mkdir(join(folder, "organizations"), { mode: 0o700 });
  await mkdir(join(folder, "personalspace"), { mode: 0o700 });
  const initialized = await initializeMachineFolder(folder, machine, {
    ...noChoices,
    preset:
      machine === bindings.personal
        ? undefined
        : "hosted-organization-personal",
  });
  expect(initialized.code).toBe(0);
  const bin = join(home, ".local", "bin");
  await mkdir(bin, { recursive: true });
  const hermes = join(bin, "hermes");
  await writeFile(hermes, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
  const checks: (readonly string[])[] = [];
  const environments: Readonly<Record<string, string>>[] = [];
  let acp = 0;
  const run: ToolRunner = async (command, _timeout, env) => {
    checks.push([...command]);
    environments.push(env);
    return { exitCode: acp, stdout: "Hermes ACP check OK\n", stderr: "" };
  };
  const tools: ToolsEnvironment = {
    home,
    path: "/usr/bin:/bin",
    platform: "linux",
    run,
  };
  const settings = join(home, ".t3-buddy", "userdata", "settings.json");
  const failAcp = () => {
    acp = 1;
  };
  return {
    home,
    folder,
    hermes,
    tools,
    settings,
    checks,
    environments,
    failAcp,
    dispose: () => rm(home, { recursive: true, force: true }),
  };
}

/** Runs `body` with environments made by `make` and removes them after. */
async function within(
  machines: readonly (typeof bindings.personal)[],
  body: (...envs: Awaited<ReturnType<typeof environment>>[]) => Promise<void>,
) {
  const envs: Awaited<ReturnType<typeof environment>>[] = [];
  try {
    for (const machine of machines) envs.push(await environment(machine));
    await body(...envs);
  } finally {
    for (const env of envs) await env.dispose();
  }
}

const written = async (path: string) =>
  JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;

posix(
  "read-only it writes nothing; --apply writes the members once, private to the account, and Hermes's ACP server answered first",
  () =>
    within([bindings.personal], async (env) => {
      const expected = buddyChatSettings({
        home: env.home,
        hermes: env.hermes,
      });
      expect(await buddyChat(env.tools, { folder: env.folder })).toEqual({
        kind: "buddy-chat",
        state: "outdated",
      });
      await expect(lstat(join(env.home, ".t3-buddy"))).rejects.toThrow();
      // Hermes's own check of its ACP server, through its launcher off PATH.
      expect(env.checks).toEqual([[env.hermes, "acp", "--check"]]);
      expect(env.environments[0]).toEqual({
        HOME: env.home,
        HERMES_HOME: join(env.home, ".hermes"),
        PATH: "/usr/bin:/bin",
      });
      expect(
        await buddyChat(env.tools, { folder: env.folder, apply: true }),
      ).toEqual({ kind: "buddy-chat", state: "managed" });
      expect(await written(env.settings)).toEqual(expected);
      expect((await stat(env.settings)).mode & 0o777).toBe(0o600);
      for (const directory of [".t3-buddy", ".t3-buddy/userdata"])
        expect((await stat(join(env.home, directory))).mode & 0o777).toBe(
          0o700,
        );
      // Applied again: nothing to write, the very same file.
      const before = await stat(env.settings);
      expect(
        await buddyChat(env.tools, { folder: env.folder, apply: true }),
      ).toEqual({ kind: "buddy-chat", state: "managed" });
      const after = await stat(env.settings);
      expect([after.ino, after.mtimeMs]).toEqual([before.ino, before.mtimeMs]);
      expect(await buddyChat(env.tools, { folder: env.folder })).toEqual({
        kind: "buddy-chat",
        state: "managed",
      });
    }),
);

posix(
  "the file as T3 Code writes it back, its own members and order, is still managed, and --apply keeps what T3 Code or the user added",
  () =>
    within([bindings.personal], async (env) => {
      await buddyChat(env.tools, { folder: env.folder, apply: true });
      const ours = await written(env.settings);
      const instances = ours.providerInstances as Record<
        string,
        Record<string, unknown>
      >;
      // T3 Code's order of its schema, and a member of its own.
      const rewritten = {
        providerInstances: {
          claudeAgent: instances.claudeAgent,
          codex: instances.codex,
          buddy: Object.fromEntries(
            Object.entries(instances.buddy ?? {}).reverse(),
          ),
        },
        enableAgentBrowserAccess: false,
        projectSettingsFolded: true,
        continueThreadsAfterServerUpdate: false,
      };
      await writeFile(env.settings, `${JSON.stringify(rewritten)}\n`);
      expect(await buddyChat(env.tools, { folder: env.folder })).toEqual({
        kind: "buddy-chat",
        state: "managed",
      });
      // The user turns Codex back on and renames Buddy: --apply restores only
      // that, and T3 Code's member stays.
      await writeFile(
        env.settings,
        JSON.stringify({
          ...rewritten,
          providerInstances: {
            ...rewritten.providerInstances,
            codex: { driver: "codex", enabled: true },
            buddy: { ...rewritten.providerInstances.buddy, displayName: "Rex" },
          },
        }),
      );
      expect(await buddyChat(env.tools, { folder: env.folder })).toEqual({
        kind: "buddy-chat",
        state: "outdated",
      });
      await buddyChat(env.tools, { folder: env.folder, apply: true });
      expect(await written(env.settings)).toEqual({
        ...ours,
        projectSettingsFolded: true,
      });
    }),
);

posix(
  "without Hermes's ACP server, Hermes, Buddy's layer, or with the layer in a Git work tree, nothing is written",
  () =>
    within([bindings.personal, bindings.personal], async (env, other) => {
      env.failAcp();
      expect(
        await buddyChat(env.tools, { folder: env.folder, apply: true }),
      ).toEqual({
        kind: "buddy-chat",
        state: "unavailable",
        reason: "hermes-acp-unavailable",
      });
      await rm(env.hermes);
      expect(
        await buddyChat(env.tools, { folder: env.folder, apply: true }),
      ).toEqual({
        kind: "buddy-chat",
        state: "unavailable",
        reason: "hermes-missing",
      });
      await expect(lstat(join(env.home, ".t3-buddy"))).rejects.toThrow();

      // Hermes on PATH is the one used, where it is.
      const onPath = join(other.home, "bin");
      await mkdir(onPath);
      await writeFile(join(onPath, "hermes"), "#!/bin/sh\n", { mode: 0o700 });
      await buddyChat(
        { ...other.tools, path: `${onPath}:/usr/bin` },
        { folder: other.folder, apply: true },
      );
      const config = (
        (await written(other.settings)).providerInstances as Record<
          string,
          { config: { commandPath: string } }
        >
      ).buddy?.config;
      expect(config?.commandPath).toBe(join(onPath, "hermes"));
      await rm(other.settings);
      // A Git work tree above Buddy's working directory would give T3 Code
      // checkpoints and its rollback a second Hermes session.
      await mkdir(join(other.folder, ".git"));
      expect(
        await buddyChat(other.tools, { folder: other.folder, apply: true }),
      ).toEqual({
        kind: "buddy-chat",
        state: "unavailable",
        reason: "buddy-layer-in-git",
      });
      await rm(join(other.folder, ".git"), { recursive: true });
      await rm(join(other.folder, buddyRulesPath));
      expect(
        await buddyChat(other.tools, { folder: other.folder, apply: true }),
      ).toEqual({
        kind: "buddy-chat",
        state: "unavailable",
        reason: "buddy-layer-missing",
      });
      await expect(lstat(other.settings)).rejects.toThrow();
    }),
);

posix(
  "a file that is no plain JSON object, one with comments T3 Code would read but a rewrite would drop, a link or another kind of file is left as it is",
  () =>
    within([bindings.personal], async (env) => {
      await mkdir(join(env.home, ".t3-buddy", "userdata"), { recursive: true });
      const unreadable = {
        kind: "buddy-chat",
        state: "unavailable",
        reason: "t3-settings-unreadable",
      } as const;
      for (const content of [
        "{ // a comment\n}",
        "[]",
        '{"providerInstances": []}',
      ]) {
        await writeFile(env.settings, content);
        expect(
          await buddyChat(env.tools, { folder: env.folder, apply: true }),
        ).toEqual(unreadable);
        expect(await readFile(env.settings, "utf8")).toBe(content);
      }
      await rm(env.settings);
      const outside = join(env.home, "outside.json");
      await writeFile(outside, "{}");
      await symlink(outside, env.settings);
      expect(
        await buddyChat(env.tools, { folder: env.folder, apply: true }),
      ).toEqual(unreadable);
      expect(await readFile(outside, "utf8")).toBe("{}");
      await rm(join(env.home, ".t3-buddy"), { recursive: true });
      await symlink(join(env.home, "elsewhere"), join(env.home, ".t3-buddy"));
      expect(
        await buddyChat(env.tools, { folder: env.folder, apply: true }),
      ).toEqual(unreadable);
    }),
);

posix(
  "another writer of the file between the read and the write: read again and keep its change; one that never stops is busy",
  () =>
    within([bindings.personal], async (env) => {
      // A T3 command that writes the file without the ownership (as `t3
      // theme set` may) between the read and the comparison.
      let writes = 0;
      const meanwhile = async (step: "read" | "replace") => {
        if (step !== "read") return;
        writes += 1;
        if (writes > 1) return;
        await writeFile(
          env.settings,
          JSON.stringify({ defaultTheme: "ocean" }),
        );
      };
      expect(
        await buddyChat(env.tools, {
          folder: env.folder,
          apply: true,
          during: meanwhile,
        }),
      ).toEqual({ kind: "buddy-chat", state: "managed" });
      expect(writes).toBe(2);
      expect(await written(env.settings)).toEqual({
        defaultTheme: "ocean",
        ...buddyChatSettings({ home: env.home, hermes: env.hermes }),
      });
      await writeFile(env.settings, "{}");
      let generation = 0;
      expect(
        await buddyChat(env.tools, {
          folder: env.folder,
          apply: true,
          during: async (step) => {
            if (step === "read")
              await writeFile(
                env.settings,
                JSON.stringify({ generation: ++generation }),
              );
          },
        }),
      ).toEqual({
        kind: "buddy-chat",
        state: "unavailable",
        reason: "t3-settings-busy",
      });
      expect(generation).toBe(5);
      expect(await written(env.settings)).toEqual({ generation: 5 });
      // No temporary file of an attempt stays behind; the ownership's file
      // is T3 Code's own, never removed.
      const { readdir } = await import("node:fs/promises");
      expect(
        (await readdir(join(env.home, ".t3-buddy", "userdata"))).sort(),
      ).toEqual(["server-owner.sqlite", "settings.json"]);
    }),
);

/** T3 Code's ownership of `stateDirectory` as its server takes it
 * (apps/server/src/serverOwnership.ts), in this process. */
function own(stateDirectory: string): Database {
  const owner = new Database(
    join(stateDirectory, "server-owner.sqlite"),
    sqliteFlags.SQLITE_OPEN_READWRITE | sqliteFlags.SQLITE_OPEN_CREATE,
  );
  owner.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;");
  return owner;
}

/** Whether a server starting now in another process would own
 * `stateDirectory`, as it tries at its start. */
function serverCouldStart(stateDirectory: string): "owned" | "busy" {
  const probe = Bun.spawnSync([
    process.execPath,
    "-e",
    `const { Database, constants } = require("bun:sqlite");
     const owner = new Database(process.argv[1], constants.SQLITE_OPEN_READWRITE | constants.SQLITE_OPEN_CREATE);
     try { owner.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;"); console.log("owned"); }
     catch (error) { console.log(error.code === "SQLITE_BUSY" ? "busy" : String(error)); }`,
    join(stateDirectory, "server-owner.sqlite"),
  ]);
  return probe.stdout.toString().trim() as "owned" | "busy";
}

posix(
  "while Buddy's T3 Code runs it owns its home: a change waits for it to stop, settings in place need none, and from the read to the replace no server starts, so none writes in between",
  () =>
    within([bindings.personal], async (env) => {
      const userdata = join(env.home, ".t3-buddy", "userdata");
      await mkdir(userdata, { recursive: true });
      const server = own(userdata);
      try {
        expect(
          await buddyChat(env.tools, { folder: env.folder, apply: true }),
        ).toEqual({
          kind: "buddy-chat",
          state: "unavailable",
          reason: "t3-running",
        });
        await expect(lstat(env.settings)).rejects.toThrow();
      } finally {
        server.close();
      }
      // Stopped: the change holds the ownership from its read to its
      // replace, between the last comparison and the replace included.
      const tried: string[] = [];
      expect(
        await buddyChat(env.tools, {
          folder: env.folder,
          apply: true,
          during: async (step) => {
            tried.push(`${step}: ${serverCouldStart(userdata)}`);
          },
        }),
      ).toEqual({ kind: "buddy-chat", state: "managed" });
      expect(tried).toEqual(["read: busy", "replace: busy"]);
      // Released when it is done: the server starts again.
      expect(serverCouldStart(userdata)).toBe("owned");
      // In place, a running server needs no change.
      const running = own(userdata);
      try {
        expect(
          await buddyChat(env.tools, { folder: env.folder, apply: true }),
        ).toEqual({ kind: "buddy-chat", state: "managed" });
      } finally {
        running.close();
      }
    }),
);

posix(
  "only the user's own Osobní Prostředí: a work Environment's Folder is skipped and nothing is read or written",
  () =>
    within([bindings.assignedOperator], async (env) => {
      expect(
        await buddyChat(env.tools, { folder: env.folder, apply: true }),
      ).toEqual({
        kind: "buddy-chat",
        state: "skipped",
        reason: "not-personal",
      });
      expect(env.checks).toEqual([]);
      await expect(lstat(join(env.home, ".t3-buddy"))).rejects.toThrow();
      // A directory that is no Folder.
      const empty = join(env.home, "empty");
      await mkdir(empty);
      expect(await buddyChat(env.tools, { folder: empty })).toEqual({
        kind: "buddy-chat",
        state: "unavailable",
        reason: "folder-unreadable",
      });
      expect(
        await buddyChat(
          { ...env.tools, home: undefined },
          { folder: env.folder },
        ),
      ).toEqual({
        kind: "buddy-chat",
        state: "unavailable",
        reason: "home-unknown",
      });
    }),
);

posix(
  "lazurio buddy chat: JSON on stdout and the exit of its state; a wrong command line is usage",
  () =>
    within(
      [bindings.personal, bindings.assignedOperator],
      async (env, work) => {
        const context = (tools: ToolsEnvironment) =>
          ({
            identity: {} as CliContext["identity"],
            platform: "linux",
            env: { HOME: tools.home, PATH: tools.path },
            executable: "/usr/local/bin/lazurio",
            toolRun: tools.run,
          }) as CliContext & { toolRun: ToolRunner };
        for (const args of [
          [],
          ["chat", "now"],
          ["chat", "--folder", "Lazurio"],
          ["chat", "--apply", "--apply"],
          ["chat", "--force"],
          ["status"],
        ])
          expect((await runBuddyCommand(args, context(env.tools))).code).toBe(
            2,
          );
        expect(
          await runBuddyCommand(
            ["chat", "--folder", env.folder, "--json"],
            context(env.tools),
          ),
        ).toEqual({
          code: 10,
          stdout: '{"kind":"buddy-chat","state":"outdated"}',
        });
        expect(
          await runBuddyCommand(
            ["chat", "--apply", "--folder", env.folder],
            context(env.tools),
          ),
        ).toEqual({
          code: 0,
          stdout: '{"kind":"buddy-chat","state":"managed"}',
        });
        expect(
          await runBuddyCommand(
            ["chat", "--folder", work.folder],
            context(work.tools),
          ),
        ).toEqual({
          code: 10,
          stdout:
            '{"kind":"buddy-chat","state":"skipped","reason":"not-personal"}',
        });
        env.failAcp();
        await rm(env.settings);
        expect(
          await runBuddyCommand(
            ["chat", "--apply", "--folder", env.folder],
            context(env.tools),
          ),
        ).toEqual({
          code: 1,
          stdout:
            '{"kind":"buddy-chat","state":"unavailable","reason":"hermes-acp-unavailable"}',
        });
      },
    ),
);
