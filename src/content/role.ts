// The person's LIVE role in the Organization an install targets (review of
// root decision 0188, 2026-10-04), as the resident `lazurio organization
// install <login> [--role builder|steward]` scopes it
// (`R:lazurio/organization-install-lib.mjs`, `installRestrictedSlotPolicy`),
// plus the Module Reader of Matěj's direction of 2026-10-05 (decision F9,
// addendum 2026-10-05), which the resident does not know. The values are the
// identifiers of root decision 0234 (`organization-admin`,
// `module-maintainer`, `module-contributor`, `module-reader`); the
// resident's `builder` and `steward` and this CLI's former `reader` are
// accepted only as deprecated aliases of `--role` (`src/content/cli.ts`):
// - a verified Organization Admin gets the full installation, restricted
//   (Organization Admin only) slots included;
// - a Module Maintainer, Module Contributor or Module Reader gets everything
//   else: restricted slots and every slot below one are excluded before any
//   provider operation (`excluded_by_role_scope`). These are the Module role
//   on the Organization's root repository, the one repository the scope is
//   read from; a Module's own repository may give the same person another
//   role. As root decision 0232 maps them, `maintain` is the Module
//   Maintainer, and `push` (`write`) is the Module Contributor where the
//   repository can have branch rules and the Module Maintainer where it
//   cannot;
// - a role that cannot be verified fails closed (`role-unverified`) before
//   anything is cloned.
// GitHub is the only authority; nothing here is recorded or cached, and the
// role decides only the install's scope, never access: a Module Reader's
// clones are read-only because GitHub refuses their pushes, not because of
// anything here.

export const organizationRoles = [
  "organization-admin",
  "module-maintainer",
  "module-contributor",
  "module-reader",
] as const;
export type OrganizationRole = (typeof organizationRoles)[number];

export const isOrganizationRole = (value: unknown): value is OrganizationRole =>
  typeof value === "string" &&
  (organizationRoles as readonly string[]).includes(value);

/** A repository permission as GitHub's REST `permissions` name it, the
 * highest one granted. */
export type RepositoryPermission =
  | "admin"
  | "maintain"
  | "write"
  | "triage"
  | "read";

/** `GET /user/memberships/orgs/<org>` through gh: an Organization Owner is
 * an active membership with GitHub's organization role `admin` (as
 * `organization-owner.ts` reads it). */
export type MembershipAnswer =
  | Readonly<{
      kind: "member";
      state: "active" | "pending";
      role: "admin" | "member";
    }>
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "unavailable" }>;

export type RoleVerification =
  | Readonly<{
      kind: "verified";
      role: OrganizationRole;
      /** Restricted slots: in scope only for a verified Organization
       * Admin. */
      restricted: "include" | "exclude";
    }>
  | Readonly<{ kind: "unverified"; detail: string }>;

const rank: Readonly<Record<RepositoryPermission, number>> = {
  read: 1,
  triage: 2,
  write: 3,
  maintain: 4,
  admin: 5,
};
const atLeast = (
  permission: RepositoryPermission | null,
  floor: RepositoryPermission,
) => permission !== null && rank[permission] >= rank[floor];

const isActiveMember = (membership: MembershipAnswer) =>
  membership.kind === "member" && membership.state === "active";

const isOwner = (membership: MembershipAnswer) =>
  membership.kind === "member" &&
  membership.state === "active" &&
  membership.role === "admin";

/** Whether a repository can have branch rules, as its own answer says
 * (root decision 0232: not the name of the plan). `unknown` when GitHub did
 * not say. */
export type BranchRules = "available" | "unavailable" | "unknown";

/** The Module role a permission on a repository is (root decision 0232),
 * or null below `write`. Where GitHub did not say whether the repository can
 * have branch rules, `write` is named by the lower role, the Module
 * Contributor: an unknown answer never makes anyone a Module Maintainer. */
function moduleRole(
  permission: RepositoryPermission | null,
  branchRules: BranchRules,
): "module-maintainer" | "module-contributor" | null {
  if (atLeast(permission, "maintain")) return "module-maintainer";
  if (atLeast(permission, "write"))
    return branchRules === "unavailable"
      ? "module-maintainer"
      : "module-contributor";
  return null;
}

const verified = (role: OrganizationRole): RoleVerification =>
  Object.freeze({
    kind: "verified",
    role,
    restricted: role === "organization-admin" ? "include" : "exclude",
  });

/** The role GitHub confirms now. `requested` is the role the caller asks
 * for — `organization-admin` for the CLI's bare `organization install
 * <login>` (the resident's Admin installation), `module-contributor`,
 * `module-maintainer` or `module-reader` for its `--role` — or null to
 * resolve it live (the Launchpad picks the form from the live role, in the
 * order Organization Admin, Module Maintainer, Module Contributor, Module
 * Reader): the Organization Admin by an active Organization Owner membership
 * (until the role in Lazurio Auth is deployed, root decision 0228); the
 * Module role on the root repository by its permission as root decision
 * 0232 maps it (`moduleRole`: `maintain` the Module Maintainer, `write` the
 * Module Contributor, or the Module Maintainer where the root cannot have
 * branch rules; the resident's `builder` gate reads WRITE); the Module
 * Reader by `read` or `triage` on it together with an active membership (a
 * public root answers `read` to every account, so the permission alone
 * names no one of the Organization). A narrower role than the live one is
 * confirmed as asked, except the Module Contributor where the root cannot
 * have branch rules: there it does not exist (0232), and `write` is
 * confirmed as the Module Maintainer. An asserted role GitHub does not
 * confirm, and a live resolution that finds none of them, is `unverified`:
 * the caller fails closed. */
