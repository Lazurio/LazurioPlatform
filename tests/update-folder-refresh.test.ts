import { afterAll, afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli";
import { initializeFolder } from "../src/folder/initialize-folder";
import { outputPaths } from "../src/folder/outputs";
import { executionOs } from "../src/folder/platform";
import { folderRefreshNeeded } from "../src/folder/refresh-needed";
import { instructionTemplateRevision } from "../src/folder/render";
import { initializeMachineFolder } from "../src/machine/cli";
import { type CliContext, runUpdateCommand } from "../src/update/cli";
import { binding } from "./fixtures/machine-bindings";
import personal from "./fixtures/machine-context-personal.json";
import {
  closeSharedSigstore,
  commitOf,
  createWorld,
  target,
  type World,
} from "./fixtures/update-world";

// "Folder refresh needed" (F17 addendum 2026-09-28): the operator updates
// Lazurio, the update never writes the Folder, and the result names the one
// command that re-renders it. Every home and Folder here is temporary.

const profile = {
  os: executionOs(process.platform),
  access: "local",
  purpose: "human",
  locale: "en",
  detail: "concise",
  coordination: "direct",
} as const;

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

// A Folder as an earlier release left it: its generated files carry that
// revision and the manifest records exactly those bytes, so the one planner
// can upgrade it.
async function renderedBy(folder: string, revision: string) {
  const path = join(folder, ".lazurio", "instructions.json");
  const manifest = JSON.parse(await readFile(path, "utf8"));
  const outputs: Record<string, string> = {};
  for (const output of outputPaths) {
    const content = `${(
      await readFile(join(folder, output), "utf8")
    ).replaceAll(
      instructionTemplateRevision,
      revision,
    )}\nText of an earlier release.\n`;
    await writeFile(join(folder, output), content);
    outputs[output] = createHash("sha256").update(content).digest("hex");
  }
  await writeFile(
    path,
    JSON.stringify({ ...manifest, templateRevision: revision, outputs }),
  );
}

test.skipIf(process.platform === "win32")(
  "a workstation Folder names the unchanged profile update, and that exact command refreshes it",
  async () => {
    const folder = join(await temporary(), "Lazurio");
    await initializeFolder(folder, profile);
    // Current: nothing to report.
    expect(
      await folderRefreshNeeded(folder, instructionTemplateRevision),
    ).toBeNull();
    await renderedBy(folder, "base-instructions-8");
    const refresh = await folderRefreshNeeded(
      folder,
      instructionTemplateRevision,
    );
    expect(refresh).toEqual({
      folder,
      recorded: "base-instructions-8",
      product: instructionTemplateRevision,
      command: `lazurio profile-update --folder ${folder} --expected-revision 1 --access local --purpose human --locale en --detail concise --coordination direct`,
    });
    // A newer or unknown recorded revision is never "behind".
    expect(await folderRefreshNeeded(folder, "base-instructions-7")).toBeNull();
    expect(await folderRefreshNeeded(join(folder, "absent"), "x")).toBeNull();

    // The reported command, run as it is printed.
    const args = (refresh?.command ?? "").split(" ").slice(1);
    const log = console.log;
    console.log = () => {};
    try {
      expect(await runCli(args)).toBe(0);
    } finally {
      console.log = log;
    }
    expect(
      await folderRefreshNeeded(folder, instructionTemplateRevision),
    ).toBeNull();
    expect(await readFile(join(folder, "AGENTS.md"), "utf8")).not.toContain(
      "Text of an earlier release.",
    );
  },
);

test.skipIf(process.platform === "win32")(
  "a hosted Folder names machine folder-refresh, and a path with spaces is quoted for the shell",
  async () => {
    const root = await temporary();
    const folder = join(root, "Lazurio");
    await mkdir(folder, { mode: 0o700 });
    await mkdir(join(folder, "organizations"), { mode: 0o700 });
    await mkdir(join(folder, "personalspace"), { mode: 0o700 });
    await initializeMachineFolder(folder, binding(personal), {
      preset: undefined,
      locale: undefined,
      detail: undefined,
      coordination: undefined,
    });
    await renderedBy(folder, "base-instructions-8");
    expect(
      await folderRefreshNeeded(folder, instructionTemplateRevision),
    ).toMatchObject({ command: "lazurio machine folder-refresh" });

    const spaced = join(root, "My 'Lazurio'");
    await initializeFolder(spaced, profile);
    await renderedBy(spaced, "base-instructions-8");
    expect(
      (await folderRefreshNeeded(spaced, instructionTemplateRevision))?.command,
    ).toStartWith(
      `lazurio profile-update --folder '${root}/My '\\''Lazurio'\\''' --expected-revision 1`,
    );
  },
);

test.skipIf(process.platform === "win32")(
  "lazurio update and update status report the refresh, human and JSON, and never write the Folder",
  async () => {
    world = await createWorld();
    const folder = join(world.root, "Lazurio");
    await initializeFolder(folder, profile);
    await renderedBy(folder, "base-instructions-8");
    const manifest = await readFile(
      join(folder, ".lazurio/instructions.json"),
      "utf8",
    );
    const context = (running: string, hosted?: string): CliContext => ({
      identity: { version: running, commit: commitOf(running), target },
      platform: process.platform,
      env: { HOME: world?.root, XDG_DATA_HOME: world?.root },
      executable: join(world?.root ?? "", "downloaded-lazurio"),
      environment: world?.environment(running),
      ...(hosted === undefined ? {} : { hostedFolder: async () => hosted }),
    });
    const run = (args: string[], running = "1.0.0", hosted?: string) =>
      runUpdateCommand(
        [...args, "--base", world?.base ?? ""],
        context(running, hosted),
      );
    const command = `lazurio profile-update --folder ${folder} --expected-revision 1 --access local --purpose human --locale en --detail concise --coordination direct`;
    const line = (product: string) =>
      `Folder refresh needed: ${folder} was rendered by base-instructions-8, Lazurio renders ${product}. Run: ${command}`;

    // Status: the active product is this one, so its revision is known.
    expect((await run(["status", "--folder", folder])).stdout).toBe(
      [
        "running 1.0.0",
        "active 1.0.0",
        "previous none",
        "latest known never checked",
        line(instructionTemplateRevision),
      ].join("\n"),
    );
    // The hosted Machine's declared operator Folder, without --folder.
    expect(
      JSON.parse(
        (await run(["status", "--json"], "1.0.0", folder)).stdout ?? "",
      ).folderRefresh,
    ).toEqual({
      folder,
      recorded: "base-instructions-8",
      product: instructionTemplateRevision,
      command,
    });
    // No Folder known: nothing reported.
    expect(
      JSON.parse((await run(["status", "--json"])).stdout ?? "").folderRefresh,
    ).toBeNull();

    // The update: the new executable says which revision it renders.
    await world.release("1.1.0", { templateRevision: "base-instructions-10" });
    expect(await run(["--folder", folder])).toEqual({
      code: 0,
      stdout: [
        "Updated from 1.0.0 to 1.1.0. A running Launchpad finishes the update when it restarts.",
        line("base-instructions-10"),
      ].join("\n"),
    });
    // Up to date: the one answering is the active one.
    expect(
      JSON.parse(
        (await run(["--json", "--folder", folder], "1.1.0")).stdout ?? "",
      ),
    ).toMatchObject({
      kind: "up-to-date",
      folderRefresh: { product: instructionTemplateRevision },
    });
    // An executable that does not say which revision it renders reports
    // nothing rather than a guess.
    await world.release("1.2.0");
    expect(
      JSON.parse(
        (await run(["--json", "--folder", folder], "1.1.0")).stdout ?? "",
      ),
    ).toMatchObject({ kind: "updated", to: "1.2.0", folderRefresh: null });
    // Reporting only: the Folder is exactly as it was.
    expect(
      await readFile(join(folder, ".lazurio/instructions.json"), "utf8"),
    ).toBe(manifest);
    // --folder belongs to the two commands that report it, and is absolute.
    expect((await run(["rollback", "--folder", folder])).code).toBe(2);
    expect((await run(["--check", "--folder", folder])).code).toBe(2);
    expect((await run(["status", "--folder", "relative"])).code).toBe(2);
  },
);
