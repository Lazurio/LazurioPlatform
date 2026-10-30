import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { FolderAdoptionError } from "../src/folder/handover-layout";
import { adoptedHandoverFolder } from "../src/folder/initialize-folder";
import { FolderOperationBusyError } from "../src/folder/lock";
import {
  initializeMachineFolder,
  machineFailureAnswer,
} from "../src/machine/cli";
import { MachineContextError } from "../src/machine/context";
import { bindings } from "./fixtures/machine-bindings";

const noChoices = {
  preset: undefined,
  locale: undefined,
  detail: undefined,
  coordination: undefined,
} as const;

async function adoptedFolder() {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "folder-busy-")));
  const folder = join(parent, "Lazurio");
  await mkdir(folder, { mode: 0o700 });
  await mkdir(join(folder, "organizations"), { mode: 0o755 });
  expect(
    await initializeMachineFolder(folder, bindings.organization, noChoices),
  ).toMatchObject({ code: 0, result: { kind: "initialized" } });
  return { parent, folder, state: join(folder, ".lazurio") };
}

// Another process holds the Folder's lock for `ms`, as a Launchpad that has
// just started reads the Folder state; this resolves once the lock is held.
async function holdFromAnotherProcess(state: string, ms: number) {
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `import { withFolderOperationLock } from ${JSON.stringify(resolve("src/folder/lock.ts"))};
       await withFolderOperationLock(${JSON.stringify(state)}, async () => {
         process.stdout.write("held\\n");
         await Bun.sleep(${ms});
       });`,
    ],
    { stdout: "pipe", stderr: "pipe", env: {} },
  );
  const reader = child.stdout.getReader();
  const { value } = await reader.read();
  reader.releaseLock();
  expect(new TextDecoder().decode(value)).toBe("held\n");
  return child;
}

// #655: the first folder-init after an upgrade ran while the restarted
// Launchpad read the Folder, found the lock busy and printed no JSON.
test.skipIf(process.platform === "win32")(
  "folder-init on an adopted Folder waits for another process's hold of the lock and reports already-adopted",
  async () => {
    const { parent, folder, state } = await adoptedFolder();
    try {
      const holder = await holdFromAnotherProcess(state, 1_500);
      const started = Date.now();
      expect(
        await initializeMachineFolder(folder, bindings.organization, noChoices),
      ).toMatchObject({ code: 0, result: { kind: "already-adopted" } });
      expect(Date.now() - started).toBeGreaterThanOrEqual(500);
      expect(await holder.exited).toBe(0);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "a hold longer than the adoption check waits is a busy Folder, answered as a retryable refusal",
  async () => {
    const { parent, folder, state } = await adoptedFolder();
    try {
      const holder = await holdFromAnotherProcess(state, 3_000);
      let busy: unknown = null;
      try {
        await adoptedHandoverFolder(folder, bindings.organization, 300);
      } catch (error) {
        busy = error;
      }
      expect(busy).toBeInstanceOf(FolderOperationBusyError);
      expect(machineFailureAnswer(busy)).toEqual({
        code: 2,
        result: {
          kind: "blocked",
          reason: "folder-busy",
          retryable: true,
          next: expect.any(String),
        },
      });
      expect(await holder.exited).toBe(0);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  },
);

test("every failure of a machine command is one answer, and an unexpected one names nothing it read", () => {
  expect(
    machineFailureAnswer(new FolderAdoptionError("foreign-entry", "stray")),
  ).toMatchObject({
    code: 2,
    result: { kind: "blocked", reason: "folder-foreign-entry", entry: "stray" },
  });
  expect(
    machineFailureAnswer(new MachineContextError("machine-context-missing")),
  ).toMatchObject({
    code: 2,
    result: { kind: "blocked", reason: "machine-context-missing" },
  });
  const unexpected = machineFailureAnswer(
    new Error("EACCES: /home/someone/Lazurio/.lazurio/private"),
  );
  expect(unexpected).toEqual({
    code: 1,
    result: { kind: "failed", reason: "internal", next: expect.any(String) },
  });
  expect(JSON.stringify(unexpected)).not.toContain("/home/");
  expect(JSON.stringify(unexpected)).not.toContain("EACCES");
});
