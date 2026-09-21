import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

// Caller-controlled stable local directories only. Not a sandbox against an
// adversary able to replace ancestor directories or act as the same OS user.
export async function inspectOwnedDirectory(directory: string) {
  if (
    !isAbsolute(directory) ||
    (await realpath(directory)) !== resolve(directory)
  )
    throw new Error("Canonical owned directory required");
  const stat = await lstat(directory);
  if (
    !stat.isDirectory() ||
    !process.getuid ||
    stat.uid !== process.getuid() ||
    (stat.mode & 0o022) !== 0
  )
    throw new Error("Caller-owned non-shared directory required");
  return stat;
}

// ONE canonical spelling of an owned directory, for every identity derived from
// its path (unit names, lock files). Lexically equivalent spellings such as
// `/a/org/../org` normalize to the same string; a symlinked spelling is refused
// by the inspection above, exactly as everywhere else.
export async function canonicalOwnedDirectory(directory: string) {
  await inspectOwnedDirectory(directory);
  return resolve(directory);
}
