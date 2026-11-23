import { afterAll, afterEach, expect, test } from "bun:test";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeFolder } from "../src/folder/initialize-folder";
import {
  FolderOperationBusyError,
  withFolderOperationLock,
} from "../src/folder/lock";
import { executionOs } from "../src/folder/platform";
import {
  folderRefreshNeeded,
  neededRefresh,
} from "../src/folder/refresh-needed";
import { instructionTemplateRevision } from "../src/folder/render";
import { updateProfile } from "../src/folder/update-profile";
import { initializeMachineFolder } from "../src/machine/cli";
import { type CliContext, runUpdateCommand } from "../src/update/cli";
import {
  detachedCommand,
  refreshFolderWhenBehind,
  resumePreparedTransaction,
} from "../src/update/folder-refresh";
import { layout, readSelector } from "../src/update/layout";
import { type ProcessRunner, runProcess } from "../src/update/self-check";
import {
  recordedRevisions,
  refreshRunner,
  renderedBy,
} from "./fixtures/folder-refresh";
import { binding } from "./fixtures/machine-bindings";
import personal from "./fixtures/machine-context-personal.json";
import {
  closeSharedSigstore,
  commitOf,
  createWorld,
  target,
  type World,
} from "./fixtures/update-world";

// The update refreshes the Folder (F17's addendum of 2026-10-30): after the
// switch, by the version it activated, and also when nothing newer was found;
// a blocked refresh leaves the update successful and stays visible to agents.
// Every home and Folder here is temporary; the refresh is this checkout's
// own CLI, the templates of the active version.

const profile = {
  os: executionOs(process.platform),
  access: "local",
  purpose: "human",
  locale: "en",
  detail: "concise",
  coordination: "direct",
} as const;
const unchangedProfile = (folder: string, revision = 1) => [
  "profile-update",
  "--folder",
  folder,
  "--expected-revision",
  String(revision),
  "--access",
  "local",
  "--purpose",
  "human",
  "--locale",
  "en",
  "--detail",
  "concise",
  "--coordination",
  "direct",
];

let parent: string | undefined;
let world: World | undefined;
afterEach(async () => {
  if (parent) await rm(parent, { recursive: true, force: true });
  parent = undefined;
  await world?.close();
  world = undefined;
});
afterAll(closeSharedSigstore);

async function temporary() {
  parent = await realpath(await mkdtemp(join(tmpdir(), "upd-refresh-")));
  return parent;
}

async function hostedFolder(folder: string) {
  await mkdir(folder, { mode: 0o700 });
  await mkdir(join(folder, "organizations"), { mode: 0o700 });
  await mkdir(join(folder, "personalspace"), { mode: 0o700 });
  await initializeMachineFolder(folder, binding(personal), {
    preset: undefined,
    locale: undefined,
    detail: undefined,
    coordination: undefined,
  });
}

/** `lazurio update` as an agent runs it, with the given runner for its
 * processes and, on a hosted Machine, the declared operator's Folder. */
function updater(
  running: string,
  run: ProcessRunner,
  hosted?: string,
): (args: string[]) => ReturnType<typeof runUpdateCommand> {
  const context: CliContext = {
    identity: { version: running, commit: commitOf(running), target },
    platform: process.platform,
    env: { HOME: world?.root, XDG_DATA_HOME: world?.root },
    executable: join(world?.root ?? "", "downloaded-lazurio"),
    environment: world?.environment(running),
    run,
    ...(hosted === undefined ? {} : { hostedFolder: async () => hosted }),
  };
  return (args) =>
    runUpdateCommand([...args, "--base", world?.base ?? ""], context);
}

test.skipIf(process.platform === "win32")(
  "which refresh a Folder needs: its unchanged profile, or the handover for the declared operator's hosted Folder",
  async () => {
    const root = await temporary();
    const folder = join(root, "Lazurio");
    await initializeFolder(folder, profile);
    // Current: nothing needed.
    expect(
      await neededRefresh(folder, instructionTemplateRevision, undefined),
    ).toBeNull();
    await renderedBy(folder, "base-instructions-8");
    expect(
      await neededRefresh(folder, instructionTemplateRevision, undefined),
    ).toEqual({
      refresh: {
        folder,
        recorded: "base-instructions-8",
        product: instructionTemplateRevision,
      },
      command: unchangedProfile(folder),
    });
    // A Folder without a handover binding is never refreshed from one.
    expect(
      (await neededRefresh(folder, instructionTemplateRevision, folder))
        ?.command,
    ).toEqual(unchangedProfile(folder));
    // A newer or unknown recorded revision is never behind; nothing is
    // needed where nothing can be read.
    expect(
      await neededRefresh(folder, "base-instructions-7", undefined),
    ).toBeNull();
    expect(await folderRefreshNeeded(join(folder, "absent"), "x")).toBeNull();

    const hosted = join(root, "Hosted");
    await hostedFolder(hosted);
    await renderedBy(hosted, "base-instructions-8");
    expect(
      (await neededRefresh(hosted, instructionTemplateRevision, hosted))
        ?.command,
    ).toEqual(["machine", "folder-refresh"]);
    // A hosted Folder that is not the declared operator's: its own recorded
    // profile at its revision, the same template upgrade.
    expect(
      (await neededRefresh(hosted, instructionTemplateRevision, undefined))
        ?.command[0],
    ).toBe("profile-update");
  },
);

