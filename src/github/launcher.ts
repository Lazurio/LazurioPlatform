import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { constants as osConstants } from "node:os";
import { resolveOnPath } from "../tools/status";
import { chooseOrganization, foreignNotice, tokenAdvice } from "./credential";
import type { GithubHttp } from "./oauth";
import { OwnerSelectionError, ownerOfGhCommand, ownerOfRemote } from "./owner";
import { type PilotPaths, readPilot } from "./pilot";
import { organizationToken } from "./store";
import { launcherMarker } from "./wiring";

// The gh launcher of the pilot (decision F46): `~/.local/bin/gh` once
// `pilot wire` ran, and `lazurio github gh …` directly. It runs the official
// gh with `GH_TOKEN` of the repository owner's Organization sign-in in the
// child's environment only (owner.ts says which owner), and nothing else
// changes for gh: its arguments, its own configuration, its output and its
// exit status are the official ones, and GitHub decides what the token may
// do. Three things are not gh's own here: the `gh auth` commands that would
// sign in or print a token (the sign-in is `lazurio github sign-in`), a host
// other than github.com, and an owner whose configured sign-in is missing,
// which fails closed with what to do instead of falling back to anything.

export type LauncherHost = Readonly<{
  env: Readonly<Record<string, string | undefined>>;
  paths: PilotPaths;
  http: GithubHttp;
  now: () => number;
  /** `git remote get-url origin` of the working directory, null outside a
   * checkout. */
  readOrigin: () => Promise<string | null>;
  /** Runs the official gh with the terminal of this process; resolves its
   * exit status. */
  runGh: (
    gh: string,
    args: readonly string[],
    env: Readonly<Record<string, string>>,
  ) => Promise<number>;
  writeStderr: (text: string) => void;
}>;

// The variables of other credentials, which never reach the official gh
// beside the chosen sign-in.
const tokenVariables = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
] as const;

function withoutTokens(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(env))
    if (
      value !== undefined &&
      !(tokenVariables as readonly string[]).includes(name)
    )
      result[name] = value;
  return result;
}

// What gh runs without any account: help, versions, completion and its own
// local configuration. Never refused, even while signed out: `lazurio tools
// status` and doctor read `gh --version` through the launcher.
const localCommands = new Set([
  "--version",
  "version",
  "help",
  "completion",
  "config",
  "alias",
]);
// `gh auth` commands that would sign in, switch accounts, wire gh as Git's
// helper or print a token.
const refusedAuth = new Set([
  "login",
  "refresh",
  "switch",
  "setup-git",
  "token",
  "git-credential",
]);

export type LauncherClass =
  | "local"
  /** `gh auth logout`: removes a sign-in gh stored itself, which on a
   * pilot Environment is always a left-over account-wide one. */
  | "logout"
  | "refused-auth"
  | "refused-token"
  | "refused-host"
  | "account";

export function classifyGh(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): LauncherClass {
  const end = args.indexOf("--");
  const own = end === -1 ? args : args.slice(0, end);
  const [command, subcommand] = own;
  if (own.includes("--show-token")) return "refused-token";
  if (command === "auth" && own.includes("-t")) return "refused-token";
  // Needs no account and no host: runs whatever GH_HOST says.
  if (
    command === undefined ||
    localCommands.has(command) ||
    own.includes("--help") ||
    own.includes("-h")
  )
    return "local";
  const host = env.GH_HOST;
  if (host !== undefined && host !== "" && host.toLowerCase() !== "github.com")
    return "refused-host";
  for (let index = 0; index < own.length; index += 1) {
    const argument = own[index] as string;
    const value =
      argument === "--hostname"
        ? own[index + 1]
        : argument.startsWith("--hostname=")
          ? argument.slice("--hostname=".length)
          : undefined;
    if (value !== undefined && value.toLowerCase() !== "github.com")
      return "refused-host";
  }
  if (command === "auth") {
    if (subcommand === "logout") return "logout";
    if (subcommand !== undefined && refusedAuth.has(subcommand))
      return "refused-auth";
    if (subcommand !== "status") return "local";
  }
  return "account";
}

const isLauncher = async (path: string) => {
  try {
    return (await readFile(path, "utf8")).includes(launcherMarker);
  } catch {
    return false;
  }
};

async function executable(path: string): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) return false;
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The official gh: the one `pilot wire` moved aside or found; before the
 * pilot is wired, the gh on PATH (never a launcher of the pilot). */
async function officialGh(
  host: LauncherHost,
  real: string | undefined,
): Promise<string | undefined> {
  if (real !== undefined) return (await executable(real)) ? real : undefined;
  const found = await resolveOnPath("gh", host.env.PATH, process.platform);
  return found === undefined || (await isLauncher(found)) ? undefined : found;
}

