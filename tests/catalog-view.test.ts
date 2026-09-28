import { expect, test } from "bun:test";
import {
  catalogSelection,
  catalogStatus,
  organizationName,
  parseCatalog,
  routeOrganization,
  teamGroups,
} from "../src/launchpad/catalog-view";
import { messages } from "../src/launchpad/messages";
import type {
  Catalog,
  CatalogModule,
  CatalogOrganization,
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
    { view: "organization", organization: "broken" },
    { view: "organization", organization: "nobody" },
    { view: "module", organization: "alpha", module: "nothing" },
  ] as const)
    expect(catalogSelection(catalog, route)).toEqual({ kind: "missing" });
  // Exact slug first; two slugs in different case are otherwise ambiguous.
  const twin = { ...alpha, directory: "Alpha", organization: "Alpha" };
  const twins: Catalog = { kind: "catalog", organizations: [alpha, twin] };
  expect(routeOrganization(twins, "Alpha")?.directory).toBe("Alpha");
  expect(routeOrganization(twins, "ALPHA")).toBeUndefined();
  expect(organizationName(alpha)).toBe("Alpha Company");
  expect(organizationName(broken)).toBe("broken");
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
      organizations: [{ ...alpha, teams: [{ slug: "core" }] }],
    },
  ])
    expect(parseCatalog(input)).toBeNull();
});
