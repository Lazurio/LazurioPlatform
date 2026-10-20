import { join } from "node:path";
import type { TeamPermission } from "../content/github";
import { inspectCheckoutDirectory } from "../folder/owned-directory";
import type { PresetName } from "../folder/presets";
import { readStateJson } from "../folder/read-state";
import { parseFolderPreferences } from "../folder/state";
import { type Catalog, readFolderCatalog } from "../organizations/catalog";
import {
  type CatalogOrganizationSelection,
  selectCatalogOrganization,
} from "../organizations/catalog-selection";
import { organizationModulesIndexPath } from "../organizations/modules-index";
import { organizationDocumentFiles } from "../organizations/read-documents";
import { readCheckoutFileBytes } from "../providers/owned-json";
import {
  absent,
  confirmCommand,
  folderLeasePorts,
  locateTaskWorktree,
  type ModuleCreateHost,
  ModuleCreateRefusal,
  type ModuleCreateReport,
  type ModuleCreateRequest,
  occupied,
  planData,
  planDigest,
  type TaskWorktree,
} from "./module-create";
import {
  declareOrganizationSlots,
  type OrganizationDocumentTexts,
} from "./organization-declaration";
import {
  assertSlug,
  assertStack,
  defaultScaffoldVersions,
  environmentPorts,
  ModuleScaffoldError,
  type ModuleScaffoldPlan,
  type PortPool,
  personalModulePortPool,
  planModuleScaffold,
  scaffoldBunVersion,
} from "./scaffold";
import { moduleTemplates } from "./scaffold-templates";

// `lazurio module create <Organization>/<slug>` (decision F52's addendum of
// 2026-10-14; Lazurio/LazurioPlatform#267): a module of an Organization of
// this Folder, in a private repository `<GitHub login>/<slug>` of that
// Organization, granted to the Teams the person names, checked out in the
// Organization root's `workspace/<slug>` and declared by a pull request into
// the Organization root from its task worktree. The plan, as for a personal
// module: every check reads only, and GitHub is asked only GETs. Who may:
// only an active Owner of the Organization, by GitHub's own live answer, the
// rule of the "+ Nový modul" tile (F36 addendum of 2026-10-04, root 0185
// point 6); a Team Environment never.

/** The permission each named Team gets on the new repository: Write, so its
 * Builders work through pull requests (root decision 0186 point 1: the
 * Teams on the module are its initial grant). */
export const moduleTeamPermission: TeamPermission = "push";

/** A Team the run grants the new repository: its slug in the Organization's
 * manifest, its slug on GitHub and the permission. */
export type TeamGrant = Readonly<{
  team: string;
  github: string;
  permission: TeamPermission;
}>;

export type PlannedOrganizationModule = Readonly<{
  scope: "organization";
  folder: string;
  organization: Readonly<{
    /** `company.slug`: the module's `company`. */
    slug: string;
    /** The GitHub login the repository is created under. */
    github: string;
    /** Its directory under `organizations/`. */
    directory: string;
    /** The Organization root's primary checkout. */
    root: string;
  }>;
  worktree: TaskWorktree | null;
  /** The documents the slot goes into, in the task worktree (or, without
   * one, the primary checkout), with their texts as the plan read them. */
  documents: Readonly<{
    directory: string;
    texts: OrganizationDocumentTexts;
  }>;
  /** `modules.manifest.json` of `documents`, for the report. */
  manifestPath: string;
  pool: PortPool;
  addsPool: false;
  plan: ModuleScaffoldPlan;
  moduleRoot: string;
  grants: readonly TeamGrant[];
}>;

type Data = Readonly<Record<string, unknown>>;
const isRecord = (value: unknown): value is Data =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** The plan of an Organization's module (see the module comment). Throws a
 * refusal with its code. */
