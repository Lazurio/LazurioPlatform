import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import { parseOrganizationSettingsValues } from "../folder/state";
import type { OrganizationSettingsValues } from "../organizations/organization-settings";
import { parseUniqueJson } from "../providers/unique-json";
import { writeDurableFile } from "../update/durable-file";
import {
  isDetailCode,
  isSettingKey,
  isSettingsVersion,
  itemOutcomes,
  type SettingsItem,
} from "./contract";
import { canonicalSettings } from "./governance";
import {
  type SettingsSource,
  type StatusError,
  settingsSources,
  statusErrors,
} from "./status";

// The last applied version of one Folder's Organization settings (decision
// F45): what was asked, what the source answered, what was applied and when,
// and why the last question brought nothing new. Product state of the Folder
// in the per-user install base, beside the update state and the content
// locks: `<base>/organization-settings/<Folder digest>.json`, 0600 in a 0700
// directory, written durably. Not in the Folder's `.lazurio/`, which admits
// no entry it does not know (and releases before this one must keep reading
// it). Bookkeeping, never authority: what applies is what the Folder
// records; a record that cannot be read is `corrupt`, never guessed.

export type AppliedState = Readonly<{
  source: SettingsSource;
  /** The version applied last: a commit, `none`, or null when never. */
  version: string | null;
  organization: Readonly<{ githubOrgId: number; login: string }> | null;
  /** The settings of that version, as delivered. */
  settings: OrganizationSettingsValues;
  /** The keys of settings at that version this release does not know. */
  unsupported: readonly string[];
  appliedAt: string | null;
  items: readonly SettingsItem[];
  lastError: Exclude<StatusError, "state_unreadable"> | null;
  /** When the source last answered (200, 304 or 409). */
  checkedAt: string | null;
}>;

export type StateRead =
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "corrupt" }>
  | Readonly<{ kind: "state"; state: AppliedState }>;

export type SettingsStateStore = Readonly<{
  read(): Promise<StateRead>;
  write(state: AppliedState): Promise<void>;
}>;

const schemaVersion = 1;
const bytesMax = 64 * 1024;
const keys = [
  "schemaVersion",
  "source",
  "version",
  "organization",
  "settings",
  "unsupported",
  "appliedAt",
  "items",
  "lastError",
  "checkedAt",
];

/** The record of one Folder (its canonical path) in an install base. */
export function settingsStateFile(base: string, folder: string): string {
  const digest = createHash("sha256").update(folder).digest("hex");
  return join(base, "organization-settings", `${digest.slice(0, 32)}.json`);
}

const time = (value: unknown): value is string | null =>
  value === null ||
  (typeof value === "string" &&
    value.length <= 40 &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value) &&
    Number.isFinite(Date.parse(value)));

function record(input: unknown): Readonly<Record<string, unknown>> | null {
  return typeof input === "object" && input !== null && !Array.isArray(input)
    ? (input as Readonly<Record<string, unknown>>)
    : null;
}

