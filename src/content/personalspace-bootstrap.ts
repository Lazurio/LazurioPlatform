import { constants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import type { ToolsEnvironment } from "../tools/overview";
import { resolveOnPath } from "../tools/status";
import { type CommitIdentity, identitySettings } from "./commit-identity";
import { gitEnvironmentOf } from "./git";

// The template's own bootstrap in a Personalspace that `lazurio personalspace
// install` has just created (decision F9, addendum of 2026-10-14;
// Lazurio/LazurioPlatform#377), and the commit and push its manual asks for
// after it. The template owns its identity logic: nothing here writes
// `personal.gen3.json` or `modules.manifest.json`. The Platform runs the
// template's `bun run bootstrap`, reads what it wrote, and commits exactly the
// files the template's manual names (manual/bootstrap-personalspace.md, step
// 7). The bootstrap is never run in a repository this run did not create:
// that would execute code of an existing repository, and its `main` is the
// person's Publication.

/** The owner the template names until its bootstrap replaces it (its
 * `OWNER_PLACEHOLDER`). */
export const templateOwnerPlaceholder = "owner-github-username";

/** The template's marker of origin (`personalspace.template.json`). */
export const personalspaceTemplateMarker = Object.freeze({
  file: "personalspace.template.json",
  schemaVersion: "humanandmachines.personalspace-template.v1",
});

/** What the bootstrap writes into the Personalspace and its manual commits. */
export const personalspaceIdentityFiles = Object.freeze([
  "personal.gen3.json",
  "modules.manifest.json",
]);

/** The commit messages of the template's manual, step 7. */
export const personalspaceCommitMessage = "Nastav Personalspace GEN3";
export const gbrainCommitMessage = "Ignoruj lokální gbrain runtime";

export type BootstrapReady =
  | Readonly<{ ok: true }>
  | Readonly<{
      ok: false;
      code: "personalspace-toolchain-missing" | "git-identity-missing";
      detail: string;
    }>;

export type BootstrapRun =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; detail: string }>;

export type PublishAnswer =
  | Readonly<{ ok: true; committed: boolean }>
  | Readonly<{ ok: false; stage: "commit" | "push"; detail: string }>;

/** The effects the Personalspace's setup needs, injectable for tests. */
export type PersonalspaceBootstrap = Readonly<{
  /** Whether a bootstrap can run and its result be committed here, asked
   * before anything is created: Bun, and a Git identity, the operator's own
   * or, where git has none, `fallback` (the person's GitHub identity). */
  ready(
    folder: string,
    fallback?: CommitIdentity | undefined,
  ): Promise<BootstrapReady>;
  /** Whether a checkout has no change and no untracked file. */
  clean(directory: string): Promise<boolean>;
  /** `bun run bootstrap -- --login … --display-name … --apply` of the
   * template in `checkout`, with the operator's gh and git. */
  run(
    checkout: string,
    request: Readonly<{ login: string; displayName: string }>,
  ): Promise<BootstrapRun>;
  /** Commits `paths` of the checkout `directory` (nothing when they are
   * unchanged) by the operator's Git identity, else by `fallback` given per
   * commit, and pushes its branch to `origin`. */
  publish(
    directory: string,
    paths: readonly string[],
    message: string,
    credentialHelper?: string | undefined,
    fallback?: CommitIdentity | undefined,
  ): Promise<PublishAnswer>;
}>;

/** Who a Personalspace's two declarations name (read only). */
export type PersonalspaceOwner =
  | Readonly<{ kind: "named"; login: string; gbrain: string | null }>
  | Readonly<{ kind: "placeholder" }>
  | Readonly<{ kind: "unreadable" }>;

const record = (value: unknown): Readonly<Record<string, unknown>> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

