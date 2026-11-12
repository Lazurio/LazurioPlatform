import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { join } from "node:path";
import {
  type ExecutorEndpoint,
  executorCall,
} from "../integrations/executor-client";
import { readHostKey, type SshAccessHost } from "../ssh-access/host";
import {
  addComputerKey,
  addedByLabel,
  type FileRefusal,
  type KeyRefusal,
  listComputerKeys,
  parseDeviceKey,
  removeComputerKey,
} from "../ssh-access/keys";
import { socketAnswers } from "./broker";
import {
  type ComputerOs,
  computerIdPattern,
  displayName,
  freeComputerId,
  isComputerOs,
  lastActivity,
  readRecord,
  recordedIds,
  removeState,
  socketPath,
  socketPathFits,
  writeRecord,
} from "./state";

// People's computers for agents (Lazurio Agent Desktop, root decisions 0240
// and 0241, decision F73): one use case for the Launchpad's
// `/connect/computer` and `/api/computers` and for `lazurio computer list`
// and `remove`. A computer is paired by its restricted line in
// `authorized_keys` (`../ssh-access/keys`), its record here and its MCP
// server in this Environment's Executor, which every agent and bot uses.
// The computer itself is never reached from here: it attaches when its
// owner's switch is on (`lazurio computer attach`).

/** Where people's computers are paired, for the account this process runs
 * as: F49's host, the installed `lazurio` and Executor. Trusted
 * composition, never HTTP input. */
export type ComputersHost = SshAccessHost &
  Readonly<{
    /** The absolute installed `lazurio` the forced command and Executor
     * run; null where it is not installed. */
    entry: () => Promise<string | null>;
    executor: ExecutorEndpoint | null;
    /** Whether this Environment may use a person's computer at all: a
     * Personal Environment or a person's own Work Environment, never a Team
     * Environment (root decision 0241). */
    allowed: () => Promise<boolean>;
    /** The Folder's language, for Executor's server name. */
    locale: () => Promise<"cs" | "en">;
    version: string;
  }>;

/** The presets whose Environment may use a person's computer: a Personal
 * Environment (its Buddy) and a person's own Work Environment; never a Team
 * Environment, the steward's or the person's own computer (root decision
 * 0241). */
export const computerPresets = Object.freeze([
  "hosted-personal",
  "hosted-organization-personal",
]);
export const computersAllowed = (preset: string) =>
  computerPresets.includes(preset);

/** The installed entry of `home`: `~/.local/bin/lazurio`, when it runs. */
export async function installedEntry(home: string): Promise<string | null> {
  const entry = join(home, ".local", "bin", "lazurio");
  try {
    await access(entry, constants.X_OK);
    return entry;
  } catch {
    return null;
  }
}

/** One paired computer as the Launchpad and `lazurio computer list` show
 * it. */
export type ComputerView = Readonly<{
  deviceId: string;
  name: string;
  os: ComputerOs | null;
  addedBy: string;
  added: string;
  fingerprint: string;
  /** The computer is attached now: its broker's socket answers. */
  connected: boolean;
  /** The last line of its history, ISO time; null without one. */
  lastActivity: string | null;
  /** Whether Executor has its MCP server. */
  agents: "executor" | "missing";
}>;

export type ComputersOverview =
  | Readonly<{
      kind: "computers";
      supported: true;
      computers: readonly ComputerView[];
    }>
  | Readonly<{
      kind: "computers";
      supported: false;
      reason: "not-here" | "unsupported-platform" | FileRefusal;
    }>;

const supportedPlatform = (host: ComputersHost) => host.platform === "linux";

export async function listComputers(
  host: ComputersHost,
): Promise<ComputersOverview> {
  if (!supportedPlatform(host))
    return {
      kind: "computers",
      supported: false,
      reason: "unsupported-platform",
    };
  if (!(await host.allowed()))
    return { kind: "computers", supported: false, reason: "not-here" };
  const [keys, activity] = await Promise.all([
    listComputerKeys(host),
    lastActivity(host.home),
  ]);
  if ("refused" in keys)
    return { kind: "computers", supported: false, reason: keys.refused };
  const computers = await Promise.all(
    keys.computers.map(async (key): Promise<ComputerView> => {
      const [record, connected] = await Promise.all([
        readRecord(host.home, key.device),
        socketAnswers(socketPath(host.home, key.device), 500),
      ]);
      return {
        deviceId: key.device,
        name: record?.name ?? key.device,
        os: record?.os ?? null,
        addedBy: key.addedBy,
        added: key.added,
        fingerprint: key.fingerprint,
        connected,
        lastActivity: activity.get(key.device)?.ts ?? null,
        agents: record?.executor ? "executor" : "missing",
      };
    }),
  );
  return { kind: "computers", supported: true, computers };
}

