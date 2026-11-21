// Buddy GEN4's browser notices, chosen once for the whole Environment (plan
// LZD-0033; Matěj, 2026-11-21: notices on from the start). The choice lives
// beside his persona, `~/.config/lazurio/buddy/notices.json`, so Lazurio and
// Chat read one choice; the browser's permission stays per origin. No file,
// or anything but an explicit "off", is on.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
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

/** Writes the choice whole: a reader never sees half a file. */
export async function writeNoticesChoice(
  home: string,
  choice: BuddyNoticesChoice,
): Promise<void> {
  const path = noticesChoicePath(home);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ choice })}\n`, {
    mode: 0o600,
  });
  await rename(temporary, path);
}
