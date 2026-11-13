import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { parseDeviceKey } from "../ssh-access/keys";
import { writeDurableFile } from "../update/durable-file";
import {
  type ComputerOs,
  computerIdPattern,
  computersDirectory,
  displayName,
  ensureComputersDirectory,
  isComputerOs,
} from "./state";

// The people's computers paired with this Environment (contract v1 section
// 2, decision F73's addendum of 2026-11-13): one owner-only file,
// `~/.local/state/lazurio/computers/registry.json`, the one truth of which
// computer may attach and with which key. The pairing writes it, the attach
// endpoint verifies a computer's signature against it, and Settings →
// Connections, `lazurio computer list|remove`, Executor's server and the
// history read it. A computer's key is never written to `authorized_keys`.

export const registryName = "registry.json";
export const registryPath = (home: string) =>
  join(computersDirectory(home), registryName);

/** One paired computer. `publicKey` is its ed25519 key as the application
 * sent it (`ssh-ed25519 <base64>`), `fingerprint` its SHA-256. */
export type RegistryEntry = Readonly<{
  deviceId: string;
  name: string;
  os: ComputerOs | null;
  publicKey: string;
  fingerprint: string;
  /** The Lazurio username the gateway named at the pairing, or `local`. */
  addedBy: string;
  /** The pairing's date (UTC, `YYYY-MM-DD`). */
  added: string;
  /** Executor's slug of the computer's MCP server, once registered. */
  executor: string | null;
}>;

const maxRegistryBytes = 1024 * 1024;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const addedByPattern = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/;

/** An entry as the file holds it, checked; null for anything else. */
function entryOf(value: unknown): RegistryEntry | null {
  if (value === null || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const name = displayName(raw.name);
  const key = parseDeviceKey(raw.publicKey);
  if (
    typeof raw.deviceId !== "string" ||
    !computerIdPattern.test(raw.deviceId) ||
    name === null ||
    "refused" in key ||
    key.type !== "ssh-ed25519" ||
    typeof raw.addedBy !== "string" ||
    !addedByPattern.test(raw.addedBy) ||
    typeof raw.added !== "string" ||
    !datePattern.test(raw.added)
  )
    return null;
  return {
    deviceId: raw.deviceId,
    name,
    os: isComputerOs(raw.os) ? raw.os : null,
    publicKey: `${key.type} ${key.key}`,
    fingerprint: key.fingerprint,
    addedBy: raw.addedBy,
    added: raw.added,
    executor: typeof raw.executor === "string" ? raw.executor : null,
  };
}

export type RegistryRead =
  | Readonly<{ computers: readonly RegistryEntry[] }>
  | Readonly<{ refused: "registry-unreadable" }>;

/** The paired computers. A missing file is none; a file that is not this
 * account's owner-only JSON is refused, never guessed. */
export async function readRegistry(
  home: string,
  uid: number | undefined,
): Promise<RegistryRead> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(
      registryPath(home),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { computers: [] }
      : { refused: "registry-unreadable" };
  }
  try {
    const info = await handle.stat();
    if (
      !info.isFile() ||
      info.size > maxRegistryBytes ||
      (uid !== undefined && info.uid !== uid) ||
      (info.mode & 0o077) !== 0
    )
      return { refused: "registry-unreadable" };
    const value = JSON.parse((await handle.readFile()).toString("utf8")) as {
      computers?: unknown;
    };
    if (!Array.isArray(value.computers))
      return { refused: "registry-unreadable" };
    const computers: RegistryEntry[] = [];
    for (const raw of value.computers) {
      const entry = entryOf(raw);
      // One unreadable entry is left out; the others stay usable.
      if (
        entry !== null &&
        !computers.some((c) => c.deviceId === entry.deviceId)
      )
        computers.push(entry);
    }
    return { computers };
  } catch {
    return { refused: "registry-unreadable" };
  } finally {
    await handle.close();
  }
}

// One writer per file in this process; the next waits for the one before.
const queues = new Map<string, Promise<void>>();

/** Changes the registry in one read, change and atomic write (temporary
 * file 0600, rename). `change` answers the new list and a result, or null
 * to write nothing. */
export function updateRegistry<T>(
  home: string,
  uid: number | undefined,
  change: (
    computers: readonly RegistryEntry[],
  ) => Readonly<{ computers: readonly RegistryEntry[] | null; result: T }>,
): Promise<T | Readonly<{ refused: "registry-unreadable" }>> {
  const key = registryPath(home);
  const before = queues.get(key) ?? Promise.resolve();
  const run = before.then(async () => {
    const read = await readRegistry(home, uid);
    if ("refused" in read) return read;
    const { computers, result } = change(read.computers);
    if (computers !== null) {
      const directory = await ensureComputersDirectory(home, uid);
      await writeDurableFile(
        directory,
        registryName,
        Buffer.from(
          `${JSON.stringify({ v: 1, computers }, null, 2)}\n`,
          "utf8",
        ),
      );
    }
    return result;
  });
  const after = run.then(
    () => undefined,
    () => undefined,
  );
  queues.set(key, after);
  void after.then(() => {
    if (queues.get(key) === after) queues.delete(key);
  });
  return run;
}

/** One computer by its id, or null. */
export async function registryEntry(
  home: string,
  uid: number | undefined,
  deviceId: string,
): Promise<RegistryEntry | null> {
  const read = await readRegistry(home, uid);
  return "computers" in read
    ? (read.computers.find((entry) => entry.deviceId === deviceId) ?? null)
    : null;
}

/** The raw 32-byte ed25519 key of `ssh-ed25519 <base64>`. */
export function rawEd25519(publicKey: string): Buffer | null {
  const key = parseDeviceKey(publicKey);
  if ("refused" in key || key.type !== "ssh-ed25519") return null;
  const blob = Buffer.from(key.key, "base64");
  // string "ssh-ed25519" (4 + 11), then the key as a string (4 + 32).
  return blob.length === 51 ? blob.subarray(19) : null;
}
