import type { ToolsEnvironment } from "../tools/overview";
import { resolveOnPath } from "../tools/status";
import { githubLoginPattern, repositoryPattern } from "./model";
import type { MembershipAnswer, RepositoryPermission } from "./role";

// The GitHub side of content installation, through this Environment's own
// GitHub sign-in: gh's (decision F19), found on the operator's PATH and run
// with the operator's home, exactly as the Launchpad's other GitHub reads run
// it (`askGitHub`). An injectable interface, so the core is tested without a
// network. No token is read, printed or passed anywhere: gh holds it, and git
// gets gh as its credential helper only for an HTTPS remote.

export type GitHubViewer = Readonly<{
  login: string;
  /** The account's numeric id (`id` of `GET /user`). */
  databaseId: number;
}>;

export type ViewerAnswer =
  | Readonly<{ kind: "signed-in"; viewer: GitHubViewer }>
  | Readonly<{ kind: "signed-out" }>
  | Readonly<{ kind: "unavailable" }>;

export type GitHubRepository = Readonly<{
  /** `<owner>/<name>` as GitHub spells it now. */
  fullName: string;
  owner: Readonly<{ login: string; databaseId: number; kind: string }>;
  private: boolean;
  archived: boolean;
  /** Whether this identity may read it (`permissions.pull`). */
  readable: boolean;
  /** The highest permission this identity has on it, or null. */
  permission: RepositoryPermission | null;
}>;

export type RepositoryAnswer =
  | Readonly<{ kind: "observed"; repository: GitHubRepository }>
  /** GitHub answered 404: absent, or not visible to this identity. GitHub
   * does not say which, and neither does this. */
  | Readonly<{ kind: "missing" }>
  | Readonly<{ kind: "unavailable" }>;

export type DeclarationAnswer =
  | Readonly<{ kind: "file"; value: unknown }>
  /** 404: no such file, or the repository is absent or not readable. */
  | Readonly<{ kind: "missing" }>
  | Readonly<{ kind: "unavailable" }>;

export type ContentGitHub = Readonly<{
  /** Who gh works as on this Environment. */
  viewer(): Promise<ViewerAnswer>;
  repository(owner: string, name: string): Promise<RepositoryAnswer>;
  /** The viewer's membership in an Organization (an Owner is an active
   * `admin` membership). */
  membership(organization: string): Promise<MembershipAnswer>;
  /** The repository's `lazurio.organization.json` on its default branch,
   * parsed, as this identity can read it. */
  declaration(owner: string, name: string): Promise<DeclarationAnswer>;
  /** The Organization's repositories this identity can read, not archived,
   * as `<owner>/<name>`, or `unavailable`. */
  organizationRepositories(
    organization: string,
  ): Promise<readonly string[] | "unavailable">;
  /** The viewer's own repositories created from `template`, as
   * `<owner>/<name>`, or `unavailable`. */
  templateDerived(template: string): Promise<readonly string[] | "unavailable">;
  /** Creates `<owner>/<name>` from `template` as a private repository of
   * `owner`; the answer says whether GitHub created it private. */
  generate(
    template: string,
    owner: string,
    name: string,
    description: string,
  ): Promise<
    | Readonly<{ kind: "created"; private: boolean }>
    | Readonly<{ kind: "failed" }>
  >;
  /** Whether the repository's `main` branch exists (a generated repository
   * is filled asynchronously). */
  branchReady(owner: string, name: string): Promise<boolean>;
  /** The Git remote of a repository for this sign-in: SSH when gh's
   * `git_protocol` is `ssh`, otherwise HTTPS with gh as the credential
   * helper, as `gh repo clone` and `gh auth setup-git` do. */
  remote(fullName: string): Promise<
    Readonly<{
      url: string;
      /** For HTTPS: git's `credential.helper` value for github.com. */
      credentialHelper?: string;
    }>
  >;
}>;

const timeoutMs = 20_000;

type GhAnswer =
  | Readonly<{ kind: "ok"; stdout: string }>
  | Readonly<{
      kind: "error";
      exitCode: number;
      status: string | null;
      stdout: string;
    }>
  | Readonly<{ kind: "unavailable" }>;

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** The `status` of a GitHub API error document gh prints on stdout
 * (`{"message":"Not Found",…,"status":"404"}`), when it is one. */
function errorStatus(stdout: string): string | null {
  try {
    const status = record(JSON.parse(stdout))?.status;
    return typeof status === "string" && /^[0-9]{3}$/.test(status)
      ? status
      : null;
  } catch {
    return null;
  }
}

