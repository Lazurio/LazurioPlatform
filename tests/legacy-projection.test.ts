import { expect, test } from "bun:test";
import { expectedLegacyProjection } from "../src/organizations/legacy-projection";

test("unverified projection omits forge identity and preserves nullish alias fallback", () => {
  const original = canonical();
  const { root_repository: root, ...rest } = original;
  const unverified = {
    ...rest,
    organization: {
      ...original.organization,
      forge_binding: {
        forge: "github",
        locator: "Fixture",
        binding_state: "unverified",
      },
    },
  };
  const inventory = {
    company: "fixture",
    github_org: "Fixture",
    module_slots: [
      {
        path: "workspace/a",
        git: { url: null, branch: null },
        repo: "Fixture/a",
        branch: "main",
        default_access: null,
        required_roles: null,
      },
    ],
  };
  for (const value of [unverified, { ...unverified, root_repository: null }]) {
    const result = expectedLegacyProjection(value, inventory);
    expect(result.projection.forge_binding).toBeUndefined();
    expect(result.projection.company).toEqual({
      slug: "fixture",
      display_name: "Fixture",
      github_org: "Fixture",
      custom: true,
    });
    expect(result.projection.modules).toEqual([
      {
        path: "workspace/a",
        slug: "a",
        repo: "Fixture/a",
        branch: "main",
        access: { default: "expected", roles: [] },
      },
    ]);
  }
  const result = expectedLegacyProjection(
    {
      ...unverified,
      root_repository: {
        forge: root.forge,
        locator: "Fixture/other",
        default_branch: "main",
        binding_state: "unverified",
      },
    },
    inventory,
  );
  expect(result.projection.forge_binding).toBeUndefined();
  expect(result.projection.company).toMatchObject({
    root_repository: "Fixture/other",
    repository: "git@github.com:Fixture/other.git",
  });
});

function canonical() {
  return {
    schema_version: "lazurio.organization.v1",
    kind: "organization",
    organization: {
      slug: "fixture",
      display_name: "Fixture",
      metadata: { custom: true },
      forge_binding: {
        forge: "github",
        locator: "Fixture",
        binding_state: "verified",
        organization_id: "1",
      },
    },
    root_repository: {
      forge: "github",
      locator: "Fixture/Fixture_GEN3",
      binding_state: "verified",
      repository_id: "2",
      default_branch: "main",
    },
    manifests: { modules: "modules.manifest.json" },
    extensions: { legacy: { extra: { preserved: true } } },
    compatibility: {
      legacy_projection: {
        path: "company.gen3.json",
        algorithm: "sha256-canonical-json-v1",
        sha256: `sha256:${"0".repeat(64)}`,
      },
    },
  };
}
function modules() {
  return {
    company: "fixture",
    github_org: "Fixture",
    module_slots: [
      { path: "infra", git: { url: "https://github.com/Fixture/infra.git" } },
      { path: "workspace/App/db", source_of_truth: "repository-db:app" },
      {
        path: "workspace/App",
        slug: "app",
        git: { url: "https://github.com/Fixture/app.git", branch: "dev" },
        default_access: "role_based",
        required_roles: ["maker"],
        teams: ["makers"],
        custom: { keep: true },
      },
      {
        path: "productionspace/Tool",
        space: "productionspace",
        workspace: "old",
        repository: "Fixture/tool",
        branch: "main",
      },
    ],
  };
}

test("legacy projection maps existing fields without rewriting source and checks declared hash content", () => {
  const c = canonical();
  const m = modules();
  const before = JSON.stringify({ c, m });
  const result = expectedLegacyProjection(c, m);
  expect(result.declaredHashMatches).toBe(false);
  expect(result.projection.company).toEqual({
    slug: "fixture",
    display_name: "Fixture",
    github_org: "Fixture",
    custom: true,
    repository: "git@github.com:Fixture/Fixture_GEN3.git",
    root_repository: "Fixture/Fixture_GEN3",
    default_branch: "main",
  });
  expect(result.projection.extra).toEqual({ preserved: true });
  expect(result.projection.forge_binding).toEqual({
    schema_version: "lazurio.forge-binding.github.v0",
    provider: "github",
    organization: { id: "1", asserted_login: "Fixture" },
    repository: {
      id: "2",
      asserted_full_name: "Fixture/Fixture_GEN3",
      default_branch: "main",
    },
  });
  expect(result.projection.modules).toEqual([
    {
      path: "productionspace/Tool",
      workspace: "productionspace",
      repository: "Fixture/tool",
      repo: "Fixture/tool",
      branch: "main",
      slug: "Tool",
    },
    {
      path: "workspace/App",
      slug: "app",
      repo: "https://github.com/Fixture/app.git",
      branch: "dev",
      access: { default: "role_based", roles: ["maker"] },
      teams: ["makers"],
      custom: { keep: true },
    },
    { path: "workspace/App/db", source_of_truth: "repository-db:app" },
  ]);
  expect(JSON.stringify({ c, m })).toBe(before);
  expect(Object.isFrozen(result.projection.modules)).toBe(true);
  c.compatibility.legacy_projection.sha256 = result.hash;
  expect(expectedLegacyProjection(c, m).declaredHashMatches).toBe(true);
  m.module_slots.reverse();
  expect(expectedLegacyProjection(c, m).hash).toBe(result.hash);
});

test("projection keeps document scope separate from executable mount support and rejects invalid paths", () => {
  const c = canonical();
  const header = { company: "fixture", github_org: "Fixture" };
  expect(
    expectedLegacyProjection(c, {
      ...header,
      module_slots: [{ path: "workspace" }, { path: "infra/deeper" }],
    }).projection.modules,
  ).toEqual([{ path: "workspace", slug: "workspace" }]);
  for (const path of [
    "../workspace/a",
    "workspace/../a",
    "workspace//a",
    "other/a",
    "workspace/a\n",
    "workspace\\a",
    "workspace/a/",
  ])
    expect(() =>
      expectedLegacyProjection(c, { ...header, module_slots: [{ path }] }),
    ).toThrow();
  expect(() =>
    expectedLegacyProjection(c, { ...header, module_slots: [null] }),
  ).toThrow();
  expect(() =>
    expectedLegacyProjection(c, {
      ...header,
      company: "other",
      module_slots: [],
    }),
  ).toThrow();
});
