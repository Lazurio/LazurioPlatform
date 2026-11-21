// Buddy GEN4's browser notices, chosen once for the whole Environment (plan
// LZD-0033; Matěj, 2026-11-21: notices on from the start). The choice lives
// beside his persona, `~/.config/lazurio/buddy/notices.json`, so Lazurio and
// Chat read one choice; the browser's permission stays per origin. No file,
// or anything but an explicit "off", is on.
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type BuddyNoticesChoice = "on" | "off";

/** The choice's file, under the user's home. */
export const noticesChoicePath = (home: string): string =>
  join(home, ".config", "lazurio", "buddy", "notices.json");

/** Whether `value` is a choice the person can make. */
export const isBuddyNoticesChoice = (
  value: unknown,
): value is BuddyNoticesChoice => value === "on" || value === "off";

/** The choice as saved, with its version: each saved change counts one up,
 * so a page can say which choice it changed. */
export type NoticesChoiceRecord = Readonly<{
  choice: BuddyNoticesChoice;
  version: number;
}>;

/** The saved choice and its version: on, version 0, where nothing (or
 * nothing readable) is saved, and off only where the person turned the
 * notices off. */
export async function readNoticesRecord(
  home: string,
): Promise<NoticesChoiceRecord> {
  try {
    const value: unknown = JSON.parse(
      await readFile(noticesChoicePath(home), "utf8"),
    );
    const record =
      typeof value === "object" && value !== null
        ? (value as { choice?: unknown; version?: unknown })
        : {};
    return {
      choice: record.choice === "off" ? "off" : "on",
      version:
        typeof record.version === "number" &&
        Number.isSafeInteger(record.version) &&
        record.version >= 0
          ? record.version
          : 0,
    };
  } catch {
    return { choice: "on", version: 0 };
  }
}

/** The choice now: off only where the person turned the notices off. */
export async function readNoticesChoice(
  home: string,
): Promise<BuddyNoticesChoice> {
  return (await readNoticesRecord(home)).choice;
}

let temporaries = 0;

/** Writes the choice whole: a reader never sees half a file, and two writes
 * never share a temporary file. */
export async function writeNoticesChoice(
  home: string,
  choice: BuddyNoticesChoice,
  version = 0,
): Promise<void> {
  const path = noticesChoicePath(home);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  temporaries += 1;
  const temporary = `${path}.${process.pid}.${temporaries}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify({ choice, version })}\n`, {
      mode: 0o600,
    });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** The answer to a page's change of the choice: the choice and version
 * held after it, and whether the page's choice is the one held. */
export type NoticesChoiceWrite = NoticesChoiceRecord &
  Readonly<{ saved: boolean }>;

/** The Launchpad's one holder of the choice: read once from the file, then
 * kept here, so a claim knows it at once. A page changes the choice it last
 * read (`basis`, its version): where another page changed it since, the
 * change is refused and the page hears the newer choice, whatever the
 * clocks and however long either request took. So a click made on an older
 * view never undoes a newer choice. Choosing what is held is no change.
 * Writes go to the file one after another; a write that fails leaves the
 * saved choice and is thrown to the caller. */
export function createNoticesChoiceHolder(home: string | undefined) {
  let held: NoticesChoiceRecord = { choice: "on", version: 0 };
  const loaded =
    home === undefined
      ? Promise.resolve()
      : readNoticesRecord(home).then((record) => {
          held = record;
        });
  let queue: Promise<void> = loaded;
  return Object.freeze({
    /** The choice held now; "on" until the file is read. */
    current: (): BuddyNoticesChoice => held.choice,
    /** The choice and its version once the file is read. */
    read: async (): Promise<NoticesChoiceRecord> => {
      await loaded;
      return held;
    },
    /** Changes the choice of version `basis` to `choice`, after every
     * earlier write. */
    write(
      choice: BuddyNoticesChoice,
      basis: number,
    ): Promise<NoticesChoiceWrite> {
      if (home === undefined)
        return Promise.reject(new Error("The Environment has no home"));
      const saved = queue.then(async (): Promise<NoticesChoiceWrite> => {
        if (choice === held.choice) return { ...held, saved: true };
        if (basis !== held.version) return { ...held, saved: false };
        const next = { choice, version: held.version + 1 };
        await writeNoticesChoice(home, next.choice, next.version);
        held = next;
        return { ...next, saved: true };
      });
      queue = saved.then(
        () => undefined,
        () => undefined,
      );
      return saved;
    },
  });
}
