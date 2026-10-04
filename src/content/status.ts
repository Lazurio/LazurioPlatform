import type { CatalogOrganization } from "../organizations/catalog";
import { locatePersonalspace } from "../organizations/personalspace";
import type { GitHubViewer } from "./github";
import { type ContentHost, catalogOf, readFolderKind } from "./host";
import {
  type ContentItem,
  type ContentScope,
  type ContentStatus,
  contentScope,
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
  if (located.kind === "owner")
    return Object.freeze({
      kind: "personalspace",
      login,
      state: "present",
      ...(mismatch ? { reason: "github-identity-mismatch" } : {}),
    });
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
