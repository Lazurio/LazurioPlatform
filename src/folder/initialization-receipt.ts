import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import { outputPaths, receiptName } from "./outputs";

export type FileIdentity = Readonly<{ dev: string; ino: string }>;

// One receipt per entry the initializer creates, named after it: the owned
// `manual/` directory, the generated outputs (AGENTS.md, manual/*) and the
// two state files. A receipt is the proof that this initialization created
// the entry; recovery never adopts an entry without one.
export const manualDirectoryReceipt = "manual";
export const initializationReceipts: Readonly<Record<string, string>> =
  Object.freeze({
    [manualDirectoryReceipt]: "created-manual.json",
    ...Object.fromEntries(outputPaths.map((path) => [path, receiptName(path)])),
    "preferences.json": "created-preferences.json",
    "instructions.json": "created-instructions.json",
  });

export function fileIdentity(stat: {
  dev: number | bigint;
  ino: number | bigint;
}): FileIdentity {
  return { dev: String(stat.dev), ino: String(stat.ino) };
}

// Create the owned manual directory, make its creation durable in the parent
// and record its identity in the journal before anything is written inside.
export async function createManualDirectory(folder: string, journal: string) {
  const manual = join(folder, "manual");
  await mkdir(manual, { mode: 0o700 }); // Exclusive: an existing manual/ is foreign.
  const parent = await open(
    folder,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await parent.sync();
  } finally {
    await parent.close();
  }
  const identity = fileIdentity(await lstat(manual));
  await recordInitializationCreation(journal, manualDirectoryReceipt, identity);
  return identity;
}

export async function recordInitializationCreation(
  journal: string,
  name: keyof typeof initializationReceipts,
  identity: { dev: string; ino: string },
) {
  const receipt = initializationReceipts[name];
  if (!receipt) throw new Error("Unknown initialization output");
  const file = await open(join(journal, receipt), "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(identity), "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
}
