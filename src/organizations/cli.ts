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
  Folder is --folder, otherwise the supervised unit's, or in a Remote
  Environment the declared operator's (as for lazurio update). --json prints the whole
  catalog, modules included, and on a Folder with a Personalspace its group
  (personalspace), which is not an Organization and is not in the table.
module list [<Organization>] [--folder <absolute Folder>] [--json]
  The modules of every Organization, or of the one named by its slug or
  directory name: its workspace modules and, when declared with a
  lazurio.module.json, its root-level applications mission-control and
  design-system (infra and mission-control/db are repositories, not
  modules); <Organization>/<module>, its Teams, its default app and whether
  it may run or the typed reason why not. Teams come from
  module_slots[].teams; an older manifest's legacy alias (workspaces, then
  workspace) is read for compatibility and named once per Organization; a
  module that declares none is in the default Team workspace. On a Folder
  with a Personalspace (the local and hosted-personal presets) the modules in
  personalspace/<owner>/workspace/ follow as personalspace/<module>, with no
  Teams; name the group personalspace to list only them. More than one
  directory in personalspace/ is refused (personalspace-ambiguous) and none
  of them is read. Same Folder and rules as organization list.
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

/** A name as the terminal shows it. A slug is written by an Organization
 * repository's members and a directory name by anyone who can create one;
 * control, line and bidirectional formatting characters are printed as a
 * visible `\u{…}` escape (and a backslash doubled), so no name can move the
 * cursor, hide a column or forge a row. JSON output escapes by itself. */
export const shown = (text: string) =>
  text.replace(
    /[\\\p{Cc}\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/gu,
    (character) =>
      character === "\\"
        ? "\\\\"
        : `\\u{${character.codePointAt(0)?.toString(16)}}`,
  );

/** Columns aligned to the widest cell, like `lazurio tools list`. */
export function columns(input: readonly (readonly string[])[]): string[] {
  const rows = input.map((row) => row.map(shown));
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

// Not executable: the reason, and the refused file when there is one
// (decision F23).
const status = (entry: {
  executable: boolean;
  reason?: string;
  file?: string;
}) =>
  entry.executable
    ? "executable"
    : `${entry.reason ?? "not-executable"}${entry.file === undefined ? "" : ` (${entry.file})`}`;

// Whether any module of the Organization takes its Teams from the legacy
// alias (`workspaces` or `workspace`). The CLI says it once per Organization,
// never per module, to help migrate its manifest to the canonical
// `module_slots[].teams`; the Launchpad shows no Teams (decision F32).
const usesLegacyTeamAlias = (organization: CatalogOrganization) =>
  organization.modules.some((module) => module.teamsSource === "legacy-alias");

// One line per Organization whose manifest still uses the legacy Team alias,
// under the table: said once, never per module.
function legacyAliasNotes(
  organizations: readonly CatalogOrganization[],
): string[] {
  return organizations
    .filter(usesLegacyTeamAlias)
    .map(
      (entry) =>
        `${shown(entry.organization ?? entry.directory)}: Teams read from the legacy alias workspaces/workspace; the canonical form is module_slots[].teams.`,
    );
}

function organizationLines(catalog: Catalog): string {
  if (catalog.organizations.length === 0)
    return "No Organizations in this Folder's organizations/.";
  return [
    ...columns(
      catalog.organizations.map((entry: CatalogOrganization) => [
        entry.organization ?? entry.directory,
        entry.state ?? "-",
        `${entry.modules.length} ${entry.modules.length === 1 ? "module" : "modules"}`,
        status(entry),
      ]),
    ),
    ...legacyAliasNotes(catalog.organizations),
  ].join("\n");
}

function moduleLines(
  modules: readonly CatalogModule[],
  organizations: readonly CatalogOrganization[],
): string {
  if (modules.length === 0) return "No modules.";
  return [
    ...columns(
      modules.map((entry) => [
        `${entry.organization}/${entry.module}`,
        entry.teams.length === 0 ? "-" : entry.teams.join(","),
        entry.defaultApp ?? "-",
        status(entry),
      ]),
    ),
    ...legacyAliasNotes(organizations),
  ].join("\n");
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
      `No Organization ${shown(name)} in this Folder (or its slug is ambiguous); see lazurio organization list.`,
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
      ? `${shown(organization.organization ?? organization.directory)}: ${status(organization)}`
      : moduleLines(
          modules,
          organization === undefined ? catalog.organizations : [organization],
        ),
  );
}
