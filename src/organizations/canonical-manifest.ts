import { array, object, text } from "../modules/manifest";
import { snapshotOrganizationDocument } from "./document-hash";

const positiveId = /^[1-9][0-9]{0,19}$/;
const login = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const companyReserved = [
  "slug",
  "display_name",
  "github_org",
  "repository",
  "git_url",
  "root_repository",
  "default_branch",
];
const legacyReserved = [
  "organization_generation",
  "organization_kind",
  "company",
  "forge_binding",
  "governance",
  "teams",
  "layers",
  "task_sources",
  "doctor",
  "module_port_pool",
  "modules",
  "default_branch",
];

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Organization object required");
  return value as Record<string, unknown>;
}
function exactText(value: unknown) {
  const result = text(value, /\S/);
  if (result.trim() !== result)
    throw new Error("Exact Organization text required");
  return result;
}
function binding(input: unknown, repository: boolean) {
  const id = repository ? "repository_id" : "organization_id";
  const value = object(
    input,
    [
      "forge",
      "locator",
      "binding_state",
      ...(repository ? ["default_branch"] : []),
    ],
    [id],
  );
  if (
    value.forge !== "github" ||
    (repository && value.default_branch !== "main")
  )
    throw new Error("Unsupported Organization binding");
  text(
    value.locator,
    repository ? /^(?!.*\.git$)[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/ : login,
  );
  if (value.binding_state === "verified") text(value[id], positiveId);
  else if (value.binding_state !== "unverified" || Object.hasOwn(value, id))
    throw new Error("Invalid Organization binding state");
  return value;
}

// Existing canonical wire schema plus root-binding cross-field invariants.
// This does not resolve legacy documents, validate the projection hash or grant access.
export function parseCanonicalOrganization(input: unknown) {
  // Reject executable/lossy values before cloning Organization-owned extension data.
  const value = object(
    snapshotOrganizationDocument(input),
    [
      "schema_version",
      "kind",
      "organization",
      "manifests",
      "extensions",
      "compatibility",
    ],
    [
      "root_repository",
      "module_port_pool",
      "governance",
      "teams",
      "layers",
      "task_sources",
      "doctor",
    ],
  );
  if (
    value.schema_version !== "lazurio.organization.v1" ||
    !["organization", "template"].includes(value.kind as string)
  )
    throw new Error("Unsupported Organization manifest");
  const organization = object(value.organization, [
    "slug",
    "display_name",
    "forge_binding",
    "metadata",
  ]);
  exactText(organization.slug);
  exactText(organization.display_name);
  const metadata = record(organization.metadata);
  if (companyReserved.some((key) => Object.hasOwn(metadata, key)))
    throw new Error("Organization metadata collision");
  const owner = binding(organization.forge_binding, false);
  const root =
    value.root_repository === undefined || value.root_repository === null
      ? null
      : binding(value.root_repository, true);
  if (root === null) {
    if (owner.binding_state === "verified")
      throw new Error("Verified Organization requires root binding");
  } else {
    const ownerName = owner.locator as string;
    const rootName = root.locator as string;
    if (
      owner.binding_state !== root.binding_state ||
      rootName.split("/")[0]?.toLowerCase() !== ownerName.toLowerCase()
    )
      throw new Error("Organization root binding mismatch");
    // Existing verified GEN3 compatibility contract, not a newly invented root name.
    if (
      owner.binding_state === "verified" &&
      rootName.toLowerCase() !== `${ownerName}/${ownerName}_GEN3`.toLowerCase()
    )
      throw new Error("Verified Organization root naming mismatch");
  }
  if (object(value.manifests, ["modules"]).modules !== "modules.manifest.json")
    throw new Error("Unsupported modules pointer");
  const extensions = object(value.extensions, ["legacy"]);
  if (
    legacyReserved.some((key) => Object.hasOwn(record(extensions.legacy), key))
  )
    throw new Error("Organization extension collision");
  const projection = object(
    object(value.compatibility, ["legacy_projection"]).legacy_projection,
    ["path", "algorithm", "sha256"],
  );
  if (
    projection.path !== "company.gen3.json" ||
    projection.algorithm !== "sha256-canonical-json-v1"
  )
    throw new Error("Unsupported projection contract");
  text(projection.sha256, /^sha256:[0-9a-f]{64}$/);
  if (value.module_port_pool !== undefined) {
    const pool = object(value.module_port_pool, ["start", "end"]);
    for (const port of [pool.start, pool.end])
      if (
        typeof port !== "number" ||
        !Number.isInteger(port) ||
        port < 1024 ||
        port > 65535
      )
        throw new Error("Invalid Organization port pool");
    if ((pool.start as number) > (pool.end as number))
      throw new Error("Inverted Organization port pool");
  }
  if (value.governance !== undefined) {
    const governance = record(value.governance);
    if (
      (Object.hasOwn(governance, "default_branch") &&
        governance.default_branch !== "main") ||
      (Object.hasOwn(governance, "access_authority") &&
        governance.access_authority !== "github")
    )
      throw new Error("Unsupported Organization governance");
  }
  if (value.doctor !== undefined) record(value.doctor);
  for (const field of ["layers", "task_sources"])
    if (value[field] !== undefined) array(value[field]);
  if (value.teams !== undefined)
    for (const inputTeam of array(value.teams)) {
      const team = record(inputTeam);
      // Team entries allow Organization-owned extension fields under the existing schema.
      if (
        typeof team.slug !== "string" ||
        !team.slug.length ||
        typeof team.display_name !== "string" ||
        !team.display_name.length
      )
        throw new Error("Invalid Organization team");
      if (Object.hasOwn(team, "default") && typeof team.default !== "boolean")
        throw new Error("Invalid team default");
      if (
        Object.hasOwn(team, "description") &&
        typeof team.description !== "string"
      )
        throw new Error("Invalid team description");
      if (Object.hasOwn(team, "forge_binding")) {
        const teamBinding = object(team.forge_binding, [
          "schema_version",
          "provider",
          "team",
        ]);
        if (
          teamBinding.schema_version !==
            "lazurio.team-forge-binding.github.v0" ||
          teamBinding.provider !== "github"
        )
          throw new Error("Unsupported team binding");
        const identity = object(teamBinding.team, ["id", "asserted_slug"]);
        text(identity.id, positiveId);
        text(identity.asserted_slug, /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/);
      }
    }
  return Object.freeze(value);
}
