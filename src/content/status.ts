import { basename } from "node:path";
import type { CatalogOrganization } from "../organizations/catalog";
import { locatePersonalspace } from "../organizations/personalspace";
import type { GitHubViewer } from "./github";
import { type ContentHost, catalogOf, readFolderKind } from "./host";
import {
  type ContentItem,
  type ContentScope,
  type ContentStatus,
  contentScope,
  sameRepository,
} from "./model";

// What this Environment should hold and what it holds now (`GET
// /api/content`). Reads only: the Folder's preset and catalog, the presence of
// the Personalspace, and gh's account; for an absent Personalspace one GitHub
// read says whether it exists there. Nothing is fetched, cloned or written.

/** The Personalspace repository of a GitHub account, by the naming the
 * resident Lazurio creates and checks (`<login>/<login>_GEN3`, local
 * directory `personalspace/<login>_GEN3`). */
export const personalspaceRepositoryName = (login: string) => `${login}_GEN3`;
export const personalspaceTemplate = "Lazurio/PersonalspaceTemplate_GEN3";

/** Whether the one directory in `personalspace/` is the viewer's own
 * Personalspace, as a clone would require (review of #183): named
 * `<login>_GEN3`, a checkout whose origin is `<login>/<login>_GEN3`, and that
 * repository on GitHub owned by the account and private. The one decision
 * for the install and for `GET /api/content`; anything else is refused with
 * its code. Reads only. */
export async function verifyPersonalspaceCheckout(
  directory: string,
  viewer: GitHubViewer,
  host: Pick<ContentHost, "git" | "github">,
): Promise<
  | Readonly<{ ok: true; repository: string }>
  | Readonly<{
      ok: false;
      code:
        | "personalspace-foreign"
        | "personalspace-not-owned"
        | "personalspace-public"
        | "github-unavailable";
      detail: string;
    }>
> {
  const name = personalspaceRepositoryName(viewer.login);
  const expected = `${viewer.login}/${name}`;
  const observed =
    basename(directory).toLowerCase() === name.toLowerCase()
      ? await host.git.inspect(directory)
      : null;
  if (
    observed?.kind !== "checkout" ||
    !sameRepository(observed.repository, expected)
  )
    return {
      ok: false,
      code: "personalspace-foreign",
      detail: `personalspace/ holds a checkout that is not ${expected}; it was left untouched`,
    };
  const answer = await host.github.repository(viewer.login, name);
  if (answer.kind === "unavailable")
    return {
      ok: false,
      code: "github-unavailable",
      detail: "GitHub did not answer for the Personalspace repository",
    };
  if (
    answer.kind === "missing" ||
    answer.repository.owner.databaseId !== viewer.databaseId
  )
    return {
      ok: false,
      code: "personalspace-not-owned",
      detail: `${expected} is not a repository owned by ${viewer.login}`,
    };
  if (!answer.repository.private)
    return {
      ok: false,
      code: "personalspace-public",
      detail: `${answer.repository.fullName} is public; a Personalspace must be private`,
    };
  return { ok: true, repository: answer.repository.fullName };
}

/** The Organizations of the catalog bound to `login` (case-insensitive, as
 * GitHub). */
export const organizationsOf = (
  organizations: readonly CatalogOrganization[],
  login: string,
) =>
  organizations.filter(
    (entry) => entry.forgeLogin?.toLowerCase() === login.toLowerCase(),
  );

function organizationItem(
  login: string,
  held: readonly CatalogOrganization[],
): ContentItem {
  if (held.length > 1)
    return Object.freeze({
      kind: "organization",
      login,
      state: "blocked",
      reason: "organization-ambiguous",
    });
  const [entry] = held;
  if (entry === undefined)
    return Object.freeze({ kind: "organization", login, state: "absent" });
  return Object.freeze({
    kind: "organization",
    login,
    ...(entry.displayName === null ? {} : { name: entry.displayName }),
    state: "present",
    ...(entry.reason === undefined ? {} : { reason: entry.reason }),
  });
}