test.skipIf(process.platform === "win32")(
  "lazurio update refreshes a workstation Folder after the switch, by the version it activated",
  async () => {
    world = await createWorld();
    const folder = join(world.root, "Lazurio");
    await initializeFolder(folder, profile);
    await renderedBy(folder, "base-instructions-8");
    const { run, calls } = refreshRunner(world.base);
    await world.release("1.1.0", {
      templateRevision: instructionTemplateRevision,
    });

    const updated = await updater("1.0.0", run)(["--folder", folder]);
    expect(updated).toEqual({
      code: 0,
      stdout: [
        "Updated from 1.0.0 to 1.1.0. A running Launchpad finishes the update when it restarts.",
        "Refreshed the Folder's generated files (AGENTS.md, manual/, the skills) for this version.",
      ].join("\n"),
    });
    // Once, after the switch, with the Folder's recorded choices.
    expect(calls).toEqual([
      { command: unchangedProfile(folder), active: "1.1.0" },
    ]);
    expect(await recordedRevisions(folder)).toEqual({
      template: instructionTemplateRevision,
      revision: 2,
    });
    expect(await readFile(join(folder, "AGENTS.md"), "utf8")).not.toContain(
      "Text of an earlier release.",
    );
    // Agents' status: nothing is needed any more.
    expect(
      JSON.parse(
        (await updater("1.1.0", run)(["status", "--folder", folder, "--json"]))
          .stdout ?? "",
      ).folderRefresh,
    ).toBeNull();
    // Current Lazurio and a current Folder: nothing to refresh, nothing run.
    expect(
      JSON.parse(
        (await updater("1.1.0", run)(["--folder", folder, "--json"])).stdout ??
          "",
      ),
    ).toMatchObject({ kind: "up-to-date", folderRefresh: null });
    expect(calls).toHaveLength(1);

    // A version that does not say which revision it renders is never
    // guessed at: nothing is refreshed.
    await renderedBy(folder, "base-instructions-8");
    await world.release("1.2.0");
    expect(
      JSON.parse(
        (await updater("1.1.0", run)(["--folder", folder, "--json"])).stdout ??
          "",
      ),
    ).toMatchObject({ kind: "updated", to: "1.2.0", folderRefresh: null });
    expect(calls).toHaveLength(1);
  },
);

test.skipIf(process.platform === "win32")(
  "already current: lazurio update refreshes a Folder that an earlier refresh or a Machines install left behind",
  async () => {
    world = await createWorld();
    await world.release("1.0.0");
    const folder = join(world.root, "Lazurio");
    await initializeFolder(folder, profile);
    await renderedBy(folder, "base-instructions-8");
    const { run, calls } = refreshRunner(world.base);

    expect(await updater("1.0.0", run)(["--folder", folder])).toEqual({
      code: 0,
      stdout: [
        "Lazurio 1.0.0 is up to date.",
        "Refreshed the Folder's generated files (AGENTS.md, manual/, the skills) for this version.",
      ].join("\n"),
    });
    expect(calls).toEqual([
      { command: unchangedProfile(folder), active: "1.0.0" },
    ]);
    expect((await recordedRevisions(folder)).template).toBe(
      instructionTemplateRevision,
    );
    // An executable that is not the active one does not speak for the
    // active version's templates: nothing is refreshed.
    await renderedBy(folder, "base-instructions-8");
    expect(
      JSON.parse(
        (await updater("0.9.0", run)(["--folder", folder, "--json"])).stdout ??
          "",
      ),
    ).toMatchObject({ kind: "up-to-date", folderRefresh: null });
    expect(calls).toHaveLength(1);
  },
);

test.skipIf(process.platform === "win32")(
  "an edited generated file blocks the refresh: the update stays successful and final, nothing is overwritten, and agents keep seeing it",
  async () => {
    world = await createWorld();
    const folder = join(world.root, "Lazurio");
    await initializeFolder(folder, profile);
    await renderedBy(folder, "base-instructions-8");
    const agents = join(folder, "AGENTS.md");
    const rendered = await readFile(agents, "utf8");
    await appendFile(agents, "My own rule.\n");
    const { run } = refreshRunner(world.base);
    await world.release("1.1.0", {
      templateRevision: instructionTemplateRevision,
    });

    const updated = await updater("1.0.0", run)(["--folder", folder, "--json"]);
    expect(updated.code).toBe(0);
    expect(JSON.parse(updated.stdout ?? "")).toMatchObject({
      kind: "updated",
      to: "1.1.0",
      folderRefresh: { state: "blocked", reason: "drift", path: "AGENTS.md" },
    });
    // The switch is final; the person's edit is untouched.
    expect(await readSelector(world.base)).toBe("1.1.0");
    expect(await readFile(agents, "utf8")).toEndWith("My own rule.\n");
    expect(await recordedRevisions(folder)).toEqual({
      template: "base-instructions-8",
      revision: 1,
    });
    // For agents: status still says the refresh is needed, and the next
    // update names it again with what to do.
    expect(
      (await updater("1.1.0", run)(["status", "--folder", folder])).stdout,
    ).toEndWith(
      `Folder refresh needed: ${folder} was rendered by base-instructions-8, Lazurio renders ${instructionTemplateRevision}. lazurio update --folder ${folder} refreshes it and names anything that blocks it.`,
    );
    expect(await updater("1.1.0", run)(["--folder", folder])).toEqual({
      code: 0,
      stdout: [
        "Lazurio 1.1.0 is up to date.",
        "The Folder's generated files were not refreshed (drift: AGENTS.md). It was changed by hand and is never overwritten: with the user's consent, move their change out of it, then run the same lazurio update again.",
      ].join("\n"),
    });
    // Resolved: the same update refreshes it.
    await writeFile(agents, rendered);
    expect(
      JSON.parse(
        (await updater("1.1.0", run)(["--folder", folder, "--json"])).stdout ??
          "",
      ),
    ).toMatchObject({
      kind: "up-to-date",
      folderRefresh: { state: "refreshed" },
    });
    expect((await recordedRevisions(folder)).template).toBe(
      instructionTemplateRevision,
    );
  },
);

