import { object, text } from "./manifest";

// Development declaration only. Resolution, workspace membership, custody,
// toolchain and operation authority must be checked separately before execution.
export function parsePreparationDeclaration(input: unknown) {
  const value = object(
    input,
    ["schema_version", "owner_package", "check_script"],
    ["prepare_script"],
  );
  if (value.schema_version !== "lazurio.preparation.v1")
    throw new Error("Unsupported preparation declaration");
  const ownerPackage = text(
    value.owner_package,
    /^(?:(?!\.{1,2}\/)[A-Za-z0-9._-]+\/)*package\.json$/,
  );
  const script = (value: unknown) => text(value, /^[A-Za-z][A-Za-z0-9:_-]*$/);
  return Object.freeze({
    schema_version: "lazurio.preparation.v1" as const,
    owner_package: ownerPackage,
    check_script: script(value.check_script),
    ...(Object.hasOwn(value, "prepare_script")
      ? { prepare_script: script(value.prepare_script) }
      : {}),
  });
}
