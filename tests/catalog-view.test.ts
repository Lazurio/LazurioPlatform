import { expect, test } from "bun:test";
import {
  catalogSelection,
  catalogStatus,
  catalogTree,
  moduleFacts,
  moduleRoute,
  organizationFacts,
  organizationName,
  organizationRoute,
  parseCatalog,
  routeOrganization,
} from "../src/launchpad/catalog-view";
import { messages } from "../src/launchpad/messages";
import {
  type Catalog,
  type CatalogModule,
  type CatalogOrganization,
  type CatalogRepository,
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
  repositories: [],
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
  repositories: [],
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
    "preparation-lockfile-unused",
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
      "preparation-lockfile-unused",
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

// The Personalspace group in the shape the core gives it (B11): not a Team,
// no Teams of its own, after the Organizations.
const personalspace: CatalogOrganization = {
  directory: "personalspace",
  organization: "personalspace",
  displayName: "Personalspace",
  state: null,
  issues: [],
  executable: true,
  teams: [],
  modules: [
    module("notes", [], {
      organization: "personalspace",
      teamsSource: "none",
      state: null,
    }),
  ],
  repositories: [],
};
const workstation: Catalog = { ...catalog, personalspace };

test("each module is listed once, in the catalog's order, whatever Teams declare it; the Personalspace group stays (F32)", () => {
  for (const locale of ["cs", "en"]) {
    const copy = messages(locale);
    const tree = catalogTree(workstation, copy);
    // web is in two declared Teams, lab in a Team nobody declares, misc in
    // none: one flat list, each module once, in declaration order.
    expect(
      tree.map((group) => [
        group.name,
        group.href,
        group.status.state,
        group.modules.map((entry) => [
          entry.module.module,
          entry.href,
          entry.status.state,
        ]),
      ]),
    ).toEqual([
      [
        "Alpha Company",
        "/o/alpha",
        "ready",
        [
          ["web", "/o/alpha/web", "ready"],
          ["docs", "/o/alpha/docs", "ready"],
          ["lab", "/o/alpha/lab", "ready"],
          ["misc", "/o/alpha/misc", "ready"],
        ],
      ],
      ["broken", "/o/broken", "blocked", []],
      [
        "Personalspace",
        "/o/personalspace",
        "ready",
        [["notes", "/o/personalspace/notes", "ready"]],
      ],
    ]);
    // The entries are the catalog's own modules, so a selected module is
    // found among them by identity, exactly once.
    const web = alpha.modules[0];
    expect(
      tree.flatMap((group) => group.modules).filter((e) => e.module === web),
    ).toHaveLength(1);
    // Without a Personalspace there is no such group.
    expect(catalogTree(catalog, copy).map((group) => group.name)).toEqual([
      "Alpha Company",
      "broken",
    ]);
  }
});

const repository = (slug: string, checkedOut: boolean): CatalogRepository => ({
  slug,
  path: `productionspace/${slug}`,
  checkedOut,
  url: checkedOut ? `https://github.com/omega/${slug}` : null,
});

test("an Organization has two sections, Workspace with every module in catalog order (a root-level application among the workspace modules) and Productionspace read-only; an empty section is not drawn; the Personalspace group stays one list (F32 addendum of 2026-10-03, final)", () => {
  // omega in a manifest's order: a workspace module, the root-level
  // application, another workspace module; two productionspace repositories,
  // one checked out and one not.
  const omega: CatalogOrganization = {
    ...alpha,
    directory: "omega",
    organization: "omega",
    displayName: "Omega Company",
    modules: [
      module("web", [], { organization: "omega" }),
      module("mission-control", [], {
        organization: "omega",
        path: "mission-control",
      }),
      module("docs", [], { organization: "omega" }),
    ],
    repositories: [repository("firmware", true), repository("connect", false)],
  };
  // Only modules: one section. Only production repositories: one section.
  // Nothing at all: no section.
  const sigma: CatalogOrganization = {
    ...alpha,
    directory: "sigma",
    organization: "sigma",
    displayName: "Sigma Company",
    modules: [module("api", [], { organization: "sigma" })],
  };
  const tau: CatalogOrganization = {
    ...alpha,
    directory: "tau",
    organization: "tau",
    displayName: "Tau Company",
    modules: [],
    repositories: [repository("firmware", false)],
  };
  const empty: CatalogOrganization = {
    ...alpha,
    directory: "empty",
    organization: "empty",
    displayName: "Empty Company",
    modules: [],
  };
  const value: Catalog = {
    kind: "catalog",
    organizations: [omega, sigma, tau, empty],
    personalspace,
  };
  for (const locale of ["cs", "en"] as const) {
    const copy = messages(locale);
    const tree = catalogTree(value, copy);
    expect(
      tree.map((group) =>
        group.sections === null
          ? [group.name, null]
          : [
              group.name,
              group.sections.map((section) =>
                section.kind === "workspace"
                  ? [
                      section.kind,
                      section.title,
                      section.modules.map((entry) => entry.module.module),
                    ]
                  : [
                      section.kind,
                      section.title,
                      section.repositories.map((entry) => [
                        entry.repository.slug,
                        entry.checkout,
                        entry.repository.url,
                      ]),
                    ],
              ),
            ],
      ),
    ).toEqual([
      [
        "Omega Company",
        [
          ["workspace", "Workspace", ["web", "mission-control", "docs"]],
          [
            "productionspace",
            "Productionspace",
            [
              [
                "firmware",
                copy.catalogCheckedOut,
                "https://github.com/omega/firmware",
              ],
              ["connect", copy.catalogNotCheckedOut, null],
            ],
          ],
        ],
      ],
      ["Sigma Company", [["workspace", "Workspace", ["api"]]]],
      [
        "Tau Company",
        [
          [
            "productionspace",
            "Productionspace",
            [["firmware", copy.catalogNotCheckedOut, null]],
          ],
        ],
      ],
      ["Empty Company", []],
      ["Personalspace", null],
    ]);
    expect(copy.catalogCheckedOut).not.toBe(copy.catalogNotCheckedOut);
    // The Workspace section is the very flat list: every module once, the
    // same entries, so a module's route and status stay what they were.
    const [first] = tree;
    const workspace = first?.sections?.[0];
    if (workspace?.kind !== "workspace") throw new Error("No Workspace");
    expect(workspace.modules).toEqual(first?.modules ?? []);
    for (const [index, entry] of (first?.modules ?? []).entries())
      expect(workspace.modules[index]).toBe(entry);
    // No third section heading in either language: the Organization group
    // of the earlier addendum is gone.
    expect(
      tree.flatMap((group) =>
        (group.sections ?? []).map((section) => section.title),
      ),
    ).not.toContain(locale === "cs" ? "Organizace" : "Organization");
    // The Personalspace group keeps its one list (B11).
    expect(tree[4]?.modules.map((entry) => entry.module.module)).toEqual([
      "notes",
    ]);
  }
});

test("no Team is drawn: no subheader, no badge, no Teams or Team membership on the Organization or module page (F32)", () => {
  // delta's manifest uses the legacy Team alias: the CLI still names it
  // (tests/organization-catalog.test.ts), the page does not.
  const delta: CatalogOrganization = {
    ...alpha,
    directory: "delta",
    organization: "delta",
    displayName: "Delta Company",
    modules: [
      module("crm", ["sales", "core"], {
        organization: "delta",
        teamsSource: "legacy-alias",
      }),
      module("wiki", ["workspace"], {
        organization: "delta",
        teamsSource: "default",
        issues: ["teams-invalid"],
      }),
    ],
  };
  const value: Catalog = { ...workstation, organizations: [alpha, delta] };
  const teamWords = [
    ...[alpha, delta].flatMap((organization) =>
      organization.teams.flatMap((team) => [team.slug, team.displayName]),
    ),
    "research",
    "workspace/workspace",
    "Team",
  ].map((word) => word.toLowerCase());
  for (const locale of ["cs", "en"]) {
    const copy = messages(locale);
    // Every text the sidebar, the overview, the Organization pages and the
    // module pages draw from the catalog.
    const facts = (entries: readonly (readonly [string, unknown])[]) =>
      entries.flatMap(([label, fact]) => [label, ...[fact].flat()]);
    const drawn = catalogTree(value, copy).flatMap((group) => [
      group.name,
      group.status.text,
      ...facts(organizationFacts(group.organization, copy)),
      ...group.modules.flatMap((entry) => [
        entry.module.module,
        entry.module.defaultApp ?? copy.catalogNone,
        entry.status.text,
        ...facts(moduleFacts(group.organization, entry.module, copy)),
      ]),
    ]);
    expect(drawn.length).toBeGreaterThan(40);
    for (const text of drawn)
      for (const word of teamWords)
        expect(String(text).toLowerCase()).not.toContain(word);
    // The module page keeps what it had besides its Teams and their one
    // issue code, teams-invalid.
    const wiki = delta.modules[1];
    if (wiki === undefined) throw new Error("No module");
    expect(moduleFacts(delta, wiki, copy).map(([label]) => label)).toEqual([
      copy.catalogOrganization,
      copy.catalogApps,
      copy.catalogPath,
      copy.catalogState,
    ]);
    expect(organizationFacts(delta, copy).map(([label]) => label)).toEqual([
      copy.catalogDirectory,
      copy.catalogState,
      copy.catalogIssues,
    ]);
  }
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
    // The read-only production repositories (F32 addendum of 2026-10-03).
    { kind: "catalog", organizations: [{ ...alpha, repositories: undefined }] },
    {
      kind: "catalog",
      organizations: [
        {
          ...alpha,
          repositories: [{ ...repository("x", true), checkedOut: "yes" }],
        },
      ],
    },
    {
      kind: "catalog",
      organizations: [
        { ...alpha, repositories: [{ ...repository("x", true), path: 1 }] },
      ],
    },
    {
      kind: "catalog",
      organizations: [
        {
          ...alpha,
          repositories: [
            {
              ...repository("x", true),
              url: "javascript:alert(1)",
            },
          ],
        },
      ],
    },
  ])
    expect(parseCatalog(input)).toBeNull();
});
