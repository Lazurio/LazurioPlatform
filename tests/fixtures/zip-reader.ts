import { crc32 } from "node:zlib";

// An independent reader of the archives the Files page streams (decision
// F35): it starts from the end-of-central-directory record, follows a ZIP64
// locator when there is one, reads every central directory record, then
// checks each entry where its local header says it is: the same name, the
// stored bytes with their CRC-32, and the data descriptor after them. The
// archive must be contiguous: entries back to back, then the directory.

export type ReadEntry = Readonly<{
  name: string;
  flags: number;
  method: number;
  crc: number;
  size: number;
  offset: number;
  external: number;
  versionNeeded: number;
  zip64: boolean;
  data: Uint8Array;
}>;

export type ReadArchive = Readonly<{
  entries: readonly ReadEntry[];
  zip64End: boolean;
}>;

const decoder = new TextDecoder("utf-8", { fatal: true });

export function readZip(bytes: Uint8Array): ReadArchive {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (at: number) => view.getUint16(at, true);
  const u32 = (at: number) => view.getUint32(at, true);
  const u64 = (at: number) => Number(view.getBigUint64(at, true));
  const expectAt = (at: number, signature: number, what: string) => {
    if (at < 0 || at + 4 > bytes.length || u32(at) !== signature)
      throw new Error(`${what} missing at ${at}`);
  };
  const end = bytes.length - 22;
  expectAt(end, 0x06054b50, "end of central directory");
  let count = u16(end + 10);
  let centralSize = u32(end + 12);
  let centralOffset = u32(end + 16);
  let zip64End = false;
  if (end >= 20 && u32(end - 20) === 0x07064b50) {
    zip64End = true;
    const record = u64(end - 20 + 8);
    expectAt(record, 0x06064b50, "ZIP64 end record");
    if (record + 56 !== end - 20)
      throw new Error("ZIP64 end record is not right before its locator");
    count = u64(record + 32);
    centralSize = u64(record + 40);
    centralOffset = u64(record + 48);
    if (centralOffset + centralSize !== record)
      throw new Error("Central directory does not end at the ZIP64 record");
  } else if (centralOffset + centralSize !== end)
    throw new Error("Central directory does not end at its end record");
  const entries: ReadEntry[] = [];
  let at = centralOffset;
  let expectedLocal = 0;
  for (let index = 0; index < count; index++) {
    expectAt(at, 0x02014b50, "central directory record");
    const flags = u16(at + 8);
    const method = u16(at + 10);
    const crc = u32(at + 16);
    let compressed = u32(at + 20);
    let size = u32(at + 24);
    const nameLength = u16(at + 28);
    const extraLength = u16(at + 30);
    const commentLength = u16(at + 32);
    const external = u32(at + 38);
    let offset = u32(at + 42);
    const versionNeeded = u16(at + 6);
    const nameBytes = bytes.subarray(at + 46, at + 46 + nameLength);
    const name =
      flags & 0x0800
        ? decoder.decode(nameBytes)
        : new TextDecoder("latin1").decode(nameBytes);
    let extra = at + 46 + nameLength;
    const extraEnd = extra + extraLength;
    let zip64 = false;
    while (extra < extraEnd) {
      const id = u16(extra);
      const length = u16(extra + 2);
      if (id === 0x0001) {
        zip64 = true;
        let field = extra + 4;
        if (size === 0xffffffff) {
          size = u64(field);
          field += 8;
        }
        if (compressed === 0xffffffff) {
          compressed = u64(field);
          field += 8;
        }
        if (offset === 0xffffffff) offset = u64(field);
      }
      extra += 4 + length;
    }
    at = extraEnd + commentLength;
    if (offset !== expectedLocal)
      throw new Error(`Entry ${name} does not follow the previous one`);
    expectAt(offset, 0x04034b50, `local header of ${name}`);
    const localNameLength = u16(offset + 26);
    const localExtraLength = u16(offset + 28);
    const localName = bytes.subarray(
      offset + 30,
      offset + 30 + localNameLength,
    );
    if (decoder.decode(localName) !== decoder.decode(nameBytes))
      throw new Error(`Local and central names differ for ${name}`);
    // A ZIP64 extra in the local header makes the data descriptor's sizes
    // 8 bytes each (APPNOTE 4.3.9.2).
    let localZip64 = false;
    for (
      let field = offset + 30 + localNameLength;
      field < offset + 30 + localNameLength + localExtraLength;
      field += 4 + u16(field + 2)
    )
      if (u16(field) === 0x0001) localZip64 = true;
    const dataStart = offset + 30 + localNameLength + localExtraLength;
    if (compressed !== size) throw new Error(`${name} is not stored`);
    const data = bytes.subarray(dataStart, dataStart + size);
    if (crc32(data) >>> 0 !== crc)
      throw new Error(`CRC-32 of ${name} does not match`);
    let next = dataStart + size;
    if (flags & 0x0008) {
      expectAt(next, 0x08074b50, `data descriptor of ${name}`);
      const descriptorSize = localZip64 ? u64(next + 16) : u32(next + 12);
      if (u32(next + 4) !== crc || descriptorSize !== size)
        throw new Error(`Data descriptor of ${name} does not match`);
      next += localZip64 ? 24 : 16;
    }
    expectedLocal = next;
    entries.push({
      name,
      flags,
      method,
      crc,
      size,
      offset,
      external,
      versionNeeded,
      zip64,
      data,
    });
  }
  if (expectedLocal !== centralOffset)
    throw new Error("The central directory does not follow the last entry");
  if (at !== centralOffset + centralSize)
    throw new Error("The central directory size does not match");
  return { entries, zip64End };
}

/** `unzip -t` on the archive when an `unzip` is installed: its exit code and
 * output, or null without one. */
export async function unzipTest(
  path: string,
): Promise<Readonly<{ code: number; output: string }> | null> {
  const unzip = Bun.which("unzip");
  if (unzip === null) return null;
  const child = Bun.spawn([unzip, "-t", path], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, output: `${stdout}${stderr}` };
}