test.skipIf(process.platform === "win32")(
  "a hosted Remote Environment: the declared operator's Folder is refreshed from its handover, whatever the refresh answers",
  async () => {
    world = await createWorld();
    const folder = join(world.root, "Lazurio");
    await hostedFolder(folder);
    await renderedBy(folder, "base-instructions-8");
    await world.release("1.1.0", {
      templateRevision: instructionTemplateRevision,
    });
    // `machine folder-refresh` reads the root-issued handover, which a test
    // has not: its answers are scripted, exactly as it prints them.
    const answers = [
      {
        exitCode: 2,
        stdout: JSON.stringify({
          kind: "blocked",
          reason: "folder-foreign-entry",
          entry: "notes.txt",
          next: "Move this entry out of the Folder.",
          machineContextDigest: "0".repeat(64),
        }),
      },
      {
        exitCode: 0,
        stdout: JSON.stringify({
          kind: "refreshed",
          revision: 2,
          machineContextDigest: "0".repeat(64),
        }),
      },
    ];
    const { run, calls } = refreshRunner(
      world.base,
      (_command, call) => answers[call - 1],
    );

    // No --folder: the declared operator's Folder.
    const blocked = await updater("1.0.0", run, folder)(["--json"]);
    expect(blocked.code).toBe(0);
    expect(JSON.parse(blocked.stdout ?? "")).toMatchObject({
      kind: "updated",
      to: "1.1.0",
      folderRefresh: {
        state: "blocked",
        reason: "folder-foreign-entry",
        path: "notes.txt",
      },
    });
    expect(calls).toEqual([
      { command: ["machine", "folder-refresh"], active: "1.1.0" },
    ]);
    // The next update finds nothing newer and refreshes it.
    expect(
      JSON.parse(
        (await updater("1.1.0", run, folder)(["--json"])).stdout ?? "",
      ),
    ).toMatchObject({
      kind: "up-to-date",
      folderRefresh: { state: "refreshed" },
    });
    expect(calls).toHaveLength(2);
  },
);

test.skipIf(process.platform === "win32")(
  "a busy Folder is retried a bounded number of times; one another operation refreshed meanwhile is unchanged",
  async () => {
    const root = await temporary();
    const base = join(root, "base");
    const folder = join(root, "Lazurio");
    await initializeFolder(folder, profile);
    await renderedBy(folder, "base-instructions-8");
    const state = join(folder, ".lazurio");
    // Another operation holds the Folder's lock until it is let go.
    const hold = () => {
      let release = () => {};
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let acquired = () => {};
      const holding = new Promise<void>((resolve) => {
        acquired = resolve;
      });
      const done = withFolderOperationLock(state, async () => {
        acquired();
        await released;
      });
      return {
        holding,
        release: () => {
          release();
          return done;
        },
      };
    };
    const refresh = (run: ProcessRunner, attempts = 3) =>
      refreshFolderWhenBehind({
        base,
        folder,
        product: instructionTemplateRevision,
        env: {},
        run,
        retry: { attempts, delayMs: 0 },
      });

    // Busy once, then free: refreshed on the second attempt.
    const first = hold();
    await first.holding;
    const freed = refreshRunner(base, async (_command, call) => {
      if (call === 2) await first.release();
      return undefined;
    });
    expect(await refresh(freed.run)).toEqual({ state: "refreshed" });
    expect(freed.calls).toHaveLength(2);
    expect((await recordedRevisions(folder)).template).toBe(
      instructionTemplateRevision,
    );

    // Busy all along: named after the last attempt, nothing written.
    await renderedBy(folder, "base-instructions-8");
    const second = hold();
    await second.holding;
    const held = refreshRunner(base);
    expect(await refresh(held.run)).toEqual({
      state: "blocked",
      reason: "folder-busy",
    });
    expect(held.calls).toHaveLength(3);
    await second.release();
    expect((await recordedRevisions(folder)).template).toBe(
      "base-instructions-8",
    );

    // Refreshed by someone else while this one waited: unchanged.
    const raced = refreshRunner(base, async (command, call) => {
      if (call !== 1) return undefined;
      await refreshRunner(base).run([layout(base).selector, ...command], 1_000);
      return {
        exitCode: 2,
        stdout: JSON.stringify({
          kind: "blocked",
          reason: "folder-busy",
          retryable: true,
        }),
      };
    });
    expect(await refresh(raced.run)).toEqual({ state: "unchanged" });
    expect(raced.calls).toHaveLength(1);
  },
);

