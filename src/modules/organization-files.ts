import { spawnSync } from "node:child_process";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { githubRemoteCoordinate } from "../providers/git-checkout";
import { ORGANIZATION_FILES } from "./runtime";

// The Organization root's files an App declares (`organization_files` of
// lazurio.runtime.v1; decision 0249, addendum of 2026-11-22, point 14; H20),
// in DEV and STAGING as the application host hands them in PROD: a directory
// with the declared canonical manifests as committed at the root checkout's
// HEAD, and `revision.json` naming that commit, never the Organization's
// checkout, so the App reads in an Environment no more than on the host. The
// copy is made again before every start and replaces the previous one as a
// whole directory, so the App never sees half of it. A declared file the
// root's HEAD does not have, or has as no regular file (a link included), is
// left out of the copy and of `revision.json`. Where the root is no Git
// checkout with a GitHub remote, the directory stays empty: the App starts
// and says the Organization's manifests are not available, as on the host
// when the first fetch failed. The App's process gets the directory as
// LAZURIO_ORGANIZATION_FILES_DIR.

/** The schema of `revision.json`, as the application host writes it. */
export const ORGANIZATION_FILES_SCHEMA = "lazurio.organization-files.v1";

/** Where an App's copy lives: outside every checkout, per Organization and
 * App id, below the account's Lazurio state. */
export function organizationFilesDirectory(
  home: string,
  company: string,
  appId: string,
): string {
  if (!home.startsWith("/")) throw new Error("Explicit account home required");
  return join(home, ".local/state/lazurio/organization-files", company, appId);
}

function git(root: string, args: string[]) {
  const result = spawnSync("git", args, {
    cwd: root,
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
 * the root's GitHub repository; null where the root is no Git checkout with a
 * GitHub remote or its HEAD cannot be read. */
function committedFiles(root: string, files: readonly string[]) {
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

export async function provideOrganizationFiles(input: {
  organizationRoot: string;
  directory: string;
  files: readonly string[];
  /** The time of this copy; the current time by default. */
  now?: () => Date;
}): Promise<string> {
  for (const file of input.files)
    if (!(ORGANIZATION_FILES as readonly string[]).includes(file))
      throw new Error("Undeclarable organization file");
  const { directory } = input;
  await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
  const next = `${directory}.next-${process.pid}`;
  const previous = `${directory}.previous-${process.pid}`;
  await rm(next, { recursive: true, force: true });
  await mkdir(next, { mode: 0o700 });
  const committed = committedFiles(input.organizationRoot, input.files);
  if (committed !== null) {
    // In the declared order, as the host lists them.
    const present = input.files.filter((file) => committed.contents.has(file));
    for (const file of present)
      await writeFile(
        join(next, file),
        committed.contents.get(file) as Buffer,
        { mode: 0o400 },
      );
    await writeFile(
      join(next, "revision.json"),
      `${JSON.stringify(
        {
          schema_version: ORGANIZATION_FILES_SCHEMA,
          repository: committed.repository,
          commit: committed.commit,
          fetched_at: (input.now?.() ?? new Date())
            .toISOString()
            .replace(/\.\d{3}Z$/, "Z"),
          files: present,
        },
        null,
        2,
      )}\n`,
      { mode: 0o400 },
    );
  }
  // Replace the whole directory: the App reads the old copy or the new one.
  await rm(previous, { recursive: true, force: true });
  await rename(directory, previous).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
  await rename(next, directory);
  await rm(previous, { recursive: true, force: true });
  return directory;
}
