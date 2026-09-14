import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { GLOBSTAR, Minimatch } from "minimatch";
import { inspectOwnedDirectory } from "../folder/owned-directory";
import { readOwnedDeclarationBytes } from "../providers/owned-json";
import { compileWorkspacePatterns } from "./workspace-membership";

// Read-only manifest inventory, not complete workspace execution qualification.
// Local file dependencies, patches and other effect inputs remain separate gates.
export async function inspectWorkspaceInputs(
  owner: string,
  workspaces: unknown,
) {
  if (workspaces === undefined) return Object.freeze({});
  const patterns = compileWorkspacePatterns(workspaces);
  const descendants = patterns
    .filter((entry) => !entry.excluded)
    .map(
      ({ pattern }) =>
        new Minimatch(pattern, {
          dot: true,
          nonegate: true,
          nocomment: true,
          noext: true,
          platform: "linux",
        }),
    );
  const selectedMember = (path: string) =>
    patterns.some((entry) => !entry.excluded && entry.glob.match(path)) &&
    !patterns.some((entry) => entry.excluded && entry.glob.match(path));
  const possibleDescendant = (path: string) => {
    const parts = path.split("/");
    if (
      patterns.some(
        ({ excluded, pattern }) =>
          excluded &&
          pattern.endsWith("/**") &&
          new Bun.Glob(pattern.slice(0, -3)).match(path),
      )
    )
      return false;
    return descendants.some((matcher) =>
      matcher.set.some(
        (row) =>
          (row.includes(GLOBSTAR) || row.length > parts.length) &&
          matcher.matchOne(parts, row, true),
      ),
    );
  };
  await inspectOwnedDirectory(owner);
  const members = new Set<string>();
  let entriesObserved = 0;
  const pending = [""];
  while (pending.length) {
    const relative = pending.pop() as string;
    if (relative.split("/").length > 64)
      throw new Error("Workspace inventory depth limit exceeded");
    const directory = join(owner, relative);
    await inspectOwnedDirectory(directory);
    const entries = await readdir(directory, { withFileTypes: true });
    entriesObserved += entries.length;
    if (entriesObserved > 20_000)
      throw new Error("Workspace inventory entry limit exceeded");
    const selected = relative !== "" && selectedMember(relative);
    for (const entry of entries) {
      // Prune before traversal, not after a glob has walked derived/Git trees.
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (
        entry.isDirectory() &&
        (selectedMember(path) || possibleDescendant(path))
      )
        pending.push(path);
      if (selected && entry.name === "package.json") {
        if (!entry.isFile())
          throw new Error("Regular workspace manifest required");
        members.add(path);
      }
    }
  }
  const result: Record<string, string> = {};
  for (const member of [...members].sort()) {
    let directory = owner;
    for (const segment of dirname(member).split("/")) {
      directory = join(directory, segment);
      const identity = await inspectOwnedDirectory(directory);
      result[`directory:${directory}`] = `${identity.dev}:${identity.ino}`;
    }
    const bytes = await readOwnedDeclarationBytes(join(owner, member));
    result[member] = createHash("sha256").update(bytes).digest("hex");
  }
  return Object.freeze(result);
}
