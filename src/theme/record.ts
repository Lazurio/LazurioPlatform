import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  acquireFileLock,
  type FileLock,
  FileLockError,
} from "../platform/flock";
import { parseUniqueJson } from "../providers/unique-json";
import { writeDurableFile } from "../update/durable-file";
import {
  defaultEnvironmentTheme,
  type EnvironmentThemeId,
  isEnvironmentThemeId,
} from "./palettes";

// The Environment's theme record (root decision 0208 point 1): one per
// Environment, owned by its Launchpad, `{theme, revision, setAt}`. The
// Launchpad's Settings → Obecné and `lazurio theme` read and change it,
// each change at the revision it was asked at (compare and set), and
// `/.lazurio/shell.json` carries it to every app (src/theme/palettes.ts,
// `shellThemeOf`). It is product state of the Folder, never its profile: it
// is not part of `FolderPreferences` or the profile, so it feeds no
// generated instruction and needs no Folder transaction.
//
// Where: in the per-user install base, beside the record of the Organization's
// settings (decision F45) and the content locks,
// `<base>/theme/<Folder digest>.json`, 0600 in a 0700 directory, written
// durably (temporary file, sync, rename, directory sync), so a reader sees
// the old or the new record whole. Not in the Folder's `.lazurio/`, which
// admits no entry it does not know: a release before this one would refuse
// the whole Folder. One change at a time across the CLI and the Launchpad: a
// kernel `flock` on `<base>/theme/<Folder digest>.lock`, coordination only
// (src/platform/flock.ts), since the record itself is replaced atomically. A
// Launchpad without an install base (a development run) keeps it in memory.
// A record that cannot be read is the default theme at revision 0, and the
// next change replaces it: every failure degrades to the design system's look.

export type EnvironmentThemeRecord = Readonly<{
  theme: EnvironmentThemeId;
  /** 0 while nobody chose a theme; one more with every change. */
  revision: number;
  /** When it was last changed (ISO 8601, UTC); null while never. */
  setAt: string | null;
}>;

export const defaultThemeRecord: EnvironmentThemeRecord = Object.freeze({
  theme: defaultEnvironmentTheme,
  revision: 0,
  setAt: null,
});

/** What a change answers: the record after it, `unchanged` where it already
 * was the asked theme, or why nothing changed. */
export type ThemeChange =
  | Readonly<{ kind: "set" | "unchanged"; record: EnvironmentThemeRecord }>
  | Readonly<{
      kind: "blocked";
      reason: "theme-changed";
      record: EnvironmentThemeRecord;
    }>
  | Readonly<{ kind: "blocked"; reason: "theme-busy" }>;

export type ThemeStore = Readonly<{
  /** The record; the default one where there is none or it cannot be read. */
  read(): Promise<EnvironmentThemeRecord>;
  /** Changes the theme to `theme` if the record is still at `expected` (any
   * revision with null): `theme-changed` with the current record otherwise.
   * Asking for the theme it has is `unchanged`, whatever the revision. */
  change(
    theme: EnvironmentThemeId,
    expected: number | null,
  ): Promise<ThemeChange>;
}>;

/** The store as an Environment whose theme is fixed reads it (root decision
 * 0208 point 6): while `fixed()`, every read is the default Lazurio record,
 * whatever the record says, so neither a theme chosen before the
 * Environment became public nor a record written past the Launchpad reaches
 * its visitors. Changes go to `store`; on such an Environment the routes and
 * `lazurio theme set` refuse them before they get here. */
export function fixedThemeReads(
  store: ThemeStore,
  fixed: () => boolean,
): ThemeStore {
  return Object.freeze({
    read: () => (fixed() ? Promise.resolve(defaultThemeRecord) : store.read()),
    change: (theme: EnvironmentThemeId, expected: number | null) =>
      store.change(theme, expected),
  });
}

const schemaVersion = 1;
const bytesMax = 4 * 1024;
const keys = ["schemaVersion", "theme", "revision", "setAt"];

const time = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length <= 40 &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value) &&
  Number.isFinite(Date.parse(value));

/** The record in its exact form; throws on anything else. */
export function parseThemeRecord(input: unknown): EnvironmentThemeRecord {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    throw new Error("Invalid theme record");
  const value = input as Readonly<Record<string, unknown>>;
  if (
    Object.keys(value).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(value, key)) ||
    value.schemaVersion !== schemaVersion ||
    !isEnvironmentThemeId(value.theme) ||
    typeof value.revision !== "number" ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1 ||
    !time(value.setAt)
  )
    throw new Error("Invalid theme record");
  return Object.freeze({
    theme: value.theme,
    revision: value.revision,
    setAt: value.setAt,
  });
}

