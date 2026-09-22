import { expect, test } from "bun:test";
import { outputPaths } from "../src/folder/outputs";
import { previewConfiguredFolder } from "../src/folder/preview";
import {
  parseFolderPreferences,
  parseInstructionManifest,
} from "../src/folder/state";

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
  customInstructions: "  Vlastní pracovní instrukce.\n",
};
const manifest = {
  schemaVersion: 2,
  preferenceRevision: 1,
  templateRevision: "base-instructions-3",
  outputs: Object.fromEntries(
    outputPaths.map((path) => [path, "a".repeat(64)]),
  ),
};

test("configured preview refuses mismatched state and unimplemented custom composition before inspection", async () => {
  let inspections = 0;
  const inspect = async () => {
    inspections++;
    return { kind: "absent" as const };
  };
  await expect(
    previewConfiguredFolder(preferences, manifest, inspect),
  ).rejects.toThrow("Custom instruction");
  await expect(
    previewConfiguredFolder(
      { ...preferences, customInstructions: "" },
      { ...manifest, preferenceRevision: 2 },
      inspect,
    ),
  ).rejects.toThrow("mismatched");
  expect(inspections).toBe(0);
  const result = await previewConfiguredFolder(
    { ...preferences, customInstructions: "" },
    null,
    inspect,
  );
  expect(result.plan.kind).toBe("write");
  expect(inspections).toBe(outputPaths.length);
});

test("state parsing preserves custom source independently from frozen generated ownership", () => {
  const source = structuredClone(preferences);
  const parsed = parseFolderPreferences(source);
  source.profile.locale = "en";
  expect(parsed.profile.locale).toBe("cs");
  expect(parsed.customInstructions).toBe(preferences.customInstructions);
  expect(Object.isFrozen(parsed.profile)).toBe(true);
  expect(parseFolderPreferences(JSON.parse(JSON.stringify(parsed)))).toEqual(
    parsed,
  );
  const owned = parseInstructionManifest(manifest);
  expect(Object.isFrozen(owned.outputs)).toBe(true);
  expect(Object.keys(owned.outputs)).toEqual([...outputPaths]);
  expect(parseInstructionManifest(JSON.parse(JSON.stringify(owned)))).toEqual(
    owned,
  );
});

test("unknown schemas, fields, unsafe revisions and non-owned paths are rejected", () => {
  for (const revision of [
    0,
    -1,
    1.5,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
    "1",
  ])
    expect(() =>
      parseFolderPreferences({ ...preferences, revision }),
    ).toThrow();
  expect(() =>
    parseFolderPreferences({ ...preferences, schemaVersion: 1 }),
  ).toThrow();
  expect(() =>
    parseFolderPreferences({ ...preferences, authority: "admin" }),
  ).toThrow();
  expect(() =>
    parseFolderPreferences({ ...preferences, customInstructions: null }),
  ).toThrow();
  // Every owned output needs a digest, and nothing else is an output.
  for (const path of [
    "../AGENTS.md",
    "Organizations/AGENTS.md",
    "Personalspace/AGENTS.md",
    "manual/notes.md",
  ])
    expect(() =>
      parseInstructionManifest({
        ...manifest,
        outputs: { ...manifest.outputs, [path]: "a".repeat(64) },
      }),
    ).toThrow();
  const { "manual/roles.md": _, ...missing } = manifest.outputs;
  expect(() =>
    parseInstructionManifest({ ...manifest, outputs: missing }),
  ).toThrow();
  expect(() =>
    parseInstructionManifest({ ...manifest, preferenceRevision: 0 }),
  ).toThrow();
  expect(() =>
    parseInstructionManifest({ ...manifest, schemaVersion: 1 }),
  ).toThrow();
  expect(() =>
    parseInstructionManifest({
      ...manifest,
      outputs: { ...manifest.outputs, "manual/roles.md": "bad" },
    }),
  ).toThrow();
});

test("state parsers reject accessor and inherited inputs without executing getters", () => {
  let calls = 0;
  expect(() =>
    parseFolderPreferences({
      ...preferences,
      get revision() {
        calls++;
        return 1;
      },
    }),
  ).toThrow();
  expect(() =>
    parseInstructionManifest({
      ...manifest,
      outputs: {
        ...manifest.outputs,
        get "AGENTS.md"() {
          calls++;
          return "a".repeat(64);
        },
      },
    }),
  ).toThrow();
  expect(() => parseFolderPreferences(Object.create(preferences))).toThrow();
  expect(calls).toBe(0);
});