/** The record in its exact form; throws on anything else. */
export function parseAppliedState(input: unknown): AppliedState {
  const value = record(input);
  if (
    value === null ||
    Object.keys(value).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(value, key)) ||
    value.schemaVersion !== schemaVersion
  )
    throw new Error("Invalid Organization settings record");
  const organization =
    value.organization === null ? null : record(value.organization);
  if (
    !(settingsSources as readonly unknown[]).includes(value.source) ||
    (value.version !== null && !isSettingsVersion(value.version)) ||
    (value.organization !== null &&
      (organization === null ||
        Object.keys(organization).sort().join(",") !== "githubOrgId,login" ||
        typeof organization.githubOrgId !== "number" ||
        !Number.isSafeInteger(organization.githubOrgId) ||
        organization.githubOrgId < 1 ||
        typeof organization.login !== "string" ||
        !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(
          organization.login,
        ))) ||
    !Array.isArray(value.unsupported) ||
    value.unsupported.length > 64 ||
    !value.unsupported.every(isSettingKey) ||
    !time(value.appliedAt) ||
    !time(value.checkedAt) ||
    (value.lastError !== null &&
      (value.lastError === "state_unreadable" ||
        !(statusErrors as readonly unknown[]).includes(value.lastError))) ||
    !Array.isArray(value.items) ||
    value.items.length > 72
  )
    throw new Error("Invalid Organization settings record");
  const items = value.items.map((entry): SettingsItem => {
    const item = record(entry);
    if (
      item === null ||
      Object.keys(item).sort().join(",") !== "detail,key,outcome" ||
      !isSettingKey(item.key) ||
      !(itemOutcomes as readonly unknown[]).includes(item.outcome) ||
      (item.detail !== null && !isDetailCode(item.detail))
    )
      throw new Error("Invalid Organization settings record item");
    return Object.freeze({
      key: item.key as string,
      outcome: item.outcome as SettingsItem["outcome"],
      detail: item.detail as string | null,
    });
  });
  const settings = parseOrganizationSettingsValues(value.settings);
  if (JSON.stringify(settings) !== JSON.stringify(value.settings))
    throw new Error("Organization settings record not canonical");
  return Object.freeze({
    source: value.source as SettingsSource,
    version: value.version as string | null,
    organization:
      organization === null
        ? null
        : Object.freeze({
            githubOrgId: organization.githubOrgId as number,
            login: organization.login as string,
          }),
    settings,
    unsupported: Object.freeze([...(value.unsupported as string[])]),
    appliedAt: value.appliedAt,
    items: Object.freeze(items),
    lastError: value.lastError as AppliedState["lastError"],
    checkedAt: value.checkedAt,
  });
}

/** What is written: the state in its one representation. */
function serialize(state: AppliedState): Uint8Array {
  const value = {
    schemaVersion,
    source: state.source,
    version: state.version,
    organization: state.organization,
    settings: canonicalSettings(state.settings),
    unsupported: state.unsupported,
    appliedAt: state.appliedAt,
    items: state.items,
    lastError: state.lastError,
    checkedAt: state.checkedAt,
  };
  // Never write what would not read back.
  parseAppliedState(JSON.parse(JSON.stringify(value)));
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

async function readOwnedRecord(file: string): Promise<string | null> {
  let before: Awaited<ReturnType<typeof lstat>>;
  try {
    before = await lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (
    !before.isFile() ||
    before.nlink !== 1 ||
    before.uid !== process.getuid?.() ||
    (before.mode & 0o077) !== 0 ||
    before.size > bytesMax
  )
    throw new Error("Unsafe Organization settings record");
  const handle = await open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const opened = await handle.stat();
    if (opened.ino !== before.ino || opened.dev !== before.dev)
      throw new Error("Organization settings record changed");
    const buffer = Buffer.alloc(Math.min(Number(opened.size), bytesMax) + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > bytesMax)
      throw new Error("Organization settings record too large");
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      buffer.subarray(0, bytesRead),
    );
  } finally {
    await handle.close();
  }
}

/** The record of `folder` in the install base `base`. */
export function fileStateStore(
  base: string,
  folder: string,
): SettingsStateStore {
  const file = settingsStateFile(base, folder);
  const directory = join(base, "organization-settings");
  return Object.freeze({
    async read(): Promise<StateRead> {
      try {
        const text = await readOwnedRecord(file);
        if (text === null) return { kind: "absent" };
        return {
          kind: "state",
          state: parseAppliedState(parseUniqueJson(text)),
        };
      } catch {
        return { kind: "corrupt" };
      }
    },
    async write(state) {
      const bytes = serialize(state);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const entry = await lstat(directory);
      if (!entry.isDirectory() || entry.uid !== process.getuid?.())
        throw new Error("Unsafe Organization settings directory");
      await chmod(directory, 0o700);
      await writeDurableFile(
        directory,
        file.slice(directory.length + 1),
        bytes,
      );
    },
  });
}

/** A record kept only in this process: where no install base is known. */
export function memoryStateStore(initial?: AppliedState): SettingsStateStore {
  let kept: AppliedState | null = initial ?? null;
  return Object.freeze({
    async read(): Promise<StateRead> {
      return kept === null
        ? { kind: "absent" }
        : { kind: "state", state: kept };
    },
    async write(state) {
      // The same check as the file: never keep what would not read back.
      serialize(state);
      kept = state;
    },
  });
}
