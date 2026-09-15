import { open, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Fetcher } from "tuf-js";
import { inspectOwnedDirectory } from "../folder/owned-directory";
import { readOwnedDeclarationBytes } from "../providers/owned-json";

/** Write-ahead evidence, not trust. Shared custody/order checks for all replay. */
export async function readMetadataJournal(directory: string) {
  await inspectOwnedDirectory(directory);
  const names = (await readdir(directory)).sort();
  if (names.length > 260) throw new Error("Replay record limit");
  const records: { name: string; bytes: Buffer }[] = [];
  let bytes = 0;
  for (const [index, name] of names.entries()) {
    const prefix = `${String(index + 1).padStart(3, "0")}-`;
    const leaf = name.slice(prefix.length);
    if (
      !name.startsWith(prefix) ||
      !/^(?:[1-9][0-9]*\.)?(?:root|timestamp|snapshot|targets)\.json$/.test(
        leaf,
      )
    )
      throw new Error("Incomplete or unknown replay record");
    const value = await readOwnedDeclarationBytes(join(directory, name));
    bytes += value.length;
    if (bytes > 32 * 1024 * 1024) throw new Error("Replay byte limit");
    records.push({ name: leaf, bytes: value });
  }
  return { records, bytes };
}

/** Write-ahead evidence, NOT trusted metadata. The owner provides a new private
 * directory (or a completely validated prefix for append), retains failures
 * and must reverify records before any recovery use.
 * Never record origin credentials/query strings. TUF currently requests metadata
 * sequentially; refuse concurrent use rather than ambiguously ordering records.
 */
export class MetadataJournalFetcher implements Fetcher {
  private readonly base: URL;
  private count = 0;
  private bytes = 0;
  private busy = false;
  private failed = false;
  private readonly recordLimit: number;
  private readonly byteLimit: number;

  constructor(
    private readonly transport: Fetcher,
    private readonly directory: string,
    metadataBaseUrl: string,
    retained: Readonly<{ records: number; bytes: number }> = {
      records: 0,
      bytes: 0,
    },
    limits: Readonly<{ records: number; bytes: number }> = {
      records: 260,
      bytes: 32 * 1024 * 1024,
    },
    private readonly assertHeld?: () => Promise<void>,
  ) {
    // Snapshot once: a new cycle starts at record 001 even when its budget
    // has been reduced by evidence retained in earlier cycles.
    const records = retained.records;
    const bytes = retained.bytes;
    const recordLimit = limits.records;
    const byteLimit = limits.bytes;
    // Only an owner-bound replay may supply the counts of the complete,
    // validated retained prefix. New records always use exclusive creation.
    if (
      !Number.isSafeInteger(recordLimit) ||
      recordLimit < 0 ||
      recordLimit > 260 ||
      !Number.isSafeInteger(byteLimit) ||
      byteLimit < 0 ||
      byteLimit > 32 * 1024 * 1024 ||
      !Number.isSafeInteger(records) ||
      records < 0 ||
      records > recordLimit ||
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      bytes > byteLimit
    )
      throw new Error("Invalid retained metadata journal bounds");
    this.count = records;
    this.bytes = bytes;
    this.recordLimit = recordLimit;
    this.byteLimit = byteLimit;
    try {
      this.base = new URL(metadataBaseUrl);
    } catch {
      throw new Error("Invalid metadata journal origin");
    }
    if (
      this.base.username ||
      this.base.password ||
      this.base.search ||
      this.base.hash ||
      !this.base.pathname.endsWith("/")
    )
      throw new Error("Ambiguous metadata journal base");
  }

  async downloadBytes(url: string, maxLength: number): Promise<Buffer> {
    if (this.failed) throw new Error("Metadata journal requires recovery");
    if (this.busy) throw new Error("Concurrent metadata journal use refused");
    let request: URL;
    try {
      request = new URL(url);
    } catch {
      throw new Error("Invalid metadata journal request");
    }
    if (!Number.isSafeInteger(maxLength) || maxLength < 0)
      throw new Error("Invalid metadata journal length");
    const name = request.pathname.slice(this.base.pathname.length);
    if (
      request.origin !== this.base.origin ||
      !request.pathname.startsWith(this.base.pathname) ||
      request.username ||
      request.password ||
      request.search ||
      request.hash ||
      !/^(?:[1-9][0-9]*\.)?(?:root|timestamp|snapshot|targets)\.json$/.test(
        name,
      )
    )
      throw new Error("Metadata journal request refused");
    if (this.count >= this.recordLimit)
      throw new Error("Metadata journal record limit");
    if (this.bytes >= this.byteLimit)
      throw new Error("Metadata journal byte limit");
    this.busy = true;
    let recording = false;
    try {
      await this.assertHeld?.();
      await inspectOwnedDirectory(this.directory);
      // A signed length is still bounded by the local operation's resource policy.
      const limit = Math.min(
        maxLength,
        1024 * 1024,
        this.byteLimit - this.bytes,
      );
      const bytes = await this.transport.downloadBytes(url, limit);
      recording = true;
      await this.assertHeld?.();
      if (bytes.length > limit) throw new Error("Metadata journal byte limit");
      const path = join(
        this.directory,
        `${String(++this.count).padStart(3, "0")}-${name}`,
      );
      const file = await open(path, "wx", 0o600);
      try {
        await file.writeFile(bytes);
        await file.sync();
      } finally {
        await file.close();
      }
      const directory = await open(this.directory, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
      this.bytes += bytes.length;
      await this.assertHeld?.();
      return bytes;
    } catch (error) {
      // Normal root 404s contain no record and must remain usable by TUF.
      if (recording) this.failed = true;
      throw error;
    } finally {
      this.busy = false;
    }
  }

  downloadFile<T>(
    url: string,
    maxLength: number,
    handler: (file: string) => Promise<T>,
  ): Promise<T> {
    if (this.failed)
      return Promise.reject(new Error("Metadata journal requires recovery"));
    return this.transport.downloadFile(url, maxLength, handler);
  }
}
