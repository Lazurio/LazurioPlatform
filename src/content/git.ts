import { lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { inspectGitCheckout } from "../providers/git-checkout";
import type { ToolRunner } from "../tools/status";
import { resolveOnPath } from "../tools/status";
import { type CommitIdentity, identitySettings } from "./commit-identity";
import { repositoryPattern } from "./model";

// Git for content installation: the operator's own `git` from the
// operator's PATH, with the operator's home and Git configuration, because a
// clone is the operator's act under the operator's sign-in (SSH key or gh as
// credential helper). A public Environment's anonymous clone is the one
// exception: it runs the same git with none of that (`anonymousGitEnvironment`).
// Only the clone runs here; the verification reads the
// result through the existing read-only checkout inspection.

export type CloneRequest = Readonly<{
  url: string;
  directory: string;
  /** The branch to check out: `main`, or a repository database's declared
   * branch (`isBranchName`). */
  branch: string;
  /** Git's `credential.helper` for github.com over HTTPS: gh's; or `""` for
   * an anonymous clone (a public Environment's read, `anonymousGitHub`),
   * which runs isolated from every configuration, credential and helper of
   * the operator and of this process, and only for exactly
   * `https://github.com/<owner>/<repository>.git`. Absent: the operator's
   * configuration as it is. */
  credentialHelper?: string | undefined;
}>;

export type CheckoutObservation =
  | Readonly<{
      kind: "checkout";
      /** `<owner>/<name>` of `remote.origin.url`. */
      repository: string;
      branch: string | null;
      commit: string;
    }>
  | Readonly<{ kind: "not-checkout" }>;

/** The checkout a directory belongs to, as Git names it (absolute paths). In
 * a linked worktree `gitDir` is its own directory below `commonDir`; in a
 * primary checkout the two are the same. */
export type WorktreeObservation = Readonly<{
  top: string;
  gitDir: string;
  commonDir: string;
  /** The checked-out branch, or null on a detached HEAD. */
  branch: string | null;
}>;

export type ContentGit = Readonly<{
  clone(request: CloneRequest): Promise<"cloned" | "failed">;
  inspect(directory: string): Promise<CheckoutObservation>;
  /** The checkout `directory` belongs to, or null where it is none. */
  worktree(directory: string): Promise<WorktreeObservation | null>;
  /** Whether Git ignores `path` (relative to `directory`, the top of a
   * checkout): a tracked path never is. Null when Git could not answer. */
  ignored(directory: string, path: string): Promise<boolean | null>;
  /** Makes `directory` a new repository whose `main` holds one commit of
   * everything in it, by the operator's own Git identity (decision F52), or
   * where git has none, by `fallback` (the person's GitHub identity, given
   * per commit, never configured). Git's last error line when it fails. */
  commitAll(
    directory: string,
    message: string,
    fallback?: CommitIdentity | undefined,
  ): Promise<Readonly<{ ok: true }> | Readonly<{ ok: false; detail: string }>>;
  /** Points the `origin` of the repository `directory` at `url` and pushes
   * its `main` there, with gh as the credential helper of an HTTPS remote as
   * the clone has it. */
  push(
    directory: string,
    remote: Readonly<{ url: string; credentialHelper?: string | undefined }>,
  ): Promise<Readonly<{ ok: true }> | Readonly<{ ok: false; detail: string }>>;
  /** Synchronization of a present primary checkout (docs/content-sync.md,
   * "Existing repositories"): whether its tracked or untracked files differ
   * from `HEAD`, and whether Git has an operation under way in `gitDir`
   * (merge, rebase, cherry-pick, revert, bisect, am). Null when Git could
   * not answer. Reads only, without Git's optional index refresh. */
  changes(
    directory: string,
    gitDir: string,
  ): Promise<Readonly<{ dirty: boolean; operation: boolean }> | null>;
  /** The commit `branch` has on the remote, by one `ls-remote` of that ref. */
  remoteHead(
    directory: string,
    remote: SyncRemote,
    branch: string,
    timeoutMs: number,
  ): Promise<RemoteAnswer>;
  /** Fetches `branch` into `refs/remotes/origin/<branch>` and answers the
   * commit it holds after the fetch. */
  fetchBranch(
    directory: string,
    remote: SyncRemote,
    branch: string,
    timeoutMs: number,
  ): Promise<RemoteAnswer>;
  /** How `remote` relates to `local` in this checkout: `behind` when local
   * is a strict ancestor; null when `remote` is not here (not fetched yet). */
  relation(
    directory: string,
    local: string,
    remote: string,
  ): Promise<"equal" | "behind" | "ahead" | "diverged" | null>;
  /** Fast-forwards the checked-out branch to `commit`; never a merge, a
   * stash, a hook or a reset. Whether `HEAD` is `commit` afterwards. */
  fastForward(directory: string, commit: string): Promise<boolean>;
}>;

/** Where a synchronization reads a present checkout's remote:
 * `configured`, its `origin` with git's configuration as it is (a Team
 * Environment, whose helper the hosting points at the broker); `account`,
 * its `origin` with gh as github.com's HTTPS helper when there is one, as a
 * clone has it; `anonymous`, exactly `https://github.com/<repository>.git`
 * isolated from every configuration and credential (a public Environment). */
export type SyncRemote =
  | Readonly<{ kind: "configured" }>
  | Readonly<{ kind: "account"; credentialHelper?: string | undefined }>
  | Readonly<{ kind: "anonymous"; repository: string }>;

export type RemoteAnswer =
  | Readonly<{ kind: "commit"; commit: string }>
  | Readonly<{ kind: "missing" }>
  | Readonly<{ kind: "denied" }>
  | Readonly<{ kind: "unavailable" }>
  | Readonly<{ kind: "failed" }>;

/** The process environment git runs with: the operator's PATH, home and XDG
 * directories, plus what an operator's Git and SSH setup legitimately takes
 * from the environment (the agent socket, an SSH command, configuration
 * given through `GIT_CONFIG_*`). Never a token. */
export type GitEnvironment = Readonly<{
  path: string | undefined;
  home: string | undefined;
  platform: string;
  run: ToolRunner;
  env: Readonly<Record<string, string>>;
  /** Test seam: the origin, exactly `http://127.0.0.1:<port>`, of a local
   * server that stands in for github.com for an anonymous clone, given to
   * that clone alone as one `url.<origin>/.insteadOf=https://github.com/`
   * with HTTP allowed. The product never sets it. */
  anonymousOrigin?: string | undefined;
}>;

/** A branch name a clone may be asked for: a declared branch such as `main`
 * or `v3`, never an option, a range or a path that climbs. */
export const isBranchName = (branch: string) =>
  /^[A-Za-z0-9_][A-Za-z0-9._/-]{0,99}$/.test(branch) &&
  !branch.includes("..") &&
  !branch.includes("//") &&
  !branch.endsWith("/") &&
  !branch.endsWith(".") &&
  !branch.endsWith(".lock");

/** The repository of exactly `https://github.com/<owner>/<repository>.git`,
 * the one URL an anonymous clone may have, or null for anything else (another
 * scheme or host, credentials, a query, a fragment, a missing `.git`). */
export function anonymousCloneTarget(url: string): string | null {
  const match = /^https:\/\/github\.com\/([^/?#@\s]+\/[^/?#@\s]+)\.git$/.exec(
    url,
  );
  const repository = match?.[1];
  return repository !== undefined &&
    repositoryPattern.test(repository) &&
    !/\/\.{1,2}$/.test(repository)
    ? repository
    : null;
}

/** The whole environment of an anonymous clone (decision F55's addendum of
 * 2026-10-17, review of #472): only PATH, a locale and an empty temporary
 * home. No system, global or XDG configuration and nothing injected through
 * the environment (`GIT_CONFIG_*`, `GIT_CONFIG_PARAMETERS`), so no
 * `http.extraHeader`, credential helper, `insteadOf` rewrite or
 * `core.sshCommand` of anyone reaches it; no prompt, askpass or SSH helper;
 * HTTPS the only protocol. The process runs with exactly this environment
 * (the tool runner inherits nothing). */
export function anonymousGitEnvironment(
  path: string | undefined,
  home: string,
): Record<string, string> {
  return {
    ...(path ? { PATH: path } : {}),
    HOME: home,
    XDG_CONFIG_HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CEILING_DIRECTORIES: dirname(home),
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
    SSH_ASKPASS: "",
    GCM_INTERACTIVE: "never",
    GIT_ALLOW_PROTOCOL: "https",
    LC_ALL: "C",
  };
}

const testOrigin = /^http:\/\/127\.0\.0\.1:[0-9]{1,5}$/;

const passed =
  /^(SSH_AUTH_SOCK|GIT_SSH|GIT_SSH_COMMAND|GIT_CONFIG_GLOBAL|GIT_CONFIG_NOSYSTEM|GIT_CONFIG_COUNT|GIT_CONFIG_KEY_[0-9]+|GIT_CONFIG_VALUE_[0-9]+|XDG_CONFIG_HOME)$/;

/** The part of a process environment git is given. */
export function gitEnvironmentOf(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const value: Record<string, string> = {};
  for (const [name, entry] of Object.entries(env))
    if (entry !== undefined && passed.test(name)) value[name] = entry;
  return value;
}

/** What Git leaves in a Git directory while an operation is under way. */
const operationMarkers = [
  "MERGE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "BISECT_LOG",
  "rebase-merge",
  "rebase-apply",
  "sequencer",
];
const present = () => true;
const absent = (error: NodeJS.ErrnoException) => {
  if (error?.code === "ENOENT") return false;
  throw error;
};

/** A failed `ls-remote` or `fetch` by Git's own words (`LC_ALL=C`): the
 * provider refused this identity (`denied`), the network or the provider did
 * not answer (`unavailable`), or anything else (`failed`). */
export function classifyNetworkFailure(
  output: string,
): Readonly<{ kind: "denied" | "unavailable" | "failed" }> {
  if (
    /Repository not found|does not appear to be a git repository|Permission denied|Authentication failed|could not read Username|could not read Password|terminal prompts disabled|returned error: 40[134]|access denied|not authorized/i.test(
      output,
    )
  )
    return { kind: "denied" };
  if (
    /Could not resolve host|Connection timed out|Operation timed out|Connection refused|Network is unreachable|No route to host|Connection reset|unable to access|early EOF|remote end hung up|returned error: 5[0-9][0-9]|Temporary failure/i.test(
      output,
    )
  )
    return { kind: "unavailable" };
  return { kind: "failed" };
}

const cloneTimeoutMs = 600_000;
const inspectTimeoutMs = 10_000;
const commitTimeoutMs = 60_000;

export function processContentGit(environment: GitEnvironment): ContentGit {
  let located: Promise<string | undefined> | undefined;
  const git = () => {
    located ??= resolveOnPath("git", environment.path, environment.platform);
    return located;
  };
  const env = () => ({
    ...environment.env,
    ...(environment.home ? { HOME: environment.home } : {}),
    ...(environment.path ? { PATH: environment.path } : {}),
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
    LC_ALL: "C",
  });
  const read = async (directory: string, args: readonly string[]) => {
    const executable = await git();
    if (executable === undefined) return null;
    const result = await environment.run(
      [executable, "-C", directory, ...args],
      inspectTimeoutMs,
      env(),
    );
    return result !== "timeout" && result.exitCode === 0
      ? result.stdout.replace(/\n$/, "")
      : null;
  };
  // Only for github.com over HTTPS: reset the list, then gh.
  const helperOf = (credentialHelper: string | undefined) =>
    credentialHelper === undefined
      ? []
      : [
          "-c",
          "credential.https://github.com.helper=",
          "-c",
          `credential.https://github.com.helper=${credentialHelper}`,
        ];
  // A public Environment's anonymous clone: refused before any process for
  // anything but exactly `https://github.com/<owner>/<repository>.git`, then
  // run from an empty temporary home with `anonymousGitEnvironment` and
  // nothing else; the empty `credential.helper` stays as a second fence.
  const anonymousClone = async (
    executable: string,
    request: CloneRequest,
  ): Promise<"cloned" | "failed"> => {
    const seam = environment.anonymousOrigin;
    if (
      anonymousCloneTarget(request.url) === null ||
      (seam !== undefined && !testOrigin.test(seam))
    )
      return "failed";
    let home: string;
    try {
      home = await mkdtemp(join(tmpdir(), "lazurio-anonymous-git-"));
    } catch {
      return "failed";
    }
    try {
      const result = await environment.run(
        [
          executable,
          "-C",
          home,
          "-c",
          "credential.helper=",
          ...(seam === undefined
            ? []
            : ["-c", `url.${seam}/.insteadOf=https://github.com/`]),
          "clone",
          "--quiet",
          "--no-recurse-submodules",
          "--origin",
          "origin",
          "--branch",
          request.branch,
          "--",
          request.url,
          request.directory,
        ],
        cloneTimeoutMs,
        {
          ...anonymousGitEnvironment(environment.path, home),
          ...(seam === undefined ? {} : { GIT_ALLOW_PROTOCOL: "https:http" }),
        },
      );
      return result !== "timeout" && result.exitCode === 0
        ? "cloned"
        : "failed";
    } catch {
      return "failed";
    } finally {
      await rm(home, { recursive: true, force: true }).catch(() => {});
    }
  };
  // One write of the operator's git; its last error line when it fails.
  const write = async (
    directory: string,
    args: readonly string[],
    timeoutMs = inspectTimeoutMs,
  ): Promise<
    Readonly<{ ok: true }> | Readonly<{ ok: false; detail: string }>
  > => {
    // The subcommand, after any `-c <setting>`.
    const command = args.find(
      (arg, index) => !arg.startsWith("-") && args[index - 1] !== "-c",
    );
    const executable = await git();
    if (executable === undefined || !environment.home)
      return { ok: false, detail: "git is not on this account's PATH" };
    try {
      const result = await environment.run(
        // Never Git's background maintenance after one of these one-shot
        // writes: `git commit` ends by starting `git maintenance run --auto
        // --detach`, which outlives the command, keeps writing into the
        // repository and races the removal of a temporary sibling
        // (`publishNewCheckout`), which then survives (#442). Every write
        // gets the same setting; none needs it, and the person's own git
        // use later still gets it.
        [executable, "-C", directory, "-c", "maintenance.auto=false", ...args],
        timeoutMs,
        env(),
      );
      if (result === "timeout")
        return { ok: false, detail: `git ${command} timed out` };
      if (result.exitCode === 0) return { ok: true };
      const last = `${result.stderr}${result.stdout}`
        .trim()
        .split("\n")
        .filter((line) => line.trim() !== "")
        .at(-1);
      return {
        ok: false,
        detail: `git ${command} failed${last === undefined ? "" : `: ${last.slice(0, 300)}`}`,
      };
    } catch {
      return { ok: false, detail: `git ${command} could not run` };
    }
  };
  // ---- synchronization of a present checkout (docs/content-sync.md) ----
  // Never interactive: no terminal or askpass prompt, and SSH in batch mode,
  // with the operator's own SSH command where one is configured. Never a
  // hook, a stash, a submodule or Git's background maintenance, and never a
  // checkout's own `core.fsmonitor` program, which `git status` and a merge
  // would run and which may write into the checkout (Pablo's review of #620).
  // `-c` reaches the Git processes these start too (GIT_CONFIG_PARAMETERS).
  const quiet = [
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "maintenance.auto=false",
    "-c",
    "gc.auto=0",
    "-c",
    "submodule.recurse=false",
    "-c",
    "merge.autoStash=false",
  ];
  const sshCommand = async (directory: string) => {
    if (environment.env.GIT_SSH_COMMAND !== undefined)
      return `${environment.env.GIT_SSH_COMMAND} -o BatchMode=yes`;
    const configured = await read(directory, [
      "config",
      "--get",
      "core.sshCommand",
    ]);
    if (configured !== null && configured !== "")
      return `${configured} -o BatchMode=yes`;
    // GIT_SSH names a program that may not take ssh's options.
    return environment.env.GIT_SSH !== undefined
      ? undefined
      : "ssh -o BatchMode=yes";
  };
  // One network command of a synchronization; its answer, classified.
  const network = async (
    directory: string,
    remote: SyncRemote,
    args: (source: string) => readonly string[],
    timeoutMs: number,
  ): Promise<
    | Readonly<{ kind: "ran"; exitCode: number; stdout: string }>
    | Exclude<RemoteAnswer, { kind: "commit" } | { kind: "missing" }>
  > => {
    const executable = await git();
    if (executable === undefined || !environment.home)
      return { kind: "failed" };
    let argv: string[];
    let variables: Record<string, string>;
    let home: string | undefined;
    if (remote.kind === "anonymous") {
      const seam = environment.anonymousOrigin;
      if (
        !repositoryPattern.test(remote.repository) ||
        (seam !== undefined && !testOrigin.test(seam))
      )
        return { kind: "failed" };
      try {
        home = await mkdtemp(join(tmpdir(), "lazurio-anonymous-git-"));
      } catch {
        return { kind: "failed" };
      }
      // The checkout's own configuration still applies: its credential
      // helpers, extra headers and SSH command are reset for this command,
      // and HTTPS stays the only protocol.
      argv = [
        executable,
        "-C",
        directory,
        ...quiet,
        "-c",
        "credential.helper=",
        "-c",
        "http.extraHeader=",
        "-c",
        "core.sshCommand=",
        ...(seam === undefined
          ? []
          : ["-c", `url.${seam}/.insteadOf=https://github.com/`]),
        ...args(`https://github.com/${remote.repository}.git`),
      ];
      variables = {
        ...anonymousGitEnvironment(environment.path, home),
        ...(seam === undefined ? {} : { GIT_ALLOW_PROTOCOL: "https:http" }),
        GIT_OPTIONAL_LOCKS: "0",
      };
    } else {
      const ssh = await sshCommand(directory);
      argv = [
        executable,
        "-C",
        directory,
        ...quiet,
        ...(remote.kind === "account" ? helperOf(remote.credentialHelper) : []),
        ...args("origin"),
      ];
      variables = {
        ...env(),
        ...(ssh === undefined ? {} : { GIT_SSH_COMMAND: ssh }),
        GIT_ASKPASS: "",
        SSH_ASKPASS: "",
        GIT_OPTIONAL_LOCKS: "0",
      };
    }
    try {
      const result = await environment.run(argv, timeoutMs, variables);
      if (result === "timeout") return { kind: "unavailable" };
      if (result.exitCode === 0 || result.exitCode === 2)
        return {
          kind: "ran",
          exitCode: result.exitCode,
          stdout: result.stdout,
        };
      return classifyNetworkFailure(`${result.stderr}\n${result.stdout}`);
    } catch {
      return { kind: "failed" };
    } finally {
      if (home !== undefined)
        await rm(home, { recursive: true, force: true }).catch(() => {});
    }
  };
  const commitOf = (value: string | null) =>
    value !== null && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(value)
      ? value
      : null;
  const ancestor = async (directory: string, a: string, b: string) => {
    const executable = await git();
    if (executable === undefined) return null;
    const result = await environment.run(
      [executable, "-C", directory, "merge-base", "--is-ancestor", a, b],
      inspectTimeoutMs,
      env(),
    );
    if (result === "timeout") return null;
    return result.exitCode === 0 ? true : result.exitCode === 1 ? false : null;
  };
  return Object.freeze({
    async changes(directory, gitDir) {
      const executable = await git();
      if (executable === undefined) return null;
      const status = await environment.run(
        [
          executable,
          "-C",
          directory,
          ...quiet,
          "status",
          "--porcelain=v1",
          "-z",
          "--untracked-files=all",
        ],
        inspectTimeoutMs,
        { ...env(), GIT_OPTIONAL_LOCKS: "0" },
      );
      if (status === "timeout" || status.exitCode !== 0) return null;
      let operation = false;
      for (const entry of operationMarkers)
        if (await lstat(join(gitDir, entry)).then(present, absent)) {
          operation = true;
          break;
        }
      return Object.freeze({ dirty: status.stdout !== "", operation });
    },
    async remoteHead(directory, remote, branch, timeoutMs) {
      if (!isBranchName(branch)) return { kind: "failed" };
      const answer = await network(
        directory,
        remote,
        (source) => [
          "ls-remote",
          "--exit-code",
          "--",
          source,
          `refs/heads/${branch}`,
        ],
        timeoutMs,
      );
      if (answer.kind !== "ran") return answer;
      if (answer.exitCode === 2) return { kind: "missing" };
      const line = answer.stdout
        .split("\n")
        .find((entry) => entry.endsWith(`\trefs/heads/${branch}`));
      const commit = commitOf(line?.split("\t")[0] ?? null);
      return commit === null ? { kind: "failed" } : { kind: "commit", commit };
    },
    async fetchBranch(directory, remote, branch, timeoutMs) {
      if (!isBranchName(branch)) return { kind: "failed" };
      const tracking = `refs/remotes/origin/${branch}`;
      const answer = await network(
        directory,
        remote,
        (source) => [
          "fetch",
          "--quiet",
          "--no-tags",
          "--no-recurse-submodules",
          "--no-write-fetch-head",
          "--",
          source,
          `+refs/heads/${branch}:${tracking}`,
        ],
        timeoutMs,
      );
      if (answer.kind !== "ran") return answer;
      if (answer.exitCode !== 0) return { kind: "failed" };
      const commit = commitOf(
        await read(directory, [
          "rev-parse",
          "--verify",
          `${tracking}^{commit}`,
        ]),
      );
      return commit === null ? { kind: "failed" } : { kind: "commit", commit };
    },
    async relation(directory, local, remote) {
      if (local === remote) return "equal";
      const known = await read(directory, [
        "cat-file",
        "-t",
        `${remote}^{commit}`,
      ]);
      if (known !== "commit") return null;
      const behind = await ancestor(directory, local, remote);
      if (behind === null) return null;
      if (behind) return "behind";
      const ahead = await ancestor(directory, remote, local);
      if (ahead === null) return null;
      return ahead ? "ahead" : "diverged";
    },
    async fastForward(directory, commit) {
      if (commitOf(commit) === null) return false;
      const merged = await write(
        directory,
        [...quiet, "merge", "--ff-only", "--quiet", "--no-stat", commit],
        commitTimeoutMs,
      );
      if (!merged.ok) return false;
      return (
        (await read(directory, ["rev-parse", "--verify", "HEAD"])) === commit
      );
    },
    async clone(request) {
      if (!isBranchName(request.branch)) return "failed";
      const executable = await git();
      if (executable !== undefined && request.credentialHelper === "")
        return anonymousClone(executable, request);
      if (executable === undefined || !environment.home) return "failed";
      const helper = helperOf(request.credentialHelper);
      try {
        const result = await environment.run(
          [
            executable,
            ...helper,
            "clone",
            "--quiet",
            "--no-recurse-submodules",
            "--origin",
            "origin",
            "--branch",
            request.branch,
            "--",
            request.url,
            request.directory,
          ],
          cloneTimeoutMs,
          env(),
        );
        return result !== "timeout" && result.exitCode === 0
          ? "cloned"
          : "failed";
      } catch {
        return "failed";
      }
    },
    async inspect(directory) {
      const executable = await git();
      if (executable === undefined) return { kind: "not-checkout" };
      const observed = await inspectGitCheckout(directory, executable);
      if (observed.kind !== "checkout-observed")
        return { kind: "not-checkout" };
      const commit = await read(directory, ["rev-parse", "--verify", "HEAD"]);
      if (commit === null || !/^[0-9a-f]{40,64}$/.test(commit))
        return { kind: "not-checkout" };
      const branch = await read(directory, [
        "symbolic-ref",
        "--quiet",
        "--short",
        "HEAD",
      ]);
      return Object.freeze({
        kind: "checkout",
        repository: observed.repository,
        branch,
        commit,
      });
    },
    async worktree(directory) {
      const paths = await read(directory, [
        "rev-parse",
        "--path-format=absolute",
        "--show-toplevel",
        "--git-dir",
        "--git-common-dir",
      ]);
      const [top, gitDir, commonDir] = paths?.split("\n") ?? [];
      if (
        top === undefined ||
        gitDir === undefined ||
        commonDir === undefined ||
        ![top, gitDir, commonDir].every((path) => path.startsWith("/"))
      )
        return null;
      const branch = await read(directory, [
        "symbolic-ref",
        "--quiet",
        "--short",
        "HEAD",
      ]);
      return Object.freeze({
        top,
        gitDir,
        commonDir,
        branch: branch === "" ? null : branch,
      });
    },
    async ignored(directory, path) {
      const executable = await git();
      if (executable === undefined) return null;
      const result = await environment.run(
        [executable, "-C", directory, "check-ignore", "--quiet", "--", path],
        inspectTimeoutMs,
        env(),
      );
      if (result === "timeout") return null;
      // 0: ignored, 1: not ignored (a tracked path never is), else no answer.
      return result.exitCode === 0
        ? true
        : result.exitCode === 1
          ? false
          : null;
    },
    async commitAll(directory, message, fallback) {
      for (const args of [
        ["init", "--quiet", "--initial-branch=main"],
        ["add", "--all"],
      ]) {
        const result = await write(directory, args, commitTimeoutMs);
        if (!result.ok) return result;
      }
      const identity = await identitySettings(
        (key) => read(directory, ["config", "--get", key]),
        fallback,
      );
      if (identity === null)
        return {
          ok: false,
          detail:
            "git has no user.name or user.email and no GitHub identity was known",
        };
      return write(
        directory,
        [...identity, "commit", "--quiet", "--message", message],
        commitTimeoutMs,
      );
    },
    async push(directory, remote) {
      const added = await write(directory, [
        "remote",
        "add",
        "origin",
        remote.url,
      ]);
      if (!added.ok) return added;
      return write(
        directory,
        [
          ...helperOf(remote.credentialHelper),
          "push",
          "--quiet",
          "--set-upstream",
          "origin",
          "main",
        ],
        cloneTimeoutMs,
      );
    },
  });
}
