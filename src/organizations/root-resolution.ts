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

// Execution admission policy, one home. `legacy` (only the deprecated projection)
// is never executable here; `transition` requires exact projection parity;
// `current` executes from the canonical file alone. Drift, conflict and missing
// refuse. Consuming the upstream resolver envelope directly replaces this table.
export function isExecutableOrganizationState(
  state: OrganizationRootState,
): boolean {
  return state === "transition" || state === "current";
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
  } else if (canonical.kind !== "present") state = "legacy";
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
