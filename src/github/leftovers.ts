import { readdir, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { resolveOnPath } from "../tools/status";
import type { PilotWiring } from "./pilot";
import {
  githubCredentialHelpers,
  helperCommand,
  type WiringHost,
} from "./wiring";

// What else in this Environment can reach GitHub as the person, beyond the
// pilot's Organization sign-ins (decision F46, the migration of root decision
// 0192's work Environments). Each of these reaches every Organization of the
// person, so while one is left the boundary of the pilot is not the
// Environment's. Found without reading or printing a value: a file is named,
// a variable is named, never their content.

export type LeftoverKind =
  /** gh's own stored sign-in (its hosts file), what `gh auth login` left. */
  | "gh-sign-in"
  /** A `github.com` line in Git's plain credential store. */
  | "git-credentials"
  /** `GH_TOKEN`/`GITHUB_TOKEN` in this process or a shell startup file. */
  | "token-variable"
  /** Git consults another credential helper for github.com. */
  | "git-helper"
  /** `ssh git@github.com` still authenticates as a person (only checked on
   * request: it contacts GitHub). */
  | "ssh-key";

export type Leftover = Readonly<{
  kind: LeftoverKind;
  /** `~/…` for a file under the home, else the absolute path. */
  file?: string;
  variable?: string;
}>;

export const tokenVariableNames = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
] as const;

const shown = (path: string, home: string) =>
  path === home
    ? "~"
    : path.startsWith(`${home}/`)
      ? `~/${path.slice(home.length + 1)}`
      : path;

const readText = (path: string) => readFile(path, "utf8").catch(() => null);

const absolute = (value: string | undefined) =>
  value !== undefined && value !== "" && isAbsolute(value) ? value : undefined;

/** gh's configuration directory as gh resolves it. */
function ghConfigDirectory(
  env: Readonly<Record<string, string | undefined>>,
  home: string,
): string {
  return (
    absolute(env.GH_CONFIG_DIR) ??
    join(absolute(env.XDG_CONFIG_HOME) ?? join(home, ".config"), "gh")
  );
}

// The shell and session files a token variable is commonly exported from.
const startupFiles = [
  ".profile",
  ".bashrc",
  ".bash_profile",
  ".bash_login",
  ".zshrc",
  ".zshenv",
  ".zprofile",
  ".pam_environment",
];
const tokenLine = new RegExp(
  `^\\s*(?:export\\s+)?(${tokenVariableNames.join("|")})\\s*=`,
  "m",
);

export type LeftoverHost = WiringHost &
  Readonly<{
    /** Runs `ssh -T git@github.com` (only with `ssh: true`). */
    ssh: boolean;
    wiring: PilotWiring | null;
  }>;

export type LeftoverReport = Readonly<{
  leftovers: readonly Leftover[];
  /** `checked` when ssh was asked, `unknown` when it could not tell. */
  ssh: "not-checked" | "checked" | "unknown";
}>;

export async function findLeftovers(
  host: LeftoverHost,
): Promise<LeftoverReport> {
  const home = host.env.HOME;
  const found: Leftover[] = [];
  if (home === undefined || !isAbsolute(home))
    return { leftovers: [], ssh: "not-checked" };

  const hosts = join(ghConfigDirectory(host.env, home), "hosts.yml");
  if (/^github\.com:[ \t]*$/m.test((await readText(hosts)) ?? ""))
    found.push({ kind: "gh-sign-in", file: shown(hosts, home) });

  for (const path of [
    join(home, ".git-credentials"),
    join(
      absolute(host.env.XDG_CONFIG_HOME) ?? join(home, ".config"),
      "git",
      "credentials",
    ),
  ]) {
    const text = await readText(path);
    if (text === null) continue;
    const github = text.split("\n").some((line) => {
      try {
        return new URL(line.trim()).hostname.toLowerCase() === "github.com";
      } catch {
        return false;
      }
    });
    if (github)
      found.push({ kind: "git-credentials", file: shown(path, home) });
  }

  for (const variable of tokenVariableNames) {
    const value = host.env[variable];
    if (value !== undefined && value !== "")
      found.push({ kind: "token-variable", variable });
  }
  const environmentDirectory = join(
    absolute(host.env.XDG_CONFIG_HOME) ?? join(home, ".config"),
    "environment.d",
  );
  const environmentFiles = (await readdir(environmentDirectory).catch(() => []))
    .filter((name) => name.endsWith(".conf"))
    .sort()
    .map((name) => join(environmentDirectory, name));
  for (const path of [
    ...startupFiles.map((name) => join(home, name)),
    ...environmentFiles,
  ]) {
    const match = tokenLine.exec((await readText(path)) ?? "");
    if (match !== null)
      found.push({
        kind: "token-variable",
        variable: match[1] as string,
        file: shown(path, home),
      });
  }

  const helpers = await githubCredentialHelpers(host);
  const own =
    host.wiring === null ? null : helperCommand(host.wiring.executable);
  if (helpers?.some((helper) => helper !== own))
    found.push({ kind: "git-helper" });

  let ssh: LeftoverReport["ssh"] = "not-checked";
  if (host.ssh) {
    const command = await resolveOnPath("ssh", host.env.PATH, host.platform);
    if (command === undefined) ssh = "unknown";
    else {
      const result = await host.run(
        [
          command,
          "-T",
          "-o",
          "BatchMode=yes",
          "-o",
          "ConnectTimeout=10",
          "-o",
          "StrictHostKeyChecking=yes",
          "git@github.com",
        ],
        20_000,
        { HOME: home, PATH: host.env.PATH ?? "/usr/bin:/bin", LANG: "C" },
      );
      if (result === "timeout") ssh = "unknown";
      else {
        const output = `${result.stdout}\n${result.stderr}`;
        if (/You've successfully authenticated/.test(output)) {
          ssh = "checked";
          found.push({ kind: "ssh-key" });
        } else if (/Permission denied \(publickey/.test(output))
          ssh = "checked";
        else ssh = "unknown";
      }
    }
  }
  return Object.freeze({ leftovers: Object.freeze(found), ssh });
}

/** What to do about one leftover, in plain words. */
export function leftoverAdvice(leftover: Leftover): string {
  switch (leftover.kind) {
    case "gh-sign-in":
      return `gh still keeps an account-wide sign-in (${leftover.file}). Remove it: gh auth logout --hostname github.com (the pilot's gh runs it without the Organization sign-ins). It is not revoked at GitHub; that would sign you out of gh everywhere.`;
    case "git-credentials":
      return `${leftover.file} holds a github.com credential for Git. Remove that line; Git uses the pilot's helper.`;
    case "token-variable":
      return leftover.file === undefined
        ? `${leftover.variable} is set in this process's environment. Unset it where it is exported.`
        : `${leftover.file} exports ${leftover.variable}. Remove that line and start a new session.`;
    case "git-helper":
      return "Git consults another credential helper for github.com after the pilot's (git config --global --get-all credential.https://github.com.helper). Remove it.";
    case "ssh-key":
      return "An SSH key in this Environment still signs in to GitHub as a person (ssh -T git@github.com). Remove it under GitHub Settings → SSH and GPG keys (https://github.com/settings/keys); git already uses HTTPS here.";
  }
}