export async function personalspaceOwnerOf(
  checkout: string,
): Promise<PersonalspaceOwner> {
  const personal = record(await readJson(join(checkout, "personal.gen3.json")));
  const modules = record(
    await readJson(join(checkout, "modules.manifest.json")),
  );
  const login = record(personal?.owner)?.github_username;
  const declared = modules?.owner;
  if (
    login === templateOwnerPlaceholder ||
    declared === templateOwnerPlaceholder
  )
    return { kind: "placeholder" };
  if (typeof login !== "string" || typeof declared !== "string")
    return { kind: "unreadable" };
  const gbrain = record(record(personal?.gbrain)?.repository)?.github_repo;
  return {
    kind: "named",
    login,
    gbrain: typeof gbrain === "string" ? gbrain : null,
  };
}

/** Whether `checkout` carries the marker of `template`. */
export async function isTemplateCheckout(checkout: string, template: string) {
  const marker = record(
    await readJson(join(checkout, personalspaceTemplateMarker.file)),
  );
  return (
    marker?.schema_version === personalspaceTemplateMarker.schemaVersion &&
    typeof marker.template_repo === "string" &&
    marker.template_repo.toLowerCase() === template.toLowerCase()
  );
}

/** The Bun at the Environment's standard path (`~/.local/bin/bun`, as the
 * module lifecycle), else the one on the operator's PATH. */
async function locateBun(
  home: string | undefined,
  path: string | undefined,
  platform: string,
): Promise<string | undefined> {
  if (home !== undefined) {
    const standard = join(home, ".local", "bin", "bun");
    if (await executable(standard)) return standard;
  }
  return resolveOnPath("bun", path, platform);
}

