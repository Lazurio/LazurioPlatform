import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  type AssignedEnvironment,
  assignedEnvironments,
  type MachineBinding,
} from "../folder/machine-binding";
import { syncDirectory } from "../update/durable-file";

// SSH from the Osobní Prostředí into the Work Environments assigned to its
// owner (root decision 0192, addendum of 2026-10-26, points (c) to (e); plan
// DEV-6676 P2). The truth is the recorded binding's assigned peers; this
// module writes them, and only them, into the account's SSH configuration:
//
// - `~/.ssh/config.d/lazurio-environments.conf` (0600), one `Host` block per
//   Environment id, pinned to its host keys, with the Osobní Prostředí's one
//   key and no agent forwarding;
// - `~/.ssh/known_hosts_lazurio_environments` (0644), `<id> <type> <key>`;
// - one `Include` line at the top of `~/.ssh/config`, before any `Host` or
//   `Match` block, so that it applies to every host; the person's own lines
//   are kept byte for byte, and a missing file is created 0600.
//
// The Platform is the only writer of the first two files, which say so on
// their first line; a file at either path without that line is the person's
// and is never overwritten or removed. A symlinked `~/.ssh`, `~/.ssh/config.d`
// or file, a file of another account and anything but a regular file are
// refused too. Without assigned peers (Machines writes them only for a
// Platform that reads them) the two files are removed when they are ours and
// nothing is created; the `Include` line stays, since OpenSSH skips an
// `Include` that matches no file. Every write replaces a file in one rename;
// a file with the same bytes and mode is not touched, so a second run changes
// nothing.

export const environmentsConfigPath =
  "~/.ssh/config.d/lazurio-environments.conf";
export const environmentsKnownHostsPath =
  "~/.ssh/known_hosts_lazurio_environments";
/** The Osobní Prostředí's own key, which Machines create in it (M1). */
export const environmentKeyPath = "~/.ssh/lazurio-environment-ed25519";
export const sshConfigPath = "~/.ssh/config";
/** The first line of both files the Platform writes: its ownership mark. */
export const managedHeader =
  "# Spravuje Lazurio (LazurioPlatform) z handoveru tohoto Prostředí. Neupravujte; přepíše se.";
export const includeLine = `Include ${environmentsConfigPath}`;

const maxFileBytes = 1024 * 1024;

/** The config's text: the header and one block per Environment. */
export function renderEnvironmentsConfig(
  environments: readonly AssignedEnvironment[],
): string {
  return [
    managedHeader,
    ...environments.flatMap((entry) => [
      "",
      `Host ${entry.environment}`,
      `  HostName ${entry.host}`,
      `  User ${entry.user}`,
      `  HostKeyAlias ${entry.environment}`,
      `  UserKnownHostsFile ${environmentsKnownHostsPath}`,
      "  StrictHostKeyChecking yes",
      `  IdentityFile ${environmentKeyPath}`,
      "  IdentitiesOnly yes",
      "  ForwardAgent no",
    ]),
    "",
  ].join("\n");
}

/** The pinned host keys: the header and a line per key. */
export function renderEnvironmentsKnownHosts(
  environments: readonly AssignedEnvironment[],
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
function checkedEnvironments(machine: MachineBinding) {
  const environments = assignedEnvironments(machine);
  for (const entry of environments)
    for (const value of [
      entry.environment,
      entry.host,
      entry.user,
      ...entry.hostKeys.flatMap(({ type, key }) => [type, key]),
    ])
      if (!token.test(value)) throw new Error("Unsafe assigned peer value");
  return environments;
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

type Observed =
  | Readonly<{ kind: "missing" }>
  | Readonly<{ kind: "file"; bytes: Buffer; mode: number }>
  | Readonly<{ kind: "refused"; reason: EnvironmentSshRefusal }>;

class Refusal extends Error {
  constructor(
    readonly reason: EnvironmentSshRefusal,
    readonly path: string,
  ) {
    super(reason);
  }
}

// A directory of this account, not a link to one; missing reads as such.
async function inspectDirectory(
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
async function readFile(
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

const isOurs = (bytes: Buffer) =>
  bytes.toString("utf8").split("\n", 1)[0] === managedHeader;

// The file at a path the Platform owns: missing, ours, or refused by name.
async function ownedFile(path: string, shown: string, uid: number | undefined) {
  const observed = await readFile(path, uid);
  if (observed.kind === "refused") throw new Refusal(observed.reason, shown);
  if (observed.kind === "file" && !isOurs(observed.bytes))
    throw new Refusal("file-foreign", shown);
  return observed;
}

// Replaces `directory/name` with `bytes` and exactly `mode` in one rename:
// a new file beside it, synced, renamed over the old one, and the directory
// synced, so a reader sees the old bytes or the new ones.
async function replaceFile(
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
 * Machine's binding, or removes it when there are none. Refuses, changing
 * nothing, a path that is unsafe or a file at the Platform's paths that is
 * not the Platform's. Any other Machine is left alone. */
export async function writeEnvironmentSsh(
  location: EnvironmentSshLocation,
  machine: MachineBinding,
): Promise<EnvironmentSshResult> {
  if (machine.kind !== "personal-vm") return { kind: "none" };
  const environments = checkedEnvironments(machine);
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
        : await readFile(join(ssh, "config"), location.uid);
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
      return { kind: "blocked", reason: error.reason, path: error.path };
    throw error;
  }
}
