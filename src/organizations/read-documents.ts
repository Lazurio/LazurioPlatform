import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { inspectOwnedDirectory } from "../folder/owned-directory";
import { readOwnedJson } from "../providers/owned-json";

const paths = Object.freeze({
  canonical: "lazurio.organization.json",
  legacy: "company.gen3.json",
  modules: "modules.manifest.json",
});
type Document =
  | { kind: "missing" }
  | { kind: "invalid" }
  | { kind: "present"; value: Readonly<Record<string, unknown>> };

function freezeJson(value: unknown): void {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeJson(child);
    Object.freeze(value);
  }
}

async function readDocument(path: string): Promise<Readonly<Document>> {
  try {
    await lstat(path);
  } catch (error) {
    return Object.freeze({
      kind:
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? "missing"
          : "invalid",
    });
  }
  // Once observed, a disappearing file is invalid, not optional absence.
  try {
    const value = await readOwnedJson(path);
    if (!value || typeof value !== "object" || Array.isArray(value))
      return Object.freeze({ kind: "invalid" });
    freezeJson(value);
    return Object.freeze({
      kind: "present",
      value: value as Readonly<Record<string, unknown>>,
    });
  } catch {
    return Object.freeze({ kind: "invalid" });
  }
}

// Acquisition only: no fallback, semantic resolution, discovery or authorization.
// Consume all three states in the existing Organization resolution contract.
export async function readOrganizationDocuments(directory: string) {
  if (!["darwin", "linux"].includes(process.platform))
    return Object.freeze({ kind: "unavailable" as const });
  try {
    const before = await inspectOwnedDirectory(directory);
    const canonical = await readDocument(join(directory, paths.canonical));
    const legacy = await readDocument(join(directory, paths.legacy));
    const modules = await readDocument(join(directory, paths.modules));
    const after = await inspectOwnedDirectory(directory);
    if (before.dev !== after.dev || before.ino !== after.ino)
      return Object.freeze({ kind: "unavailable" as const });
    return Object.freeze({
      kind: "documents-observed" as const,
      canonical,
      legacy,
      modules,
    });
  } catch {
    return Object.freeze({ kind: "unavailable" as const });
  }
}