export function parseViewer(stdout: string): GitHubViewer | null {
  try {
    const value = record(JSON.parse(stdout));
    const login = value?.login;
    const id = value?.id;
    if (
      typeof login !== "string" ||
      !githubLoginPattern.test(login) ||
      typeof id !== "number" ||
      !Number.isSafeInteger(id) ||
      id < 1
    )
      return null;
    return Object.freeze({ login, databaseId: id });
  } catch {
    return null;
  }
}

const permissionOrder: readonly [string, RepositoryPermission][] = [
  ["admin", "admin"],
  ["maintain", "maintain"],
  ["push", "write"],
  ["triage", "triage"],
  ["pull", "read"],
];

/** The highest permission REST's `permissions` object grants, or null. */
function highestPermission(
  permissions: Record<string, unknown> | null,
): RepositoryPermission | null {
  for (const [field, permission] of permissionOrder)
    if (permissions?.[field] === true) return permission;
  return null;
}

/** `GET /user/memberships/orgs/<org>`, as `organization-owner.ts` reads it. */
export function parseMembership(stdout: string): MembershipAnswer {
  try {
    const value = record(JSON.parse(stdout));
    const state = value?.state;
    const role = value?.role;
    if (
      (state !== "active" && state !== "pending") ||
      (role !== "admin" && role !== "member")
    )
      return { kind: "unavailable" };
    return Object.freeze({ kind: "member", state, role });
  } catch {
    return { kind: "unavailable" };
  }
}

export function parseRepository(stdout: string): GitHubRepository | null {
  try {
    const value = record(JSON.parse(stdout));
    const owner = record(value?.owner);
    const permissions = record(value?.permissions);
    const fullName = value?.full_name;
    if (
      typeof fullName !== "string" ||
      !repositoryPattern.test(fullName) ||
      owner === null ||
      typeof owner.login !== "string" ||
      !githubLoginPattern.test(owner.login) ||
      typeof owner.id !== "number" ||
      !Number.isSafeInteger(owner.id) ||
      typeof owner.type !== "string" ||
      typeof value?.private !== "boolean" ||
      typeof value?.archived !== "boolean"
    )
      return null;
    return Object.freeze({
      fullName,
      owner: Object.freeze({
        login: owner.login,
        databaseId: owner.id,
        kind: owner.type,
      }),
      private: value.private,
      archived: value.archived,
      // A public repository answers without `permissions` to an anonymous
      // reader only; a signed-in gh always gets them.
      readable: permissions?.pull === true,
      permission: highestPermission(permissions),
    });
  } catch {
    return null;
  }
}

