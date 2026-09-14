import { inspectOwnedDirectory } from "../folder/owned-directory";
import { organizationDocumentHash } from "./document-hash";
import { prepareOrganizationConversion } from "./prepare-conversion";
import { readOrganizationDocuments } from "./read-documents";

// Read-only explicit migration preview, never normal runtime fallback. Repeated
// observation detects drift; it is not an atomic snapshot or permission to write.
export async function inspectOrganizationConversion(directory: string) {
  const blocked = (reason: string) =>
    Object.freeze({ kind: "blocked" as const, reason });
  try {
    const before = await inspectOwnedDirectory(directory);
    const documents = await readOrganizationDocuments(directory);
    if (documents.kind !== "documents-observed")
      return blocked("documents-unavailable");
    if (documents.canonical.kind !== "missing")
      return blocked("canonical-target-occupied");
    if (
      documents.legacy.kind !== "present" ||
      documents.modules.kind !== "present"
    )
      return blocked("legacy-and-inventory-required");
    let draft: ReturnType<typeof prepareOrganizationConversion>;
    try {
      draft = prepareOrganizationConversion(
        documents.legacy.value,
        documents.modules.value,
      );
    } catch {
      return blocked("declaration-reconciliation-required");
    }
    const current = await readOrganizationDocuments(directory);
    const after = await inspectOwnedDirectory(directory);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      organizationDocumentHash(documents) !== organizationDocumentHash(current)
    )
      return blocked("organization-changed");
    return draft;
  } catch {
    return blocked("inspection-unavailable");
  }
}
