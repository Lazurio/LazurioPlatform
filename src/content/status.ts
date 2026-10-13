import { lstat } from "node:fs/promises";
import { basename, join } from "node:path";
import { readStateJson } from "../folder/read-state";
import { parseFolderPreferences } from "../folder/state";
import type { CatalogOrganization } from "../organizations/catalog";
import {
  locatePersonalspace,
  type PersonalspaceHolder,
  type PersonalspaceHolderRead,
} from "../organizations/personalspace";
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
// Whose Personalspace it holds is one decision (`personalspaceHolder`, #186),
// which the catalog and the module lifecycle make too.

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

/** What the Folder says before GitHub is asked whose its Personalspace is:
 * decided already (none here, or a layout that is refused), or the one owner
 * directory with the Environment's scope and the identity of that checkout:
 * what a remembered decision is kept for. Reads the recorded preset and
 * Machine binding without the Folder lock, as the catalog reads them
 * (`folderHasPersonalspace`): a Folder whose state cannot be read has no
 * Personalspace. */
export type PersonalspaceLayout =
  | Readonly<{ kind: "decided"; holder: PersonalspaceHolder }>
  | Readonly<{
      kind: "owner";
      directory: string;
      scope: ContentScope;
      identity: string;
    }>;

const decided = (holder: PersonalspaceHolder): PersonalspaceLayout =>
  Object.freeze({ kind: "decided", holder });
const blockedBy = (
  reason: Extract<PersonalspaceHolder, { kind: "blocked" }>["reason"],
  login: string | null,
): PersonalspaceHolder => Object.freeze({ kind: "blocked", reason, login });

// Where a file is (its device and inode) and, with `changes`, its last
// change; "-" without one. Work in the checkout changes neither the owner
// directory's nor `.git`'s place; a checkout made again in place gets a new
// Git configuration, and another origin rewrites it.
const identityOf = (path: string, changes: boolean) =>
  lstat(path).then(
    (entry) =>
      changes
        ? `${entry.dev}:${entry.ino}:${entry.mtimeMs}:${entry.size}`
        : `${entry.dev}:${entry.ino}`,
    () => "-",
  );

/** The layout of `folder`'s Personalspace (see `PersonalspaceLayout`).
 * Never throws. */
export async function personalspaceLayout(
  folder: string,
): Promise<PersonalspaceLayout> {
  let scope: ContentScope;
  try {
    const preferences = parseFolderPreferences(
      await readStateJson(join(folder, ".lazurio"), "preferences.json"),
    );
    scope = contentScope(preferences.preset.name, preferences.machine);
  } catch {
    return decided({ kind: "absent" });
  }
  if (!scope.allowed || !scope.personalspace)
    return decided({ kind: "absent" });
  const located = await locatePersonalspace(folder);
  if (located.kind === "absent") return decided(located);
  if (located.kind === "blocked")
    return decided(blockedBy(located.reason, null));
  const git = join(located.directory, ".git");
  const identity = (
    await Promise.all([
      identityOf(located.directory, false),
      identityOf(git, false),
      identityOf(join(git, "config"), true),
    ])
  ).join("/");
  return Object.freeze({
    kind: "owner",
    directory: located.directory,
    scope,
    identity,
  });
}

/** Whether gh's account holds the owner directory `directory`: signed in,
 * the handover's Owner on a personal Remote Environment (`viewerMayHold`),
 * and the directory its own, private Personalspace
 * (`verifyPersonalspaceCheckout`). gh's account is asked first; GitHub is
 * asked about the repository only for a checkout of the account's own name
 * and origin. May throw when a process cannot run. */
export async function holderOfCheckout(
  directory: string,
  scope: ContentScope,
  host: Pick<ContentHost, "git" | "github">,
): Promise<PersonalspaceHolder> {
  const answer = await host.github.viewer();
  if (answer.kind !== "signed-in")
    return blockedBy(
      answer.kind === "signed-out" ? "github-signed-out" : "github-unavailable",
      null,
    );
  const { viewer } = answer;
  if (!viewerMayHold(scope, viewer))
    return blockedBy("github-identity-mismatch", viewer.login);
  const verified = await verifyPersonalspaceCheckout(directory, viewer, host);
  return verified.ok
    ? Object.freeze({ kind: "held", login: viewer.login, directory })
    : blockedBy(verified.code, viewer.login);
}

/** Whose Personalspace this Folder holds (Lazurio/LazurioPlatform#186,
 * decided by Matěj on 2026-10-05): the GitHub account this Environment's gh
 * is signed in with, when the one directory in `personalspace/` is that
 * account's own, private Personalspace; on a personal Remote Environment
 * that account must also be the handover's Owner. Signed out, GitHub
 * silent, another account's or an unverifiable checkout: blocked with the
 * reason, never held. The one decision of `GET /api/content`, the catalog
 * and the module lifecycle; the Launchpad and the CLI remember it a minute
 * (`createPersonalspaceHolder`). Reads only; never throws. */
export async function personalspaceHolder(
  folder: string,
  host: Pick<ContentHost, "git" | "github">,
): Promise<PersonalspaceHolder> {
  const layout = await personalspaceLayout(folder);
  if (layout.kind === "decided") return layout.holder;
  return holderOfCheckout(layout.directory, layout.scope, host).catch(() =>
    blockedBy("personalspace-unavailable", null),
  );
}

// The layout's own reasons: decided without asking GitHub.
const layoutReasons: ReadonlySet<string> = new Set([
  "personalspace-ambiguous",
  "personalspace-unavailable",
]);

async function personalspaceItem(
  folder: string,
  scope: ContentScope,
  host: ContentHost,
  holder: PersonalspaceHolderRead,
): Promise<ContentItem> {
  // Present only when it is verifiably the account's own Personalspace,
  // the same decision as the install's, the catalog's and the lifecycle's:
  // unverifiable or another account's is blocked with the reason.
  const decision = await holder(folder);
  if (decision.kind === "held")
    return Object.freeze({
      kind: "personalspace",
      login: decision.login,
      state: "present",
    });
  if (decision.kind === "blocked" && !layoutReasons.has(decision.reason))
    return Object.freeze({
      kind: "personalspace",
      login: decision.login,
      state: "blocked",
      reason: decision.reason,
    });
  // Decided by the layout alone: gh's account for the item, and for an
  // absent Personalspace whether GitHub has one.
  const answer = await host.github.viewer();
  const viewer = answer.kind === "signed-in" ? answer.viewer : null;
  const login = viewer?.login ?? null;
  if (decision.kind === "blocked")
    return Object.freeze({
      kind: "personalspace",
      login,
      state: "blocked",
      reason: decision.reason,
    });
  const mismatch = viewer !== null && !viewerMayHold(scope, viewer);
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

/** The content status of one Folder (see the module comment). Whose
 * Personalspace it holds comes from `holder`: by default decided now
 * through `host`, in the Launchpad its remembered decision, which its
 * catalog and module lifecycle share. */
export async function contentStatus(
  folder: string,
  host: ContentHost,
  holder: PersonalspaceHolderRead = (folder) =>
    personalspaceHolder(folder, host),
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
    items.push(await personalspaceItem(folder, scope, host, holder));
  return Object.freeze({ allowed: true, items: Object.freeze(items) });
}
