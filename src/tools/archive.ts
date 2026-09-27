import { gunzipSync, inflateRawSync } from "node:zlib";

// A release archive of a curated tool (decision F19), read in memory after its
// SHA-256 was verified against the release's published checksums. Nothing is
// ever extracted as a tree: every entry is checked first, and only the one
// named regular file (the tool's binary) comes out. Refused outright: an
// absolute name, a `..` segment, a backslash or NUL in a name, a link whose
// target leaves the archive root, a device, FIFO or other special entry, an
// encrypted or ZIP64 zip, and anything the reader does not understand.
export class UnsafeArchiveError extends Error {}

const maxExpanded = 512 * 1024 * 1024;

function fail(message: string): never {
  throw new UnsafeArchiveError(message);
}

// The one form of an entry name: `./` prefixes and a trailing slash dropped,
// every other oddity refused.
export function archiveEntryName(raw: string): string {
  if (raw.length === 0 || raw.includes("\0") || raw.includes("\\"))
    fail("Invalid entry name");
  if (raw.startsWith("/")) fail("Absolute entry name");
  const segments = raw
    .split("/")
    .filter((segment) => segment !== "" && segment !== ".");
  if (segments.length === 0) return ".";
  if (segments.some((segment) => segment === ".."))
    fail("Parent segment in entry name");
  return segments.join("/");
}

// A link target, relative to the directory of the link, must stay inside the
// archive root.
function checkLinkTarget(entry: string, target: string) {
  if (target.length === 0 || target.includes("\0") || target.includes("\\"))
    fail("Invalid link target");
  if (target.startsWith("/")) fail("Absolute link target");
  const depth: string[] = entry.split("/").slice(0, -1);
  for (const segment of target.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (depth.length === 0) fail("Link target outside the archive");
      depth.pop();
    } else depth.push(segment);
  }
}

type Entry =
  | Readonly<{ kind: "file"; name: string; data: () => Uint8Array }>
  | Readonly<{ kind: "directory"; name: string }>
  | Readonly<{ kind: "link"; name: string; target: string }>;

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

function cString(block: Uint8Array, start: number, length: number): string {
  const slice = block.subarray(start, start + length);
  const end = slice.indexOf(0);
  return text(end === -1 ? slice : slice.subarray(0, end));
}

function octal(block: Uint8Array, start: number, length: number): number {
  const first = block[start] ?? 0;
  // Base-256 sizes belong to entries far larger than any tool binary.
  if (first & 0x80) fail("Unsupported numeric field");
  const value = cString(block, start, length).trim();
  if (value === "") return 0;
  if (!/^[0-7]+$/.test(value)) fail("Invalid numeric field");
  const number = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(number)) fail("Invalid numeric field");
  return number;
}

// PAX records: "<length> <key>=<value>\n".
function paxRecords(data: Uint8Array): Map<string, string> {
  const records = new Map<string, string>();
  const content = text(data);
  let offset = 0;
  while (offset < content.length) {
    const space = content.indexOf(" ", offset);
    if (space === -1) fail("Invalid PAX record");
    const length = Number.parseInt(content.slice(offset, space), 10);
    if (!Number.isSafeInteger(length) || length <= 0)
      fail("Invalid PAX record");
    // The length counts bytes; the header is ASCII in every real archive.
    const record = content.slice(space + 1, offset + length - 1);
    const equals = record.indexOf("=");
    if (equals === -1) fail("Invalid PAX record");
    records.set(record.slice(0, equals), record.slice(equals + 1));
    offset += length;
  }
  return records;
}

function tarEntries(archive: Uint8Array): Entry[] {
  const entries: Entry[] = [];
  let offset = 0;
  let longName: string | undefined;
  let longLink: string | undefined;
  let pax = new Map<string, string>();
  while (offset + 512 <= archive.length) {
    const block = archive.subarray(offset, offset + 512);
    if (block.every((byte) => byte === 0)) break;
    const size = octal(block, 124, 12);
    const type = String.fromCharCode(block[156] ?? 0);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > archive.length) fail("Truncated entry");
    const data = archive.subarray(dataStart, dataEnd);
    offset = dataStart + Math.ceil(size / 512) * 512;
    if (type === "x") {
      pax = paxRecords(data);
      continue;
    }
    if (type === "g") continue;
    if (type === "L") {
      longName = cString(data, 0, data.length);
      continue;
    }
    if (type === "K") {
      longLink = cString(data, 0, data.length);
      continue;
    }
    const magic = cString(block, 257, 6);
    const prefix = magic.startsWith("ustar") ? cString(block, 345, 155) : "";
    const header = cString(block, 0, 100);
    const raw =
      pax.get("path") ??
      longName ??
      (prefix === "" ? header : `${prefix}/${header}`);
    const linkRaw = pax.get("linkpath") ?? longLink ?? cString(block, 157, 100);
    pax = new Map();
    longName = undefined;
    longLink = undefined;
    const name = archiveEntryName(raw);
    if (type === "0" || type === "\0" || type === "7")
      entries.push({ kind: "file", name, data: () => data });
    else if (type === "5") entries.push({ kind: "directory", name });
    else if (type === "2") {
      checkLinkTarget(name, linkRaw);
      entries.push({ kind: "link", name, target: linkRaw });
    } else if (type === "1") {
      // A hard link names another entry of the archive.
      entries.push({ kind: "link", name, target: archiveEntryName(linkRaw) });
    } else fail("Unsupported entry type");
  }
  return entries;
}

