import { expect, test } from "bun:test";
import { organizationDocumentHash } from "../src/organizations/document-hash";
import { expectedLegacyProjection } from "../src/organizations/legacy-projection";
import { prepareOrganizationConversion } from "../src/organizations/prepare-conversion";

function fixture() {
  return {
    legacy: {
      organization_generation: "gen3",
      organization_kind: "organization",
      company: {
        slug: "fixture",
        display_name: "Fixture",
        github_org: "Fixture",
        custom: { preserved: true },
      },
      modules: [
        {
          path: "workspace/app",
          slug: "app",
          repo: "https://github.com/Fixture/app.git",
        },
      ],
      custom: { nested: [1, "two"] },
    },
    modules: {
      company: "fixture",
      github_org: "Fixture",
      module_slots: [
        {
          path: "workspace/app",
          git: { url: "https://github.com/Fixture/app.git" },
        },
      ],
    },
  };
}

test("explicit conversion preserves complete declarations without inventing provider identity", () => {
  const { legacy, modules } = fixture();
  const before = JSON.stringify({ legacy, modules });
  const result = prepareOrganizationConversion(legacy, modules);
  expect(result.kind).toBe("conversion-draft");
  expect(result.legacyHash).toBe(organizationDocumentHash(legacy));
  expect(result.modulesHash).toBe(organizationDocumentHash(modules));
  expect(
    expectedLegacyProjection(result.canonical, modules).projection,
  ).toEqual(legacy);
  expect(result.canonical.organization).toMatchObject({
    forge_binding: { binding_state: "unverified" },
  });
  expect(JSON.stringify(result.canonical)).not.toContain("organization_id");
  expect(Object.isFrozen(result.canonical)).toBe(true);
  expect(JSON.stringify({ legacy, modules })).toBe(before);
});

test("conversion retains declared stable IDs but refuses conflicting or augmented binding data", () => {
  const { legacy, modules } = fixture();
  const bound = {
    ...legacy,
    company: {
      ...legacy.company,
      root_repository: "Fixture/Fixture_GEN3",
      repository: "git@github.com:Fixture/Fixture_GEN3.git",
      default_branch: "main",
    },
    forge_binding: {
      schema_version: "lazurio.forge-binding.github.v0",
      provider: "github",
      organization: { id: "1", asserted_login: "Fixture" },
      repository: {
        id: "2",
        asserted_full_name: "Fixture/Fixture_GEN3",
        default_branch: "main",
      },
    },
  };
  const result = prepareOrganizationConversion(bound, modules);
  expect(
    expectedLegacyProjection(result.canonical, modules).projection,
  ).toEqual(bound);
  for (const binding of [
    { ...bound.forge_binding, provider: "other" },
    { ...bound.forge_binding, extra: true },
    {
      ...bound.forge_binding,
      organization: { id: "1", asserted_login: "Other" },
    },
    {
      ...bound.forge_binding,
      repository: { ...bound.forge_binding.repository, id: 2 },
    },
  ])
    expect(() =>
      prepareOrganizationConversion(
        { ...bound, forge_binding: binding },
        modules,
      ),
    ).toThrow();
});

test("conversion refuses inventory drift, alias loss, malformed input and executable hooks", () => {
  const { legacy, modules } = fixture();
  for (const input of [
    { ...legacy, organization_generation: "gen2" },
    { ...legacy, modules: [] },
    {
      ...legacy,
      company: {
        ...legacy.company,
        git_url: "https://github.com/Fixture/root.git",
      },
    },
    { ...legacy, forge_binding: null },
  ])
    expect(() => prepareOrganizationConversion(input, modules)).toThrow();
  expect(() =>
    prepareOrganizationConversion(legacy, { ...modules, company: "other" }),
  ).toThrow();
  expect(() =>
    prepareOrganizationConversion(legacy, {
      ...modules,
      module_slots: [...modules.module_slots, ...modules.module_slots],
    }),
  ).toThrow();
  let invoked = false;
  const hostile = {
    get company() {
      invoked = true;
      return legacy.company;
    },
  };
  expect(() => prepareOrganizationConversion(hostile, modules)).toThrow();
  expect(invoked).toBe(false);
});
