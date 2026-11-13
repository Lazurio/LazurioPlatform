import { constants } from "node:fs";
import { access, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  type ExecutorEndpoint,
  executorCall,
} from "../integrations/executor-client";
import {
  addedByLabel,
  type KeyRefusal,
  type KeysLocation,
  listComputerKeys,
  parseDeviceKey,
  removeComputerKey,
} from "../ssh-access/keys";
import { socketAnswers } from "./broker";
import { type RegistryEntry, readRegistry, updateRegistry } from "./registry";
import {
  type ComputerOs,
  computerIdPattern,
  displayName,
  freeComputerId,
  isComputerOs,
  isUpdating,
  lastActivity,
  readRecord,
  recordPath,
  removeState,
  socketPath,
  socketPathFits,
} from "./state";

// People's computers for agents (Lazurio Agent Desktop, root decisions 0240
// and 0241, decision F73 and its addendum of 2026-11-13): one use case for
// the Launchpad's `/connect/computer` and `/api/computers` and for `lazurio
// computer list` and `remove`. A computer is paired by its entry in the
// registry (`./registry`) and its MCP server in this Environment's
// Executor, which every agent and bot uses. The computer itself is never
// reached from here: it opens its own WebSocket session to
// `/.lazurio/computers/attach` while its owner's switch is on
// (`./attach-ws`).

/** Where people's computers are paired, for the account this process runs
 * as. Trusted composition, never HTTP input. */
