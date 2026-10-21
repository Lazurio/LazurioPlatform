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
  // The module's declared default app: the one the gateway serves at the
  // module's hostname (launchpad-parity B4, B5).
  const defaultApp =
    byDefault.kind === "selected" && byDefault.package === selection.package;
  return Object.freeze({
    ...plan,
    defaultApp,
    preparation,
    // Include package hooks/toolchain/dependencies, not only the selected script.
    // This is a local change detector, never a publisher or authority proof.
    declarationDigest: createHash("sha256")
      .update(JSON.stringify({ manifest, pkg }))
      .digest("hex"),
    // What a static app's server depends on (decision F58): its identity,
    // its listeners (address, protocol, health) and its fallback, never the
    // rest of its package. A built run carries this digest, so a pull that
    // changes only the package (a dependency, its version) leaves the
    // running static server current, and its new build is served without a
    // restart. Null for an app without a static output.
    staticDigest:
      plan.runtime.static === null
        ? null
        : createHash("sha256")
            .update(
              JSON.stringify({
                schema: "lazurio.static-serving.v1",
                id: plan.runtime.id,
                company: plan.runtime.company,
                module: plan.runtime.module,
                listeners: plan.listeners,
                fallback: plan.runtime.static.fallback,
              }),
            )
            .digest("hex"),
    // What an app's own server depends on when it runs from `main` (decision
    // F58, addendum of 2026-10-21): its identity, its listeners, the command
    // it runs, the output it is handed, whether it is told its origin and the
    // names of the secrets and siblings it is given, never the rest of its
    // package. So a pull that changes only a dependency leaves the running
    // server current until the restart onto its new build (#570). Null for
    // an app without `start_script`.
    serverDigest:
      plan.runtime.server === null
        ? null
        : createHash("sha256")
            .update(
              JSON.stringify({
                schema: "lazurio.server-run.v1",
                id: plan.runtime.id,
                company: plan.runtime.company,
                module: plan.runtime.module,
                listeners: plan.listeners,
                start: [
                  plan.runtime.server.start_script,
                  record(pkg.scripts)[plan.runtime.server.start_script],
                ],
                output: plan.runtime.server.build?.output ?? null,
                // Told its external origin only as the module's default app.
                defaultApp,
                secrets: plan.runtime.secrets,
                optional: plan.runtime.optional_secrets,
                slots: plan.runtime.optional.required_module_slots ?? null,
              }),
            )
            .digest("hex"),
  });
}
