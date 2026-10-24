import { minimatch } from "minimatch";
import { inspectCanonicalInventory } from "./canonical-inventory";
import { expectedLegacyProjection } from "./legacy-projection";
import { classifyRepositorySlotPath } from "./repository-slots";

type Data = Record<string, unknown>;
const record = (value: unknown): Data =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Data)
    : {};
const records = (value: unknown): Data[] =>
  Array.isArray(value) ? value.map(record) : [];
export const organizationModulesIndexPath = "generated/modules.index.json";

// Existing Core modules_index.v2 wire projection, not registration authority.
// See docs/organization-contract.md for compatibility and conformance evidence.
export function compileOrganizationModulesIndex(
  canonicalInput: unknown,
  modulesInput: unknown,
): string | null {
  const observed = inspectCanonicalInventory(canonicalInput, modulesInput);
  const ownership = record(
    record(observed.canonical.governance).file_ownership,
  );
  const owners = Object.entries(ownership)
    .filter(
      ([, patterns]) =>
        Array.isArray(patterns) &&
        patterns.some(
          (pattern: unknown) =>
            typeof pattern === "string" &&
            minimatch(organizationModulesIndexPath, pattern, { dot: true }),
        ),
    )
    .map(([kind]) => kind);
  if (owners.length === 0) return null;
  if (owners.length !== 1 || owners[0] !== "derived")
    throw new Error("The modules index must have exactly one derived owner.");
  if (observed.inventory.issues.length > 0)
    throw new Error("Cannot compile an inventory with declaration issues.");
  const company = expectedLegacyProjection(canonicalInput, modulesInput)
    .projection as Data;
  const roster = records(company.teams);
  const defaultTeam =
    roster.find((team) => team.default === true)?.slug ?? "workspace";
  const teams = roster.length
    ? roster.map((team) => ({
        slug: team.slug,
        display_name: team.display_name ?? null,
        default: team.default ?? false,
      }))
    : [
        {
          slug: "workspace",
          display_name: null,
          default: true,
          implicit: true,
        },
      ];
  const memberships = (entry: Data, workspace: boolean): unknown[] => {
    if (!workspace) return [];
    if (Array.isArray(entry.teams))
      return entry.teams.length ? entry.teams : [defaultTeam];
    if (Array.isArray(entry.workspaces) && entry.workspaces.length)
      return entry.workspaces;
    return typeof entry.workspace === "string" && entry.workspace
      ? [entry.workspace]
      : [defaultTeam];
  };
  const modules = records(company.modules).map((entry) => {
    const space = classifyRepositorySlotPath(entry.path)?.scope;
    if (space !== "workspace" && space !== "productionspace")
      throw new Error("Invalid projected module path.");
    const membership = memberships(entry, space === "workspace");
    return {
      slug: entry.slug,
      path: entry.path,
      space,
      teams: membership,
      workspace: membership[0] ?? null,
      category: entry.category ?? null,
      source_of_truth: entry.source_of_truth ?? null,
      repo: entry.repo ?? null,
      access: entry.access ?? null,
    };
  });
  const manifest_slots = records(record(modulesInput).module_slots).map(
    (entry) => {
      const space = classifyRepositorySlotPath(entry.path)?.scope;
      if (!space) throw new Error("Invalid inventory path.");
      const membership = memberships(entry, space === "workspace");
      return {
        ...entry,
        space,
        teams: membership,
        workspace: membership[0] ?? null,
      };
    },
  );
  return `${JSON.stringify({ schema_version: "companiesascode.modules_index.v2", compiler_version: "companiesascode.organization_compiler.v1", company_slug: record(company.company).slug ?? null, teams, workspaces: teams, modules, manifest_slots }, null, 2)}\n`;
}
