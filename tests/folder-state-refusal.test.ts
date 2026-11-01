import { expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeFolder } from "../src/folder/initialize-folder";
import { outputPaths } from "../src/folder/outputs";
import { executionOs } from "../src/folder/platform";
import { instructionTemplateRevision } from "../src/folder/render";
import {
  parseFolderPreferences,
  parseInstructionManifest,
} from "../src/folder/state";
import {
  describeFolderStateRefusal,
  folderStateRefusal,
  parseFolderStateRefusal,
} from "../src/folder/state-error";
import { FolderStateUnreadable } from "../src/folder/state-fields";
import { observeFolder } from "../src/recover/observe";
import { UpdateFailure } from "../src/update/errors";
import { requireSelfCheck } from "../src/update/self-check";

// A manifest of this version, then the same Folder rendered by a newer
// template with an output this version does not render (#782: a branch's
// build wrote `ui-craft` into a live Folder, and no release could read it).
const manifest = {
  schemaVersion: 3,
  preferenceRevision: 1,
  templateRevision: "base-instructions-3",
  outputs: Object.fromEntries(
    outputPaths.map((path) => [path, "a".repeat(64)]),
  ),
};
const newer = "base-instructions-999999";
const unknownOutput = ".agents/skills/ui-craft/SKILL.md";

const refusalOf = (read: () => unknown) => {
  try {
    read();
  } catch (error) {
    return folderStateRefusal(error);
  }
  throw new Error("expected a refusal");
};

test("an output this version does not render is named, with the template that rendered it", () => {
  const refusal = refusalOf(() =>
    parseInstructionManifest({
      ...manifest,
      templateRevision: newer,
      outputs: { ...manifest.outputs, [unknownOutput]: "b".repeat(64) },
    }),
  );
  expect(refusal).toEqual({
    condition: "unknown-output",
    field: unknownOutput,
    recorded: newer,
    product: instructionTemplateRevision,
    newer: true,
  });
  expect(
    describeFolderStateRefusal({ ...refusal, file: "instructions.json" }),
  ).toBe(
    `unknown-output (instructions.json ${unknownOutput}); the Folder was rendered by ${newer}, this version renders ${instructionTemplateRevision}, an older one`,
  );
  // An output this version renders that is not recorded.
  const { "manual/roles.md": _, ...missing } = manifest.outputs;
  expect(
    refusalOf(() =>
      parseInstructionManifest({ ...manifest, outputs: missing }),
    ),
  ).toEqual({
    condition: "missing-output",
    field: "manual/roles.md",
    recorded: "base-instructions-3",
    product: instructionTemplateRevision,
  });
  // An unknown schema and a field of another version are named too.
  expect(
    refusalOf(() =>
      parseInstructionManifest({ ...manifest, schemaVersion: 9 }),
    ),
  ).toMatchObject({ condition: "unsupported-schema", field: "schemaVersion" });
  expect(
    refusalOf(() =>
      parseFolderPreferences({
        schemaVersion: 2,
        revision: 1,
        preset: { name: "local", version: 1, selection: "derived" },
        machine: null,
        profile: {
          os: "linux",
          access: "local",
          purpose: "human",
          locale: "cs",
          detail: "concise",
          coordination: "direct",
        },
        customInstructions: "",
        authority: "admin",
      }),
    ),
  ).toMatchObject({ condition: "unknown-field", field: "authority" });
});

