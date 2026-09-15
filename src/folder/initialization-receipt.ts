import { open } from "node:fs/promises";
import { join } from "node:path";

export const initializationReceipts = {
  "AGENTS.md": "created-agents.json",
  "preferences.json": "created-preferences.json",
  "instructions.json": "created-instructions.json",
} as const;

export async function recordInitializationCreation(
  journal: string,
  name: keyof typeof initializationReceipts,
  identity: { dev: string; ino: string },
) {
  const file = await open(
    join(journal, initializationReceipts[name]),
    "wx",
    0o600,
  );
  try {
    await file.writeFile(JSON.stringify(identity), "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
}
