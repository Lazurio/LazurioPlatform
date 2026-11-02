import { expect, test } from "bun:test";
import { parseCanonicalOrganization } from "../src/organizations/canonical-manifest";
import {
  type ManifestCase,
  manifestRefusals,
  manifestVariants,
  verifiedManifest,
} from "./fixtures/organization-manifests";

test("canonical Organization reader preserves owned metadata in an isolated frozen snapshot", () => {
  const input = verifiedManifest();
  const parsed = parseCanonicalOrganization(input);
  expect(parsed).toEqual(input);
  expect(Object.isFrozen(parsed)).toBe(true);
  expect(
    Object.isFrozen((parsed.organization as Record<string, unknown>).metadata),
  ).toBe(true);
  input.organization.metadata.custom.values.push("new work");
  expect(parsed).not.toEqual(input);
  expect(Object.isFrozen(input)).toBe(false);
  const unverified = verifiedManifest();
  unverified.kind = "template";
  unverified.organization.forge_binding.binding_state = "unverified";
  delete unverified.organization.forge_binding.organization_id;
  delete unverified.root_repository;
  expect(parseCanonicalOrganization(unverified).kind).toBe("template");
  unverified.root_repository = null;
  expect(parseCanonicalOrganization(unverified).root_repository).toBe(null);
  unverified.root_repository = {
    forge: "github",
    locator: "Fixture/another",
    default_branch: "main",
    binding_state: "unverified",
  };
  expect(parseCanonicalOrganization(unverified).root_repository).toEqual(
    unverified.root_repository,
  );
});

test("verified root uses its explicit repository name without inventing a GEN3 suffix", () => {
  const input = verifiedManifest();
  input.root_repository.locator = "Fixture/company-workspace";
  const parsed = parseCanonicalOrganization(input);
  expect(parsed.root_repository).toEqual(input.root_repository);
  input.root_repository.locator = "Other/company-workspace";
  expect(() => parseCanonicalOrganization(input)).toThrow(
    "Organization root binding mismatch",
  );
  input.root_repository.locator = "Fixture/company-workspace";
  delete input.root_repository.repository_id;
  expect(() => parseCanonicalOrganization(input)).toThrow();
});

for (const [name, change] of manifestVariants)
  test(`canonical Organization accepts ${name}`, () => {
    const input = verifiedManifest();
    change(input);
    expect(parseCanonicalOrganization(input)).toEqual(input);
  });

// Beside the shared JSON cases: a value JSON cannot carry.
const invalid: readonly ManifestCase[] = [
  ...manifestRefusals,
  [
    "lossy metadata",
    (v) => {
      v.organization.metadata.value = undefined;
    },
  ],
];
for (const [name, mutate] of invalid)
  test(`canonical Organization rejects ${name}`, () => {
    const input = verifiedManifest();
    mutate(input);
    expect(() => parseCanonicalOrganization(input)).toThrow();
  });