async function executable(path: string) {
  try {
    if (!(await stat(path)).isFile()) return false;
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

const bootstrapTimeoutMs = 600_000;
const gitTimeoutMs = 60_000;
const pushTimeoutMs = 600_000;

/** The reason a failed bootstrap gives: its own `Bootstrap selhal: …` line,
 * else the last line it printed. */
export function bootstrapFailureDetail(stderr: string, stdout: string) {
  const lines = `${stderr}\n${stdout}`
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const own = lines.find((line) => line.startsWith("Bootstrap selhal:"));
  return (own ?? lines.at(-1) ?? "no output").slice(0, 400);
}

/** The bootstrap of this process: Bun, gh and git from the operator's PATH
 * and home, as content installation runs them. */
export function processPersonalspaceBootstrap(
  tools: ToolsEnvironment,
  processEnv: Readonly<Record<string, string | undefined>>,
  options: Readonly<{ bunExecutable?: string | undefined }> = {},
): PersonalspaceBootstrap {
  const passed = gitEnvironmentOf(processEnv);
  let bun: Promise<string | undefined> | undefined;
  const bunOf = () => {
    bun ??= (async () => {
      const located =
        options.bunExecutable ??
        (await locateBun(tools.home, tools.path, tools.platform));
      return located !== undefined && (await executable(located))
        ? located
        : undefined;
    })();
    return bun;
  };
  let git: Promise<string | undefined> | undefined;
  const gitOf = () => {
    git ??= resolveOnPath("git", tools.path, tools.platform);
    return git;
  };
  const env = (path = tools.path) => {
    const value: Record<string, string> = {
      ...passed,
      GH_PROMPT_DISABLED: "1",
      GH_NO_UPDATE_NOTIFIER: "1",
      NO_COLOR: "1",
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "never",
    };
    if (tools.home) value.HOME = tools.home;
    if (path) value.PATH = path;
    for (const [name, entry] of Object.entries(tools.xdg ?? {}))
      value[name] = entry;
    return value;
  };
  const runGit = async (
    directory: string,
    args: readonly string[],
    timeoutMs = gitTimeoutMs,
  ) => {
    const executable = await gitOf();
    if (executable === undefined) return null;
    try {
      const result = await tools.run(
        [executable, "-C", directory, ...args],
        timeoutMs,
        { ...env(), LC_ALL: "C" },
      );
      return result === "timeout" ? null : result;
    } catch {
      return null;
    }
  };
  // git's own value of a setting in `directory`, or null.
  const configured =
    (directory: string) => async (key: "user.name" | "user.email") => {
      const answer = await runGit(directory, ["config", "--get", key]);
      return answer !== null && answer.exitCode === 0 ? answer.stdout : null;
    };
  const lastLine = (text: string) =>
    text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "")
      .at(-1)
      ?.slice(0, 300);
  return Object.freeze({
    async ready(folder, fallback) {
      if ((await bunOf()) === undefined)
        return {
          ok: false,
          code: "personalspace-toolchain-missing",
          detail:
            "Bun is not at ~/.local/bin/bun or on PATH, and the template's bootstrap runs with it; nothing was created (see lazurio tools status)",
        };
      if ((await identitySettings(configured(folder), fallback)) === null)
        return {
          ok: false,
          code: "git-identity-missing",
          detail:
            "git has no user.name or user.email and no GitHub identity is known to commit the new Personalspace's owner with; nothing was created. Set them (git config --global user.name …, user.email …) or sign in gh, and run the install again",
        };
      return { ok: true };
    },
    async clean(directory) {
      const answer = await runGit(directory, ["status", "--porcelain"]);
      return answer !== null && answer.exitCode === 0 && answer.stdout === "";
    },
    async run(checkout, request) {
      const executable = await bunOf();
      if (executable === undefined)
        return { ok: false, detail: "Bun is not available" };
      // The template's bootstrap runs `bun` again for its doctor: the same
      // Bun comes first on its PATH.
      const path = [dirname(executable), tools.path]
        .filter((entry) => entry !== undefined && entry !== "")
        .join(delimiter);
      try {
        const result = await tools.run(
          [
            executable,
            "run",
            "--cwd",
            checkout,
            "bootstrap",
            "--",
            "--login",
            request.login,
            "--display-name",
            request.displayName,
            "--apply",
          ],
          bootstrapTimeoutMs,
          env(path),
        );
        if (result === "timeout")
          return { ok: false, detail: "the bootstrap timed out" };
        return result.exitCode === 0
          ? { ok: true }
          : {
              ok: false,
              detail: bootstrapFailureDetail(result.stderr, result.stdout),
            };
      } catch {
        return { ok: false, detail: "the bootstrap could not be started" };
      }
    },
    async publish(directory, paths, message, credentialHelper, fallback) {
      const failed = (
        stage: "commit" | "push",
        command: string,
        result: Awaited<ReturnType<typeof runGit>>,
      ): PublishAnswer => {
        const last =
          result === null
            ? undefined
            : lastLine(`${result.stderr}\n${result.stdout}`);
        return {
          ok: false,
          stage,
          detail: `git ${command} failed${last === undefined ? "" : `: ${last}`}`,
        };
      };
      const added = await runGit(directory, ["add", "--", ...paths]);
      if (added === null || added.exitCode !== 0)
        return failed("commit", "add", added);
      // Exit 0: nothing of `paths` is staged, so nothing to commit.
      const staged = await runGit(directory, [
        "diff",
        "--cached",
        "--quiet",
        "--",
        ...paths,
      ]);
      if (staged === null || (staged.exitCode !== 0 && staged.exitCode !== 1))
        return failed("commit", "diff", staged);
      const committed = staged.exitCode === 1;
      if (committed) {
        const identity = await identitySettings(
          configured(directory),
          fallback,
        );
        if (identity === null)
          return {
            ok: false,
            stage: "commit",
            detail:
              "git has no user.name or user.email and no GitHub identity was known",
          };
        const commit = await runGit(directory, [
          ...identity,
          "commit",
          "--quiet",
          "--message",
          message,
          "--",
          ...paths,
        ]);
        if (commit === null || commit.exitCode !== 0)
          return failed("commit", "commit", commit);
      }
      const helper =
        credentialHelper === undefined
          ? []
          : [
              // Only for github.com over HTTPS: reset the list, then gh.
              "-c",
              "credential.https://github.com.helper=",
              "-c",
              `credential.https://github.com.helper=${credentialHelper}`,
            ];
      const pushed = await runGit(
        directory,
        [...helper, "push", "--quiet", "origin", "HEAD"],
        pushTimeoutMs,
      );
      if (pushed === null || pushed.exitCode !== 0)
        return failed("push", "push", pushed);
      return { ok: true, committed };
    },
  });
}
