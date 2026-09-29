import { dirname, join } from "node:path";
import { modulePreparationArgs } from "./frozen-install-process";
import {
  inspectInstallAuthority,
  inspectOwnerDirectories,
  readInstallOwner,
  verifyInstallAuthority,
} from "./install-authority";
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
 * dependencies staying inside it, the declared scripts and a qualified
 * install. What the catalog reports; the start inspects all of it again, and
 * the install inputs too. Throws the typed refusal (decision F25), or a
 * refusal of the checkout rule (decision F23). */
export async function inspectPreparationShape(
  moduleDirectory: string,
  applicationPackage: string,
) {
  const plan = await declaredPlan(moduleDirectory, applicationPackage);
  const preparation = preparationOf(plan, applicationPackage);
  const owner = dirname(join(moduleDirectory, preparation.owner_package));
  await inspectOwnerDirectories(moduleDirectory, owner);
  const installOwner = await readInstallOwner(owner);
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
) {
  const plan = await declaredPlan(moduleDirectory, applicationPackage);
  const preparation = preparationOf(plan, applicationPackage);
  const owner = dirname(join(moduleDirectory, preparation.owner_package));
  const authority = await inspectInstallAuthority(
    moduleDirectory,
    owner,
    environment,
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
