import { organizationDocumentHash } from "./document-hash";
import { expectedLegacyProjection } from "./legacy-projection";
import { prepareOrganizationConversion } from "./prepare-conversion";
import { readOrganizationDocuments } from "./read-documents";

// Interim, canonical-first implementation of the upstream Lazurio Core root
// resolution (manual/lazurio-manifest-family.md "Compatibility states";
// lazurio/core/organization-activation-lib.mjs resolveOrganizationRootDocuments).
// `lazurio.organization.json` is the only Organization authority. `company.gen3.json`
// is consulted solely as the generated compatibility projection for the parity
// gate while it still exists; it disappears at finalization and never becomes a
// second authority, fallback or schema. The projection digest reuses the same
// deterministic generator and sha256-canonical-json-v1 digest the conversion
// preview already pins, so this adds no second schema. A state is never chosen
// silently: anything unreadable, malformed or divergent is `conflict`.
export const organizationRootStates = Object.freeze([
  "legacy",
  "transition",
  "projection_drift",
  "conflict",
  "current",
  "missing",
] as const);
export type OrganizationRootState = (typeof organizationRootStates)[number];

// Execution admission policy, one home. Only parity-valid `transition` executes
// in this interim. `legacy` (only the deprecated projection) never executes
// here. `current` (canonical file alone) stays diagnostically readable but is
// not executable: the root contract (decision 0145, manual
// lazurio-manifest-family "Compatibility states") lets the projection disappear
// only after `lazurio migrate organization-manifest --finalize` has gated every
// mutation-capable reader, and a valid digest proves the projection's content,
// not that finalization happened. `current` becomes executable only once the
// pinned Core envelope carries an explicit, verified finalization admission
// signal. Drift, conflict and missing refuse.
export function isExecutableOrganizationState(
  state: OrganizationRootState,
): boolean {
  return state === "transition";
}

