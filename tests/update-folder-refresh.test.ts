import { afterAll, afterEach, expect, test } from "bun:test";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeFolder } from "../src/folder/initialize-folder";
import { withFolderOperationLock } from "../src/folder/lock";
import { executionOs } from "../src/folder/platform";
import {
  folderRefreshNeeded,
  neededRefresh,
} from "../src/folder/refresh-needed";
import { instructionTemplateRevision } from "../src/folder/render";
import { initializeMachineFolder } from "../src/machine/cli";
import { type CliContext, runUpdateCommand } from "../src/update/cli";
import { refreshFolderWhenBehind } from "../src/update/folder-refresh";
import { layout, readSelector } from "../src/update/layout";
import type { ProcessRunner } from "../src/update/self-check";
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
    // Nothing above wrote anything.
    expect((await recordedRevisions(folder)).template).toBe(
      "base-instructions-8",
    );
  },
);
