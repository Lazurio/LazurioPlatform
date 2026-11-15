import { constants } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  realpath,
  stat,
  symlink,
} from "node:fs/promises";
import { join, sep } from "node:path";
import {
  type OrganizationTool,
  type OrganizationToolId,
  organizationToolIds,
} from "../organizations/organization-settings";
import { safeTail } from "./redact";
import { resolveOnPath, type ToolRunner, versionOf } from "./status";

// The Organization's tools (decision F73, amending F17 and root decision
// 0161 point 2 for an Organization's work Environments): the Organization
// declares a catalog tool and its minimum version in `settings.tools` of its
// manifest, and `lazurio update` in each of its work Environments makes the
// tool available at that minimum, without asking, because the Organization
// Admin's approval of the declaration is the consent. The Organization
// declares only which tool and which minimum. How a tool is installed,
// updated and verified is this catalog's alone: an official installer, the
// tool's own update, a version command, never an installer of the
// manifest's (that would turn every write to an Organization's repository
// into a command run in all of its Environments).
//
// What it does, per declared tool:
// - the tool is the one the user's own PATH finds first, as doctor reads
//   it: never a PATH this run arranges, so a tool reported at its minimum
//   is the one the user runs;
// - a tool that reports at least the minimum is left exactly as it is,
//   wherever it was installed and whatever version it has;
// - a missing tool is installed by its official installer, for the user,
//   without root, into its installer's home, and linked into the standard
//   path `~/.local/bin` (0161 point 6), never over anything that is there;
// - a tool below the minimum is updated by its own official path when the
//   one on PATH is that installer's; an installation of someone else's (a
//   system package, npm) is reported, never replaced or shadowed;
// - it never downgrades, never switches what the user selected to anything
//   older and never edits a shell profile;
// - every outcome is an item; a failure names its stage and a safe tail of
//   the installer's output.

/** How Lazurio installs and keeps one Organization tool. */
export type OrganizationToolRecipe = Readonly<{
  tool: OrganizationToolId;
  /** The command on PATH and its version argument. */
  command: string;
  versionArgs: readonly string[];
  /** The official installation page. */
  source: string;
  /** The official installer, as one POSIX shell script: it fetches the
   * vendor's script to a private file, then runs it. */
  installer: string;
  /** More environment for the installer. */
  installerEnv: Readonly<Record<string, string>>;
  /** Where the installer keeps the programs, from the home directory and the
   * XDG base directories. */
  bin: (home: string, xdg: Readonly<Record<string, string>>) => string;
  /** The programs linked from `bin` into `~/.local/bin`. */
  links: readonly string[];
  /** The tool's own update of the installation in `bin`: null when it
   * ran to its end, or why it stopped. It never lowers the version the
   * user runs; the caller verifies the minimum afterwards. */
  raise: (bin: string, step: RaiseSteps) => Promise<StepFailure | null>;
}>;

/** A step that did not end well: a locale-neutral reason and the output it
 * gave, of which only a safe tail is ever shown. */
export type StepFailure = Readonly<{ reason: string; output?: string }>;

/** What a recipe's update may do: run a command (null when it ended well),
 * read the version a command reports, and the declared minimum. */
export type RaiseSteps = Readonly<{
  run: (
    argv: readonly string[],
    extra?: Readonly<Record<string, string>>,
  ) => Promise<StepFailure | null>;
  read: (argv: readonly string[]) => Promise<string | undefined>;
  version: (argv: readonly string[]) => Promise<string | undefined>;
  minimum: string;
}>;

// Fetch to a private file, then run it, so a failed download never runs half
// a script (as the catalog's codex installer).
const fetchThenRun = (url: string, args: string) =>
  `set -eu; f="$(mktemp)"; trap 'rm -f "$f"' EXIT; curl --proto '=https' --tlsv1.2 -fsSL ${url} -o "$f"; sh "$f"${args}`;

const pnpmInstaller = fetchThenRun("https://get.pnpm.io/install.sh", "");

