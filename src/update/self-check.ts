import { join } from "node:path";
import { readStateJson } from "../folder/read-state";
import {
  folderStateSchemas,
  parseFolderPreferences,
  parseInstructionManifest,
} from "../folder/state";
import { UpdateFailure } from "./errors";
import { embeddedIdentity, type ProductIdentity } from "./identity";
import {
  type SignedIdentity,
  type StateSchemas,
  updaterContract,
} from "./signed-identity";

/** `lazurio self-check`: what an executable states about ITSELF when it is run
 * by its immutable path (docs/update.md "Download"). The updater never trusts
 * a candidate's files for this — it runs the candidate and compares the answer
 * with the signed identity. The mode reads and never writes: no lock, no
 * directory, no observation, no network.
 */
export type SelfCheckReport = Readonly<{
  schemaVersion: 1;
  identity: ProductIdentity;
  updaterContract: number;
  /** Folder state schema versions this executable can read. */
  schemas: StateSchemas;
  /** Schema versions found in the Folder that was named, after parsing it. */
  folder: Readonly<{ preferences: number; manifest: number }> | null;
}>;

/** Runs INSIDE the executable being checked. Throws when the named Folder's
 * state cannot be read by this version.
 */
export async function selfCheckReport(
  folder: string | undefined,
  identity: ProductIdentity = embeddedIdentity(),
): Promise<SelfCheckReport> {
  let state: SelfCheckReport["folder"] = null;
  if (folder !== undefined) {
    // Plain reads of the two state documents. The operation lock is NOT
    // taken: taking it writes, and a candidate must not write before it is
    // confirmed. A concurrent profile update can therefore fail this read;
    // that is a retryable refusal, never a half-read success.
    const directory = join(folder, ".lazurio");
    const preferences = parseFolderPreferences(
      await readStateJson(directory, "preferences.json"),
    );
    const manifest = parseInstructionManifest(
      await readStateJson(directory, "instructions.json"),
    );
    state = Object.freeze({
      preferences: preferences.schemaVersion,
      manifest: manifest.schemaVersion,
    });
  }
  return Object.freeze({
    schemaVersion: 1,
    identity,
    updaterContract,
    schemas: folderStateSchemas,
    folder: state,
  });
}

export type ProcessResult =
  | Readonly<{ exitCode: number; stdout: string }>
  | "timeout";

/** Run one short-lived product process and capture bounded stdout. */
export type ProcessRunner = (
  command: readonly string[],
  timeoutMs: number,
  env?: Readonly<Record<string, string>>,
) => Promise<ProcessResult>;

const maxOutputBytes = 64 * 1024;

export const runProcess: ProcessRunner = async (
  command,
  timeoutMs,
  env = {},
) => {
  const child = Bun.spawn([...command], {
    // Empty unless the caller names variables: nothing of the caller's
    // environment may steer a candidate's answer.
    env: { ...env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  // The bound holds even when a grandchild keeps the pipe open after the
  // child was killed: the reader is cancelled, not waited for.
  const reader = child.stdout.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  const finished = (async () => {
    const chunks: Uint8Array[] = [];
    let length = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxOutputBytes) {
        child.kill("SIGKILL");
        return Object.freeze({ exitCode: -1, stdout: "" });
      }
      chunks.push(value);
    }
    return Object.freeze({
      exitCode: await child.exited,
      stdout: Buffer.concat(chunks).toString("utf8"),
    });
  })();
  try {
    const result = await Promise.race([finished, expired]);
    if (result === "timeout") {
      child.kill("SIGKILL");
      finished.catch(() => undefined);
    }
    return result;
  } finally {
    clearTimeout(timer);
    await reader.cancel().catch(() => undefined);
  }
};

export const defaultSelfCheckTimeoutMs = 30_000;

/** Run `executable self-check --json` and require that it is the version the
 * signed identity describes and that it could read the Folder it was shown.
 */
export async function requireSelfCheck(input: {
  executable: string;
  expected: Pick<SignedIdentity, "version" | "sourceCommit" | "target">;
  folder?: string | undefined;
  timeoutMs?: number | undefined;
  run?: ProcessRunner | undefined;
}): Promise<void> {
  const failed = (reason: string, exitCode?: number) =>
    new UpdateFailure("self-check-failed", {
      reason,
      ...(exitCode === undefined ? {} : { exitCode }),
    });
  let result: ProcessResult;
  try {
    result = await (input.run ?? runProcess)(
      [
        input.executable,
        "self-check",
        "--json",
        ...(input.folder === undefined ? [] : ["--folder", input.folder]),
      ],
      input.timeoutMs ?? defaultSelfCheckTimeoutMs,
    );
  } catch {
    throw failed("not-executable");
  }
  if (result === "timeout") throw failed("timeout");
  if (result.exitCode !== 0) throw failed("exit", result.exitCode);
  let report: Partial<SelfCheckReport>;
  try {
    report = JSON.parse(result.stdout) as Partial<SelfCheckReport>;
  } catch {
    throw failed("output");
  }
  if (report?.schemaVersion !== 1 || !report.identity) throw failed("output");
  if (
    report.identity.version !== input.expected.version ||
    report.identity.commit !== input.expected.sourceCommit ||
    report.identity.target !== input.expected.target
  )
    throw failed("identity-mismatch");
  if (input.folder !== undefined && !report.folder) throw failed("folder");
}