test("a refusal never quotes what is not a Folder-relative name or a template revision", () => {
  for (const key of [
    "/home/someone/secret.md",
    "../AGENTS.md",
    "manual/../../x",
    "line\nbreak",
    "\u001b[31mred",
    "x".repeat(129),
  ]) {
    const refusal = refusalOf(() =>
      parseInstructionManifest({
        ...manifest,
        templateRevision: "not a revision, but content",
        outputs: { ...manifest.outputs, [key]: "a".repeat(64) },
      }),
    );
    expect(refusal).toEqual({
      condition: "unknown-output",
      product: instructionTemplateRevision,
    });
  }
  // An error that is not a refusal says only that the state is invalid.
  expect(folderStateRefusal(new Error("/home/someone: quoted"))).toEqual({
    condition: "invalid",
    product: instructionTemplateRevision,
  });
  // Another process's refusal is read back in the same shapes only.
  expect(
    parseFolderStateRefusal({
      condition: "unknown-output",
      file: "instructions.json",
      field: unknownOutput,
      recorded: "base-instructions-92",
      product: "base-instructions-91",
      newer: true,
    }),
  ).toEqual({
    condition: "unknown-output",
    file: "instructions.json",
    field: unknownOutput,
    recorded: "base-instructions-92",
    product: "base-instructions-91",
    newer: true,
  });
  expect(
    parseFolderStateRefusal({
      condition: "unknown-output",
      file: "/etc/passwd",
      field: "/etc/passwd",
      recorded: "anything",
      product: "base-instructions-91",
      extra: "dropped",
    }),
  ).toEqual({ condition: "unknown-output", product: "base-instructions-91" });
  for (const input of [
    null,
    [],
    "unknown-output",
    { condition: "something-else", product: "base-instructions-91" },
    { condition: "unknown-output", product: "x" },
  ])
    expect(parseFolderStateRefusal(input)).toBeUndefined();
  expect(new FolderStateUnreadable("invalid").message).toBe(
    "Unreadable Folder state: invalid",
  );
});

test("lazurio update names the Folder state the candidate could not read, not only its exit", async () => {
  const said = {
    folderStateRefused: {
      condition: "unknown-output",
      file: "instructions.json",
      field: unknownOutput,
      recorded: "base-instructions-92",
      product: "base-instructions-91",
      newer: true,
    },
  };
  const failure = await requireSelfCheck({
    executable: "/candidate",
    expected: { version: "1.1.0", target: "linux-x64" },
    base: "/base",
    folder: "/folder",
    run: async () => ({ exitCode: 1, stdout: JSON.stringify(said) }),
  }).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(UpdateFailure);
  expect((failure as UpdateFailure).failure.code).toBe("self-check-failed");
  expect((failure as UpdateFailure).failure.context).toEqual({
    reason: "folder-state",
    ...said.folderStateRefused,
  });
  // Without a refusal it stays the exit, as before.
  const plain = await requireSelfCheck({
    executable: "/candidate",
    expected: { version: "1.1.0", target: "linux-x64" },
    base: "/base",
    folder: "/folder",
    run: async () => ({ exitCode: 1, stdout: "" }),
  }).catch((error: unknown) => error);
  expect((plain as UpdateFailure).failure.context).toEqual({
    reason: "exit",
    exitCode: 1,
  });
});

test.skipIf(process.platform === "win32")(
  "Doctor and Recovery mode see the same named condition as the self-check",
  async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "state-refusal-")),
    );
    try {
      const folder = join(root, "Lazurio");
      await initializeFolder(folder, {
        os: executionOs(process.platform),
        access: "local",
        purpose: "human",
        locale: "en",
        detail: "concise",
        coordination: "direct",
      });
      const instructions = join(folder, ".lazurio", "instructions.json");
      const recorded = JSON.parse(await readFile(instructions, "utf8"));
      await writeFile(
        instructions,
        JSON.stringify({
          ...recorded,
          templateRevision: newer,
          outputs: { ...recorded.outputs, [unknownOutput]: "c".repeat(64) },
        }),
        { mode: 0o600 },
      );
      const observed = await observeFolder(folder);
      expect(observed.facts).toBeNull();
      expect(observed.check).toEqual({
        id: "folder-state",
        rule: observed.check.rule,
        outcome: "failed",
        code: "folder-state-unreadable",
        context: {
          condition: "unknown-output",
          file: "instructions.json",
          field: unknownOutput,
          recorded: newer,
          product: instructionTemplateRevision,
          newer: true,
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
