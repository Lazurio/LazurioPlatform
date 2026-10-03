import { crc32 } from "node:zlib";

// A streaming ZIP writer for the Files page's folder download (decision F34),
// after PKWARE's APPNOTE 6.3.10. Entries are stored (method 0): office files,
// images and video are compressed already, and storing streams at disk speed
// with no CPU cost. Each file's header is written before its bytes with bit
// 3 set, and its CRC-32 and sizes follow in a data descriptor, so nothing is
// read twice and nothing is buffered beyond one chunk; the central directory
// at the end carries every value again, which is what extractors read.
// Names are UTF-8 (bit 11). ZIP64 is used only where a value needs it: a file
// of 4 GiB or more, an entry starting past 4 GiB, or 65,535 entries or more.
// Each entry carries the extended timestamp (0x5455), so its modification
// time survives time zones where an extractor reads it.

export type ZipInput =
  | Readonly<{ kind: "directory"; name: string; modified: Date }>
  | Readonly<{
      kind: "file";
      /** The entry's path in the archive, `/`-separated, no trailing `/`. */
      name: string;
      modified: Date;
      /** The size the file is expected to have; decides ZIP64 for it. */
      size: number;
      /** The bytes, opened when the writer reaches the entry. An iterable
       * that fails before its first chunk leaves the entry out whole; one
       * that fails later breaks the archive. */
      content: () => AsyncIterable<Uint8Array>;
    }>;

/** Where ZIP64 starts. Only tests lower these, to exercise ZIP64 with small
 * data; the format's own limits are the defaults. */
export type ZipLimits = Readonly<{ value: number; entries: number }>;
const formatLimits: ZipLimits = { value: 0xffffffff, entries: 0xffff };

const versionMadeBy = (3 << 8) | 45; // Unix, APPNOTE 4.5
const flagDescriptor = 0x0008;
const flagUtf8 = 0x0800;
const fileAttributes = 0o100644 * 0x10000;
const directoryAttributes = 0o040755 * 0x10000 + 0x10;
const centralChunkBytes = 1024 * 1024;

class Writer {
  readonly bytes: Uint8Array;
  private readonly view: DataView;
  private offset = 0;
  constructor(length: number) {
    this.bytes = new Uint8Array(length);
    this.view = new DataView(this.bytes.buffer);
  }
  u16(value: number) {
    this.view.setUint16(this.offset, value, true);
    this.offset += 2;
    return this;
  }
  u32(value: number) {
    this.view.setUint32(this.offset, value >>> 0, true);
    this.offset += 4;
    return this;
  }
  u64(value: number) {
    this.view.setBigUint64(this.offset, BigInt(value), true);
    this.offset += 8;
    return this;
  }
  u8(value: number) {
    this.view.setUint8(this.offset, value);
    this.offset += 1;
    return this;
  }
  raw(value: Uint8Array) {
    this.bytes.set(value, this.offset);
    this.offset += value.length;
    return this;
  }
}

/** MS-DOS date and time in the local time of this process, clamped to the
 * range the format can hold (1980–2107). */
