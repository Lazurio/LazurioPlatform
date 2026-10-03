import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { inspectCheckoutDirectory } from "../folder/owned-directory";
import { object, parseModuleManifest, text } from "../modules/manifest";
import { readModuleApplication } from "../modules/read-application";
import {
  type CheckoutReason,
  checkoutRefusal,
} from "../providers/checkout-custody";
import { readCheckoutJson } from "../providers/owned-json";
import { inspectCanonicalInventory } from "./canonical-inventory";
import { organizationDocumentHash } from "./document-hash";
import { organizationDocumentFiles } from "./read-documents";
import {
  organizationRepositoryPaths,
  rootApplicationPaths,
} from "./repository-slots";
import { resolveOrganizationRoot } from "./root-resolution";

// Resolve a selection against the live inventory, never a caller-supplied path.
// Local composition must invoke this again at each operation boundary. The
// result is not provider permission, a lock, or a durable execution capability.
// Execution admission is bound to the root resolution state through the one
// admission rule (`isExecutableOrganizationState` in root-resolution): every
// state it does not admit, an unresolvable root and a template refuse
// fail-closed before any descendant inspection, lock, preparation, script start
// or write.
export async function resolveOrganizationApplication(
  directory: string,
  input: unknown,
) {
  const value = object(input, ["company", "module", "package"]);
  const company = text(value.company, /^[A-Za-z0-9][A-Za-z0-9-]*$/);
  const module = text(value.module, /^[a-z0-9][a-z0-9-]*$/);
  const pkg = text(value.package, /\S/);
  const observed = await readOrganizationApplications(directory, {
    admission: "executable",
  });
  if (
    observed.kind !== "applications-observed" ||
    observed.admission !== "executable" ||
    observed.company !== company
  )
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
// legacy fallback, persisted catalog or per-module special cases are introduced.
// Canonical-first: the listing is read from `lazurio.organization.json`; the
// deprecated `company.gen3.json` is consulted only by the root resolution parity
// gate. With the default `inspection-only` admission a root the admission rule
// does not execute (`projection_drift`, and `current` under the transition-only
// variant) is still listed (canonical read stays available) but marked not
// executable; with `executable` admission it ends before descendants.
export async function readOrganizationApplications(
  directory: string,
  options: { admission: "inspection-only" | "executable" } = {
    admission: "inspection-only",
  },
) {
  return (await observeOrganizationApplications(directory, options)).result;
}

// The same observation together with the canonical and inventory documents it
// was made from, for a consumer that shows more of the same declarations (the
// Folder catalog: display name, Teams). The documents are exactly the ones the
// final recheck compared, so nothing is read a second time.
export async function observeOrganizationApplications(
  directory: string,
  options: { admission: "inspection-only" | "executable" } = {
    admission: "inspection-only",
  },
) {
  const unavailable = () =>
    Object.freeze({
      result: Object.freeze({ kind: "unavailable" as const }),
      documents: null,
    });
  const without = <T>(result: T) => Object.freeze({ result, documents: null });
  try {
    const before = await inspectCheckoutDirectory(directory);
    const resolved = await resolveOrganizationRoot(directory);
    if (resolved.kind !== "root-resolved") return unavailable();
    const resolution = Object.freeze({
      state: resolved.state,
      issues: resolved.issues,
    });
    if (resolved.state === "missing" || resolved.state === "legacy")
      return without(
        Object.freeze({
          kind: "canonical-documents-required" as const,
          resolution,
        }),
      );
    if (resolved.state === "conflict") {
      // A document the checkout rule refused is named by its rule and file
      // (decision F23) instead of the general conflict.
      const refused = (["canonical", "legacy", "modules"] as const).flatMap(
        (name) => {
          const document = resolved.documents[name];
          return document.kind === "invalid" && document.refused !== undefined
            ? [
                Object.freeze({
                  reason: document.refused,
                  file: organizationDocumentFiles[name],
                }),
              ]
            : [];
        },
      )[0];
      return without(
        Object.freeze({
          kind: "organization-conflict" as const,
          resolution,
          ...(refused === undefined ? {} : { refused }),
        }),
      );
    }
    if (options.admission === "executable" && !resolved.executable)
      return without(
        Object.freeze({
          kind: "organization-not-executable" as const,
          resolution,
        }),
      );
    const { documents } = resolved;
    if (
      documents.canonical.kind !== "present" ||
      documents.modules.kind !== "present"
    )
      return unavailable();
    const inventory = inspectCanonicalInventory(
      documents.canonical.value,
      documents.modules.value,
    );
    // The canonical manifest family excludes template roots from runtime.
    // Keep parsing/preview available, but do not inspect or authorize their apps.
    if (inventory.canonical.kind !== "organization")
      return without(
        Object.freeze({
          kind: "template-not-runtime" as const,
          resolution,
        }),
      );
    const company = (inventory.canonical.organization as { slug: string }).slug;
    const conflicted = new Set(
      inventory.inventory.issues.flatMap((issue) => issue.indices),
    );
    const entries = [];
    // The declared repositories the catalog lists read-only, never modules:
    // the Organization's `infra` (root decision 0179 point 5) and its
    // productionspace repositories (root decision 0041), in declaration
    // order. A slot without a usable id or in a declaration conflict is left
    // out; its issue stays visible.
    const repositories = inventory.inventory.slots.flatMap((slot) => {
      if (!slot || slot.id === null || conflicted.has(slot.index)) return [];
      const layout =
        slot.scope === "productionspace"
          ? ("productionspace" as const)
          : slot.scope === "root" && organizationRepositoryPaths.has(slot.path)
            ? ("organization" as const)
            : null;
      return layout === null
        ? []
        : [Object.freeze({ id: slot.id, path: slot.path, layout })];
    });
    for (const slot of inventory.inventory.slots) {
      // A workspace slot is a module; a root-level application slot is one
      // only when it carries a module manifest (decision F24), never by its
      // directory alone. Other root slots and productionspace never are.
      if (!slot) continue;
      const workspace = slot.scope === "workspace" && !slot.nestedDatabase;
      const application =
        slot.scope === "root" &&
        rootApplicationPaths.has(slot.path) &&
        (await declaresModule(
          join(directory, slot.path, "lazurio.module.json"),
        ));
      if (!workspace && !application) continue;
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
          await inspectCheckoutDirectory(path);
        }
        const observed = await observeModuleDirectory(
          path,
          (module) => module.company === company && module.id === slot.id,
        );
        entries.push(
          observed.kind === "module-observed"
            ? Object.freeze({
                ...identity,
                kind: observed.kind,
                defaultApp: observed.defaultApp,
                apps: observed.apps,
              })
            : "file" in observed
              ? Object.freeze({
                  ...identity,
                  kind: observed.kind,
                  file: observed.file,
                })
              : Object.freeze({ ...identity, kind: observed.kind }),
        );
      } catch (error) {
        // A directory of the slot the checkout rule refuses (decision F23),
        // named relative to the module, or to the root above it.
        const refused = checkoutRefusal(error, [
          join(directory, slot.path),
          directory,
        ]);
        entries.push(
          refused === null
            ? Object.freeze({
                ...identity,
                kind: "module-unavailable" as const,
              })
            : Object.freeze({
                ...identity,
                kind: refused.reason,
                file: refused.file,
              }),
        );
      }
    }
    const after = await inspectCheckoutDirectory(directory);
    const current = await resolveOrganizationRoot(directory);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      current.kind !== "root-resolved" ||
      current.state !== resolved.state ||
      organizationDocumentHash(documents) !==
        organizationDocumentHash(current.documents)
    )
      return without(Object.freeze({ kind: "organization-changed" as const }));
    return Object.freeze({
      result: Object.freeze({
        kind: "applications-observed" as const,
        company,
        resolution,
        admission: resolved.executable
          ? ("executable" as const)
          : ("inspection-only" as const),
        entries: Object.freeze(entries),
        repositories: Object.freeze(repositories),
        issues: inventory.inventory.issues,
        warnings: inventory.warnings,
      }),
      documents: Object.freeze({
        canonical: inventory.canonical,
        modules: inventory.modules,
      }),
    });
  } catch (error) {
    // No raw manifest content, environment, script or filesystem error in
    // output; a refusal of the checkout rule is named (decision F23).
    const refused = checkoutRefusal(error, directory);
    return refused === null
      ? unavailable()
      : without(Object.freeze({ kind: "checkout-refused" as const, refused }));
  }
}

