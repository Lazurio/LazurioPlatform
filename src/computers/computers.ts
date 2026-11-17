import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { join } from "node:path";
import {
  type ExecutorEndpoint,
  executorCall,
} from "../integrations/executor-client";
import {
  type KeysLocation,
  listComputerKeys,
  removeComputerKey,
} from "../ssh-access/keys";
import { socketAnswers } from "./broker";
import {
  type ComputerOs,
  computerIdPattern,
  isUpdating,
  lastActivity,
  listRecords,
  removeState,
  socketPath,
  updateRecord,
} from "./state";

// People's computers for agents (Lazurio Agent Desktop, root decisions 0240
// and 0241, decision F75): one use case for the Launchpad's `/api/computers`
// (Settings → Connections) and for `lazurio computer list` and `remove`. A
// computer is known here by its record (`./state`), which its first attach
// over contract v3 creates (`./attach-ws`), and by its MCP server in this
// Environment's Executor, which every agent and bot uses. Whether it may
// attach is the gateway's and Lazurio Auth's, never this Environment's: there
// is no pairing and no registry of computers or keys. The computer itself is
// never reached from here: it opens its own WebSocket session to
// `/.lazurio/computers/attach` while its owner's switch is on.

/** Where people's computers are kept, for the account this process runs
 * as. Trusted composition, never HTTP input. */
export type ComputersHost = KeysLocation &
  Readonly<{
    platform: string;
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

/** One computer that attached, as the Launchpad and `lazurio computer list`
 * show it. */
export type ComputerView = Readonly<{
  deviceId: string;
  name: string;
  os: ComputerOs | null;
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
      reason: "not-here" | "unsupported-platform" | "state-unreadable";
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
  const [read, activity] = await Promise.all([
    listRecords(host.home),
    lastActivity(host.home),
  ]);
  if ("refused" in read)
    return { kind: "computers", supported: false, reason: read.refused };
  const computers = await Promise.all(
    read.records.map(async (record): Promise<ComputerView> => {
      const [connected, updating] = await Promise.all([
        socketAnswers(socketPath(host.home, record.deviceId), 500),
        isUpdating(host.home, record.deviceId),
      ]);
      const seen = activity.get(record.deviceId);
      return {
        deviceId: record.deviceId,
        name: record.name,
        os: record.os,
        connected,
        lastActivity: seen?.ts ?? null,
        agents: record.executor ? "executor" : "missing",
        appVersion: seen?.version ?? null,
        appSystem: seen?.system ?? null,
        updating: !connected && updating,
      };
    }),
  );
  return { kind: "computers", supported: true, computers };
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

/** Executor as a computer's first attach uses it (`AttachHost.servers`):
 * the command `lazurio computer mcp --device <id>`, named in the Folder's
 * language. */
export function attachServers(host: () => Promise<ComputersHost>) {
  return Object.freeze({
    register: async (
      input: Readonly<{ deviceId: string; name: string }>,
    ): Promise<string | "executor-unavailable" | "executor-failed"> => {
      const current = await host();
      const command = await current.executorCommand();
      if (command === null) return "executor-unavailable";
      return registerComputerServer(current.executor, {
        command,
        deviceId: input.deviceId,
        name: input.name,
        locale: await current.locale(),
      });
    },
    unregister: async (slug: string) =>
      unregisterComputerServer((await host()).executor, slug),
  });
}

/** What a removal means for the computer, in the answer of the API and of
 * `lazurio computer remove`. */
export const removalNote =
  "Its open session ends at the broker's next check at the latest. A computer the gateway still admits as an approved device may attach again, which creates it anew.";

export type RemoveAnswer =
  | Readonly<{
      kind: "computer-removed";
      deviceId: string;
      /** Executor's server: removed, there was none, or it stayed (the
       * person removes it in Apps → Integrace → Vlastní). */
      agents: "removed" | "none" | "left";
      note: string;
    }>
  | Readonly<{
      kind: "blocked";
      reason: "invalid-id" | "not-found" | "unsupported-platform";
    }>;

/** Removes a computer: its record first (an open session ends at the
 * broker's next check), then its server in Executor and its tool list. The
 * history stays. */
export async function removeComputer(
  host: ComputersHost,
  deviceId: unknown,
): Promise<RemoveAnswer> {
  if (typeof deviceId !== "string" || !computerIdPattern.test(deviceId))
    return { kind: "blocked", reason: "invalid-id" };
  if (!supportedPlatform(host))
    return { kind: "blocked", reason: "unsupported-platform" };
  const { before } = await updateRecord(
    host.home,
    host.uid,
    deviceId,
    (current) => (current === null ? undefined : null),
  );
  if (before === null) return { kind: "blocked", reason: "not-found" };
  let agents: "removed" | "none" | "left" = "none";
  if (before.executor)
    agents = (await unregisterComputerServer(host.executor, before.executor))
      ? "removed"
      : "left";
  await removeState(host.home, deviceId);
  return { kind: "computer-removed", deviceId, agents, note: removalNote };
}

/** What the cleanup of the old SSH path did. */
export type SshCleanup = Readonly<{
  removed: readonly string[];
  failed: readonly string[];
}>;

/** Removes every computer's line of the old SSH path (contract v0,
 * `lazurio-computer:` lines) from `authorized_keys`: such a line would let a
 * computer around the gateway. Every other line stays byte for byte. Run once
 * as the installed Launchpad starts; nothing to do is quick. */
export async function cleanupSshComputers(
  location: KeysLocation,
): Promise<SshCleanup> {
  const legacy = await listComputerKeys(location);
  if (!("computers" in legacy) || legacy.computers.length === 0)
    return { removed: [], failed: [] };
  const removed: string[] = [];
  const failed: string[] = [];
  for (const device of new Set(legacy.computers.map((line) => line.device))) {
    const answer = await removeComputerKey(location, device);
    if (answer.kind === "blocked") failed.push(device);
    else removed.push(device);
  }
  return { removed, failed };
}
