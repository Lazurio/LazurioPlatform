import { posix } from "node:path";
import { array } from "../modules/manifest";
import { organizationDocumentHash } from "./document-hash";

/** The root-level application slots of an Organization: beside its workspace
 * modules, each its own repository, and a module of the catalog when it
 * carries a `lazurio.module.json` (decision F24). The other root slots,
 * `infra` and `mission-control/db`, are repositories, never applications. */
export const rootApplicationPaths: ReadonlySet<string> = new Set([
  "design-system",
  "mission-control",
]);
const rootPaths = new Set([
  ...rootApplicationPaths,
  "infra",
  "mission-control/db",
]);
const mount = "[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9_-])?";
const direct = new RegExp(`^(workspace|modules|productionspace)/(${mount})$`);
const database = new RegExp(`^(workspace|modules)/(${mount})/db$`);
// A guest Module (root decision 0221, DEV-6694): a Module of another
// Organization, its home Organization, mounted in the host's `workspace/`
// below a folder named after that Organization's own mount
// (`<home_organization>_GEN3`), with its repository database child below it.
const login = "[A-Za-z0-9][A-Za-z0-9-]{0,38}";
const guest = new RegExp(`^workspace/(${login})_GEN3/(${mount})(/db)?$`);
const homeOrganization = new RegExp(`^${login}$`);
// The owner of a declared GitHub remote, in any of the forms a slot spells
// one (`git.url`, `repo`, `repository`, `repository_db.url`, or the bare
// `<owner>/<name>` of `repository_db.repo`).
const remoteOwner =
  /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)?([A-Za-z0-9][A-Za-z0-9-]{0,38})\/[A-Za-z0-9_.-]+?(?:\.git)?\/?$/;

// Broader document scope used for legacy projection, NOT executable mount validity.
export function organizationSlotArea(input: unknown) {
  if (
    typeof input !== "string" ||
    !input ||
    input.includes("\\") ||
    input.endsWith("/") ||
    /[\r\n\0]/.test(input) ||
    posix.normalize(input) !== input
  )
    return null;
  if (
    [...rootPaths].some(
      (root) => input === root || input.startsWith(`${root}/`),
    )
  )
    return "root";
  if (input === "productionspace" || input.startsWith("productionspace/"))
    return "productionspace";
  if (
    ["workspace", "modules"].some(
      (root) => input === root || input.startsWith(`${root}/`),
    )
  )
    return "workspace";
  return null;
}

export type RepositorySlotPath = Readonly<{
  path: string;
  scope: "root" | "workspace" | "productionspace";
  nestedDatabase: boolean;
  /** A guest slot's home Organization, exactly as declared. */
  home?: string;
}>;

// Exact repository-mount grammar, not general filesystem normalization. Never
// rewrite historical case/spelling or infer permission from a path or scope.
// With `home` (a slot's `home_organization`) only the guest grammar applies:
// `workspace/<home>_GEN3/<mount>` and its `/db` child, the middle segment
// exactly the home Organization's mount; without it a guest path stays
// unsupported, as `workspace/` stays flat for the host's own modules (0041).
export function classifyRepositorySlotPath(
  input: unknown,
  home?: unknown,
): RepositorySlotPath | null {
  if (
    typeof input !== "string" ||
    input.includes("\\") ||
    /[\r\n\0]/.test(input)
  )
    return null;
  if (home !== undefined) {
    const match = guest.exec(input);
    return typeof home === "string" &&
      homeOrganization.test(home) &&
      match !== null &&
      match[0] === input &&
      match[1] === home
      ? Object.freeze({
          path: input,
          scope: "workspace" as const,
          nestedDatabase: match[3] !== undefined,
          home,
        })
      : null;
  }
  if (rootPaths.has(input))
    return Object.freeze({
      path: input,
      scope: "root" as const,
      nestedDatabase: false,
    });
  const match = direct.exec(input);
  if (match && match[0] === input)
    return Object.freeze({
      path: input,
      scope:
        match[1] === "productionspace"
          ? ("productionspace" as const)
          : ("workspace" as const),
      nestedDatabase: false,
    });
  const db = database.exec(input);
  if (db && db[0] === input)
    return Object.freeze({
      path: input,
      scope: "workspace" as const,
      nestedDatabase: true,
    });
  return null;
}

