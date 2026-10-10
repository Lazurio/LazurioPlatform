import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  link,
  lstat,
  open,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { resolveOnPath, type ToolRunner } from "../tools/status";
import { syncDirectory, writeDurableFile } from "../update/durable-file";
import {
  ensurePrivateDirectory,
  type GhWiring,
  isPlainAbsolutePath,
  type PilotPaths,
  type PilotWiring,
} from "./pilot";

// How gh and Git reach the pilot's sign-ins (decision F46), and how they are
// given back. `pilot wire`:
// - gh: the standard entry `~/.local/bin/gh` (decision 0161), which every
//   shell and service of the Environment finds first, becomes a small
//   launcher script that runs `lazurio github gh`. The official gh is kept
//   beside: a binary at the entry is linked (or copied) to the pilot's state
//   directory before the launcher replaces the entry in one rename, so gh is
//   there at every instant; a link at the entry is remembered; a gh found
//   elsewhere on PATH is used where it is.
// - Git: one include file, added to the user's global Git configuration,
//   resets the credential helpers for https://github.com to the pilot's
//   helper, has Git send the repository path (`useHttpPath`) and rewrites
//   `git@github.com:` and `ssh://git@github.com/` remotes to HTTPS, so no
//   account SSH key is used for GitHub.
// `pilot unwire` restores the entry as it was and removes the include. A
// launcher or include of the pilot carries `launcherMarker`; anything else
// at those places is never changed.

export const launcherMarker = "# lazurio-github-sign-in-pilot v1";

/** The `~/.local/bin/gh` of a wired pilot. */
export const launcherScript = (executable: string): string =>
  [
    "#!/bin/sh",
    `${launcherMarker}: gh with the Organization sign-in of this Environment (decision F46).`,
    "# Written by lazurio github pilot wire; lazurio github pilot unwire restores the official gh.",
    `exec '${executable}' github gh "$@"`,
    "",
  ].join("\n");

/** Git's helper command line (`!` runs it through the shell, Git appends the
 * action). */
export const helperCommand = (executable: string): string =>
  `!'${executable}' github credential`;

