import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  assignedEnvironments,
  type MachineBinding,
  type MachinePeerHostKey,
} from "../folder/machine-binding";
import { syncDirectory } from "../update/durable-file";
import { utcInstant } from "./access-service";

// SSH from this Environment into the Environments it may reach (root
// decision 0224; before it, root decision 0192's addendum of 2026-10-26,
// points (c) to (e), plan DEV-6676 P2). The routes come from one of two
// sources, never both: the access service's `GET /v1/targets` when the
// handover declares the service (`access-service.ts`, `routes.ts`), else a
// personal Machine's assigned peers in the recorded binding. This module
// writes them, and only them, into the account's SSH configuration:
//
// - `~/.ssh/config.d/lazurio-environments.conf` (0600), one `Host` block per
//   Environment id, pinned to its host keys, with this Environment's one
//   key, no agent or port forwarding and no jump host, and the route's
//   deadline as a comment when the service gave one;
// - `~/.ssh/known_hosts_lazurio_environments` (0644), `<id> <type> <key>`;
// - one `Include` line at the top of `~/.ssh/config`, before any `Host` or
//   `Match` block, so that it applies to every host; the person's own lines
//   are kept byte for byte, and a missing file is created 0600.
//
// The Platform is the only writer of the first two files, which say so on
// their first line; a file at either path without that line is the person's
// and is never overwritten or removed. A symlinked `~/.ssh`, `~/.ssh/config.d`
// or file, a file of another account and anything but a regular file are
// refused too. Without routes the two files are removed when they are ours and
// nothing is created; the `Include` line stays, since OpenSSH skips an
// `Include` that matches no file. Every write replaces a file in one rename;
// a file with the same bytes and mode is not touched, so a second run changes
// nothing.

export const environmentsConfigPath =
  "~/.ssh/config.d/lazurio-environments.conf";
export const environmentsKnownHostsPath =
  "~/.ssh/known_hosts_lazurio_environments";
/** The source Environment's own key (root decision 0224): created inside it
 * (`source-key.ts`), never copied out. */
export const environmentKeyPath = "~/.ssh/lazurio-environment-ed25519";
export const sshConfigPath = "~/.ssh/config";
/** The first line of both files the Platform writes: its ownership mark. */
export const managedHeader =
  "# Spravuje Lazurio (LazurioPlatform). Neupravujte; přepíše se.";
/** The mark of the files the first release wrote; still the Platform's. */
export const legacyManagedHeader =
  "# Spravuje Lazurio (LazurioPlatform) z handoveru tohoto Prostředí. Neupravujte; přepíše se.";
export const includeLine = `Include ${environmentsConfigPath}`;
/** The comment that carries a route's deadline in its block. */
const validUntilMark = "  # valid_until ";

const maxFileBytes = 1024 * 1024;

/** One route from this Environment to another: its Environment id (the
 * `Host` alias), the target's host name and account and its pinned host
 * keys. A route from the access service also carries its deadline; one
 * from the handover's assigned peers has none. */
export type EnvironmentRoute = Readonly<{
  environment: string;
  host: string;
  user: string;
  hostKeys: readonly MachinePeerHostKey[];
  validUntil?: string;
}>;

/** The config's text: the header and one block per Environment. Every
 * block pins its host keys under its own alias, uses only this
 * Environment's one key, forwards nothing (no agent, no port, no jump) and
 * shares no connection, whatever the person's own `Host *` says (the first value OpenSSH obtains
 * wins, and the `Include` stands first). */
export function renderEnvironmentsConfig(
  environments: readonly EnvironmentRoute[],
): string {
  return [
    managedHeader,
    ...environments.flatMap((entry) => [
      "",
      `Host ${entry.environment}`,
      ...(entry.validUntil === undefined
        ? []
        : [`${validUntilMark}${entry.validUntil}`]),
      `  HostName ${entry.host}`,
      `  User ${entry.user}`,
      `  HostKeyAlias ${entry.environment}`,
      `  UserKnownHostsFile ${environmentsKnownHostsPath}`,
      "  StrictHostKeyChecking yes",
      `  IdentityFile ${environmentKeyPath}`,
      "  IdentitiesOnly yes",
      "  ForwardAgent no",
      "  ProxyJump none",
      "  ClearAllForwardings yes",
      // No shared connection: a master the person's own `Host *` opened
      // to another endpoint, or to this id's old route, is never reused.
      "  ControlMaster no",
      "  ControlPath none",
    ]),
    "",
  ].join("\n");
}

/** The pinned host keys: the header and a line per key. */
export function renderEnvironmentsKnownHosts(
  environments: readonly EnvironmentRoute[],
): string {
  return [
    managedHeader,
    ...environments.flatMap((entry) =>
      entry.hostKeys.map(
        (hostKey) => `${entry.environment} ${hostKey.type} ${hostKey.key}`,
      ),
    ),
    "",
  ].join("\n");
}

