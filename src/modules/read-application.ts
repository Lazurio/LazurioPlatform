import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { inspectCheckoutDirectory } from "../folder/owned-directory";
import { readCheckoutJson as readDeclaration } from "../providers/owned-json";
import { selectModuleApplication } from "./manifest";
import { parsePreparationDeclaration } from "./preparation-declaration";
import { planModuleRuntime } from "./runtime";

// Read-only adapter for an explicitly selected, stable, caller-owned module.
// This is neither Organization discovery nor an authorization/process lease.
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Declaration object required");
  return value as Record<string, unknown>;
}

export async function readModuleApplication(
  moduleDirectory: string,
  requestedPackage?: string,
) {
  if (process.platform === "win32")
    throw new Error("Unqualified module reader platform");
  const root = await inspectCheckoutDirectory(moduleDirectory);
  const manifest = await readDeclaration(
    join(moduleDirectory, "lazurio.module.json"),
  );
  const selection = selectModuleApplication(manifest, requestedPackage);
  if (selection.kind !== "selected") return selection;
  const byDefault = selectModuleApplication(manifest);
  const packagePath = join(moduleDirectory, selection.package);
  // Check each intermediate directory, not just the final package parent.
  let directory = moduleDirectory;
  const parents = dirname(selection.package);
  if (parents !== ".")
    for (const segment of parents.split("/")) {
      directory = join(directory, segment);
      await inspectCheckoutDirectory(directory);
    }
  const pkg = record(await readDeclaration(packagePath));
  if (pkg.companyascode && Object.hasOwn(record(pkg.companyascode), "app"))
    throw new Error("Legacy app declaration requires explicit adoption");
  const metadata = record(pkg.lazurio);
  const runtime = metadata.runtime;
  const preparation = Object.hasOwn(metadata, "preparation")
    ? parsePreparationDeclaration(metadata.preparation)
    : null;
  const plan = planModuleRuntime(
    manifest,
    runtime,
    selection.package,
    pkg.scripts,
  );
  const after = await inspectCheckoutDirectory(moduleDirectory);
  if (after.dev !== root.dev || after.ino !== root.ino)
    throw new Error("Module directory changed");
  return Object.freeze({
    ...plan,
    // The module's declared default app: the one the gateway serves at the
    // module's hostname (launchpad-parity B4, B5).
    defaultApp:
      byDefault.kind === "selected" && byDefault.package === selection.package,
    preparation,
    // Include package hooks/toolchain/dependencies, not only the selected script.
    // This is a local change detector, never a publisher or authority proof.
    declarationDigest: createHash("sha256")
      .update(JSON.stringify({ manifest, pkg }))
      .digest("hex"),
  });
}