export async function planOrganizationModule(
  request: ModuleCreateRequest,
  host: ModuleCreateHost,
  report: ModuleCreateReport,
  scope: string,
  name: string,
): Promise<PlannedOrganizationModule> {
  report.scope = "organization";
  report.module.name = `${scope}/${name}`;
  report.module.slug = name;
  assertStack(request.stack);
  const slug = assertSlug(name);
  const teams = [...(request.teams ?? [])];
  if (teams.length === 0)
    throw new ModuleCreateRefusal(
      "teams-required",
      "An Organization's module names its Teams: they are its slot's teams and its first grants on GitHub.",
      "Ask the person which Teams work on the module and name them with --teams <team,team>.",
    );

  // 1. Not a Team Environment: it acts under the Team's brokered identity
  // and never founds modules (root 0185 point 6, F36 addendum).
  // Fail closed: a Folder whose preset cannot be read might be one.
  const preset = await folderPreset(request.folder);
  if (preset === null)
    throw new ModuleCreateRefusal(
      "folder-unavailable",
      "This Folder's preferences cannot be read, so it is not known whether this is a Team Environment, which never creates modules.",
      "Repair the Folder (lazurio doctor shows how), then run the command again.",
    );
  if (preset === "hosted-organization-team")
    throw new ModuleCreateRefusal(
      "team-environment",
      "A Team Environment does not create modules: it acts under its Team's identity, which founds no repository of the Organization.",
      "Ask an Owner of the Organization to create the module from their own Environment.",
    );

  // 2. The Organization: one of this Folder's, resolving cleanly.
  const catalog = await readFolderCatalog(request.folder).catch(() => null);
  const selection =
    catalog === null
      ? ({ kind: "missing" } as const)
      : byGitHubLogin(
          catalog,
          scope,
          selectCatalogOrganization(catalog, scope),
        );
  if (selection.kind === "ambiguous")
    throw new ModuleCreateRefusal(
      "organization_ambiguous",
      `More than one Organization of this Folder is ${scope}.`,
      "Leave one checkout of the Organization in organizations/; lazurio organization list shows them.",
    );
  if (
    selection.kind === "missing" ||
    selection.organization === catalog?.personalspace
  )
    throw new ModuleCreateRefusal(
      "organization_not_found",
      `No Organization of this Folder is ${scope}.`,
      "Name the Organization by its slug as lazurio organization list shows it; an Organization that is not installed here is installed with lazurio organization install.",
    );
  const entry = selection.organization;
  if (entry.organization === null || !entry.executable)
    throw new ModuleCreateRefusal(
      "organization_manifest_not_mutation_safe",
      `The Organization root organizations/${entry.directory} resolves ${entry.state ?? "unreadable"}${entry.issues.length > 0 ? ` (${entry.issues.join(", ")})` : ""}; a module is declared only in a root that resolves cleanly.`,
      "Repair the Organization root first (see lazurio organization list --json), then run the command again.",
    );
  if (entry.forgeLogin === undefined)
    throw new ModuleCreateRefusal(
      "organization-not-bound",
      `The Organization ${entry.organization} names no GitHub login in lazurio.organization.json.`,
      "The Organization Admin binds the Organization to its GitHub Organization first.",
    );
  const github = entry.forgeLogin;
  const root = join(request.folder, "organizations", entry.directory);
  report.organization = {
    slug: entry.organization,
    github,
    directory: entry.directory,
  };

  // 3. Who asks: an active Owner of the Organization, by GitHub's answer.
  const viewer = await host.github.viewer();
  if (viewer.kind === "signed-out")
    throw new ModuleCreateRefusal(
      "github-signed-out",
      "gh is not signed in on this Environment.",
      "Sign in to GitHub here (gh auth login), then run the command again.",
    );
  if (viewer.kind === "unavailable")
    throw new ModuleCreateRefusal(
      "github-unavailable",
      "GitHub did not say who gh is signed in as.",
      "GitHub did not answer; run the command again in a moment.",
    );
  const membership = await host.github.membership(github);
  if (membership.kind === "unavailable")
    throw new ModuleCreateRefusal(
      "github-unavailable",
      `GitHub did not answer the membership of ${viewer.viewer.login} in ${github}.`,
      "GitHub did not answer; run the command again in a moment.",
    );
  if (
    membership.kind !== "member" ||
    membership.state !== "active" ||
    membership.role !== "admin"
  )
    throw new ModuleCreateRefusal(
      "organization-owner-required",
      `${viewer.viewer.login}, as whom gh is signed in here, is no active Owner of ${github}: only an Owner creates an Organization's module (its repository and its Teams' grants).`,
      `Ask an Owner of ${github} to create the module, or to create it from their own Environment.`,
    );

  // 4. The layout: the task worktree and the documents the slot goes into.
  const worktree = await locateTaskWorktree(request.cwd, root, host.git);
  report.worktree =
    worktree === null ? null : { path: worktree.path, branch: worktree.branch };
  const documentsDirectory = worktree === null ? root : worktree.path;
  const texts = await readOrganizationDocumentTexts(documentsDirectory);
  const manifestPath = join(
    documentsDirectory,
    organizationDocumentFiles.modules,
  );
  // The documents resolve cleanly where the slot goes (the task branch may
  // differ from the primary checkout the catalog read).
  try {
    declareOrganizationSlots(texts, []);
  } catch (error) {
    if (!(error instanceof ModuleScaffoldError)) throw error;
    throw new ModuleCreateRefusal(
      "organization_manifest_not_mutation_safe",
      `${documentsDirectory}: ${error.message}`,
      "Repair the Organization's documents in the task branch (or rebase it on main), then run the command again.",
    );
  }
  const canonical = JSON.parse(texts.canonical) as Data;
  const pool = organizationPool(canonical.module_port_pool);
  report.manifest =
    pool === null
      ? null
      : { path: manifestPath, module_port_pool: pool, adds_pool: false };
  const declaredTeams = (
    Array.isArray(canonical.teams) ? canonical.teams : []
  ).filter(isRecord);
  const workspace = join(root, "workspace");
  const moduleRoot = join(workspace, slug);
  report.module_root = moduleRoot;
  if (!(await absent(workspace)))
    try {
      await inspectCheckoutDirectory(workspace);
    } catch {
      throw new ModuleCreateRefusal(
        "organization-workspace-unavailable",
        `${workspace} is not a real directory of your own account.`,
        "workspace/ of the Organization root must be a real directory of your account.",
      );
    }
  // As a directory (`workspace/<slug>/`): roots ignore `/workspace/*/`,
  // which Git applies only to a directory, and this one does not exist yet.
  const ignored = await host.git.ignored(root, `workspace/${slug}/`);
  if (ignored === null)
    throw new ModuleCreateRefusal(
      "organization-workspace-unavailable",
      "Git could not say whether the Organization root ignores workspace/<slug>.",
      "Check that the Organization root is a Git checkout and git runs here, then run the command again.",
    );
  if (!ignored)
    throw new ModuleCreateRefusal(
      "organization-workspace-tracked",
      `The Organization root's Git does not ignore workspace/${slug}: a module there would become part of the Organization root repository.`,
      "Let the Organization root's .gitignore ignore workspace/*/ (as the Organization template does) in a pull request, then run the command again.",
    );
  if (await occupied(workspace, slug))
    throw new ModuleCreateRefusal(
      "directory_exists",
      `${moduleRoot} already exists (letter case ignored); a module is never written over an existing directory.`,
      "Choose another slug, or work in the existing module.",
    );

  // 5. The plan (the generator, F52): slug, Teams of the roster, slot, lease.
  const primarySlots = await primaryModuleSlots(root);
  const planned = planModuleScaffold({
    owner: {
      kind: "organization",
      slug: entry.organization,
      githubOrg: github,
      teams: declaredTeams
        .map((team) => team.slug)
        .filter((team): team is string => typeof team === "string"),
    },
    slug,
    stack: request.stack,
    displayName: request.name,
    teams,
    port: request.port ?? null,
    pool,
    existingSlots: [
      ...primarySlots,
      ...((JSON.parse(texts.modules) as { module_slots: unknown[] })
        .module_slots ?? []),
    ],
    takenPorts: [
      ...(await folderLeasePorts(request.folder, null)),
      ...environmentPorts,
    ],
    templates: host.templates ?? moduleTemplates,
    versions: { bun: scaffoldBunVersion, ...defaultScaffoldVersions },
    data: request.data,
  });

  // 6. Each Team on GitHub: by its bound slug and id, else by its slug.
  const grants: TeamGrant[] = [];
  for (const team of planned.slot.teams ?? []) {
    const declared = declaredTeams.find((item) => item.slug === team);
    const binding = isRecord(declared?.forge_binding)
      ? declared.forge_binding
      : null;
    const bound = isRecord(binding?.team) ? binding.team : null;
    const githubSlug =
      typeof bound?.asserted_slug === "string" ? bound.asserted_slug : team;
    const answer = await host.github.team(github, githubSlug);
    if (answer.kind === "unavailable")
      throw new ModuleCreateRefusal(
        "github-unavailable",
        `GitHub did not answer whether ${github} has the Team ${githubSlug}.`,
        "GitHub did not answer; run the command again in a moment.",
      );
    if (answer.kind === "missing")
      throw new ModuleCreateRefusal(
        "team-not-on-github",
        `${github} has no Team ${githubSlug} on GitHub that ${viewer.viewer.login} can see, for the Team ${team} of the Organization's manifest.`,
        "Choose Teams that exist on GitHub, or ask the Organization Admin to create the Team (and bind it in lazurio.organization.json).",
      );
    if (
      typeof bound?.id === "string" &&
      bound.id !== String(answer.team.databaseId)
    )
      throw new ModuleCreateRefusal(
        "team-binding-mismatch",
        `The Team ${team} is bound to the GitHub Team id ${bound.id}, but ${github}'s Team ${githubSlug} is ${answer.team.databaseId}.`,
        "The Organization Admin corrects the Team's binding in lazurio.organization.json first.",
      );
    grants.push(
      Object.freeze({
        team,
        github: answer.team.slug,
        permission: moduleTeamPermission,
      }),
    );
  }

  // 7. The repository `<login>/<slug>`: never one that exists.
  const fullName = `${github}/${slug}`;
  const existing = await host.github.repository(github, slug);
  if (existing.kind === "observed")
    throw new ModuleCreateRefusal(
      "repository-exists",
      `GitHub already has ${existing.repository.fullName} (names are compared ignoring letter case); an existing repository is never taken over.`,
      "Ask the person for another name of the module (its slug).",
    );
  if (existing.kind === "unavailable")
    throw new ModuleCreateRefusal(
      "github-unavailable",
      `GitHub did not answer whether ${fullName} exists.`,
      "GitHub did not answer; run the command again in a moment.",
    );
  await planData(report, planned, github, moduleRoot, host.github);

  const resolvedPool = pool as PortPool;
  report.status = "actionable";
  report.reason = "scaffold_planned";
  report.module.display_name = planned.displayName;
  report.repository = { full_name: fullName, private: true, create: true };
  report.teams = grants.map((grant) => ({
    slug: grant.team,
    github_slug: grant.github,
    permission: grant.permission,
  }));
  report.slot = planned.slot;
  report.lease = planned.lease;
  report.files = planned.files.map((file) => ({
    path: file.path,
    bytes: Buffer.byteLength(file.content),
    ...(file.mode === undefined ? {} : { mode: file.mode }),
  }));
  report.generated_by_install = [...planned.generatedByInstall];
  report.tree_hash = planned.treeHash;
  report.warnings.push(...planned.warnings);
  report.manifest = {
    path: manifestPath,
    module_port_pool: resolvedPool,
    adds_pool: false,
  };
  report.plan = planDigest({
    repository: fullName,
    plan: planned,
    pool: resolvedPool,
    addsPool: false,
    organization: { slug: entry.organization, github },
    grants,
  });
  return Object.freeze({
    scope: "organization" as const,
    folder: request.folder,
    organization: Object.freeze({
      slug: entry.organization,
      github,
      directory: entry.directory,
      root,
    }),
    worktree,
    documents: Object.freeze({ directory: documentsDirectory, texts }),
    manifestPath,
    pool: resolvedPool,
    addsPool: false as const,
    plan: planned,
    moduleRoot,
    grants: Object.freeze(grants),
  });
}

