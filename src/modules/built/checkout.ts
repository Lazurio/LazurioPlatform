import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";

// What a build reads of a checkout (decision F58): its commit, branch and
// whether it has changes that are not committed, through the operator's git
// with a closed environment (no global or system configuration, no prompt,
// no optional locks), read-only and bounded, as the other checkout readers.

export type CheckoutHead = Readonly<{
  commit: string;
  /** The branch it is on; null when detached. */
  branch: string | null;
  /** Tracked or untracked changes that are not committed (ignored files,
   * such as `node_modules` and the build output, are not changes). */
  dirty: boolean;
  /** The repository's git directory, whose `HEAD` and refs change with a
   * pull (watched by the Launchpad, decision F58). */
  gitDirectory: string;
}>;

/** Reads a checkout; with `dirty: false` the status is not asked (the
 * watcher's read). */
export type ReadCheckout = (
  directory: string,
  options?: Readonly<{ status?: boolean }>,
) => Promise<CheckoutHead | null>;

export function gitCheckoutReader(git: () => Promise<string | undefined>) {
  const run = (executable: string, directory: string, args: string[]) =>
    new Promise<string | null>((resolve) => {
      execFile(
        executable,
        ["-C", directory, ...args],
        {
          env: {
            PATH: "/usr/bin:/bin",
            LC_ALL: "C",
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_OPTIONAL_LOCKS: "0",
            GIT_TERMINAL_PROMPT: "0",
          },
          timeout: 10_000,
          killSignal: "SIGKILL",
          maxBuffer: 1024 * 1024,
          encoding: "utf8",
        },
        (error, stdout) => resolve(error ? null : stdout),
      );
    });
  const read: ReadCheckout = async (directory, options = {}) => {
    const executable = await git();
    if (executable === undefined || !isAbsolute(executable)) return null;
    const paths = await run(executable, directory, [
      "rev-parse",
      "--verify",
      "--absolute-git-dir",
      "HEAD^{commit}",
    ]);
    const [gitDirectory, commit] = paths?.trim().split("\n") ?? [];
    if (
      gitDirectory === undefined ||
      !isAbsolute(gitDirectory) ||
      commit === undefined ||
      !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(commit)
    )
      return null;
    const branch = await run(executable, directory, [
      "symbolic-ref",
      "--quiet",
      "--short",
      "HEAD",
    ]);
    let dirty = false;
    if (options.status !== false) {
      const status = await run(executable, directory, [
        "status",
        "--porcelain=v1",
        "--untracked-files=normal",
        "--ignore-submodules=all",
      ]);
      if (status === null) return null;
      dirty = status.trim() !== "";
    }
    return Object.freeze({
      commit,
      branch: branch === null ? null : branch.trim() || null,
      dirty,
      gitDirectory,
    });
  };
  return read;
}
