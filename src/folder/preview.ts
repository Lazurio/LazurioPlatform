import { createHash } from "node:crypto";
import { parseFolderProfile } from "./profile";
import { type ObservedFile, planInstructions } from "./reconcile";
import { instructionTemplateRevision, renderInstructions } from "./render";
import { parseFolderPreferences, parseInstructionManifest } from "./state";

// Adapter-supplied state must come from the trusted local owner, not arbitrary
// imported JSON. This validates coherence, not authenticity or writer custody.
export async function previewConfiguredFolder(
  preferencesInput: unknown,
  manifestInput: unknown | null,
  inspect: () => Promise<ObservedFile>,
) {
  const preferences = parseFolderPreferences(preferencesInput);
  const manifest =
    manifestInput === null ? null : parseInstructionManifest(manifestInput);
  if (manifest && manifest.preferenceRevision !== preferences.revision)
    throw new Error("Incomplete or mismatched Folder state");
  if (preferences.customInstructions !== "")
    throw new Error("Custom instruction composition is not implemented");
  return previewFolder(
    preferences.profile,
    manifest?.output.digest ?? null,
    inspect,
  );
}

// Shared read-only use case. Callers bind an owned-directory inventory adapter;
// this operation never discovers a home folder or installs/activates anything.
export async function previewFolder(
  input: unknown,
  previousDigest: string | null,
  inspect: () => Promise<ObservedFile>,
) {
  const profile = parseFolderProfile(input);
  if (previousDigest !== null && !/^[a-f0-9]{64}$/.test(previousDigest))
    throw new Error("Invalid previous instruction digest");
  const content = renderInstructions(profile);
  const digest = createHash("sha256").update(content).digest("hex");
  const observed = await inspect();
  const plan = planInstructions(previousDigest, digest, observed);
  return {
    kind: "folder-preview" as const,
    templateRevision: instructionTemplateRevision,
    profile,
    desired: { path: "AGENTS.md" as const, content, digest },
    observed,
    plan,
  };
}
