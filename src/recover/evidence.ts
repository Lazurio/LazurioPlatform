import { createHash } from "node:crypto";
import { isTemplateRevision } from "../folder/render";
import type { ErrorContext, UpdateErrorCode } from "../update/errors";
import { isProductVersion } from "../update/identity";
import { updateStatePaths } from "../update/layout";
import {
  checkDetail,
  type FailedCheck,
  type RecoveryCheck,
  type RecoveryCheckId,
  type RecoveryCode,
  type RecoveryRule,
} from "./checks";
import type { FolderFacts, UnitFacts } from "./observe";

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
 * allowlist of keys, each with its own validator. Every other key (a
 * `message`, a `note`, a `detail`, an `error`) and every value its validator
 * refuses is dropped. It holds for the product's own check contexts and for
 * the one read back from the update unit's journal alike. */
const enumeratedId = (value: unknown) =>
  typeof value === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(value);
const integer = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value);
const stateWord = (value: unknown) =>
  typeof value === "string" && /^[a-z][a-z-]{0,31}$/.test(value);
const updateStatePath = (value: unknown) =>
  (updateStatePaths as readonly unknown[]).includes(value);
const revisionId = (value: unknown) =>
  integer(value) || (typeof value === "string" && isTemplateRevision(value));
const contextRules: Readonly<Record<string, (value: unknown) => boolean>> =
  Object.freeze({
    reason: enumeratedId,
    code: enumeratedId,
    stage: enumeratedId,
    resource: enumeratedId,
    check: enumeratedId,
    exitCode: integer,
    httpStatus: integer,
    nRestarts: integer,
    execMainStatus: integer,
    activeState: stateWord,
    subState: stateWord,
    result: stateWord,
    path: updateStatePath,
    version: isProductVersion,
    expected: isProductVersion,
    actual: isProductVersion,
    reported: isProductVersion,
    active: isProductVersion,
    latest: isProductVersion,
    from: isProductVersion,
    to: isProductVersion,
    revision: revisionId,
    recorded: revisionId,
    product: revisionId,
    target: (value) =>
      typeof value === "string" && /^[a-z0-9]+-[a-z0-9]+$/.test(value),
    errno: (value) => typeof value === "string" && /^E[A-Z]{1,15}$/.test(value),
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