/** Raises a rustup installation to the minimum without lowering what the
 * user runs (review of #992). First the toolchain the user selected, raised
 * in place by rustup's own update: a channel (stable, beta, nightly) moves
 * to its newest release, a pinned one stays where it is. Only when that
 * cannot reach the minimum is the default switched, and only to stable, and
 * only when stable reports at least the minimum, which is above the version
 * selected now; otherwise the default stays as it was and the failure says
 * which stable there is. */
async function raiseRustToolchain(
  bin: string,
  step: RaiseSteps,
): Promise<StepFailure | null> {
  const rustup = join(bin, "rustup");
  const shown = await step.read([rustup, "show", "active-toolchain"]);
  const selected = shown?.trim().split(/\s+/, 1)[0];
  if (selected === undefined || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(selected))
    return { reason: "toolchain-unknown" };
  const failed = await step.run([
    rustup,
    "update",
    selected,
    "--no-self-update",
  ]);
  if (failed !== null) return failed;
  const raised = await step.version([
    rustup,
    "run",
    selected,
    "cargo",
    "--version",
  ]);
  if (raised !== undefined && compareVersions(raised, step.minimum) >= 0)
    return null;
  if (/^stable(-|$)/.test(selected))
    return {
      reason: `stable-below-minimum:${raised ?? "unknown"}`,
    };
  const installed = await step.run([
    rustup,
    "toolchain",
    "install",
    "stable",
    "--profile",
    "minimal",
    "--no-self-update",
  ]);
  if (installed !== null) return installed;
  const stable = await step.version([
    rustup,
    "run",
    "stable",
    "cargo",
    "--version",
  ]);
  if (stable === undefined) return { reason: "stable-version-unreadable" };
  if (compareVersions(stable, step.minimum) < 0)
    return { reason: `stable-below-minimum:${stable}` };
  // Never older than what is selected now (the minimum is above it, but
  // the switch is checked on its own).
  if (raised !== undefined && compareVersions(stable, raised) < 0)
    return { reason: "would-downgrade" };
  return step.run([rustup, "default", "stable"]);
}

export const organizationToolRecipes: Readonly<
  Record<OrganizationToolId, OrganizationToolRecipe>
> = Object.freeze({
  // Cargo comes with Rust's toolchain through rustup, its official installer
  // (https://rustup.rs): stable, the minimal profile, no change of PATH or of
  // a shell profile. rustup keeps `~/.cargo` and `~/.rustup`; a repository's
  // `rust-toolchain.toml` still chooses its own toolchain, which rustup
  // fetches on first use.
  cargo: Object.freeze({
    tool: "cargo",
    command: "cargo",
    versionArgs: ["--version"],
    source: "https://rustup.rs",
    installer: fetchThenRun(
      "https://sh.rustup.rs",
      " -y --no-modify-path --profile minimal --default-toolchain stable",
    ),
    installerEnv: Object.freeze({}),
    bin: (home: string) => join(home, ".cargo", "bin"),
    links: Object.freeze(["cargo", "rustc", "rustup"]),
    raise: raiseRustToolchain,
  }),
  // pnpm's official installer (https://pnpm.io/installation) verifies the
  // npm registry's signature of what it downloads; `PNPM_NO_MODIFY_PATH`
  // keeps it from touching a shell profile (pnpm 12.16 and newer). pnpm
  // keeps its home in `$XDG_DATA_HOME/pnpm` (`~/.local/share/pnpm`) and
  // switches by itself to the version a project's `packageManager` names.
  // Run again, it installs the newest release over its own.
  pnpm: Object.freeze({
    tool: "pnpm",
    command: "pnpm",
    versionArgs: ["--version"],
    source: "https://pnpm.io/installation",
    installer: pnpmInstaller,
    installerEnv: Object.freeze({ PNPM_NO_MODIFY_PATH: "1" }),
    bin: (home: string, xdg: Readonly<Record<string, string>>) =>
      join(xdg.XDG_DATA_HOME ?? join(home, ".local", "share"), "pnpm", "bin"),
    links: Object.freeze(["pnpm", "pnpx"]),
    // pnpm has no update of its own that keeps its home: its installer,
    // run again, installs the newest release over its own.
    raise: (_bin: string, step: RaiseSteps) =>
      step.run(["/bin/sh", "-c", pnpmInstaller], { PNPM_NO_MODIFY_PATH: "1" }),
  }),
});

