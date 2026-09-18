import { posix } from "node:path";
import { array, text } from "./manifest";

// Declarative membership only: no filesystem custody, dependency snapshot or
// execution permission follows from a match. Paths are module-relative packages.
export function isDeclaredWorkspaceMember(
  ownerPackage: string,
  applicationPackage: string,
  workspaces: unknown,
) {
  const packagePattern = /^(?:(?!\.{1,2}\/)[A-Za-z0-9._-]+\/)*package\.json$/;
  text(ownerPackage, packagePattern);
  text(applicationPackage, packagePattern);
  if (ownerPackage === applicationPackage) return true;
  const member = posix.relative(
    posix.dirname(ownerPackage),
    posix.dirname(applicationPackage),
  );
  if (!member || member === ".." || member.startsWith("../")) return false;
  if (workspaces === undefined) return false;
  // The first contract uses Bun's documented array form. Unknown shapes must not
  // silently become membership or a fallback to an ancestor install owner.
  const patterns = compileWorkspacePatterns(workspaces);
  return (
    patterns.some(({ excluded, glob }) => !excluded && glob.match(member)) &&
    !patterns.some(({ excluded, glob }) => excluded && glob.match(member))
  );
}

export function compileWorkspacePatterns(workspaces: unknown) {
  return array(workspaces).map((value) => {
    const source = text(value, /.+/);
    const excluded = source.startsWith("!");
    const pattern = excluded ? source.slice(1) : source;
    if (
      !pattern ||
      pattern.startsWith("/") ||
      pattern.includes("\\") ||
      pattern.split("/").includes("..")
    )
      throw new Error("Module-relative workspace pattern required");
    return { excluded, pattern, glob: new Bun.Glob(pattern) };
  });
}
