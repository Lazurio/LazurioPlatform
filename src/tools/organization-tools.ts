import { lstat, mkdir, realpath, symlink } from "node:fs/promises";
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
// - a tool that reports at least the minimum is left exactly as it is,
//   wherever it was installed and whatever version it has;
// - a missing tool is installed by its official installer, for the user,
//   without root, into its installer's home, and linked into the standard
//   path `~/.local/bin` (0161 point 6), never over anything that is there;
// - a tool below the minimum is updated by its own official path when the
//   one on PATH is that installer's; an installation of someone else's (a
//   system package, npm) is reported, never replaced or shadowed;
// - it never downgrades and never edits a shell profile;
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
  /** The tool's own update, run from `bin`, as argv lists in order. */
  update: (bin: string) => readonly (readonly string[])[];
}>;

// Fetch to a private file, then run it, so a failed download never runs half
// a script (as the catalog's codex installer).
const fetchThenRun = (url: string, args: string) =>
  `set -eu; f="$(mktemp)"; trap 'rm -f "$f"' EXIT; curl --proto '=https' --tlsv1.2 -fsSL ${url} -o "$f"; sh "$f"${args}`;

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
    update: (bin: string) => [
      [join(bin, "rustup"), "update", "stable", "--no-self-update"],
      [join(bin, "rustup"), "default", "stable"],
    ],
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
    installer: fetchThenRun("https://get.pnpm.io/install.sh", ""),
    installerEnv: Object.freeze({ PNPM_NO_MODIFY_PATH: "1" }),
    bin: (home: string, xdg: Readonly<Record<string, string>>) =>
      join(xdg.XDG_DATA_HOME ?? join(home, ".local", "share"), "pnpm", "bin"),
    links: Object.freeze(["pnpm", "pnpx"]),
    update: () => [],
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
    | Readonly<{ result: "current"; version: string }>
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
  onStep?: (tool: OrganizationToolId, step: "installing" | "updating") => void;
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

/** The run environment of an installer and its tool: the user's PATH with
 * `~/.local/bin` first, the home, the XDG base directories, and nothing
 * else of this process. */
function runEnvironment(
  input: OrganizationToolsInput,
  home: string,
): Record<string, string> {
  const entry = join(home, ".local", "bin");
  const path = (input.path ?? "").split(":").filter((part) => part !== "");
  return {
    PATH: [entry, ...path.filter((part) => part !== entry)].join(":"),
    HOME: home,
    ...(input.xdg ?? {}),
    LC_ALL: "C",
  };
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
  const found = await resolveOnPath(recipe.command, env.PATH, input.platform);
  const before =
    found === undefined
      ? undefined
      : await versionAt(found, recipe, input, env);
  if (
    found !== undefined &&
    before !== undefined &&
    compareVersions(before, declared.minimum) >= 0
  )
    return Object.freeze({ ...base, result: "current", version: before });
  if (found !== undefined && before === undefined)
    return failed("verify", "version-unreadable");
  const timeout = input.timeoutMs ?? installTimeoutMs;
  const runStep = async (
    argv: readonly string[],
    extra: Readonly<Record<string, string>> = {},
  ): Promise<string | null> => {
    const result = await input.run(
      argv,
      timeout,
      { ...env, ...extra },
      { cwd: home, maxBytes: 1024 * 1024 },
    );
    if (result === "timeout") return "timeout";
    return result.exitCode === 0
      ? null
      : `exit-${result.exitCode}\n${result.stdout}\n${result.stderr}`;
  };
  let result: "installed" | "updated";
  if (found === undefined) {
    input.onStep?.(declared.tool, "installing");
    const outcome = await runStep(
      ["/bin/sh", "-c", recipe.installer],
      recipe.installerEnv,
    ).catch(() => "spawn-failed");
    if (outcome !== null) {
      const [reason = "failed", ...rest] = outcome.split("\n");
      return failed("install", reason, rest.join("\n"));
    }
    result = "installed";
  } else {
    // Below the minimum: only the official installer's own installation is
    // raised, by the tool's own update, or (where it has none) its installer
    // run again over its own home.
    if (!(await inside(found, bin)))
      return Object.freeze({
        ...base,
        result: "below-minimum" as const,
        version: before as string,
        reason: "foreign-installation" as const,
        path: found,
        source: recipe.source,
      });
    input.onStep?.(declared.tool, "updating");
    const steps = recipe.update(bin);
    const commands: readonly (readonly string[])[] =
      steps.length > 0 ? steps : [["/bin/sh", "-c", recipe.installer]];
    for (const argv of commands) {
      const outcome = await runStep(
        argv,
        steps.length > 0 ? {} : recipe.installerEnv,
      ).catch(() => "spawn-failed");
      if (outcome !== null) {
        const [reason = "failed", ...rest] = outcome.split("\n");
        return failed("update", reason, rest.join("\n"));
      }
    }
    result = "updated";
  }
  try {
    await linkInto(bin, recipe.links, home);
  } catch {
    return failed("link", "link-failed");
  }
  const located = await resolveOnPath(recipe.command, env.PATH, input.platform);
  const after =
    located === undefined
      ? undefined
      : await versionAt(located, recipe, input, env);
  if (after === undefined) return failed("verify", "not-found-after");
  if (compareVersions(after, declared.minimum) < 0)
    return failed("verify", `below-minimum-after:${after}`);
  // Whether the user's own PATH (not the one this run put first) finds it.
  const onPath =
    (await resolveOnPath(recipe.command, input.path, input.platform)) !==
    undefined;
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
