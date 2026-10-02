import { dirname, join, posix } from "node:path";
import { readCheckoutJson } from "../providers/owned-json";
import { modulePreparationArgs } from "./frozen-install-process";
import {
  inspectCheckoutConfiguration,
  inspectInstallAuthority,
  inspectOwnerDirectories,
  readInstallOwner,
  verifyInstallAuthority,
} from "./install-authority";
import { parseModuleManifest } from "./manifest";
import { PreparationRefused } from "./preparation-refusal";
import { readModuleApplication } from "./read-application";
import { isDeclaredWorkspaceMember } from "./workspace-membership";

type Plan = Extract<
  Awaited<ReturnType<typeof readModuleApplication>>,
  { kind: "declared-runtime-plan" }
>;

/** The preparation in effect for an application (decision F25): its explicit
 * `lazurio.preparation`, or, when it declares none, the default: the
 * application's own package is the owner, preparing is the frozen install
 * from the lockfile beside it, and there is no prepare or check script. */
export type Preparation = Readonly<{
  kind: "declared" | "default";
  owner_package: string;
  check_script?: string;
  prepare_script?: string;
}>;

function preparationOf(plan: Plan, applicationPackage: string): Preparation {
  const declared = plan.preparation;
  if (declared === null)
    return Object.freeze({
      kind: "default" as const,
      owner_package: applicationPackage,
    });
  return Object.freeze({
    kind: "declared" as const,
    owner_package: declared.owner_package,
    check_script: declared.check_script,
    ...(declared.prepare_script === undefined
      ? {}
      : { prepare_script: declared.prepare_script }),
  });
}

// Where the owner's local `file:` dependencies may lie (decision F25): for
// the default preparation anywhere in the Organization (or Personalspace
// owner) directory that holds the module, as the replaced Launchpad
// installed them, so a contracts package of the Organization's root
// repository is an input; for a declared preparation, as before, the owner.
function dependencyBoundary(
  preparation: Preparation,
  owner: string,
  organizationDirectory: string | undefined,
) {
  return preparation.kind === "default" && organizationDirectory !== undefined
    ? organizationDirectory
    : owner;
}

// The default preparation installs into the application's own directory,
// beneath any other application package there: refused when the module
// declares an application package whose directory contains this one's or
// lies inside it (decision F25). Siblings (`app/v1`, `app/v2`) never
// overlap; a local package inside the application's directory is a
// dependency, not an application.
// A declared preparation keeps nested application packages possible, so the
// same rule decides whether its start may install (decision F32).
export async function applicationsOverlap(
  moduleDirectory: string,
  applicationPackage: string,
) {
  const { apps } = parseModuleManifest(
    await readCheckoutJson(join(moduleDirectory, "lazurio.module.json")),
  );
  const directory = posix.dirname(applicationPackage);
  const contains = (outer: string, inner: string) =>
    outer === "." || inner.startsWith(`${outer}/`);
  return (apps ?? []).some((other) => {
    if (other === applicationPackage) return false;
    const otherDirectory = posix.dirname(other);
    return (
      otherDirectory === directory ||
      contains(directory, otherDirectory) ||
      contains(otherDirectory, directory)
    );
  });
}

async function requireSeparateApplications(
  moduleDirectory: string,
  applicationPackage: string,
) {
  if (await applicationsOverlap(moduleDirectory, applicationPackage))
    throw new PreparationRefused(
      "preparation-applications-overlap",
      join(moduleDirectory, applicationPackage),
      "Application packages overlap",
    );
}

async function declaredPlan(
  moduleDirectory: string,
  applicationPackage: string,
) {
  const plan = await readModuleApplication(moduleDirectory, applicationPackage);
  if (plan.kind !== "declared-runtime-plan")
    throw new Error("Declared application runtime required");
  return plan;
}