// Whether a module manifest is there at all: only its absence (the slot not
// checked out, or checked out without one) answers no. Anything else is read
// by the module reader, which names what it refuses.
const declaresModule = (manifest: string) =>
  lstat(manifest).then(
    () => true,
    (error: NodeJS.ErrnoException) =>
      error.code !== "ENOENT" && error.code !== "ENOTDIR",
  );

/** What a module's app says of itself for a page to show (decision F36):
 * display-only text from its `lazurio.runtime` declaration, bounded, never
 * raw file content, a path or a grant. The Module's manifest stays the
 * authority; the Launchpad only draws it. */
export type AppDisplay = Readonly<{
  /** The app's id in its declaration, at most 128 characters. */
  id: string;
  /** Its title, at most 120 characters. */
  title: string;
  /** Its one-line description, at most 240 characters (the parser's bound). */
  description?: string;
  /** Its semantic icon key, when it is one (lowercase words and dashes). */
  icon?: string;
  /** Its tags, at most 20, each at most 128 characters (a longer one is
   * left out). */
  tags: readonly string[];
}>;

function appDisplay(
  runtime: Readonly<{
    id: string;
    title: string;
    tags: readonly string[];
    optional: Readonly<Record<string, string | readonly string[]>>;
  }>,
): AppDisplay {
  const { description, icon } = runtime.optional;
  // The runtime parser bounds none of id, title or tags; the page's catalog
  // reader does (src/launchpad/catalog-view.ts), so the projection keeps to
  // those bounds and a valid declaration never makes the catalog unreadable.
  return Object.freeze({
    id: [...runtime.id].slice(0, 128).join(""),
    title: [...runtime.title].slice(0, 120).join(""),
    ...(typeof description === "string" ? { description } : {}),
    ...(typeof icon === "string" && /^[a-z0-9][a-z0-9-]{0,39}$/.test(icon)
      ? { icon }
      : {}),
    tags: Object.freeze(
      runtime.tags.filter((tag) => [...tag].length <= 128).slice(0, 20),
    ),
  });
}

