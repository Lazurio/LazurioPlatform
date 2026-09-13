import { inspectCanonicalInventory } from "./canonical-inventory";
import {
  organizationDocumentHash,
  snapshotOrganizationDocument,
} from "./document-hash";
import {
  classifyRepositorySlotPath,
  organizationSlotArea,
} from "./repository-slots";

type Data = Readonly<Record<string, unknown>>;

// Pure compatibility projection of validated declarations. Never writes the
// legacy file, rewrites inventory, or treats declared aliases/access as authority.
export function expectedLegacyProjection(
  canonicalInput: unknown,
  modulesInput: unknown,
) {
  const { canonical, modules } = inspectCanonicalInventory(
    canonicalInput,
    modulesInput,
  );
  const organization = canonical.organization as Data;
  const owner = organization.forge_binding as Data;
  const root = canonical.root_repository as Data | null | undefined;
  const company: Record<string, unknown> = {
    ...(organization.metadata as Data),
    slug: organization.slug,
    display_name: organization.display_name,
    github_org: owner.locator,
  };
  if (root)
    Object.assign(company, {
      repository: `git@github.com:${root.locator}.git`,
      root_repository: root.locator,
      default_branch: root.default_branch,
    });
  const output: Record<string, unknown> = {
    ...((canonical.extensions as Data).legacy as Data),
    organization_generation: "gen3",
    organization_kind: canonical.kind,
    company,
  };
  if (root && owner.binding_state === "verified")
    output.forge_binding = {
      schema_version: "lazurio.forge-binding.github.v0",
      provider: "github",
      organization: {
        id: owner.organization_id,
        asserted_login: owner.locator,
      },
      repository: {
        id: root.repository_id,
        asserted_full_name: root.locator,
        default_branch: root.default_branch,
      },
    };
  for (const key of [
    "governance",
    "teams",
    "layers",
    "task_sources",
    "doctor",
    "module_port_pool",
  ])
    if (Object.hasOwn(canonical, key)) output[key] = canonical[key];
  const projected: Record<string, unknown>[] = [];
  for (const input of modules.module_slots as unknown[]) {
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new Error("Invalid projection slot");
    const slot = input as Data;
    const area = organizationSlotArea(slot.path);
    if (!area) throw new Error("Invalid projection slot path");
    if (area === "root") continue;
    const path = slot.path as string;
    const entry: Record<string, unknown> = { ...slot };
    for (const key of ["git", "space", "default_access", "required_roles"])
      delete entry[key];
    if (
      !Object.hasOwn(slot, "slug") &&
      !classifyRepositorySlotPath(path)?.nestedDatabase
    )
      entry.slug = path.split("/").at(-1);
    const git = slot.git as Data | null | undefined;
    const remote = git?.url ?? slot.repo ?? slot.repository;
    const branch = git?.branch ?? slot.branch;
    if (remote !== undefined) entry.repo = remote;
    if (branch !== undefined) entry.branch = branch;
    if (slot.space === "productionspace") entry.workspace = "productionspace";
    if (
      Object.hasOwn(slot, "default_access") ||
      Object.hasOwn(slot, "required_roles")
    )
      entry.access = {
        default: slot.default_access ?? "expected",
        roles: slot.required_roles ?? [],
      };
    projected.push(entry);
  }
  projected.sort((a, b) =>
    (a.path as string) < (b.path as string)
      ? -1
      : (a.path as string) > (b.path as string)
        ? 1
        : 0,
  );
  output.modules = projected;
  const projection = snapshotOrganizationDocument(output) as Data;
  const hash = organizationDocumentHash(projection);
  const declared = ((canonical.compatibility as Data).legacy_projection as Data)
    .sha256;
  return Object.freeze({
    projection,
    hash,
    declaredHashMatches: hash === declared,
  });
}
