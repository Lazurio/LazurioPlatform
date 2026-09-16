import { join } from "node:path";
import { inspectOwnedDirectory } from "../folder/owned-directory";
import { object, parseModuleManifest, text } from "../modules/manifest";
import { readModuleApplication } from "../modules/read-application";
import { readOwnedJson } from "../providers/owned-json";
import { inspectCanonicalInventory } from "./canonical-inventory";
import { organizationDocumentHash } from "./document-hash";
import { readCanonicalDocuments } from "./read-documents";

// Resolve a selection against the live inventory, never a caller-supplied path.
// Local composition must invoke this again at each operation boundary. The
// result is not provider permission, a lock, or a durable execution capability.
export async function resolveOrganizationApplication(
  directory: string,
  input: unknown,
) {
  const value = object(input, ["company", "module", "package"]);
  const company = text(value.company, /^[A-Za-z0-9][A-Za-z0-9-]*$/);
  const module = text(value.module, /^[a-z0-9][a-z0-9-]*$/);
  const pkg = text(value.package, /\S/);
  const observed = await readOrganizationApplications(directory);
  if (observed.kind !== "applications-observed" || observed.company !== company)
    throw new Error("Selected Organization unavailable");
  const matches = observed.entries.filter((entry) => entry.module === module);
  const entry = matches[0];
  if (
    matches.length !== 1 ||
    !entry ||
    entry.kind !== "module-observed" ||
    !entry.apps.some(
      (app) => app.package === pkg && app.kind === "runtime-declared",
    )
  )
    throw new Error("Selected application unavailable");
  return Object.freeze({ moduleDirectory: join(directory, entry.path) });
}

// Local declaration observation, not provider access, readiness, or a launch grant.
// The caller selects a permitted Organization directory; no recursive disk scan,
// legacy projection, persisted catalog or per-module special cases are introduced.
export async function readOrganizationApplications(directory: string) {
  const unavailable = () => Object.freeze({ kind: "unavailable" as const });
  try {
    const before = await inspectOwnedDirectory(directory);
    const documents = await readCanonicalDocuments(directory);
    if (documents.kind !== "documents-observed") return unavailable();
    if (
      documents.canonical.kind !== "present" ||
      documents.modules.kind !== "present"
    )
      return Object.freeze({ kind: "canonical-documents-required" as const });
    const inventory = inspectCanonicalInventory(
      documents.canonical.value,
      documents.modules.value,
    );
    // The canonical manifest family excludes template roots from runtime.
    // Keep parsing/preview available, but do not inspect or authorize their apps.
    if (inventory.canonical.kind !== "organization")
      return Object.freeze({ kind: "template-not-runtime" as const });
    const company = (inventory.canonical.organization as { slug: string }).slug;
    const conflicted = new Set(
      inventory.inventory.issues.flatMap((issue) => issue.indices),
    );
    const entries = [];
    for (const slot of inventory.inventory.slots) {
      if (slot?.scope !== "workspace" || slot.nestedDatabase) continue;
      const identity = { module: slot.id, path: slot.path };
      if (conflicted.has(slot.index) || slot.id === null) {
        entries.push(
          Object.freeze({ ...identity, kind: "declaration-conflict" as const }),
        );
        continue;
      }
      try {
        // Inspect each parent; do not follow an Organization's workspace symlink.
        let path = directory;
        for (const segment of slot.path.split("/")) {
          path = join(path, segment);
          await inspectOwnedDirectory(path);
        }
        const moduleBefore = await inspectOwnedDirectory(path);
        const manifest = await readOwnedJson(join(path, "lazurio.module.json"));
        const module = parseModuleManifest(manifest);
        if (module.company !== company || module.id !== slot.id)
          throw new Error("Module identity conflict");
        if (module.apps === null) {
          entries.push(
            Object.freeze({
              ...identity,
              kind: "explicit-apps-required" as const,
            }),
          );
          continue;
        }
        const apps = [];
        for (const pkg of module.apps) {
          try {
            const app = await readModuleApplication(path, pkg);
            if (
              app.kind !== "declared-runtime-plan" ||
              app.runtime.company !== company ||
              app.runtime.module !== slot.id
            )
              throw new Error("Application declaration unavailable");
            apps.push(
              Object.freeze({
                package: pkg,
                kind: "runtime-declared" as const,
              }),
            );
          } catch {
            apps.push(
              Object.freeze({ package: pkg, kind: "invalid-runtime" as const }),
            );
          }
        }
        const after = await inspectOwnedDirectory(path);
        if (
          moduleBefore.dev !== after.dev ||
          moduleBefore.ino !== after.ino ||
          organizationDocumentHash(manifest) !==
            organizationDocumentHash(
              await readOwnedJson(join(path, "lazurio.module.json")),
            )
        )
          throw new Error("Module changed during observation");
        entries.push(
          Object.freeze({
            ...identity,
            kind: "module-observed" as const,
            defaultApp: module.default_app,
            apps: Object.freeze(apps),
          }),
        );
      } catch {
        entries.push(
          Object.freeze({ ...identity, kind: "module-unavailable" as const }),
        );
      }
    }
    const after = await inspectOwnedDirectory(directory);
    const current = await readCanonicalDocuments(directory);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      organizationDocumentHash(documents) !== organizationDocumentHash(current)
    )
      return Object.freeze({ kind: "organization-changed" as const });
    return Object.freeze({
      kind: "applications-observed" as const,
      company,
      entries: Object.freeze(entries),
      issues: inventory.inventory.issues,
      warnings: inventory.warnings,
    });
  } catch {
    // No raw manifest content, environment, script or filesystem error in output.
    return unavailable();
  }
}