/** Where an Organization root's task worktrees live: beside its own files,
 * in `.worktrees/root/<task>` (the root's worktree discipline). */
export const organizationTaskWorktrees = (root: string) =>
  join(root, ".worktrees", "root");

/** The dry run's next steps for an Organization's module. */
export function organizationDryRunSteps(
  report: ModuleCreateReport,
  module: PlannedOrganizationModule,
  request: ModuleCreateRequest,
): string[] {
  const steps: string[] = [];
  const worktree = module.worktree?.linked ? module.worktree.path : null;
  const { root } = module.organization;
  if (worktree === null)
    steps.push(
      `The real run needs a task worktree of the Organization root in ${organizationTaskWorktrees(root)}: git -C '${root}' worktree add -b <branch> '${join(organizationTaskWorktrees(root), "<task>")}' main.`,
    );
  steps.push(
    `Show the person this plan in the thread: the private repository ${report.repository?.full_name} of the Organization, the Teams ${module.grants.map((grant) => `${grant.team} (${grant.permission})`).join(", ")}, the stack ${module.plan.stack}, the files and the port ${module.plan.lease?.port ?? "(none, no app)"}. Create it only after they confirm it.`,
    `Then, from ${worktree === null ? "the task worktree" : worktree}: ${confirmCommand(request, report.plan as string)}`,
  );
  return steps;
}