/** What is written: the record in its one representation. */
function serialize(record: EnvironmentThemeRecord): Uint8Array {
  const value = {
    schemaVersion,
    theme: record.theme,
    revision: record.revision,
    setAt: record.setAt,
  };
  // Never write what would not read back.
  parseThemeRecord(JSON.parse(JSON.stringify(value)));
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

/** The change itself, the same for every store: the record after `theme`
 * was asked at `expected`, or why it stays as it is. */
export function changeRecord(
  current: EnvironmentThemeRecord,
  theme: EnvironmentThemeId,
  expected: number | null,
  now: Date,
): ThemeChange {
  if (current.theme === theme) return { kind: "unchanged", record: current };
  if (expected !== null && expected !== current.revision)
    return { kind: "blocked", reason: "theme-changed", record: current };
  return {
    kind: "set",
    record: Object.freeze({
      theme,
      revision: current.revision + 1,
      setAt: now.toISOString(),
    }),
  };
}

/** The record file of one Folder (its canonical path) in an install base. */
export function themeRecordFile(base: string, folder: string): string {
  const digest = createHash("sha256").update(folder).digest("hex");
  return join(base, "theme", `${digest.slice(0, 32)}.json`);
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
    throw new Error("Unsafe theme record");
  const handle = await open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const opened = await handle.stat();
    if (opened.ino !== before.ino || opened.dev !== before.dev)
      throw new Error("Theme record changed");
    const buffer = Buffer.alloc(Math.min(Number(opened.size), bytesMax) + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > bytesMax) throw new Error("Theme record too large");
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      buffer.subarray(0, bytesRead),
    );
  } finally {
    await handle.close();
  }
}

/** How long a change waits for another one of the same Folder. */
export const themeLockWaitMs = 3_000;

/** The record of `folder` in the install base `base`. */
export function fileThemeStore(
  base: string,
  folder: string,
  options: Readonly<{ now?: () => Date; lockWaitMs?: number }> = {},
): ThemeStore {
  const file = themeRecordFile(base, folder);
  const directory = join(base, "theme");
  const lockFile = file.replace(/\.json$/, ".lock");
  const now = options.now ?? (() => new Date());
  async function read(): Promise<EnvironmentThemeRecord> {
    try {
      const text = await readOwnedRecord(file);
      return text === null
        ? defaultThemeRecord
        : parseThemeRecord(parseUniqueJson(text));
    } catch {
      return defaultThemeRecord;
    }
  }
  return Object.freeze({
    read,
    async change(theme, expected) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const entry = await lstat(directory);
      if (!entry.isDirectory() || entry.uid !== process.getuid?.())
        throw new Error("Unsafe theme directory");
      await chmod(directory, 0o700);
      let lock: FileLock;
      try {
        lock = await acquireFileLock(lockFile, {
          timeoutMs: options.lockWaitMs ?? themeLockWaitMs,
        });
      } catch (error) {
        if (error instanceof FileLockError && error.reason === "busy")
          return { kind: "blocked", reason: "theme-busy" };
        throw error;
      }
      try {
        // A writer of this record killed mid-write left only its temporary
        // file (`writeDurableFile`'s name); another Folder's are its own.
        const leftover = new RegExp(
          `^\\.${basename(file).replace(/\./g, "\\.")}\\.tmp-[0-9a-f]{16}$`,
        );
        for (const name of await readdir(directory))
          if (leftover.test(name))
            await rm(join(directory, name), { force: true });
        const answer = changeRecord(await read(), theme, expected, now());
        if (answer.kind === "set")
          await writeDurableFile(
            directory,
            file.slice(directory.length + 1),
            serialize(answer.record),
          );
        return answer;
      } finally {
        await lock.release();
      }
    },
  });
}

/** A record kept only in this process: where no install base is known. */
export function memoryThemeStore(
  initial: EnvironmentThemeRecord = defaultThemeRecord,
  now: () => Date = () => new Date(),
): ThemeStore {
  let kept = initial;
  return Object.freeze({
    read: async () => kept,
    async change(theme, expected) {
      const answer = changeRecord(kept, theme, expected, now());
      if (answer.kind === "set") {
        serialize(answer.record);
        kept = answer.record;
      }
      return answer;
    },
  });
}