export type ComputersHost = KeysLocation &
  Readonly<{
    platform: string;
    /** Today's date as the registry writes it (UTC, `YYYY-MM-DD`). */
    today: () => string;
    /** The computer's session address, `wss://<launchpad host>/.lazurio/
     * computers/attach`; null where this Launchpad has no external origin. */
    channelUrl: () => Promise<string | null>;
    /** The absolute installed `lazurio` Executor runs as the computer's MCP
     * server; null where it is not installed. */
    executorCommand: () => Promise<string | null>;
    executor: ExecutorEndpoint | null;
    /** Whether this Environment may use a person's computer at all: a
     * Personal Environment or a person's own Work Environment, never a Team
     * Environment (root decision 0241). */
    allowed: () => Promise<boolean>;
    /** The Folder's language, for Executor's server name. */
    locale: () => Promise<"cs" | "en">;
    /** This Environment's name as Lazurio shows it, for the application's
     * panel (`result.environment.name`); absent or null: none is sent. */
    environmentName?: () => Promise<string | null>;
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

/** The computer's session address of a Launchpad's external origin. */
export function channelUrlOf(origin: string): string | null {
  try {
    const url = new URL(origin);
    if (url.protocol === "https:")
      return `wss://${url.host}/.lazurio/computers/attach`;
    if (url.protocol === "http:" && url.hostname === "127.0.0.1")
      return `ws://${url.host}/.lazurio/computers/attach`;
    return null;
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
  /** The application's version and system at its last connection, as it
   * reported them; null when it reported none. */
  appVersion: string | null;
  appSystem: string | null;
  /** Not attached because its application updates itself
   * (`lazurio_app_update`), for about a minute. */
  updating: boolean;
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
      reason: "not-here" | "unsupported-platform" | "registry-unreadable";
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
  const [registry, activity] = await Promise.all([
    readRegistry(host.home, host.uid),
    lastActivity(host.home),
  ]);
  if ("refused" in registry)
    return { kind: "computers", supported: false, reason: registry.refused };
  const computers = await Promise.all(
    registry.computers.map(async (entry): Promise<ComputerView> => {
      const [connected, updating] = await Promise.all([
        socketAnswers(socketPath(host.home, entry.deviceId), 500),
        isUpdating(host.home, entry.deviceId),
      ]);
      const seen = activity.get(entry.deviceId);
      return {
        deviceId: entry.deviceId,
        name: entry.name,
        os: entry.os,
        addedBy: entry.addedBy,
        added: entry.added,
        fingerprint: entry.fingerprint,
        connected,
        lastActivity: seen?.ts ?? null,
        agents: entry.executor ? "executor" : "missing",
        appVersion: seen?.version ?? null,
        appSystem: seen?.system ?? null,
        updating: !connected && updating,
      };
    }),
  );
  return { kind: "computers", supported: true, computers };
}

/** Where the computer opens its session (contract v1 section 2). */
export type ComputerChannel = Readonly<{ url: string }>;

export type PairRefusal =
  | KeyRefusal
  | "invalid-name"
  | "invalid-os"
  | "invalid-added-by"
  | "not-here"
  | "unsupported-platform"
  | "channel-unavailable"
  | "no-free-id"
  | "registry-unreadable";

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
      channel: ComputerChannel;
      /** This Environment's name for the application's panel, or null. */
      environment: Readonly<{ name: string }> | null;
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
    command: string;
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
        command: input.command,
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

/** Pairs a computer: its entry in the registry and its server in
 * Executor. The same key again answers the computer it already is, so the
 * application may simply retry. Nothing is written to `authorized_keys`. */
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
  const key = parseDeviceKey(input.publicKey);
  if ("refused" in key || key.type !== "ssh-ed25519")
    return { kind: "blocked", reason: "invalid-key" };
  const url = await host.channelUrl();
  if (url === null) return { kind: "blocked", reason: "channel-unavailable" };
  // A computer still on the old SSH path keeps its id (contract v1,
  // Přechod z v0).
  const legacy = await listComputerKeys(host);
  const legacyIds =
    "computers" in legacy ? legacy.computers.map((c) => c.device) : [];
  type Paired = Readonly<{
    outcome: "added" | "already-present";
    entry: RegistryEntry;
  }> | null;
  const paired = await updateRegistry<Paired>(
    host.home,
    host.uid,
    (computers) => {
      const known = computers.find(
        (entry) => entry.fingerprint === key.fingerprint,
      );
      if (known !== undefined)
        return {
          computers: null,
          result: { outcome: "already-present", entry: known },
        };
      const deviceId = freeComputerId(
        request.name,
        new Set([...computers.map((entry) => entry.deviceId), ...legacyIds]),
      );
      if (deviceId === null || !socketPathFits(host.home, deviceId))
        return { computers: null, result: null };
      const entry: RegistryEntry = {
        deviceId,
        name: request.name,
        os: request.os,
        publicKey: `${key.type} ${key.key}`,
        fingerprint: key.fingerprint,
        addedBy,
        added: host.today(),
        executor: null,
      };
      return {
        computers: [...computers, entry],
        result: { outcome: "added", entry },
      };
    },
  );
  if (paired === null) return { kind: "blocked", reason: "no-free-id" };
  if ("refused" in paired) return { kind: "blocked", reason: paired.refused };
  let agents: "executor" | "executor-unavailable" | "executor-failed" =
    "executor";
  if (paired.entry.executor === null) {
    const command = await host.executorCommand();
    const registered =
      command === null
        ? "executor-unavailable"
        : await registerComputerServer(host.executor, {
            command,
            deviceId: paired.entry.deviceId,
            name: request.name,
            locale: await host.locale(),
          });
    if (
      registered === "executor-unavailable" ||
      registered === "executor-failed"
    )
      agents = registered;
    else
      await updateRegistry(host.home, host.uid, (computers) => ({
        computers: computers.map((entry) =>
          entry.deviceId === paired.entry.deviceId
            ? { ...entry, executor: registered }
            : entry,
        ),
        result: null,
      }));
  }
  const environmentName = displayName(
    await (host.environmentName?.() ?? Promise.resolve(null)).catch(() => null),
  );
  return {
    kind: "computer-paired",
    outcome: paired.outcome,
    deviceId: paired.entry.deviceId,
    name: paired.entry.name,
    channel: { url },
    environment: environmentName === null ? null : { name: environmentName },
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
      reason:
        | "invalid-id"
        | "not-found"
        | "unsupported-platform"
        | "registry-unreadable";
    }>;

/** Removes a computer: its registry entry first (it can no longer attach,
 * and an attached session ends within a check), a leftover SSH line of the
 * old path, then Executor's server and its state. */
export async function removeComputer(
  host: ComputersHost,
  deviceId: unknown,
): Promise<RemoveAnswer> {
  if (typeof deviceId !== "string" || !computerIdPattern.test(deviceId))
    return { kind: "blocked", reason: "invalid-id" };
  if (!supportedPlatform(host))
    return { kind: "blocked", reason: "unsupported-platform" };
  const removed = await updateRegistry(host.home, host.uid, (computers) => {
    const entry = computers.find((item) => item.deviceId === deviceId);
    return entry === undefined
      ? { computers: null, result: null }
      : {
          computers: computers.filter((item) => item.deviceId !== deviceId),
          result: entry,
        };
  });
  if (removed !== null && "refused" in removed)
    return { kind: "blocked", reason: removed.refused };
  const legacy = await removeComputerKey(host, deviceId);
  const legacyRecord = await readRecord(host.home, deviceId);
  if (removed === null && legacy.kind === "blocked")
    return { kind: "blocked", reason: "not-found" };
  const slug = removed?.executor ?? legacyRecord?.executor ?? null;
  let agents: "removed" | "none" | "left" = "none";
  if (slug)
    agents = (await unregisterComputerServer(host.executor, slug))
      ? "removed"
      : "left";
  await removeState(host.home, deviceId);
  return { kind: "computer-removed", deviceId, agents };
}

/** What the move from the SSH path did (contract v1, Přechod z v0). */
export type Migration = Readonly<{
  moved: readonly string[];
  failed: readonly string[];
}>;

/** Moves every computer of the old SSH path into the registry: its key,
 * name, system and Executor's server stay; its line leaves
 * `authorized_keys`, its old record goes. Every other line stays byte for
 * byte. Run once as the Launchpad starts; nothing to do is quick. */
export async function migrateSshComputers(
  host: ComputersHost,
): Promise<Migration> {
  const legacy = await listComputerKeys(host);
  if (!("computers" in legacy) || legacy.computers.length === 0)
    return { moved: [], failed: [] };
  const moved: string[] = [];
  const failed: string[] = [];
  for (const line of legacy.computers) {
    const record = await readRecord(host.home, line.device);
    const entered = await updateRegistry(host.home, host.uid, (computers) => {
      if (computers.some((entry) => entry.deviceId === line.device))
        return { computers: null, result: true };
      const entry: RegistryEntry = {
        deviceId: line.device,
        name: record?.name ?? line.device,
        os: record?.os ?? null,
        publicKey: `ssh-ed25519 ${line.key}`,
        fingerprint: line.fingerprint,
        addedBy: line.addedBy,
        added: line.added,
        executor: record?.executor ?? null,
      };
      return { computers: [...computers, entry], result: true };
    });
    if (entered !== true) {
      failed.push(line.device);
      continue;
    }
    const removed = await removeComputerKey(host, line.device);
    if (removed.kind === "blocked") {
      failed.push(line.device);
      continue;
    }
    await rm(recordPath(host.home, line.device), { force: true });
    moved.push(line.device);
  }
  return { moved, failed };
}
