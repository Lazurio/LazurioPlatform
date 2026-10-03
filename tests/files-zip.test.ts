import { afterEach, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { dosDateTime, type ZipInput, zipArchive } from "../src/files/zip";
import { readZip, unzipTest } from "./fixtures/zip-reader";

// The streaming ZIP writer of the folder download (decision F34): a valid
// archive by an independent reader and by `unzip -t`, UTF-8 names, ZIP64
// exactly where a value needs it (exercised with lowered limits), an
// unreadable file left out whole, and a cancelled stream that closes the file
// it was reading.

let root: string | undefined;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

const modified = new Date("2026-10-02T14:30:10.000Z");
const encoder = new TextEncoder();

function file(name: string, ...chunks: string[]): ZipInput {
  const bytes = chunks.map((chunk) => encoder.encode(chunk));
  return {
    kind: "file",
    name,
    modified,
    size: bytes.reduce((sum, chunk) => sum + chunk.length, 0),
    content: async function* () {
      yield* bytes;
    },
  };
}

async function* inputs(...items: ZipInput[]): AsyncGenerator<ZipInput> {
  yield* items;
}

async function collect(stream: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return new Uint8Array(Buffer.concat(chunks));
}

async function written(bytes: Uint8Array) {
  root ??= await realpath(await mkdtemp(join(tmpdir(), "files-zip-")));
  const path = join(root, `archive-${crypto.randomUUID()}.zip`);
  await writeFile(path, bytes);
  return path;
}

test("an archive of folders and files with Czech names reads back byte for byte", async () => {
  const bytes = await collect(
    zipArchive(
      inputs(
        { kind: "directory", name: "Úkol", modified },
        file("Úkol/Zpráva pro klienta.docx", "PK-like ", "content"),
        { kind: "directory", name: "Úkol/podklady", modified },
        file("Úkol/podklady/čísla.csv", "1;2;3\n"),
        file("Úkol/prázdný.txt"),
      ),
    ),
  );
  const archive = readZip(bytes);
  expect(archive.zip64End).toBe(false);
  expect(
    archive.entries.map((entry) => [
      entry.name,
      new TextDecoder().decode(entry.data),
    ]),
  ).toEqual([
    ["Úkol/", ""],
    ["Úkol/Zpráva pro klienta.docx", "PK-like content"],
    ["Úkol/podklady/", ""],
    ["Úkol/podklady/čísla.csv", "1;2;3\n"],
    ["Úkol/prázdný.txt", ""],
  ]);
  for (const entry of archive.entries) {
    // Stored, UTF-8 names; files carry a data descriptor, folders do not.
    expect(entry.method).toBe(0);
    expect(entry.flags & 0x0800).toBe(0x0800);
    expect(entry.flags & 0x0008).toBe(entry.name.endsWith("/") ? 0 : 0x0008);
    expect(entry.zip64).toBe(false);
    expect(entry.versionNeeded).toBe(20);
    // Unix modes, and the MS-DOS folder bit on folders.
    expect(entry.external >>> 16).toBe(
      entry.name.endsWith("/") ? 0o040755 : 0o100644,
    );
    expect(entry.external & 0x10).toBe(entry.name.endsWith("/") ? 0x10 : 0);
  }
  const tested = await unzipTest(await written(bytes));
  if (tested !== null) {
    expect(tested.code).toBe(0);
    expect(tested.output).toContain("No errors detected");
  }
});

test("ZIP64 is written exactly where a value reaches the limit, and still reads back", async () => {
  // Lowered limits: a file of 100 bytes or more, an entry starting at byte
  // 100 or later and three entries or more need ZIP64.
  const limits = { value: 100, entries: 3 };
  const large = "x".repeat(150);
  const bytes = await collect(
    zipArchive(
      inputs(
        file("small.txt", "small"),
        file("large.txt", large.slice(0, 70), large.slice(70)),
        file("late.txt", "late"),
      ),
      limits,
    ),
  );
  const archive = readZip(bytes);
  expect(archive.zip64End).toBe(true);
  expect(
    archive.entries.map((entry) => [entry.name, entry.size, entry.zip64]),
  ).toEqual([
    ["small.txt", 5, false],
    // Its size and its offset: ZIP64 in both headers, an 8-byte descriptor.
    ["large.txt", 150, true],
    ["late.txt", 4, true],
  ]);
  expect(new TextDecoder().decode(archive.entries[1]?.data)).toBe(large);
  expect(archive.entries[1]?.versionNeeded).toBe(45);
  const tested = await unzipTest(await written(bytes));
  if (tested !== null) {
    expect(tested.code).toBe(0);
    expect(tested.output).toContain("No errors detected");
  }
});

test("a file that cannot be opened is left out whole; the archive stays valid", async () => {
  const unreadable: ZipInput = {
    kind: "file",
    name: "locked.bin",
    modified,
    size: 10,
    // biome-ignore lint/correctness/useYield: it fails before its first chunk
    content: async function* () {
      throw new Error("EACCES");
    },
  };
  const bytes = await collect(
    zipArchive(
      inputs(file("before.txt", "a"), unreadable, file("after.txt", "b")),
    ),
  );
  expect(readZip(bytes).entries.map((entry) => entry.name)).toEqual([
    "before.txt",
    "after.txt",
  ]);
});

test("a file that breaks after its first chunk breaks the archive instead of hiding the damage", async () => {
  const broken: ZipInput = {
    kind: "file",
    name: "broken.bin",
    modified,
    size: 10,
    content: async function* () {
      yield encoder.encode("12345");
      throw new Error("EIO");
    },
  };
  await expect(collect(zipArchive(inputs(broken)))).rejects.toThrow("EIO");
});

test("a cancelled archive closes the file it was reading", async () => {
  let closed = false;
  const endless: ZipInput = {
    kind: "file",
    name: "endless.bin",
    modified,
    size: 1 << 30,
    content: async function* () {
      try {
        for (;;) yield new Uint8Array(1024);
      } finally {
        closed = true;
      }
    },
  };
  const stream = zipArchive(inputs(endless));
  // The local header, then two chunks of the file, then the consumer leaves.
  await stream.next();
  await stream.next();
  await stream.next();
  await stream.return(undefined);
  expect(closed).toBe(true);
});

test("the stored CRC-32 is the standard one, computed across chunks", async () => {
  const bytes = await collect(
    zipArchive(inputs(file("hello.txt", "hel", "lo"))),
  );
  expect(readZip(bytes).entries[0]?.crc).toBe(crc32("hello") >>> 0);
  expect(crc32("hello") >>> 0).toBe(0x3610a686);
});

test("MS-DOS time is local and clamped to 1980–2107", () => {
  const local = new Date(2026, 9, 2, 14, 30, 11);
  expect(dosDateTime(local)).toEqual({
    time: (14 << 11) | (30 << 5) | 5,
    date: (46 << 9) | (10 << 5) | 2,
  });
  expect(dosDateTime(new Date(1970, 0, 1))).toEqual({
    time: 0,
    date: (1 << 5) | 1,
  });
  expect(dosDateTime(new Date(2200, 0, 1)).date).toBe(
    (127 << 9) | (12 << 5) | 31,
  );
  expect(dosDateTime(new Date(Number.NaN)).date).toBe((1 << 5) | 1);
});
