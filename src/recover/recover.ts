import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { machineBinding } from "../machine/binding";
import type { MachineContext } from "../machine/context";
import type { ErrorContext } from "../update/errors";
import { isProductVersion, type ProductIdentity } from "../update/identity";
import { layout, readSelector } from "../update/layout";
import type { ProcessRunner } from "../update/self-check";
import {
  detectServiceControl,
  observeUpdateUnit,
  readUpdateUnitFailure,
} from "../update/service-control";
import { readStatus, type UpdateStatus } from "../update/update";
import { compareVersions } from "../update/version";
import {
  failed,
  ok,
  primaryFailure,
  type RecoveryCheck,
  skipped,
} from "./checks";
import {
  fingerprint,
  isReleaseVersion,
  type RecoveryEvidence,
  tierOneContext,
} from "./evidence";
import { type PreparedIssue, prepareIssue, type RefusedIssue } from "./issue";
import {
  askHealth,
  type HealthAnswer,
  judgeHealth,
  observeFolder,
  observeSelfCheck,
  observeUnit,
  systemdVersion,
  unitJournal,
  userManagerPresent,
} from "./observe";
import {
  bindingValues,
  contextValues,
  folderNames,
  type MachineFacts,
  machineValues,
} from "./private-values";
import { recoveryPrompt } from "./prompt";
import { createSanitizer, journalLimits, type Sanitizer } from "./sanitize";

/** `collectRecovery`: the one use case behind `lazurio recover` and, in a
 * later slice, the Launchpad's recovery page (docs/recovery.md). It reads and
 * never writes: no lock, no restart, no network, nothing filed. */
export type RecoveryEnvironment = Readonly<{
  base: string;
  /** The executable that runs this. */
  identity: ProductIdentity;
  fixture: boolean;
  platform: string;
  env: Readonly<Record<string, string | undefined>>;
  /** The Folder named by the caller; the supervised unit's otherwise, then
   * on a hosted Machine the declared operator's. */
  folder?: string | undefined;
  hostedFolder?: (() => Promise<string | undefined>) | undefined;
  run: ProcessRunner;
  now: () => Date;
  /** This process's account, home, host and system. */
  machine: () => Promise<
    MachineFacts & Readonly<{ kernel: string; arch: string; bun: string }>
  >;
  /** The Machine handover, where there is one. Never a reason to fail. */
  machineContext: () => Promise<Readonly<{
    context: MachineContext;
    digest: string;
  }> | null>;
  health?: ((base: string) => Promise<HealthAnswer>) | undefined;
  selfCheckTimeoutMs?: number | undefined;
  /** The prompt's language; the Folder's recorded one when not named. */
  locale?: "cs" | "en" | undefined;
}>;

export type RecoveryVerdict = "healthy" | "broken" | "not-installed";

export type RecoveryResult = Readonly<{
  kind: "recovery";
  verdict: RecoveryVerdict;
  checks: readonly RecoveryCheck[];
  /** Only when broken. */
  evidence: RecoveryEvidence | null;
  prompt: string | null;
  issue: PreparedIssue | RefusedIssue | null;
}>;

/** R2 from the update core's own status reader, the one an outside observer
 * reads: a path of state no crash can produce. */
async function updateState(
  environment: RecoveryEnvironment,
): Promise<{ check: RecoveryCheck; status: UpdateStatus | null }> {
  try {
    const status = await readStatus({
      base: environment.base,
      identity: environment.identity,
      service: null,
      // Only the refresh report reads the Folder; recovery reads it itself.
      folder: undefined,
    });
    return {
      status,
      check:
        status.stateInvalid === null
          ? ok("update-state-invalid")
          : failed("update-state-invalid", "state-invalid", {
              path: status.stateInvalid,
            }),
    };
  } catch {
    return {
      status: null,
      check: failed("update-state-invalid", "internal"),
    };
  }
}

async function installedVersions(base: string): Promise<string[]> {
  const entries = await readdir(layout(base).versions).catch(() => []);
  return entries.filter(isProductVersion).sort(compareVersions);
}

// The names v0.1.x leaves behind; read to report them, never touched here.
const exists = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  );

/** A context kept to its tier-1 allowlist, then every string sanitized. */
const cleanContext = (context: ErrorContext, sanitizer: Sanitizer) =>
  Object.freeze(
    Object.fromEntries(
      Object.entries(tierOneContext(context)).map(([key, value]) => [
        key,
        typeof value === "string" ? sanitizer.sanitize(value) : value,
      ]),
    ),
  );

// Only the numbers of a kernel release (`6.8.0` of `6.8.0-45-generic`): the
// rest is a free-form suffix any build may choose.
const kernelRelease = (value: string) =>
  /^\d{1,4}\.\d{1,4}(\.\d{1,4})?/.exec(value)?.[0] ?? "invalid";

// A version the Machine recorded is tier 1 only in the release form.
const release = (value: string) =>
  isReleaseVersion(value) ? value : "invalid";
const maybeRelease = (value: string | null) =>
  value === null ? null : release(value);

// Only the time, in the one form the product writes.
const isoTime = (value: string) => {
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
};

