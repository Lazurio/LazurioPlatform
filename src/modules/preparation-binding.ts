import { dirname, join } from "node:path";
import { modulePreparationArgs } from "./frozen-install-process";
import {
  inspectInstallAuthority,
  verifyInstallAuthority,
} from "./install-authority";
import { readModuleApplication } from "./read-application";
import { isDeclaredWorkspaceMember } from "./workspace-membership";

// Read-only binding inspection for an explicitly selected, caller-owned module.
// Not an execution grant: workspace install inputs, current authorization and
// shared owner coordination must still be established by the effect composition.
export async function inspectPreparationBinding(
  moduleDirectory: string,
  applicationPackage: string,
  environment?: Readonly<Record<string, string>>,
) {
  const plan = await readModuleApplication(moduleDirectory, applicationPackage);
  if (plan.kind !== "declared-runtime-plan" || !plan.preparation)
    throw new Error("Explicit preparation declaration required");
  const declaration = plan.preparation;
  const owner = dirname(join(moduleDirectory, declaration.owner_package));
  const authority = await inspectInstallAuthority(
    moduleDirectory,
    owner,
    environment,
  );
  if (
    !isDeclaredWorkspaceMember(
      declaration.owner_package,
      applicationPackage,
      authority.manifest.workspaces,
    )
  )
    throw new Error(
      "Application is not a declared member of preparation owner",
    );
  modulePreparationArgs(authority, declaration.check_script);
  if (declaration.prepare_script !== undefined)
    modulePreparationArgs(authority, declaration.prepare_script);
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
    authority,
    workspaceMember: declaration.owner_package !== applicationPackage,
  });
}