test.skipIf(process.platform === "win32")(
  "a refresh that fails, hangs or answers something else is named, never thrown",
  async () => {
    const root = await temporary();
    const folder = join(root, "Lazurio");
    await initializeFolder(folder, profile);
    await renderedBy(folder, "base-instructions-8");
    const refresh = (run: ProcessRunner) =>
      refreshFolderWhenBehind({
        base: join(root, "base"),
        folder,
        product: instructionTemplateRevision,
        env: {},
        run,
        retry: { attempts: 2, delayMs: 0 },
      });
    const answer =
      (result: Awaited<ReturnType<ProcessRunner>>): ProcessRunner =>
      async () =>
        result;
    expect(await refresh(answer("timeout"))).toEqual({
      state: "failed",
      reason: "timeout",
    });
    expect(
      await refresh(
        answer({
          exitCode: 1,
          stdout: JSON.stringify({ kind: "failed", reason: "internal" }),
        }),
      ),
    ).toEqual({ state: "failed", reason: "internal" });
    expect(await refresh(answer({ exitCode: 1, stdout: "" }))).toEqual({
      state: "failed",
      reason: "internal",
    });
    expect(await refresh(answer({ exitCode: 0, stdout: "{}" }))).toEqual({
      state: "failed",
      reason: "internal",
    });
    expect(await refresh(answer({ exitCode: 0, stdout: "not json" }))).toEqual({
      state: "failed",
      reason: "output",
    });
    expect(
      await refresh(async () => {
        throw new Error("not executable");
      }),
    ).toEqual({ state: "failed", reason: "internal" });
    // Only the product's codes and a plain path within the Folder pass.
    expect(
      await refresh(
        answer({
          exitCode: 2,
          stdout: JSON.stringify({
            kind: "blocked",
            reason: "drift",
            path: "manual/a\nb.md",
          }),
        }),
      ),
    ).toEqual({ state: "blocked", reason: "drift" });
    expect(
      await refresh(
        answer({
          exitCode: 2,
          stdout: JSON.stringify({ kind: "blocked", reason: "Not a code" }),
        }),
      ),
    ).toEqual({ state: "failed", reason: "internal" });
    // A path is kept only when it stays within the Folder and every
    // character shows as itself (Pablo's review of #731): an absolute path,
    // an upward or empty segment, a drive or UNC prefix, a terminal escape
    // or a bidirectional override is dropped and the reason stays.
    const blockedAt = (path: string) =>
      refresh(
        answer({
          exitCode: 2,
          stdout: JSON.stringify({ kind: "blocked", reason: "drift", path }),
        }),
      );
    for (const path of [
      "/etc/passwd",
      "../outside",
      "manual/../../outside",
      "./AGENTS.md",
      "manual//x.md",
      "manual/",
      "C:\\Windows\\system.ini",
      "\\\\server\\share",
      "manual/\u001b[31mBAD",
      "manual/\u009b31mBAD",
      "manual/\u202egnp.exe",
      "manual/\u200bhidden.md",
      "x".repeat(513),
    ])
      expect(await blockedAt(path)).toEqual({
        state: "blocked",
        reason: "drift",
      });
    for (const path of [
      "AGENTS.md",
      "manual/this-machine.md",
      "notes.txt",
      "manual/Příručka.md",
    ])
      expect(await blockedAt(path)).toEqual({
        state: "blocked",
        reason: "drift",
        path,
      });
    // A foreign entry is named by `entry`, held to the same rule.
    expect(
      await refresh(
        answer({
          exitCode: 2,
          stdout: JSON.stringify({
            kind: "blocked",
            reason: "folder-foreign-entry",
            entry: "../outside",
          }),
        }),
      ),
    ).toEqual({ state: "blocked", reason: "folder-foreign-entry" });
    // Nothing above wrote anything.
    expect((await recordedRevisions(folder)).template).toBe(
      "base-instructions-8",
    );
  },
);

