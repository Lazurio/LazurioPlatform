import type { MachineBinding } from "../folder/machine-binding";
import type { PresetName } from "../folder/presets";

// Content installation (decision F9, addendum of 2026-10-04; root decision
// 0188): the explicit operation that puts an Environment's content into its
// Lazurio Folder. Which content an Environment holds is decided by its kind,
// the Folder's recorded preset, and nothing else:
// - `local` (the person's own computer): its Organizations and the
//   Personalspace;
// - `hosted-personal` (the person's personal Remote Environment): only the
//   Personalspace, never an Organization repository;
// - `hosted-organization-personal` (a work Environment assigned to one
//   operator): only the Organization of its handover, never a Personalspace;
// - `hosted-organization-team` and `hosted-organization-steward`: content the
//   hosting prepares; this operation reports them and does nothing there.
// Nothing here grants access: GitHub decides at every operation boundary.

/** What one install request names. */
export type ContentItemRef =
  | Readonly<{ kind: "organization"; login: string }>
  | Readonly<{ kind: "personalspace" }>;

export type ContentItemState = "absent" | "present" | "blocked";

/** One item of `contentStatus`, the shape `GET /api/content` answers. */
export type ContentItem =
  | Readonly<{
      kind: "organization";
      login: string;
      name?: string;
      state: ContentItemState;
      reason?: string;
    }>
  | Readonly<{
      kind: "personalspace";
      login: string | null;
      state: ContentItemState;
      onGitHub?: "exists" | "missing" | "unknown";
      reason?: string;
    }>;

/** Why this Environment does not install content at all, or not this item:
 * `prepared-by-hosting` (a Team or Automated Environment, whose content the
 * hosting prepares), `not-for-this-environment` (an item its kind never
 * holds), `folder-unreadable` (the Folder's state could not be read). */
export type ContentRefusal =
  | "prepared-by-hosting"
  | "not-for-this-environment"
  | "folder-unreadable";

export type ContentStatus = Readonly<{
  allowed: boolean;
  reason?: ContentRefusal;
  items: readonly ContentItem[];
}>;

/** The fixed step vocabulary (contract of the Launchpad UI). */
export const organizationSteps = [
  "access",
  "root",
  "modules",
  "preparation",
  "check",
] as const;
export const personalspaceSteps = ["find", "create", "clone", "check"] as const;
export type StepKey =
  | (typeof organizationSteps)[number]
  | (typeof personalspaceSteps)[number];
export type StepState = "running" | "done" | "failed" | "skipped";

/** The stable failure codes a step may carry; the Launchpad writes the
 * person's sentence from the code, `detail` is a short English line for
 * agents. */
export const contentFailureCodes = [
  // GitHub identity of this Environment
  "github-signed-out",
  "github-unavailable",
  "github-identity-mismatch",
  // Organization root
  "organization-root-needs-decision",
  "organization-ambiguous",
  "root-denied",
  "root-owner-mismatch",
  "role-unverified",
  "organization-template",
  "root-declaration-invalid",
  "root-declaration-mismatch",
  "organization-unreadable",
  // materialization of one repository
  "destination-occupied",
  "destination-invalid",
  "clone-failed",
  "checkout-unexpected",
  "publish-failed",
  // the final check of an Organization: the catalog's reason, or none
  "organization-missing",
  // Personalspace
  "personalspace-ambiguous",
  "personalspace-unavailable",
  "personalspace-public",
  "personalspace-not-owned",
  "personalspace-elsewhere",
  "create-failed",
  "personalspace-not-private",
  "create-not-ready",
  "check-failed",
  // the operation itself
  "content-busy",
  "operation-failed",
] as const;
export type ContentFailureCode = (typeof contentFailureCodes)[number];

export type ContentStep = Readonly<{
  item: ContentItemRef;
  key: StepKey;
  state: StepState;
  detail?: string;
  /** Only on a failed step: a `contentFailureCodes` member, or for the
   * Organization `check` the catalog's reason (`organization-conflict`, …). */
  code?: string;
}>;

export type ContentFailure = Readonly<{
  item: ContentItemRef;
  key: StepKey;
  code: string;
  detail: string;
}>;

/** What the Folder's recorded preset admits. */
export type ContentScope =
  | Readonly<{ allowed: false; reason: "prepared-by-hosting" }>
  | Readonly<{
      allowed: true;
      /** `folder`: the Organizations the Folder holds, and any other one an
       * install names; `none`: no Organization; otherwise exactly this
       * GitHub login (the handover's Organization). */
      organizations: "folder" | "none" | Readonly<{ only: string }>;
      personalspace: boolean;
      /** The person a personal Remote Environment belongs to: its
       * Personalspace must be theirs. */
      personalOwner: Readonly<{ githubId: number }> | null;
    }>;

/** The scope of an Environment from its recorded preset and Machine binding
 * (`derivePreset` decides the preset; the Folder records it). */
export function contentScope(
  preset: PresetName,
  machine: MachineBinding | null,
): ContentScope {
  switch (preset) {
    case "local":
      return Object.freeze({
        allowed: true,
        organizations: "folder",
        personalspace: true,
        personalOwner: null,
      });
    case "hosted-personal":
      return Object.freeze({
        allowed: true,
        organizations: "none",
        personalspace: true,
        personalOwner:
          machine?.owner.kind === "principal"
            ? Object.freeze({ githubId: machine.owner.githubId })
            : null,
      });
    case "hosted-organization-personal":
      // A work Environment holds the Organization of its handover only. A
      // binding without one (impossible for this preset) admits nothing.
      return machine?.owner.kind === "organization"
        ? Object.freeze({
            allowed: true,
            organizations: Object.freeze({ only: machine.owner.organization }),
            personalspace: false,
            personalOwner: null,
          })
        : Object.freeze({
            allowed: true,
            organizations: "none",
            personalspace: false,
            personalOwner: null,
          });
    case "hosted-organization-team":
    case "hosted-organization-steward":
      return Object.freeze({ allowed: false, reason: "prepared-by-hosting" });
  }
}

/** Whether the scope admits one requested item. */
export function scopeAdmits(scope: ContentScope, item: ContentItemRef) {
  if (!scope.allowed) return false;
  if (item.kind === "personalspace") return scope.personalspace;
  if (scope.organizations === "none") return false;
  if (scope.organizations === "folder") return true;
  return item.login.toLowerCase() === scope.organizations.only.toLowerCase();
}

/** A GitHub login, as GitHub spells them. */
export const githubLoginPattern =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
/** `<owner>/<repository>` of github.com. */
export const repositoryPattern =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9_.-]{1,100}$/;

/** Whether two GitHub coordinates name the same repository (GitHub compares
 * owner and name case-insensitively). */
export const sameRepository = (a: string, b: string) =>
  a.toLowerCase() === b.toLowerCase();

/** One item in the text and JSON lines of the CLI. */
export const itemLabel = (item: ContentItemRef) =>
  item.kind === "organization" ? `organization ${item.login}` : "personalspace";
