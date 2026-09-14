import { inspectCanonicalInventory } from "./canonical-inventory";
import {
  organizationDocumentHash,
  snapshotOrganizationDocument,
} from "./document-hash";
import { expectedLegacyProjection } from "./legacy-projection";

type Data = Readonly<Record<string, unknown>>;
export class OrganizationProjectionConflict extends Error {
  readonly sections: readonly string[];
  constructor(sections: string[]) {
    super("Organization conversion would change legacy content");
    this.sections = Object.freeze([...sections]);
  }
}
function record(input: unknown): Data {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Organization conversion requires objects");
  return input as Data;
}
const shared = [
  "governance",
  "teams",
  "layers",
  "task_sources",
  "doctor",
  "module_port_pool",
];
const companyFields = [
  "slug",
  "display_name",
  "github_org",
  "repository",
  "git_url",
  "root_repository",
  "default_branch",
];

// Pure explicit conversion draft, not runtime fallback or permission evidence.
// Only content-preserving round trips with listed normalizations are accepted.
// A future writer must separately prove
// canonical-target absence and revalidate source bytes/custody under its lock.
export function prepareOrganizationConversion(
  legacyInput: unknown,
  modulesInput: unknown,
) {
  const legacy = record(snapshotOrganizationDocument(legacyInput));
  const modules = snapshotOrganizationDocument(modulesInput);
  if (legacy.organization_generation !== "gen3")
    throw new Error("Explicit GEN3 declaration required");
  const company = record(legacy.company);
  const declared = Object.hasOwn(legacy, "forge_binding")
    ? record(legacy.forge_binding)
    : null;
  const owner = declared ? record(declared.organization) : null;
  const repository = declared ? record(declared.repository) : null;
  // Preserves an existing declaration only; it does not verify it against GitHub.
  const bindingState = declared ? "verified" : "unverified";
  const hasRoot =
    Object.hasOwn(company, "root_repository") || declared !== null;
  const materializeBranch =
    hasRoot &&
    !Object.hasOwn(company, "default_branch") &&
    repository?.default_branch === "main";
  const branch = materializeBranch
    ? repository.default_branch
    : company.default_branch;
  const projectedLegacy = materializeBranch
    ? { ...legacy, company: { ...company, default_branch: branch } }
    : legacy;
  const excluded = new Set([
    "organization_generation",
    "organization_kind",
    "company",
    "forge_binding",
    "modules",
    ...shared,
  ]);
  const legacyHash = organizationDocumentHash(legacy);
  const candidate = {
    schema_version: "lazurio.organization.v1",
    kind: legacy.organization_kind,
    organization: {
      slug: company.slug,
      display_name: company.display_name,
      forge_binding: {
        forge: "github",
        locator: company.github_org,
        binding_state: bindingState,
        ...(owner ? { organization_id: owner.id } : {}),
      },
      metadata: Object.fromEntries(
        Object.entries(company).filter(([key]) => !companyFields.includes(key)),
      ),
    },
    ...(hasRoot
      ? {
          root_repository: {
            forge: "github",
            locator: company.root_repository,
            default_branch: branch,
            binding_state: bindingState,
            ...(repository ? { repository_id: repository.id } : {}),
          },
        }
      : {}),
    manifests: { modules: "modules.manifest.json" },
    extensions: {
      legacy: Object.fromEntries(
        Object.entries(legacy).filter(([key]) => !excluded.has(key)),
      ),
    },
    compatibility: {
      legacy_projection: {
        path: "company.gen3.json",
        algorithm: "sha256-canonical-json-v1",
        sha256: organizationDocumentHash(projectedLegacy),
      },
    },
    ...Object.fromEntries(
      shared
        .filter((key) => Object.hasOwn(legacy, key))
        .map((key) => [key, legacy[key]]),
    ),
  };
  const inspected = inspectCanonicalInventory(candidate, modules);
  if (inspected.inventory.issues.length || inspected.warnings.length)
    throw new Error("Organization conversion requires reconciled inventory");
  // Also rejects conflicting aliases, unknown binding fields and lossy defaults.
  const projected = expectedLegacyProjection(inspected.canonical, modules);
  if (!projected.declaredHashMatches) {
    // Fixed section labels only: never put private values or arbitrary metadata
    // keys into diagnostic messages. A mismatch remains a refusal, not a repair.
    const known = [
      "company",
      "forge_binding",
      "modules",
      "organization_generation",
      "organization_kind",
      ...shared,
    ];
    const changed = (key: string) =>
      Object.hasOwn(projectedLegacy, key) !==
        Object.hasOwn(projected.projection, key) ||
      (Object.hasOwn(projectedLegacy, key) &&
        organizationDocumentHash(projectedLegacy[key]) !==
          organizationDocumentHash(projected.projection[key]));
    const sections = known.filter(changed);
    if (
      [
        ...new Set([
          ...Object.keys(projectedLegacy),
          ...Object.keys(projected.projection),
        ]),
      ].some((key) => !known.includes(key) && changed(key))
    )
      sections.push("other-metadata");
    throw new OrganizationProjectionConflict(sections);
  }
  return Object.freeze({
    kind: "conversion-draft" as const,
    canonical: inspected.canonical,
    legacyHash,
    modulesHash: organizationDocumentHash(modules),
    normalizations: Object.freeze(
      materializeBranch
        ? [
            "company.default_branch from forge_binding.repository.default_branch",
          ]
        : [],
    ),
  });
}
