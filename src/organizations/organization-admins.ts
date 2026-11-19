// The appointed Organization Admins: the optional `organization_admins` of
// `lazurio.organization.json` (root decision 0245, amended 2026-11-18). An
// Organization Owner appoints an Organization Admin; the Owner role itself is
// never the Admin role, neither for access nor for the Admin's administrative
// acts. Until Lazurio Auth holds the role as Machines applies it from the
// Organization's Deployment Repo, this list in the Organization's root is
// where an agent reads who the appointed Admins are (`lazurio organization
// role`). It changes only by a reviewed pull request to the root. It is a
// pointer for agents, not a grant: it gives no entry, key or access, and it
// goes once the role in Lazurio Auth answers.
//
// The list is `[{ "github_id": "<n>", "github_login": "<login>" }]`. The
// GitHub id is the identity, written as a decimal string like every other id
// of the manifest (`organization_id`, `repository_id`, a Team's `id`); a JSON
// number is refused. The login is what people read and may go stale after a
// rename. An absent field, or an empty list, appoints no one. `parseCanonicalOrganization` accepts the field without judging it, so
// a malformed list never makes the Organization unusable; this module is its
// only reader, and a malformed list confirms no one as an Organization Admin.
// The schema's `$defs.organizationAdmins` states the same shape; the
// uniqueness of ids and logins and the bound of an id at 2^53 − 1 are checked
// only here (tests/organization-schema.test.ts).

import { githubLoginPattern } from "../content/model";

export type OrganizationAdmin = Readonly<{
  /** The account's numeric GitHub id (`id` of `GET /users/<login>`), read
   * from its decimal string. */
  githubId: number;
  /** Its login as the Organization wrote it. */
  githubLogin: string;
}>;

export type OrganizationAdmins =
  | Readonly<{
      /** `absent`: the field is not there, so no one is appointed. */
      status: "absent" | "declared";
      admins: readonly OrganizationAdmin[];
    }>
  | Readonly<{ status: "invalid"; admins: null; detail: string }>;

/** At most this many Admins; an Organization usually has one. */
export const organizationAdminsMax = 100;

/** A GitHub id as the manifest writes ids: decimal digits without a leading
 * zero; the reader also bounds it at `Number.MAX_SAFE_INTEGER`, so it reads
 * back as the exact number GitHub's API gives. */
const decimalId = /^[1-9][0-9]{0,15}$/;

const invalid = (detail: string): OrganizationAdmins =>
  Object.freeze({ status: "invalid", admins: null, detail });

/** The appointed Organization Admins of one parsed canonical Organization
 * manifest. */
export function organizationAdmins(
  manifest: Readonly<Record<string, unknown>>,
): OrganizationAdmins {
  if (!Object.hasOwn(manifest, "organization_admins"))
    return Object.freeze({ status: "absent", admins: Object.freeze([]) });
  const value = manifest.organization_admins;
  if (!Array.isArray(value))
    return invalid("organization_admins must be a list");
  if (value.length > organizationAdminsMax)
    return invalid(
      `organization_admins names more than ${organizationAdminsMax} Organization Admins`,
    );
  const admins: OrganizationAdmin[] = [];
  const ids = new Set<number>();
  const logins = new Set<string>();
  for (const [index, entry] of value.entries()) {
    const at = `organization_admins[${index}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      return invalid(`${at} must be an object`);
    const keys = Object.keys(entry);
    if (
      keys.length !== 2 ||
      !keys.includes("github_id") ||
      !keys.includes("github_login")
    )
      return invalid(`${at} must have exactly github_id and github_login`);
    const { github_id: id, github_login: login } = entry as Record<
      string,
      unknown
    >;
    if (
      typeof id !== "string" ||
      !decimalId.test(id) ||
      !Number.isSafeInteger(Number(id))
    )
      return invalid(
        `${at}.github_id must be a decimal string of a positive whole number up to ${Number.MAX_SAFE_INTEGER}`,
      );
    if (typeof login !== "string" || !githubLoginPattern.test(login))
      return invalid(`${at}.github_login must be a GitHub login`);
    const githubId = Number(id);
    if (ids.has(githubId))
      return invalid(`${at}.github_id ${id} is named more than once`);
    if (logins.has(login.toLowerCase()))
      return invalid(`${at}.github_login ${login} is named more than once`);
    ids.add(githubId);
    logins.add(login.toLowerCase());
    admins.push(Object.freeze({ githubId, githubLogin: login }));
  }
  return Object.freeze({ status: "declared", admins: Object.freeze(admins) });
}
