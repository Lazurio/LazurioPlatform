import { array, text } from "../modules/manifest";
import { parseCanonicalOrganization } from "./canonical-manifest";
import { snapshotOrganizationDocument } from "./document-hash";
import { inspectRepositorySlots } from "./repository-slots";

function record(input: unknown): Readonly<Record<string, unknown>> {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Inventory object required");
  return input as Readonly<Record<string, unknown>>;
}
function identity(input: unknown) {
  const value = text(input, /\S/);
  if (value.trim() !== value)
    throw new Error("Exact inventory identity required");
  return value;
}

// Bind declarations only. Returned diagnostics do not authorize a slot or resolve
// the legacy projection. No disk discovery, remote fetch or manifest rewriting.
export function inspectCanonicalInventory(
  canonicalInput: unknown,
  modulesInput: unknown,
) {
  const canonical = parseCanonicalOrganization(canonicalInput);
  const modules = record(snapshotOrganizationDocument(modulesInput));
  if (
    (Object.hasOwn(modules, "organization_generation") &&
      modules.organization_generation !== "gen3") ||
    (Object.hasOwn(modules, "schema_version") &&
      modules.schema_version !== "companiesascode.modules.v1" &&
      modules.schema_version !== "modules.manifest.v3")
  )
    throw new Error("Unsupported inventory schema");
  const company = identity(modules.company);
  const owner = identity(modules.github_org);
  const organization = record(canonical.organization);
  const expectedCompany = organization.slug as string;
  const expectedOwner = record(organization.forge_binding).locator as string;
  if (
    company.toLowerCase() !== expectedCompany.toLowerCase() ||
    owner.toLowerCase() !== expectedOwner.toLowerCase()
  )
    throw new Error("Organization inventory identity conflict");
  const declarations = array(modules.module_slots);
  const inventory = inspectRepositorySlots(declarations);
  const warnings: string[] = [];
  if (company !== expectedCompany) warnings.push("company-case-drift");
  if (owner !== expectedOwner) warnings.push("forge-locator-case-drift");
  return Object.freeze({
    kind: "declarations-observed" as const,
    canonical,
    modules,
    inventory,
    warnings: Object.freeze(warnings),
  });
}