export async function collectRecovery(
  environment: RecoveryEnvironment,
): Promise<RecoveryResult> {
  const { base, identity, platform, env, run } = environment;
  const detectedAt = environment.now().toISOString();
  const service = await detectServiceControl({ base, platform, env, run });
  const supervised = service !== null;
  const folder =
    environment.folder ??
    service?.folder ??
    (await environment.hostedFolder?.().catch(() => undefined));

  const state = await updateState(environment);
  const active = state.status?.active ?? (await readSelector(base));
  const folderObservation = await observeFolder(folder);
  const selfCheck = await observeSelfCheck({
    base,
    active,
    target: identity.target,
    folder,
    run,
    timeoutMs: environment.selfCheckTimeoutMs,
  });
  const unit = await observeUnit({ supervised, platform, env, run });
  const health =
    active === null
      ? skipped("launchpad-health", "not-installed")
      : judgeHealth({
          answer: await (environment.health ?? askHealth)(base),
          active,
          supervised,
        });
  const checks = Object.freeze([
    state.check,
    folderObservation.check,
    selfCheck.check,
    unit.check,
    health,
  ]);
  const primary = primaryFailure(checks);
  if (primary === null)
    return Object.freeze({
      kind: "recovery",
      verdict: active === null ? "not-installed" : "healthy",
      checks,
      evidence: null,
      prompt: null,
      issue: null,
    });

  // Broken: the evidence, sanitized, the issue behind the gate, the prompt.
  const machine = await environment.machine();
  const handover = await environment.machineContext().catch(() => null);
  let handoverBinding: ReturnType<typeof machineBinding> | null = null;
  try {
    handoverBinding =
      handover === null
        ? null
        : machineBinding(handover.context, handover.digest);
  } catch {}
  const sanitizer = createSanitizer({
    values: [
      ...(folder === undefined
        ? []
        : [{ kind: "folder" as const, value: folder }]),
      { kind: "install-base", value: base },
      ...machineValues(machine),
      ...(folder === undefined ? [] : await folderNames(folder)),
      ...bindingValues(folderObservation.preferences?.machine ?? null),
      ...bindingValues(handoverBinding),
      ...contextValues(handover?.context ?? null),
    ],
    publicDigests: [
      identity.commit,
      ...(selfCheck.identity === null ? [] : [selfCheck.identity.commit]),
    ],
  });
  const managed = supervised && userManagerPresent(platform, env);
  const command = { run, env };
  const journal = managed
    ? await unitJournal(command, journalLimits.lines)
    : null;
  let lastUpdateFailure: NonNullable<
    RecoveryEvidence["unit"]
  >["lastUpdateFailure"] = null;
  if (managed) {
    const updateUnit = await observeUpdateUnit(command);
    const failure =
      updateUnit?.kind === "failed"
        ? await readUpdateUnitFailure(command, updateUnit.invocationId)
        : null;
    lastUpdateFailure =
      failure === null
        ? null
        : Object.freeze({
            code: failure.code,
            context: cleanContext(failure.context, sanitizer),
          });
  }
  const status = state.status;
  const lastCheck = status?.lastCheck;
  const checkedAt = lastCheck == null ? null : isoTime(lastCheck.checkedAt);
  const clean = (check: RecoveryCheck): RecoveryCheck =>
    check.outcome === "skipped"
      ? check
      : Object.freeze({
          ...check,
          context: cleanContext(check.context, sanitizer),
        });
  const cleanChecks = Object.freeze(checks.map(clean));
  const cleanPrimary = primaryFailure(cleanChecks) ?? primary;
  const evidence: RecoveryEvidence = Object.freeze({
    schema: "lazurio.recovery.v1",
    detectedAt,
    fingerprint: fingerprint(cleanPrimary, identity.target),
    check: cleanPrimary.id,
    rule: cleanPrimary.rule,
    code: cleanPrimary.code,
    context: cleanPrimary.context,
    failed: Object.freeze(
      checks
        .filter((check) => check.outcome === "failed")
        .map((check) => check.id),
    ),
    checks: cleanChecks,
    product: Object.freeze({
      running: Object.freeze({ ...identity, fixture: environment.fixture }),
      active:
        selfCheck.identity === null
          ? null
          : Object.freeze({
              ...selfCheck.identity,
              version: release(selfCheck.identity.version),
            }),
    }),
    platform: Object.freeze({
      os: platform,
      kernel: kernelRelease(machine.kernel),
      arch: machine.arch,
      systemd: userManagerPresent(platform, env)
        ? await systemdVersion(command)
        : null,
      bun: machine.bun,
    }),
    install: Object.freeze({
      active: maybeRelease(active),
      highWater: maybeRelease(status?.highWater ?? null),
      stateInvalid: status?.stateInvalid ?? null,
      versions: Object.freeze((await installedVersions(base)).map(release)),
      supervised,
      legacyPrevious: await exists(join(base, "previous")),
      legacyMarker: await exists(join(base, "update", "pending.json")),
    }),
    unit:
      unit.facts === null
        ? null
        : Object.freeze({ ...unit.facts, lastUpdateFailure }),
    folder: folderObservation.facts,
    lastCheck:
      lastCheck == null || checkedAt === null
        ? null
        : Object.freeze({ latest: release(lastCheck.latest), checkedAt }),
    journal: journal === null ? null : sanitizer.journalTail(journal),
  });
  const issue = prepareIssue(evidence, sanitizer);
  const locale =
    environment.locale ?? folderObservation.preferences?.profile.locale ?? "en";
  return Object.freeze({
    kind: "recovery",
    verdict: "broken",
    checks: cleanChecks,
    evidence,
    prompt: recoveryPrompt({ evidence, issue, folder, supervised }, locale),
    issue,
  });
}
