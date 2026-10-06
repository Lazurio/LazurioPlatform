import { join } from "node:path";
import { parseCanonicalOrganization } from "../organizations/canonical-manifest";
import type { Catalog } from "../organizations/catalog";
import type { ContentGit } from "./git";
import type { ContentGitHub } from "./github";
import { repositoryPattern, sameRepository } from "./model";

// Where an Organization's ROOT repository is, for a GitHub login (Matěj,
// 2026-10-05; root decision 0188): a name is never trusted, it is only a
// candidate, accepted after the repository declares itself the root. A
// repository declares itself the root of `login` when its own
// `lazurio.organization.json`, on its default branch as this Environment's
// gh reads it, is an Organization (not a template) whose
// `organization.forge_binding.locator` is `login` and whose
// `root_repository.locator` names exactly that repository. The install
// verifies the cloned commit once more before publishing it.
//
// The sources, in this order:
// - `explicit`: the operator named it (the CLI's `--root`);
// - `dashboard`: the Organization record of the Dashboard, fed by the
//   Organization's Lazurio for GitHub app installation: the TARGET source,
//   not wired yet (`dashboard` stays undefined until it is);
// - `name-candidate`: `<login>/<login>_GEN3`, the name the resident creates;
// - `scan`: the Organization's repositories this account can read, the one
//   that declares itself the root.
// A named source (`explicit`, `dashboard`) is authoritative about WHICH
// repository: when it does not declare itself the root, resolution fails
// (`root-declaration-mismatch`) instead of trying another. A discovery source
// that finds nothing passes to the next. The interim pair name-candidate and
// scan goes when the Dashboard source is wired; the verification stays.

export const rootSources = [
  "explicit",
  "dashboard",
  "name-candidate",
  "scan",
] as const;
export type RootSource = (typeof rootSources)[number];

/** How many repositories a scan reads at most, and at once. */
const scanLimit = 1_000;
const scanConcurrency = 8;

export type RootResolution =
  | Readonly<{
      kind: "present";
      /** The Organization root in the Folder. */
      directory: string;
      /** Its directory name under `organizations/`. */
      name: string;
      /** The catalog's slug of the Organization. */
      slug: string | null;
      /** `<owner>/<name>` of its `origin`, when it is a checkout of one. */
      repository: string | null;
    }>
  | Readonly<{ kind: "resolved"; source: RootSource; repository: string }>
  | Readonly<{ kind: "ambiguous-in-folder"; directories: readonly string[] }>
  | Readonly<{
      kind: "failed";
      code:
        | "root-owner-mismatch"
        | "root-declaration-mismatch"
        | "root-not-found"
        | "root-ambiguous"
        | "github-unavailable";
      detail: string;
      /** For `root-ambiguous`: every repository that declares itself. */
      candidates?: readonly string[];
    }>;

/** Whether a parsed `lazurio.organization.json` declares `repository` the
 * root of the Organization bound to `login`. */
export function declaresRoot(
  document: unknown,
  login: string,
  repository: string,
): boolean {
  try {
    const canonical = parseCanonicalOrganization(document) as Readonly<
      Record<string, unknown>
    >;
    if (canonical.kind !== "organization") return false;
    const organization = canonical.organization as Readonly<
      Record<string, Readonly<Record<string, unknown>>>
    >;
    const owner = organization.forge_binding?.locator;
    const root = (
      canonical.root_repository as Readonly<Record<string, unknown>> | null
    )?.locator;
    return (
      typeof owner === "string" &&
      owner.toLowerCase() === login.toLowerCase() &&
      typeof root === "string" &&
      sameRepository(root, repository)
    );
  } catch {
    return false;
  }
}

type Verdict = "declares" | "does-not-declare" | "unavailable";

async function verdict(
  github: ContentGitHub,
  login: string,
  repository: string,
): Promise<Verdict> {
  const [owner, name] = repository.split("/") as [string, string];
  const answer = await github.declaration(owner, name);
  if (answer.kind === "unavailable") return "unavailable";
  return answer.kind === "file" && declaresRoot(answer.value, login, repository)
    ? "declares"
    : "does-not-declare";
}