// #1205: an update whose Folder refresh was cut off inside its transaction
// left a prepared transaction behind, and the Folder and the Launchpad stayed
// blocked until someone resumed it by hand. The next update's refresh
// finishes it first, by the active version's own `profile-resume`, and then
// refreshes as usual.
test.skipIf(process.platform === "win32")(
  "a prepared transaction an interrupted refresh left is resumed by the next update's refresh",
  async () => {
    const root = await temporary();
    const folder = join(root, "Lazurio");
    const base = join(root, "base");
    await initializeFolder(folder, profile);
    await renderedBy(folder, "base-instructions-8");
    // The interrupted refresh: prepared, then cut off before any replacement.
    await expect(
      updateProfile(folder, 1, { profile }, async (step) => {
        if (step === "prepared") throw new Error("cut off");
      }),
    ).rejects.toThrow("cut off");
    const state = join(folder, ".lazurio");
    expect(await readdir(join(state, "transaction"))).toContain(
      "prepared.json",
    );
    expect(await recordedRevisions(folder)).toEqual({
      template: "base-instructions-8",
      revision: 1,
    });

    const { run, calls } = refreshRunner(base);
    expect(
      await refreshFolderWhenBehind({
        base,
        folder,
        product: instructionTemplateRevision,
        env: {},
        run,
        retry: { attempts: 2, delayMs: 0 },
      }),
    ).toEqual({ state: "refreshed" });
    expect(calls.map((call) => call.command[0])).toEqual(["profile-resume"]);
    expect(calls[0]?.command).toEqual([
      "profile-resume",
      "--folder",
      folder,
      "--target-revision",
      "2",
    ]);
    // Finished at the marker's revision, archived, nothing pending.
    expect(await readdir(state)).not.toContain("transaction");
    expect(await readdir(join(state, "history"))).toContain("revision-2");
    expect(await recordedRevisions(folder)).toEqual({
      template: instructionTemplateRevision,
      revision: 2,
    });
  },
);

test.skipIf(process.platform === "win32")(
  "a prepared transaction the recovery refuses stays as it is and is named",
  async () => {
    const root = await temporary();
    const folder = join(root, "Lazurio");
    const base = join(root, "base");
    await initializeFolder(folder, profile);
    await renderedBy(folder, "base-instructions-8");
    await expect(
      updateProfile(folder, 1, { profile }, async (step) => {
        if (step === "prepared") throw new Error("cut off");
      }),
    ).rejects.toThrow("cut off");
    // An edit of an active file after the interruption: the journal no longer
    // agrees, so the recovery refuses and nothing is replaced.
    await appendFile(join(folder, "AGENTS.md"), "\nEdited by hand.\n");
    const { run, calls } = refreshRunner(base);
    expect(
      await refreshFolderWhenBehind({
        base,
        folder,
        product: instructionTemplateRevision,
        env: {},
        run,
        retry: { attempts: 2, delayMs: 0 },
      }),
    ).toEqual({ state: "failed", reason: "transaction-pending" });
    expect(calls.map((call) => call.command[0])).toEqual(["profile-resume"]);
    expect(await readdir(join(folder, ".lazurio"))).toContain("transaction");
    expect(await readFile(join(folder, "AGENTS.md"), "utf8")).toEndWith(
      "\nEdited by hand.\n",
    );
  },
);

test.skipIf(process.platform === "win32")(
  "past its bound the refresh is killed only under the Folder's lock, never while the child holds it",
  async () => {
    const root = await temporary();
    const folder = join(root, "Lazurio");
    const base = join(root, "base");
    await initializeFolder(folder, profile);
    await renderedBy(folder, "base-instructions-8");
    const state = join(folder, ".lazurio");
    const decisions: string[] = [];
    // The child's change holds the Folder's lock when the bound runs out (it
    // is inside its transaction): not killed. Then it has left it: killed,
    // and while the kill runs the parent holds the lock, so the child could
    // not have entered a transaction between the decision and the kill.
    const run: ProcessRunner = async (_argv, _timeoutMs, _env, onTimeout) => {
      let killedWhileInside = false;
      await withFolderOperationLock(state, async () => {
        killedWhileInside = (await onTimeout?.(async () => {})) ?? false;
      });
      decisions.push(killedWhileInside ? "killed" : "held");
      let lockedDuringKill = false;
      const killed = await onTimeout?.(async () => {
        lockedDuringKill = await withFolderOperationLock(
          state,
          async () => false,
          0,
        ).catch((error) => error instanceof FolderOperationBusyError);
      });
      decisions.push(killed ? "killed" : "held");
      expect(lockedDuringKill).toBe(true);
      return "timeout";
    };
    expect(
      await refreshFolderWhenBehind({
        base,
        folder,
        product: instructionTemplateRevision,
        env: {},
        run,
        retry: { attempts: 1, delayMs: 0 },
      }),
    ).toEqual({ state: "failed", reason: "timeout" });
    expect(decisions).toEqual(["held", "killed"]);
  },
);

test.skipIf(process.platform === "win32")(
  "a real child past its bound is killed unless the caller keeps it, and is gone when the kill resolves",
  async () => {
    const child = ["sh", "-c", 'sleep 0.6; printf "{}"'];
    expect(await runProcess(child, 150, {})).toBe("timeout");
    let kept = 0;
    expect(
      await runProcess(child, 150, {}, async () => {
        kept += 1;
        return false;
      }),
    ).toEqual({ exitCode: 0, stdout: "{}" });
    expect(kept).toBeGreaterThan(0);
    const started = Date.now();
    expect(
      await runProcess(child, 150, {}, async (kill) => {
        await kill();
        return true;
      }),
    ).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(550);
    // A caller that fails to answer keeps the child: it may not be safe to
    // cut it off.
    expect(
      await runProcess(child, 150, {}, async () => {
        throw new Error("cannot tell");
      }),
    ).toEqual({ exitCode: 0, stdout: "{}" });
  },
);

