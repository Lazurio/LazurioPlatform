import { inspectCanonicalInventory } from "../organizations/canonical-inventory";
import { expectedLegacyProjection } from "../organizations/legacy-projection";
import { resolveOrganizationRootDocuments } from "../organizations/root-resolution";
import {
  canonicalJson,
  type DataSlot,
  insertModuleSlotText,
  ModuleScaffoldError,
  type ModuleSlot,
} from "./scaffold";

// The declaration of a new module in an Organization root (decision F52's
// addendum of 2026-10-14, #267): its slots go into `modules.manifest.json`
// byte for byte, and the root's compatibility projection follows them, so
// the root still resolves as before. Since root decision 0145 a root in
// `transition` carries `company.gen3.json`, a projection generated from
// `lazurio.organization.json` and `modules.manifest.json`, and the
// canonical manifest names that projection's digest
// (`compatibility.legacy_projection.sha256`). A new slot changes the
// projection; without the two follow-ups the root would resolve `conflict`
// (`canonical_projection_hash_invalid`) and stop executing after the merge.
// The root's generator left this to `lazurio migrate organization-manifest
// --write`, which a Platform-only Environment does not have. This writes
// what that command writes: the projection `JSON.stringify(…, null, 2)` with
// a final newline, and only the digest's string in the canonical manifest.
// Pure: texts in, texts out; nothing is read or written here.

export type OrganizationDocumentTexts = Readonly<{
  /** `lazurio.organization.json`. */
  canonical: string;
  /** `modules.manifest.json`. */
  modules: string;
  /** `company.gen3.json`, or null where the root has none (`current`). */
  legacy: string | null;
}>;

const refused = (message: string) =>
  new ModuleScaffoldError(
    "manifest_insert_failed",
    `${message} The Organization's documents were left unchanged.`,
  );

/**
 * The Organization root's three documents with `slots` declared, in order,
 * and the projection regenerated. Verified before it is returned: the root
 * resolves to the state it had (`transition` or `current`) with no issue,
 * and no declaration issue names a new slot. Throws `ModuleScaffoldError`
 * (`manifest_invalid`, `manifest_insert_failed`, `slot_exists`) otherwise.
 */
export function declareOrganizationSlots(
  texts: OrganizationDocumentTexts,
  slots: readonly (ModuleSlot | DataSlot)[],
): OrganizationDocumentTexts {
  let canonical: unknown;
  try {
    canonical = JSON.parse(texts.canonical);
  } catch (error) {
    throw new ModuleScaffoldError(
      "manifest_invalid",
      `lazurio.organization.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const before = resolve(canonical, texts.modules, texts.legacy);
  if (!before.executable || before.issues.length > 0)
    throw new ModuleScaffoldError(
      "manifest_invalid",
      `The Organization root resolves ${before.state}${before.issues.length > 0 ? ` (${before.issues.join(", ")})` : ""}; a slot is declared only in a root that resolves cleanly.`,
    );
  const modules = slots.reduce(
    (text, slot) => insertModuleSlotText(text, slot),
    texts.modules,
  );
  const modulesDocument = JSON.parse(modules) as { module_slots: unknown[] };
  let projection: ReturnType<typeof expectedLegacyProjection>;
  try {
    projection = expectedLegacyProjection(canonical, modulesDocument);
  } catch {
    throw refused("The Organization's projection could not be generated.");
  }
  const previous = (
    canonical as {
      compatibility: { legacy_projection: { sha256: string } };
    }
  ).compatibility.legacy_projection.sha256;
  const nextCanonical = replaceOnce(texts.canonical, previous, projection.hash);
  const expected = structuredClone(canonical) as {
    compatibility: { legacy_projection: { sha256: string } };
  };
  expected.compatibility.legacy_projection.sha256 = projection.hash;
  if (canonicalJson(JSON.parse(nextCanonical)) !== canonicalJson(expected))
    throw refused(
      "The projection's digest could not be replaced in lazurio.organization.json verifiably.",
    );
  const legacy =
    texts.legacy === null
      ? null
      : `${JSON.stringify(projection.projection, null, 2)}\n`;
  const after = resolve(JSON.parse(nextCanonical), modules, legacy);
  if (after.state !== before.state || after.issues.length > 0)
    throw refused(
      `With the slot the root would resolve ${after.state}${after.issues.length > 0 ? ` (${after.issues.join(", ")})` : ""}.`,
    );
  // A declaration issue that names a new slot (a colliding id or path, a
  // data slot without its module): the root resolves, but the slot would
  // not be a module.
  const inventory = inspectCanonicalInventory(
    JSON.parse(nextCanonical),
    modulesDocument,
  ).inventory;
  const added = new Set(
    slots.map((slot) =>
      modulesDocument.module_slots.findIndex(
        (entry) => (entry as { path?: unknown })?.path === slot.path,
      ),
    ),
  );
  const named = inventory.issues.filter((issue) =>
    issue.indices.some((index) => added.has(index)),
  );
  if (named.length > 0)
    throw new ModuleScaffoldError(
      "slot_exists",
      `The new slot conflicts with the Organization's declarations (${named.map((issue) => issue.code).join(", ")}).`,
      "Choose another slug for the module.",
    );
  return Object.freeze({ canonical: nextCanonical, modules, legacy });
}

function resolve(canonical: unknown, modules: string, legacy: string | null) {
  const present = (value: unknown) =>
    Object.freeze({
      kind: "present" as const,
      value: value as Readonly<Record<string, unknown>>,
    });
  let modulesValue: unknown;
  let legacyValue: unknown;
  try {
    modulesValue = JSON.parse(modules);
    legacyValue = legacy === null ? null : JSON.parse(legacy);
  } catch (error) {
    throw new ModuleScaffoldError(
      "manifest_invalid",
      `An Organization document is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return resolveOrganizationRootDocuments({
    kind: "documents-observed",
    canonical: present(canonical),
    legacy:
      legacy === null
        ? Object.freeze({ kind: "missing" as const })
        : present(legacyValue),
    modules: present(modulesValue),
  });
}

// `"<from>"` replaced by `"<to>"`, where the text holds it exactly once.
function replaceOnce(text: string, from: string, to: string): string {
  const needle = JSON.stringify(from);
  const first = text.indexOf(needle);
  if (first < 0 || text.indexOf(needle, first + needle.length) >= 0)
    throw refused(
      "lazurio.organization.json does not name the projection's digest exactly once.",
    );
  return `${text.slice(0, first)}${JSON.stringify(to)}${text.slice(first + needle.length)}`;
}