/** The Launchpad's selection (the slug, else the directory), and where it
 * finds none, the one Organization bound to that GitHub login: the "+ Nový
 * modul" prompt names an Organization by its login, which may differ from
 * its slug. */
function byGitHubLogin(
  catalog: Catalog,
  name: string,
  selection: CatalogOrganizationSelection,
): CatalogOrganizationSelection {
  if (selection.kind !== "missing") return selection;
  const bound = catalog.organizations.filter(
    (entry) => entry.forgeLogin?.toLowerCase() === name.toLowerCase(),
  );
  if (bound.length > 1) return { kind: "ambiguous", candidates: bound };
  const [only] = bound;
  return only === undefined ? selection : { kind: "found", organization: only };
}

// ---- reads -------------------------------------------------------------------

/** The Folder's recorded preset; null when the Folder's state cannot be
 * read. */
async function folderPreset(folder: string): Promise<PresetName | null> {
  try {
    return parseFolderPreferences(
      await readStateJson(join(folder, ".lazurio"), "preferences.json"),
    ).preset.name;
  } catch {
    return null;
  }
}

async function readText(path: string): Promise<string | null> {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      await readCheckoutFileBytes(path),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw new ModuleCreateRefusal(
      "manifest_invalid",
      `${path} cannot be read as a file of your own checkout.`,
    );
  }
}