// The owner's rules of a preparation over the owner's package: the
// application is the owner or a declared member of its workspace, and the
// named scripts are the owner's.
function checkOwner(
  preparation: Preparation,
  applicationPackage: string,
  owner: Readonly<{
    owner: string;
    manifest: Readonly<Record<string, unknown>>;
  }>,
) {
  if (
    !isDeclaredWorkspaceMember(
      preparation.owner_package,
      applicationPackage,
      owner.manifest.workspaces,
    )
  )
    throw new PreparationRefused(
      "preparation-owner-invalid",
      join(owner.owner, "package.json"),
      "Application is not a declared member of preparation owner",
    );
  for (const script of [preparation.check_script, preparation.prepare_script])
    if (script !== undefined) modulePreparationArgs(owner, script);
}

/** Installation stays refused for a workspace owner or member until its
 * broader input snapshot is qualified. */
export function requireQualifiedInstall(
  preparation: Preparation,
  applicationPackage: string,
  owner: Readonly<{
    owner: string;
    manifest: Readonly<Record<string, unknown>>;
  }>,
) {
  if (
    preparation.owner_package !== applicationPackage ||
    Object.hasOwn(owner.manifest, "workspaces")
  )
    throw new PreparationRefused(
      "preparation-workspace-unqualified",
      join(owner.owner, "package.json"),
      "Workspace installation input snapshot is not qualified",
    );
}

/** Whether an application's preparation can run as far as is known without
 * running anything and without the install inputs' contents: its preparation
 * in effect, the owner's package, its Bun, its one lockfile, its own local
 * dependencies being there inside their boundary, the declared scripts and a qualified
 * install. What the catalog reports; the start inspects all of it again, and
 * the install inputs too. Throws the typed refusal (decision F25), or a
 * refusal of the checkout rule (decision F23). */
export async function inspectPreparationShape(
  moduleDirectory: string,
  applicationPackage: string,
  organizationDirectory?: string,
) {
  const plan = await declaredPlan(moduleDirectory, applicationPackage);
  const preparation = preparationOf(plan, applicationPackage);
  if (preparation.kind === "default")
    await requireSeparateApplications(moduleDirectory, applicationPackage);
  const owner = dirname(join(moduleDirectory, preparation.owner_package));
  await inspectOwnerDirectories(moduleDirectory, owner);
  await inspectCheckoutConfiguration(moduleDirectory, owner);
  const installOwner = await readInstallOwner(
    owner,
    dependencyBoundary(preparation, owner, organizationDirectory),
  );
  checkOwner(preparation, applicationPackage, installOwner);
  requireQualifiedInstall(preparation, applicationPackage, installOwner);
  return preparation;
}

// Read-only binding inspection for an explicitly selected, caller-owned module.
// Not an execution grant: workspace install inputs, current authorization and
// shared owner coordination must still be established by the effect composition.
export async function inspectPreparationBinding(
  moduleDirectory: string,
  applicationPackage: string,
  environment?: Readonly<Record<string, string>>,
  organizationDirectory?: string,
) {
  const plan = await declaredPlan(moduleDirectory, applicationPackage);
  const preparation = preparationOf(plan, applicationPackage);
  if (preparation.kind === "default")
    await requireSeparateApplications(moduleDirectory, applicationPackage);
  const owner = dirname(join(moduleDirectory, preparation.owner_package));
  const authority = await inspectInstallAuthority(
    moduleDirectory,
    owner,
    environment,
    dependencyBoundary(preparation, owner, organizationDirectory),
  );
  checkOwner(preparation, applicationPackage, authority);
  const current = await readModuleApplication(
    moduleDirectory,
    applicationPackage,
  );
  if (
    current.kind !== "declared-runtime-plan" ||
    current.declarationDigest !== plan.declarationDigest ||
    !(await verifyInstallAuthority(authority))
  )
    throw new Error("Preparation binding changed");
  return Object.freeze({
    kind: "preparation-binding-observed" as const,
    plan,
    preparation,
    authority,
    workspaceMember: preparation.owner_package !== applicationPackage,
  });
}
