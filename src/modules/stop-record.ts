import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Why an app of a module last stopped, kept so that whoever looks later
 * (`lazurio module status`, the Launchpad, a person reading the journal) sees
 * who stopped it and why instead of a bare `stopped` (LazurioPlatform#1035).
 *
 * - `asleep`: the Launchpad's sweep found no open connection to any of its
 *   listeners for a tab's idle time (root decision 0195 point 23). The next
 *   Open, or the gateway's `ensure` of a navigation, starts it again.
 * - `stop-requested`: an explicit Stop, by the Launchpad (Apps) or the CLI.
 *
 * One small file per app under the account's state directory, never in the
 * Folder's `.lazurio` (whose layout refuses unknown entries). Advisory only:
 * a record that cannot be written or read never changes what runs. */
export type StopRecord = Readonly<{
  reason: "asleep" | "stop-requested";
  by: "launchpad-sweep" | "launchpad" | "cli";
  /** When it stopped (ISO 8601, UTC). */
  at: string;
  /** `asleep`: since when no sweep saw a connection (ISO 8601, UTC). */
  unusedSince?: string;
  /** `asleep`: the idle time it waited, in minutes. */
  idleMinutes?: number;
}>;

export type StopRecordKey = Readonly<{
  folder: string;
  organization: string;
  module: string;
  app: string;
}>;

export function stopRecordDirectory(
  home: string | undefined,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
  const state = env.XDG_STATE_HOME?.startsWith("/")
    ? env.XDG_STATE_HOME
    : home === undefined
      ? null
      : join(home, ".local", "state");
  return state === null ? null : join(state, "lazurio", "app-stops");
}

function recordPath(directory: string, key: StopRecordKey) {
  const id = createHash("sha256")
    .update(
      ["v1", key.folder, key.organization, key.module, key.app].join("\0"),
    )
    .digest("hex")
    .slice(0, 32);
  return join(directory, `${id}.json`);
}

export async function writeStopRecord(
  directory: string | null,
  key: StopRecordKey,
  record: StopRecord,
): Promise<boolean> {
  if (directory === null) return false;
  const path = recordPath(directory, key);
  const staged = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(
      staged,
      `${JSON.stringify({ v: 1, ...key, ...record })}\n`,
      { mode: 0o600 },
    );
    await rename(staged, path);
    return true;
  } catch {
    await rm(staged, { force: true }).catch(() => undefined);
    return false;
  }
}

export async function clearStopRecord(
  directory: string | null,
  key: StopRecordKey,
): Promise<void> {
  if (directory === null) return;
  await rm(recordPath(directory, key), { force: true }).catch(() => undefined);
}

const reasons = new Set(["asleep", "stop-requested"]);
const actors = new Set(["launchpad-sweep", "launchpad", "cli"]);

export async function readStopRecord(
  directory: string | null,
  key: StopRecordKey,
): Promise<StopRecord | null> {
  if (directory === null) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(await readFile(recordPath(directory, key), "utf8"));
  } catch {
    return null;
  }
  if (
    parsed?.v !== 1 ||
    parsed.folder !== key.folder ||
    parsed.organization !== key.organization ||
    parsed.module !== key.module ||
    parsed.app !== key.app ||
    !reasons.has(parsed.reason as string) ||
    !actors.has(parsed.by as string) ||
    typeof parsed.at !== "string"
  )
    return null;
  return Object.freeze({
    reason: parsed.reason as StopRecord["reason"],
    by: parsed.by as StopRecord["by"],
    at: parsed.at,
    ...(typeof parsed.unusedSince === "string"
      ? { unusedSince: parsed.unusedSince }
      : {}),
    ...(typeof parsed.idleMinutes === "number"
      ? { idleMinutes: parsed.idleMinutes }
      : {}),
  });
}
