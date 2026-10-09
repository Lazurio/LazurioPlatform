import { isAbsolute, join } from "node:path";
import type { ToolRunner } from "../tools/status";
import type {
  ExecutorContext,
  ExecutorHost,
  ExecutorJournalEntry,
  ExecutorUnsupportedReason,
} from "./flow";

// The production composition of Executor (decision F44): this process's home,
// PATH and user manager, and whether this process is the declared operator
// of a readable Machine handover, the signal every Remote Environment
// convergence uses (`hostedOperatorFolder`). Only that operator, on Linux,
// has Executor set up by Lazurio; a workstation is the second wave.

const unsupported = (reason: ExecutorUnsupportedReason): ExecutorContext =>
  Object.freeze({ kind: "unsupported", reason });

export function processExecutorHost(
  input: Readonly<{
    /** The declared operator's Folder when this process is the operator of
     * a Machine handover, undefined when there is none; rejects when a
     * handover is there but unreadable (`hostedOperatorFolder`). */
    hostedFolder: () => Promise<string | undefined>;
    env: Readonly<Record<string, string | undefined>>;
    platform: string;
    arch?: string | undefined;
    run: ToolRunner;
    journal?: ((entry: ExecutorJournalEntry) => void) | undefined;
  }>,
): ExecutorHost {
  const home =
    input.env.HOME !== undefined && isAbsolute(input.env.HOME)
      ? input.env.HOME
      : undefined;
  const at = home ?? "/nonexistent";
  return Object.freeze({
    async context() {
      if (input.platform !== "linux" || home === undefined)
        return unsupported("workstation");
      let folder: string | undefined;
      try {
        folder = await input.hostedFolder();
      } catch {
        return unsupported("handover-unreadable");
      }
      if (folder === undefined) return unsupported("workstation");
      // The handover's operator is this account, and so is this home.
      if (folder !== join(home, "Lazurio")) return unsupported("not-operator");
      return Object.freeze({ kind: "supported" as const });
    },
    home: at,
    bin: join(at, ".local", "bin"),
    root: join(at, ".local", "share", "executor-cli"),
    path: input.env.PATH,
    env: input.env,
    platform: input.platform,
    arch: input.arch ?? process.arch,
    run: input.run,
    uid: process.getuid?.(),
    journal: input.journal,
  });
}
