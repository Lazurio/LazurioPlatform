import { lstat, readlink, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { inspectOwnedDirectory } from "./owned-directory";

const names = ["Lazurio", "Conglomerate", "Conglomerate_GEN3"] as const;
type Name = (typeof names)[number];
type Observation = Readonly<
  | { name: Name; kind: "missing" }
  | { name: Name; kind: "directory"; device: number; inode: number }
  | { name: Name; kind: "alias"; device: number; inode: number }
>;

// Read-only path inventory, not an approved migration plan or a writer lock.
// The caller supplies an owned synthetic home; never discover an ambient home.
export async function inspectLegacyPaths(home: string) {
  if (process.platform !== "darwin")
    return { kind: "blocked", reason: "unqualified-platform" } as const;
  try {
    const parent = await inspectOwnedDirectory(home);
    const canonical = join(home, "Lazurio");
    const inspect = async (name: Name): Promise<Observation> => {
      const path = join(home, name);
      const before = await lstat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (!before) return Object.freeze({ name, kind: "missing" });
      let kind: "directory" | "alias";
      if (before.isSymbolicLink()) {
        // Reject foreign targets before resolving them or reading their content.
        if (name === "Lazurio") throw new Error("Canonical path is an alias");
        const target = await readlink(path);
        if (resolve(home, target) !== canonical)
          throw new Error("Unexpected alias target");
        const targetStat = await inspectOwnedDirectory(canonical);
        if ((await realpath(path)) !== canonical || !targetStat.isDirectory())
          throw new Error("Unresolved alias");
        if ((await readlink(path)) !== target) throw new Error("Alias changed");
        kind = "alias";
      } else {
        await inspectOwnedDirectory(path);
        kind = "directory";
      }
      const after = await lstat(path);
      if (
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.mode !== after.mode ||
        before.ctimeMs !== after.ctimeMs
      )
        throw new Error("Path changed");
      return Object.freeze({ name, kind, device: after.dev, inode: after.ino });
    };
    const paths = await Promise.all(names.map(inspect));
    const repeated = await Promise.all(names.map(inspect));
    const currentParent = await inspectOwnedDirectory(home);
    if (
      parent.dev !== currentParent.dev ||
      parent.ino !== currentParent.ino ||
      JSON.stringify(paths) !== JSON.stringify(repeated)
    )
      throw new Error("Path inventory changed");
    return Object.freeze({
      kind: "observed" as const,
      paths: Object.freeze(paths),
    });
  } catch {
    // Do not expose foreign paths, link contents or OS diagnostics.
    return { kind: "blocked", reason: "unsafe-or-changing-paths" } as const;
  }
}
