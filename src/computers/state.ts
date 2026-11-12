import { constants } from "node:fs";
import {
  appendFile,
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
import { deviceName } from "../ssh-access/keys";
import { writeDurableFile } from "../update/durable-file";

// A person's computer for agents (Lazurio Agent Desktop, root decisions 0240
// and 0241, decision F73): what this Environment keeps about each paired
// computer, owned here and nowhere else.
//
//   ~/.local/state/lazurio/computers/            0700
//     <id>.json        the computer's record: its name as the person sees it,
//                      its system and Executor's server (never a key)
//     <id>.sock        the broker's socket while the computer is attached
//     <id>.tools.json  the computer's tool list from its last session, so an
//                      agent's MCP server can list tools while it is away
//     audit.jsonl      the history: connections, the lock, a tool's name, its
//                      outcome and duration; never arguments, screen content
//                      or a password
//
// The one truth of whether a computer may connect is its line in
// `authorized_keys` (`../ssh-access/keys`); a record without that line is a
// leftover and is listed by nothing.

/** The directory of every computer's state. */
export const computersDirectory = (home: string) =>
  join(home, ".local", "state", "lazurio", "computers");

/** A computer's id: its name reduced like an F49 device's. */
export const computerIdPattern = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

export const computerOses = ["macos", "windows"] as const;
export type ComputerOs = (typeof computerOses)[number];
export const isComputerOs = (value: unknown): value is ComputerOs =>
  (computerOses as readonly unknown[]).includes(value);

export const socketPath = (home: string, id: string) =>
  join(computersDirectory(home), `${id}.sock`);
export const recordPath = (home: string, id: string) =>
  join(computersDirectory(home), `${id}.json`);
export const toolsPath = (home: string, id: string) =>
  join(computersDirectory(home), `${id}.tools.json`);
export const updatingPath = (home: string, id: string) =>
  join(computersDirectory(home), `${id}.updating`);
export const auditPath = (home: string) =>
  join(computersDirectory(home), "audit.jsonl");

/** A Unix socket's path must fit `sun_path` (108 bytes on Linux, 104 on
 * macOS); a longer home cannot hold a computer. */
export const socketPathFits = (home: string, id: string) =>
  Buffer.byteLength(socketPath(home, id)) < 104;

/** The computer's name as the person sees it: no control or direction
 * characters, at most 64 characters; null when nothing remains. */
export function displayName(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 200) return null;
  const name = [...raw.normalize("NFC")]
    .filter((character) => !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(character))
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 64)
    .trim();
  return name === "" ? null : name;
}

/** A free id for `name`: its F49 device name, and on a collision the same
 * with `-2`, `-3`, … within 40 characters. */
export function freeComputerId(
  name: string,
  taken: ReadonlySet<string>,
): string | null {
  const base = deviceName(name);
  if (base === null) return null;
  if (!taken.has(base)) return base;
  for (let suffix = 2; suffix < 1000; suffix++) {
    const tail = `-${suffix}`;
    const candidate = `${base.slice(0, 40 - tail.length).replace(/-+$/, "")}${tail}`;
    if (computerIdPattern.test(candidate) && !taken.has(candidate))
      return candidate;
  }
  return null;
}

/** What the record keeps. */
export type ComputerRecord = Readonly<{
  deviceId: string;
  name: string;
  os: ComputerOs;
  /** Executor's slug of the computer's MCP server, once registered. */
  executor: string | null;
}>;

/** The directory, created owner-only, and refused when it is a link or
 * another account's. */
export async function ensureComputersDirectory(
  home: string,
  uid: number | undefined,
): Promise<string> {
  const directory = computersDirectory(home);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory())
    throw new Error("The computers' state is no directory");
  if (uid !== undefined && info.uid !== uid)
    throw new Error("The computers' state belongs to another account");
  if ((info.mode & 0o077) !== 0) await chmod(directory, 0o700);
  return directory;
}

const maxRecordBytes = 16 * 1024;

// A small owner-only JSON file, opened without following a link; null when
// it is missing or not readable as one.
async function readSmallJson(
  path: string,
  maxBytes: number,
): Promise<unknown | null> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return null;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes) return null;
    return JSON.parse((await handle.readFile()).toString("utf8"));
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

