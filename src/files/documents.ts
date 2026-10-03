import { randomBytes } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  statfs,
  unlink,
} from "node:fs/promises";
import { isAbsolute, join, relative, sep, win32 } from "node:path";
import {
  maxNameBytes,
  type PathRefusal,
  segmentRefusal,
  uploadNames,
  utf8Bytes,
} from "./rules";

// The Documents adapter of decision F34: the filesystem effects behind the
// Launchpad's Files routes and `lazurio files link`. The served root is the
// Documents folder of the account the process runs as, `<home>/Documents`,
// and nothing outside it: every path is resolved with realpath and must stay
// inside the root's own realpath, every name on the way must pass the rules
// (rules.ts), and only regular files and directories are served. This is
// the boundary of what the Launchpad hands to a browser, not a sandbox
// against the account itself, which can change the folder at any moment.

export type DocumentsRefusal =
  | PathRefusal
  /** No home, or `<home>/Documents` is not a usable directory: not a
   * directory, or one that holds the home folder or overlaps the Lazurio
   * Folder. */
  | "documents-unavailable"
  /** The path resolves (through a link) outside the Documents folder. */
  | "outside-documents"
  | "not-found"
  /** Neither a regular file nor a directory: a FIFO, socket or device. */
  | "not-regular"
  | "not-directory"
  | "not-file";

export type UploadRefusal =
  | DocumentsRefusal
  /** The filesystem has less free space than the upload needs, or ran out. */
  | "disk-full"
  /** The body ended or broke before its declared length arrived. */
  | "upload-incomplete"
  /** Every candidate name is taken or too long. */
  | "name-unavailable";

export type Refused<Reason extends string = DocumentsRefusal> = Readonly<{
  refusal: Reason;
}>;

const refused = <Reason extends string>(refusal: Reason): Refused<Reason> =>
  Object.freeze({ refusal });

export const isRefused = <Reason extends string>(
  value: object,
): value is Refused<Reason> => "refusal" in value;

/** What the adapter needs of its process: trusted composition, never request
 * input. */
export type DocumentsHost = Readonly<{
  /** The account's home: HOME, or USERPROFILE on Windows. */
  home: string | undefined;
  platform: string;
  /** The Lazurio Folder, which the Documents folder must not overlap. */
  folder?: string | undefined;
  /** Free bytes on the filesystem of `directory`; null when unknown. A seam
   * for tests; the default asks `statfs`. */
  freeBytes?: (directory: string) => Promise<number | null>;
  /** The hard link an upload is published by. A seam for tests of a
   * filesystem without hard links; the default is `link`. */
  link?: (existing: string, created: string) => Promise<void>;
}>;

/** The home whose Documents folder is served, as `os.homedir()` reads it:
 * HOME, or USERPROFILE on Windows. A OneDrive-redirected Documents folder of
 * Windows is not followed: the folder is `%USERPROFILE%\Documents`. */
export function accountHome(
  env: Readonly<Record<string, string | undefined>>,
  platform: string,
): string | undefined {
  const home = platform === "win32" ? env.USERPROFILE : env.HOME;
  const absolute = platform === "win32" ? win32.isAbsolute : isAbsolute;
  return home !== undefined && absolute(home) ? home : undefined;
}

/** The Documents host of this process: its account's home and platform,
 * and the Lazurio Folder it serves. */
export function processDocumentsHost(
  folder: string | undefined,
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform: string = process.platform,
): DocumentsHost {
  return Object.freeze({ home: accountHome(env, platform), platform, folder });
}

/** The Documents folder of an account, opened: its path and its realpath. */
export type Documents = Readonly<{
  path: string;
  real: string;
  platform: string;
}>;

export type DocumentEntry =
  | Readonly<{
      kind: "file";
      /** The names of its real path inside the Documents folder. */
      segments: readonly string[];
      real: string;
      size: number;
      modified: Date;
    }>
  | Readonly<{
      kind: "directory";
      segments: readonly string[];
      real: string;
      modified: Date;
    }>;

const errorCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;

// What a lookup may meet when a path does not lead to an entry.
const missingCodes = new Set([
  "ENOENT",
  "ENOTDIR",
  "ELOOP",
  "ENAMETOOLONG",
  "EACCES",
  "EPERM",
]);
const missing = (error: unknown) => missingCodes.has(errorCode(error) ?? "");

/** Whether `child` is `parent` or lies inside it; both real paths. */
function contains(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return (
    path === "" ||
    (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))
  );
}

/** The Documents folder of `host.home`, by its realpath. `create` makes the
 * folder itself, and nothing else, when it is missing: listing and uploading
 * do, a download or a link does not. The folder must be a directory that
 * neither holds the home folder nor overlaps the Lazurio Folder, and inside
 * the home it must lie on a visible path, so a Documents link to `~`, `/` or
 * `~/.ssh` serves nothing. */
