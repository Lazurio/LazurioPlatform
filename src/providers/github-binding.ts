import { object, text } from "../modules/manifest";
import type { parseGitHubRepositoryObservation } from "./github-repository";

// Compare the existing verified forge-binding wire contract with one provider
// observation. Matching identities are not access, local custody or a mandate.
export function compareGitHubBindings(
  organizationInput: unknown,
  repositoryInput: unknown,
  observation: ReturnType<typeof parseGitHubRepositoryObservation>,
) {
  const organization = object(
    organizationInput,
    ["forge", "locator", "binding_state"],
    ["organization_id"],
  );
  const repository = object(
    repositoryInput,
    ["forge", "locator", "default_branch", "binding_state"],
    ["repository_id"],
  );
  if (
    organization.forge !== "github" ||
    repository.forge !== "github" ||
    repository.default_branch !== "main"
  )
    throw new Error("Unsupported forge binding");
  const owner = text(
    organization.locator,
    /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/,
  );
  const name = text(
    repository.locator,
    /^(?!.*\.git$)[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/,
  );
  for (const [binding, field] of [
    [organization, "organization_id"],
    [repository, "repository_id"],
  ] as const) {
    if (binding.binding_state === "unverified") {
      if (Object.hasOwn(binding, field))
        throw new Error("Unverified binding has an identity");
    } else if (binding.binding_state === "verified")
      text(binding[field], /^[1-9][0-9]{0,19}$/);
    else throw new Error("Unknown forge binding state");
  }
  if (
    organization.binding_state !== "verified" ||
    repository.binding_state !== "verified"
  )
    return Object.freeze({ kind: "binding-unverified" as const });
  if (observation.kind !== "observed")
    return Object.freeze({ kind: "provider-unavailable" as const });
  const actual = observation.repository;
  if (
    actual.owner.kind !== "Organization" ||
    actual.owner.databaseId === null ||
    actual.databaseId === null
  )
    return Object.freeze({ kind: "provider-identity-unavailable" as const });
  if (
    actual.owner.databaseId !== organization.organization_id ||
    actual.databaseId !== repository.repository_id ||
    actual.owner.login.toLowerCase() !== owner.toLowerCase() ||
    actual.name.toLowerCase() !== name.toLowerCase() ||
    name.split("/")[0]?.toLowerCase() !== owner.toLowerCase()
  )
    return Object.freeze({ kind: "binding-mismatch" as const });
  return Object.freeze({ kind: "binding-matches" as const });
}
