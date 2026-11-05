import { isAbsolute, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { ContentGitHub } from "../content/github";
import { type ContentHost, processGitHubHost } from "../content/host";
import { githubLoginPattern } from "../content/model";
import {
  type RootResolution,
  resolveOrganizationRootRepository,
} from "../content/organization-root";
import {
  type OrganizationRole,
  type RepositoryPermission,
  verifyOrganizationRole,
} from "../content/role";
import { type CliContext, operatorFolder } from "../update/cli";
import { type Catalog, readFolderCatalog } from "./catalog";
import { shown } from "./cli";

/** `lazurio organization role <Organization>` (#866): the live role of the
 * account gh is signed in with, from the same core that scopes `lazurio
 * content install` (`verifyOrganizationRole`, the root as
 * `resolveOrganizationRootRepository` finds it), and the Organization's
 * Admins, for the agent that must know whether its user is the Admin before
 * it does or prepares what only the Admin does (root decisions 0228, 0230).
 * GitHub is the source until Lazurio Auth holds the Admin role (0228); the
 * output keeps its shape when the source changes. */
export const roleHelp = `organization role <Organization> [--folder <absolute Folder>] [--json]
  The role GitHub confirms now in the Organization named by its GitHub login
  for the account gh is signed in with here: admin (an active Owner, the
  Organization Admin until the role in Lazurio Auth is deployed, root
  decision 0228), steward (maintain on the root repository), builder (write
  on it) or reader (an active member who reads it), and the Organization's
  Admins as GitHub lists its active Owners, without bot accounts. The root is
  the one the Folder holds, otherwise the one GitHub declares, as for content
  install; the Folder is --folder, otherwise the supervised unit's or the
  declared operator's, and without one only GitHub is asked. A role GitHub
  does not confirm is printed as not verified with the reason, and an agent
  then proceeds as for a member. Reads only. Exit status: 0 verified, 1 not
  verified, 2 usage.`;

export class RoleUsageError extends Error {}

const usage =
  "Usage: organization role <Organization> [--folder <Folder>] [--json]";

export type OrganizationRoleAnswer = Readonly<{
  kind: "organization-role";
  organization: string;
  /** The account gh works as here, when GitHub said. */
  login: string | null;
  role: OrganizationRole | null;
  verified: boolean;
  source: "github";
  /** `<owner>/<name>` of the root repository, when it was found. */
  rootRepository: string | null;
  /** The active Owners as GitHub lists them to this account, without bots;
   * absent when GitHub did not list any. */
  admins?: readonly string[];
  /** Why the role is not verified, or what was not found on the way. */
  detail?: string;
}>;

const rootRepositoryOf = (resolution: RootResolution) =>
  resolution.kind === "present" || resolution.kind === "resolved"
    ? resolution.repository
    : null;

/** Whether `repository` (`<owner>/<name>`) belongs to the Organization whose
 * GitHub login is `organization`. A root the Folder holds is whatever its
 * checkout's `origin` names, so its owner is checked before its permission
 * counts for this Organization's role. */
const belongsTo = (repository: string, organization: string) =>
  repository.split("/")[0]?.toLowerCase() === organization.toLowerCase();

const rootDetail = (resolution: RootResolution) =>
  resolution.kind === "failed"
    ? resolution.detail
    : resolution.kind === "ambiguous-in-folder"
      ? `the Folder holds more than one root of the Organization: ${resolution.directories.join(", ")}`
      : undefined;

/** The answer for one Organization: who gh is, the root, the permission on
 * it, the membership and the Owners. GitHub not answering never yields a
 * role (fail closed). */
export async function readOrganizationRole(
  input: Readonly<{
    organization: string;
    github: ContentGitHub;
    root: () => Promise<RootResolution>;
  }>,
): Promise<OrganizationRoleAnswer> {
  const { organization, github } = input;
  const answer = (
    fields: Omit<OrganizationRoleAnswer, "kind" | "organization" | "source">,
  ): OrganizationRoleAnswer =>
    Object.freeze({
      kind: "organization-role",
      organization,
      ...fields,
      source: "github",
    });
  const viewer = await github.viewer();
  if (viewer.kind !== "signed-in")
    return answer({
      login: null,
      role: null,
      verified: false,
      rootRepository: null,
      detail:
        viewer.kind === "signed-out"
          ? "gh is not signed in here"
          : "GitHub did not answer who gh works as here",
    });
  const resolution = await input.root();
  const named = rootRepositoryOf(resolution);
  // A root of another owner is no root of this Organization: its permission
  // names no role here, and the answer says why.
  const foreign =
    named !== null && !belongsTo(named, organization) ? named : null;
  const rootRepository = foreign === null ? named : null;
  let rootPermission: RepositoryPermission | null = null;
  if (rootRepository !== null) {
    const [owner, name] = rootRepository.split("/") as [string, string];
    const access = await github.repository(owner, name);
    if (access.kind === "observed" && access.repository.readable)
      rootPermission = access.repository.permission ?? "read";
  }
  const membership = await github.membership(organization);
  // The highest live role needs the Owner check: without the membership a
  // write or maintain on the root could be an Owner's, so no role is
  // confirmed (content install, which only scopes, takes the narrower role
  // from the same core).
  const role =
    membership.kind === "unavailable"
      ? ({
          kind: "unverified",
          detail:
            "GitHub did not answer the Organization membership, so whether the account is an Owner is not known",
        } as const)
      : verifyOrganizationRole({
          requested: null,
          membership,
          rootPermission,
        });
  const owners =
    github.owners === undefined
      ? "unavailable"
      : await github.owners(organization);
  const found =
    foreign === null
      ? rootDetail(resolution)
      : `the Folder's root of ${organization} is a checkout of ${foreign}, which does not belong to ${organization}`;
  const detail =
    role.kind === "unverified"
      ? found === undefined
        ? role.detail
        : `${role.detail}; ${found}`
      : found;
  return answer({
    login: viewer.viewer.login,
    role: role.kind === "verified" ? role.role : null,
    verified: role.kind === "verified",
    rootRepository,
    // An empty listing is what GitHub shows an account that may not see the
    // Owners, never a definitive "no Admins": the key is left out.
    ...(owners === "unavailable" || owners.length === 0
      ? {}
      : { admins: owners }),
    ...(detail === undefined ? {} : { detail }),
  });
}

const noOrganizations: Catalog = Object.freeze({
  kind: "catalog",
  organizations: Object.freeze([]),
});

export async function runOrganizationRoleCommand(
  args: string[],
  context: CliContext,
  // Test seams: gh and git of this process, and the catalog core.
  host: Pick<ContentHost, "github" | "git"> = processGitHubHost({
    env: context.env,
    platform: context.platform,
  }),
  readCatalog: (folder: string) => Promise<Catalog> = (folder) =>
    readFolderCatalog(folder),
): Promise<
  Readonly<{ code: number; result: OrganizationRoleAnswer; text: string }>
> {
  let values: { folder?: string | undefined; json?: boolean | undefined };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args,
      strict: true,
      allowPositionals: true,
      options: { folder: { type: "string" }, json: { type: "boolean" } },
    }));
  } catch (error) {
    throw new RoleUsageError(
      `${error instanceof Error ? error.message : String(error)}\n${usage}`,
    );
  }
  const [noun, verb, organization, ...rest] = positionals;
  if (
    noun !== "organization" ||
    verb !== "role" ||
    organization === undefined ||
    rest.length !== 0 ||
    !githubLoginPattern.test(organization) ||
    (values.folder !== undefined &&
      (!isAbsolute(values.folder) || resolve(values.folder) !== values.folder))
  )
    throw new RoleUsageError(usage);
  // Without a Folder, or with one that cannot be read, only GitHub is asked:
  // the role does not depend on the Folder, only where the root is found.
  const folder = values.folder ?? (await operatorFolder(context));
  const catalog =
    folder === undefined
      ? noOrganizations
      : await readCatalog(folder).catch(() => noOrganizations);
  const result = await readOrganizationRole({
    organization,
    github: host.github,
    root: () =>
      resolveOrganizationRootRepository({
        folder: folder ?? "/",
        login: organization,
        catalog,
        git: host.git,
        github: host.github,
      }),
  });
  // A detail can quote a directory name anyone could create in the Folder.
  const detail = result.detail === undefined ? undefined : shown(result.detail);
  const lines = [
    result.verified
      ? `${organization}: ${result.role} (GitHub, as ${result.login})`
      : `${organization}: role not verified${detail === undefined ? "" : ` (${detail})`}; proceed as for a member`,
    ...(result.verified && detail !== undefined ? [`  ${detail}`] : []),
    `  root: ${result.rootRepository ?? "not found"}`,
    `  Admins: ${result.admins === undefined ? "GitHub did not list them" : result.admins.length === 0 ? "none listed" : result.admins.join(", ")}`,
  ];
  return {
    code: result.verified ? 0 : 1,
    result,
    text: values.json === true ? JSON.stringify(result) : lines.join("\n"),
  };
}
