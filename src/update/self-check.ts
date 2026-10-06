import { join } from "node:path";
import { readStateJson } from "../folder/read-state";
import { instructionTemplateRevision } from "../folder/render";
import {
  parseFolderPreferences,
  parseInstructionManifest,
} from "../folder/state";
import { isStartRefusal } from "../launchpad/start-check";
import { type UpdateErrorReason, UpdateFailure } from "./errors";
import {
  embeddedFixture,
  embeddedIdentity,
  type ProductIdentity,
} from "./identity";
import { readHighWater, readSelector } from "./layout";

/** `lazurio self-check`: what an executable states about ITSELF when it is run
 * by its immutable path (docs/update.md "Activation", step 2). The updater
 * never trusts a candidate's files for this — it runs the candidate and
 * compares the answer with the verified manifest. The mode reads and never
 * writes: no lock, no directory, no network.
 */
export type SelfCheckReport = Readonly<{
  schemaVersion: 1;
  identity: ProductIdentity;
  /** A qualification build; never true for a release. */
  fixture: boolean;
  /** The template revision this executable renders into a Folder. Absent
   * from executables older than the F17 addendum 2026-09-28. */
  templateRevision: string;
  /** What this executable reads in the install base it was shown. */
  base: Readonly<{
    active: string | null;
    highWater: string | null;
  }> | null;
  /** Schema versions found in the Folder that was named, after parsing it. */
  folder: Readonly<{ preferences: number; manifest: number }> | null;
  /** `--launchpad`: the Launchpad start sequence ran read-only against the
   * named Folder and served on a private socket. Absent from executables
   * older than the first release without rollback. */
  launchpad?: Readonly<{ probe: "ok" }> | null;
}>;

/** Runs INSIDE the executable being checked. Throws when this version cannot
 * read the install base or the named Folder's state.
 */
export async function selfCheckReport(
  input: Readonly<{
    base?: string | undefined;
    folder?: string | undefined;
    /** Also run the Launchpad probe against `folder`. */
    launchpad?: boolean | undefined;
  }>,
  identity: ProductIdentity = embeddedIdentity(),
): Promise<SelfCheckReport> {
  let base: SelfCheckReport["base"] = null;
  if (input.base !== undefined) {
    // Throws on a mark this version cannot read.
    base = Object.freeze({
      active: await readSelector(input.base),
      highWater: await readHighWater(input.base),
    });
  }
  let folder: SelfCheckReport["folder"] = null;
  if (input.folder !== undefined) {
    // Plain reads of the two state documents. The operation lock is NOT
    // taken: taking it writes, and a candidate must not write before it is
    // committed. A concurrent profile update can therefore fail this read;
    // that is a retryable refusal, never a half-read success.
    const directory = join(input.folder, ".lazurio");
    const preferences = parseFolderPreferences(
      await readStateJson(directory, "preferences.json"),
    );
    const manifest = parseInstructionManifest(
      await readStateJson(directory, "instructions.json"),
    );
    folder = Object.freeze({
      preferences: preferences.schemaVersion,
      manifest: manifest.schemaVersion,
    });
  }
  let launchpad: SelfCheckReport["launchpad"] = null;
  if (input.launchpad) {
    if (input.folder === undefined)
      throw new Error("The Launchpad probe needs a Folder");
    // Throws `LaunchpadStartRefused` for a condition the start would name.
    // Loaded only here: the rest of the update core never needs the page.
    const { probeLaunchpad } = await import("../launchpad/server");
    await probeLaunchpad(input.folder, identity.version);
    launchpad = Object.freeze({ probe: "ok" as const });
  }
  return Object.freeze({
    schemaVersion: 1,
    identity,
    fixture: embeddedFixture() !== undefined,
    templateRevision: instructionTemplateRevision,
    base,
    folder,
    launchpad,
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
 * verified manifest describes and that it could read what it was shown. With
 * a Folder it also runs the candidate's Launchpad probe (`--launchpad`): the
 * point of no return is after this, never after the switch.
 * Returns the template revision it renders, or null when it does not say.
 */
export async function requireSelfCheck(input: {
  executable: string;
  /** Without a commit, any commit is accepted (an already installed version). */
  expected: Omit<ProductIdentity, "commit"> & { commit?: string | undefined };
  base: string;
  folder?: string | undefined;
  timeoutMs?: number | undefined;
  run?: ProcessRunner | undefined;
}): Promise<string | null> {
  const failed = (
    reason: UpdateErrorReason,
    extra: Readonly<Record<string, string | number>> = {},
  ) => new UpdateFailure("self-check-failed", { reason, ...extra });
  let result: ProcessResult;
  try {
    result = await (input.run ?? runProcess)(
      [
        input.executable,
        "self-check",
        "--json",
        "--base",
        input.base,
        ...(input.folder === undefined
          ? []
          : ["--folder", input.folder, "--launchpad"]),
      ],
      input.timeoutMs ?? defaultSelfCheckTimeoutMs,
    );
  } catch {
    throw failed("not-executable");
  }
  if (result === "timeout") throw failed("timeout");
  if (result.exitCode !== 0) {
    // A refused probe names its condition, and nothing else.
    let refused: unknown;
    try {
      refused = (JSON.parse(result.stdout) as { launchpadRefused?: unknown })
        ?.launchpadRefused;
    } catch {}
    throw isStartRefusal(refused)
      ? failed("launchpad-refused", { refusal: refused })
      : failed("exit", { exitCode: result.exitCode });
  }
  let report: Partial<SelfCheckReport>;
  try {
    report = JSON.parse(result.stdout) as Partial<SelfCheckReport>;
  } catch {
    throw failed("output");
  }
  if (report?.schemaVersion !== 1 || !report.identity) throw failed("output");
  if (
    report.identity.version !== input.expected.version ||
    (input.expected.commit !== undefined &&
      report.identity.commit !== input.expected.commit) ||
    report.identity.target !== input.expected.target
  )
    throw failed("identity-mismatch");
  // A fixture build trusts a fixture root: a product never activates one.
  if (report.fixture !== (embeddedFixture() !== undefined))
    throw failed("fixture");
  if (!report.base) throw failed("base");
  if (input.folder !== undefined && !report.folder) throw failed("folder");
  if (input.folder !== undefined && report.launchpad?.probe !== "ok")
    throw failed("launchpad");
  return typeof report.templateRevision === "string"
    ? report.templateRevision
    : null;
}
