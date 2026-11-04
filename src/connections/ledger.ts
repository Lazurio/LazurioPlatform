import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type { PairingLedger, PairingLedgerStore } from "./pairing";

// The pairing ledger of decision F71 on disk: the times of the starts and
// until when a code may be valid, never a code. One small JSON file under
// `${XDG_STATE_HOME:-~/.local/state}/lazurio/connections/`, mode 0600 in a
// 0700 directory, replaced whole by an atomic rename.

/** `${XDG_STATE_HOME:-~/.local/state}/lazurio/connections/pairing.json`; a
 * relative XDG_STATE_HOME is ignored, as for the vault's state. */
export function pairingLedgerPath(
  home: string,
  env: Readonly<Record<string, string | undefined>>,
): string {
  const xdg = env.XDG_STATE_HOME;
  const state =
    xdg !== undefined && xdg !== "" && isAbsolute(xdg)
      ? xdg
      : join(home, ".local", "state");
  return join(state, "lazurio", "connections", "pairing.json");
}

/** The ledger in `path`: none yet is null; a file that does not parse is
 * answered as it is, so the reader counts it unreadable; any other failure
 * throws. */
export function fileLedger(path: string): PairingLedgerStore {
  return Object.freeze({
    async read(): Promise<unknown> {
      let text: string;
      try {
        text = await readFile(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
      try {
        return JSON.parse(text) as unknown;
      } catch {
        return "unreadable";
      }
    },
    async write(ledger: PairingLedger): Promise<void> {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const temporary = `${path}.${randomBytes(6).toString("hex")}.tmp`;
      try {
        await writeFile(temporary, `${JSON.stringify(ledger)}\n`, {
          mode: 0o600,
          flag: "wx",
        });
        await rename(temporary, path);
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined);
        throw error;
      }
    },
  });
}
