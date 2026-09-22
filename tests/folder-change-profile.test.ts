import { expect, test } from "bun:test";
import { planProfileChange } from "../src/folder/change-profile";
import { outputDigests, previewFolder } from "../src/folder/preview";
import { instructionSource } from "../src/folder/render";
import { parseFolderPreferences } from "../src/folder/state";
import { bindings } from "./fixtures/machine-bindings";

const current = parseFolderPreferences({
  schemaVersion: 2,
  revision: 7,
  customInstructions: "",
  preset: { name: "local", version: 1, selection: "derived" },
  machine: null,
  profile: {
    os: "linux",
    access: "local",
    purpose: "human",
    locale: "en",
    detail: "concise",
    coordination: "direct",
  },
});
async function fixture(preferences = current) {
  const preview = await previewFolder(
    instructionSource(preferences),
    null,
    async () => ({ kind: "absent" }),
  );
  const outputs = outputDigests(preview.desired);
  return {
    manifest: {
      schemaVersion: 2,
      preferenceRevision: preferences.revision,
      templateRevision: preview.templateRevision,
      outputs,
    },
    inspect: async (path: keyof typeof outputs) => ({
      kind: "regular" as const,
      digest: outputs[path],
    }),
  };
}

test("profile change binds one next revision and matching output without mutating input", async () => {
  const { manifest, inspect } = await fixture();
  const snapshot = JSON.stringify({ current, manifest });
  const result = await planProfileChange(
    current,
    manifest,
    7,
    { profile: { ...current.profile, locale: "cs" } },
    inspect,
  );
  expect(result.kind).toBe("profile-change");
  if (result.kind !== "profile-change") throw new Error("Expected change");
  expect(result.preferences.revision).toBe(8);
  expect(result.preferences.profile.locale).toBe("cs");
  expect(result.manifest.preferenceRevision).toBe(8);
  expect(result.manifest.outputs).toEqual(outputDigests(result.desired));
  expect(result.previous).toEqual(manifest.outputs);
  // A locale change rewrites AGENTS.md only; the English manual is unchanged.
  expect(result.files).toEqual([{ kind: "replace", path: "AGENTS.md" }]);
  expect(JSON.stringify({ current, manifest })).toBe(snapshot);
  expect(
    await planProfileChange(
      current,
      manifest,
      7,
      { profile: current.profile },
      inspect,
    ),
  ).toEqual({ kind: "unchanged" });
  expect(
    await planProfileChange(
      current,
      manifest,
      7,
      { preset: "local", profile: current.profile },
      inspect,
    ),
  ).toEqual({ kind: "unchanged" });
});

test("the preset changes only within the handover allow-list and keeps the binding", async () => {
  const hosted = parseFolderPreferences({
    schemaVersion: 2,
    revision: 3,
    customInstructions: "",
    preset: {
      name: "hosted-organization-personal",
      version: 1,
      selection: "derived",
    },
    machine: bindings.organization,
    profile: { ...current.profile, access: "remote" },
  });
  const { manifest, inspect } = await fixture(hosted);
  const changed = await planProfileChange(
    hosted,
    manifest,
    3,
    { preset: "hosted-organization-team", profile: hosted.profile },
    inspect,
  );
  expect(changed.kind).toBe("profile-change");
  if (changed.kind !== "profile-change") throw new Error("Expected change");
  expect(changed.preferences.preset).toEqual({
    name: "hosted-organization-team",
    version: 1,
    selection: "explicit",
  });
  expect(changed.preferences.machine).toEqual(bindings.organization);
  expect(changed.preferences.revision).toBe(4);
  for (const preset of ["hosted-personal", "local"] as const)
    expect(
      await planProfileChange(
        hosted,
        manifest,
        3,
        { preset, profile: hosted.profile },
        inspect,
      ),
    ).toEqual({ kind: "blocked", reason: "preset-not-allowed" });
  expect(
    await planProfileChange(
      hosted,
      manifest,
      3,
      { profile: { ...hosted.profile, access: "local" } },
      inspect,
    ),
  ).toEqual({ kind: "blocked", reason: "preset-composition" });
  await expect(
    planProfileChange(
      hosted,
      manifest,
      3,
      { preset: "hosted-team", profile: hosted.profile },
      inspect,
    ),
  ).rejects.toThrow("Unknown workspace preset");
  await expect(
    planProfileChange(
      hosted,
      manifest,
      3,
      { machine: null, profile: hosted.profile },
      inspect,
    ),
  ).rejects.toThrow();
});

test("stale, incomplete, incompatible and custom state blocks before inventory", async () => {
  const { manifest } = await fixture();
  const inspect = async (): Promise<never> => {
    throw new Error("Inventory must not run");
  };
  const changed = { profile: { ...current.profile, locale: "cs" } };
  expect(
    await planProfileChange(
      current,
      {
        ...manifest,
        outputs: { ...manifest.outputs, "AGENTS.md": "b".repeat(64) },
      },
      7,
      changed,
      inspect,
    ),
  ).toEqual({ kind: "blocked", reason: "incomplete-state" });
  for (const expected of [6, 8, NaN, 7.5])
    expect(
      await planProfileChange(current, manifest, expected, changed, inspect),
    ).toEqual({ kind: "blocked", reason: "stale-revision" });
  expect(
    await planProfileChange(
      current,
      { ...manifest, preferenceRevision: 6 },
      7,
      changed,
      inspect,
    ),
  ).toEqual({ kind: "blocked", reason: "incomplete-state" });
  expect(
    await planProfileChange(
      current,
      { ...manifest, templateRevision: "unknown" },
      7,
      changed,
      inspect,
    ),
  ).toEqual({ kind: "blocked", reason: "template-upgrade-required" });
  expect(
    await planProfileChange(
      { ...current, customInstructions: "Do not drop this" },
      manifest,
      7,
      changed,
      inspect,
    ),
  ).toEqual({ kind: "blocked", reason: "custom-composition-unavailable" });
  expect(
    await planProfileChange(
      current,
      manifest,
      7,
      { profile: { ...changed.profile, os: "windows" } },
      inspect,
    ),
  ).toEqual({ kind: "blocked", reason: "execution-os-change" });
});

test("drift and exhausted revisions never yield new writable state", async () => {
  const { manifest, inspect } = await fixture();
  const changed = { profile: { ...current.profile, locale: "cs" } };
  expect(
    await planProfileChange(current, manifest, 7, changed, async () => ({
      kind: "absent",
    })),
  ).toEqual({ kind: "blocked", reason: "drift", path: "AGENTS.md" });
  // An edited manual file is refused by name, whichever file it is.
  expect(
    await planProfileChange(current, manifest, 7, changed, async (path) =>
      path === "manual/roles.md"
        ? { kind: "regular", digest: "c".repeat(64) }
        : inspect(path),
    ),
  ).toEqual({ kind: "blocked", reason: "drift", path: "manual/roles.md" });
  const maximum = Number.MAX_SAFE_INTEGER;
  expect(
    await planProfileChange(
      { ...current, revision: maximum },
      { ...manifest, preferenceRevision: maximum },
      maximum,
      changed,
      inspect,
    ),
  ).toEqual({ kind: "blocked", reason: "revision-exhausted" });
});
