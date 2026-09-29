import { expect, test } from "bun:test";
import {
  catalogSelection,
  catalogStatus,
  moduleRoute,
  organizationName,
  organizationRoute,
  parseCatalog,
  routeOrganization,
  teamGroups,
  usesLegacyTeamAlias,
} from "../src/launchpad/catalog-view";
import { messages } from "../src/launchpad/messages";
import {
  type Catalog,
  type CatalogModule,
  type CatalogOrganization,
  findCatalogOrganization,
} from "../src/organizations/catalog";

const module = (
  name: string,
  teams: string[],
  extra: Partial<CatalogModule> = {},
): CatalogModule => ({
  organization: "alpha",
  module: name,
  path: `workspace/${name}`,
  teams,
  teamsSource: "teams",
  apps: [{ package: "app/package.json", kind: "runtime-declared" }],
  defaultApp: "app/package.json",
  state: "transition",
  executable: true,
  ...extra,
});

const alpha: CatalogOrganization = {
  directory: "alpha_GEN3",
  organization: "alpha",
  displayName: "Alpha Company",
  state: "transition",
  issues: [],
  executable: true,
  teams: [
    { slug: "core", displayName: "Core" },
    { slug: "sales", displayName: "Sales" },
    { slug: "empty", displayName: "Empty" },
  ],
  modules: [
    module("web", ["sales", "core"]),
    module("docs", ["core"]),
    module("lab", ["research"]),
    module("misc", []),
  ],
};
const broken: CatalogOrganization = {
  directory: "broken",
  organization: null,
  displayName: null,
  state: "conflict",
  issues: ["modules_document_unreadable"],
  executable: false,
  reason: "organization-conflict",
  teams: [],
  modules: [],
};
const catalog: Catalog = { kind: "catalog", organizations: [alpha, broken] };

test("every reason reads as a sentence in both languages; an unknown code is named, not guessed", () => {
  const reasons = [
    "canonical-documents-required",
    "organization-conflict",
    "organization-not-executable",
    "template-not-runtime",
    "organization-changed",
    "organization-unavailable",
    "organization-duplicate",
    "declaration-conflict",
    "module-unavailable",
    "explicit-apps-required",
    "no-app",
    "default-app-invalid",
    "declaration-not-regular",
    "declaration-owner",
    "declaration-too-large",
    "preparation-owner-invalid",
    "preparation-script-missing",
    "preparation-lockfile-missing",
    "preparation-lockfile-ambiguous",
    "preparation-package-manager-unsupported",
    "preparation-workspace-unqualified",
    "preparation-dependency-outside-owner",
    "preparation-dependency-missing",
    "preparation-applications-overlap",
  ];
  for (const locale of ["cs", "en"]) {
    const copy = messages(locale);
    expect(catalogStatus({ executable: true }, copy)).toEqual({
      state: "ready",
      text: copy.catalogReady,
      code: null,
    });
    const texts = reasons.map((reason) => {
      const status = catalogStatus({ executable: false, reason }, copy);
      expect(status.state).toBe("blocked");
      expect(status.code).toBe(reason);
      expect(status.text).not.toBe(reason);
      expect(status.text.length).toBeGreaterThan(10);
      return status.text;
    });
    expect(new Set(texts).size).toBe(reasons.length);
    expect(
      catalogStatus({ executable: false, reason: "future-reason" }, copy),
    ).toEqual({
      state: "blocked",
      text: "future-reason",
      code: "future-reason",
    });
  }
  // A refused file of the operator's checkout is named in the sentence
  // (decision F23), as text.
  for (const locale of ["cs", "en"])
    for (const reason of [
      "declaration-not-regular",
      "declaration-owner",
      "declaration-too-large",
      "preparation-lockfile-missing",
      "preparation-dependency-outside-owner",
    ]) {
      const status = catalogStatus(
        { executable: false, reason, file: "app/package.json" },
        messages(locale),
      );
      expect(status.text).toContain("app/package.json");
      expect(status.text).not.toContain("{file}");
    }
  expect(messages("cs").catalogReasonNoApp).not.toBe(
    messages("en").catalogReasonNoApp,
  );
});

test("modules are grouped by Team N:M: declared order, undeclared Teams, then the rest", () => {
  const copy = messages("en");
  expect(
    teamGroups(alpha, copy).map((group) => [
      group.team?.displayName ?? null,
      group.modules.map((entry) => entry.module),
    ]),
  ).toEqual([
    ["Core", ["web", "docs"]],
    ["Sales", ["web"]],
    ["research", ["lab"]],
    ["Other modules", ["misc"]],
  ]);
  // Without any Team there is no subheader at all.
  expect(teamGroups({ ...alpha, modules: [module("misc", [])] }, copy)).toEqual(
    [{ team: null, modules: [module("misc", [])] }],
  );
  expect(teamGroups(broken, copy)).toEqual([]);
});