export async function openDocuments(
  host: DocumentsHost,
  options: Readonly<{ create: boolean }>,
): Promise<Documents | Refused> {
  const { home } = host;
  if (home === undefined || !isAbsolute(home))
    return refused("documents-unavailable");
  const path = join(home, "Documents");
  const resolve = async () => {
    try {
      return await realpath(path);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return null;
      throw error;
    }
  };
  let real: string | null;
  try {
    real = await resolve();
    if (real === null) {
      if (!options.create) return refused("not-found");
      try {
        await mkdir(path, { mode: 0o700 });
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
      }
      real = await resolve();
      if (real === null) return refused("documents-unavailable");
    }
    if (!(await stat(real)).isDirectory())
      return refused("documents-unavailable");
  } catch {
    return refused("documents-unavailable");
  }
  const homeReal = await realpath(home).catch(() => home);
  if (contains(real, homeReal)) return refused("documents-unavailable");
  if (
    contains(homeReal, real) &&
    relative(homeReal, real)
      .split(sep)
      .some((segment) => segmentRefusal(segment, host.platform) !== null)
  )
    return refused("documents-unavailable");
  if (host.folder !== undefined) {
    const folder = host.folder;
    const folderReal = await realpath(folder).catch(() => folder);
    if (contains(real, folderReal) || contains(folderReal, real))
      return refused("documents-unavailable");
  }
  return Object.freeze({ path, real, platform: host.platform });
}

/** A real path inside the Documents folder as its entry: the names of its
 * path inside the folder must pass the rules too (a link into a hidden
 * folder serves nothing), and only a regular file or a directory is one. */
async function entryOf(
  documents: Documents,
  real: string,
): Promise<DocumentEntry | Refused> {
  if (!contains(documents.real, real)) return refused("outside-documents");
  const inside = relative(documents.real, real);
  const segments = inside === "" ? [] : inside.split(sep);
  for (const segment of segments) {
    const refusal = segmentRefusal(segment, documents.platform);
    if (refusal !== null) return refused(refusal);
  }
  let info: Stats;
  try {
    info = await stat(real);
  } catch (error) {
    if (missing(error)) return refused("not-found");
    throw error;
  }
  return entryFromStat(segments, real, info) ?? refused("not-regular");
}

function entryFromStat(
  segments: readonly string[],
  real: string,
  info: Stats,
): DocumentEntry | null {
  if (info.isFile())
    return Object.freeze({
      kind: "file",
      segments: Object.freeze([...segments]),
      real,
      size: info.size,
      modified: info.mtime,
    });
  if (info.isDirectory())
    return Object.freeze({
      kind: "directory",
      segments: Object.freeze([...segments]),
      real,
      modified: info.mtime,
    });
  return null;
}

/** The entry at a real path, as the Files page would serve it: inside the
 * Documents folder, visible on its whole path, a file or a folder. What
 * `lazurio files link` checks a path on disk with. */
export const documentAt = (
  documents: Documents,
  real: string,
): Promise<DocumentEntry | Refused> => entryOf(documents, real);

/** The entry of a path the rules accepted (rules.ts), followed through links
 * and kept inside the Documents folder. */
export async function resolveDocument(
  documents: Documents,
  segments: readonly string[],
): Promise<DocumentEntry | Refused> {
  let real: string;
  try {
    real = await realpath(join(documents.real, ...segments));
  } catch (error) {
    if (missing(error)) return refused("not-found");
    throw error;
  }
  return entryOf(documents, real);
}

/** One name of a directory as an entry, or null when it is not served: a
 * hidden or refused name, a link that leaves the folder or dangles, a
 * special file, or a name that vanished meanwhile. */