const u16 = (view: DataView, at: number) => view.getUint16(at, true);
const u32 = (view: DataView, at: number) => view.getUint32(at, true);

function zipEntries(archive: Uint8Array): Entry[] {
  let expanded = 0;
  const view = new DataView(
    archive.buffer,
    archive.byteOffset,
    archive.byteLength,
  );
  let end = -1;
  for (
    let at = archive.length - 22;
    at >= Math.max(0, archive.length - 22 - 0xffff);
    at--
  )
    if (u32(view, at) === 0x06054b50) {
      end = at;
      break;
    }
  if (end === -1) fail("Not a zip archive");
  const count = u16(view, end + 10);
  const directorySize = u32(view, end + 12);
  const directoryOffset = u32(view, end + 16);
  if (
    count === 0xffff ||
    directorySize === 0xffffffff ||
    directoryOffset === 0xffffffff
  )
    fail("ZIP64 is not supported");
  if (directoryOffset + directorySize > end) fail("Invalid zip directory");
  const entries: Entry[] = [];
  let at = directoryOffset;
  for (let index = 0; index < count; index++) {
    if (at + 46 > end || u32(view, at) !== 0x02014b50)
      fail("Invalid zip directory entry");
    const flags = u16(view, at + 8);
    const method = u16(view, at + 10);
    const compressed = u32(view, at + 20);
    const size = u32(view, at + 24);
    const nameLength = u16(view, at + 28);
    const extraLength = u16(view, at + 30);
    const commentLength = u16(view, at + 32);
    const madeBy = u16(view, at + 4) >> 8;
    const external = u32(view, at + 38);
    const local = u32(view, at + 42);
    const raw = text(archive.subarray(at + 46, at + 46 + nameLength));
    at += 46 + nameLength + extraLength + commentLength;
    if (flags & 0x1) fail("Encrypted zip entry");
    if (compressed === 0xffffffff || size === 0xffffffff)
      fail("ZIP64 is not supported");
    // The same bound as the expanded tar: by the declared sizes before
    // anything is inflated, and inflation itself never exceeds the declared
    // size of its entry.
    expanded += size;
    if (size > maxExpanded || expanded > maxExpanded)
      fail("Archive expands beyond the limit");
    const name = archiveEntryName(raw);
    // Unix file type in the high half of the external attributes.
    const unixMode = madeBy === 3 ? external >>> 16 : 0;
    const fileType = unixMode & 0o170000;
    const read = () => {
      if (local + 30 > archive.length || u32(view, local) !== 0x04034b50)
        fail("Invalid zip local header");
      const start = local + 30 + u16(view, local + 26) + u16(view, local + 28);
      if (start + compressed > archive.length) fail("Truncated zip entry");
      const stored = archive.subarray(start, start + compressed);
      if (method === 0) {
        if (compressed !== size) fail("Invalid stored zip entry");
        return stored;
      }
      if (method !== 8) fail("Unsupported zip compression");
      const inflated = new Uint8Array(
        inflateRawSync(stored, { maxOutputLength: Math.max(size, 1) }),
      );
      if (inflated.length !== size) fail("Invalid zip entry size");
      return inflated;
    };
    if (raw.endsWith("/") || fileType === 0o040000)
      entries.push({ kind: "directory", name });
    else if (fileType === 0o120000) {
      const target = text(read());
      checkLinkTarget(name, target);
      entries.push({ kind: "link", name, target });
    } else if (fileType === 0 || fileType === 0o100000)
      entries.push({ kind: "file", name, data: read });
    else fail("Unsupported entry type");
  }
  return entries;
}

export type ArchiveFormat = "tar.gz" | "zip";

/** Every entry checked, then the bytes of the one regular file at exactly
 * `path`. A missing file, or a link at that path, is refused. */
export function extractArchiveFile(
  archive: Uint8Array,
  format: ArchiveFormat,
  path: string,
): Uint8Array {
  const entries =
    format === "zip"
      ? zipEntries(archive)
      : tarEntries(
          new Uint8Array(gunzipSync(archive, { maxOutputLength: maxExpanded })),
        );
  const wanted = archiveEntryName(path);
  const matches = entries.filter((entry) => entry.name === wanted);
  const [match] = matches;
  if (matches.length !== 1 || match === undefined)
    fail(matches.length === 0 ? "Binary not in archive" : "Duplicate entry");
  if (match.kind !== "file") fail("Binary is not a regular file");
  return match.data();
}