// Every value is one token of the binding's own shapes; a token with space,
// quote, `%`, `#` or a control character would change the meaning of the
// config, so it is refused before anything is written.
const token = /^[A-Za-z0-9._+/=@-]+$/;
function checkedRoutes(routes: readonly EnvironmentRoute[]) {
  const seen = new Set<string>();
  for (const entry of routes) {
    for (const value of [
      entry.environment,
      entry.host,
      entry.user,
      ...entry.hostKeys.flatMap(({ type, key }) => [type, key]),
    ])
      if (!token.test(value)) throw new Error("Unsafe route value");
    if (entry.validUntil !== undefined && utcInstant(entry.validUntil) === null)
      throw new Error("Unsafe route value");
    if (entry.hostKeys.length === 0 || seen.has(entry.environment))
      throw new Error("Unsafe route value");
    seen.add(entry.environment);
  }
  return routes;
}

export type EnvironmentSshLocation = Readonly<{
  /** The account's home directory. */
  home: string;
  /** The account's uid; undefined where the platform has none. */
  uid: number | undefined;
}>;

export type EnvironmentSshRefusal =
  | "ssh-directory-unsafe"
  | "file-unsafe"
  | "file-foreign";

export type EnvironmentSshResult =
  | Readonly<{ kind: "written"; environments: readonly string[] }>
  | Readonly<{ kind: "unchanged"; environments: readonly string[] }>
  | Readonly<{ kind: "removed" }>
  | Readonly<{ kind: "none" }>
  | Readonly<{
      kind: "blocked";
      reason: EnvironmentSshRefusal;
      path: string;
    }>;

export type Observed =
  | Readonly<{ kind: "missing" }>
  | Readonly<{ kind: "file"; bytes: Buffer; mode: number }>
  | Readonly<{ kind: "refused"; reason: EnvironmentSshRefusal }>;

export class Refusal extends Error {
  constructor(
    readonly reason: string,
    readonly path: string,
  ) {
    super(reason);
  }
}

// A directory of this account, not a link to one; missing reads as such.
export async function inspectDirectory(
  path: string,
  shown: string,
  uid: number | undefined,
): Promise<"missing" | "present"> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY,
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return "missing";
    if (code === "ELOOP" || code === "ENOTDIR")
      throw new Refusal("ssh-directory-unsafe", shown);
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isDirectory() || (uid !== undefined && info.uid !== uid))
      throw new Refusal("ssh-directory-unsafe", shown);
    return "present";
  } finally {
    await handle.close();
  }
}

// A regular file of this account, opened without following a link and
// checked on the open handle; missing reads as such.
export async function readOwnFile(
  path: string,
  uid: number | undefined,
): Promise<Observed> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { kind: "missing" };
    if (code === "ELOOP") return { kind: "refused", reason: "file-unsafe" };
    throw error;
  }
  try {
    const info = await handle.stat();
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      (uid !== undefined && info.uid !== uid) ||
      info.size > maxFileBytes
    )
      return { kind: "refused", reason: "file-unsafe" };
    const bytes = await handle.readFile();
    if (bytes.length > maxFileBytes)
      return { kind: "refused", reason: "file-unsafe" };
    return { kind: "file", bytes, mode: info.mode & 0o777 };
  } finally {
    await handle.close();
  }
}

const isOurs = (bytes: Buffer) => {
  const first = bytes.toString("utf8").split("\n", 1)[0];
  return first === managedHeader || first === legacyManagedHeader;
};

// The file at a path the Platform owns: missing, ours, or refused by name.
async function ownedFile(path: string, shown: string, uid: number | undefined) {
  const observed = await readOwnFile(path, uid);
  if (observed.kind === "refused") throw new Refusal(observed.reason, shown);
  if (observed.kind === "file" && !isOurs(observed.bytes))
    throw new Refusal("file-foreign", shown);
  return observed;
}

// Replaces `directory/name` with `bytes` and exactly `mode` in one rename:
// a new file beside it, synced, renamed over the old one, and the directory
// synced, so a reader sees the old bytes or the new ones.
export async function replaceFile(
  directory: string,
  name: string,
  bytes: Uint8Array,
  mode: number,
) {
  const temporary = join(
    directory,
    `.${name}.tmp-${randomBytes(8).toString("hex")}`,
  );
  const file = await open(temporary, "wx", 0o600);
  let renamed = false;
  try {
    try {
      await file.chmod(mode);
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, join(directory, name));
    renamed = true;
  } finally {
    if (!renamed) await rm(temporary, { force: true });
  }
  await syncDirectory(directory);
}

