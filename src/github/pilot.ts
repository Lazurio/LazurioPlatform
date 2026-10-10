import { chmod, lstat, mkdir, readFile, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { withFolderReadLock } from "../folder/lock";
import { inspectOwnedDirectory } from "../folder/owned-directory";
import type { PresetName } from "../folder/presets";
import { readFolderState } from "../folder/read-state";
import { parseUniqueJson } from "../providers/unique-json";
import { writeDurableFile } from "../update/durable-file";

// The pilot switch of the Organization-scoped GitHub sign-in (decision F46,
// a pilot under root decision 0192): one configuration file of the
// Environment user. Without it nothing of this module changes anything: no
// command of `lazurio github` but `pilot enable` and `status` acts, the
// launcher and the Git helper are not wired, doctor adds no row and the
// curated gh sign-in of F19 is untouched. The file names the Organizations
// whose own private sign-in app this Environment may sign in to (the first
// is the owning Organization, used when a command names no repository) and,
// once wired, what `pilot wire` replaced, so `pilot unwire` restores it.
//
//   ${XDG_CONFIG_HOME:-~/.config}/lazurio/github/          0700
//     pilot.json        0600  the switch: Organizations and the wiring record
//     pilot.gitconfig   0600  the Git include `pilot wire` writes
//   ${XDG_STATE_HOME:-~/.local/state}/lazurio/github/      0700
//     <login>.json      0600  one Organization's sign-in (store.ts)
//     <login>.lock      0600  its kernel lock (refresh, sign-in, sign-out)
//     gh                0755  the official gh, moved aside by `pilot wire`
//
// Nothing here is secret but the sign-in files; the client id of a GitHub App
// is public.

export const pilotSchema = "lazurio.github-sign-in-pilot.v1";

export type PilotPaths = Readonly<{
  configDirectory: string;
  config: string;
  gitInclude: string;
  stateDirectory: string;
  /** Where `pilot wire` keeps the official gh it moved out of the entry. */
  savedGh: string;
  /** The standard entry of gh (decision 0161): `~/.local/bin/gh`. */
  ghEntry: string;
}>;

const xdgDirectory = (
  env: Readonly<Record<string, string | undefined>>,
  name: "XDG_CONFIG_HOME" | "XDG_STATE_HOME",
  home: string,
  fallback: readonly string[],
) => {
  // A relative XDG directory is invalid and ignored, as for the install base.
  const value = env[name];
  return value !== undefined && value !== "" && isAbsolute(value)
    ? value
    : join(home, ...fallback);
};

/** The pilot's paths for an absolute HOME; undefined without one. */
export function pilotPaths(
  env: Readonly<Record<string, string | undefined>>,
): PilotPaths | undefined {
  const home = env.HOME;
  if (home === undefined || !isAbsolute(home)) return undefined;
  const configDirectory = join(
    xdgDirectory(env, "XDG_CONFIG_HOME", home, [".config"]),
    "lazurio",
    "github",
  );
  const stateDirectory = join(
    xdgDirectory(env, "XDG_STATE_HOME", home, [".local", "state"]),
    "lazurio",
    "github",
  );
  return Object.freeze({
    configDirectory,
    config: join(configDirectory, "pilot.json"),
    gitInclude: join(configDirectory, "pilot.gitconfig"),
    stateDirectory,
    savedGh: join(stateDirectory, "gh"),
    ghEntry: join(home, ".local", "bin", "gh"),
  });
}

// GitHub logins: letters, digits and single inner hyphens, at most 39.
const loginPattern = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
export const isGithubLogin = (value: unknown): value is string =>
  typeof value === "string" && loginPattern.test(value);

/** A GitHub App's client id (`Iv1.…`, `Iv23li…`). An OAuth App's id (the
 * GitHub CLI's included) is refused: its tokens reach every Organization of
 * the person, which is exactly what this pilot ends. */
export const isAppClientId = (value: unknown): value is string =>
  typeof value === "string" && /^Iv[A-Za-z0-9.]{6,62}$/.test(value);

export const sameLogin = (a: string, b: string) =>
  a.toLowerCase() === b.toLowerCase();

export type PilotOrganization = Readonly<{ login: string; clientId: string }>;

/** What `pilot wire` found at `~/.local/bin/gh` and did with it:
 * - `file`: the official binary itself, moved to `savedGh` (`real`);
 * - `link`: a symbolic link (`target`, its literal text), replaced by the
 *   launcher and recreated by `unwire`; `real` is where it led;
 * - `absent`: no entry, gh found elsewhere on PATH (`real`); the launcher is
 *   created and removed again by `unwire`. */
export type GhWiring =
  | Readonly<{ previous: "file"; real: string }>
  | Readonly<{ previous: "link"; real: string; target: string }>
  | Readonly<{ previous: "absent"; real: string }>;

export type PilotWiring = Readonly<{
  /** The Lazurio executable the launcher and the Git helper run. */
  executable: string;
  gh: GhWiring;
  wiredAt: string;
}>;

export type PilotConfig = Readonly<{
  schema: typeof pilotSchema;
  /** The first is the owning Organization (O3); the others are explicit
   * additional sign-ins, selected by repository owner. */
  organizations: readonly PilotOrganization[];
  wiring: PilotWiring | null;
}>;

export const maxOrganizations = 10;

function plainObject(input: unknown): Record<string, unknown> | null {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    return null;
  const prototype = Object.getPrototypeOf(input);
  return prototype === Object.prototype || prototype === null
    ? (input as Record<string, unknown>)
    : null;
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const present = Object.keys(value).sort();
  return (
    present.length === keys.length &&
    [...keys].sort().every((key, index) => present[index] === key)
  );
}

/** An absolute path Lazurio writes into a shell line and a Git config value:
 * no quote, backslash or control character, so single quotes protect it. */
export const isPlainAbsolutePath = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length <= 1024 &&
  isAbsolute(value) &&
  !/['"\\\p{Cc}]/u.test(value);

const isTime = (value: unknown): value is string =>
  typeof value === "string" &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value) &&
  Number.isFinite(Date.parse(value));

function parseGhWiring(input: unknown): GhWiring {
  const value = plainObject(input);
  if (value === null) throw new Error("Invalid pilot wiring");
  if (
    value.previous === "link" &&
    exactKeys(value, ["previous", "real", "target"]) &&
    isPlainAbsolutePath(value.real) &&
    typeof value.target === "string" &&
    value.target.length > 0 &&
    value.target.length <= 1024
  )
    return Object.freeze({
      previous: "link",
      real: value.real,
      target: value.target,
    });
  if (
    (value.previous === "file" || value.previous === "absent") &&
    exactKeys(value, ["previous", "real"]) &&
    isPlainAbsolutePath(value.real)
  )
    return Object.freeze({ previous: value.previous, real: value.real });
  throw new Error("Invalid pilot wiring");
}

/** The configuration only in its exact form; anything else is refused and
 * never echoed. */
export function parsePilotConfig(input: unknown): PilotConfig {
  const value = plainObject(input);
  if (
    value === null ||
    !exactKeys(value, ["schema", "organizations", "wiring"]) ||
    value.schema !== pilotSchema ||
    !Array.isArray(value.organizations) ||
    value.organizations.length === 0 ||
    value.organizations.length > maxOrganizations
  )
    throw new Error("Invalid pilot configuration");
  const organizations = value.organizations.map((entry) => {
    const organization = plainObject(entry);
    if (
      organization === null ||
      !exactKeys(organization, ["login", "clientId"]) ||
      !isGithubLogin(organization.login) ||
      !isAppClientId(organization.clientId)
    )
      throw new Error("Invalid pilot configuration");
    return Object.freeze({
      login: organization.login,
      clientId: organization.clientId,
    });
  });
  const logins = new Set(
    organizations.map((entry) => entry.login.toLowerCase()),
  );
  const clients = new Set(organizations.map((entry) => entry.clientId));
  if (
    logins.size !== organizations.length ||
    clients.size !== organizations.length
  )
    throw new Error("Invalid pilot configuration");
  let wiring: PilotWiring | null = null;
  if (value.wiring !== null) {
    const wired = plainObject(value.wiring);
    if (
      wired === null ||
      !exactKeys(wired, ["executable", "gh", "wiredAt"]) ||
      !isPlainAbsolutePath(wired.executable) ||
      !isTime(wired.wiredAt)
    )
      throw new Error("Invalid pilot configuration");
    wiring = Object.freeze({
      executable: wired.executable,
      gh: parseGhWiring(wired.gh),
      wiredAt: wired.wiredAt,
    });
  }
  return Object.freeze({
    schema: pilotSchema,
    organizations: Object.freeze(organizations),
    wiring,
  });
}

/** Creates an owner-only directory, refusing a link or anything else in its
 * place. */
export async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const entry = await lstat(directory);
  if (!entry.isDirectory() || entry.isSymbolicLink())
    throw new Error("Pilot directory is not a directory");
  await chmod(directory, 0o700);
}

