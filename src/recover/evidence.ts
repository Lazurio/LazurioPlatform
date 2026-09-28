import { createHash } from "node:crypto";
import { constants } from "node:os";
import { isTemplateRevision } from "../folder/render";
import { healthSocketChecks, startRefusals } from "../launchpad/start-check";
import {
  type ErrorContext,
  type UpdateErrorCode,
  updateErrorCodes,
  updateErrorReasons,
  updateErrorResources,
  updateErrorStages,
} from "../update/errors";
import { updateTargets } from "../update/identity";
import { updateStatePaths } from "../update/layout";
import {
  checkDetail,
  type FailedCheck,
  type RecoveryCheck,
  type RecoveryCheckId,
  type RecoveryCode,
  type RecoveryRule,
  recoveryCheckIds,
} from "./checks";
import {
  type FolderFacts,
  healthReasons,
  serviceResults,
  serviceSubStates,
  type UnitFacts,
  unitActiveStates,
} from "./observe";

/** The evidence bundle (docs/recovery-mode.md E.1): enumerated fields plus
 * one bounded, sanitized tail of the Launchpad unit's journal. Structure
 * first: a field cannot leak what it does not contain. The fields are tier 1,
 * the issue body; the journal is tier 2 and stays on the Machine
 * (docs/recovery.md "Two tiers"). Never collected: the
 * Folder's files, Organization entries by name, preference contents, the
 * handover, environment variables, tool sign-in state, anything under
 * `personalspace/`. */
export const evidenceSchema = "lazurio.recovery.v1";

export type ExecutableFacts = Readonly<{
  version: string;
  commit: string;
  target: string;
  fixture: boolean;
}>;

export type RecoveryEvidence = Readonly<{
  schema: typeof evidenceSchema;
  detectedAt: string;
  /** `rf-` and 12 hex characters; the same fault across releases. */
  fingerprint: string;
  /** The failed check the issue is about, and every failed check. */
  check: RecoveryCheckId;
  rule: RecoveryRule | null;
  code: RecoveryCode;
  context: ErrorContext;
  failed: readonly RecoveryCheckId[];
  checks: readonly RecoveryCheck[];
  product: Readonly<{
    /** The executable that ran `recover`. */
    running: ExecutableFacts;
    /** What the active executable said in its self-check; null when it
     * said nothing readable. */
    active: ExecutableFacts | null;
  }>;
  platform: Readonly<{
    os: string;
    kernel: string;
    arch: string;
    /** Linux with a user service manager only. */
    systemd: number | null;
    bun: string;
  }>;
  install: Readonly<{
    active: string | null;
    highWater: string | null;
    /** Relative to the install base. */
    stateInvalid: string | null;
    versions: readonly string[];
    supervised: boolean;
    /** Left by v0.1.x: the retained `previous` link and the activation
     * marker `update/pending.json`. Reported, never touched. */
    legacyPrevious: boolean;
    legacyMarker: boolean;
  }>;
  unit:
    | (UnitFacts &
        Readonly<{
          lastUpdateFailure: Readonly<{
            code: UpdateErrorCode;
            context: ErrorContext;
          }> | null;
        }>)
    | null;
  folder: FolderFacts | null;
  lastCheck: Readonly<{ latest: string; checkedAt: string }> | null;
  /** Sanitized; null where no journal can be read. Tier 2: never in the
   * issue body. */
  journal: string | null;
}>;

/** Tier 1 for a context (docs/recovery.md "Two tiers"): an explicit
 * allowlist of keys. An id-valued key admits only the finite values the
 * product itself defines, taken from the constants beside the code that emits
 * them, never a shape; a version admits only the release form, digits only.
 * Every other key (a `message`, a `note`, a `detail`, an `error`) and every
 * value outside its list is dropped. It holds for the product's own check
 * contexts and for the one read back from the update unit's journal alike. */
const oneOf =
  (...lists: readonly (readonly unknown[])[]) =>
  (value: unknown) =>
    lists.some((list) => list.includes(value));
const integer = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value);
/** The product's release form (docs/release-cycle.md): `X.Y.Z` or
 * `X.Y.Z-rc.N`. A wider version string could carry a word. */
export const isReleaseVersion = (value: unknown): value is string =>
  typeof value === "string" &&
  /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})(-rc\.[1-9]\d{0,5})?$/.test(
    value,
  );
const revisionId = (value: unknown) =>
  integer(value) || (typeof value === "string" && isTemplateRevision(value));
export const contextRules: Readonly<
  Record<string, (value: unknown) => boolean>
> = Object.freeze({
  reason: oneOf(updateErrorReasons, healthReasons),
  code: oneOf(updateErrorCodes),
  stage: oneOf(updateErrorStages),
  resource: oneOf(updateErrorResources),
  // A check of `recover`, or the one a Launchpad in Recovery mode names.
  check: oneOf(recoveryCheckIds, healthSocketChecks),
  // the enumerated condition of a refused Launchpad start or probe
  // (start-check.ts)
  refusal: oneOf(startRefusals),
  exitCode: integer,
  httpStatus: integer,
  nRestarts: integer,
  execMainStatus: integer,
  activeState: oneOf(unitActiveStates, ["unknown"]),
  subState: oneOf(serviceSubStates, ["unknown"]),
  result: oneOf(serviceResults, ["unknown"]),
  path: oneOf(updateStatePaths),
  version: isReleaseVersion,
  expected: isReleaseVersion,
  actual: isReleaseVersion,
  reported: isReleaseVersion,
  active: isReleaseVersion,
  latest: isReleaseVersion,
  from: isReleaseVersion,
  to: isReleaseVersion,
  revision: revisionId,
  recorded: revisionId,
  product: revisionId,
  target: oneOf(updateTargets),
  errno: oneOf(Object.keys(constants.errno)),
});

export const tierOneContext = (context: ErrorContext): ErrorContext =>
  Object.freeze(
    Object.fromEntries(
      Object.entries(context).filter(
        ([key, value]) =>
          Object.hasOwn(contextRules, key) &&
          (contextRules[key] as (value: unknown) => boolean)(value),
      ),
    ),
  );

/** 12 hex characters of SHA-256 over the check, its code, the one detail of
 * its context and the target, without the version, so one fault meets its
 * issue across releases (docs/recovery-mode.md E.4). */
export function fingerprint(check: FailedCheck, target: string): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([check.id, check.code, checkDetail(check), target]))
    .digest("hex");
  return `rf-${digest.slice(0, 12)}`;
}

/** JSON for a person: a value that fits on one line stays on one line. */
export function readableJson(value: unknown, indent = ""): string {
  const inline = JSON.stringify(value);
  if (
    inline === undefined ||
    value === null ||
    typeof value !== "object" ||
    indent.length + inline.length <= 72
  )
    return inline ?? "null";
  const inner = `${indent}  `;
  if (Array.isArray(value))
    return `[\n${value.map((entry) => `${inner}${readableJson(entry, inner)}`).join(",\n")}\n${indent}]`;
  return `{\n${Object.entries(value)
    .filter(([, entry]) => entry !== undefined)
    .map(
      ([key, entry]) =>
        `${inner}${JSON.stringify(key)}: ${readableJson(entry, inner)}`,
    )
    .join(",\n")}\n${indent}}`;
}