export async function runGhLauncher(
  args: readonly string[],
  host: LauncherHost,
): Promise<number> {
  const say = (message: string) =>
    host.writeStderr(`gh (Lazurio): ${message}\n`);
  const pilot = await readPilot(host.paths);
  if (pilot.kind !== "on") {
    say(
      pilot.kind === "off"
        ? "the GitHub sign-in pilot is off in this Environment. If gh was wired to it, restore gh: lazurio github pilot unwire"
        : `the GitHub sign-in pilot's configuration cannot be read (${host.paths.config}).`,
    );
    return 1;
  }
  const { config } = pilot;
  const gh = await officialGh(host, config.wiring?.gh.real);
  if (gh === undefined) {
    say(
      config.wiring === null
        ? "the official gh is not on PATH. Install it: lazurio tools install gh"
        : "the official gh that the pilot moved aside is gone. Restore gh with lazurio github pilot unwire, then lazurio tools install gh",
    );
    return 1;
  }
  const classification = classifyGh(args, host.env);
  switch (classification) {
    case "local":
    case "logout":
      return host.runGh(gh, args, withoutTokens(host.env));
    case "refused-auth":
      say(
        `in this Environment GitHub is signed in per Organization (pilot), so gh auth ${args[1]} is not used here. See lazurio github status; the Operator signs in with lazurio github sign-in --organization <Organization>.`,
      );
      return 1;
    case "refused-token":
      say("tokens are never printed in this Environment.");
      return 1;
    case "refused-host":
      say("the GitHub sign-in pilot serves github.com only.");
      return 1;
    case "account":
      break;
  }
  let owner: string | null;
  try {
    owner = ownerOfGhCommand(args, host.env)?.owner ?? null;
  } catch (error) {
    if (!(error instanceof OwnerSelectionError)) throw error;
    say(
      error.reason === "selectors-disagree"
        ? "--repo, GH_REPO and the command name repositories of different owners; name one."
        : error.reason === "host-not-github"
          ? "the GitHub sign-in pilot serves github.com only."
          : "--repo or GH_REPO is not a repository (OWNER/REPO).",
    );
    return 1;
  }
  if (owner === null) {
    const origin = await host.readOrigin().catch(() => null);
    owner = origin === null ? null : ownerOfRemote(origin);
  }
  const { organization, foreign } = chooseOrganization(config, owner);
  const answer = await organizationToken({
    paths: host.paths,
    organization,
    http: host.http,
    now: host.now,
  });
  if (answer.kind !== "token") {
    say(tokenAdvice(organization.login, answer));
    // gh's own status for a missing sign-in.
    return answer.kind === "signed-out" ? 4 : 1;
  }
  const code = await host.runGh(gh, args, {
    ...withoutTokens(host.env),
    GH_TOKEN: answer.token,
  });
  if (code !== 0 && foreign !== null)
    host.writeStderr(`${foreignNotice(config, foreign, "gh")}\n`);
  return code;
}

/** The official gh on this process's terminal. The launcher waits for it and
 * exits with its status; a terminal's Ctrl-C reaches both (one process
 * group), a SIGTERM or SIGHUP sent to the launcher is passed on. */
export function runInherited(
  gh: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(gh, [...args], { env: { ...env }, stdio: "inherit" });
    const forward = (signal: NodeJS.Signals) => () => {
      child.kill(signal);
    };
    const handlers: [NodeJS.Signals, () => void][] = [
      ["SIGTERM", forward("SIGTERM")],
      ["SIGHUP", forward("SIGHUP")],
      // gh gets the terminal's own Ctrl-C; the launcher only outlives it.
      ["SIGINT", () => undefined],
    ];
    for (const [signal, handler] of handlers) process.on(signal, handler);
    let settled = false;
    const done = (code: number) => {
      if (settled) return;
      settled = true;
      for (const [signal, handler] of handlers)
        process.removeListener(signal, handler);
      resolve(code);
    };
    child.once("error", () => done(127));
    child.once("exit", (code, signal) =>
      done(
        code ??
          (signal === null ? 1 : 128 + (osConstants.signals[signal] ?? 0)),
      ),
    );
  });
}

/** `git remote get-url origin` in the working directory, bounded. */
export function checkoutOrigin(
  env: Readonly<Record<string, string | undefined>>,
): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn("git", ["remote", "get-url", "origin"], {
      env: withoutTokens(env),
      stdio: ["ignore", "pipe", "ignore"],
    });
    let output = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (output.length < 4096) output += chunk;
    });
    child.once("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0 && output.trim() !== "" ? output.trim() : null);
    });
  });
}
