import { type FolderProfile, parseFolderProfile } from "./profile";

// Schema versions this product can read; a release declares them in its
// artifact identity so staging can check backward read compatibility.
export const folderStateSchemas = Object.freeze({
  preferences: Object.freeze([1]),
  manifest: Object.freeze([1]),
});

// Development schema for the single-output transaction. Parsing is not proof of
// custody: a filesystem adapter must establish the state owner's trusted boundary.
export type FolderPreferences = Readonly<{
  schemaVersion: 1;
  revision: number;
  profile: FolderProfile;
  customInstructions: string;
}>;

export type InstructionManifest = Readonly<{
  schemaVersion: 1;
  preferenceRevision: number;
  templateRevision: string;
  output: Readonly<{ path: "AGENTS.md"; digest: string }>;
}>;

export function stateFields(
  input: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    throw new Error("Invalid Folder state");
  const ownKeys = Reflect.ownKeys(input);
  if (
    ownKeys.length !== keys.length ||
    ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))
  )
    throw new Error("Unknown or missing Folder state field");
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !("value" in descriptor))
      throw new Error("Executable Folder state field");
    result[key] = descriptor.value;
  }
  return result;
}

function revision(input: unknown): number {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < 1)
    throw new Error("Invalid Folder revision");
  return input;
}

export function parseFolderPreferences(input: unknown): FolderPreferences {
  const value = stateFields(input, [
    "schemaVersion",
    "revision",
    "profile",
    "customInstructions",
  ]);
  if (value.schemaVersion !== 1 || typeof value.customInstructions !== "string")
    throw new Error("Unsupported Folder preferences");
  return Object.freeze({
    schemaVersion: 1,
    revision: revision(value.revision),
    profile: parseFolderProfile(value.profile),
    // Source is preserved verbatim. This schema neither executes it nor imports
    // effective mandates; composition/conflict handling is a separate consumer.
    customInstructions: value.customInstructions,
  });
}

export function parseInstructionManifest(input: unknown): InstructionManifest {
  const value = stateFields(input, [
    "schemaVersion",
    "preferenceRevision",
    "templateRevision",
    "output",
  ]);
  const output = stateFields(value.output, ["path", "digest"]);
  if (
    value.schemaVersion !== 1 ||
    typeof value.templateRevision !== "string" ||
    value.templateRevision.length === 0 ||
    output.path !== "AGENTS.md" ||
    typeof output.digest !== "string" ||
    !/^[a-f0-9]{64}$/.test(output.digest)
  )
    throw new Error("Unsupported instruction manifest");
  return Object.freeze({
    schemaVersion: 1,
    preferenceRevision: revision(value.preferenceRevision),
    templateRevision: value.templateRevision,
    output: Object.freeze({ path: "AGENTS.md", digest: output.digest }),
  });
}
