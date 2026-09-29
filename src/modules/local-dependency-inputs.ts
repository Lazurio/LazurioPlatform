import { createHash } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { inspectCheckoutDirectory } from "../folder/owned-directory";
import { readCheckoutFileBytes } from "../providers/owned-json";
import { parseUniqueJson } from "../providers/unique-json";
import { PreparationRefused } from "./preparation-refusal";

// The owner-relative roots of one manifest's `file:` dependencies, added to
// `roots`; `base` is the manifest's directory relative to the owner and
// `file` its path, which a dependency outside the owner is refused with
// (decision F25). Parses only; nothing is read.
function collect(
  manifest: Readonly<Record<string, unknown>>,
  base: string,
  file: string,
  roots: Set<string>,
) {
  const outside = () =>
    new PreparationRefused(
      "preparation-dependency-outside-owner",
      file,
      "Local dependency escapes its owner",
    );
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
      // Trailing directory separators do not change the selected input. Strip
      // them before resolving parent segments, retaining the owner escape check.
      let path = descriptor.value
        .slice(5)
        .replace(/^\.\//, "")
        .replace(/\/+$/, "");
      const prefix = base ? base.split("/") : [];
      while (path.startsWith("../")) {
        if (!prefix.length) throw outside();
        prefix.pop();
        path = path.slice(3);
      }
      if (path === "..") {
        if (!prefix.length) throw outside();
        prefix.pop();
        roots.add(prefix.join("/"));
        continue;
      }
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
      roots.add([...prefix, path].join("/"));
    }
  }
}

/** Whether the owner's own `file:` dependencies stay inside it, without
 * reading them: what a read-only check of the preparation (the catalog)
 * can know. */
export function inspectDirectLocalDependencies(
  owner: string,
  manifest: Readonly<Record<string, unknown>>,
) {
  collect(manifest, "", join(owner, "package.json"), new Set());
}

// File dependency graph within one explicit owner. No installation occurs here.
// Other local protocols and workspace effects still need qualification.
export async function inspectLocalDependencyInputs(
  owner: string,
  manifest: Readonly<Record<string, unknown>>,
) {
  const roots = new Set<string>();
  collect(manifest, "", join(owner, "package.json"), roots);
  const result: Record<string, string> = Object.create(null);
  let count = 0;
  let size = 0;
  // Set iteration includes newly discovered roots and visits cycles only once.
  for (const root of roots) {
    let parent = owner;
    for (const segment of root.split("/").slice(0, -1)) {
      parent = join(parent, segment);
      const identity = await inspectCheckoutDirectory(parent);
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
        const identity = await inspectCheckoutDirectory(path);
        result[`directory:${path}`] = `${identity.dev}:${identity.ino}`;
        const entries = await readdir(path);
        for (const entry of entries.sort().reverse()) {
          if (entry === ".git" || entry === "node_modules") continue;
          pending.push(relative ? `${relative}/${entry}` : entry);
        }
      } else {
        const bytes = await readCheckoutFileBytes(path);
        size += bytes.length;
        if (size > 64 * 1024 * 1024)
          throw new Error("Local dependency byte limit exceeded");
        result[relative] = createHash("sha256").update(bytes).digest("hex");
        if (relative === (root ? `${root}/package.json` : "package.json")) {
          const nested = parseUniqueJson(bytes.toString("utf8"));
          if (!nested || typeof nested !== "object" || Array.isArray(nested))
            throw new Error("Local dependency package object required");
          collect(nested as Record<string, unknown>, root, path, roots);
        }
      }
    }
  }
  return Object.freeze(result);
}