// Whether `~/.ssh/config` already includes the file for every host: the
// exact line before its first `Host` or `Match` block.
function includesGlobally(config: Buffer): boolean {
  for (const raw of config.toString("utf8").split("\n")) {
    const line = raw.replace(/\r$/, "").trim();
    if (line === includeLine) return true;
    if (/^(?:host|match)(?:\s|=)/i.test(line)) return false;
  }
  return false;
}

/** Writes the person's SSH config for the assigned peers of this personal
 * Machine's binding, or removes it when there are none. Any other Machine is
 * left alone: its routes come only from the access service. */
export async function writeEnvironmentSsh(
  location: EnvironmentSshLocation,
  machine: MachineBinding,
): Promise<EnvironmentSshResult> {
  if (machine.kind !== "personal-vm") return { kind: "none" };
  return writeEnvironmentRoutes(location, assignedEnvironments(machine));
}

/** Writes the SSH config for exactly these routes, or removes it when there
 * are none. Refuses, changing nothing, a path that is unsafe or a file at the
 * Platform's paths that is not the Platform's. */
export async function writeEnvironmentRoutes(
  location: EnvironmentSshLocation,
  routes: readonly EnvironmentRoute[],
): Promise<EnvironmentSshResult> {
  const environments = checkedRoutes(routes);
  const ssh = join(location.home, ".ssh");
  const configDirectory = join(ssh, "config.d");
  const configName = "lazurio-environments.conf";
  const knownHostsName = "known_hosts_lazurio_environments";
  try {
    // Everything is inspected before anything is written.
    const sshState = await inspectDirectory(ssh, "~/.ssh", location.uid);
    const directoryState =
      sshState === "missing"
        ? "missing"
        : await inspectDirectory(
            configDirectory,
            "~/.ssh/config.d",
            location.uid,
          );
    const missing: Observed = { kind: "missing" };
    const conf =
      directoryState === "missing"
        ? missing
        : await ownedFile(
            join(configDirectory, configName),
            environmentsConfigPath,
            location.uid,
          );
    const knownHosts =
      sshState === "missing"
        ? missing
        : await ownedFile(
            join(ssh, knownHostsName),
            environmentsKnownHostsPath,
            location.uid,
          );
    // Without assigned peers only the Platform's own files go, and the
    // person's config is not even read.
    if (environments.length === 0) {
      if (conf.kind === "missing" && knownHosts.kind === "missing")
        return { kind: "none" };
      if (conf.kind === "file") await rm(join(configDirectory, configName));
      if (knownHosts.kind === "file") await rm(join(ssh, knownHostsName));
      return { kind: "removed" };
    }
    const config =
      sshState === "missing"
        ? missing
        : await readOwnFile(join(ssh, "config"), location.uid);
    if (config.kind === "refused")
      throw new Refusal(config.reason, sshConfigPath);

    const names = environments.map((entry) => entry.environment);
    let written = false;
    if (sshState === "missing") await mkdir(ssh, { mode: 0o700 });
    if (directoryState === "missing")
      await mkdir(configDirectory, { mode: 0o700 });
    const knownHostsBytes = Buffer.from(
      renderEnvironmentsKnownHosts(environments),
      "utf8",
    );
    if (
      knownHosts.kind !== "file" ||
      !knownHosts.bytes.equals(knownHostsBytes) ||
      knownHosts.mode !== 0o644
    ) {
      await replaceFile(ssh, knownHostsName, knownHostsBytes, 0o644);
      written = true;
    }
    const confBytes = Buffer.from(
      renderEnvironmentsConfig(environments),
      "utf8",
    );
    if (
      conf.kind !== "file" ||
      !conf.bytes.equals(confBytes) ||
      conf.mode !== 0o600
    ) {
      await replaceFile(configDirectory, configName, confBytes, 0o600);
      written = true;
    }
    if (config.kind !== "file" || !includesGlobally(config.bytes)) {
      const line = Buffer.from(`${includeLine}\n`, "utf8");
      await replaceFile(
        ssh,
        "config",
        config.kind === "file" ? Buffer.concat([line, config.bytes]) : line,
        config.kind === "file" ? config.mode : 0o600,
      );
      written = true;
    }
    return { kind: written ? "written" : "unchanged", environments: names };
  } catch (error) {
    if (error instanceof Refusal)
      return {
        kind: "blocked",
        reason: error.reason as EnvironmentSshRefusal,
        path: error.path,
      };
    throw error;
  }
}

/** The routes the Platform's own two files record now, each with its
 * deadline when it has one; empty when there are none or the files are not
 * exactly what the Platform writes (a file it cannot read back records no
 * route, so nothing is kept from it). */
export async function recordedRoutes(
  location: EnvironmentSshLocation,
): Promise<readonly EnvironmentRoute[]> {
  return (await readRecordedRoutes(location)) ?? [];
}

