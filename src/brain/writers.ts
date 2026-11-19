import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { BrainPaths } from "./pin";

// A gbrain command Lazurio's setup started (an embedding, a migration, a
// sync) runs in its own process group (`runTool`), so it outlives a setup
// that was killed: the Launchpad's limit, a reboot of the Launchpad, a
// person's Ctrl-C. Such a writer must never meet the next run's recovery
// or a started server on the same PGLite brain. Setup holds its lock, so any
// command of a release in Lazurio's own directory that is not the server
// (systemd's, stopped separately) is one a dead run left: it is ended, and
// a run that cannot end it changes nothing.

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Process ids of this user's gbrain commands of Lazurio's releases, other
 * than `serve`, as their command line names them
 * (`bun <releases>/<commit>/bin/gbrain <verb> …`). */
export async function strayWriters(
  paths: BrainPaths,
  proc = "/proc",
): Promise<readonly number[]> {
  const uid = process.getuid?.();
  const found: number[] = [];
  let entries: string[];
  try {
    entries = await readdir(proc);
  } catch {
    return found;
  }
  const prefix = `${paths.releases}/`;
  for (const entry of entries) {
    if (!/^[0-9]+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === process.pid) continue;
    try {
      if (uid !== undefined && (await stat(join(proc, entry))).uid !== uid)
        continue;
      const argv = (await readFile(join(proc, entry, "cmdline"), "utf8"))
        .split("\0")
        .filter((part) => part.length > 0);
      const at = argv.findIndex(
        (part) => part.startsWith(prefix) && part.endsWith("/bin/gbrain"),
      );
      if (at >= 0 && argv[at + 1] !== "serve") found.push(pid);
    } catch {
      // A process that ended while it was read.
    }
  }
  return found;
}

/** Ends every stray writer: TERM, then KILL; true once none is left. */
export async function endStrayWriters(
  paths: BrainPaths,
  options: Readonly<{ proc?: string; graceMs?: number }> = {},
): Promise<boolean> {
  const proc = options.proc ?? "/proc";
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    const pids = await strayWriters(paths, proc);
    if (pids.length === 0) return true;
    for (const pid of pids) {
      try {
        process.kill(pid, signal);
      } catch {}
    }
    for (let i = 0; i < 50; i++) {
      if ((await strayWriters(paths, proc)).length === 0) return true;
      await sleep((options.graceMs ?? 5000) / 50);
    }
  }
  return (await strayWriters(paths, proc)).length === 0;
}
