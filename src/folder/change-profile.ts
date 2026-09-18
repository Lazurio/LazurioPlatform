import { previewFolder } from "./preview";
import { parseFolderProfile } from "./profile";
import type { ObservedFile } from "./reconcile";
import { instructionTemplateRevision } from "./render";
import { parseFolderPreferences, parseInstructionManifest } from "./state";

// Shared profile-change planning. The caller reads trusted current state under
// the common lock and must revalidate before writing. This is not an apply token.
export async function planProfileChange(
  currentPreferencesInput: unknown,
  currentManifestInput: unknown,
  expectedRevision: number,
  requestedProfileInput: unknown,
  inspect: () => Promise<ObservedFile>,
) {
  const current = parseFolderPreferences(currentPreferencesInput);
  const manifest = parseInstructionManifest(currentManifestInput);
  const requested = parseFolderProfile(requestedProfileInput);
  if (
    !Number.isSafeInteger(expectedRevision) ||
    expectedRevision !== current.revision
  )
    return { kind: "blocked", reason: "stale-revision" } as const;
  if (manifest.preferenceRevision !== current.revision)
    return { kind: "blocked", reason: "incomplete-state" } as const;
  if (manifest.templateRevision !== instructionTemplateRevision)
    return { kind: "blocked", reason: "template-upgrade-required" } as const;
  if (requested.os !== current.profile.os)
    return { kind: "blocked", reason: "execution-os-change" } as const;
  if (current.customInstructions !== "")
    return {
      kind: "blocked",
      reason: "custom-composition-unavailable",
    } as const;

  const expectedCurrent = await previewFolder(
    current.profile,
    null,
    async () => ({ kind: "absent" }),
  );
  if (expectedCurrent.desired.digest !== manifest.output.digest)
    return { kind: "blocked", reason: "incomplete-state" } as const;

  const preview = await previewFolder(
    requested,
    manifest.output.digest,
    inspect,
  );
  if (preview.plan.kind === "blocked") return preview.plan;
  if (preview.plan.kind === "unchanged") return { kind: "unchanged" } as const;
  if (current.revision === Number.MAX_SAFE_INTEGER)
    return { kind: "blocked", reason: "revision-exhausted" } as const;
  const preferences = parseFolderPreferences({
    ...current,
    revision: current.revision + 1,
    profile: requested,
  });
  const nextManifest = parseInstructionManifest({
    schemaVersion: 1,
    preferenceRevision: preferences.revision,
    templateRevision: preview.templateRevision,
    output: { path: preview.desired.path, digest: preview.desired.digest },
  });
  return {
    kind: "profile-change" as const,
    expectedRevision: current.revision,
    previousDigest: manifest.output.digest,
    preferences,
    manifest: nextManifest,
    desired: preview.desired,
  };
}