type Data = Readonly<Record<string, unknown>>;
function isRecord(value: unknown): value is Data {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

// Structural normalization gates mirrored from the upstream Core resolver
// (`normalizeModulesManifest`, `normalizeLegacyOrganization`) with the same
// issue codes: a parseable but structurally invalid document is `conflict`,
// never a silently accepted root. Absent `organization_kind` defaults to
// `organization` exactly as upstream does. Identity cross-checks and alias
// validation stay with the conversion inventory; this gate is deliberately
// narrower, never wider, than upstream.
export function modulesManifestIssues(value: unknown): string[] {
  if (!isRecord(value)) return ["modules_manifest_missing"];
  const issues: string[] = [];
  const generationSupported =
    (value.organization_generation === undefined ||
      value.organization_generation === "gen3") &&
    (value.schema_version === undefined ||
      value.schema_version === "companiesascode.modules.v1" ||
      value.schema_version === "modules.manifest.v3");
  if (!generationSupported) issues.push("modules_manifest_schema_unsupported");
  if (!Array.isArray(value.module_slots))
    issues.push("modules_manifest_slots_invalid");
  else
    value.module_slots.forEach((slot, index) => {
      if (!isRecord(slot) || typeof slot.path !== "string" || slot.path === "")
        issues.push(`modules_manifest_slot_${index}_path_invalid`);
    });
  const company = text(value.company);
  if (!company || company !== value.company)
    issues.push("modules_manifest_company_missing");
  const locator = text(value.github_org);
  if (!locator || locator !== value.github_org)
    issues.push("modules_manifest_forge_locator_missing");
  return issues;
}

export function legacyManifestIssues(value: unknown): string[] {
  if (!isRecord(value)) return ["legacy_manifest_invalid"];
  const issues: string[] = [];
  if (
    value.organization_generation !== "gen3" ||
    (value.schema_version !== undefined &&
      value.schema_version !== "company.gen3.v3")
  )
    issues.push("legacy_manifest_schema_unsupported");
  const kind = value.organization_kind ?? "organization";
  if (kind !== "organization" && kind !== "template")
    issues.push("organization_kind_invalid");
  const company = isRecord(value.company) ? value.company : null;
  const slug = text(company?.slug);
  const displayName = text(company?.display_name) || slug;
  const locator = text(company?.github_org);
  if (!company || !slug || !displayName || !locator)
    issues.push("legacy_organization_identity_invalid");
  if (value.module_port_pool === null)
    issues.push("legacy_module_port_pool_invalid");
  return issues;
}

type Documents = Extract<
  Awaited<ReturnType<typeof readOrganizationDocuments>>,
  { kind: "documents-observed" }
>;

// Pure state derivation over already acquired documents; no filesystem access.
export function resolveOrganizationRootDocuments(documents: Documents) {
  const issues: string[] = [];
  for (const name of ["canonical", "legacy", "modules"] as const)
    if (documents[name].kind === "invalid")
      issues.push(`${name}_document_unreadable`);
  const canonical = documents.canonical;
  const legacy = documents.legacy;
  const modules = documents.modules;
  let state: OrganizationRootState = "missing";
  if (issues.length) state = "conflict";
  else if (canonical.kind !== "present" && legacy.kind !== "present")
    state = "missing";
  else if (modules.kind !== "present") {
    state = "conflict";
    issues.push("modules_manifest_missing");
  } else if (structuralIssues(legacy, modules.value, issues))
    state = "conflict";
  else if (canonical.kind !== "present") state = "legacy";
  else {
    let expected: ReturnType<typeof expectedLegacyProjection> | null = null;
    try {
      expected = expectedLegacyProjection(canonical.value, modules.value);
    } catch {
      issues.push("canonical_manifest_invalid");
    }
    if (!expected) state = "conflict";
    else if (!expected.declaredHashMatches) {
      state = "conflict";
      issues.push("canonical_projection_hash_invalid");
    } else if (legacy.kind !== "present") state = "current";
    else if (organizationDocumentHash(legacy.value) === expected.hash)
      state = "transition";
    else if (semanticParity(legacy.value, modules.value, expected.hash)) {
      state = "projection_drift";
      issues.push("legacy_projection_drift");
    } else {
      state = "conflict";
      issues.push("normalized_semantics_conflict");
    }
  }
  return Object.freeze({
    state,
    executable: isExecutableOrganizationState(state),
    issues: Object.freeze([...new Set(issues)].sort()),
  });
}

// Upstream normalizes every present document before assigning a state; a
// structurally invalid modules or legacy document is `conflict` regardless of
// which other documents exist.
function structuralIssues(
  legacy: Documents["legacy"],
  modules: unknown,
  issues: string[],
): boolean {
  issues.push(...modulesManifestIssues(modules));
  if (legacy.kind === "present")
    issues.push(...legacyManifestIssues(legacy.value));
  return issues.length > 0;
}

// Interim semantic comparison: the legacy document must round-trip through the
// existing pure conversion to a canonical draft whose deterministic projection
// equals the canonical manifest's. Upstream compares normalized resources;
// this round trip recognizes drift only where parity is proven and classifies
// every other divergence as conflict, which is stricter, never looser.
function semanticParity(
  legacy: unknown,
  modules: unknown,
  expectedHash: string,
): boolean {
  try {
    const draft = prepareOrganizationConversion(legacy, modules);
    return (
      expectedLegacyProjection(draft.canonical, modules).hash === expectedHash
    );
  } catch {
    return false;
  }
}

// Directory resolution for runtime consumers. Never inspects descendants, writes,
// migrates or repairs; `unavailable` (no documents observed) is not a state.
export async function resolveOrganizationRoot(directory: string) {
  const documents = await readOrganizationDocuments(directory);
  if (documents.kind !== "documents-observed")
    return Object.freeze({ kind: "unavailable" as const });
  return Object.freeze({
    kind: "root-resolved" as const,
    ...resolveOrganizationRootDocuments(documents),
    documents,
  });
}
