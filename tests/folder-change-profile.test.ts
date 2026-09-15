import { expect, test } from "bun:test";
import { planProfileChange } from "../src/folder/change-profile";
import { previewFolder } from "../src/folder/preview";
import { parseFolderPreferences } from "../src/folder/state";

const current = parseFolderPreferences({
  schemaVersion: 1,
  revision: 7,
  customInstructions: "",
  profile: {
    os: "linux",
    access: "remote",
    purpose: "human",
    locale: "en",
    detail: "concise",
    coordination: "direct",
  },
});
async function fixture() {
  const preview = await previewFolder(current.profile, null, async () => ({
    kind: "absent",
  }));
  return {
    manifest: {
      schemaVersion: 1,
      preferenceRevision: current.revision,
      templateRevision: preview.templateRevision,
      output: { path: "AGENTS.md", digest: preview.desired.digest },
    },
    inspect: async () => ({
      kind: "regular" as const,
      digest: preview.desired.digest,
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
    { ...current.profile, locale: "cs" },
    inspect,
  );
  expect(result.kind).toBe("profile-change");
  if (result.kind !== "profile-change") throw new Error("Expected change");
  expect(result.preferences.revision).toBe(8);
  expect(result.preferences.profile.locale).toBe("cs");
  expect(result.manifest.preferenceRevision).toBe(8);
  expect(result.manifest.output.digest).toBe(result.desired.digest);
  expect(result.previousDigest).toBe(manifest.output.digest);
  expect(JSON.stringify({ current, manifest })).toBe(snapshot);
  expect(
    await planProfileChange(current, manifest, 7, current.profile, inspect),
  ).toEqual({ kind: "unchanged" });
});

test("stale, incomplete, incompatible and custom state blocks before inventory", async () => {
  const { manifest } = await fixture();
  const inspect = async (): Promise<never> => {
    throw new Error("Inventory must not run");
  };
  const changed = { ...current.profile, locale: "cs" };
  expect(
    await planProfileChange(
      current,
      { ...manifest, output: { ...manifest.output, digest: "b".repeat(64) } },
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
      { ...changed, os: "windows" },
      inspect,
    ),
  ).toEqual({ kind: "blocked", reason: "execution-os-change" });
});

test("drift and exhausted revisions never yield new writable state", async () => {
  const { manifest, inspect } = await fixture();
  const changed = { ...current.profile, locale: "cs" };
  expect(
    await planProfileChange(current, manifest, 7, changed, async () => ({
      kind: "absent",
    })),
  ).toEqual({ kind: "blocked", reason: "drift" });
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