const gitValue = (value: string) =>
  `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** The pilot's Git include. */
export const gitIncludeText = (executable: string): string =>
  [
    `${launcherMarker}: Git for github.com through the Organization sign-in of this Environment (decision F46).`,
    "# Written by lazurio github pilot wire; lazurio github pilot unwire removes it.",
    '[credential "https://github.com"]',
    "\thelper =",
    `\thelper = ${gitValue(helperCommand(executable))}`,
    "\tuseHttpPath = true",
    '[url "https://github.com/"]',
    "\tinsteadOf = git@github.com:",
    "\tinsteadOf = ssh://git@github.com/",
    "",
  ].join("\n");

export type WiringHost = Readonly<{
  paths: PilotPaths;
  env: Readonly<Record<string, string | undefined>>;
  platform: string;
  run: ToolRunner;
}>;

// Git with only what selects the user's configuration.
const gitEnv = (
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> => {
  const result: Record<string, string> = { LANG: "C", LC_ALL: "C" };
  for (const name of [
    "HOME",
    "PATH",
    "XDG_CONFIG_HOME",
    "GIT_CONFIG_GLOBAL",
    "GIT_CONFIG_NOSYSTEM",
    "GIT_CONFIG_SYSTEM",
  ]) {
    const value = env[name];
    if (value !== undefined && value !== "") result[name] = value;
  }
  return result;
};

async function git(
  host: WiringHost,
  args: readonly string[],
): Promise<Readonly<{ exitCode: number; stdout: string }> | null> {
  const found = await resolveOnPath("git", host.env.PATH, host.platform);
  if (found === undefined) return null;
  const result = await host.run([found, ...args], 15_000, gitEnv(host.env));
  return result === "timeout"
    ? null
    : { exitCode: result.exitCode, stdout: result.stdout };
}

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    const entry = await lstat(await realpath(path));
    if (!entry.isFile()) return false;
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

const readText = (path: string) => readFile(path, "utf8").catch(() => null);

const isLauncherText = (text: string | null) =>
  text?.includes(launcherMarker) === true;

type EntryState =
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "launcher"; text: string }>
  | Readonly<{ kind: "file" }>
  | Readonly<{ kind: "link"; target: string }>
  | Readonly<{ kind: "other" }>;

async function inspectEntry(path: string): Promise<EntryState> {
  let entry: Awaited<ReturnType<typeof lstat>>;
  try {
    entry = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { kind: "absent" };
    return { kind: "other" };
  }
  if (entry.isSymbolicLink())
    return { kind: "link", target: await readlink(path) };
  if (!entry.isFile()) return { kind: "other" };
  // A launcher is a few hundred bytes; a binary is never read whole.
  if (entry.size < 4096) {
    const text = await readText(path);
    if (isLauncherText(text)) return { kind: "launcher", text: text as string };
  }
  return { kind: "file" };
}

/** Writes `content` as `path` in one rename, so the entry is never missing. */
async function placeAtomically(
  path: string,
  content: string | { link: string },
  mode = 0o755,
): Promise<void> {
  const temporary = join(
    dirname(path),
    `.gh.lazurio-${randomBytes(8).toString("hex")}`,
  );
  try {
    if (typeof content === "string") {
      const file = await open(temporary, "wx", mode);
      try {
        await file.writeFile(content);
        await file.sync();
      } finally {
        await file.close();
      }
      await chmod(temporary, mode);
    } else await symlink(content.link, temporary);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/** A copy on disk before anything relies on it: the file, then its
 * directory. */
async function copyDurably(from: string, to: string): Promise<void> {
  await copyFile(from, to);
  await chmod(to, 0o755);
  const file = await open(to, "r");
  try {
    await file.sync();
  } finally {
    await file.close();
  }
  await syncDirectory(dirname(to));
}

/** The kept binary back at the entry, in one rename (through a copy beside
 * the entry when the two are on different filesystems). */
async function restoreOfficial(saved: string, entry: string): Promise<void> {
  try {
    await rename(saved, entry);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
  }
  const temporary = join(
    dirname(entry),
    `.gh.lazurio-${randomBytes(8).toString("hex")}`,
  );
  try {
    await copyDurably(saved, temporary);
    await rename(temporary, entry);
    await syncDirectory(dirname(entry));
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  await rm(saved, { force: true });
}

/** The official binary at the entry, kept as `savedGh`: a hard link where
 * both are on one filesystem, else a copy. */
async function keepOfficial(entry: string, saved: string): Promise<void> {
  await rm(saved, { force: true });
  try {
    await link(entry, saved);
    await syncDirectory(dirname(saved));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    await copyDurably(entry, saved);
  }
}

/** The include file and its `include.path` in the user's global Git
 * configuration; false when Git cannot be asked or written. */
async function configureGit(
  host: WiringHost,
  executable: string,
): Promise<boolean> {
  const { paths } = host;
  await ensurePrivateDirectory(paths.configDirectory);
  await writeDurableFile(
    paths.configDirectory,
    "pilot.gitconfig",
    Buffer.from(gitIncludeText(executable)),
  );
  const included = await git(host, [
    "config",
    "--global",
    "--get-all",
    "include.path",
  ]);
  if (included === null) return false;
  if (included.stdout.split("\n").includes(paths.gitInclude)) return true;
  const added = await git(host, [
    "config",
    "--global",
    "--add",
    "include.path",
    paths.gitInclude,
  ]);
  return added !== null && added.exitCode === 0;
}

export type WireRefusal =
  /** The Lazurio executable cannot be named in a shell line, or is not a
   * file that runs (a source checkout run by Bun is not one). */
  | "executable-unsupported"
  | "git-missing"
  /** No official gh: install it first (`lazurio tools install gh`). */
  | "gh-missing"
  /** Something at `~/.local/bin/gh` the pilot does not replace. */
  | "gh-entry-unsupported"
  /** After the change, PATH would still find another gh first. */
  | "gh-not-first"
  | "git-config-failed";

export type WireOutcome =
  | Readonly<{ kind: "wired"; wiring: PilotWiring; repaired: boolean }>
  /** `repair`: a wiring was there; it was left as it is. Otherwise nothing
   * of the pilot's is left in place. */
  | Readonly<{ kind: "blocked"; reason: WireRefusal; repair: boolean }>;

/** Wires gh and Git to the pilot, or repairs a wiring (`current`): the record
 * is written by `record` before the entry changes, so `unwire` always knows
 * what to restore. */
export async function wire(
  host: WiringHost,
  input: Readonly<{
    executable: string;
    current: PilotWiring | null;
    now: () => number;
    record: (wiring: PilotWiring | null) => Promise<void>;
  }>,
): Promise<WireOutcome> {
  const { paths } = host;
  const blocked = (reason: WireRefusal): WireOutcome =>
    Object.freeze({ kind: "blocked", reason, repair: input.current !== null });
  if (
    !isPlainAbsolutePath(input.executable) ||
    !(await isExecutableFile(input.executable))
  )
    return blocked("executable-unsupported");
  if ((await resolveOnPath("git", host.env.PATH, host.platform)) === undefined)
    return blocked("git-missing");

  const entry = await inspectEntry(paths.ghEntry);
  let gh: GhWiring;
  let saveOfficial = false;
  switch (entry.kind) {
    case "launcher":
      if (input.current !== null) gh = input.current.gh;
      else if (await isExecutableFile(paths.savedGh))
        // A wiring interrupted before its record: the binary was kept.
        gh = { previous: "file", real: paths.savedGh };
      else return blocked("gh-entry-unsupported");
      // A repair never keeps a gh that is gone (an upgrade removed it).
      if (!(await isExecutableFile(gh.real))) return blocked("gh-missing");
      break;
    case "file":
      gh = { previous: "file", real: paths.savedGh };
      saveOfficial = true;
      break;
    case "link": {
      // The link's own target, not where it finally leads: a package
      // manager's versioned path behind it changes with every upgrade.
      const real = resolve(dirname(paths.ghEntry), entry.target);
      if (!(await isExecutableFile(real))) return blocked("gh-missing");
      if (
        !isPlainAbsolutePath(real) ||
        isLauncherText(
          (await lstat(await realpath(real))).size < 4096
            ? await readText(real)
            : null,
        )
      )
        return blocked("gh-entry-unsupported");
      gh = { previous: "link", real, target: entry.target };
      break;
    }
    case "absent": {
      const real = await resolveOnPath("gh", host.env.PATH, host.platform);
      if (real === undefined) return blocked("gh-missing");
      if (!isPlainAbsolutePath(real) || isLauncherText(await readText(real)))
        return blocked("gh-entry-unsupported");
      gh = { previous: "absent", real };
      break;
    }
    case "other":
      return blocked("gh-entry-unsupported");
  }

  if (saveOfficial) {
    await ensurePrivateDirectory(paths.stateDirectory);
    await keepOfficial(paths.ghEntry, paths.savedGh);
  }
  const wiring: PilotWiring = Object.freeze({
    executable: input.executable,
    gh,
    wiredAt: input.current?.wiredAt ?? new Date(input.now()).toISOString(),
  });
  // The record first: whatever happens next, unwire knows what to restore.
  await input.record(wiring);
  // A first wiring that fails is undone, record included; a repair that
  // fails leaves the wiring as it was (status names what is still missing),
  // never tearing down one that works.
  const rollBack = async () => {
    if (input.current !== null) return;
    await unwire(host, wiring);
    await input.record(null);
  };
  try {
    if (!(await configureGit(host, input.executable))) {
      await rollBack();
      return blocked("git-config-failed");
    }
    await placeAtomically(paths.ghEntry, launcherScript(input.executable));
    const first = await resolveOnPath("gh", host.env.PATH, host.platform);
    if (first !== paths.ghEntry) {
      await rollBack();
      return blocked("gh-not-first");
    }
  } catch (error) {
    await rollBack().catch(() => undefined);
    throw error;
  }
  return Object.freeze({
    kind: "wired",
    wiring,
    repaired: input.current !== null,
  });
}

export type UnwireOutcome = Readonly<{
  kind: "unwired";
  /** What `~/.local/bin/gh` is now:
   * - `restored`: the official gh or its link is back;
   * - `removed`: the launcher is gone, gh is found where it was;
   * - `left`: the entry is not the pilot's launcher any more (replaced
   *   since), so it stays;
   * - `not-restored`: the kept binary is gone; the launcher was removed and
   *   gh needs `lazurio tools install gh`. */
  gh: "restored" | "removed" | "left" | "not-restored";
  git: "removed" | "failed";
}>;

/** Gives gh and Git back as `pilot wire` found them. Safe to repeat. */
export async function unwire(
  host: WiringHost,
  wiring: PilotWiring,
): Promise<UnwireOutcome> {
  const { paths } = host;
  let ghState: UnwireOutcome["gh"];
  const entry = await inspectEntry(paths.ghEntry);
  const restore = async (): Promise<UnwireOutcome["gh"]> => {
    switch (wiring.gh.previous) {
      case "file":
        if (!(await isExecutableFile(paths.savedGh))) {
          await rm(paths.ghEntry, { force: true });
          return "not-restored";
        }
        await restoreOfficial(paths.savedGh, paths.ghEntry);
        return "restored";
      case "link":
        await placeAtomically(paths.ghEntry, { link: wiring.gh.target });
        return "restored";
      case "absent":
        await rm(paths.ghEntry, { force: true });
        return "removed";
    }
  };
  if (entry.kind === "launcher" || entry.kind === "absent")
    ghState = await restore();
  else {
    ghState = "left";
    // The entry was replaced since (a new gh): the kept one is stale.
    if (wiring.gh.previous === "file") await rm(paths.savedGh, { force: true });
  }

  const gitState = (await removeInclude(host)) ? "removed" : "failed";
  if (gitState === "removed") await rm(paths.gitInclude, { force: true });
  return Object.freeze({ kind: "unwired", gh: ghState, git: gitState });
}

/** Undoes what a wiring without its record left (an interrupted wire, a
 * switch removed by hand): the include and its `include.path`, and a
 * launcher of the pilot at the entry, given back the kept official gh. Safe
 * where nothing is left; runs also while the pilot is off. */
export async function unwireLeftovers(host: WiringHost): Promise<
  Readonly<{
    gh: "restored" | "left" | "none";
    git: "removed" | "failed" | "none";
  }>
> {
  const { paths } = host;
  let gh: "restored" | "left" | "none" = "none";
  const entry = await inspectEntry(paths.ghEntry);
  if (entry.kind === "launcher") {
    if (await isExecutableFile(paths.savedGh)) {
      await restoreOfficial(paths.savedGh, paths.ghEntry);
      gh = "restored";
    } else gh = "left";
  }
  const included = await git(host, [
    "config",
    "--global",
    "--get-all",
    "include.path",
  ]);
  const listed =
    included?.stdout.split("\n").includes(paths.gitInclude) === true;
  const file = (await readText(paths.gitInclude)) !== null;
  if (!listed && !file) return Object.freeze({ gh, git: "none" });
  if (listed && !(await removeInclude(host)))
    return Object.freeze({ gh, git: "failed" });
  await rm(paths.gitInclude, { force: true });
  return Object.freeze({ gh, git: "removed" });
}

/** `include.path` of the pilot's include, removed from the global Git
 * configuration; true when it is not there afterwards. */
async function removeInclude(host: WiringHost): Promise<boolean> {
  const escaped = host.paths.gitInclude.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const unset = await git(host, [
    "config",
    "--global",
    "--unset-all",
    "include.path",
    `^${escaped}$`,
  ]);
  // 5: the value was not there, which is the goal.
  return unset !== null && (unset.exitCode === 0 || unset.exitCode === 5);
}

export type WiringHealth = Readonly<{
  gh: "ok" | "broken";
  git: "ok" | "broken";
}>;

/** Whether the wiring is still what `pilot wire` left. */
export async function inspectWiring(
  host: WiringHost,
  wiring: PilotWiring,
): Promise<WiringHealth> {
  const { paths } = host;
  const entry = await inspectEntry(paths.ghEntry);
  const gh =
    entry.kind === "launcher" &&
    entry.text === launcherScript(wiring.executable) &&
    (await isExecutableFile(wiring.gh.real))
      ? "ok"
      : "broken";
  const included = await git(host, [
    "config",
    "--global",
    "--get-all",
    "include.path",
  ]);
  const gitOk =
    included !== null &&
    included.exitCode === 0 &&
    included.stdout.split("\n").includes(paths.gitInclude) &&
    (await readText(paths.gitInclude)) === gitIncludeText(wiring.executable);
  return Object.freeze({ gh, git: gitOk ? "ok" : "broken" });
}

/** The credential helpers Git consults for a github.com repository, as the
 * user's global configuration (with its includes) composes them: each
 * `credential.helper` and `credential.<github.com URL>.helper` in order, an
 * empty value resetting the list. The system configuration comes before it
 * and is reset by the pilot's include; a repository's own configuration is
 * not read. Null when Git cannot be asked. */
export async function githubCredentialHelpers(
  host: WiringHost,
): Promise<readonly string[] | null> {
  const result = await git(host, [
    "config",
    "--global",
    "--includes",
    "-z",
    "--get-regexp",
    "^credential\\..*helper$",
  ]);
  if (result === null) return null;
  // 1: no such key at all.
  if (result.exitCode === 1) return [];
  if (result.exitCode !== 0) return null;
  const helpers: string[] = [];
  for (const record of result.stdout.split("\0")) {
    if (record === "") continue;
    const newline = record.indexOf("\n");
    const key = (
      newline === -1 ? record : record.slice(0, newline)
    ).toLowerCase();
    const value = newline === -1 ? "" : record.slice(newline + 1);
    const url = key.slice("credential.".length, -".helper".length);
    if (key !== "credential.helper" && !githubUrlPattern(url)) continue;
    if (value === "") helpers.length = 0;
    else helpers.push(value);
  }
  return Object.freeze(helpers);
}

const githubUrlPattern = (pattern: string) => {
  try {
    const url = new URL(
      pattern.includes("://") ? pattern : `https://${pattern}`,
    );
    return (
      url.protocol === "https:" && url.hostname.toLowerCase() === "github.com"
    );
  } catch {
    return false;
  }
};
