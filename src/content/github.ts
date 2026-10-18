import { parse } from "node:path";
import { ghStatus } from "../tools/gh-status";
import type { ToolsEnvironment } from "../tools/overview";
import { resolveOnPath } from "../tools/status";
import { githubLoginPattern, repositoryPattern } from "./model";
import type { MembershipAnswer, RepositoryPermission } from "./role";

// The GitHub side of content installation, through this Environment's own
// GitHub sign-in: gh's (decision F19), found on the operator's PATH and run
// with the operator's home, exactly as the Launchpad's other GitHub reads run
// it (`askGitHub`). An injectable interface, so the core is tested without a
// network. No token is read, printed or passed anywhere: gh holds it, and git
// gets gh as its credential helper only for an HTTPS remote. A public
// Environment has none of it (`anonymousGitHub`).
//
// On a Team Environment the gh found there is the Organization's brokered gh
// (Lazurio/github-app `adapter/brokered-gh.mjs`, which Machines installs as
// `/usr/local/bin/gh`, #488): GitHub's App identity Lazurio for GitHub, with a
// token minted for exactly one repository per command. Every call here speaks
// its contract, which a person's gh takes just as well: gh runs outside any
// checkout (the filesystem root), so no checkout's origin picks the
// repository; a read of one repository names it in `GH_REPO`; the adapter's
// refusals, which carry no API status, are read by their words; and an HTTPS
// clone keeps git's own configured credential helper wherever gh is that App
// identity (`remote`), because the adapter refuses every `gh auth` command
// and the hosting points git's helper at the same broker.

export type GitHubViewer = Readonly<{
  login: string;
  /** The account's numeric id (`id` of `GET /user`). */
  databaseId: number;
  /** The profile's name (`name` of `GET /user`), when the account set one. */
  name?: string;
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

/** A Team as GitHub names it: its slug and its numeric id. */
export type GitHubTeam = Readonly<{ slug: string; databaseId: number }>;

export type TeamAnswer =
  | Readonly<{ kind: "observed"; team: GitHubTeam }>
  /** 404: no such Team, or one this identity cannot see. */
  | Readonly<{ kind: "missing" }>
  | Readonly<{ kind: "unavailable" }>;

/** The repository permissions a Team grant names (REST's `permission`). */
export type TeamPermission = "pull" | "triage" | "push" | "maintain" | "admin";

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
  /** Creates the empty private repository `name` of the account gh is
   * signed in with (`POST /user/repos`), or, given an `organization`, of
   * that Organization (`POST /orgs/<organization>/repos`): no README, no
   * license, no template. The answer is GitHub's account of the repository
   * it created, which the caller verifies (decision F52). */
  createRepository(
    name: string,
    description: string,
    organization?: string,
  ): Promise<
    | Readonly<{ kind: "created"; repository: GitHubRepository }>
    | Readonly<{ kind: "failed" }>
  >;
  /** An Organization's Team by its slug (`GET orgs/<org>/teams/<slug>`), as
   * this identity can see it. */
  team(organization: string, slug: string): Promise<TeamAnswer>;
  /** Grants a Team `permission` on a repository of its Organization (`PUT
   * orgs/<org>/teams/<team>/repos/<owner>/<name>`) and reads the grant back;
   * `granted` only when GitHub then answers that the Team reaches it with
   * that permission. */
  grantTeam(
    organization: string,
    team: string,
    fullName: string,
    permission: TeamPermission,
  ): Promise<"granted" | "failed">;
  /** The Git remote of a repository for this sign-in: SSH when gh's
   * `git_protocol` is `ssh`, otherwise HTTPS with gh as the credential
   * helper, as `gh repo clone` and `gh auth setup-git` do; where gh is a
   * GitHub App's identity (a Team Environment's brokered gh), HTTPS with
   * git's own configured helper (no `credentialHelper`). */
  remote(fullName: string): Promise<
    Readonly<{
      url: string;
      /** For HTTPS: git's `credential.helper` value for github.com. */
      credentialHelper?: string;
    }>
  >;
}>;

/** GitHub on a public Environment (root decision 0204 point 5, decision F55's
 * addendum of 2026-10-17), which has no identity at all: no gh account, no
 * App, no token. Reader-only by its shape: its one capability is where a
 * public repository is read, `https://github.com/<owner>/<repository>.git`
 * with the empty credential helper, which makes the git adapter clone it
 * isolated from every configuration, credential and helper
 * (`anonymousGitEnvironment`), so a clone carries nothing of anyone and
 * GitHub answers it as it answers anyone. It reads nothing of GitHub's API
 * and has nothing that creates, grants or pushes. */
