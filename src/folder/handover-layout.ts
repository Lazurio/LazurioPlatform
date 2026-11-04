import { lstat, opendir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { inspectOwnedDirectory } from "./owned-directory";
import { stateFields } from "./state-fields";

type Identity = Readonly<{ dev: string; ino: string }>;
// `personalspace` is recorded when the directory exists at initialization;
// an Organization preset tolerates an empty one and refuses a used one.
export type HandoverLayout = Readonly<{
  root: Identity;
  organizations: Identity;
  personalspace?: Identity;
}>;
export type PersonalspacePolicy = "present" | "never";

// The Folder owns exactly these top-level entries; everything else is the
// operator's. The two legacy launchpad files are tolerated by name only. A
// `manual/` without recorded digests is a foreign entry like any other: it is
// refused by name, never adopted or overwritten. `.agents/` and `.claude/`
// hold the Folder's skills (decision F14, addendum of 2026-10-14) beside
// whatever a harness or the person keeps there; only the skill files are
// Lazurio's, and before the Folder has state they are foreign like the rest.
const owned = [
  "AGENTS.md",
  "manual",
  ".agents",
  ".claude",
  ".lazurio",
] as const;
const tolerated = [
  "organizations",
  "personalspace",
  "launchpad.gen3.json",
  "launchpad.gen3.local.json",
] as const;

// A refusal that names the top-level entry it concerns, so an operator can act
// without the initializer listing, reading or moving anything.
export class FolderAdoptionError extends Error {
  constructor(
    public readonly code:
      | "foreign-entry"
      | "layout-missing"
      | "personalspace-conflict"
      | "state-unrecognized"
      | "binding-changed"
      | "directory-shared",
    public readonly entry: string,
  ) {
    super(`${code}: ${entry}`);
  }
}

function identity(value: unknown): Identity {
  const fields = stateFields(value, ["dev", "ino"]);
  if (
    typeof fields.dev !== "string" ||
    typeof fields.ino !== "string" ||
    !/^\d+$/.test(fields.dev) ||
    !/^\d+$/.test(fields.ino)
  )
    throw new Error("Invalid handover directory identity");
  return Object.freeze({ dev: fields.dev, ino: fields.ino });
}

export function parseHandoverLayout(value: unknown): HandoverLayout {
  const withPersonalspace =
    typeof value === "object" &&
    value !== null &&
    Object.hasOwn(value, "personalspace");
  const fields = stateFields(
    value,
    withPersonalspace
      ? ["root", "organizations", "personalspace"]
      : ["root", "organizations"],
  );
  const layout: HandoverLayout = {
    root: identity(fields.root),
    organizations: identity(fields.organizations),
  };
  return Object.freeze(
    withPersonalspace
      ? { ...layout, personalspace: identity(fields.personalspace) }
      : layout,
  );
}

async function exists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

// A caller-owned directory that is group- or world-writable (Ubuntu's default
// umask 0002 creates such directories) is refused by name: the ownership rule
// stands, the operator learns which path to fix. Symlinks and foreign owners
// keep the generic refusal of inspectOwnedDirectory. A free Environment's
// layout is held to this same rule before the Platform creates any of it
// (src/machine/assignment.ts `createAssignedFolderLayout`).
export async function ownedIdentity(
  path: string,
  entry: string,
): Promise<Identity> {
  const stat = await lstat(path);
  if (
    stat.isDirectory() &&
    stat.uid === process.getuid?.() &&
    (stat.mode & 0o022) !== 0
  )
    throw new FolderAdoptionError("directory-shared", entry);
  const owned = await inspectOwnedDirectory(path);
  return { dev: String(owned.dev), ino: String(owned.ino) };
}

// Existence and identity only; the work directories are never listed.
export async function inspectHandoverLayout(
  folder: string,
): Promise<HandoverLayout> {
  const root = await ownedIdentity(folder, ".");
  if (!(await exists(join(folder, "organizations"))))
    throw new FolderAdoptionError("layout-missing", "organizations");
  const organizations = await ownedIdentity(
    join(folder, "organizations"),
    "organizations",
  );
  const personalspace = (await exists(join(folder, "personalspace")))
    ? await ownedIdentity(join(folder, "personalspace"), "personalspace")
    : undefined;
  if (
    organizations.dev !== root.dev ||
    (personalspace !== undefined && personalspace.dev !== root.dev)
  )
    throw new Error("Cross-filesystem handover layout");
  return parseHandoverLayout(
    personalspace === undefined
      ? { root, organizations }
      : { root, organizations, personalspace },
  );
}

export async function verifyHandoverLayout(
  folder: string,
  receipt: HandoverLayout,
) {
  const observed = await inspectHandoverLayout(folder);
  if (JSON.stringify(observed) !== JSON.stringify(receipt))
    throw new Error("Handover layout changed; operator repair required");
}

// The directories the layout records, in initialization order.
export function handoverDirectories(layout: HandoverLayout) {
  return layout.personalspace === undefined
    ? (["organizations"] as const)
    : (["organizations", "personalspace"] as const);
}

// Empty or not, never which names are inside: one read of the first entry.
async function isEmptyDirectory(path: string) {
  const directory = await opendir(path);
  try {
    return (await directory.read()) === null;
  } finally {
    await directory.close();
  }
}

// The Folder boundary: every top-level entry is owned or tolerated, anything
// else fails closed by name. `claimed` admits the owned names once the Folder
// has state. Adoption and initialization recovery run this same check before
// they write, so an entry that appears after the journal never gets written
// around.
export async function requireFolderBoundary(folder: string, claimed = false) {
  const entries = (await readdir(folder)).sort();
  const allowed: readonly string[] = claimed
    ? [...tolerated, ...owned]
    : tolerated;
  for (const entry of entries)
    if (!allowed.includes(entry))
      throw new FolderAdoptionError("foreign-entry", entry);
  return entries;
}

// The top-level entries of a Folder with state that it neither owns nor
// tolerates, sorted: names only, nothing below them is listed. The change
// transaction and its recovery never read, write or move them, on a
// workstation and, since decision F10's addendum of 2026-11-03, in a hosted
// Folder too, where they no longer stop a refresh. A hosted Folder reports
// them instead (`lazurio update`, `update status`, `doctor`), because work
// products belong in `~/Documents/<task>/`. Adoption and initialization
// recovery keep refusing them by name: a new Folder holds only what its
// handover creates.
export async function foreignTopLevelEntries(
  folder: string,
): Promise<readonly string[]> {
  const known: readonly string[] = [...tolerated, ...owned];
  return Object.freeze(
    (await readdir(folder)).filter((entry) => !known.includes(entry)).sort(),
  );
}

// The entries a free Environment's Platform creates itself (root decision
// 0216), in creation order: the Folder, `organizations` and, where the preset
// has one, `personalspace`.
export type AssignedLayoutEntry = "." | "organizations" | "personalspace";

/**
 * Which of a free Environment's layout entries are missing, after every
 * rule adoption will apply to the layout has passed on what exists already,
 * so that creating the missing ones never ends in a refusal that leaves them
 * behind (`createAssignedFolderLayout` in src/machine/assignment.ts). Reads
 * only. A Folder that does not exist is missing whole. An existing one is
 * held to `ownedIdentity` first (never a link, a file, another account's
 * or a shared directory), then `adopted` decides: a Folder with state is
 * adopted already (nothing is missing for it) or another Machine's (that
 * refusal is thrown); otherwise its boundary (`requireFolderBoundary`, a
 * foreign entry by name), each existing layout directory by the same
 * `ownedIdentity` and filesystem, and the preset's Personalspace policy (a
 * used `personalspace` under `never` is `personalspace-conflict`, whether
 * or not that preset would create one) are checked as
 * `inspectHandoverLayout` and `requireAdoptableLayout` check them.
 */
export async function missingAssignedLayout(
  folder: string,
  personalspace: PersonalspacePolicy,
  adopted: () => Promise<unknown>,
): Promise<readonly AssignedLayoutEntry[]> {
  const created: readonly AssignedLayoutEntry[] =
    personalspace === "present"
      ? [".", "organizations", "personalspace"]
      : [".", "organizations"];
  if (!(await exists(folder))) return created;
  const root = await ownedIdentity(folder, ".");
  if ((await adopted()) !== null) return [];
  const entries = await requireFolderBoundary(folder);
  for (const entry of ["organizations", "personalspace"] as const) {
    if (!entries.includes(entry)) continue;
    const found = await ownedIdentity(join(folder, entry), entry);
    if (found.dev !== root.dev)
      throw new Error("Cross-filesystem handover layout");
  }
  if (
    personalspace === "never" &&
    entries.includes("personalspace") &&
    !(await isEmptyDirectory(join(folder, "personalspace")))
  )
    throw new FolderAdoptionError("personalspace-conflict", "personalspace");
  return created.filter((entry) => entry !== "." && !entries.includes(entry));
}

// Adoption rule. Work directories may be non-empty and are never traversed,
// listed beyond existence, moved or written. Any foreign top-level entry fails
// closed by name. A preset whose Personalspace policy is `never` tolerates an
// empty precreated personalspace/ and refuses a used one without touching it.
export async function requireAdoptableLayout(
  folder: string,
  personalspace: PersonalspacePolicy,
  claimed = false,
) {
  const entries = await requireFolderBoundary(folder, claimed);
  if (!entries.includes("organizations"))
    throw new FolderAdoptionError("layout-missing", "organizations");
  const hasPersonalspace = entries.includes("personalspace");
  if (personalspace === "present" && !hasPersonalspace)
    throw new FolderAdoptionError("layout-missing", "personalspace");
  if (
    personalspace === "never" &&
    hasPersonalspace &&
    !(await isEmptyDirectory(join(folder, "personalspace")))
  )
    throw new FolderAdoptionError("personalspace-conflict", "personalspace");
}