test.skipIf(process.platform === "win32")(
  "lazurio update finishes a prepared transaction with the active version before it checks a newer release",
  async () => {
    world = await createWorld();
    const folder = join(world.root, "Lazurio");
    await initializeFolder(folder, profile);
    await renderedBy(folder, "base-instructions-8");
    await expect(
      updateProfile(folder, 1, { profile }, async (step) => {
        if (step === "prepared") throw new Error("cut off");
      }),
    ).rejects.toThrow("cut off");
    const { run, calls } = refreshRunner(world.base);
    await world.release("1.1.0", {
      templateRevision: instructionTemplateRevision,
    });

    const updated = await updater("1.0.0", run)(["--folder", folder]);
    expect(updated.code).toBe(0);
    // The recovery ran first, by the version that was active before the
    // switch, at the marker's revision; nothing else was left to refresh.
    expect(calls).toEqual([
      {
        command: [
          "profile-resume",
          "--folder",
          folder,
          "--target-revision",
          "2",
        ],
        active: "1.0.0",
      },
    ]);
    expect(await readSelector(world.base)).toBe("1.1.0");
    expect(await readdir(join(folder, ".lazurio"))).not.toContain(
      "transaction",
    );
    expect(await recordedRevisions(folder)).toEqual({
      template: instructionTemplateRevision,
      revision: 2,
    });
  },
);

test.skipIf(process.platform === "win32")(
  "on the hosted operator's Folder the restart is owed before the transaction is finished, and survives an updater that dies right after",
  async () => {
    const root = await temporary();
    const folder = join(root, "Lazurio");
    const base = join(root, "base");
    await initializeFolder(folder, profile);
    await renderedBy(folder, "base-instructions-8");
    await expect(
      updateProfile(folder, 1, { profile }, async (step) => {
        if (step === "prepared") throw new Error("cut off");
      }),
    ).rejects.toThrow("cut off");
    const owedFile = layout(base).launchpadRestartOwed;
    let owedAtResume: string | null = null;
    // The recovery finishes the transaction, and its answer never reaches
    // the updater (cut off as an updater that dies is): the Folder says it
    // is finished, and the restart stays owed.
    const dying = refreshRunner(base, async (command) => {
      if (command[0] === "profile-resume")
        owedAtResume = await readFile(owedFile, "utf8").catch(() => null);
      return undefined;
    });
    const died = async () => {
      const result = await dying.run(
        [
          layout(base).selector,
          "profile-resume",
          "--folder",
          folder,
          "--target-revision",
          "2",
        ],
        1_000,
      );
      throw Object.assign(new Error("updater died"), { result });
    };
    await expect(
      resumePreparedTransaction({
        base,
        folder,
        product: instructionTemplateRevision,
        env: {},
        operatorFolder: async () => folder,
        run: async () => died(),
      }),
    ).resolves.toEqual({ state: "refreshed" });
    // Owed before the recovery ran, and still owed after the updater died
    // with the transaction finished.
    expect(JSON.parse(owedAtResume ?? "{}")).toEqual({ folder });
    expect(await readdir(join(folder, ".lazurio"))).not.toContain(
      "transaction",
    );
    expect(JSON.parse(await readFile(owedFile, "utf8"))).toEqual({ folder });
    // The next run finds a current Folder and the debt: its refresh restarts
    // the Launchpad.
    const next = refreshRunner(base, async (command) =>
      command[0] === "machine"
        ? { exitCode: 0, stdout: '{"kind":"unchanged"}' }
        : undefined,
    );
    expect(
      await refreshFolderWhenBehind({
        base,
        folder,
        product: instructionTemplateRevision,
        env: {},
        operatorFolder: async () => folder,
        run: next.run,
        retry: { attempts: 1, delayMs: 0 },
      }),
    ).toEqual({ state: "unchanged" });
    expect(next.calls.map((call) => call.command.slice(0, 2))).toEqual([
      ["machine", "folder-refresh"],
    ]);
  },
);

test.skipIf(process.platform === "win32")(
  "on the hosted operator's Folder a resumed transaction owes a restart of its Launchpad, which the refresh then does",
  async () => {
    const root = await temporary();
    const folder = join(root, "Lazurio");
    const base = join(root, "base");
    await initializeFolder(folder, profile);
    await renderedBy(folder, "base-instructions-8");
    await expect(
      updateProfile(folder, 1, { profile }, async (step) => {
        if (step === "prepared") throw new Error("cut off");
      }),
    ).rejects.toThrow("cut off");
    let owedAtRefresh: string | null = null;
    const { run, calls } = refreshRunner(base, async (command) => {
      if (command[0] !== "machine") return undefined;
      owedAtRefresh = await readFile(
        layout(base).launchpadRestartOwed,
        "utf8",
      ).catch(() => null);
      return { exitCode: 0, stdout: '{"kind":"unchanged"}' };
    });
    expect(
      await refreshFolderWhenBehind({
        base,
        folder,
        product: instructionTemplateRevision,
        env: {},
        operatorFolder: async () => folder,
        run,
        retry: { attempts: 1, delayMs: 0 },
      }),
    ).toEqual({ state: "unchanged" });
    expect(calls.map((call) => call.command.slice(0, 2))).toEqual([
      ["profile-resume", "--folder"],
      ["machine", "folder-refresh"],
    ]);
    expect(JSON.parse(owedAtRefresh ?? "{}")).toEqual({ folder });
  },
);

