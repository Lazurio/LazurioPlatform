// The person's LIVE role in the Organization an install targets (review of
// root decision 0188, 2026-10-04), as the resident `lazurio organization
// install <login> [--role builder|steward]` scopes it
// (`R:lazurio/organization-install-lib.mjs`, `installRestrictedSlotPolicy`):
// - a verified Admin gets the full installation, restricted (Admin-only)
//   slots included;
// - a Builder or Steward gets everything else: restricted slots and every
//   slot below one are excluded before any provider operation
//   (`excluded_by_role_scope`);
// - a role that cannot be verified fails closed (`role-unverified`) before
//   anything is cloned.
// GitHub is the only authority; nothing here is recorded or cached, and the
// role decides only the install's scope, never access.

export const organizationRoles = ["admin", "steward", "builder"] as const;
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
 * an active membership with the role `admin` (as `organization-owner.ts`
 * reads it). */
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
      /** Restricted slots: in scope only for a verified Admin. */
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

const isOwner = (membership: MembershipAnswer) =>
  membership.kind === "member" &&
  membership.state === "active" &&
  membership.role === "admin";

const verified = (role: OrganizationRole): RoleVerification =>
  Object.freeze({
    kind: "verified",
    role,
    restricted: role === "admin" ? "include" : "exclude",
  });

/** The role GitHub confirms now. `requested` is the role the caller asks
 * for — `admin` for the CLI's bare `organization install <login>` (the
 * resident's Admin installation), `builder` or `steward` for its `--role` —
 * or null to resolve it live (the Launchpad picks the form from the live
 * role): Admin by an active Owner membership, Steward by
 * `maintain` on the root repository (the Steward's grant), Builder by
 * `write` on it (the resident's Builder gate reads WRITE). An asserted role
 * GitHub does not confirm, and a live resolution that finds none of them,
 * is `unverified`: the caller fails closed. */
export function verifyOrganizationRole(
  input: Readonly<{
    requested: OrganizationRole | null;
    membership: MembershipAnswer;
    /** The account's permission on the root repository; null when it is
     * not known. */
    rootPermission: RepositoryPermission | null;
  }>,
): RoleVerification {
  const { requested, membership, rootPermission } = input;
  const admin = isOwner(membership);
  if (requested === "admin")
    return admin
      ? verified("admin")
      : {
          kind: "unverified",
          detail:
            membership.kind === "unavailable"
              ? "GitHub did not answer the Organization membership"
              : "the account is not an active Owner of the Organization",
        };
  if (requested === "steward")
    return atLeast(rootPermission, "maintain")
      ? verified("steward")
      : {
          kind: "unverified",
          detail:
            "the account has no maintain permission on the root repository",
        };
  if (requested === "builder")
    return atLeast(rootPermission, "write")
      ? verified("builder")
      : {
          kind: "unverified",
          detail: "the account has no write permission on the root repository",
        };
  if (admin) return verified("admin");
  if (atLeast(rootPermission, "maintain")) return verified("steward");
  if (atLeast(rootPermission, "write")) return verified("builder");
  return {
    kind: "unverified",
    detail:
      membership.kind === "unavailable" && rootPermission === null
        ? "GitHub did not answer the membership or the root repository's permission"
        : "the account is neither an Owner nor has write permission on the root repository",
  };
}

/** How a declared slot's access is classified, as the resident's
 * `classifyOrganizationSlotAccess` (`R:lazurio/core/organization-slot-scope-lib.mjs`):
 * `restricted` for `default_access` `restricted` or `private` (Admin-only),
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
