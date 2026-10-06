import { inspectGitCheckout } from "../providers/git-checkout";
import type { ToolRunner } from "../tools/status";
import { resolveOnPath } from "../tools/status";

// Git for content installation: the operator's own `git` from the
// operator's PATH, with the operator's home and Git configuration, because a
// clone is the operator's act under the operator's sign-in (SSH key or gh as
// credential helper). Only the clone runs here; the verification reads the
// result through the existing read-only checkout inspection.

export type CloneRequest = Readonly<{
  url: string;
  directory: string;
  branch: "main";
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

export type ContentGit = Readonly<{
  clone(request: CloneRequest): Promise<"cloned" | "failed">;
  inspect(directory: string): Promise<CheckoutObservation>;
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
}>;

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
  return Object.freeze({
    async clone(request) {
      const executable = await git();
      if (executable === undefined || !environment.home) return "failed";
      const helper =
        request.credentialHelper === undefined
          ? []
          : [
              // Only for github.com over HTTPS: reset the list, then gh.
              "-c",
              "credential.https://github.com.helper=",
              "-c",
              `credential.https://github.com.helper=${request.credentialHelper}`,
            ];
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
  });
}
