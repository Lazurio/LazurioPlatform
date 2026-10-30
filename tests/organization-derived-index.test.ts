import { expect, test } from "bun:test";
import { declareOrganizationSlots } from "../src/modules/organization-declaration";
import { expectedLegacyProjection } from "../src/organizations/legacy-projection";
import { canonicalDocument } from "./fixtures/catalog-folder";

function fixture() {
  const canonical = canonicalDocument("acme", "organization", [
    { slug: "core", display_name: "Core" },
  ]);
  Object.assign(canonical, {
    teams: [{ slug: "core", display_name: "Core", default: true }],
    governance: { file_ownership: { derived: ["generated/**"] } },
  });
  const modules = {
    company: "acme",
    github_org: "acme",
    teams: [{ slug: "old", display_name: "Old" }],
    module_slots: [],
  };
  const projection = expectedLegacyProjection(canonical, modules);
  canonical.compatibility.legacy_projection.sha256 = projection.hash;
  return {
    canonical: JSON.stringify(canonical),
    modules: JSON.stringify(modules),
    legacy: JSON.stringify(projection.projection),
    modulesIndex: null,
  };
}

test("registration refreshes the template index and inventory roster from canonical declarations", () => {
  const before = fixture();
  const after = declareOrganizationSlots(before, []);
  expect(JSON.parse(after.modules).teams).toEqual(
    JSON.parse(after.canonical).teams,
  );
  const index = JSON.parse(
    (after as unknown as { modulesIndex: string }).modulesIndex,
  );
  expect(index).toMatchObject({
    schema_version: "companiesascode.modules_index.v2",
    company_slug: "acme",
    modules: [],
    manifest_slots: [],
  });
  expect(index.teams).toEqual([
    { slug: "core", display_name: "Core", default: true },
  ]);
  expect(declareOrganizationSlots(after, [])).toEqual(after);
});

test("an unknown index schema is preserved, and ambiguous ownership refuses compilation", () => {
  const before = fixture();
  expect(() =>
    declareOrganizationSlots(
      { ...before, modulesIndex: '{"schema_version":"unrecognized"}' },
      [],
    ),
  ).toThrow("unsupported schema");
  const canonical = JSON.parse(before.canonical);
  canonical.governance.file_ownership.manual = ["generated/**"];
  const projected = expectedLegacyProjection(
    canonical,
    JSON.parse(before.modules),
  );
  canonical.compatibility.legacy_projection.sha256 = projected.hash;
  expect(() =>
    declareOrganizationSlots(
      {
        ...before,
        canonical: JSON.stringify(canonical),
        legacy: JSON.stringify(projected.projection),
      },
      [],
    ),
  ).toThrow("exactly one derived owner");
});
