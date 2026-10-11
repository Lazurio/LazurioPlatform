import { join } from "node:path";
import { canonicalCheckoutDirectory } from "../../folder/owned-directory";
import type { ApplicationRunner } from "../../modules/application-runner";
import type { ModuleHost } from "../../modules/module-operations";
import {
  type Catalog,
  type CatalogOrganization,
  readFolderCatalog,
} from "../../organizations/catalog";
import {
  catalogGroups,
  catalogOrganizationKey,
} from "../../organizations/catalog-selection";
import {
  locatePersonalspace,
  observePersonalspaceModule,
} from "../../organizations/personalspace";

// The running Modules of the overview of Nová karta (decision F47 point 7):
// the transient user units of the Environment's Organizations (and its
// Personalspace) that run now, each named by the catalog's Organization, its
// module and app, so that Zastavit is the existing
// `POST /api/modules/<org>/<module>/stop` with `{app}`. Nothing is recorded:
// the service manager lists what runs (`runner.list()`), and each app of the
// catalog is named by the runner's own rule (`identify`), so the two meet
// without a registry of the Launchpad's.

export type ModuleUnit = Readonly<{
  /** The name `/api/modules/<org>/…` takes: `catalogOrganizationKey`. */
  org: string;
  module: string;
  /** The app's package, as the module routes take it. */
  app: string;
  unit: string;
}>;

export type ModulesSeams = Readonly<{
  folder: string;
  /** The Launchpad's module host: who owns started apps and their runner. */
  host: Pick<ModuleHost, "runnerKind" | "createRunner">;
  readCatalog?: ((folder: string) => Promise<Catalog>) | undefined;
}>;

/** Where a group's apps run and under which company each module's are
 * named: the rule by which `targetOf` (module-operations.ts) names a target.
 * An Organization's root and its slug; the Personalspace's owner directory
 * and the company each module declares. Null where it cannot be read, as
 * the lifecycle then refuses the module too. */
async function groupScope(
  folder: string,
  catalog: Catalog,
  group: CatalogOrganization,
): Promise<Readonly<{
  directory: string;
  company: (module: string) => Promise<string | null>;
}> | null> {
  const slug = group.organization;
  if (slug === null) return null;
  try {
    if (group !== catalog.personalspace)
      return {
        directory: await canonicalCheckoutDirectory(
          join(folder, "organizations", group.directory),
        ),
        company: async () => slug,
      };
    const located = await locatePersonalspace(folder);
    if (located.kind !== "owner") return null;
    const directory = await canonicalCheckoutDirectory(located.directory);
    return {
      directory,
      company: async (module) => {
        const { observed } = await observePersonalspaceModule(
          directory,
          module,
        ).catch(() => ({ observed: null }));
        return observed?.kind === "module-observed" ? observed.company : null;
      },
    };
  } catch {
    return null;
  }
}

/** The running units of one group of the catalog, or null when the manager
 * could not list them. */
async function groupUnits(
  seams: ModulesSeams,
  catalog: Catalog,
  group: CatalogOrganization,
): Promise<ModuleUnit[] | null> {
  const org = catalogOrganizationKey(catalog, group);
  const runnable = group.modules.filter((module) =>
    module.apps.some((app) => app.kind === "runtime-declared"),
  );
  if (org === null || runnable.length === 0) return [];
  const scope = await groupScope(seams.folder, catalog, group);
  if (scope === null) return [];
  let runner: ApplicationRunner;
  try {
    runner = seams.host.createRunner("systemd-user", scope.directory);
  } catch {
    return [];
  }
  const listed = await runner
    .list()
    .catch(() => ({ kind: "unavailable" }) as const);
  if (listed.kind !== "listed") return null;
  // A failed unit (`ended`) does not run and is not listed.
  const running = new Set(
    listed.applications
      .filter((application) => application.state === "running")
      .map((application) => application.id),
  );
  if (running.size === 0) return [];
  const units: ModuleUnit[] = [];
  for (const module of runnable) {
    const company = await scope.company(module.module);
    if (company === null) continue;
    for (const app of module.apps) {
      if (app.kind !== "runtime-declared") continue;
      const unit = runner.identify({
        company,
        module: module.module,
        package: app.package,
      });
      if (running.has(unit))
        units.push({ org, module: module.module, app: app.package, unit });
    }
  }
  return units;
}

/** Every running Module app of the catalog, or null when which run is not
 * known: apps that are not the service manager's (a session runner, which
 * no Remote Environment uses), a catalog that cannot be read, or a group
 * the manager did not list. A unit that no app of the catalog names, such as
 * one whose declaration changed while it ran, is not listed. */
export async function runningModules(
  seams: ModulesSeams,
): Promise<readonly ModuleUnit[] | null> {
  try {
    if ((await seams.host.runnerKind()) !== "systemd-user") return null;
    const catalog = await (seams.readCatalog ?? readFolderCatalog)(
      seams.folder,
    );
    const groups = await Promise.all(
      catalogGroups(catalog).map((group) => groupUnits(seams, catalog, group)),
    );
    return groups.some((units) => units === null)
      ? null
      : groups.flatMap((units) => units ?? []);
  } catch {
    return null;
  }
}
