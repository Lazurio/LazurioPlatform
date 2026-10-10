// Which Organization's sign-in a gh command or a Git request uses (decision
// F46): the owner of the repository it is about. The rules are those of the
// Team Environment's brokered gh (Lazurio/github-app `adapter/brokered-gh.mjs`)
// for selecting one repository — `--repo`/`-R`, `GH_REPO`, then the checkout's
// `origin`, and selectors that disagree are refused — with two additions a
// person's commands need, since one token serves a whole Organization instead
// of one repository: the endpoint of `gh api repos/<owner>/…`,
// `orgs/<owner>/…` or `user/memberships/orgs/<owner>`, the `owner` variable
// of a `gh api graphql` query (how Lazurio's own repository reads ask), and
// the repository or GitHub URL right after the subcommand (`gh repo clone
// <owner>/<repo>`, `gh pr view <url>`). A command that names none of these
// uses the owning Organization. Nothing here sends a request; GitHub decides
// what the chosen token may do.

const ownerPattern = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const repositoryPattern = /^[A-Za-z0-9_.-]{1,100}$/;

export class OwnerSelectionError extends Error {
  constructor(
    readonly reason: /** Two places name repositories of different owners. */
      | "selectors-disagree"
      /** A selector names another host than github.com. */
      | "host-not-github"
      /** A selector is not a repository. */
      | "selector-invalid",
  ) {
    super(`owner-${reason}`);
    this.name = "OwnerSelectionError";
  }
}

const isOwner = (value: string) => ownerPattern.test(value);

/** The owner of a GitHub remote URL (`https://github.com/O/R.git`,
 * `git@github.com:O/R.git`, `ssh://git@github.com/O/R.git`), or null for
 * anything else, another host included. */
