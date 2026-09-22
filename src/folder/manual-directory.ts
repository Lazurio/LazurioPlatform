import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { FolderAdoptionError } from "./handover-layout";
import {
  initializationReceipts,
  manualDirectoryReceipt,
  recordInitializationCreation,
} from "./initialization-receipt";
import { outputFile, outputPaths } from "./outputs";
import { inspectOwnedDirectory } from "./owned-directory";
import { readOwnedStateFile } from "./read-state";
import { stateFields } from "./state-fields";

// The proof that this initialization created `manual/`. A dev/ino pair alone
// is not one: ext4 hands a recreated directory the same inode number, so a
// `rm -r manual && mkdir manual` would pass. The initializer therefore writes
// a marker holding a fresh nonce into the directory before anything else and
// records dev, ino and the nonce in the journal receipt. The marker stays as
// a hidden file: every later verification (recovery, the archived
// initialization, a diagnosis) keeps the same strong proof instead of falling
// back to the inode, and the directory says what it is.
export const manualMarkerName = ".lazurio-generated";
const markerHeader = "lazurio-generated-manual-v1";

function markerContent(nonce: string) {
  return `${markerHeader}\n${nonce}\n`;
}

async function syncDirectory(path: string) {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

// Create the owned manual directory exclusively (an existing one is foreign),
// seal it with the nonce marker, make everything durable in the parent, and
// only then record the receipt: the receipt is the proof, never the name.
export async function createManualDirectory(folder: string, journal: string) {
  const manual = join(folder, "manual");
  await mkdir(manual, { mode: 0o700 });
  const nonce = randomBytes(16).toString("hex");
  const marker = await open(join(manual, manualMarkerName), "wx", 0o600);
  try {
    await marker.writeFile(markerContent(nonce), "utf8");
    await marker.sync();
  } finally {
    await marker.close();
  }
  await syncDirectory(manual);
  await syncDirectory(folder);
  const stat = await lstat(manual);
  const record = { dev: String(stat.dev), ino: String(stat.ino), nonce };
  await recordInitializationCreation(journal, manualDirectoryReceipt, record);
  return record;
}

// Ours, or refused by name: the directory exists with the recorded identity,
// carries the marker with the recorded nonce, and holds nothing this
// initialization did not receipt. Nothing is written or moved here.
export async function verifyManualDirectory(folder: string, journal: string) {
  const manual = join(folder, "manual");
  const receiptFile = initializationReceipts[manualDirectoryReceipt];
  if (!receiptFile) throw new Error("Unknown initialization output");
  const receipt = stateFields(
    JSON.parse((await readOwnedStateFile(journal, receiptFile)).content),
    ["dev", "ino", "nonce"],
  );
  if (
    typeof receipt.nonce !== "string" ||
    !/^[a-f0-9]{32}$/.test(receipt.nonce)
  )
    throw new Error("Invalid manual directory receipt");
  const stat = await lstat(manual).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (stat === null) throw new Error("Missing recorded initialization output");
  if (
    !stat.isDirectory() ||
    receipt.dev !== String(stat.dev) ||
    receipt.ino !== String(stat.ino)
  )
    throw new FolderAdoptionError("foreign-entry", "manual");
  await inspectOwnedDirectory(manual);
  const entries = (await readdir(manual)).sort();
  if (!entries.includes(manualMarkerName))
    throw new FolderAdoptionError("foreign-entry", "manual");
  const marker = await readOwnedStateFile(manual, manualMarkerName).catch(
    () => null,
  );
  if (marker === null || marker.content !== markerContent(receipt.nonce))
    throw new FolderAdoptionError("foreign-entry", "manual");
  const ours = outputPaths
    .map((path) => outputFile(folder, path))
    .filter((file) => file.directory === manual)
    .map((file) => file.name);
  for (const entry of entries) {
    if (entry === manualMarkerName) continue;
    const receipted =
      ours.includes(entry) &&
      (await lstat(
        join(journal, initializationReceipts[`manual/${entry}`] ?? ""),
      ).then(
        () => true,
        () => false,
      ));
    if (!receipted)
      throw new FolderAdoptionError("foreign-entry", `manual/${entry}`);
  }
}
