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

/** The choice now: off only where the person turned the notices off. */
export async function readNoticesChoice(
  home: string,
): Promise<BuddyNoticesChoice> {
  try {
    const value: unknown = JSON.parse(
      await readFile(noticesChoicePath(home), "utf8"),
    );
    return typeof value === "object" &&
      value !== null &&
      (value as { choice?: unknown }).choice === "off"
      ? "off"
      : "on";
  } catch {
    return "on";
  }
}

let temporaries = 0;

/** Writes the choice whole: a reader never sees half a file, and two writes
 * never share a temporary file. */
export async function writeNoticesChoice(
  home: string,
  choice: BuddyNoticesChoice,
): Promise<void> {
  const path = noticesChoicePath(home);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  temporaries += 1;
  const temporary = `${path}.${process.pid}.${temporaries}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify({ choice })}\n`, {
      mode: 0o600,
    });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** The Launchpad's one holder of the choice: read once from the file, then
 * kept here, so a claim knows it at once. Writes go to the file one after
 * another in the order the person made them, and the choice held is the
 * one last saved; a write that fails leaves the saved one and is thrown to
 * the caller. */
export function createNoticesChoiceHolder(home: string | undefined) {
  let held: BuddyNoticesChoice = "on";
  const loaded =
    home === undefined
      ? Promise.resolve()
      : readNoticesChoice(home).then((choice) => {
          held = choice;
        });
  let queue: Promise<void> = loaded;
  return Object.freeze({
    /** The choice held now; "on" until the file is read. */
    current: (): BuddyNoticesChoice => held,
    /** The choice once the file is read. */
    read: async (): Promise<BuddyNoticesChoice> => {
      await loaded;
      return held;
    },
    /** Saves the person's choice after every earlier save. */
    write(choice: BuddyNoticesChoice): Promise<BuddyNoticesChoice> {
      if (home === undefined)
        return Promise.reject(new Error("The Environment has no home"));
      const saved = queue.then(async () => {
        await writeNoticesChoice(home, choice);
        held = choice;
        return choice;
      });
      queue = saved.then(
        () => undefined,
        () => undefined,
      );
      return saved;
    },
  });
}