test.skipIf(process.platform === "win32")(
  "a child that finishes while a decision to keep it is in flight ends the run, and no period is armed again",
  async () => {
    const child = ["sh", "-c", 'sleep 0.25; printf "{}"'];
    let decisions = 0;
    const result = await runProcess(child, 100, {}, async () => {
      decisions += 1;
      // Deciding takes longer than the child still needs.
      await Bun.sleep(400);
      return false;
    });
    expect(result).toEqual({ exitCode: 0, stdout: "{}" });
    const after = decisions;
    await Bun.sleep(500);
    expect(decisions).toBe(after);
  },
);

test.skipIf(process.platform === "win32")(
  "a lock that cannot be verified keeps the child: nothing shows it is outside its transaction",
  async () => {
    const root = await temporary();
    const folder = join(root, "Lazurio");
    const base = join(root, "base");
    await initializeFolder(folder, profile);
    await renderedBy(folder, "base-instructions-8");
    const state = join(folder, ".lazurio");
    let kills = 0;
    let kept: boolean | undefined;
    const run: ProcessRunner = async (_argv, _timeoutMs, _env, onTimeout) => {
      // The state directory is away for the moment: taking the lock fails,
      // and not because someone holds it.
      await rename(state, `${state}.away`);
      try {
        kept = !(await onTimeout?.(async () => {
          kills += 1;
        }));
      } finally {
        await rename(`${state}.away`, state);
      }
      return "timeout";
    };
    await refreshFolderWhenBehind({
      base,
      folder,
      product: instructionTemplateRevision,
      env: {},
      run,
      retry: { attempts: 1, delayMs: 0 },
    });
    expect(kept).toBe(true);
    expect(kills).toBe(0);
  },
);

test.skipIf(process.platform === "win32")(
  "on a supervised base the refresh and the recovery run as a transient unit that outlives the caller",
  async () => {
    const root = await temporary();
    const folder = join(root, "Lazurio");
    const base = join(root, "base");
    await initializeFolder(folder, profile);
    await renderedBy(folder, "base-instructions-8");
    await expect(
      updateProfile(folder, 1, { profile }, async (step) => {
        if (step === "prepared") throw new Error("cut off");
      }),
    ).rejects.toThrow("cut off");
    const argvs: (readonly string[])[] = [];
    const inner = refreshRunner(base);
    const run: ProcessRunner = async (argv, timeoutMs, env, onTimeout) => {
      argvs.push(argv);
      // What the unit runs: the command after `--`.
      return inner.run(
        argv.slice(argv.indexOf("--") + 1),
        timeoutMs,
        env,
        onTimeout,
      );
    };
    expect(
      await refreshFolderWhenBehind({
        base,
        folder,
        product: instructionTemplateRevision,
        env: {},
        run,
        detach: true,
        retry: { attempts: 1, delayMs: 0 },
      }),
    ).toEqual({ state: "refreshed" });
    expect(argvs.length).toBeGreaterThan(0);
    const units = new Set<string>();
    for (const argv of argvs) {
      const unit = argv[3] ?? "";
      expect(unit).toMatch(/^lazurio-folder-refresh-[0-9a-f-]{36}$/);
      units.add(unit);
      expect(argv.slice(0, argv.indexOf("--") + 1)).toEqual([
        ...detachedCommand(unit),
      ]);
      expect(argv[argv.indexOf("--") + 1]).toBe(layout(base).selector);
    }
    // Each command its own unit, so that each can be stopped by name.
    expect(units.size).toBe(argvs.length);
    expect(argvs[0]?.[argvs[0].indexOf("--") + 2]).toBe("profile-resume");
  },
);

test.skipIf(process.platform === "win32")(
  "a refused recovery keeps the restart owed: after an explicit repair, the update of a current Folder still restarts the Launchpad",
  async () => {
    const root = await temporary();
    const folder = join(root, "Lazurio");
    const base = join(root, "base");
    await initializeFolder(folder, profile);
    await renderedBy(folder, "base-instructions-8");
    await expect(
      updateProfile(folder, 1, { profile }, async (step) => {
        if (step === "prepared") throw new Error("cut off");
      }),
    ).rejects.toThrow("cut off");
    const owedFile = layout(base).launchpadRestartOwed;
    // The update's recovery is refused (an edit the journal does not know).
    const agents = join(folder, "AGENTS.md");
    const original = await readFile(agents, "utf8");
    await writeFile(agents, `${original}\nEdited by hand.\n`);
    const refused = refreshRunner(base);
    expect(
      await resumePreparedTransaction({
        base,
        folder,
        product: instructionTemplateRevision,
        env: {},
        operatorFolder: async () => folder,
        run: refused.run,
      }),
    ).toEqual({ state: "failed", reason: "transaction-pending" });
    expect(JSON.parse(await readFile(owedFile, "utf8"))).toEqual({ folder });
    // The person undoes the edit and finishes the transaction by hand.
    await writeFile(agents, original);
    const byHand = await refreshRunner(base).run(
      [
        layout(base).selector,
        "profile-resume",
        "--folder",
        folder,
        "--target-revision",
        "2",
      ],
      10_000,
    );
    expect(byHand).toMatchObject({ exitCode: 0 });
    expect(await readdir(join(folder, ".lazurio"))).not.toContain(
      "transaction",
    );
    // A later update finds a current Folder and the debt: it restarts.
    const later = refreshRunner(base, async (command) =>
      command[0] === "machine"
        ? {
            exitCode: 0,
            stdout: '{"kind":"unchanged","launchpad":"restarted"}',
          }
        : undefined,
    );
    expect(
      await refreshFolderWhenBehind({
        base,
        folder,
        product: instructionTemplateRevision,
        env: {},
        operatorFolder: async () => folder,
        run: later.run,
        retry: { attempts: 1, delayMs: 0 },
      }),
    ).toEqual({ state: "unchanged" });
    expect(later.calls.map((call) => call.command.slice(0, 2))).toEqual([
      ["machine", "folder-refresh"],
    ]);
  },
);