/** The root repository of the Organization bound to GitHub `login` (see
 * the module comment). `root` is the operator's explicit
 * `<owner>/<repository>`; `dashboard` the Dashboard's answer, once wired. */
export async function resolveOrganizationRootRepository(
  input: Readonly<{
    folder: string;
    login: string;
    catalog: Catalog;
    git: ContentGit;
    github: ContentGitHub;
    root?: string | undefined;
    dashboard?: (() => Promise<string | null>) | undefined;
  }>,
): Promise<RootResolution> {
  const { login, github } = input;
  const lower = login.toLowerCase();
  // An Organization the Folder already holds is its own root.
  const held = input.catalog.organizations.filter(
    (entry) => entry.forgeLogin?.toLowerCase() === lower,
  );
  if (held.length > 1)
    return Object.freeze({
      kind: "ambiguous-in-folder",
      directories: Object.freeze(held.map((entry) => entry.directory)),
    });
  const [entry] = held;
  if (entry !== undefined) {
    const directory = join(input.folder, "organizations", entry.directory);
    const observed = await input.git.inspect(directory);
    return Object.freeze({
      kind: "present",
      directory,
      name: entry.directory,
      slug: entry.organization,
      repository: observed.kind === "checkout" ? observed.repository : null,
    });
  }
  const failed = (
    code: Extract<RootResolution, { kind: "failed" }>["code"],
    detail: string,
    candidates?: readonly string[],
  ): RootResolution =>
    Object.freeze({
      kind: "failed",
      code,
      detail,
      ...(candidates === undefined ? {} : { candidates }),
    });
  const unavailable = () =>
    failed(
      "github-unavailable",
      "GitHub did not answer while the root repository was looked up",
    );

  // Named sources: authoritative about which repository, still verified.
  const named: [RootSource, () => Promise<string | null>][] = [
    ["explicit", async () => input.root ?? null],
    ["dashboard", input.dashboard ?? (async () => null)],
  ];
  for (const [source, ask] of named) {
    const repository = await ask();
    if (repository === null) continue;
    if (
      !repositoryPattern.test(repository) ||
      repository.split("/")[0]?.toLowerCase() !== lower
    )
      return failed(
        "root-owner-mismatch",
        `the named root must be <owner>/<repository> of ${login}`,
      );
    const answer = await verdict(github, login, repository);
    if (answer === "unavailable") return unavailable();
    if (answer === "does-not-declare")
      return failed(
        "root-declaration-mismatch",
        `${repository} does not declare itself the root of ${login} in its lazurio.organization.json`,
      );
    return Object.freeze({ kind: "resolved", source, repository });
  }

  // The name candidate.
  const candidate = `${login}/${login}_GEN3`;
  const byName = await verdict(github, login, candidate);
  if (byName === "unavailable") return unavailable();
  if (byName === "declares")
    return Object.freeze({
      kind: "resolved",
      source: "name-candidate",
      repository: candidate,
    });

  // The scan of what this account can read in the Organization.
  const listed = await github.organizationRepositories(login);
  if (listed === "unavailable") return unavailable();
  const repositories = listed
    .filter(
      (repository) =>
        repository.split("/")[0]?.toLowerCase() === lower &&
        !sameRepository(repository, candidate),
    )
    .slice(0, scanLimit);
  const matches: string[] = [];
  let unanswered = false;
  for (let start = 0; start < repositories.length; start += scanConcurrency) {
    const batch = repositories.slice(start, start + scanConcurrency);
    const answers = await Promise.all(
      batch.map((repository) => verdict(github, login, repository)),
    );
    answers.forEach((answer, index) => {
      if (answer === "declares") matches.push(batch[index] as string);
      if (answer === "unavailable") unanswered = true;
    });
  }
  if (matches.length > 1)
    return failed(
      "root-ambiguous",
      `more than one repository of ${login} declares itself the root: ${matches.join(", ")}`,
      Object.freeze(matches),
    );
  const [match] = matches;
  if (match !== undefined)
    return Object.freeze({
      kind: "resolved",
      source: "scan",
      repository: match,
    });
  // A repository GitHub did not answer for might be the root: not "none".
  if (unanswered) return unavailable();
  return failed(
    "root-not-found",
    `no repository of ${login} this account can read declares itself the root (${candidate} included)`,
  );
}