/** What the computer needs to open its session (contract v0 section 1). */
export type ComputerSsh = Readonly<{
  host: string;
  user: string;
  /** One `known_hosts` line: the Environment's tailnet name and host key. */
  knownHosts: string;
}>;

export type PairRefusal =
  | KeyRefusal
  | "invalid-name"
  | "invalid-os"
  | "invalid-added-by"
  | "not-here"
  | "unsupported-platform"
  | "tailnet-unavailable"
  | "host-key-unavailable"
  | "user-unknown"
  | "lazurio-missing"
  | "no-free-id"
  | FileRefusal
  | "key-in-use"
  | "device-taken";

/** Refusals of what was sent, as opposed to the state of this
 * Environment. */
export const pairInputRefusals: ReadonlySet<PairRefusal> = new Set<PairRefusal>(
  [
    "key-missing",
    "private-key",
    "multiple-lines",
    "options-not-allowed",
    "unsupported-type",
    "invalid-key",
    "not-a-public-key",
    "invalid-name",
    "invalid-os",
    "invalid-added-by",
  ],
);

export type PairAnswer =
  | Readonly<{
      kind: "computer-paired";
      outcome: "added" | "already-present";
      deviceId: string;
      name: string;
      ssh: ComputerSsh;
      /** Whether Executor now has the computer's MCP server. */
      agents: "executor" | "executor-unavailable" | "executor-failed";
    }>
  | Readonly<{ kind: "blocked"; reason: PairRefusal }>;

/** What the pairing page shows before the person confirms: the checked
 * name, system and the key's fingerprint, or why it cannot be paired. */
export function pairingRequest(
  input: Readonly<{ name: unknown; os: unknown; publicKey: unknown }>,
):
  | Readonly<{ name: string; os: ComputerOs; fingerprint: string }>
  | Readonly<{ refused: PairRefusal }> {
  const name = displayName(input.name);
  if (name === null || freeComputerId(name, new Set()) === null)
    return { refused: "invalid-name" };
  if (!isComputerOs(input.os)) return { refused: "invalid-os" };
  const key = parseDeviceKey(input.publicKey);
  if ("refused" in key) return { refused: key.refused };
  if (key.type !== "ssh-ed25519") return { refused: "unsupported-type" };
  return { name, os: input.os, fingerprint: key.fingerprint };
}

// Executor's name of the computer's server: "Počítač: <name>".
const serverName = (locale: "cs" | "en", name: string, id: string | null) =>
  `${locale === "cs" ? "Počítač" : "Computer"}: ${name}${id === null ? "" : ` (${id})`}`;

/** Adds the computer's MCP server to Executor: the command
 * `lazurio computer mcp --device <id>`, without keys. Its slug, or why
 * not. */
export async function registerComputerServer(
  executor: ExecutorEndpoint | null,
  input: Readonly<{
    entry: string;
    deviceId: string;
    name: string;
    locale: "cs" | "en";
  }>,
): Promise<string | "executor-unavailable" | "executor-failed"> {
  if (executor === null) return "executor-unavailable";
  for (const suffix of [null, input.deviceId]) {
    const added = await executorCall(
      executor,
      "POST",
      "/mcp/servers",
      {
        transport: "stdio",
        name: serverName(input.locale, input.name, suffix),
        command: input.entry,
        args: ["computer", "mcp", "--device", input.deviceId],
      },
      60_000,
    );
    if (added.kind === "unavailable") return "executor-unavailable";
    if (added.kind !== "answer") return "executor-failed";
    if (added.status === 409) continue;
    const slug =
      added.status === 200 &&
      added.body !== null &&
      typeof added.body === "object"
        ? (added.body as Record<string, unknown>).slug
        : undefined;
    return typeof slug === "string" ? slug : "executor-failed";
  }
  return "executor-failed";
}

/** Removes the computer's MCP server from Executor. */
export async function unregisterComputerServer(
  executor: ExecutorEndpoint | null,
  slug: string,
): Promise<boolean> {
  if (executor === null) return false;
  const removed = await executorCall(
    executor,
    "DELETE",
    `/mcp/servers/${encodeURIComponent(slug)}`,
  );
  return (
    removed.kind === "answer" &&
    removed.status === 200 &&
    removed.body !== null &&
    typeof removed.body === "object" &&
    (removed.body as Record<string, unknown>).removed === true
  );
}

