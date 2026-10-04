import { join } from "node:path";
import type { Catalog } from "../organizations/catalog";
import type { ContentGit } from "./git";
import { repositoryPattern } from "./model";

// Where an Organization's ROOT repository is declared for a GitHub login.
// The Organization contract says the root is explicit, never derived as
// `<Owner>/<Owner>_GEN3` (docs/organization-contract.md). The explicit
// declaration, `root_repository.locator` of `lazurio.organization.json`,
// lives INSIDE the root, so it cannot name the root of an Organization this
// Environment does not hold yet; the Machine handover names only the
// Organization (`owner.organization`), and the workspace composition of the
// Dashboard (F33), which will name it (`root`), is not delivered. Until an
// owner decides which authority names an absent Organization's root, this
// resolver knows two answers and returns `needs-decision` for the rest:
// - `present`: the Folder already holds the Organization (its canonical
//   manifest binds this login); the root is that checkout;
// - `explicit`: the operator named `<owner>/<repository>` (the CLI's
//   `--root`, the B7 design's `organization add <org>/<root-repo>`); the
//   clone is then accepted only when its own declaration binds this login and,
//   when it declares `root_repository`, names exactly this repository.

export type RootOption = Readonly<{
  id: string;
  summary: string;
}>;

/** The options for the open decision, in the order of the recommendation
 * (docs/content-sync.md "Open decision: the root of an absent
 * Organization"). */
export const organizationRootOptions: readonly RootOption[] = Object.freeze([
  {
    id: "convention-confirmed-by-declaration",
    summary:
      "Recommended now: look up <login>/<login>_GEN3 as a candidate and accept it only when its own lazurio.organization.json binds the login and declares itself as root_repository; the declaration, not the name, is the authority.",
  },
  {
    id: "dashboard-composition",
    summary:
      "Target (F33): the Dashboard's workspace composition names each Organization's root (root.fullName, immutable id); replaces the candidate rule when delivered.",
  },
  {
    id: "machine-handover",
    summary:
      "Machines records the owning Organization's root repository in the work Environment's handover; covers work Environments only.",
  },
  {
    id: "github-self-declaration-scan",
    summary:
      "Scan the Organization's repositories for the one whose lazurio.organization.json declares itself as root; no name rule, one API read per repository.",
  },
  {
    id: "explicit-operator-input",
    summary:
      "The operator names <owner>/<repository> (implemented in the CLI as --root); the Launchpad would need a field for it.",
  },
]);

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
  | Readonly<{ kind: "explicit"; repository: string }>
  | Readonly<{ kind: "ambiguous"; directories: readonly string[] }>
  | Readonly<{ kind: "explicit-mismatch" }>
  | Readonly<{
      kind: "needs-decision";
      login: string;
      options: readonly RootOption[];
    }>;

/** The root repository of the Organization bound to GitHub `login`, as far
 * as it is declared to this Environment (see the module comment). `root` is
 * the operator's explicit `<owner>/<repository>`, when named. */
export async function resolveOrganizationRootRepository(
  input: Readonly<{
    folder: string;
    login: string;
    catalog: Catalog;
    git: ContentGit;
    root?: string | undefined;
  }>,
): Promise<RootResolution> {
  const login = input.login.toLowerCase();
  const held = input.catalog.organizations.filter(
    (entry) => entry.forgeLogin?.toLowerCase() === login,
  );
  if (held.length > 1)
    return Object.freeze({
      kind: "ambiguous",
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
  if (input.root !== undefined) {
    if (
      !repositoryPattern.test(input.root) ||
      input.root.split("/")[0]?.toLowerCase() !== login
    )
      return Object.freeze({ kind: "explicit-mismatch" });
    return Object.freeze({ kind: "explicit", repository: input.root });
  }
  return Object.freeze({
    kind: "needs-decision",
    login: input.login,
    options: organizationRootOptions,
  });
}
