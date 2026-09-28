import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { type PresetName, presetNames } from "../folder/presets";
import { readStateJson } from "../folder/read-state";
import {
  instructionTemplateRevision,
  isTemplateRevision,
} from "../folder/render";
import {
  type FolderPreferences,
  parseFolderPreferences,
  parseInstructionManifest,
} from "../folder/state";
import { type ErrorContext, UpdateFailure } from "../update/errors";
import { isProductVersion, type ProductIdentity } from "../update/identity";
import { layout, versionExecutable } from "../update/layout";
import {
  defaultSelfCheckTimeoutMs,
  type ProcessResult,
  type ProcessRunner,
  requireSelfCheck,
  type SelfCheckReport,
} from "../update/self-check";
import {
  launchpadUnit,
  serviceCommandTimeoutMs,
  serviceEnvironment,
} from "../update/service-control";
import {
  failed,
  ok,
  type RecoveryCheck,
  type RecoveryCode,
  skipped,
} from "./checks";

/** The observations behind the checks. Each reads and never writes: no lock,
 * no restart, no network. */

type Env = Readonly<Record<string, string | undefined>>;

// ---- Folder ---------------------------------------------------------------

/** Tier 1 (docs/recovery.md "Two tiers"): every string is an enumerated
 * literal or a revision of the product's form, else the literal `invalid`,
 * never the value the Folder recorded. */
export type FolderFacts = Readonly<{
  preset: PresetName | "invalid";
  machineKind: (typeof machineKinds)[number] | "invalid";
  revision: number;
  recordedTemplateRevision: string;
  productTemplateRevision: string;
  preferencesSchema: number;
  manifestSchema: number;
  pendingTransaction: boolean;
}>;

export type FolderObservation = Readonly<{
  check: RecoveryCheck;
  facts: FolderFacts | null;
  /** Parsed only for the sanitizer's values and the prompt's locale. */
  preferences: FolderPreferences | null;
}>;

const machineKinds = ["workstation", "personal-vm", "workspace-vm"] as const;
const oneOf = <T extends string>(
  allowed: readonly T[],
  value: string,
): T | "invalid" =>
  (allowed as readonly string[]).includes(value) ? (value as T) : "invalid";
const whole = (value: number) =>
  Number.isSafeInteger(value) && value >= 0 ? value : -1;

const stateNames = new Set([
  "preferences.json",
  "instructions.json",
  ".operation-lock",
  "history",
]);

/** Whether THIS version can read the Folder's state: the same two plain reads
 * the self-check does, without the operation lock (taking it writes). A
 * pending transaction or an entry this version does not know is what stops
 * the Launchpad from starting (R1's cause). */
export async function observeFolder(
  folder: string | undefined,
): Promise<FolderObservation> {
  const none = (check: RecoveryCheck): FolderObservation =>
    Object.freeze({ check, facts: null, preferences: null });
  if (folder === undefined) return none(skipped("folder-state", "no-folder"));
  const state = join(folder, ".lazurio");
  let entries: string[];
  try {
    entries = await readdir(state);
  } catch {
    return none(failed("folder-state", "folder-state-absent"));
  }
  const pendingTransaction = entries.includes("transaction");
  let preferences: FolderPreferences;
  let manifest: ReturnType<typeof parseInstructionManifest>;
  try {
    preferences = parseFolderPreferences(
      await readStateJson(state, "preferences.json"),
    );
    manifest = parseInstructionManifest(
      await readStateJson(state, "instructions.json"),
    );
  } catch {
    return none(failed("folder-state", "folder-state-unreadable"));
  }
  const facts: FolderFacts = Object.freeze({
    preset: oneOf(presetNames, preferences.preset.name),
    machineKind: oneOf(
      machineKinds,
      preferences.machine?.kind ?? "workstation",
    ),
    revision: whole(preferences.revision),
    recordedTemplateRevision: isTemplateRevision(manifest.templateRevision)
      ? manifest.templateRevision
      : "invalid",
    productTemplateRevision: instructionTemplateRevision,
    preferencesSchema: whole(preferences.schemaVersion),
    manifestSchema: whole(manifest.schemaVersion),
    pendingTransaction,
  });
  const check = pendingTransaction
    ? failed("folder-state", "folder-state-pending")
    : entries.some((name) => !stateNames.has(name)) ||
        !entries.includes(".operation-lock")
      ? failed("folder-state", "folder-state-unrecognized")
      : ok("folder-state", { revision: preferences.revision });
  return Object.freeze({ check, facts, preferences });
}

