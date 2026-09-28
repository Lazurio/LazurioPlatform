import { isAbsolute, resolve } from "node:path";
import { parseArgs } from "node:util";
import { type CliContext, operatorFolder } from "../update/cli";
import {
  type Catalog,
  type CatalogModule,
  type CatalogOrganization,
  catalogModules,
  findCatalogOrganization,
  readFolderCatalog,
} from "./catalog";

/** `lazurio organization list` and `lazurio module list`: the terminal surface
 * of the Folder catalog (launchpad-parity B1). The Launchpad's
 * `POST /api/catalog` answers with the same catalog from the same core. */
export const catalogHelp = `organization list [--folder <absolute Folder>] [--json]
  Every directory in <Folder>/organizations/ as one Organization: its slug,
  resolution state (transition, current, projection_drift, conflict, legacy,
  missing), how many modules it declares, and whether its modules may run or
  the typed reason why not. An Organization that cannot be read is listed with
  its reason and never hides the others; template Organizations are listed
  and never run. Reads only; nothing is written, fetched or started. The
  Folder is --folder, otherwise the supervised unit's, or on a hosted Machine
  the declared operator's (as for lazurio update). --json prints the whole
  catalog, modules included.
module list [<Organization>] [--folder <absolute Folder>] [--json]
  The workspace modules of every Organization, or of the one named by its
  slug or directory name: <Organization>/<module>, its Teams, its default app
  and whether it may run or the typed reason why not. Same Folder and rules
  as organization list.
Exit status: 0 listed, 2 usage, unknown Organization or no Folder known,
1 the Folder could not be read.`;

export class CatalogUsageError extends Error {}

export type CatalogCommandOutput = Readonly<{
  code: number;
  result: Record<string, unknown>;
  text: string;
}>;

const usage =
  "Usage: organization list [--folder <Folder>] [--json] | module list [<Organization>] [--folder <Folder>] [--json]";

/** Columns aligned to the widest cell, like `lazurio tools list`. */
function columns(rows: readonly (readonly string[])[]): string[] {
  const widths = rows.reduce<number[]>(
    (width, row) =>
      row.map((cell, index) => Math.max(width[index] ?? 0, cell.length)),
    [],
  );
  return rows.map((row) =>
    row
      .map((cell, index) =>
        index === row.length - 1 ? cell : cell.padEnd(widths[index] ?? 0),
      )
      .join("  "),
  );
}

const status = (entry: { executable: boolean; reason?: string }) =>
  entry.executable ? "executable" : (entry.reason ?? "not-executable");

function organizationLines(catalog: Catalog): string {
  if (catalog.organizations.length === 0)
    return "No Organizations in this Folder's organizations/.";
  return columns(
    catalog.organizations.map((entry: CatalogOrganization) => [
      entry.organization ?? entry.directory,
      entry.state ?? "-",
      `${entry.modules.length} ${entry.modules.length === 1 ? "module" : "modules"}`,
      status(entry),
    ]),
  ).join("\n");
}

function moduleLines(modules: readonly CatalogModule[]): string {
  if (modules.length === 0) return "No modules.";
  return columns(
    modules.map((entry) => [
      `${entry.organization}/${entry.module}`,
      entry.teams.length === 0 ? "-" : entry.teams.join(","),
      entry.defaultApp ?? "-",
      status(entry),
    ]),
  ).join("\n");
}

export async function runCatalogCommand(
  args: string[],
  context: CliContext,
  // Test seam: the catalog core; the product reads the Folder.
  read: (folder: string) => Promise<Catalog> = readFolderCatalog,
): Promise<CatalogCommandOutput> {
  let values: { folder?: string | undefined; json?: boolean | undefined };
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args,
      strict: true,
      allowPositionals: true,
      tokens: true,
      options: { folder: { type: "string" }, json: { type: "boolean" } },
    });
    ({ values, positionals } = parsed);
    const supplied = new Set<string>();
    for (const token of parsed.tokens) {
      if (token.kind !== "option") continue;
      if (supplied.has(token.name)) throw new Error("Duplicate command option");
      supplied.add(token.name);
    }
  } catch (error) {
    throw new CatalogUsageError(
      `${error instanceof Error ? error.message : String(error)}\n${usage}`,
    );
  }
  const [noun, verb, ...rest] = positionals;
  if (
    verb !== "list" ||
    (noun === "organization" && rest.length !== 0) ||
    (noun === "module" && rest.length > 1) ||
    (noun !== "organization" && noun !== "module") ||
    (values.folder !== undefined &&
      (!isAbsolute(values.folder) || resolve(values.folder) !== values.folder))
  )
    throw new CatalogUsageError(usage);
  const json = values.json === true;
  const done = (
    code: number,
    result: Record<string, unknown>,
    text: string,
  ): CatalogCommandOutput => ({
    code,
    result,
    text: json ? JSON.stringify(result) : text,
  });
  const folder = values.folder ?? (await operatorFolder(context));
  if (folder === undefined)
    return done(
      2,
      { kind: "blocked", reason: "folder-unknown" },
      "No Folder known: name it with --folder <absolute Folder>.",
    );
  let catalog: Catalog;
  try {
    catalog = await read(folder);
  } catch {
    // No raw filesystem error: it could quote a private path.
    return done(
      1,
      { kind: "blocked", reason: "folder-unreadable" },
      "The Folder could not be read: it must be an absolute, caller-owned, non-shared directory.",
    );
  }
  if (noun === "organization")
    return done(0, catalog, organizationLines(catalog));
  const name = rest[0];
  const organization =
    name === undefined ? undefined : findCatalogOrganization(catalog, name);
  if (name !== undefined && organization === undefined)
    return done(
      2,
      { kind: "blocked", reason: "organization-unknown", organization: name },
      `No Organization ${name} in this Folder (or its slug is ambiguous); see lazurio organization list.`,
    );
  const modules = catalogModules(catalog, organization);
  return done(
    0,
    {
      kind: "module-list",
      ...(organization === undefined
        ? {}
        : {
            organization: organization.organization ?? organization.directory,
            ...(organization.reason === undefined
              ? {}
              : { reason: organization.reason }),
          }),
      modules,
    },
    organization?.reason !== undefined && organization.modules.length === 0
      ? `${organization.organization ?? organization.directory}: ${organization.reason}`
      : moduleLines(modules),
  );
}
