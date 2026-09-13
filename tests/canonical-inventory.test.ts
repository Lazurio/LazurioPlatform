import { expect, test } from "bun:test";
import { inspectCanonicalInventory } from "../src/organizations/canonical-inventory";

const canonical = {
  schema_version: "lazurio.organization.v1",
  kind: "organization",
  organization: {
    slug: "fixture",
    display_name: "Fixture",
    metadata: {},
    forge_binding: {
      forge: "github",
      locator: "Fixture",
      binding_state: "unverified",
    },
  },
  manifests: { modules: "modules.manifest.json" },
  extensions: { legacy: {} },
  compatibility: {
    legacy_projection: {
      path: "company.gen3.json",
      algorithm: "sha256-canonical-json-v1",
      sha256: `sha256:${"0".repeat(64)}`,
    },
  },
};
function modules() {
  return {
    company: "fixture",
    github_org: "Fixture",
    module_slots: [
      { path: "workspace/app", slug: "app", custom: { retained: true } },
    ],
    custom: { retained: ["fixture"] },
  };
}

test("canonical inventory binds identities while retaining declarations and per-slot diagnostics", () => {
  for (const version of [
    undefined,
    "companiesascode.modules.v1",
    "modules.manifest.v3",
  ]) {
    const input = {
      ...modules(),
      ...(version
        ? { schema_version: version, organization_generation: "gen3" }
        : {}),
    };
    const result = inspectCanonicalInventory(canonical, input);
    expect(result.modules).toEqual(input);
    expect(result.inventory.issues).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(Object.isFrozen(result.modules.custom)).toBe(true);
    input.custom.retained.push("later");
    expect(result.modules).not.toEqual(input);
  }
  const input = modules();
  input.company = "FIXTURE";
  input.github_org = "fixture";
  input.module_slots.push({
    path: "workspace/app",
    slug: "other",
    custom: { retained: true },
  });
  input.module_slots.push({
    path: "workspace/healthy",
    slug: "healthy",
    custom: { retained: true },
  });
  const result = inspectCanonicalInventory(canonical, input);
  expect(result.warnings).toEqual([
    "company-case-drift",
    "forge-locator-case-drift",
  ]);
  expect(result.inventory.issues).toContainEqual({
    code: "path-identity-conflict",
    indices: [0, 1],
  });
  expect(result.inventory.slots[2]?.id).toBe("healthy");
  expect(result.modules).toEqual(input);
});

test("canonical inventory refuses wrong Organization, unknown schemas and malformed inventory before use", () => {
  for (const patch of [
    { company: "other" },
    { github_org: "Other" },
    { company: " fixture" },
    { github_org: "" },
    { schema_version: "next" },
    { schema_version: null },
    { organization_generation: "gen4" },
    { organization_generation: null },
    { module_slots: {} },
    { module_slots: null },
    { custom: undefined },
  ])
    expect(() =>
      inspectCanonicalInventory(canonical, { ...modules(), ...patch }),
    ).toThrow();
  expect(() =>
    inspectCanonicalInventory({ ...canonical, kind: "machine" }, modules()),
  ).toThrow();
  expect(() => inspectCanonicalInventory(canonical, null)).toThrow();
});
