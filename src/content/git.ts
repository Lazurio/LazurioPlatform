import { mkdtemp, rm } from "node:fs/promises";
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
  branch: "main";
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
}>;

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
  /** The HTTP(S) proxy of this process (`proxyEnvironmentOf`), which an
   * anonymous clone is given besides PATH: a public Environment may reach
   * github.com only through its proxy. */
  proxy?: Readonly<Record<string, string>> | undefined;
  /** Test seam: the origin, exactly `http://127.0.0.1:<port>`, of a local
   * server that stands in for github.com for an anonymous clone, given to
   * that clone alone as one `url.<origin>/.insteadOf=https://github.com/`
   * with HTTP allowed. The product never sets it. */
  anonymousOrigin?: string | undefined;
}>;

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

const proxyName = /^(http_proxy|https_proxy|all_proxy|no_proxy)$/i;

/** The standard proxy variables of an environment (`http_proxy`,
 * `https_proxy`, `all_proxy`, `no_proxy`, in either case), which route a
 * connection and name nobody. One whose value has an `@`, a proxy URL with
 * userinfo (its credentials), is left out, never carried. */
export function proxyEnvironmentOf(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const value: Record<string, string> = {};
  for (const [name, entry] of Object.entries(env))
    if (proxyName.test(name) && entry && !entry.includes("@"))
      value[name] = entry;
  return value;
}

/** The whole environment of an anonymous clone (decision F55's addendum of
 * 2026-10-17, review of #472): only PATH, a locale, an empty temporary home
 * and the Environment's HTTP(S) proxy without credentials
 * (`proxyEnvironmentOf` of `proxy`), the only way a public Environment
 * reaches github.com. No system, global or XDG configuration and nothing
 * injected through the environment (`GIT_CONFIG_*`, `GIT_CONFIG_PARAMETERS`),
 * so no `http.extraHeader`, credential helper, `insteadOf` rewrite or
 * `core.sshCommand` of anyone reaches it; no prompt, askpass or SSH helper;
 * HTTPS the only protocol. The process runs with exactly this environment
 * (the tool runner inherits nothing). */
export function anonymousGitEnvironment(
  path: string | undefined,
  home: string,
  proxy: Readonly<Record<string, string | undefined>> = {},
): Record<string, string> {
  return {
    ...proxyEnvironmentOf(proxy),
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
  // run from an empty temporary home with `anonymousGitEnvironment`, the
  // Environment's proxy included, and nothing else; the empty
  // `credential.helper` stays as a second fence.
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
          ...anonymousGitEnvironment(environment.path, home, environment.proxy),
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
  return Object.freeze({
    async clone(request) {
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