// The owners of every remote a slot declares, null for one that names no
// GitHub repository.
function declaredRemoteOwners(declaration: Readonly<Record<string, unknown>>) {
  const record = (value: unknown) =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Readonly<Record<string, unknown>>)
      : {};
  const git = record(declaration.git);
  const database = record(declaration.repository_db);
  return [
    git.url,
    declaration.repo,
    declaration.repository,
    database.url,
    database.repo,
  ].flatMap((remote) =>
    typeof remote === "string"
      ? [remoteOwner.exec(remote.trim())?.[1] ?? null]
      : [],
  );
}

/** The declaration issues of a guest slot (DEV-6694), each quarantining
 * only that slot: `home_organization` that is no GitHub login, or the host
 * itself; a path that is not `workspace/<home>_GEN3/<mount>` (or its `/db`
 * child); a remote of another owner. */
export const guestSlotIssues = Object.freeze([
  "guest-home-organization-invalid",
  "guest-home-is-host",
  "guest-path-invalid",
  "guest-remote-owner-mismatch",
] as const);

type Issue = Readonly<{ code: string; indices: readonly number[] }>;
// Report implicated declaration indices so a later discovery consumer can quarantine
// conflicts without losing unrelated siblings. This is not an app/module catalog.
// `host` is the Organization's own GitHub login (`github_org`): a guest slot's
// home Organization is never the host itself.
export function inspectRepositorySlots(input: unknown, host?: string) {
  organizationDocumentHash(input);
  const declarations = array(input);
  const issues: Issue[] = [];
  const issue = (code: string, ...indices: number[]) =>
    issues.push(Object.freeze({ code, indices: Object.freeze(indices) }));
  const paths = new Map<
    string,
    { path: string; id: string | null; index: number }
  >();
  const ids = new Map<string, { path: string; index: number }>();
  const slots = declarations.map((input, index) => {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      issue("invalid-declaration", index);
      return null;
    }
    const declaration = input as Record<string, unknown>;
    let home: string | undefined;
    if (Object.hasOwn(declaration, "home_organization")) {
      const value = declaration.home_organization;
      if (typeof value !== "string" || !homeOrganization.test(value)) {
        issue("guest-home-organization-invalid", index);
        return null;
      }
      if (host !== undefined && value.toLowerCase() === host.toLowerCase()) {
        issue("guest-home-is-host", index);
        return null;
      }
      home = value;
    }
    const path = classifyRepositorySlotPath(declaration.path, home);
    if (!path) {
      issue(
        home === undefined ? "unsupported-path" : "guest-path-invalid",
        index,
      );
      return null;
    }
    // A guest's repository is its home Organization's, by every remote it
    // declares; a host slot's remote owner is not checked here.
    if (
      home !== undefined &&
      declaredRemoteOwners(declaration).some(
        (owner) => owner?.toLowerCase() !== home.toLowerCase(),
      )
    )
      issue("guest-remote-owner-mismatch", index);
    const fallback = path.path.split("/").at(-1);
    const candidate = Object.hasOwn(declaration, "slug")
      ? declaration.slug
      : path.nestedDatabase
        ? null
        : fallback;
    const id =
      typeof candidate === "string" &&
      candidate !== "root" &&
      /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(candidate) &&
      !/[\r\n]/.test(candidate)
        ? candidate
        : null;
    if (
      id === null &&
      (!path.nestedDatabase || Object.hasOwn(declaration, "slug"))
    )
      issue("invalid-repository-slug", index);
    const previous = paths.get(path.path.toLowerCase());
    if (previous)
      issue(
        previous.path !== path.path
          ? "path-case-collision"
          : previous.id !== id
            ? "path-identity-conflict"
            : "duplicate-path",
        previous.index,
        index,
      );
    else paths.set(path.path.toLowerCase(), { path: path.path, id, index });
    if (id !== null) {
      // A guest's identity is `<home_organization>/<slug>`: it never collides
      // with the host's own slugs, only with a guest of the same home.
      const key = home === undefined ? id : `${home.toLowerCase()}/${id}`;
      const previousId = ids.get(key);
      if (previousId) issue("repository-id-collision", previousId.index, index);
      else ids.set(key, { path: path.path, index });
    }
    return Object.freeze({ ...path, id, index });
  });
  // A guest's database child names its home in its path, so its parent at
  // exactly that path is a guest of the same home Organization.
  for (const slot of slots)
    if (slot?.nestedDatabase) {
      const parent = slot.path.slice(0, -3);
      if (paths.get(parent.toLowerCase())?.path !== parent)
        issue("repository-db-parent-missing", slot.index);
    }
  return Object.freeze({
    slots: Object.freeze(slots),
    issues: Object.freeze(issues),
  });
}
