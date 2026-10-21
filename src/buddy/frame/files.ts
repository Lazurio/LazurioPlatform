import { lstat, open } from "node:fs/promises";
import { join } from "node:path";

/** The adapter's secret from its file (buddy-web-v1 CONTRACT section 5): a
 * regular file, not a link, owned by this account and readable by nobody
 * else (no group or other bits), holding one line of 16 to 1024 printable
 * ASCII characters. Read on every request, so Machines may rotate it without
 * a restart. Null when anything is off; the reason is never shown, the file
 * is never named to the browser. */
export async function readAdapterSecret(
  file: string,
  uid: number,
): Promise<string | null> {
  try {
    const stat = await lstat(file);
    if (
      !stat.isFile() ||
      stat.uid !== uid ||
      (stat.mode & 0o077) !== 0 ||
      stat.size > 4096
    )
      return null;
    const handle = await open(file, "r");
    try {
      const text = await handle.readFile({ encoding: "utf8" });
      const secret = text.replace(/\r?\n$/, "");
      return /^[\x21-\x7e]{16,1024}$/.test(secret) ? secret : null;
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

/** Buddy's persona as the install writes it (`src/buddy/budicek/README.md`,
 * schema `lazurio.buddy-persona.v1`). */
export const personaFileOf = (home: string) =>
  join(home, ".config", "lazurio", "buddy", "persona.json");

export const defaultBuddyName = "Buddy";

/** Buddy's name from the persona's `buddy_name`: one line of at most 64
 * characters. Any other file, or none, names him Buddy. */
export async function readBuddyName(file: string): Promise<string> {
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.size > 64 * 1024) return defaultBuddyName;
    const persona: unknown = JSON.parse(await Bun.file(file).text());
    if (
      typeof persona !== "object" ||
      persona === null ||
      (persona as Record<string, unknown>).schema_version !==
        "lazurio.buddy-persona.v1"
    )
      return defaultBuddyName;
    const name = (persona as Record<string, unknown>).buddy_name;
    if (
      typeof name !== "string" ||
      name.trim() === "" ||
      name.trim() !== name ||
      [...name].length > 64 ||
      [...name].some((character) => {
        const code = character.charCodeAt(0);
        return code < 0x20 || code === 0x7f;
      })
    )
      return defaultBuddyName;
    return name;
  } catch {
    return defaultBuddyName;
  }
}
