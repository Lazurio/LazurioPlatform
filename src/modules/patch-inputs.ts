import { createHash } from "node:crypto";
import { join } from "node:path";
import { inspectOwnedDirectory } from "../folder/owned-directory";
import { readOwnedDeclarationBytes } from "../providers/owned-json";

// Explicit owner-relative patch inputs, not a parser or executor of patch content.
export async function inspectPatchInputs(owner: string, value: unknown) {
  const result: Record<string, string> = Object.create(null);
  if (value === undefined) return Object.freeze(result);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Patch declaration object required");
  const paths = new Set<string>();
  for (const descriptor of Object.values(
    Object.getOwnPropertyDescriptors(value),
  )) {
    if (!("value" in descriptor) || typeof descriptor.value !== "string")
      throw new Error("Patch path required");
    const path = descriptor.value;
    const segments = path.split("/");
    if (
      segments.some(
        (part) =>
          !part ||
          part === "." ||
          part === ".." ||
          part === ".git" ||
          part === "node_modules",
      ) ||
      path.includes("\\") ||
      path.includes(":") ||
      [...path].some(
        (character) =>
          character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      )
    )
      throw new Error("Owner-relative patch path required");
    paths.add(path);
  }
  await inspectOwnedDirectory(owner);
  for (const path of [...paths].sort()) {
    let directory = owner;
    for (const segment of path.split("/").slice(0, -1)) {
      directory = join(directory, segment);
      const identity = await inspectOwnedDirectory(directory);
      result[`directory:${directory}`] = `${identity.dev}:${identity.ino}`;
    }
    const bytes = await readOwnedDeclarationBytes(join(owner, path));
    result[path] = createHash("sha256").update(bytes).digest("hex");
  }
  return Object.freeze(result);
}
