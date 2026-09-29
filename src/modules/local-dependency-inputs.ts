import { createHash } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { inspectCheckoutDirectory } from "../folder/owned-directory";
import { readCheckoutFileBytes } from "../providers/owned-json";
import { parseUniqueJson } from "../providers/unique-json";
import { PreparationRefused } from "./preparation-refusal";

// The roots of one manifest's `file:` dependencies, relative to the
// boundary, each with the manifest that declares it, added to `roots`.
// `base` is the manifest's directory relative to the boundary and `file` its
// path, which a dependency outside the boundary is refused with (decision
// F25). Paths are normalized as text: no symlink is followed. Parses only;
// nothing is read.
function collect(
  manifest: Readonly<Record<string, unknown>>,
  base: string,
  file: string,
  roots: Map<string, string>,
) {
  const outside = () =>
    new PreparationRefused(
      "preparation-dependency-outside-owner",
      file,
      "Local dependency escapes its owner",
    );
  const add = (root: string) => {
    if (!roots.has(root)) roots.set(root, file);
  };
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
        add(prefix.join("/"));
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
      add([...prefix, path].join("/"));
    }
  }
}

// Where the dependencies of `owner` may lie: the owner itself, or for the
// default preparation the Organization (or Personalspace owner) directory
// that holds it (decision F25). The boundary itself is never a dependency:
// that would be the whole checkout.
function scope(owner: string, boundary: string) {
  const offset = relative(boundary, owner);
  if (isAbsolute(offset) || offset === ".." || offset.startsWith(`..${sep}`))
    throw new Error("Install owner outside its dependency boundary");
  return offset.split(sep).filter(Boolean).join("/");
}

// A dependency root, reached from the boundary one real directory of the
// checkout at a time (decision F23: no symlink, the operator's own). A root
// that is not there is `preparation-dependency-missing`, named by the
// manifest that declares it.
async function reach(
  boundary: string,
  root: string,
  file: string,
  widened: boolean,
  seen?: Record<string, string>,
) {
  if (widened && root === "")
    throw new PreparationRefused(
      "preparation-dependency-outside-owner",
      file,
      "Local dependency is its whole boundary",
    );
  const missing = (error: unknown) => {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR"
      ? new PreparationRefused(
          "preparation-dependency-missing",
          file,
          "Local dependency missing",
        )
      : error;
  };
  let parent = boundary;
  for (const segment of root.split("/").slice(0, -1)) {
    parent = join(parent, segment);
    const identity = await inspectCheckoutDirectory(parent).catch(
      (error: unknown) => {
        throw missing(error);
      },
    );
    if (seen) seen[`directory:${parent}`] = `${identity.dev}:${identity.ino}`;
  }
  const path = join(boundary, root);
  const stat = await lstat(path).catch((error: unknown) => {
    throw missing(error);
  });
  return { path, stat };
}

/** Whether the owner's own `file:` dependencies stay inside the boundary
 * and are there, reached through real directories of the operator's
 * checkout, without reading their contents: what a read-only check of the
 * preparation (the catalog) can know. */
export async function inspectDirectLocalDependencies(
  owner: string,
  manifest: Readonly<Record<string, unknown>>,
  boundary: string = owner,
) {
  const roots = new Map<string, string>();
  collect(manifest, scope(owner, boundary), join(owner, "package.json"), roots);
  for (const [root, file] of roots) {
    const { path, stat } = await reach(
      boundary,
      root,
      file,
      boundary !== owner,
    );
    if (stat.isDirectory() || stat.isSymbolicLink())
      await inspectCheckoutDirectory(path);
  }
}

// File dependency graph within one explicit boundary: the owner, or for the
// default preparation the Organization directory holding it (decision F25).
// Only the declared dependencies are inventoried, never the boundary as a
// whole. No installation occurs here. Other local protocols and workspace
// effects still need qualification.
export async function inspectLocalDependencyInputs(
  owner: string,
  manifest: Readonly<Record<string, unknown>>,
  boundary: string = owner,
) {
  const roots = new Map<string, string>();
  collect(manifest, scope(owner, boundary), join(owner, "package.json"), roots);
  const result: Record<string, string> = Object.create(null);
  let count = 0;
  let size = 0;
  // Map iteration includes newly discovered roots and visits cycles only once.
  for (const [root, file] of roots) {
    await reach(boundary, root, file, boundary !== owner, result);
    const pending = [root];
    while (pending.length) {
      const relative = pending.pop() as string;
      if (++count > 20_000 || relative.split("/").length > 64)
        throw new Error("Local dependency inventory limit exceeded");
      const path = join(boundary, relative);
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