export function dosDateTime(
  when: Date,
): Readonly<{ time: number; date: number }> {
  const year = when.getFullYear();
  if (Number.isNaN(year) || year < 1980) return { time: 0, date: (1 << 5) | 1 };
  if (year > 2107)
    return {
      time: (23 << 11) | (59 << 5) | 29,
      date: (127 << 9) | (12 << 5) | 31,
    };
  return {
    time:
      (when.getHours() << 11) |
      (when.getMinutes() << 5) |
      Math.floor(when.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate(),
  };
}

// The extended timestamp extra field: the modification time in UTC seconds.
function timestampExtra(when: Date): Uint8Array {
  const seconds = Math.floor(when.getTime() / 1000);
  const clamped = Number.isFinite(seconds)
    ? Math.min(Math.max(seconds, 0), 0xffffffff)
    : 0;
  return new Writer(9).u16(0x5455).u16(5).u8(1).u32(clamped).bytes;
}

// The ZIP64 extended information extra field with the given 8-byte values,
// in the order APPNOTE 4.5.3 fixes: size, compressed size, offset.
function zip64Extra(values: readonly number[]): Uint8Array {
  const writer = new Writer(4 + 8 * values.length)
    .u16(0x0001)
    .u16(8 * values.length);
  for (const value of values) writer.u64(value);
  return writer.bytes;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(
    parts.reduce((sum, part) => sum + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

type Recorded = Readonly<{
  name: Uint8Array;
  directory: boolean;
  /** The local header declared ZIP64 (a file of the limit or more). */
  zip64: boolean;
  crc: number;
  size: number;
  offset: number;
  time: number;
  date: number;
  timestamp: Uint8Array;
}>;

function localHeader(
  name: Uint8Array,
  flags: number,
  zip64: boolean,
  time: number,
  date: number,
  timestamp: Uint8Array,
): Uint8Array {
  // With bit 3 the CRC and sizes come in the data descriptor; a ZIP64 entry
  // says so with the 0xFFFFFFFF markers and both sizes in its extra field.
  const extra = concat(zip64 ? [zip64Extra([0, 0]), timestamp] : [timestamp]);
  return new Writer(30 + name.length + extra.length)
    .u32(0x04034b50)
    .u16(zip64 ? 45 : 20)
    .u16(flags)
    .u16(0)
    .u16(time)
    .u16(date)
    .u32(0)
    .u32(zip64 ? 0xffffffff : 0)
    .u32(zip64 ? 0xffffffff : 0)
    .u16(name.length)
    .u16(extra.length)
    .raw(name)
    .raw(extra).bytes;
}

function centralHeader(entry: Recorded, limits: ZipLimits): Uint8Array {
  const bigSize = entry.zip64 || entry.size >= limits.value;
  const bigOffset = entry.offset >= limits.value;
  const values = [
    ...(bigSize ? [entry.size, entry.size] : []),
    ...(bigOffset ? [entry.offset] : []),
  ];
  const extra = concat(
    values.length > 0
      ? [zip64Extra(values), entry.timestamp]
      : [entry.timestamp],
  );
  const zip64 = values.length > 0;
  return new Writer(46 + entry.name.length + extra.length)
    .u32(0x02014b50)
    .u16(versionMadeBy)
    .u16(zip64 ? 45 : 20)
    .u16(entry.directory ? flagUtf8 : flagUtf8 | flagDescriptor)
    .u16(0)
    .u16(entry.time)
    .u16(entry.date)
    .u32(entry.crc)
    .u32(bigSize ? 0xffffffff : entry.size)
    .u32(bigSize ? 0xffffffff : entry.size)
    .u16(entry.name.length)
    .u16(extra.length)
    .u16(0)
    .u16(0)
    .u16(0)
    .u32(entry.directory ? directoryAttributes : fileAttributes)
    .u32(bigOffset ? 0xffffffff : entry.offset)
    .raw(entry.name)
    .raw(extra).bytes;
}

const encoder = new TextEncoder();

/** The archive of `inputs`, in order, as a stream of byte chunks. */
export async function* zipArchive(
  inputs: AsyncIterable<ZipInput>,
  limits: ZipLimits = formatLimits,
): AsyncGenerator<Uint8Array> {
  const recorded: Recorded[] = [];
  let offset = 0;
  for await (const input of inputs) {
    const directory = input.kind === "directory";
    const name = encoder.encode(directory ? `${input.name}/` : input.name);
    const { time, date } = dosDateTime(input.modified);
    const timestamp = timestampExtra(input.modified);
    if (input.kind === "directory") {
      const header = localHeader(name, flagUtf8, false, time, date, timestamp);
      recorded.push({
        name,
        directory,
        zip64: false,
        crc: 0,
        size: 0,
        offset,
        time,
        date,
        timestamp,
      });
      offset += header.length;
      yield header;
      continue;
    }
    // The header goes out only once the content has opened, so a file that
    // cannot be read is left out instead of breaking the archive.
    const content = input.content()[Symbol.asyncIterator]();
    let step: IteratorResult<Uint8Array>;
    try {
      step = await content.next();
    } catch {
      continue;
    }
    const zip64 = input.size >= limits.value;
    const start = offset;
    let crc = 0;
    let size = 0;
    try {
      const header = localHeader(
        name,
        flagUtf8 | flagDescriptor,
        zip64,
        time,
        date,
        timestamp,
      );
      offset += header.length;
      yield header;
      while (!step.done) {
        crc = crc32(step.value, crc);
        size += step.value.byteLength;
        offset += step.value.byteLength;
        yield step.value;
        step = await content.next();
      }
    } finally {
      // Cancelled mid-file (the client went away): close the file.
      if (!step.done) await content.return?.();
    }
    const descriptor = zip64
      ? new Writer(24).u32(0x08074b50).u32(crc).u64(size).u64(size).bytes
      : new Writer(16).u32(0x08074b50).u32(crc).u32(size).u32(size).bytes;
    offset += descriptor.length;
    yield descriptor;
    recorded.push({
      name,
      directory,
      zip64,
      crc,
      size,
      offset: start,
      time,
      date,
      timestamp,
    });
  }
  // The central directory, in chunks of about a megabyte.
  const centralOffset = offset;
  let pending: Uint8Array[] = [];
  let pendingBytes = 0;
  for (const entry of recorded) {
    const header = centralHeader(entry, limits);
    pending.push(header);
    pendingBytes += header.length;
    offset += header.length;
    if (pendingBytes >= centralChunkBytes) {
      yield concat(pending);
      pending = [];
      pendingBytes = 0;
    }
  }
  const centralSize = offset - centralOffset;
  const count = recorded.length;
  const zip64End =
    count >= limits.entries ||
    centralSize >= limits.value ||
    centralOffset >= limits.value;
  if (zip64End) {
    const recordOffset = offset;
    pending.push(
      new Writer(56)
        .u32(0x06064b50)
        .u64(44)
        .u16(versionMadeBy)
        .u16(45)
        .u32(0)
        .u32(0)
        .u64(count)
        .u64(count)
        .u64(centralSize)
        .u64(centralOffset).bytes,
      new Writer(20).u32(0x07064b50).u32(0).u64(recordOffset).u32(1).bytes,
    );
  }
  pending.push(
    new Writer(22)
      .u32(0x06054b50)
      .u16(0)
      .u16(0)
      .u16(zip64End && count >= limits.entries ? 0xffff : count)
      .u16(zip64End && count >= limits.entries ? 0xffff : count)
      .u32(zip64End && centralSize >= limits.value ? 0xffffffff : centralSize)
      .u32(
        zip64End && centralOffset >= limits.value ? 0xffffffff : centralOffset,
      )
      .u16(0).bytes,
  );
  yield concat(pending);
}
