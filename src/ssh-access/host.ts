import { constants } from "node:fs";
import { access, open } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import type { MachineBinding } from "../folder/machine-binding";
import type { ToolsEnvironment } from "../tools/overview";
import { resolveOnPath } from "../tools/status";
import type { KeysLocation } from "./keys";

// What a person's computer needs to reach this Environment over SSH
// (decision F49): the account to sign in as, the Environment's name in its
// tailnet, and the Environment's own host key, delivered over the signed-in
// page so that the computer pins it instead of trusting it on first use.
// Read live on every request; nothing is recorded. The network grant from
// the device to the Environment is the Organization Admin's, enforced by
// Headscale: nothing here checks or opens it.

/** The tailnet name of this Environment, or why it is not known. Never
 * guessed: without a running Tailscale that names this node, there is no
 * name to give. */
export type TailnetName =
  | Readonly<{ state: "known"; dnsName: string }>
  | Readonly<{
      state: "unavailable";
      reason:
        | "tailscale-missing"
        | "tailscale-failed"
        | "tailnet-not-running"
        | "no-dns-name";
    }>;

/** The Environment's ed25519 host key, `ssh-ed25519 <base64>` without the
 * comment. */
export type HostKey = Readonly<{ type: "ssh-ed25519"; key: string }>;

/** Where SSH access reads and writes, for the account this process runs
 * as. Trusted composition, never HTTP input; tests supply a temporary home,
 * a host key file of their own and a tailnet answer. */
export type SshAccessHost = KeysLocation &
  Readonly<{
    /** The platform: Windows has no `authorized_keys` handled here. */
    platform: string;
    /** The OS account a device signs in as. */
    user: string;
    /** Today's date as the marker writes it (UTC, `YYYY-MM-DD`). */
    today: () => string;
    /** The Environment's public ed25519 host key file. */
    hostKeyPath: string;
    tailnet: () => Promise<TailnetName>;
    machine?: MachineBinding | null;
    folder?: string;
  }>;

const dnsName =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** This node's name from `tailscale status --json`: `Self.DNSName` without
 * its trailing dot, while the backend runs and MagicDNS names it. */
export function tailnetOfStatus(stdout: string): TailnetName {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    return { state: "unavailable", reason: "tailscale-failed" };
  }
  if (value === null || typeof value !== "object")
    return { state: "unavailable", reason: "tailscale-failed" };
  const status = value as Record<string, unknown>;
  if (status.BackendState !== "Running")
    return { state: "unavailable", reason: "tailnet-not-running" };
  const tailnet = status.CurrentTailnet as Record<string, unknown> | undefined;
  const self = status.Self as Record<string, unknown> | undefined;
  const name =
    typeof self?.DNSName === "string"
      ? self.DNSName.replace(/\.$/, "").toLowerCase()
      : "";
  if (tailnet?.MagicDNSEnabled === false || !dnsName.test(name))
    return { state: "unavailable", reason: "no-dns-name" };
  return { state: "known", dnsName: name };
}

const tailscaleApp = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";

/** Asks this account's Tailscale for the node's name: the `tailscale` on
 * the PATH, on macOS also the app's own command. */
export async function readTailnet(
  tools: ToolsEnvironment,
): Promise<TailnetName> {
  let command = await resolveOnPath("tailscale", tools.path, tools.platform);
  if (command === undefined && tools.platform === "darwin")
    command = await access(tailscaleApp, constants.X_OK).then(
      () => tailscaleApp,
      () => undefined,
    );
  if (command === undefined)
    return { state: "unavailable", reason: "tailscale-missing" };
  const env: Record<string, string> = {};
  if (tools.path) env.PATH = tools.path;
  if (tools.home) env.HOME = tools.home;
  try {
    const result = await tools.run([command, "status", "--json"], 5_000, env, {
      maxBytes: 4 * 1024 * 1024,
    });
    if (result === "timeout" || result.exitCode !== 0)
      return { state: "unavailable", reason: "tailscale-failed" };
    return tailnetOfStatus(result.stdout);
  } catch {
    return { state: "unavailable", reason: "tailscale-failed" };
  }
}

/** The host key in a `.pub` file's first line, when it is a complete
 * ed25519 key; its comment (often the host's name) is dropped. */
export function hostKeyOf(text: string): HostKey | null {
  const [type, field] = (text.split(/\r?\n/)[0] ?? "").trim().split(/\s+/);
  if (type !== "ssh-ed25519" || field === undefined) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(field)) return null;
  const blob = Buffer.from(field, "base64");
  // string "ssh-ed25519" (4 + 11) and the 32-byte key (4 + 32).
  if (
    blob.length !== 51 ||
    blob.readUInt32BE(0) !== 11 ||
    blob.subarray(4, 15).toString("latin1") !== "ssh-ed25519" ||
    blob.readUInt32BE(15) !== 32
  )
    return null;
  return { type, key: blob.toString("base64") };
}