// Real transient units, where this host has a systemd user manager.
const userUnits =
  process.platform === "linux" &&
  Bun.spawnSync(
    [
      "systemd-run",
      "--user",
      "--quiet",
      "--no-ask-password",
      "--collect",
      "--wait",
      "--pipe",
      "--",
      "true",
    ],
    { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
  ).exitCode === 0;
const unitEnv = () => {
  const env: Record<string, string> = {};
  for (const name of [
    "HOME",
    "PATH",
    "XDG_RUNTIME_DIR",
    "DBUS_SESSION_BUS_ADDRESS",
  ])
    if (process.env[name] !== undefined)
      env[name] = process.env[name] as string;
  return env;
};

test.skipIf(!userUnits)(
  "a real detached refresh past its bound is stopped as a unit under the Folder's lock, and does not go on after it",
  async () => {
    const root = await temporary();
    const folder = join(root, "Lazurio");
    const base = join(root, "base");
    await initializeFolder(folder, profile);
    await renderedBy(folder, "base-instructions-8");
    // The selector: a refresh that takes longer than the bound, then writes.
    const marker = join(root, "went-on");
    await mkdir(join(base, "bin"), { recursive: true, mode: 0o700 });
    await writeFile(
      layout(base).selector,
      `#!/bin/sh\nsleep 2\necho went-on > '${marker}'\nprintf '{"kind":"unchanged"}'\n`,
      { mode: 0o700 },
    );
    expect(
      await refreshFolderWhenBehind({
        base,
        folder,
        product: instructionTemplateRevision,
        env: unitEnv(),
        detach: true,
        timeoutMs: 400,
        retry: { attempts: 1, delayMs: 0 },
      }),
    ).toEqual({ state: "failed", reason: "timeout" });
    await Bun.sleep(2_500);
    expect(await readFile(marker, "utf8").catch(() => null)).toBeNull();
  },
);

test.skipIf(!userUnits)(
  "a real detached command finishes after its caller is gone",
  async () => {
    const root = await temporary();
    const marker = join(root, "finished");
    const unit = `lazurio-folder-refresh-test-${process.pid}-${Date.now()}`;
    // No caller decision: past the bound the caller's child (the client) is
    // killed, as a caller that ends is; the unit goes on to its end.
    expect(
      await runProcess(
        [
          ...detachedCommand(unit),
          "sh",
          "-c",
          `sleep 1; echo finished > '${marker}'`,
        ],
        200,
        unitEnv(),
      ),
    ).toBe("timeout");
    await Bun.sleep(1_800);
    expect(await readFile(marker, "utf8")).toBe("finished\n");
  },
);

test.skipIf(process.platform === "win32")(
  "a detached refresh whose unit cannot be shown stopped is kept: a failed kill and a failed status prove nothing",
  async () => {
    const root = await temporary();
    const folder = join(root, "Lazurio");
    const base = join(root, "base");
    await initializeFolder(folder, profile);
    await renderedBy(folder, "base-instructions-8");
    const queried: string[] = [];
    let clientKilled = false;
    const answers = [
      // No bus: nothing printed, exit 1.
      { exitCode: 1, stdout: "" },
      // Still running.
      { exitCode: 0, stdout: "active\n" },
      // Something else printed with a status that is not "not active".
      { exitCode: 1, stdout: "inactive\n" },
    ];
    let decisions = 0;
    const run: ProcessRunner = async (argv, _timeoutMs, _env, onTimeout) => {
      if (argv[0] === "systemctl") {
        queried.push(argv[2] ?? "");
        if (argv[2] === "kill") return { exitCode: 1, stdout: "" };
        return answers[decisions] ?? { exitCode: 1, stdout: "" };
      }
      // The detached refresh past its bound, three times: never proven
      // stopped, so never killed and the Folder's lock always released
      // with the unit kept.
      for (decisions = 0; decisions < answers.length; decisions++) {
        const killed = await onTimeout?.(async () => {
          clientKilled = true;
        });
        expect(killed).toBe(false);
      }
      return "timeout";
    };
    await refreshFolderWhenBehind({
      base,
      folder,
      product: instructionTemplateRevision,
      env: {},
      run,
      detach: true,
      timeoutMs: 50,
      stopWaitMs: 300,
      retry: { attempts: 1, delayMs: 0 },
    });
    expect(clientKilled).toBe(false);
    expect(queried).toContain("kill");
    expect(queried).toContain("is-active");
  },
);