async function readModulesIndex(directory: string): Promise<string | null> {
  try {
    await inspectCheckoutDirectory(join(directory, "generated"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw new ModuleCreateRefusal(
      "manifest_invalid",
      "The Organization generated directory is not a safe checkout directory.",
    );
  }
  return readText(join(directory, organizationModulesIndexPath));
}

/** The texts of an Organization root's three documents in `directory`. */
export async function readOrganizationDocumentTexts(
  directory: string,
): Promise<OrganizationDocumentTexts> {
  const [canonical, modules, legacy, modulesIndex] = await Promise.all([
    readText(join(directory, organizationDocumentFiles.canonical)),
    readText(join(directory, organizationDocumentFiles.modules)),
    readText(join(directory, organizationDocumentFiles.legacy)),
    readModulesIndex(directory),
  ]);
  if (modules === null)
    throw new ModuleCreateRefusal(
      "modules_manifest_missing",
      `${join(directory, organizationDocumentFiles.modules)} is missing: the Organization declares its modules there.`,
      "Run the command from a task worktree of the Organization root.",
    );
  if (canonical === null)
    throw new ModuleCreateRefusal(
      "organization_manifest_not_mutation_safe",
      `${join(directory, organizationDocumentFiles.canonical)} is missing.`,
      "Run the command from a task worktree of the Organization root.",
    );
  return Object.freeze({ canonical, modules, legacy, modulesIndex });
}

// The slots of the primary checkout, which the task branch may lack.
async function primaryModuleSlots(root: string): Promise<readonly unknown[]> {
  const text = await readText(join(root, organizationDocumentFiles.modules));
  try {
    const slots = (JSON.parse(text ?? "{}") as { module_slots?: unknown })
      .module_slots;
    return Array.isArray(slots) ? slots : [];
  } catch {
    return [];
  }
}

/** The Organization's `module_port_pool`, which never overlaps the reserved
 * personal range (HumanAndMachines/Lazurio#545); null without one (the
 * generator refuses `pool_missing` for a module with an app). */
function organizationPool(value: unknown): PortPool | null {
  if (!isRecord(value)) return null;
  const { start, end } = value as { start?: unknown; end?: unknown };
  if (typeof start !== "number" || typeof end !== "number") return null;
  if (
    start <= personalModulePortPool.end &&
    end >= personalModulePortPool.start
  )
    throw new ModuleCreateRefusal(
      "organization-pool-invalid",
      `The Organization's module_port_pool ${start}-${end} overlaps ${personalModulePortPool.start}-${personalModulePortPool.end}, the range reserved for personal modules.`,
      "The Organization Admin moves the module_port_pool out of the reserved range (100 ports disjoint from every other Organization's).",
    );
  return { start, end };
}