async function childEntry(
  documents: Documents,
  directory: DocumentEntry,
  name: string,
): Promise<DocumentEntry | null> {
  if (segmentRefusal(name, documents.platform) !== null) return null;
  const path = join(directory.real, name);
  let info: Stats;
  try {
    info = await lstat(path);
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
  if (!info.isSymbolicLink())
    return entryFromStat([...directory.segments, name], path, info);
  let real: string;
  try {
    real = await realpath(path);
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
  const entry = await entryOf(documents, real);
  return isRefused(entry) ? null : entry;
}

// Folders first, then names as a person reads them (numbers by value, case
// and accents ignored), ties by code unit so the order is total.
const collator = new Intl.Collator("en", {
  numeric: true,
  sensitivity: "base",
});
const byName = (left: string, right: string) =>
  collator.compare(left, right) || (left < right ? -1 : left > right ? 1 : 0);
function byKindAndName(
  left: Readonly<{ name: string; kind: string }>,
  right: Readonly<{ name: string; kind: string }>,
): number {
  if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
  return byName(left.name, right.name);
}

export type ListedEntry = Readonly<{
  name: string;
  kind: "file" | "directory";
  /** Bytes of a file; null for a directory. */
  size: number | null;
  /** ISO 8601, UTC. */
  modifiedAt: string;
}>;

async function children(
  documents: Documents,
  directory: DocumentEntry,
): Promise<{ name: string; entry: DocumentEntry; kind: string }[]> {
  const found: { name: string; entry: DocumentEntry; kind: string }[] = [];
  for (const name of await readdir(directory.real)) {
    const entry = await childEntry(documents, directory, name);
    if (entry !== null) found.push({ name, entry, kind: entry.kind });
  }
  return found.sort(byKindAndName);
}

/** The visible entries of a directory, folders first, then by name. */
export async function listDocuments(
  documents: Documents,
  directory: DocumentEntry,
): Promise<readonly ListedEntry[]> {
  return (await children(documents, directory)).map(({ name, entry }) =>
    Object.freeze({
      name,
      kind: entry.kind,
      size: entry.kind === "file" ? entry.size : null,
      modifiedAt: entry.modified.toISOString(),
    }),
  );
}

export type TreeEntry =
  | Readonly<{ kind: "directory"; path: readonly string[]; modified: Date }>
  | Readonly<{
      kind: "file";
      path: readonly string[];
      modified: Date;
      size: number;
      real: string;
    }>;

/** Every visible entry under a directory, the directory itself first (path
 * `[]`), depth first, in listing order: what its ZIP holds. Links are
 * followed while they stay inside the folder, as the listing shows them, so
 * a folder reached by a link and by its own name is in it twice; a link back
 * to a folder on the way down would never end and is left out. A folder that
 * cannot be read is left out with its contents; the folder asked for itself
 * must be readable. */
export async function* documentTree(
  documents: Documents,
  directory: DocumentEntry,
): AsyncGenerator<TreeEntry> {
  const top = await children(documents, directory);
  yield Object.freeze({
    kind: "directory",
    path: Object.freeze([]),
    modified: directory.modified,
  });
  async function* below(
    found: Awaited<ReturnType<typeof children>>,
    prefix: readonly string[],
    ancestors: ReadonlySet<string>,
  ): AsyncGenerator<TreeEntry> {
    for (const { name, entry } of found) {
      const path = Object.freeze([...prefix, name]);
      if (entry.kind === "file") {
        yield Object.freeze({
          kind: "file",
          path,
          modified: entry.modified,
          size: entry.size,
          real: entry.real,
        });
        continue;
      }
      if (ancestors.has(entry.real)) continue;
      let inner: Awaited<ReturnType<typeof children>>;
      try {
        inner = await children(documents, entry);
      } catch (error) {
        if (missing(error)) continue;
        throw error;
      }
      yield Object.freeze({
        kind: "directory",
        path,
        modified: entry.modified,
      });
      yield* below(inner, path, new Set([...ancestors, entry.real]));
    }
  }
  yield* below(top, [], new Set([directory.real]));
}

const readChunkBytes = 256 * 1024;
// Opening a FIFO for reading waits for a writer; without blocking, the
// check below refuses it instead. Windows has no such flag and no FIFOs.
const readFlags =
  constants.O_NONBLOCK === undefined
    ? "r"
    : constants.O_RDONLY | constants.O_NONBLOCK;

/** The bytes `[start, end)` of a regular file, read when the consumer pulls
 * them. The file is opened lazily and closed when the reading ends, fails or
 * is cancelled. A file that is no longer regular, or that ends early, throws:
 * the response breaks instead of looking complete. */
export async function* readDocument(
  real: string,
  start: number,
  end: number,
): AsyncGenerator<Uint8Array> {
  const handle = await open(real, readFlags);
  try {
    if (!(await handle.stat()).isFile())
      throw new Error("Not a regular file any more");
    let position = start;
    while (position < end) {
      const length = Math.min(readChunkBytes, end - position);
      // A fresh buffer per chunk: the consumer may still hold the last one.
      const buffer = new Uint8Array(length);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      if (bytesRead === 0) throw new Error("The file ended early");
      position += bytesRead;
      yield bytesRead === length ? buffer : buffer.subarray(0, bytesRead);
    }
  } finally {
    await handle.close();
  }
}

// Temporary files of an upload in progress: hidden, so never listed, served
// or archived. A process killed during an upload leaves one behind; the next
// upload into the same folder removes leftovers older than an hour (an
// upload in progress writes far more often than that).
const uploadTemporary = /^\.lazurio-upload-[0-9a-f]{16}\.part$/;
const staleUploadMs = 60 * 60 * 1000;

async function removeStaleUploads(directory: string, now: number) {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return;
  }
  for (const name of names) {
    if (!uploadTemporary.test(name)) continue;
    const path = join(directory, name);
    try {
      const info = await lstat(path);
      if (info.isFile() && now - info.mtimeMs > staleUploadMs)
        await rm(path, { force: true });
    } catch {}
  }
}

async function statfsFreeBytes(directory: string): Promise<number | null> {
  try {
    const info = await statfs(directory);
    return Number(info.bavail) * Number(info.bsize);
  } catch {
    return null;
  }
}

async function syncDirectory(directory: string, platform: string) {
  // Windows cannot open a directory for a sync.
  if (platform === "win32") return;
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

class IncompleteUpload extends Error {}

// A filesystem without hard links (exFAT, FAT, some network and synced
// folders) answers `link` with one of these.
const linkUnsupported = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"]);

/** Publishes `temporary` under `target` only when no entry of that name
 * exists: true when published, false when the name is taken. A hard link
 * makes the name appear complete at once; without hard links the name is
 * first reserved exclusively and the file is then moved over the empty
 * reservation, which the publisher alone holds. */
async function publish(
  host: DocumentsHost,
  temporary: string,
  target: string,
): Promise<boolean> {
  try {
    await (host.link ?? link)(temporary, target);
    return true;
  } catch (error) {
    const code = errorCode(error);
    if (code === "EEXIST") return false;
    if (!linkUnsupported.has(code ?? "")) throw error;
  }
  try {
    await (await open(target, "wx", 0o666)).close();
  } catch (error) {
    if (errorCode(error) === "EEXIST") return false;
    throw error;
  }
  try {
    await rename(temporary, target);
  } catch (error) {
    await rm(target, { force: true });
    throw error;
  }
  return true;
}

/** Streams an upload of exactly `length` bytes into `directory` under
 * `name`: written to a hidden temporary file in the same directory, synced,
 * then published under the first free name (`name`, `name (2).ext`, …),
 * which never replaces an existing entry. The temporary file is removed on
 * every failure, a client that goes away included. The name is stored in
 * NFC, the form people type. */
export async function uploadDocument(
  host: DocumentsHost,
  documents: Documents,
  directory: DocumentEntry,
  name: string,
  body: ReadableStream<Uint8Array> | null,
  length: number,
  now: () => number = Date.now,
): Promise<Readonly<{ name: string; size: number }> | Refused<UploadRefusal>> {
  const normalized = name.normalize("NFC");
  const refusal = segmentRefusal(normalized, documents.platform);
  if (refusal !== null) return refused(refusal);
  if (directory.kind !== "directory") return refused("not-directory");
  await removeStaleUploads(directory.real, now());
  const free = await (host.freeBytes ?? statfsFreeBytes)(directory.real);
  if (free !== null && free < length) return refused("disk-full");
  const temporary = join(
    directory.real,
    `.lazurio-upload-${randomBytes(8).toString("hex")}.part`,
  );
  const handle = await open(temporary, "wx", 0o666);
  let size = 0;
  try {
    if (body !== null) {
      const reader = body.getReader();
      try {
        for (;;) {
          let chunk: Awaited<ReturnType<typeof reader.read>>;
          try {
            chunk = await reader.read();
          } catch {
            // The client went away, or the connection broke.
            throw new IncompleteUpload();
          }
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > length) throw new IncompleteUpload();
          let written = 0;
          while (written < chunk.value.byteLength) {
            const { bytesWritten } = await handle.write(
              chunk.value,
              written,
              chunk.value.byteLength - written,
            );
            if (bytesWritten === 0) throw new Error("Nothing was written");
            written += bytesWritten;
          }
        }
      } finally {
        reader.releaseLock();
      }
    }
    if (size !== length) throw new IncompleteUpload();
    await handle.sync();
    await handle.close();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(temporary, { force: true });
    const code = errorCode(error);
    if (code === "ENOSPC" || code === "EDQUOT") return refused("disk-full");
    // A broken or short body: the client went away or sent other than it
    // declared.
    if (error instanceof IncompleteUpload) return refused("upload-incomplete");
    throw error;
  }
  try {
    for (const candidate of uploadNames(normalized)) {
      if (utf8Bytes(candidate) > maxNameBytes) break;
      if (!(await publish(host, temporary, join(directory.real, candidate))))
        continue;
      // Published: the name is in place. What follows is cleanup and
      // durability of the name; neither undoes the upload. After a move
      // there is no temporary file left to remove.
      await unlink(temporary).catch(() => undefined);
      await syncDirectory(directory.real, documents.platform).catch(
        () => undefined,
      );
      return Object.freeze({ name: candidate, size });
    }
    return refused("name-unavailable");
  } finally {
    await rm(temporary, { force: true });
  }
}