export async function readRecord(
  home: string,
  id: string,
): Promise<ComputerRecord | null> {
  if (!computerIdPattern.test(id)) return null;
  const value = await readSmallJson(recordPath(home, id), maxRecordBytes);
  if (value === null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const name = displayName(record.name);
  if (record.deviceId !== id || name === null || !isComputerOs(record.os))
    return null;
  return {
    deviceId: id,
    name,
    os: record.os,
    executor: typeof record.executor === "string" ? record.executor : null,
  };
}

export async function writeRecord(
  home: string,
  uid: number | undefined,
  record: ComputerRecord,
): Promise<void> {
  const directory = await ensureComputersDirectory(home, uid);
  await writeDurableFile(
    directory,
    `${record.deviceId}.json`,
    Buffer.from(`${JSON.stringify(record)}\n`, "utf8"),
  );
}

/** Removes a computer's record and tool list; its socket is the broker's. */
export async function removeState(home: string, id: string): Promise<void> {
  if (!computerIdPattern.test(id)) return;
  await rm(recordPath(home, id), { force: true });
  await rm(toolsPath(home, id), { force: true });
  await rm(updatingPath(home, id), { force: true });
}

/** The ids that have a record: a leftover's id is not reused either. */
export async function recordedIds(home: string): Promise<readonly string[]> {
  try {
    return (await readdir(computersDirectory(home)))
      .filter((name) => name.endsWith(".json") && !name.endsWith(".tools.json"))
      .map((name) => name.slice(0, -".json".length))
      .filter((id) => computerIdPattern.test(id));
  } catch {
    return [];
  }
}

/** The tool list a computer last offered: MCP's `tools` array, as it was. */
export async function readTools(
  home: string,
  id: string,
): Promise<readonly unknown[] | null> {
  const value = await readSmallJson(toolsPath(home, id), 4 * 1024 * 1024);
  return Array.isArray(value) ? value : null;
}

export async function writeTools(
  home: string,
  uid: number | undefined,
  id: string,
  tools: readonly unknown[],
): Promise<void> {
  const directory = await ensureComputersDirectory(home, uid);
  await writeDurableFile(
    directory,
    `${id}.tools.json`,
    Buffer.from(JSON.stringify(tools), "utf8"),
  );
}

/** One line of the history. `agent` is what the agent's own MCP client and
 * its harness call themselves, never a person. */
export type AuditEntry = Readonly<{
  ts: string;
  device: string;
  event:
    | "connected"
    | "disconnected"
    | "refused"
    | "lease"
    | "release"
    | "busy"
    | "tool"
    /** An agent asked the application to update itself: the computer is
     * away for about a minute, which is no failure. */
    | "updating";
  tool?: string;
  ok?: boolean;
  ms?: number;
  agent?: string;
  reason?: string;
  /** On `connected`: the application's version and system, as the
   * computer reports them (`appOf`). */
  version?: string;
  system?: string;
  osVersion?: string;
  channel?: string;
}>;

/** The key of the application's own details in its answer to
 * `initialize` (`Lazurio/lazurio-agent-desktop`, contract fixed
 * 2026-11-12): `appVersion`, `os`, `osVersion` and `updateChannel`. */
export const appMetaKey = "io.lazurio/agent-desktop";

/** What a computer's application says it is. */
export type AppDetails = Readonly<{
  version?: string;
  system?: string;
  osVersion?: string;
  channel?: string;
}>;

const versionLike = (value: unknown): value is string =>
  typeof value === "string" && /^v?\d[0-9A-Za-z.+-]{0,31}$/.test(value);
const labelLike = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9 ._-]{1,40}$/.test(value);

/** Only what is version-like or a short label; anything else is nothing. */
export function appDetails(
  input: Readonly<{
    version?: unknown;
    system?: unknown;
    osVersion?: unknown;
    channel?: unknown;
  }>,
): AppDetails {
  return {
    ...(versionLike(input.version) ? { version: input.version } : {}),
    ...(labelLike(input.system) ? { system: input.system } : {}),
    ...(versionLike(input.osVersion) ? { osVersion: input.osVersion } : {}),
    ...(labelLike(input.channel) ? { channel: input.channel } : {}),
  };
}

/** What a computer's application says it is, from its answer to
 * `initialize`: `_meta["io.lazurio/agent-desktop"]`, else the shape from
 * before the contract was fixed, `_meta["io.lazurio/app"]` (`version`, `os`
 * or `system`). Never `serverInfo`: it is the engine's, and its version
 * would read as the application's. */