// ---- Self-check of the active executable (R5) -----------------------------

export type SelfCheckObservation = Readonly<{
  check: RecoveryCheck;
  /** What the active executable said about itself, when it said it. */
  identity: (ProductIdentity & { fixture: boolean }) | null;
}>;

/** R5: run the ACTIVE executable's `self-check` against the base and the
 * Folder, by its immutable path, and hold the answer to the updater's own
 * rule (`requireSelfCheck`). Runs once; the same answer is judged. */
export async function observeSelfCheck(
  input: Readonly<{
    base: string;
    active: string | null;
    target: string;
    folder: string | undefined;
    run: ProcessRunner;
    timeoutMs?: number | undefined;
  }>,
): Promise<SelfCheckObservation> {
  if (input.active === null)
    return Object.freeze({
      check: skipped("self-check-failed", "not-installed"),
      identity: null,
    });
  const executable = versionExecutable(input.base, input.active);
  let answer: ProcessResult | Error;
  try {
    answer = await input.run(
      [
        executable,
        "self-check",
        "--json",
        "--base",
        input.base,
        ...(input.folder === undefined ? [] : ["--folder", input.folder]),
      ],
      input.timeoutMs ?? defaultSelfCheckTimeoutMs,
    );
  } catch (error) {
    answer = error instanceof Error ? error : new Error("not-executable");
  }
  let identity: SelfCheckObservation["identity"] = null;
  if (answer !== "timeout" && !(answer instanceof Error))
    try {
      const report = JSON.parse(answer.stdout) as Partial<SelfCheckReport>;
      const said = report?.identity;
      if (
        said &&
        isProductVersion(said.version) &&
        typeof said.commit === "string" &&
        /^[0-9a-f]{40}$/.test(said.commit) &&
        typeof said.target === "string" &&
        /^[a-z0-9]+-[a-z0-9]+$/.test(said.target)
      )
        identity = Object.freeze({
          version: said.version,
          commit: said.commit,
          target: said.target,
          fixture: report.fixture === true,
        });
    } catch {}
  try {
    await requireSelfCheck({
      executable,
      expected: { version: input.active, target: input.target },
      base: input.base,
      folder: input.folder,
      run: async () => {
        if (answer instanceof Error) throw answer;
        return answer;
      },
    });
  } catch (error) {
    const context: ErrorContext =
      error instanceof UpdateFailure ? error.failure.context : {};
    return Object.freeze({
      check: failed("self-check-failed", "self-check-failed", context),
      identity,
    });
  }
  return Object.freeze({
    check: ok("self-check-failed", { version: input.active }),
    identity,
  });
}

// ---- The supervised unit ---------------------------------------------------

export type UnitFacts = Readonly<{
  loadState: string;
  activeState: string;
  subState: string;
  result: string;
  nRestarts: number | null;
  execMainStatus: number | null;
}>;

export type UnitObservation = Readonly<{
  check: RecoveryCheck;
  facts: UnitFacts | null;
}>;

type Command = Readonly<{ run: ProcessRunner; env: Env }>;

async function output(
  command: Command,
  argv: readonly string[],
): Promise<string | null> {
  const result = await command
    .run(argv, serviceCommandTimeoutMs, serviceEnvironment(command.env))
    .catch(() => "timeout" as const);
  return result !== "timeout" && result.exitCode === 0 ? result.stdout : null;
}

/** Where a user service manager can be asked at all. */
export const userManagerPresent = (platform: string, env: Env) =>
  platform === "linux" && Boolean(env.XDG_RUNTIME_DIR);

