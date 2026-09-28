import { randomBytes } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { resolveOnPath } from "../tools/status";
import { syncDirectory } from "./durable-file";
import { executableName, layout, readSelector } from "./layout";

/** The standard entry of the operator's tools (root decision 0161 point 6,
 * F17 addendum 2026-09-28): `~/.local/bin/lazurio`, a symlink to the install
 * base's selector, so the command on PATH always runs the active version.
 * `lazurio install` creates it and never takes it from anyone: an entry that
 * is not Lazurio's stays exactly as it is and the result says so. Shell
 * profiles are never edited; whether `~/.local/bin` is on PATH, and whether
 * another `lazurio` resolves first, is reported, not changed.
 */
export type PathEntry = Readonly<{
  /** `~/.local/bin/lazurio`. */
  path: string;
  /** The selector it points to: `<base>/bin/lazurio`. */
  target: string;
  /** `present`: it already pointed to the selector and was left alone.
   * `replaced`: a dangling link or a link into another Lazurio install base.
   * `conflict`: something that is not Lazurio's; left unchanged.
   * `failed`: the directory or the link could not be written. */
  state: "created" | "present" | "replaced" | "conflict" | "failed";
  /** `conflict` only: what occupies the entry. */
  occupant: Readonly<{
    kind: "file" | "link" | "other";
    /** A link's literal target. */
    target?: string;
  }> | null;
  /** `~/.local/bin` is a directory of this process's PATH. */
  directoryOnPath: boolean;
  /** Another program named `lazurio` that resolves first on this PATH. */
  shadowedBy: string | null;
  /** What the operator or an agent should do; empty when nothing. */
  next: readonly string[];
}>;

export const entryDirectory = (home: string) => join(home, ".local", "bin");

/** The entry runs this installation's selector. */
export const entryLinked = (entry: Pick<PathEntry, "state"> | null) =>
  entry !== null &&
  (entry.state === "created" ||
    entry.state === "present" ||
    entry.state === "replaced");

const absent = (error: unknown) =>
  (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";

/** Whether an existing link at the entry belongs to Lazurio: it points to
 * `<directory>/bin/lazurio` and that is an install base's selector, or it
 * points to nothing at all.
 */
async function classifyLink(
  entry: string,
  selector: string,
): Promise<"present" | "replace" | "foreign"> {
  const literal = await readlink(entry);
  const pointed = resolve(dirname(entry), literal);
  if (pointed === selector) return "present";
  try {
    await stat(entry);
  } catch (error) {
    // Dangling: it runs nothing, so nothing is taken from anyone.
    if (absent(error)) return "replace";
    throw error;
  }
  if (
    basename(pointed) === executableName &&
    basename(dirname(pointed)) === "bin" &&
    (await readSelector(dirname(dirname(pointed)))) !== null
  )
    return "replace";
  return "foreign";
}

/** Create a missing directory with 0755, whatever the umask; an existing one
 * is the user's and is never re-moded. */
async function ensureDirectory(directory: string) {
  try {
    await mkdir(directory, { mode: 0o755 });
    await chmod(directory, 0o755);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

/** One atomic rename puts the link in place: a reader sees the old entry or
 * the new one, never none. The directory is shared with other tools, so only
 * this call's own temporary name is ever removed. */
async function placeLink(entry: string, target: string) {
  const temporary = join(
    dirname(entry),
    `.${executableName}.tmp-${randomBytes(8).toString("hex")}`,
  );
  await symlink(target, temporary);
  try {
    await rename(temporary, entry);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  await syncDirectory(dirname(entry));
}

async function sameFile(a: string, b: string): Promise<boolean> {
  try {
    return (await realpath(a)) === (await realpath(b));
  } catch {
    return false;
  }
}

/** Convergent: repeated, it finds the entry `present` and writes nothing.
 * Null where there is no home to put it in or the platform has no install
 * base design (only macOS and Linux have one). */
export async function ensurePathEntry(
  input: Readonly<{
    base: string;
    home: string | undefined;
    pathVariable: string | undefined;
    platform: string;
  }>,
): Promise<PathEntry | null> {
  const { home, platform } = input;
  if (!home || !isAbsolute(home)) return null;
  if (platform !== "darwin" && platform !== "linux") return null;
  const directory = entryDirectory(home);
  const path = join(directory, executableName);
  const target = layout(input.base).selector;
  let state: PathEntry["state"];
  let occupant: PathEntry["occupant"] = null;
  try {
    let found: Awaited<ReturnType<typeof lstat>> | null = null;
    try {
      found = await lstat(path);
    } catch (error) {
      if (!absent(error)) throw error;
    }
    if (found === null) {
      await ensureDirectory(join(home, ".local"));
      await ensureDirectory(directory);
      await placeLink(path, target);
      state = "created";
    } else if (found.isSymbolicLink()) {
      const kind = await classifyLink(path, target);
      if (kind === "present") state = "present";
      else if (kind === "replace") {
        await placeLink(path, target);
        state = "replaced";
      } else {
        state = "conflict";
        occupant = Object.freeze({
          kind: "link" as const,
          target: await readlink(path),
        });
      }
    } else {
      state = "conflict";
      occupant = Object.freeze({
        kind: found.isFile() ? ("file" as const) : ("other" as const),
      });
    }
  } catch {
    state = "failed";
  }

  const directoryOnPath = (input.pathVariable ?? "")
    .split(":")
    .some((entry) => isAbsolute(entry) && resolve(entry) === directory);
  // The same program under another name (the selector itself, an alias of
  // the directory) is not another program.
  const first = await resolveOnPath(
    executableName,
    input.pathVariable,
    platform,
  );
  const shadowedBy =
    first !== undefined && !(await sameFile(first, target)) ? first : null;
  const linked = entryLinked({ state });

  const next: string[] = [];
  if (state === "conflict")
    next.push(
      `${path} is ${
        occupant?.kind === "link"
          ? `a link to ${occupant.target}`
          : occupant?.kind === "file"
            ? "a regular file"
            : "not a file or a link"
      } that is not Lazurio's; it was left unchanged. Until it is resolved, run Lazurio as ${target}. Move that entry aside only on the operator's instruction, then run \`lazurio install\` again.`,
    );
  if (state === "failed")
    next.push(
      `${path} could not be created. Until it exists, run Lazurio as ${target}; \`lazurio install\` tries again.`,
    );
  if (linked && !directoryOnPath)
    next.push(
      `Put ${directory} on your PATH. Lazurio never edits shell profiles.`,
    );
  if (shadowedBy !== null)
    next.push(
      `Another program named lazurio resolves first on PATH: ${shadowedBy}. This installation is ${linked ? path : target}. Nothing was changed about ${shadowedBy}; remove it or put ${directory} before its directory on PATH only on the operator's instruction.`,
    );
  return Object.freeze({
    path,
    target,
    state,
    occupant,
    directoryOnPath,
    shadowedBy,
    next: Object.freeze(next),
  });
}