/** gh on this Environment, as the Launchpad's other GitHub reads run it. */
export function ghContentGitHub(
  environment: ToolsEnvironment,
  options: Readonly<{ sleep?: (ms: number) => Promise<void> }> = {},
): ContentGitHub {
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let located: Promise<string | undefined> | undefined;
  const gh = () => {
    located ??= resolveOnPath("gh", environment.path, environment.platform);
    return located;
  };
  const env = () => {
    const value: Record<string, string> = {
      GH_PROMPT_DISABLED: "1",
      GH_NO_UPDATE_NOTIFIER: "1",
      NO_COLOR: "1",
    };
    if (environment.home) value.HOME = environment.home;
    if (environment.path) value.PATH = environment.path;
    for (const [name, entry] of Object.entries(environment.xdg ?? {}))
      value[name] = entry;
    return value;
  };
  const run = async (args: readonly string[]): Promise<GhAnswer> => {
    const executable = await gh();
    if (executable === undefined || !environment.home)
      return { kind: "unavailable" };
    try {
      const result = await environment.run(
        [executable, ...args],
        timeoutMs,
        env(),
      );
      if (result === "timeout") return { kind: "unavailable" };
      if (result.exitCode === 0) return { kind: "ok", stdout: result.stdout };
      return {
        kind: "error",
        exitCode: result.exitCode,
        status: errorStatus(result.stdout),
        stdout: result.stdout,
      };
    } catch {
      return { kind: "unavailable" };
    }
  };
  const repositoryPath = (owner: string, name: string) => {
    const fullName = `${owner}/${name}`;
    if (!repositoryPattern.test(fullName))
      throw new Error("Invalid repository coordinate");
    return `repos/${fullName}`;
  };
  return Object.freeze({
    async viewer(): Promise<ViewerAnswer> {
      const answer = await run(["api", "user"]);
      if (answer.kind === "ok") {
        const viewer = parseViewer(answer.stdout);
        return viewer === null
          ? { kind: "unavailable" }
          : { kind: "signed-in", viewer };
      }
      // gh exits 4 when it has no sign-in; GitHub answers 401 to a revoked one.
      if (
        answer.kind === "error" &&
        (answer.exitCode === 4 || answer.status === "401")
      )
        return { kind: "signed-out" };
      return { kind: "unavailable" };
    },
    async repository(owner, name): Promise<RepositoryAnswer> {
      const answer = await run(["api", repositoryPath(owner, name)]);
      if (answer.kind === "ok") {
        const repository = parseRepository(answer.stdout);
        return repository === null
          ? { kind: "unavailable" }
          : { kind: "observed", repository };
      }
      if (answer.kind === "error" && answer.status === "404")
        return { kind: "missing" };
      return { kind: "unavailable" };
    },
    async membership(organization): Promise<MembershipAnswer> {
      if (!githubLoginPattern.test(organization))
        return { kind: "unavailable" };
      const answer = await run([
        "api",
        `user/memberships/orgs/${organization}`,
      ]);
      if (answer.kind === "ok") return parseMembership(answer.stdout);
      // 404: not a member (or the membership is hidden from this token).
      if (answer.kind === "error" && answer.status === "404")
        return { kind: "none" };
      return { kind: "unavailable" };
    },
    async declaration(owner, name): Promise<DeclarationAnswer> {
      // The raw file of the default branch; bounded by the runner.
      const answer = await run([
        "api",
        "--header",
        "Accept: application/vnd.github.raw+json",
        `${repositoryPath(owner, name)}/contents/lazurio.organization.json`,
      ]);
      if (answer.kind === "ok") {
        try {
          return { kind: "file", value: JSON.parse(answer.stdout) };
        } catch {
          return { kind: "file", value: null };
        }
      }
      if (answer.kind === "error" && answer.status === "404")
        return { kind: "missing" };
      return { kind: "unavailable" };
    },
    async organizationRepositories(organization) {
      if (!githubLoginPattern.test(organization)) return "unavailable";
      const answer = await run([
        "api",
        "--paginate",
        `orgs/${organization}/repos?per_page=100&type=all`,
        "--jq",
        ".[] | select(.archived | not) | .full_name",
      ]);
      if (answer.kind !== "ok") return "unavailable";
      const names = answer.stdout.split("\n").filter((line) => line !== "");
      return names.every((name) => repositoryPattern.test(name))
        ? Object.freeze(names)
        : "unavailable";
    },
    async templateDerived(template) {
      if (!repositoryPattern.test(template)) return "unavailable";
      const answer = await run([
        "api",
        "graphql",
        "--paginate",
        "--raw-field",
        "query=query($endCursor:String){viewer{repositories(ownerAffiliations:OWNER,first:100,after:$endCursor){nodes{nameWithOwner templateRepository{nameWithOwner}} pageInfo{hasNextPage endCursor}}}}",
        "--jq",
        ".data.viewer.repositories.nodes[] | select(.templateRepository != null) | [.nameWithOwner, .templateRepository.nameWithOwner] | @tsv",
      ]);
      if (answer.kind !== "ok") return "unavailable";
      const derived: string[] = [];
      for (const line of answer.stdout.split("\n")) {
        if (line === "") continue;
        const [name, source] = line.split("\t");
        if (
          name === undefined ||
          source === undefined ||
          !repositoryPattern.test(name)
        )
          return "unavailable";
        if (source.toLowerCase() === template.toLowerCase()) derived.push(name);
      }
      return Object.freeze(derived);
    },
    async generate(template, owner, name, description) {
      const answer = await run([
        "api",
        "--method",
        "POST",
        `${repositoryPath(...(template.split("/") as [string, string]))}/generate`,
        "--raw-field",
        `owner=${owner}`,
        "--raw-field",
        `name=${name}`,
        "--raw-field",
        `description=${description}`,
        "--field",
        "private=true",
        "--field",
        "include_all_branches=false",
      ]);
      if (answer.kind !== "ok") return { kind: "failed" };
      const repository = parseRepository(answer.stdout);
      return repository === null
        ? { kind: "failed" }
        : { kind: "created", private: repository.private };
    },
    async branchReady(owner, name) {
      // Generation fills the repository asynchronously; wait a bounded time.
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const answer = await run([
          "api",
          `${repositoryPath(owner, name)}/branches/main`,
        ]);
        if (answer.kind === "ok") return true;
        if (answer.kind === "unavailable") return false;
        await sleep(1_000);
      }
      return false;
    },
    async remote(fullName) {
      if (!repositoryPattern.test(fullName))
        throw new Error("Invalid repository coordinate");
      const protocol = await run([
        "config",
        "get",
        "git_protocol",
        "--host",
        "github.com",
      ]);
      if (protocol.kind === "ok" && protocol.stdout.trim() === "ssh")
        return { url: `git@github.com:${fullName}.git` };
      const executable = await gh();
      return {
        url: `https://github.com/${fullName}.git`,
        ...(executable === undefined
          ? {}
          : {
              credentialHelper: `!${JSON.stringify(executable)} auth git-credential`,
            }),
      };
    },
  });
}