export function verifyOrganizationRole(
  input: Readonly<{
    requested: OrganizationRole | null;
    membership: MembershipAnswer;
    /** The account's permission on the root repository; null when it is
     * not known. */
    rootPermission: RepositoryPermission | null;
    /** Whether the root repository can have branch rules; only `write`
     * depends on it. Absent, `unknown`. */
    rootBranchRules?: BranchRules | undefined;
  }>,
): RoleVerification {
  const { requested, membership, rootPermission } = input;
  const branchRules = input.rootBranchRules ?? "unknown";
  const admin = isOwner(membership);
  const live = moduleRole(rootPermission, branchRules);
  if (requested === "organization-admin")
    return admin
      ? verified("organization-admin")
      : {
          kind: "unverified",
          detail:
            membership.kind === "unavailable"
              ? "GitHub did not answer the Organization membership"
              : "the account is not an active Organization Owner",
        };
  if (requested === "module-maintainer")
    return live === "module-maintainer"
      ? verified("module-maintainer")
      : {
          kind: "unverified",
          detail:
            live === null
              ? "the account has no maintain permission on the root repository, nor write where it cannot have branch rules"
              : branchRules === "unknown"
                ? "the account has write but no maintain permission on the root repository, and GitHub did not say whether the repository can have branch rules (where it cannot, write is the Module Maintainer, root decision 0232)"
                : "the account has write but no maintain permission on the root repository, which can have branch rules (root decision 0232)",
        };
  if (requested === "module-contributor")
    return live === null
      ? {
          kind: "unverified",
          detail: "the account has no write permission on the root repository",
        }
      : verified(
          // No Module Contributor where the root cannot have branch rules.
          branchRules === "unavailable"
            ? "module-maintainer"
            : "module-contributor",
        );
  if (requested === "module-reader")
    return isActiveMember(membership) && atLeast(rootPermission, "read")
      ? verified("module-reader")
      : {
          kind: "unverified",
          detail: !isActiveMember(membership)
            ? membership.kind === "unavailable"
              ? "GitHub did not answer the Organization membership"
              : "the account is not an active member of the Organization"
            : "the account has no read permission on the root repository",
        };
  if (admin) return verified("organization-admin");
  if (live !== null) return verified(live);
  if (isActiveMember(membership) && atLeast(rootPermission, "read"))
    return verified("module-reader");
  return {
    kind: "unverified",
    detail:
      membership.kind === "unavailable" && rootPermission === null
        ? "GitHub did not answer the membership or the root repository's permission"
        : membership.kind === "unavailable"
          ? "the account has no write permission on the root repository and GitHub did not answer the Organization membership"
          : "the account is neither an Organization Owner, nor has write permission on the root repository, nor is an active Organization Member who reads it",
  };
}

/** How a declared slot's access is classified, as the resident's
 * `classifyOrganizationSlotAccess` (`R:lazurio/core/organization-slot-scope-lib.mjs`):
 * `restricted` for `default_access` `restricted` or `private` (Organization
 * Admin only),
 * `unknown` for any other undeclared mode or a malformed `required_roles`,
 * `ordinary` otherwise. */
export function classifySlotAccess(
  slot: Readonly<Record<string, unknown>>,
): "ordinary" | "restricted" | "unknown" {
  const access = slot.default_access;
  if (
    access !== undefined &&
    access !== null &&
    (typeof access !== "string" ||
      !["expected", "optional", "role_based", "restricted", "private"].includes(
        access,
      ))
  )
    return "unknown";
  const roles = slot.required_roles;
  if (
    roles !== undefined &&
    roles !== null &&
    (!Array.isArray(roles) ||
      roles.some((role) => typeof role !== "string" || role.trim() === ""))
  )
    return "unknown";
  return access === "restricted" || access === "private"
    ? "restricted"
    : "ordinary";
}

/** Whether the root repository can have branch rules, asked only where it
 * matters: for `write`, whose Module role depends on it, and for any
 * permission of `write` or more when the Module Contributor is asked for,
 * which does not exist where the root cannot have them (root decision
 * 0232). A public repository always can. */
export async function rootBranchRules(
  repository: Readonly<{ fullName: string; private: boolean }>,
  permission: RepositoryPermission | null,
  ask: ((owner: string, name: string) => Promise<BranchRules>) | undefined,
  requested: OrganizationRole | null = null,
): Promise<BranchRules> {
  if (
    permission !== "write" &&
    !(requested === "module-contributor" && atLeast(permission, "write"))
  )
    return "unknown";
  if (!repository.private) return "available";
  if (ask === undefined) return "unknown";
  const [owner, name] = repository.fullName.split("/") as [string, string];
  return ask(owner, name);
}

/** Whether this identity can prepare an Organization for this version of
 * Lazurio when its root does not declare itself or cannot be read (root
 * decision 0201 point 8): write its root repository, by an active
 * Organization Owner membership or `write` (or more) on the conventional root
 * `<login>/<login>_GEN3`. GitHub's live answer only; nothing is recorded,
 * and it decides only which way the Launchpad points (Chat, or the sentence
 * that the Organization Admin prepares it), never access. Anything GitHub does not
 * confirm is no. */
export function canPrepareRoot(
  membership: MembershipAnswer,
  rootPermission: RepositoryPermission | null,
): boolean {
  return isOwner(membership) || atLeast(rootPermission, "write");
}
