import { createHash } from "node:crypto";
import { renderManual } from "./manual";
import { type OutputPath, outputPaths } from "./outputs";
import { type FolderPlan, type ObservedFile, planOutputs } from "./reconcile";
import {
  type InstructionSource,
  instructionSource,
  instructionTemplateRevision,
  parseInstructionSource,
  renderInstructions,
} from "./render";
import {
  isDigest,
  type OutputDigests,
  parseFolderPreferences,
  parseInstructionManifest,
} from "./state";

export type RenderedOutputs = Readonly<Record<OutputPath, string>>;
export type DesiredOutputs = Readonly<
  Record<OutputPath, Readonly<{ content: string; digest: string }>>
>;

// Every generated file of the Folder from one validated composition: AGENTS.md
// in the profile locale and the English manual (decision F14).
export function renderOutputs(input: unknown): RenderedOutputs {
  const source = parseInstructionSource(input);
  return Object.freeze({
    "AGENTS.md": renderInstructions(source),
    ...renderManual(source),
  });
}

export function desiredOutputs(source: InstructionSource): DesiredOutputs {
  const rendered = renderOutputs(source);
  const desired: Partial<
    Record<OutputPath, { content: string; digest: string }>
  > = {};
  for (const path of outputPaths) {
    const content = rendered[path];
    desired[path] = Object.freeze({
      content,
      digest: createHash("sha256").update(content).digest("hex"),
    });
  }
  return Object.freeze(desired) as DesiredOutputs;
}

export function outputDigests(desired: DesiredOutputs): OutputDigests {
  return Object.freeze(
    Object.fromEntries(outputPaths.map((path) => [path, desired[path].digest])),
  ) as OutputDigests;
}

// Adapter-supplied state must come from the trusted local owner, not arbitrary
// imported JSON. This validates coherence, not authenticity or writer custody.
export async function previewConfiguredFolder(
  preferencesInput: unknown,
  manifestInput: unknown | null,
  inspect: (path: OutputPath) => Promise<ObservedFile>,
) {
  const preferences = parseFolderPreferences(preferencesInput);
  const manifest =
    manifestInput === null ? null : parseInstructionManifest(manifestInput);
  if (manifest && manifest.preferenceRevision !== preferences.revision)
    throw new Error("Incomplete or mismatched Folder state");
  if (preferences.customInstructions !== "")
    throw new Error("Custom instruction composition is not implemented");
  return previewFolder(
    instructionSource(preferences),
    manifest?.outputs ?? null,
    inspect,
  );
}

// Shared read-only use case. Callers bind an owned-directory inventory adapter;
// this operation never discovers a home folder or installs/activates anything.
// `previous` holds the recorded digest of every owned output, or of a subset
// (a file without a recorded digest has no prior ownership), or null.
export async function previewFolder(
  input: unknown,
  previous: Readonly<Partial<Record<OutputPath, string>>> | null,
  inspect: (path: OutputPath) => Promise<ObservedFile>,
) {
  const source = parseInstructionSource(input);
  const recorded = previous ?? {};
  for (const path of outputPaths) {
    const digest = recorded[path];
    if (digest !== undefined && !isDigest(digest))
      throw new Error("Invalid previous output digest");
  }
  const desired = desiredOutputs(source);
  const observed: Partial<Record<OutputPath, ObservedFile>> = {};
  for (const path of outputPaths) observed[path] = await inspect(path);
  const plan: FolderPlan = planOutputs(
    recorded,
    outputDigests(desired),
    observed as Readonly<Record<OutputPath, ObservedFile>>,
  );
  return {
    kind: "folder-preview" as const,
    templateRevision: instructionTemplateRevision,
    source,
    desired,
    observed: Object.freeze(observed) as Readonly<
      Record<OutputPath, ObservedFile>
    >,
    plan,
  };
}
