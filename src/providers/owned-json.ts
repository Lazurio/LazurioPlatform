import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";

// Caller must first establish a stable canonical owned parent directory.
// Bounded POSIX declaration read; not an atomic multi-document snapshot.
export async function readOwnedJson(path: string): Promise<unknown> {
  if (!["darwin", "linux"].includes(process.platform))
    throw new Error("Unqualified declaration reader platform");
  const before = await lstat(path);
  const safe = (stat: typeof before) =>
    stat.isFile() &&
    stat.nlink === 1 &&
    stat.uid === process.getuid?.() &&
    (stat.mode & 0o022) === 0 &&
    stat.size <= 1024 * 1024;
  if (!safe(before)) throw new Error("Unsafe declaration file");
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const opened = await file.stat();
    if (!safe(opened) || opened.dev !== before.dev || opened.ino !== before.ino)
      throw new Error("Declaration changed before read");
    const bytes = Buffer.alloc(opened.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const result = await file.read(bytes, count, bytes.length - count, count);
      if (!result.bytesRead) break;
      count += result.bytesRead;
    }
    const after = await file.stat();
    const named = await lstat(path);
    if (
      !safe(after) ||
      !safe(named) ||
      count !== opened.size ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs ||
      named.dev !== opened.dev ||
      named.ino !== opened.ino
    )
      throw new Error("Declaration changed during read");
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        bytes.subarray(0, count),
      ),
    ) as unknown;
  } finally {
    await file.close();
  }
}
