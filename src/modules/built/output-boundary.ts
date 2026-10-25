import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";

// The way from an app's package to its declared build output (decision F58).
// `build_output` is a path of plain relative segments (never `.`, `..`,
// absolute or with a backslash), so it can leave the package only through a
// link on the way: a symlink, or on Windows a junction, which Node reports as
// a symbolic link. A build removes the output before its script runs and
// copies it into the cache after; through such a link the removal would
// delete, and the copy would take, files outside the checkout.

/** Why the way to `output` may not be removed or copied, naming the entry, or
 * null when it stays inside the package `cwd`. Every existing entry on the
 * way must be a real directory (the output itself may also be a file, which
 * stays inside), and what exists of the way must resolve inside the package.
 * Reads only. */
export async function outputOutsidePackage(
  cwd: string,
  output: string,
): Promise<string | null> {
  const segments = output.split("/");
  let root: string;
  try {
    root = await realpath(cwd);
  } catch (error) {
    // No package directory: nothing on the way exists, so nothing outside
    // can be removed or copied through it.
    if (code(error) === "ENOENT") return null;
    return `the app's package cannot be read (${code(error)})`;
  }
  let current = cwd;
  let deepest = cwd;
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment);
    const name = segments.slice(0, index + 1).join("/");
    let entry: Awaited<ReturnType<typeof lstat>>;
    try {
      entry = await lstat(current);
    } catch (error) {
      if (code(error) === "ENOENT") break;
      return `${name} cannot be read (${code(error)})`;
    }
    if (entry.isSymbolicLink())
      return `${name} is a link (a symlink or a junction)`;
    if (!entry.isDirectory()) {
      if (index === segments.length - 1) break;
      return `${name} is not a directory`;
    }
    deepest = current;
  }
  let resolved: string;
  try {
    resolved = await realpath(deepest);
  } catch (error) {
    return `the way to the output cannot be read (${code(error)})`;
  }
  const inside = relative(root, resolved);
  if (inside.startsWith("..") || isAbsolute(inside))
    return "the way to the output leads out of the app's package";
  return null;
}

/** The build log's line for a refused output. */
export function outsidePackageLog(output: string, reason: string): string {
  return `[lazurio] build_output ${output}: ${reason}. The output and the way to it must stay inside the app's package; nothing outside it is removed or copied and this build is not used.\n`;
}

function code(error: unknown): string {
  return error instanceof Error &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : "error";
}