export type PilotRead =
  | Readonly<{ kind: "off" }>
  | Readonly<{ kind: "on"; config: PilotConfig }>
  /** The file is there but is not the configuration: the pilot counts as on
   * (every gate refuses), and nothing of it is used. */
  | Readonly<{ kind: "unreadable" }>;

export async function readPilot(paths: PilotPaths): Promise<PilotRead> {
  let text: string;
  try {
    const entry = await lstat(paths.config);
    if (!entry.isFile()) return Object.freeze({ kind: "unreadable" });
    text = await readFile(paths.config, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return Object.freeze({ kind: "off" });
    return Object.freeze({ kind: "unreadable" });
  }
  try {
    return Object.freeze({
      kind: "on",
      config: parsePilotConfig(parseUniqueJson(text)),
    });
  } catch {
    return Object.freeze({ kind: "unreadable" });
  }
}

export async function writePilot(
  paths: PilotPaths,
  config: PilotConfig,
): Promise<void> {
  // Validate what is written exactly as what is read.
  const checked = parsePilotConfig(JSON.parse(JSON.stringify(config)));
  await ensurePrivateDirectory(paths.configDirectory);
  await writeDurableFile(
    paths.configDirectory,
    "pilot.json",
    Buffer.from(`${JSON.stringify(checked, null, 2)}\n`),
  );
}

export async function removePilot(paths: PilotPaths): Promise<void> {
  await rm(paths.config, { force: true });
}

/** The configured Organization of a login (GitHub logins ignore case). */
export const configuredOrganization = (
  config: PilotConfig,
  login: string,
): PilotOrganization | undefined =>
  config.organizations.find((entry) => sameLogin(entry.login, login));

export const owningOrganization = (config: PilotConfig): PilotOrganization =>
  config.organizations[0] as PilotOrganization;

// ---- The Work Environment ---------------------------------------------------

/** The person a sign-in must be: the GitHub account the Organization
 * assigned this Work Environment to (`owner.assignment` of the handover,
 * recorded in the Folder's binding). */
export type GithubSubject = Readonly<{ login: string; id: number }>;

export type WorkEnvironment =
  | Readonly<{ kind: "work"; subject: GithubSubject; preset: PresetName }>
  | Readonly<{
      kind: "refused";
      reason: /** Not a Remote Environment of this account: no hosted Folder. */
        | "not-hosted"
        /** A Remote Environment, but not an individual Work Environment
         * (`hosted-organization-personal`): a Team Environment works through
         * Lazurio for GitHub, a personal one keeps its own sign-in. */
        | "not-work-environment"
        /** The hosted context is there but cannot be read (#83). */
        | "environment-unreadable"
        /** The binding names no assigned operator, so no account can be
         * checked. */
        | "subject-unknown";
      preset?: PresetName;
    }>;

/** The pilot runs on an individual Work Environment only, signed in as the
 * person the Organization assigned it to; read from the hosted operator
 * Folder (the handover's seam, as `tools login` reads its preset). */
export async function workEnvironment(
  hostedFolder: (() => Promise<string | undefined>) | undefined,
): Promise<WorkEnvironment> {
  const refused = (
    reason: Extract<WorkEnvironment, { kind: "refused" }>["reason"],
    preset?: PresetName,
  ): WorkEnvironment =>
    Object.freeze({
      kind: "refused",
      reason,
      ...(preset === undefined ? {} : { preset }),
    });
  let folder: string | undefined;
  try {
    folder = await hostedFolder?.();
  } catch {
    return refused("environment-unreadable");
  }
  if (folder === undefined) return refused("not-hosted");
  let preferences: Awaited<ReturnType<typeof readFolderState>>["preferences"];
  try {
    await inspectOwnedDirectory(folder);
    const stateDirectory = join(folder, ".lazurio");
    preferences = await withFolderReadLock(
      stateDirectory,
      async () => (await readFolderState(stateDirectory)).preferences,
    );
  } catch {
    return refused("environment-unreadable");
  }
  const preset = preferences.preset.name;
  if (preset !== "hosted-organization-personal")
    return refused("not-work-environment", preset);
  const owner = preferences.machine?.owner;
  const assignment =
    owner?.kind === "organization" ? owner.assignment : undefined;
  if (assignment === undefined || assignment.kind !== "operator")
    return refused("subject-unknown", preset);
  return Object.freeze({
    kind: "work",
    preset,
    subject: Object.freeze({
      login: assignment.githubLogin,
      id: assignment.githubId,
    }),
  });
}

/** The curated gh sign-in and sign-out of decision F19 while gh and Git are
 * wired to this pilot: an account-wide sign-in and an account SSH key are
 * what the pilot replaces, and through the launcher neither could work, so
 * they are refused with the way that applies instead. Before `pilot wire`
 * (and after `unwire`) they work as everywhere: that is the migration and the
 * rollback path. An unreadable switch refuses too (fail closed). */
export async function pilotRefusesCuratedGh(
  env: Readonly<Record<string, string | undefined>>,
): Promise<Readonly<{ owning: string | null }> | undefined> {
  const paths = pilotPaths(env);
  if (paths === undefined) return undefined;
  const pilot = await readPilot(paths);
  if (pilot.kind === "off") return undefined;
  if (pilot.kind === "unreadable") return Object.freeze({ owning: null });
  if (pilot.config.wiring === null) return undefined;
  return Object.freeze({ owning: owningOrganization(pilot.config).login });
}