test("the legacy Team alias is named once per Organization, from any of its modules", () => {
  expect(usesLegacyTeamAlias(alpha)).toBe(false);
  expect(
    usesLegacyTeamAlias({
      modules: [
        module("web", ["core"]),
        module("crm", ["sales"], { teamsSource: "legacy-alias" }),
        module("misc", ["workspace"], { teamsSource: "default" }),
      ],
    }),
  ).toBe(true);
  expect(
    usesLegacyTeamAlias({
      modules: [module("misc", ["workspace"], { teamsSource: "default" })],
    }),
  ).toBe(false);
});

test("a route selects an Organization or a module of the catalog, or says it is missing", () => {
  expect(catalogSelection(catalog, { view: "home" })).toEqual({
    kind: "overview",
  });
  expect(
    catalogSelection(catalog, { view: "organization", organization: "ALPHA" }),
  ).toEqual({ kind: "organization", organization: alpha });
  expect(
    catalogSelection(catalog, {
      view: "module",
      organization: "alpha",
      module: "docs",
    }),
  ).toMatchObject({ kind: "module", module: { module: "docs" } });
  for (const route of [
    { view: "organization", organization: "nobody" },
    { view: "module", organization: "alpha", module: "nothing" },
  ] as const)
    expect(catalogSelection(catalog, route)).toEqual({ kind: "missing" });
  // As the CLI: without a slug, the exact directory name selects it.
  expect(
    catalogSelection(catalog, { view: "organization", organization: "broken" }),
  ).toEqual({ kind: "organization", organization: broken });
  expect(organizationRoute(catalog, alpha)).toBe("/o/alpha");
  expect(organizationRoute(catalog, broken)).toBe("/o/broken");
  expect(organizationName(alpha)).toBe("Alpha Company");
  expect(organizationName(broken)).toBe("broken");
});

test("a slug two candidates declare, in the same case or another, selects neither; the page and the CLI agree", () => {
  for (const twinSlug of ["alpha", "Alpha"]) {
    // One candidate's directory is its own slug, the other's is not a slug.
    const twin = { ...alpha, directory: twinSlug, organization: twinSlug };
    const twins: Catalog = { kind: "catalog", organizations: [alpha, twin] };
    for (const name of ["alpha", "Alpha", "ALPHA"]) {
      expect(routeOrganization(twins, name)).toBeUndefined();
      expect(findCatalogOrganization(twins, name)).toBeUndefined();
      for (const route of [
        { view: "organization", organization: name },
        { view: "module", organization: name, module: "web" },
      ] as const)
        expect(catalogSelection(twins, route)).toEqual({
          kind: "ambiguous",
          candidates: [alpha, twin],
        });
    }
    // The sidebar: a candidate links only by a name that selects exactly it.
    expect(organizationRoute(twins, alpha)).toBe("/o/alpha_GEN3");
    expect(moduleRoute(twins, alpha, module("web", []))).toBe(
      "/o/alpha_GEN3/web",
    );
    expect(organizationRoute(twins, twin)).toBeNull();
    expect(moduleRoute(twins, twin, module("web", []))).toBeNull();
    expect(
      catalogSelection(twins, {
        view: "organization",
        organization: "alpha_GEN3",
      }),
    ).toEqual({ kind: "organization", organization: alpha });
    // Every name the page selects, the CLI selects the same.
    for (const name of ["alpha", "Alpha", "alpha_GEN3", twinSlug, "nobody"])
      expect(routeOrganization(twins, name)).toBe(
        findCatalogOrganization(twins, name),
      );
  }
  for (const name of ["alpha", "ALPHA", "alpha_GEN3", "broken", "nobody"])
    expect(routeOrganization(catalog, name)).toBe(
      findCatalogOrganization(catalog, name),
    );
});

test("only an answer in the catalog's exact shape is drawn", () => {
  expect(parseCatalog(JSON.parse(JSON.stringify(catalog)))).toEqual(catalog);
  for (const input of [
    null,
    [],
    { kind: "blocked" },
    { kind: "catalog" },
    { kind: "catalog", organizations: [{ ...alpha, directory: 1 }] },
    {
      kind: "catalog",
      organizations: [
        { ...alpha, modules: [{ ...module("x", []), teams: [1] }] },
      ],
    },
    {
      kind: "catalog",
      organizations: [
        { ...alpha, modules: [{ ...module("x", []), teamsSource: 1 }] },
      ],
    },
    {
      kind: "catalog",
      organizations: [{ ...alpha, teams: [{ slug: "core" }] }],
    },
  ])
    expect(parseCatalog(input)).toBeNull();
});
