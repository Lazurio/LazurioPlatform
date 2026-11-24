import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { githubRemoteCoordinate } from "../providers/git-checkout";
import { ORGANIZATION_FILES } from "./runtime";

// The Organization root's files an App declares (`organization_files` of
// lazurio.runtime.v1; decision 0249, addendum of 2026-11-22, point 14; H20),
// in DEV and STAGING as the application host hands them in PROD: the declared
// canonical manifests as committed at the root checkout's HEAD, and
// `revision.json` naming that commit, never the Organization's checkout, so
// the App reads in an Environment no more than on the host.
//
// Each App has its own place, keyed by the Organization checkout, the Module
// and the App's package, so two Apps with the same id never share a copy.
// The place holds versions and a link `current` to one of them, which is what
// LAZURIO_ORGANIZATION_FILES_DIR names. A new copy is written as a new
// version and the link is replaced by one rename, so the path always resolves
// to a whole copy; a failure before that rename leaves the previous copy in
// place. The version before stays until the next copy, for a reader that
// resolved the link just before the switch.
//
// One limit is accepted (Anna 2026-11-23, #1211): on macOS an open through
// the path while the link is being replaced can fail with EINVAL, and a
// reader tries that open again. The path still never resolves to a missing
// or partial copy.
//
// The App runs under the same account, so the Platform cannot keep it from
// changing its own files on purpose; on the application host a separate
// account owns the copy. Here the place, each version and each file are
// read-only (0555 and 0444): writing, replacing or deleting a file of the copy
// is refused, and the copy is made again before every start.
//
// A declared file the root's HEAD does not have, or has as no regular file (a
// link included), is left out of the copy and of `revision.json`. Where the
// root is not itself a Git checkout with a GitHub remote, the copy is empty
// and has no `revision.json`, as on the host when its first fetch failed.

/** The schema of `revision.json`, as the application host writes it. */
export const ORGANIZATION_FILES_SCHEMA = "lazurio.organization-files.v1";

const READ_ONLY_DIRECTORY = 0o555;
const WRITABLE_DIRECTORY = 0o700;

/** An App's place, outside every checkout, below the account's Lazurio
 * state: per Organization, then a key of the Organization checkout, the
 * Module and the App's package, with the App id for a person reading it. */
export function organizationFilesPlace(input: {
  home: string;
  company: string;
  appId: string;
  organizationRoot: string;
  moduleDirectory: string;
  appPackage: string;
}): string {
  if (!input.home.startsWith("/"))
    throw new Error("Explicit account home required");
  const key = createHash("sha256")
    .update(
      [input.organizationRoot, input.moduleDirectory, input.appPackage].join(
        "\0",
      ),
    )
    .digest("hex")
    .slice(0, 16);
  return join(
    input.home,
    ".local/state/lazurio/organization-files",
    input.company,
    `${input.appId}-${key}`,
  );
}

/** The path an App gets as LAZURIO_ORGANIZATION_FILES_DIR. */
export function organizationFilesDirectory(place: string): string {
  return join(place, "current");
}

function git(cwd: string, args: string[]) {
  const result = spawnSync("git", args, {
    cwd,
    timeout: 20_000,
    maxBuffer: 16 * 1024 * 1024,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      LC_ALL: "C",
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  });
  return result.status === 0 && Buffer.isBuffer(result.stdout)
    ? result.stdout
    : null;
}

/** The declared files as committed at the root's HEAD, with that commit and
 * the root's GitHub repository; null where the root is not itself the top of
 * a Git checkout (Git would otherwise find a checkout above it), has no
 * GitHub remote, or its HEAD cannot be read. */
async function committedFiles(root: string, files: readonly string[]) {
  const top = git(root, ["rev-parse", "--show-toplevel"])
    ?.toString("utf8")
    .trim();
  const resolved = await realpath(root).catch(() => null);
  if (!top || resolved === null) return null;
  if ((await realpath(top).catch(() => null)) !== resolved) return null;
  const commit = git(root, ["rev-parse", "--verify", "HEAD^{commit}"])
    ?.toString("utf8")
    .trim();
  const remote = git(root, ["config", "--get", "remote.origin.url"])
    ?.toString("utf8")
    .trim();
  const repository = remote ? githubRemoteCoordinate(remote) : null;
  if (!commit || !/^[0-9a-f]{40}$/.test(commit) || repository === null)
    return null;
  const listing = git(root, ["ls-tree", "-z", commit, "--", ...files]);
  if (listing === null) return null;
  const contents = new Map<string, Buffer>();
  for (const entry of listing.toString("utf8").split("\0")) {
    // `<mode> <type> <object>\t<path>`; only a regular file counts.
    const match = /^(100644|100755) blob ([0-9a-f]{40})\t(.+)$/.exec(entry);
    if (!match || !files.includes(match[3] as string)) continue;
    const blob = git(root, ["cat-file", "blob", match[2] as string]);
    if (blob === null) return null;
    contents.set(match[3] as string, blob);
  }
  return { commit, repository, contents };
}

async function removeVersion(path: string) {
  await chmod(path, WRITABLE_DIRECTORY).catch(() => undefined);
  await rm(path, { recursive: true, force: true });
}

export async function provideOrganizationFiles(input: {
  organizationRoot: string;
  /** The App's place (`organizationFilesPlace`). */
  place: string;
  files: readonly string[];
  /** The time of this copy; the current time by default. */
  now?: () => Date;
  /** Runs after the new version is written and before the switch; for a
   * test of a failure there. */
  beforeSwitch?: () => Promise<void>;
}): Promise<string> {
  for (const file of input.files)
    if (!(ORGANIZATION_FILES as readonly string[]).includes(file))
      throw new Error("Undeclarable organization file");
  const { place } = input;
  const current = organizationFilesDirectory(place);
  await mkdir(place, { recursive: true, mode: WRITABLE_DIRECTORY });
  await chmod(place, WRITABLE_DIRECTORY);
  try {
    const before = await readlink(current).catch(() => null);
    const time = input.now?.() ?? new Date();
    const name = `v-${time.getTime()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    const version = join(place, name);
    await mkdir(version, { mode: WRITABLE_DIRECTORY });
    const committed = await committedFiles(input.organizationRoot, input.files);
    if (committed !== null) {
      // In the declared order, as the host lists them.
      const present = input.files.filter((file) =>
        committed.contents.has(file),
      );
      for (const file of present)
        await writeFile(
          join(version, file),
          committed.contents.get(file) as Buffer,
          { mode: 0o444 },
        );
      await writeFile(
        join(version, "revision.json"),
        `${JSON.stringify(
          {
            schema_version: ORGANIZATION_FILES_SCHEMA,
            repository: committed.repository,
            commit: committed.commit,
            fetched_at: time.toISOString().replace(/\.\d{3}Z$/, "Z"),
            files: present,
          },
          null,
          2,
        )}\n`,
        { mode: 0o444 },
      );
    }
    await chmod(version, READ_ONLY_DIRECTORY);
    await input.beforeSwitch?.();
    // One rename replaces the link: the path resolves to the old copy or the
    // new one, never to nothing.
    const link = join(place, `current.${name}`);
    await symlink(name, link);
    await rename(link, current);
    // Keep the new version and the one before; anything else is left over.
    for (const entry of await readdir(place)) {
      if (entry === "current" || entry === name || entry === before) continue;
      // A link a failed switch left is removed as a link, never followed.
      if (entry.startsWith("current."))
        await rm(join(place, entry), { force: true });
      else await removeVersion(join(place, entry));
    }
    return current;
  } finally {
    await chmod(place, READ_ONLY_DIRECTORY);
  }
}