export function appOf(initResult: unknown): AppDetails {
  const record = (value: unknown) =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const result = record(initResult);
  const meta = record(result._meta);
  const app = record(meta[appMetaKey]);
  const legacy = record(meta["io.lazurio/app"]);
  return appDetails({
    version: [app.appVersion, legacy.version].find(versionLike),
    system: [app.os, legacy.os, legacy.system].find(labelLike),
    osVersion: app.osVersion,
    channel: app.updateChannel,
  });
}

const maxAuditBytes = 4 * 1024 * 1024;

/** A label of an agent or a tool as the history writes it: printable,
 * without spaces at its ends, at most 64 characters; else `unknown`. */
export function auditLabel(value: unknown): string {
  if (typeof value !== "string") return "unknown";
  const label = value
    .replace(/[^A-Za-z0-9 ._:/@-]/g, "")
    .trim()
    .slice(0, 64);
  return label === "" ? "unknown" : label;
}

/** Appends one line; past 4 MiB the file moves to `audit.jsonl.1` first,
 * so the history keeps at most two files. */
export async function appendAudit(
  home: string,
  uid: number | undefined,
  entry: AuditEntry,
): Promise<void> {
  await ensureComputersDirectory(home, uid);
  const path = auditPath(home);
  try {
    if ((await lstat(path)).size > maxAuditBytes)
      await rename(path, `${path}.1`);
  } catch {}
  await appendFile(path, `${JSON.stringify(entry)}\n`, {
    mode: 0o600,
    flag:
      constants.O_WRONLY |
      constants.O_APPEND |
      constants.O_CREAT |
      constants.O_NOFOLLOW,
  });
}

/** What the history says of one computer: its last line's time and event,
 * and the application's version and system from its last `connected`. */
export type ComputerActivity = Readonly<{ ts: string; event: string }> &
  AppDetails;

/** Each computer's activity from the history. Reads at most the file's
 * last 1 MiB. */
export async function lastActivity(
  home: string,
): Promise<ReadonlyMap<string, ComputerActivity>> {
  const result = new Map<string, ComputerActivity>();
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(
      auditPath(home),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
  } catch {
    return result;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return result;
    const length = Math.min(info.size, 1024 * 1024);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, info.size - length);
    for (const line of buffer.toString("utf8").split("\n")) {
      try {
        const value = JSON.parse(line) as Record<string, unknown>;
        if (
          typeof value.device === "string" &&
          typeof value.ts === "string" &&
          typeof value.event === "string"
        ) {
          const before = result.get(value.device);
          // A connection names the application anew; any other line keeps
          // what the last connection said.
          const app =
            value.event === "connected"
              ? appDetails(value)
              : appDetails(before ?? {});
          result.set(value.device, {
            ts: value.ts,
            event: value.event,
            ...app,
          });
        }
      } catch {}
    }
  } finally {
    await handle.close();
  }
  return result;
}

/** How long a computer counts as updating after an agent asked its
 * application to update: it downloads, installs, restarts and reconnects in
 * about a minute. */
export const updatingMs = 3 * 60_000;

/** Marks a computer as updating until `until` (milliseconds). */
export async function markUpdating(
  home: string,
  uid: number | undefined,
  id: string,
  until: number,
): Promise<void> {
  const directory = await ensureComputersDirectory(home, uid);
  await writeDurableFile(
    directory,
    `${id}.updating`,
    Buffer.from(`${new Date(until).toISOString()}\n`, "utf8"),
  );
}

export async function clearUpdating(home: string, id: string): Promise<void> {
  if (computerIdPattern.test(id))
    await rm(updatingPath(home, id), { force: true });
}

/** Whether the computer is still within its update's time. */
export async function isUpdating(
  home: string,
  id: string,
  now: number = Date.now(),
): Promise<boolean> {
  if (!computerIdPattern.test(id)) return false;
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(
      updatingPath(home, id),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
  } catch {
    return false;
  }
  try {
    const until = Date.parse(
      (await handle.readFile("utf8")).slice(0, 64).trim(),
    );
    return Number.isFinite(until) && until > now;
  } catch {
    return false;
  } finally {
    await handle.close();
  }
}
