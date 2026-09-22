import { open } from "node:fs/promises";
import { join } from "node:path";
import { outputPaths, receiptName } from "./outputs";

// One receipt per file the initializer creates, named after the file: the
// generated outputs (AGENTS.md, manual/*) and the two state files.
export const initializationReceipts: Readonly<Record<string, string>> =
  Object.freeze({
    ...Object.fromEntries(outputPaths.map((path) => [path, receiptName(path)])),
    "preferences.json": "created-preferences.json",
    "instructions.json": "created-instructions.json",
  });

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
