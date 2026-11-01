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
const preferences = {
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
};
const newer = "base-instructions-999999";
const unknownOutput = ".agents/skills/ui-craft/SKILL.md";

// Keys a malformed or foreign state could carry: none of them may leave.
const privateKeys = [
  "examplePrivateValue",
  "privateTokenOfAlena0123456789",
  ".agents/skills/sk-live-51H8exampleSecret/SKILL.md",
  "manual/alena-novakova-salary.md",
  "/home/someone/secret.md",
  "../AGENTS.md",
  "line\nbreak",
  "\u001b[31mred",
];

const refusalOf = (read: () => unknown) => {
  try {
    read();
  } catch (error) {
    return folderStateRefusal(error);
  }
  throw new Error("expected a refusal");
};

test("an output this version does not render is said by its area, with the template that rendered it", () => {
  const refusal = refusalOf(() =>
    parseInstructionManifest({
      ...manifest,
      templateRevision: newer,
      outputs: { ...manifest.outputs, [unknownOutput]: "b".repeat(64) },
    }),
  );
  // The recorded path is the Folder's content: only its fixed area is said.
  expect(refusal).toEqual({
    condition: "unknown-output",
    area: "agents-skills",
    recorded: newer,
    product: instructionTemplateRevision,
    newer: true,
  });
  expect(
    describeFolderStateRefusal({ ...refusal, file: "instructions.json" }),
  ).toBe(
    `unknown-output (instructions.json, an output in .agents/skills/); the Folder was rendered by ${newer}, this version renders ${instructionTemplateRevision}, an older one`,
  );
  for (const [path, area] of [
    [".claude/skills/x/SKILL.md", "claude-skills"],
    ["manual/x.md", "manual"],
    ["CLAUDE.md", "top-level"],
    ["elsewhere/x.md", "other"],
  ])
    expect(
      refusalOf(() =>
        parseInstructionManifest({
          ...manifest,
          outputs: { ...manifest.outputs, [path as string]: "b".repeat(64) },
        }),
      ).area,
    ).toBe(area as never);
  // An output this version renders that is not recorded: its own name.
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
  expect(
    refusalOf(() =>
      parseInstructionManifest({ ...manifest, schemaVersion: 9 }),
    ),
  ).toMatchObject({ condition: "unsupported-schema", field: "schemaVersion" });
  expect(
    refusalOf(() =>
      parseInstructionManifest({ ...manifest, templateRevision: "" }),
    ),
  ).toMatchObject({ condition: "invalid", field: "templateRevision" });
  // A field of another version: the condition, never its name.
  expect(
    refusalOf(() => parseFolderPreferences({ ...preferences, authority: 1 })),
  ).toEqual({
    condition: "unknown-field",
    product: instructionTemplateRevision,
  });
});

test("a refusal never carries a key read from the Folder, only the product's own names", () => {
  for (const key of privateKeys) {
    const refusals = [
      refusalOf(() =>
        parseInstructionManifest({
          ...manifest,
          templateRevision: "not a revision, but content",
          outputs: { ...manifest.outputs, [key]: "a".repeat(64) },
        }),
      ),
      refusalOf(() => parseInstructionManifest({ ...manifest, [key]: 1 })),
      refusalOf(() => parseFolderPreferences({ ...preferences, [key]: key })),
    ];
    for (const refusal of refusals) {
      const said = `${JSON.stringify(refusal)}\n${describeFolderStateRefusal(refusal)}`;
      expect([key, said.includes(key)]).toEqual([key, false]);
      expect(refusal.field).toBeUndefined();
    }
    expect(refusals.map((refusal) => refusal.condition)).toEqual([
      "unknown-output",
      "unknown-field",
      "unknown-field",
    ]);
  }
  // An error that is not a refusal says only that the state is invalid.
  expect(folderStateRefusal(new Error("/home/someone: quoted"))).toEqual({
    condition: "invalid",
    product: instructionTemplateRevision,
  });
  // Another process's refusal is read back with this version's rules only.
  const known = {
    condition: "missing-output" as const,
    file: "instructions.json",
    field: "manual/roles.md",
    area: "manual" as const,
    recorded: "base-instructions-92",
    product: "base-instructions-91",
    newer: true as const,
  };
  expect(parseFolderStateRefusal(known)).toEqual(known);
  for (const key of privateKeys)
    expect(
      parseFolderStateRefusal({
        condition: "unknown-output",
        file: key,
        field: key,
        area: key,
        recorded: key,
        product: "base-instructions-91",
        [key]: key,
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
      area: "agents-skills",
      recorded: "base-instructions-92",
      product: "base-instructions-91",
      newer: true,
    },
  };
  const check = (stdout: string) =>
    requireSelfCheck({
      executable: "/candidate",
      expected: { version: "1.1.0", target: "linux-x64" },
      base: "/base",
      folder: "/folder",
      run: async () => ({ exitCode: 1, stdout }),
    }).catch((error: unknown) => error);
  const failure = await check(JSON.stringify(said));
  expect(failure).toBeInstanceOf(UpdateFailure);
  expect((failure as UpdateFailure).failure.code).toBe("self-check-failed");
  expect((failure as UpdateFailure).failure.context).toEqual({
    reason: "folder-state",
    ...said.folderStateRefused,
  });
  // Without a refusal it stays the exit, as before.
  expect(((await check("")) as UpdateFailure).failure.context).toEqual({
    reason: "exit",
    exitCode: 1,
  });
});

test.skipIf(process.platform === "win32")(
  "observeFolder carries the refusal as the context of folder-state-unreadable",
  async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "state-refusal-")),
    );
    try {
      const folder = join(root, "Lazurio");
      await initializeFolder(folder, {
        ...preferences.profile,
        os: executionOs(process.platform),
        locale: "en",
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
          area: "agents-skills",
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
