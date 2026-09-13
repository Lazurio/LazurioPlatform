import { expect, test } from "bun:test";
import { parseCanonicalOrganization } from "../src/organizations/canonical-manifest";

// biome-ignore lint/suspicious/noExplicitAny: adversarial wire fixtures intentionally replace typed fields with invalid types.
function fixture(): Record<string, any> {
  return {
    schema_version: "lazurio.organization.v1",
    kind: "organization",
    organization: {
      slug: "fixture",
      display_name: "Fixture Organization",
      forge_binding: {
        forge: "github",
        locator: "Fixture",
        binding_state: "verified",
        organization_id: "123",
      },
      metadata: { custom: { values: [1, "česky"] } },
    },
    root_repository: {
      forge: "github",
      locator: "Fixture/Fixture_GEN3",
      default_branch: "main",
      binding_state: "verified",
      repository_id: "456",
    },
    manifests: { modules: "modules.manifest.json" },
    compatibility: {
      legacy_projection: {
        path: "company.gen3.json",
        algorithm: "sha256-canonical-json-v1",
        sha256: `sha256:${"0".repeat(64)}`,
      },
    },
    extensions: { legacy: { custom: { preserved: true } } },
    governance: {
      default_branch: "main",
      access_authority: "github",
      custom: "retained",
    },
    module_port_pool: { start: 5000, end: 5099 },
    teams: [
      {
        slug: "makers",
        display_name: "Makers",
        default: true,
        description: "Fixture",
        custom: "retained",
        forge_binding: {
          schema_version: "lazurio.team-forge-binding.github.v0",
          provider: "github",
          team: { id: "789", asserted_slug: "makers" },
        },
      },
    ],
    layers: [],
    task_sources: [],
    doctor: { custom: true },
  };
}

test("canonical Organization reader preserves owned metadata in an isolated frozen snapshot", () => {
  const input = fixture();
  const parsed = parseCanonicalOrganization(input);
  expect(parsed).toEqual(input);
  expect(Object.isFrozen(parsed)).toBe(true);
  expect(
    Object.isFrozen((parsed.organization as Record<string, unknown>).metadata),
  ).toBe(true);
  input.organization.metadata.custom.values.push("new work");
  expect(parsed).not.toEqual(input);
  expect(Object.isFrozen(input)).toBe(false);
  const unverified = fixture();
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

// biome-ignore lint/suspicious/noExplicitAny: mutation cases deliberately violate the input schema; production API accepts unknown.
const invalid: [string, (value: Record<string, any>) => void][] = [
  [
    "schema",
    (v) => {
      v.schema_version = "next";
    },
  ],
  [
    "kind",
    (v) => {
      v.kind = "machine";
    },
  ],
  [
    "unknown root field",
    (v) => {
      v.extra = true;
    },
  ],
  [
    "missing identity",
    (v) => {
      delete v.organization;
    },
  ],
  [
    "trimmed identity",
    (v) => {
      v.organization.slug = " fixture";
    },
  ],
  [
    "blank name",
    (v) => {
      v.organization.display_name = "";
    },
  ],
  [
    "identity field",
    (v) => {
      v.organization.extra = true;
    },
  ],
  [
    "metadata collision",
    (v) => {
      v.organization.metadata.github_org = "Other";
    },
  ],
  [
    "metadata type",
    (v) => {
      v.organization.metadata = [];
    },
  ],
  [
    "forge",
    (v) => {
      v.organization.forge_binding.forge = "local";
    },
  ],
  [
    "owner locator",
    (v) => {
      v.organization.forge_binding.locator = "bad-";
    },
  ],
  [
    "owner ID",
    (v) => {
      v.organization.forge_binding.organization_id = 123;
    },
  ],
  [
    "missing verified ID",
    (v) => {
      delete v.organization.forge_binding.organization_id;
    },
  ],
  [
    "unverified ID",
    (v) => {
      v.organization.forge_binding.binding_state = "unverified";
    },
  ],
  [
    "unknown binding state",
    (v) => {
      v.organization.forge_binding.binding_state = "active";
    },
  ],
  [
    "binding extra",
    (v) => {
      v.organization.forge_binding.extra = true;
    },
  ],
  [
    "missing verified root",
    (v) => {
      delete v.root_repository;
    },
  ],
  [
    "null verified root",
    (v) => {
      v.root_repository = null;
    },
  ],
  [
    "different owner",
    (v) => {
      v.root_repository.locator = "Other/Other_GEN3";
    },
  ],
  [
    "verified root name",
    (v) => {
      v.root_repository.locator = "Fixture/another";
    },
  ],
  [
    "Git URL instead of locator",
    (v) => {
      v.root_repository.locator = "git@github.com:Fixture/Fixture_GEN3.git";
    },
  ],
  [
    "branch",
    (v) => {
      v.root_repository.default_branch = "dev";
    },
  ],
  [
    "root ID",
    (v) => {
      v.root_repository.repository_id = "0";
    },
  ],
  [
    "mixed binding states",
    (v) => {
      v.root_repository.binding_state = "unverified";
      delete v.root_repository.repository_id;
    },
  ],
  [
    "modules pointer",
    (v) => {
      v.manifests.modules = "../modules.json";
    },
  ],
  [
    "projection pointer",
    (v) => {
      v.compatibility.legacy_projection.path = "elsewhere.json";
    },
  ],
  [
    "projection algorithm",
    (v) => {
      v.compatibility.legacy_projection.algorithm = "sha256";
    },
  ],
  [
    "projection digest",
    (v) => {
      v.compatibility.legacy_projection.sha256 = "bad";
    },
  ],
  [
    "extension collision",
    (v) => {
      v.extensions.legacy.company = {};
    },
  ],
  [
    "port range",
    (v) => {
      v.module_port_pool.end = 1023;
    },
  ],
  [
    "port order",
    (v) => {
      v.module_port_pool.start = 5100;
    },
  ],
  [
    "port fractional",
    (v) => {
      v.module_port_pool.start = 5000.5;
    },
  ],
  [
    "port extra",
    (v) => {
      v.module_port_pool.extra = 1;
    },
  ],
  [
    "governance authority",
    (v) => {
      v.governance.access_authority = "dashboard";
    },
  ],
  [
    "governance type",
    (v) => {
      v.governance = null;
    },
  ],
  [
    "doctor type",
    (v) => {
      v.doctor = [];
    },
  ],
  [
    "layers type",
    (v) => {
      v.layers = {};
    },
  ],
  [
    "task sources type",
    (v) => {
      v.task_sources = {};
    },
  ],
  [
    "team identity",
    (v) => {
      delete v.teams[0].slug;
    },
  ],
  [
    "team default",
    (v) => {
      v.teams[0].default = "yes";
    },
  ],
  [
    "team provider",
    (v) => {
      v.teams[0].forge_binding.provider = "local";
    },
  ],
  [
    "team ID",
    (v) => {
      v.teams[0].forge_binding.team.id = "01";
    },
  ],
  [
    "team locator",
    (v) => {
      v.teams[0].forge_binding.team.asserted_slug = "Bad";
    },
  ],
  [
    "lossy metadata",
    (v) => {
      v.organization.metadata.value = undefined;
    },
  ],
];
for (const [name, mutate] of invalid)
  test(`canonical Organization rejects ${name}`, () => {
    const input = fixture();
    mutate(input);
    expect(() => parseCanonicalOrganization(input)).toThrow();
  });