const unitProperties = [
  "LoadState",
  "ActiveState",
  "SubState",
  "Result",
  "NRestarts",
  "ExecMainStatus",
] as const;

/** The values systemd defines for the properties read (systemd's unit and
 * service state tables), and `unknown` for anything else: a finite list, so
 * nothing read here can carry text into the evidence. */
export const unitLoadStates = [
  "stub",
  "loaded",
  "not-found",
  "bad-setting",
  "error",
  "merged",
  "masked",
] as const;
export const unitActiveStates = [
  "active",
  "reloading",
  "inactive",
  "failed",
  "activating",
  "deactivating",
  "maintenance",
  "refreshing",
] as const;
export const serviceSubStates = [
  "dead",
  "condition",
  "start-pre",
  "start",
  "start-post",
  "running",
  "exited",
  "reload",
  "reload-signal",
  "reload-notify",
  "stop",
  "stop-watchdog",
  "stop-sigterm",
  "stop-sigkill",
  "stop-post",
  "final-watchdog",
  "final-sigterm",
  "final-sigkill",
  "failed",
  "dead-before-auto-restart",
  "failed-before-auto-restart",
  "dead-resources-pinned",
  "auto-restart",
  "auto-restart-queued",
  "cleaning",
] as const;
export const serviceResults = [
  "success",
  "resources",
  "protocol",
  "timeout",
  "exit-code",
  "signal",
  "core-dump",
  "watchdog",
  "start-limit-hit",
  "oom-kill",
  "exec-condition",
] as const;
const stateWord = (allowed: readonly string[], value: string | undefined) =>
  value !== undefined && allowed.includes(value) ? value : "unknown";
const count = (value: string | undefined) =>
  value !== undefined && /^\d{1,9}$/.test(value) ? Number(value) : null;

/** The unit `lazurio install --service` wrote, read through
 * `systemctl --user show`. Only a supervised installation has one. */
export async function observeUnit(
  input: Readonly<{
    supervised: boolean;
    platform: string;
    env: Env;
    run: ProcessRunner;
  }>,
): Promise<UnitObservation> {
  const none = (check: RecoveryCheck): UnitObservation =>
    Object.freeze({ check, facts: null });
  if (!userManagerPresent(input.platform, input.env))
    return none(skipped("launchpad-unit", "no-user-manager"));
  if (!input.supervised)
    return none(skipped("launchpad-unit", "not-supervised"));
  const text = await output(input, [
    "systemctl",
    "--user",
    "show",
    `--property=${unitProperties.join(",")}`,
    "--",
    launchpadUnit,
  ]);
  if (text === null)
    return none(skipped("launchpad-unit", "user-manager-unreachable"));
  const properties = new Map<string, string>();
  for (const line of text.split("\n")) {
    const split = line.indexOf("=");
    if (split > 0) properties.set(line.slice(0, split), line.slice(split + 1));
  }
  const facts: UnitFacts = Object.freeze({
    loadState: stateWord(unitLoadStates, properties.get("LoadState")),
    activeState: stateWord(unitActiveStates, properties.get("ActiveState")),
    subState: stateWord(serviceSubStates, properties.get("SubState")),
    result: stateWord(serviceResults, properties.get("Result")),
    nRestarts: count(properties.get("NRestarts")),
    execMainStatus: count(properties.get("ExecMainStatus")),
  });
  const context: ErrorContext = {
    activeState: facts.activeState,
    subState: facts.subState,
    result: facts.result,
    ...(facts.nRestarts === null ? {} : { nRestarts: facts.nRestarts }),
    ...(facts.execMainStatus === null
      ? {}
      : { execMainStatus: facts.execMainStatus }),
  };
  const judged = (code: RecoveryCode | null) =>
    Object.freeze({
      check:
        code === null
          ? ok("launchpad-unit", context)
          : failed("launchpad-unit", code, context),
      facts,
    });
  if (facts.loadState === "not-found") return judged("unit-not-loaded");
  switch (facts.activeState) {
    case "active":
    case "reloading":
      return judged(null);
    case "activating":
      return judged(
        facts.subState === "auto-restart" ? "unit-restarting" : null,
      );
    case "failed":
      return judged("unit-failed");
    case "inactive":
    case "deactivating":
      return judged("unit-inactive");
    default:
      return Object.freeze({
        check: skipped("launchpad-unit", "unit-state-unknown"),
        facts,
      });
  }
}

