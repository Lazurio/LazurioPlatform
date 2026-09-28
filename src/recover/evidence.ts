import { createHash } from "node:crypto";
import type { ErrorContext, UpdateErrorCode } from "../update/errors";
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
 * first: a field cannot leak what it does not contain. Never collected: the
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
  /** Sanitized; null where no journal can be read. */
  journal: string | null;
}>;

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
