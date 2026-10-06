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
   * `replaced`: a link to the selector of a Lazurio install base, another one
   * or one that is gone.
   * `conflict`: something that is not Lazurio's; left unchanged.
   * `failed`: the directory or the link could not be written. */
  state: "created" | "present" | "replaced" | "conflict" | "failed";
  /** `conflict` only: what occupies the entry. */
  occupant: Readonly<{
    /** `parent`: `~/.local` or `~/.local/bin` is itself not a plain
     * directory, so the entry would land somewhere else. */
    kind: "file" | "link" | "other" | "parent";
    /** A link's literal target; for `parent` the path of that component. */
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
 * has that shape under a directory named as an install base is and the base
 * is gone. Any other link is someone else's, working or dangling: a dangling
 * link may point to a volume that is not mounted right now.
 */
async function classifyLink(
  entry: string,
  selector: string,
): Promise<"present" | "replace" | "foreign"> {
  const literal = await readlink(entry);
  const pointed = resolve(dirname(entry), literal);
  if (pointed === selector) return "present";
  if (
    basename(pointed) !== executableName ||
    basename(dirname(pointed)) !== "bin"
  )
    return "foreign";
  const base = dirname(dirname(pointed));
  let dangling = false;
  try {
    await stat(entry);
  } catch (error) {
    if (!absent(error)) throw error;
    dangling = true;
  }
  if (dangling)
    return basename(base).toLowerCase() === executableName
      ? "replace"
      : "foreign";
  return (await readSelector(base)) !== null ? "replace" : "foreign";
}

/** Create a missing directory with 0755, whatever the umask; an existing one
 * is the user's and is never re-moded. False when the component exists and
 * is not a plain directory (a link, a file): nothing is written through it. */
async function ensureDirectory(directory: string): Promise<boolean> {
  try {
    return (await lstat(directory)).isDirectory();
  } catch (error) {
    if (!absent(error)) throw error;
  }
  try {
    await mkdir(directory, { mode: 0o755 });
    await chmod(directory, 0o755);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return (await lstat(directory)).isDirectory();
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

/** What is at the entry, looked at component by component and never through
 * a link: the entry is only ever written into the real `~/.local/bin`. With
 * `create`, a missing `~/.local` or `~/.local/bin` is created (0755); without
 * it nothing is written and a missing directory means a missing entry. */
type Observed =
  | Readonly<{ kind: "missing" | "present" | "replaceable" }>
  | Readonly<{
      kind: "conflict";
      occupant: NonNullable<PathEntry["occupant"]>;
    }>;

async function observeEntry(
  home: string,
  target: string,
  create: boolean,
): Promise<Observed> {
  const directory = entryDirectory(home);
  for (const component of [join(home, ".local"), directory]) {
    if (create) {
      if (!(await ensureDirectory(component)))
        return {
          kind: "conflict",
          occupant: Object.freeze({ kind: "parent", target: component }),
        };
      continue;
    }
    try {
      if (!(await lstat(component)).isDirectory())
        return {
          kind: "conflict",
          occupant: Object.freeze({ kind: "parent", target: component }),
        };
    } catch (error) {
      if (!absent(error)) throw error;
      return { kind: "missing" };
    }
  }
  const path = join(directory, executableName);
  let found: Awaited<ReturnType<typeof lstat>>;
  try {
    found = await lstat(path);
  } catch (error) {
    if (!absent(error)) throw error;
    return { kind: "missing" };
  }
  if (!found.isSymbolicLink())
    return {
      kind: "conflict",
      occupant: Object.freeze({ kind: found.isFile() ? "file" : "other" }),
    };
  const kind = await classifyLink(path, target);
  if (kind === "present") return { kind: "present" };
  if (kind === "replace") return { kind: "replaceable" };
  return {
    kind: "conflict",
    occupant: Object.freeze({ kind: "link", target: await readlink(path) }),
  };
}

/** Whether `~/.local/bin` is on this PATH, and which other `lazurio`, if
 * any, resolves first on it. */
async function pathFacts(
  directory: string,
  target: string,
  pathVariable: string | undefined,
  platform: string,
): Promise<Readonly<{ directoryOnPath: boolean; shadowedBy: string | null }>> {
  const directoryOnPath = (pathVariable ?? "")
    .split(":")
    .some((entry) => isAbsolute(entry) && resolve(entry) === directory);
  // The same program under another name (the selector itself, an alias of
  // the directory) is not another program.
  const first = await resolveOnPath(executableName, pathVariable, platform);
  const shadowedBy =
    first !== undefined && !(await sameFile(first, target)) ? first : null;
  return { directoryOnPath, shadowedBy };
}

type EntryInput = Readonly<{
  base: string;
  home: string | undefined;
  pathVariable: string | undefined;
  platform: string;
}>;

/** Null where there is no home to put the entry in or the platform has no
 * install base design (only macOS and Linux have one). */
const entryHome = (input: EntryInput) =>
  input.home &&
  isAbsolute(input.home) &&
  (input.platform === "darwin" || input.platform === "linux")
    ? input.home
    : null;

/** The entry as it is, for `lazurio install prompt`: nothing is written.
 * `missing` and `replaceable` are what `lazurio install` would create or
 * replace; `unreadable` is an entry that could not be looked at. */
export type ObservedEntry = Readonly<{
  path: string;
  target: string;
  state: "present" | "missing" | "replaceable" | "conflict" | "unreadable";
  occupant: PathEntry["occupant"];
  directoryOnPath: boolean;
  shadowedBy: string | null;
}>;

export async function inspectPathEntry(
  input: EntryInput,
): Promise<ObservedEntry | null> {
  const home = entryHome(input);
  if (home === null) return null;
  const directory = entryDirectory(home);
  const target = layout(input.base).selector;
  let observed: Observed | null;
  try {
    observed = await observeEntry(home, target, false);
  } catch {
    observed = null;
  }
  return Object.freeze({
    path: join(directory, executableName),
    target,
    state: observed?.kind ?? "unreadable",
    occupant: observed?.kind === "conflict" ? observed.occupant : null,
    ...(await pathFacts(directory, target, input.pathVariable, input.platform)),
  });
}

/** Convergent: repeated, it finds the entry `present` and writes nothing. */
export async function ensurePathEntry(
  input: EntryInput,
): Promise<PathEntry | null> {
  const home = entryHome(input);
  if (home === null) return null;
  const directory = entryDirectory(home);
  const path = join(directory, executableName);
  const target = layout(input.base).selector;
  let state: PathEntry["state"];
  let occupant: PathEntry["occupant"] = null;
  try {
    const observed = await observeEntry(home, target, true);
    if (observed.kind === "missing") {
      await placeLink(path, target);
      state = "created";
    } else if (observed.kind === "replaceable") {
      await placeLink(path, target);
      state = "replaced";
    } else if (observed.kind === "conflict") {
      state = "conflict";
      occupant = observed.occupant;
    } else state = "present";
  } catch {
    state = "failed";
  }

  const { directoryOnPath, shadowedBy } = await pathFacts(
    directory,
    target,
    input.pathVariable,
    input.platform,
  );
  const linked = entryLinked({ state });

  const next: string[] = [];
  if (state === "conflict")
    next.push(
      occupant?.kind === "parent"
        ? `${occupant.target} is not a plain directory, so ${path} was not written. Run Lazurio as ${target}. Put ${dirname(target)} on your PATH, or make ${occupant.target} a plain directory on the operator's instruction and run \`lazurio install\` again.`
        : `${path} is ${
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