/** Whether gh's account may hold this Environment's Personalspace: on a
 * personal Remote Environment only its owner's (the handover's GitHub id). */
export const viewerMayHold = (scope: ContentScope, viewer: GitHubViewer) =>
  !scope.allowed ||
  scope.personalOwner === null ||
  scope.personalOwner.githubId === viewer.databaseId;

async function personalspaceItem(
  folder: string,
  scope: ContentScope,
  host: ContentHost,
): Promise<ContentItem> {
  const located = await locatePersonalspace(folder);
  const answer = await host.github.viewer();
  const viewer = answer.kind === "signed-in" ? answer.viewer : null;
  const login = viewer?.login ?? null;
  if (located.kind === "blocked")
    return Object.freeze({
      kind: "personalspace",
      login,
      state: "blocked",
      reason: located.reason,
    });
  const mismatch = viewer !== null && !viewerMayHold(scope, viewer);
  if (located.kind === "owner") {
    // Present only when it is verifiably the account's own Personalspace,
    // the same decision as the install's: unverifiable or another account's
    // is blocked with the reason, never present.
    const verified =
      viewer === null || mismatch
        ? null
        : await verifyPersonalspaceCheckout(located.directory, viewer, host);
    if (verified?.ok === true)
      return Object.freeze({ kind: "personalspace", login, state: "present" });
    return Object.freeze({
      kind: "personalspace",
      login,
      state: "blocked",
      reason:
        verified !== null
          ? verified.code
          : mismatch
            ? "github-identity-mismatch"
            : answer.kind === "signed-out"
              ? "github-signed-out"
              : "github-unavailable",
    });
  }
  if (viewer === null || mismatch)
    return Object.freeze({
      kind: "personalspace",
      login,
      state: "absent",
      onGitHub: "unknown",
      ...(mismatch
        ? { reason: "github-identity-mismatch" }
        : {
            reason:
              answer.kind === "signed-out"
                ? "github-signed-out"
                : "github-unavailable",
          }),
    });
  const repository = await host.github.repository(
    viewer.login,
    personalspaceRepositoryName(viewer.login),
  );
  return Object.freeze({
    kind: "personalspace",
    login,
    state: "absent",
    onGitHub:
      repository.kind === "observed"
        ? "exists"
        : repository.kind === "missing"
          ? "missing"
          : "unknown",
  });
}

/** The content status of one Folder (see the module comment). */
export async function contentStatus(
  folder: string,
  host: ContentHost,
): Promise<ContentStatus> {
  let scope: ContentScope;
  try {
    const kind = await readFolderKind(folder);
    scope = contentScope(kind.preset, kind.machine);
  } catch {
    return Object.freeze({
      allowed: false,
      reason: "folder-unreadable",
      items: Object.freeze([]),
    });
  }
  if (!scope.allowed)
    return Object.freeze({
      allowed: false,
      reason: scope.reason,
      items: Object.freeze([]),
    });
  const items: ContentItem[] = [];
  if (scope.organizations !== "none") {
    const catalog = await catalogOf(host, folder);
    if (scope.organizations === "folder") {
      const logins = new Map<string, string>();
      for (const entry of catalog.organizations)
        if (entry.forgeLogin !== undefined)
          logins.set(entry.forgeLogin.toLowerCase(), entry.forgeLogin);
      for (const login of logins.values())
        items.push(
          organizationItem(
            login,
            organizationsOf(catalog.organizations, login),
          ),
        );
    } else {
      const login = scope.organizations.only;
      items.push(
        organizationItem(login, organizationsOf(catalog.organizations, login)),
      );
    }
  }
  if (scope.personalspace)
    items.push(await personalspaceItem(folder, scope, host));
  return Object.freeze({ allowed: true, items: Object.freeze(items) });
}