/** One module directory's declaration, the reader Organization slots and the
 * Personalspace share (launchpad-parity B1, B11): `lazurio.module.json`, and
 * for each declared app whether its runtime declaration names this module,
 * unchanged during the read. `accept` is the caller's identity rule; a
 * module it refuses, and anything unreadable, throws. The caller inspects the
 * parents of `path`. No raw content leaves this function.
 *
 * These are the module's declarations (decision F23): `lazurio.module.json`
 * and the `package.json` of each app it lists. A declaration the checkout
 * rule refuses is named by its rule and module-relative file, the module's
 * when it is `lazurio.module.json`, the app's when it is the app's. */
export async function observeModuleDirectory(
  path: string,
  accept: (module: Readonly<{ id: string; company: string }>) => boolean,
) {
  const moduleBefore = await inspectCheckoutDirectory(path);
  let manifest: unknown;
  try {
    manifest = await readCheckoutJson(join(path, "lazurio.module.json"));
  } catch (error) {
    const refused = checkoutRefusal(error, path);
    if (refused === null) throw error;
    return Object.freeze({ kind: refused.reason, file: refused.file });
  }
  const module = parseModuleManifest(manifest);
  if (!accept(module)) throw new Error("Module identity conflict");
  if (module.apps === null)
    return Object.freeze({ kind: "explicit-apps-required" as const });
  const apps: Readonly<{
    package: string;
    kind: "runtime-declared" | "invalid-runtime";
    reason?: CheckoutReason;
    file?: string;
    display?: AppDisplay;
  }>[] = [];
  for (const pkg of module.apps) {
    try {
      const app = await readModuleApplication(path, pkg);
      if (
        app.kind !== "declared-runtime-plan" ||
        app.runtime.company !== module.company ||
        app.runtime.module !== module.id
      )
        throw new Error("Application declaration unavailable");
      apps.push(
        Object.freeze({
          package: pkg,
          kind: "runtime-declared" as const,
          display: appDisplay(app.runtime),
        }),
      );
    } catch (error) {
      const refused = checkoutRefusal(error, path);
      apps.push(
        Object.freeze({
          package: pkg,
          kind: "invalid-runtime" as const,
          ...(refused ?? {}),
        }),
      );
    }
  }
  const after = await inspectCheckoutDirectory(path);
  if (
    moduleBefore.dev !== after.dev ||
    moduleBefore.ino !== after.ino ||
    organizationDocumentHash(manifest) !==
      organizationDocumentHash(
        await readCheckoutJson(join(path, "lazurio.module.json")),
      )
  )
    throw new Error("Module changed during observation");
  return Object.freeze({
    kind: "module-observed" as const,
    company: module.company,
    defaultApp: module.default_app,
    apps: Object.freeze(apps),
  });
}
