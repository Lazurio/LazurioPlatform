import { createHash } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { inspectOwnedDirectory } from "../folder/owned-directory";
import { readOwnedDeclarationBytes } from "../providers/owned-json";

// Direct owner-relative file: inputs. No installation or dependency resolution.
// Other local protocols and transitive local inputs still need qualification.
export async function inspectLocalDependencyInputs(
  owner: string,
  manifest: Readonly<Record<string, unknown>>,
) {
  const roots = new Set<string>();
  for (const field of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    const declarations = manifest[field];
    if (declarations === undefined) continue;
    if (
      !declarations ||
      typeof declarations !== "object" ||
      Array.isArray(declarations)
    )
      throw new Error("Dependency declaration object required");
    for (const descriptor of Object.values(
      Object.getOwnPropertyDescriptors(declarations),
    )) {
      if (!("value" in descriptor) || typeof descriptor.value !== "string")
        throw new Error("Dependency reference required");
      if (!descriptor.value.startsWith("file:")) continue;
      const path = descriptor.value.slice(5).replace(/^\.\//, "");
      if (
        path
          .split("/")
          .some(
            (part: string) =>
              !part || [".", "..", ".git", "node_modules"].includes(part),
          ) ||
        path.includes("\\") ||
        path.includes(":") ||
        [...path].some(
          (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
        )
      )
        throw new Error("Owner-relative local dependency required");
      roots.add(path);
    }
  }
  const result: Record<string, string> = Object.create(null);
  let count = 0;
  let size = 0;
  for (const root of [...roots].sort()) {
    let parent = owner;
    for (const segment of root.split("/").slice(0, -1)) {
      parent = join(parent, segment);
      const identity = await inspectOwnedDirectory(parent);
      result[`directory:${parent}`] = `${identity.dev}:${identity.ino}`;
    }
    const pending = [root];
    while (pending.length) {
      const relative = pending.pop() as string;
      if (++count > 20_000 || relative.split("/").length > 64)
        throw new Error("Local dependency inventory limit exceeded");
      const path = join(owner, relative);
      const stat = await lstat(path);
      if (stat.isDirectory()) {
        const identity = await inspectOwnedDirectory(path);
        result[`directory:${path}`] = `${identity.dev}:${identity.ino}`;
        const entries = await readdir(path);
        for (const entry of entries.sort().reverse()) {
          if (entry === ".git" || entry === "node_modules") continue;
          pending.push(`${relative}/${entry}`);
        }
      } else {
        const bytes = await readOwnedDeclarationBytes(path);
        size += bytes.length;
        if (size > 64 * 1024 * 1024)
          throw new Error("Local dependency byte limit exceeded");
        result[relative] = createHash("sha256").update(bytes).digest("hex");
      }
    }
  }
  return Object.freeze(result);
}