/** Pairs a computer: its restricted key line, its record and its server in
 * Executor. The same key again answers the computer it already is, so the
 * application may simply retry. */
export async function pairComputer(
  host: ComputersHost,
  input: Readonly<{
    name: unknown;
    os: unknown;
    publicKey: unknown;
    addedBy: unknown;
  }>,
): Promise<PairAnswer> {
  const request = pairingRequest(input);
  if ("refused" in request) return { kind: "blocked", reason: request.refused };
  const addedBy = addedByLabel(input.addedBy);
  if (addedBy === null) return { kind: "blocked", reason: "invalid-added-by" };
  if (!supportedPlatform(host))
    return { kind: "blocked", reason: "unsupported-platform" };
  if (!(await host.allowed())) return { kind: "blocked", reason: "not-here" };
  if (host.user === "") return { kind: "blocked", reason: "user-unknown" };
  const key = parseDeviceKey(input.publicKey);
  if ("refused" in key || key.type !== "ssh-ed25519")
    return { kind: "blocked", reason: "invalid-key" };
  const [tailnet, hostKey, entry] = await Promise.all([
    host.tailnet(),
    readHostKey(host.hostKeyPath),
    host.entry(),
  ]);
  if (tailnet.state !== "known")
    return { kind: "blocked", reason: "tailnet-unavailable" };
  if (hostKey === null)
    return { kind: "blocked", reason: "host-key-unavailable" };
  if (entry === null) return { kind: "blocked", reason: "lazurio-missing" };
  const keys = await listComputerKeys(host);
  if ("refused" in keys) return { kind: "blocked", reason: keys.refused };
  const known = keys.computers.find(
    (item) => item.fingerprint === key.fingerprint,
  );
  const deviceId =
    known?.device ??
    freeComputerId(
      request.name,
      new Set([
        ...keys.computers.map((item) => item.device),
        ...(await recordedIds(host.home)),
      ]),
    );
  if (deviceId === null || !socketPathFits(host.home, deviceId))
    return { kind: "blocked", reason: "no-free-id" };
  const added = await addComputerKey(host, {
    key: { type: "ssh-ed25519", key: key.key, fingerprint: key.fingerprint },
    entry,
    device: deviceId,
    addedBy,
    date: host.today(),
  });
  if (added.kind === "blocked") return added;
  const existing = await readRecord(host.home, deviceId);
  let executor = existing?.executor ?? null;
  let agents: "executor" | "executor-unavailable" | "executor-failed" =
    "executor";
  if (executor === null) {
    const registered = await registerComputerServer(host.executor, {
      entry,
      deviceId,
      name: request.name,
      locale: await host.locale(),
    });
    if (
      registered === "executor-unavailable" ||
      registered === "executor-failed"
    )
      agents = registered;
    else executor = registered;
  }
  await writeRecord(host.home, host.uid, {
    deviceId,
    name: request.name,
    os: request.os,
    executor,
  });
  return {
    kind: "computer-paired",
    outcome: added.outcome,
    deviceId,
    name: request.name,
    ssh: {
      host: tailnet.dnsName,
      user: host.user,
      knownHosts: `${tailnet.dnsName} ${hostKey.type} ${hostKey.key}`,
    },
    agents,
  };
}

export type RemoveAnswer =
  | Readonly<{
      kind: "computer-removed";
      deviceId: string;
      /** Executor's server: removed, there was none, or it stayed (the
       * person removes it in Apps → Integrace → Vlastní). */
      agents: "removed" | "none" | "left";
    }>
  | Readonly<{
      kind: "blocked";
      reason: "invalid-id" | "not-found" | "unsupported-platform" | FileRefusal;
    }>;

/** Removes a computer: its key line first (it can no longer attach, and an
 * attached session ends within a ping), then Executor's server and its
 * record. */
export async function removeComputer(
  host: ComputersHost,
  deviceId: unknown,
): Promise<RemoveAnswer> {
  if (typeof deviceId !== "string" || !computerIdPattern.test(deviceId))
    return { kind: "blocked", reason: "invalid-id" };
  if (!supportedPlatform(host))
    return { kind: "blocked", reason: "unsupported-platform" };
  const removed = await removeComputerKey(host, deviceId);
  if (removed.kind === "blocked") return removed;
  const record = await readRecord(host.home, deviceId);
  let agents: "removed" | "none" | "left" = "none";
  if (record?.executor)
    agents = (await unregisterComputerServer(host.executor, record.executor))
      ? "removed"
      : "left";
  await removeState(host.home, deviceId);
  return { kind: "computer-removed", deviceId, agents };
}