export const anonymousGitHub = Object.freeze({
  remote(fullName: string): Readonly<{ url: string; credentialHelper: "" }> {
    if (!repositoryPattern.test(fullName))
      throw new Error("Invalid repository coordinate");
    return Object.freeze({
      url: `https://github.com/${fullName}.git`,
      credentialHelper: "",
    });
  },
});

const timeoutMs = 20_000;

// The name of a repository GitHub accepts (as `repositoryPattern`'s).
const repositoryNamePattern = /^[A-Za-z0-9_.-]{1,100}$/;

type GhAnswer =
  | Readonly<{ kind: "ok"; stdout: string }>
  | Readonly<{
      kind: "error";
      exitCode: number;
      status: string | null;
      stdout: string;
      stderr: string;
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
    const name =
      typeof value?.name === "string"
        ? [...value.name]
            .filter((character) => character >= " " && character !== "\u007f")
            .join("")
            .trim()
            .slice(0, 200)
        : "";
    return Object.freeze({
      login,
      databaseId: id,
      ...(name === "" ? {} : { name }),
    });
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

/** Whether a Team Environment's brokered gh refused a repository as not this
 * Team's (its stderr, `Brokered gh failed closed: <why>`, exit 1, no API
 * status): the broker mints only for a repository of its Organization on
 * which the Team holds a grant, and answers anything else "refused the
 * request"; without a repository named it has none to mint for. Every other
 * refusal of the adapter (the broker not reachable, an invalid answer, its
 * configuration missing) is GitHub not answering now. */
export function brokeredRefusalDenies(stderr: string): boolean {
  return /^Brokered gh failed closed: (?:GitHub token broker refused the request|run gh inside a Team repository checkout)/m.test(
    stderr,
  );
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

// A Team's slug as GitHub forms it: lowercase letters, digits and hyphens.
const teamSlugPattern = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/;

/** `GET orgs/<org>/teams/<slug>`: the Team's slug and id. */
export function parseTeam(stdout: string): GitHubTeam | null {
  try {
    const value = record(JSON.parse(stdout));
    const slug = value?.slug;
    const id = value?.id;
    if (
      typeof slug !== "string" ||
      !teamSlugPattern.test(slug) ||
      typeof id !== "number" ||
      !Number.isSafeInteger(id) ||
      id < 1
    )
      return null;
    return Object.freeze({ slug, databaseId: id });
  } catch {
    return null;
  }
}

// Whether a read permission covers the one a grant named.
const grantOrder: readonly RepositoryPermission[] = [
  "read",
  "triage",
  "write",
  "maintain",
  "admin",
];
const grantNames: Readonly<Record<TeamPermission, RepositoryPermission>> = {
  pull: "read",
  triage: "triage",
  push: "write",
  maintain: "maintain",
  admin: "admin",
};
function reaches(
  permission: RepositoryPermission | null,
  granted: TeamPermission,
): boolean {
  return (
    permission !== null &&
    grantOrder.indexOf(permission) >= grantOrder.indexOf(grantNames[granted])
  );
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
  // Outside any checkout, so the brokered gh takes its repository from
  // `GH_REPO` alone, never from the origin of the directory this process
  // happens to run in (the Folder, a module an agent works in).
  const outside = (home: string) => parse(home).root;
  const run = async (
    args: readonly string[],
    extra: Readonly<Record<string, string>> = {},
  ): Promise<GhAnswer> => {
    const executable = await gh();
    if (executable === undefined || !environment.home)
      return { kind: "unavailable" };
    try {
      const result = await environment.run(
        [executable, ...args],
        timeoutMs,
        { ...env(), ...extra },
        { cwd: outside(environment.home) },
      );
      if (result === "timeout") return { kind: "unavailable" };
      if (result.exitCode === 0) return { kind: "ok", stdout: result.stdout };
      return {
        kind: "error",
        exitCode: result.exitCode,
        status: errorStatus(result.stdout),
        stdout: result.stdout,
        stderr: result.stderr,
      };
    } catch {
      return { kind: "unavailable" };
    }
  };
  // Whether gh works here as a GitHub App's identity (Lazurio for GitHub
  // through the Organization's broker), as its sign-in probe reads it: the
  // one `gh auth` command the brokered gh answers.
  const appIdentity = async () => {
    const executable = await gh();
    const home = environment.home;
    if (executable === undefined || !home) return false;
    const status = await ghStatus(
      (command, ms) =>
        environment.run(command, ms, env(), { cwd: outside(home) }),
      executable,
      timeoutMs,
    );
    return status.signIn.identity === "app";
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
      // The repository named to gh, as the brokered gh needs it (a person's
      // gh ignores it for an explicit path).
      const answer = await run(["api", repositoryPath(owner, name)], {
        GH_REPO: `${owner}/${name}`,
      });
      if (answer.kind === "ok") {
        const repository = parseRepository(answer.stdout);
        if (repository === null) return { kind: "unavailable" };
        // `permissions` describe a user. An App installation's token gets
        // them all false even with write, and GitHub answers a repository
        // at all only to an identity that may read it (404 otherwise): for
        // the App identity the answer is the read.
        return repository.readable || !(await appIdentity())
          ? { kind: "observed", repository }
          : {
              kind: "observed",
              repository: Object.freeze({ ...repository, readable: true }),
            };
      }
      if (
        answer.kind === "error" &&
        (answer.status === "404" || brokeredRefusalDenies(answer.stderr))
      )
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
      // 404: no such Organization visible to this account, so none of its
      // repositories either.
      if (answer.kind === "error" && answer.status === "404")
        return Object.freeze([]);
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
    async createRepository(name, description, organization) {
      if (
        !repositoryNamePattern.test(name) ||
        (organization !== undefined && !githubLoginPattern.test(organization))
      )
        return { kind: "failed" };
      const answer = await run([
        "api",
        "--method",
        "POST",
        organization === undefined
          ? "user/repos"
          : `orgs/${organization}/repos`,
        "--raw-field",
        `name=${name}`,
        "--raw-field",
        `description=${description}`,
        "--field",
        "private=true",
        "--field",
        "auto_init=false",
      ]);
      if (answer.kind !== "ok") return { kind: "failed" };
      const repository = parseRepository(answer.stdout);
      return repository === null
        ? { kind: "failed" }
        : { kind: "created", repository };
    },
    async team(organization, slug) {
      if (!githubLoginPattern.test(organization) || !teamSlugPattern.test(slug))
        return { kind: "unavailable" };
      const answer = await run(["api", `orgs/${organization}/teams/${slug}`]);
      if (answer.kind === "ok") {
        const team = parseTeam(answer.stdout);
        return team === null
          ? { kind: "unavailable" }
          : { kind: "observed", team };
      }
      if (answer.kind === "error" && answer.status === "404")
        return { kind: "missing" };
      return { kind: "unavailable" };
    },
    async grantTeam(organization, team, fullName, permission) {
      if (
        !githubLoginPattern.test(organization) ||
        !teamSlugPattern.test(team) ||
        !repositoryPattern.test(fullName)
      )
        return "failed";
      const path = `orgs/${organization}/teams/${team}/repos/${fullName}`;
      const put = await run([
        "api",
        "--method",
        "PUT",
        path,
        "--raw-field",
        `permission=${permission}`,
      ]);
      if (put.kind !== "ok") return "failed";
      // Read back: the repository as the Team reaches it, with the Team's
      // permissions on it.
      const read = await run([
        "api",
        "--header",
        "Accept: application/vnd.github.v3.repository+json",
        path,
      ]);
      if (read.kind !== "ok") return "failed";
      const repository = parseRepository(read.stdout);
      return repository !== null &&
        repository.fullName.toLowerCase() === fullName.toLowerCase() &&
        reaches(repository.permission, permission)
        ? "granted"
        : "failed";
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
      const url = `https://github.com/${fullName}.git`;
      // The App identity of a Team Environment: git's configured helper,
      // which the hosting points at the broker for exactly this repository
      // (`useHttpPath`); gh's would be refused, and resetting the list would
      // drop the broker's.
      if (await appIdentity()) return { url };
      const executable = await gh();
      return {
        url,
        ...(executable === undefined
          ? {}
          : {
              credentialHelper: `!${JSON.stringify(executable)} auth git-credential`,
            }),
      };
    },
  });
}