/** Reads the host key file, at most 16 KiB; null when it is missing or no
 * ed25519 key. */
export async function readHostKey(path: string): Promise<HostKey | null> {
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > 16 * 1024) return null;
      return hostKeyOf(await handle.readFile("utf8"));
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

/** The name a computer gives this Environment in its SSH config: the first
 * label of the tailnet name, which is the node's own name. */
export function sshAlias(
  name: string,
  machine?: MachineBinding | null,
): string | null {
  if (machine) {
    const owner = machine.owner;
    const scoped =
      owner.kind === "organization"
        ? `lazurio.org.${owner.organization}.${machine.name}`
        : `lazurio.personal.${owner.githubLogin}.${machine.name}`;
    // Dots delimit the independently validated GitHub and Machine names.
    // A hyphen-only concatenation would collide for org a-b/c and a/b-c.
    return /^[a-z0-9.-]{1,200}$/.test(scoped.toLowerCase())
      ? scoped.toLowerCase()
      : null;
  }
  const alias = name.split(".")[0] ?? "";
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(alias) ? alias : null;
}

/** What a computer writes to reach this Environment: an OpenSSH `Host`
 * block and the host key line, in a known_hosts file of their own and under
 * the alias (`HostKeyAlias`), so that tailnets reusing the same 100.64.x
 * addresses never meet in one entry. */
export type ComputerSettings = Readonly<{
  state: "ready";
  alias: string;
  /** The key the computer signs in with, in OpenSSH's `~` form. */
  keyPath: string;
  /** The `Host` block for `~/.ssh/config`. */
  config: string;
  /** The line for `~/.ssh/known_hosts_lazurio`. */
  knownHosts: string;
  /** An optional desktop handoff, absent for callers without a Folder. */
  codex?: Readonly<{ projectPath: string; url: string }>;
}>;

/** Why there are no settings for a computer yet. */
export type ComputerMissing =
  | Extract<TailnetName, { state: "unavailable" }>["reason"]
  | "host-key-missing"
  | "user-invalid";

export type ComputerAnswer =
  | ComputerSettings
  | Readonly<{ state: "unavailable"; missing: readonly ComputerMissing[] }>;

/** The settings for a computer, or everything that is missing for them. */
export function computerSettings(
  input: Readonly<{
    user: string;
    tailnet: TailnetName;
    hostKey: HostKey | null;
    machine?: MachineBinding | null;
    folder?: string;
  }>,
): ComputerAnswer {
  const missing: ComputerMissing[] = [];
  const alias =
    input.tailnet.state === "known"
      ? sshAlias(input.tailnet.dnsName, input.machine)
      : null;
  if (input.tailnet.state === "unavailable") missing.push(input.tailnet.reason);
  else if (alias === null) missing.push("no-dns-name");
  if (input.hostKey === null) missing.push("host-key-missing");
  // An OS account name OpenSSH takes as one word.
  if (!/^[A-Za-z0-9._][A-Za-z0-9._-]{0,63}$/.test(input.user))
    missing.push("user-invalid");
  if (
    missing.length > 0 ||
    alias === null ||
    input.hostKey === null ||
    input.tailnet.state !== "known"
  )
    return { state: "unavailable", missing };
  const keyPath = `~/.ssh/${alias}-ed25519`;
  return {
    state: "ready",
    alias,
    keyPath,
    config: [
      `Host ${alias}`,
      `  HostName ${input.tailnet.dnsName}`,
      `  User ${input.user}`,
      `  IdentityFile ${keyPath}`,
      "  IdentitiesOnly yes",
      `  HostKeyAlias ${alias}`,
      "  UserKnownHostsFile ~/.ssh/known_hosts_lazurio",
      "  StrictHostKeyChecking yes",
    ].join("\n"),
    knownHosts: `${alias} ${input.hostKey.type} ${input.hostKey.key}`,
    ...(input.folder === undefined
      ? {}
      : {
          codex: {
            projectPath: input.folder,
            // Verified in Codex Desktop 26.1007.30912. name is the SSH alias;
            // projectPath registers the host+path project. No label/model field.
            url: `codex://settings/connections/ssh/add?${new URLSearchParams({ name: alias, projectPath: input.folder, enabled: "true" })}`,
          },
        }),
  };
}

/** SSH access of this process's account: its home and uid, its name, the
 * system's host key and its Tailscale. */
export function processSshAccessHost(tools: ToolsEnvironment): SshAccessHost {
  // An account without a name of its own (no passwd entry) has no user a
  // computer could sign in as: its settings say so, the Launchpad starts.
  let user = "";
  try {
    user = userInfo().username;
  } catch {}
  return {
    platform: tools.platform,
    home: homedir(),
    uid: process.getuid?.(),
    user,
    today: () => new Date().toISOString().slice(0, 10),
    hostKeyPath: "/etc/ssh/ssh_host_ed25519_key.pub",
    tailnet: () => readTailnet(tools),
  };
}