/** `systemctl --version`: the number of the first line, `systemd 255 (…)`. */
export async function systemdVersion(command: Command): Promise<number | null> {
  const text = await output(command, ["systemctl", "--version"]);
  return count(/^systemd (\d+)/.exec(text ?? "")?.[1]);
}

/** The last lines of the Launchpad unit's journal, unsanitized: the caller
 * passes them through the sanitizer before they go anywhere. */
export async function unitJournal(
  command: Command,
  lines: number,
): Promise<string | null> {
  return output(command, [
    "journalctl",
    "--user",
    "--unit",
    launchpadUnit,
    "--output",
    "cat",
    "--no-pager",
    "--lines",
    String(lines),
  ]);
}

// ---- The health socket -----------------------------------------------------

export type HealthAnswer =
  | Readonly<{ kind: "version"; version: string }>
  /** Recovery mode (docs/update.md "Recovery mode"): `503 {mode, check,
   * reason}`; `reason` is why the start was refused, when it was sent. */
  | Readonly<{ kind: "recovery"; check: string; refusal: string | null }>
  | Readonly<{ kind: "unexpected" }>
  | Readonly<{ kind: "none" }>;

/** `GET /health` on the socket under the base, distinguishing no answer from
 * an answer this version does not expect. */
export async function askHealth(
  base: string,
  timeoutMs = 2_000,
): Promise<HealthAnswer> {
  let response: Response;
  try {
    response = await fetch("http://launchpad/health", {
      unix: layout(base).healthSocket,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return Object.freeze({ kind: "none" });
  }
  try {
    const body = (await response.json()) as {
      version?: unknown;
      mode?: unknown;
      check?: unknown;
      reason?: unknown;
    };
    const id = (value: unknown): value is string =>
      typeof value === "string" && /^[a-z][a-z-]{0,63}$/.test(value);
    if (response.ok && isProductVersion(body.version))
      return Object.freeze({ kind: "version", version: body.version });
    if (response.status === 503 && body.mode === "recovery" && id(body.check))
      return Object.freeze({
        kind: "recovery",
        check: body.check,
        refusal: id(body.reason) ? body.reason : null,
      });
  } catch {}
  return Object.freeze({ kind: "unexpected" });
}

/** The reasons the health check itself writes into its context. */
export const healthReasons = ["unexpected-answer", "no-answer"] as const;

/** A supervised Launchpad must answer with the active version. Without a
 * supervisor no socket is expected: an answer is reported, silence is not
 * a fault. */
export function judgeHealth(
  input: Readonly<{
    answer: HealthAnswer;
    active: string | null;
    supervised: boolean;
  }>,
): RecoveryCheck {
  const { answer, active, supervised } = input;
  if (active === null) return skipped("launchpad-health", "not-installed");
  switch (answer.kind) {
    case "version":
      return answer.version === active
        ? ok("launchpad-health", { version: answer.version })
        : failed("launchpad-health", "launchpad-version-mismatch", {
            reported: answer.version,
            active,
          });
    case "recovery":
      // Why the start was refused: the tier-1 allowlist keeps both only as
      // the product's own ids (healthSocketChecks, startRefusals).
      return failed("launchpad-health", "launchpad-recovery-mode", {
        check: answer.check,
        ...(answer.refusal === null ? {} : { refusal: answer.refusal }),
      });
    case "unexpected":
      return failed("launchpad-health", "launchpad-not-answering", {
        reason: "unexpected-answer",
      });
    case "none":
      return supervised
        ? failed("launchpad-health", "launchpad-not-answering", {
            reason: "no-answer",
          })
        : skipped("launchpad-health", "not-supervised");
  }
}
