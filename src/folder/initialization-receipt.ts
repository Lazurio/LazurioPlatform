import { open } from "node:fs/promises";
import { join } from "node:path";
import { outputPaths, receiptName } from "./outputs";

export type FileIdentity = Readonly<{ dev: string; ino: string }>;

// One receipt per entry the initializer creates, named after it: the owned
// `manual/` directory (dev, ino and the nonce of its marker, see
// manual-directory.ts), the generated outputs (AGENTS.md, manual/*) and the
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

export async function recordInitializationCreation(
  journal: string,
  name: keyof typeof initializationReceipts,
  identity: FileIdentity & Readonly<{ nonce?: string }>,
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
