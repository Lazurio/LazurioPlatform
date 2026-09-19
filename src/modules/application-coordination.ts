import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { inspectOwnedDirectory } from "../folder/owned-directory";
import { acquireFileLock, FileLockError } from "../platform/flock";

// Coordination-only exclusion for application operations whose truth lives in
// the OS service manager (start/stop under the `systemd-user` runner). The lock
// only serializes concurrent requests across processes. It protects no state on
// disk: after any crash the next holder re-inspects the service manager and
// converges — an active unit refuses a second start, stop is idempotent, and a
// half-started unit is visible as activating/failed. It is therefore a kernel
// `flock` that dies with its holder, with NO retained owner record.
export function createApplicationCoordination(input: {
  // One file per canonical Organization directory, in the user manager's own
  // runtime directory: same scope and lifetime as the transient units.
  lockFile: string;
  timeoutMs?: number;
}) {
  const timeoutMs = input.timeoutMs ?? 30_000;
  let chain: Promise<unknown> = Promise.resolve();
  return Object.freeze({
    // In-process requests queue in order without a deadline, as they always did;
    // the bounded wait applies to another process holding the lock.
    run<T>(action: () => Promise<T>) {
      const result = chain.then(async () => {
        const directory = dirname(input.lockFile);
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await inspectOwnedDirectory(directory);
        let lock: Awaited<ReturnType<typeof acquireFileLock>>;
        try {
          lock = await acquireFileLock(input.lockFile, { timeoutMs });
        } catch (error) {
          if (error instanceof FileLockError && error.reason === "busy")
            return Object.freeze({ kind: "coordination-busy" as const });
          throw error;
        }
        try {
          return await action();
        } finally {
          await lock.release();
        }
      });
      chain = result.then(
        () => {},
        () => {},
      );
      return result;
    },
  });
}
