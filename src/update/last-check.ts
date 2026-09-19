import { readFile } from "node:fs/promises";
import { writeDurableFile } from "./durable-file";
import { isProductVersion } from "./identity";
import { layout } from "./layout";
import { compareVersions } from "./version";

/** `update/last-check.json`: what the last VERIFIED check learned, for the
 * Launchpad pill, the CLI notice and `update status`. A disposable cache: it
 * decides nothing, and a missing or unreadable file only means "not checked".
 */
export type LastCheck = Readonly<{
  /** ISO time of the check. */
  checkedAt: string;
  /** Version of the release the check verified. */
  latest: string;
  notesUrl: string;
}>;

export async function readLastCheck(base: string): Promise<LastCheck | null> {
  try {
    const value = JSON.parse(
      await readFile(layout(base).lastCheck, "utf8"),
    ) as Partial<LastCheck> | null;
    if (
      typeof value?.checkedAt === "string" &&
      !Number.isNaN(Date.parse(value.checkedAt)) &&
      isProductVersion(value.latest) &&
      typeof value.notesUrl === "string"
    )
      return Object.freeze({
        checkedAt: value.checkedAt,
        latest: value.latest,
        notesUrl: value.notesUrl,
      });
  } catch {}
  return null;
}

/** Never in the way of the operation that checked. */
export async function writeLastCheck(
  base: string,
  check: LastCheck,
): Promise<void> {
  await writeDurableFile(
    layout(base).update,
    "last-check.json",
    Buffer.from(`${JSON.stringify(check, null, 2)}\n`),
  ).catch(() => undefined);
}

/** The one-line notice other commands print; never touches the network. */
export async function updateNotice(
  base: string,
  running: string,
): Promise<string | null> {
  const check = await readLastCheck(base);
  return check !== null && compareVersions(check.latest, running) > 0
    ? `Lazurio ${check.latest} is available (running ${running}). Run \`lazurio update\`. ${check.notesUrl}`
    : null;
}