/** Whether either of the Platform's two route files is at its path, in any
 * form (decision F70, amendment of 2026-11-03, point 6): a base with one has
 * kept routes, so its Launchpad keeps letting expired ones go even when it
 * can no longer show that it is a hosted operator's. Anything that cannot be
 * checked counts as there: expiry only ever removes what has expired. */
export async function hasRouteFiles(
  location: EnvironmentSshLocation,
): Promise<boolean> {
  const ssh = join(location.home, ".ssh");
  for (const path of [
    join(ssh, "config.d", "lazurio-environments.conf"),
    join(ssh, "known_hosts_lazurio_environments"),
  ]) {
    try {
      await lstat(path);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") return true;
    }
  }
  return false;
}

// The recorded routes: empty when neither file is there, null when anything
// is there that cannot be read back exactly as the Platform writes it.
async function readRecordedRoutes(
  location: EnvironmentSshLocation,
): Promise<readonly EnvironmentRoute[] | null> {
  const ssh = join(location.home, ".ssh");
  let conf: Observed;
  let known: Observed;
  try {
    conf = await readOwnFile(
      join(ssh, "config.d", "lazurio-environments.conf"),
      location.uid,
    );
    known = await readOwnFile(
      join(ssh, "known_hosts_lazurio_environments"),
      location.uid,
    );
  } catch {
    return null;
  }
  if (conf.kind === "missing" && known.kind === "missing") return [];
  if (
    conf.kind !== "file" ||
    known.kind !== "file" ||
    !isOurs(conf.bytes) ||
    !isOurs(known.bytes)
  )
    return null;
  const keys = new Map<string, MachinePeerHostKey[]>();
  for (const line of known.bytes.toString("utf8").split("\n").slice(1)) {
    if (line === "") continue;
    const [alias, type, key, extra] = line.split(" ");
    if (
      alias === undefined ||
      type !== "ssh-ed25519" ||
      key === undefined ||
      extra !== undefined
    )
      return null;
    keys.set(alias, [...(keys.get(alias) ?? []), { type, key }]);
  }
  const routes: EnvironmentRoute[] = [];
  const blocks = conf.bytes.toString("utf8").split("\n\nHost ").slice(1);
  for (const block of blocks) {
    const [environment, ...lines] = block.split("\n");
    const fields = new Map<string, string>();
    for (const line of lines) {
      if (line === "") continue;
      if (line.startsWith(validUntilMark))
        fields.set("validUntil", line.slice(validUntilMark.length));
      else {
        const match = /^ {2}([A-Za-z]+) (\S+)$/.exec(line);
        if (match === null) return null;
        fields.set(match[1] as string, match[2] as string);
      }
    }
    const host = fields.get("HostName");
    const user = fields.get("User");
    const hostKeys =
      environment === undefined ? undefined : keys.get(environment);
    if (
      environment === undefined ||
      host === undefined ||
      user === undefined ||
      hostKeys === undefined
    )
      return null;
    const validUntil = fields.get("validUntil");
    routes.push({
      environment,
      host,
      user,
      hostKeys,
      ...(validUntil === undefined ? {} : { validUntil }),
    });
  }
  try {
    return checkedRoutes(routes);
  } catch {
    return null;
  }
}

/** Without an answer of the service: keeps only the recorded routes whose
 * deadline is still ahead, and adds nothing. A route without a deadline
 * (written from the handover) is not the service's and goes too. */
export async function pruneEnvironmentRoutes(
  location: EnvironmentSshLocation,
  now: number,
): Promise<EnvironmentSshResult> {
  const kept = (await recordedRoutes(location)).filter((route) => {
    const until =
      route.validUntil === undefined ? null : utcInstant(route.validUntil);
    return until !== null && until > now;
  });
  return writeEnvironmentRoutes(location, kept);
}

/** Without a declared service (decision F70, amendment of 2026-11-03,
 * point 6): drops the recorded routes whose deadline has passed and adds
 * nothing. A route without a deadline (a personal Machine's assigned peers
 * from the handover) stays; when nothing has expired no file is touched.
 * The Platform's own files that cannot be read back are removed, since
 * nothing shows their deadlines; a file of the person's is refused as
 * always. */
export async function expireEnvironmentRoutes(
  location: EnvironmentSshLocation,
  now: number,
): Promise<EnvironmentSshResult> {
  const recorded = await readRecordedRoutes(location);
  if (recorded === null) return writeEnvironmentRoutes(location, []);
  const kept = recorded.filter((route) => {
    if (route.validUntil === undefined) return true;
    const until = utcInstant(route.validUntil);
    return until !== null && until > now;
  });
  if (kept.length < recorded.length)
    return writeEnvironmentRoutes(location, kept);
  return kept.length === 0
    ? { kind: "none" }
    : {
        kind: "unchanged",
        environments: kept.map((route) => route.environment),
      };
}