/** Which catalog recipes exist is the reader's list: one tool, one recipe. */
export const organizationToolRecipeIds: readonly OrganizationToolId[] =
  organizationToolIds;

/** `a` compared with `b`, both `major.minor.patch` (a prerelease or build
 * suffix of `a` is dropped): negative, zero or positive. */
export function compareVersions(a: string, b: string): number {
  const parts = (value: string) =>
    (value.split(/[-+]/, 1)[0] ?? "")
      .split(".")
      .map((part) => Number.parseInt(part, 10));
  const left = parts(a);
  const right = parts(b);
  for (let index = 0; index < 3; index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

const fullVersion = (value: string | undefined) =>
  value !== undefined && /^\d+\.\d+\.\d+/.test(value) ? value : undefined;

/** How one declared tool ended. `current`: it already reports at least the
 * minimum, nothing touched. `installed`: it was missing and its official
 * installer installed it. `updated`: it was below and its own update raised
 * it. `below-minimum`: below, but the one on PATH is not its official
 * installer's, so it is left as it is. `failed`: a stage did not end well.
 * `unsupported-platform`: no recipe runs here (Windows, for now). */
export type OrganizationToolItem = Readonly<{
  tool: OrganizationToolId;
  minimum: string;
}> &
  (
    | Readonly<{
        result: "current";
        version: string;
        /** Only when the user's PATH does not reach it: the installer's own
         * installation, linked into a ~/.local/bin that PATH lacks. */
        onPath?: false;
      }>
    | Readonly<{ result: "installed"; version: string; onPath: boolean }>
    | Readonly<{
        result: "updated";
        from: string;
        version: string;
        onPath: boolean;
      }>
    | Readonly<{
        result: "below-minimum";
        version: string;
        reason: "foreign-installation";
        path: string;
        source: string;
      }>
    | Readonly<{
        result: "failed";
        stage: "install" | "update" | "link" | "verify";
        reason: string;
        detail?: string;
        source: string;
      }>
    | Readonly<{ result: "unsupported-platform"; platform: string }>
  );

export type OrganizationToolsInput = Readonly<{
  tools: readonly OrganizationTool[];
  path: string | undefined;
  home: string | undefined;
  xdg?: Readonly<Record<string, string>> | undefined;
  platform: string;
  run: ToolRunner;
  /** Called before a tool's installer or update starts (a line's step). */
  onStep?: (
    tool: OrganizationToolId,
    step: "installing" | "updating",
    minimum: string,
  ) => void;
  timeoutMs?: number;
}>;

const installTimeoutMs = 15 * 60_000;
const versionTimeoutMs = 30_000;

async function versionAt(
  program: string,
  recipe: OrganizationToolRecipe,
  input: OrganizationToolsInput,
  env: Readonly<Record<string, string>>,
): Promise<string | undefined> {
  try {
    const result = await input.run(
      [program, ...recipe.versionArgs],
      versionTimeoutMs,
      env,
      input.home === undefined ? {} : { cwd: input.home },
    );
    if (result === "timeout" || result.exitCode !== 0) return undefined;
    return fullVersion(versionOf(result.stdout));
  } catch {
    return undefined;
  }
}

/** Links `~/.local/bin/<name>` to `<bin>/<name>` where nothing is there yet;
 * what is there, a link of someone else's included, stays. */
async function linkInto(
  bin: string,
  names: readonly string[],
  home: string,
): Promise<void> {
  const entry = join(home, ".local", "bin");
  await mkdir(entry, { recursive: true, mode: 0o755 });
  for (const name of names) {
    const target = join(bin, name);
    try {
      await lstat(target);
    } catch {
      continue;
    }
    const link = join(entry, name);
    try {
      await lstat(link);
      continue;
    } catch {}
    await symlink(target, link);
  }
}

async function inside(path: string, directory: string): Promise<boolean> {
  try {
    const real = await realpath(path);
    const base = await realpath(directory);
    return real === base || real.startsWith(`${base}${sep}`);
  } catch {
    return false;
  }
}

/** The run environment of an installer and its tool: the user's own PATH
 * as it is, the home, the XDG base directories, and nothing else of this
 * process. Never a PATH arranged for this run: what it finds is what the
 * user runs (review of #992). */
function runEnvironment(
  input: OrganizationToolsInput,
  home: string,
): Record<string, string> {
  return {
    PATH: input.path ?? "",
    HOME: home,
    ...(input.xdg ?? {}),
    LC_ALL: "C",
  };
}

async function executable(file: string): Promise<boolean> {
  try {
    await access(file, constants.X_OK);
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

async function oneTool(
  declared: OrganizationTool,
  input: OrganizationToolsInput,
  home: string,
): Promise<OrganizationToolItem> {
  const recipe = organizationToolRecipes[declared.tool];
  const base = { tool: declared.tool, minimum: declared.minimum } as const;
  const env = runEnvironment(input, home);
  const bin = recipe.bin(home, input.xdg ?? {});
  const own = join(bin, recipe.command);
  const failed = (
    stage: "install" | "update" | "link" | "verify",
    reason: string,
    output = "",
  ): OrganizationToolItem => {
    const detail = output === "" ? "" : safeTail(output);
    return Object.freeze({
      ...base,
      result: "failed" as const,
      stage,
      reason,
      ...(detail === "" ? {} : { detail }),
      source: recipe.source,
    });
  };
  // The one the user runs: the first on their own PATH. Where none is, the
  // official installer's own installation that PATH does not reach yet (a
  // run before linked it into a ~/.local/bin the PATH lacks) is the one to
  // keep, never a second installation over it.
  const onUserPath = await resolveOnPath(
    recipe.command,
    input.path,
    input.platform,
  );
  const found = onUserPath ?? ((await executable(own)) ? own : undefined);
  const before =
    found === undefined
      ? undefined
      : await versionAt(found, recipe, input, env);
  if (found !== undefined && before === undefined)
    return failed("verify", "version-unreadable");
  if (
    found !== undefined &&
    before !== undefined &&
    compareVersions(before, declared.minimum) >= 0
  )
    return onUserPath === undefined
      ? Object.freeze({
          ...base,
          result: "current",
          version: before,
          onPath: false,
        })
      : Object.freeze({ ...base, result: "current", version: before });
  const timeout = input.timeoutMs ?? installTimeoutMs;
  const run = async (
    argv: readonly string[],
    extra: Readonly<Record<string, string>> = {},
  ): Promise<StepFailure | null> => {
    try {
      const result = await input.run(
        argv,
        timeout,
        { ...env, ...extra },
        { cwd: home, maxBytes: 1024 * 1024 },
      );
      if (result === "timeout") return { reason: "timeout" };
      return result.exitCode === 0
        ? null
        : {
            reason: `exit-${result.exitCode}`,
            output: `${result.stdout}\n${result.stderr}`,
          };
    } catch {
      return { reason: "spawn-failed" };
    }
  };
  let result: "installed" | "updated";
  if (found === undefined) {
    input.onStep?.(declared.tool, "installing", declared.minimum);
    const outcome = await run(
      ["/bin/sh", "-c", recipe.installer],
      recipe.installerEnv,
    );
    if (outcome !== null)
      return failed("install", outcome.reason, outcome.output);
    result = "installed";
  } else {
    // Below the minimum: only the official installer's own installation is
    // raised, by the tool's own update; someone else's is reported.
    if (!(await inside(found, bin)))
      return Object.freeze({
        ...base,
        result: "below-minimum" as const,
        version: before as string,
        reason: "foreign-installation" as const,
        path: found,
        source: recipe.source,
      });
    input.onStep?.(declared.tool, "updating", declared.minimum);
    const outcome = await recipe.raise(bin, {
      run,
      read: async (argv) => {
        try {
          const answer = await input.run(argv, versionTimeoutMs, env, {
            cwd: home,
          });
          return answer === "timeout" || answer.exitCode !== 0
            ? undefined
            : answer.stdout;
        } catch {
          return undefined;
        }
      },
      version: async (argv) => {
        try {
          const answer = await input.run(argv, versionTimeoutMs, env, {
            cwd: home,
          });
          return answer === "timeout" || answer.exitCode !== 0
            ? undefined
            : fullVersion(versionOf(answer.stdout));
        } catch {
          return undefined;
        }
      },
      minimum: declared.minimum,
    });
    if (outcome !== null)
      return failed("update", outcome.reason, outcome.output);
    result = "updated";
  }
  try {
    await linkInto(bin, recipe.links, home);
  } catch {
    return failed("link", "link-failed");
  }
  // Verified as the user runs it: the first on their own PATH, or, where
  // that PATH reaches none, the installation itself (and it says so).
  const located = await resolveOnPath(
    recipe.command,
    input.path,
    input.platform,
  );
  const checked = located ?? ((await executable(own)) ? own : undefined);
  const after =
    checked === undefined
      ? undefined
      : await versionAt(checked, recipe, input, env);
  if (after === undefined) return failed("verify", "not-found-after");
  if (compareVersions(after, declared.minimum) < 0)
    return failed("verify", `below-minimum-after:${after}`);
  const onPath = located !== undefined;
  return result === "installed"
    ? Object.freeze({ ...base, result, version: after, onPath })
    : Object.freeze({
        ...base,
        result,
        from: before as string,
        version: after,
        onPath,
      });
}

/** Makes the declared tools available at their minimum, one at a time, in
 * the order declared. Never throws: every tool is an item. */
export async function provisionOrganizationTools(
  input: OrganizationToolsInput,
): Promise<readonly OrganizationToolItem[]> {
  const items: OrganizationToolItem[] = [];
  for (const declared of input.tools) {
    const base = { tool: declared.tool, minimum: declared.minimum } as const;
    if (input.platform !== "linux" && input.platform !== "darwin") {
      items.push(
        Object.freeze({
          ...base,
          result: "unsupported-platform" as const,
          platform: input.platform,
        }),
      );
      continue;
    }
    if (input.home === undefined) {
      items.push(
        Object.freeze({
          ...base,
          result: "failed" as const,
          stage: "install" as const,
          reason: "home-unknown",
          source: organizationToolRecipes[declared.tool].source,
        }),
      );
      continue;
    }
    try {
      items.push(await oneTool(declared, input, input.home));
    } catch {
      items.push(
        Object.freeze({
          ...base,
          result: "failed" as const,
          stage: "install" as const,
          reason: "operation-failed",
          source: organizationToolRecipes[declared.tool].source,
        }),
      );
    }
  }
  return Object.freeze(items);
}

/** Whether the declared tools are there at their minimum, without changing
 * anything (`lazurio doctor`): each tool's version on the user's PATH. */
export async function organizationToolsState(
  input: Omit<OrganizationToolsInput, "onStep" | "timeoutMs">,
): Promise<
  readonly Readonly<{
    tool: OrganizationToolId;
    minimum: string;
    state: "ok" | "missing" | "below-minimum" | "version-unreadable";
    version?: string;
  }>[]
> {
  const states = [];
  for (const declared of input.tools) {
    const recipe = organizationToolRecipes[declared.tool];
    const found = await resolveOnPath(
      recipe.command,
      input.path,
      input.platform,
    );
    const env = {
      PATH: input.path ?? "",
      ...(input.home === undefined ? {} : { HOME: input.home }),
      ...(input.xdg ?? {}),
      LC_ALL: "C",
    };
    const version =
      found === undefined
        ? undefined
        : await versionAt(found, recipe, input, env);
    const base = { tool: declared.tool, minimum: declared.minimum };
    states.push(
      Object.freeze(
        found === undefined
          ? { ...base, state: "missing" as const }
          : version === undefined
            ? { ...base, state: "version-unreadable" as const }
            : compareVersions(version, declared.minimum) < 0
              ? { ...base, state: "below-minimum" as const, version }
              : { ...base, state: "ok" as const, version },
      ),
    );
  }
  return Object.freeze(states);
}