export function ownerOfRemote(url: string): string | null {
  const value = url.trim();
  const scp = /^[A-Za-z0-9._-]+@([A-Za-z0-9.-]+):\/?([^/]+)\/([^/]+?)\/?$/.exec(
    value,
  );
  if (scp !== null) {
    const [, host = "", owner = "", repository = ""] = scp;
    return host.toLowerCase() === "github.com" &&
      isOwner(owner) &&
      repositoryPattern.test(repository)
      ? owner
      : null;
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (
    !["https:", "ssh:", "git+ssh:"].includes(parsed.protocol) ||
    parsed.hostname.toLowerCase() !== "github.com"
  )
    return null;
  const [owner = "", repository = ""] = parsed.pathname
    .replace(/^\/+/, "")
    .split("/");
  return isOwner(owner) && repositoryPattern.test(repository) ? owner : null;
}

/** The owner a `--repo`/`GH_REPO` value names: `OWNER/REPO`,
 * `github.com/OWNER/REPO` or a GitHub URL. Another host is refused: the
 * pilot serves github.com only. */
export function ownerOfSelector(value: string): string {
  const trimmed = value.trim();
  if (/^[a-z+]+:\/\/|^[^/@\s]+@[^/:\s]+:/i.test(trimmed)) {
    const owner = ownerOfRemote(trimmed);
    if (owner !== null) return owner;
    throw new OwnerSelectionError(
      /github\.com/i.test(trimmed) ? "selector-invalid" : "host-not-github",
    );
  }
  const parts = trimmed.replace(/\.git$/, "").split("/");
  if (parts.length === 3) {
    if ((parts[0] ?? "").toLowerCase() !== "github.com")
      throw new OwnerSelectionError("host-not-github");
    parts.shift();
  }
  const [owner = "", repository = ""] = parts;
  if (
    parts.length !== 2 ||
    !isOwner(owner) ||
    !repositoryPattern.test(repository)
  )
    throw new OwnerSelectionError("selector-invalid");
  return owner;
}

/** The owner a repository-shaped argument names, or null when it is not one
 * (a plain name, a number, a branch). */
function ownerOfArgument(value: string): string | null {
  if (/^https:\/\//i.test(value)) return ownerOfRemote(value);
  const parts = value.replace(/\.git$/, "").split("/");
  const [owner = "", repository = ""] = parts;
  return parts.length === 2 &&
    isOwner(owner) &&
    repositoryPattern.test(repository)
    ? owner
    : null;
}

/** The owner a `gh api` endpoint names: `repos/<owner>/…`,
 * `orgs/<owner>…` or `user/memberships/orgs/<owner>`, with or without the
 * leading slash or the API origin. A placeholder (`{owner}`) names none: gh
 * fills it from the checkout. */
export function ownerOfEndpoint(value: string): string | null {
  const match =
    /^(?:https:\/\/api\.github\.com)?\/?(?:repos|orgs|user\/memberships\/orgs)\/([^/?#]+)(?:[/?#]|$)/i.exec(
      value,
    );
  const owner = match?.[1];
  return owner !== undefined && isOwner(owner) ? owner : null;
}

// The `gh repo` subcommands whose first argument is a repository (`repo list`
// takes an owner).
const repositoryFirst = new Set([
  "archive",
  "clone",
  "create",
  "delete",
  "edit",
  "fork",
  "set-default",
  "sync",
  "unarchive",
  "view",
]);

// `-f owner=<login>`, `--raw-field owner=<login>` (or `-F`, `--field`, and
// the `=` forms) of a GraphQL query.
function graphqlOwner(args: readonly string[]): string | null {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] as string;
    let value: string | undefined;
    if (["-f", "-F", "--raw-field", "--field"].includes(argument))
      value = args[index + 1];
    else if (/^--(?:raw-)?field=/.test(argument))
      value = argument.slice(argument.indexOf("=") + 1);
    const owner = value?.startsWith("owner=") ? value.slice(6) : undefined;
    if (owner !== undefined && isOwner(owner)) return owner;
  }
  return null;
}

export type OwnerChoice = Readonly<{
  owner: string;
  source: "selector" | "argument";
}>;

/** The owner a gh command's own arguments and `GH_REPO` name, or null when
 * they name none (the caller then reads the checkout's `origin`, then uses
 * the owning Organization). Arguments after `--` belong to another program
 * (`gh repo clone O/R -- --depth 1`) and are never read. */
export function ownerOfGhCommand(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): OwnerChoice | null {
  const end = args.indexOf("--");
  const own = end === -1 ? [...args] : args.slice(0, end);
  const found: OwnerChoice[] = [];
  const repository = env.GH_REPO;
  if (repository !== undefined && repository.trim() !== "")
    found.push({ owner: ownerOfSelector(repository), source: "selector" });
  for (let index = 0; index < own.length; index += 1) {
    const argument = own[index] as string;
    let value: string | undefined;
    if (argument === "--repo" || argument === "-R") {
      value = own[index + 1];
      if (value === undefined)
        throw new OwnerSelectionError("selector-invalid");
      index += 1;
    } else if (argument.startsWith("--repo=")) value = argument.slice(7);
    else if (argument.startsWith("-R=")) value = argument.slice(3);
    if (value !== undefined)
      found.push({ owner: ownerOfSelector(value), source: "selector" });
  }
  const [command, subcommand, first] = own;
  if (command === "api") {
    let named: string | null = null;
    for (const argument of own.slice(1)) {
      named = ownerOfEndpoint(argument);
      if (named !== null) break;
    }
    if (named === null && own.includes("graphql")) named = graphqlOwner(own);
    if (named !== null) found.push({ owner: named, source: "argument" });
  } else if (first !== undefined && !first.startsWith("-")) {
    const owner =
      command === "repo" && subcommand === "list"
        ? isOwner(first)
          ? first
          : null
        : command === "repo" && repositoryFirst.has(subcommand ?? "")
          ? ownerOfArgument(first)
          : /^https:\/\/github\.com\//i.test(first)
            ? ownerOfRemote(first)
            : null;
    if (owner !== null) found.push({ owner, source: "argument" });
  }
  const chosen = found[0];
  if (chosen === undefined) return null;
  if (
    found.some(
      (entry) => entry.owner.toLowerCase() !== chosen.owner.toLowerCase(),
    )
  )
    throw new OwnerSelectionError("selectors-disagree");
  return Object.freeze(chosen);
}

/** The owner of a Git credential request's `path` (`OWNER/REPO.git`, sent
 * because the pilot sets `useHttpPath`), or null without one. */
export function ownerOfCredentialPath(path: string | undefined): string | null {
  if (path === undefined) return null;
  const owner = path.replace(/^\/+/, "").split("/")[0] ?? "";
  return isOwner(owner) ? owner : null;
}
