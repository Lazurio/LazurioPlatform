import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { MachineBinding } from "../src/folder/machine-binding";
import {
  type AppsHomePart,
  appsHeading,
  appsHomeParts,
  appsScope,
  appsScopes,
  appsSections,
  appsSpaceOf,
  favoriteTiles,
  moduleAccessTarget,
  moduleAccessUrl,
  moduleDescription,
  moduleName,
  moduleStone,
  newModuleOffer,
  newModulePrompt,
  newPersonalModulePrompt,
  type PersonalStart,
  personalHolderOf,
  personalStarts,
  pluralKey,
  tileTarget,
} from "../src/launchpad/apps-view";
import { parseCatalog } from "../src/launchpad/catalog-view";
import type { PublicEntry } from "../src/launchpad/chat";
import {
  favoritesFirst,
  favoritesKey,
  moduleFavorite,
  parseFavorites,
  repositoryFavorite,
  toggleFavorite,
} from "../src/launchpad/favorites";
import { type MessageKey, messages } from "../src/launchpad/messages";
import { shellDocument } from "../src/launchpad/shell-document";
import type {
  Catalog,
  CatalogModule,
  CatalogOrganization,
  CatalogRepository,
} from "../src/organizations/catalog";
import { shellMessages } from "../src/shell/messages";
import { type SwitchTab, switchTabs } from "../src/shell/view";
import {
  binding,
  handoverEntry,
  personalWithEntry,
} from "./fixtures/machine-bindings";
import personalContext from "./fixtures/machine-context-personal.json";

// Decision F36 and its addendum of 2026-10-04: the Apps home as pure
// functions, like the catalog's view tests. One Organization at a time, its
// two sections Workspace (every module) and Productionspace (production
// repositories, read-only) with counts, clean tiles, favourites first, and
// what a tile does: the module's app on its own origin hosted,
// start-then-open locally, otherwise a short message in the wireframe's
// words.

const cs = messages("cs");
const en = messages("en");

const module = (
  id: string,
  extra: Partial<CatalogModule> = {},
): CatalogModule => ({
  organization: "example",
  module: id,
  path: `workspace/${id}`,
  teams: ["workspace"],
  teamsSource: "default",
  apps: [{ package: "app/v1/package.json", kind: "runtime-declared" }],
  defaultApp: "app/v1/package.json",
  state: "current",
  executable: true,
  ...extra,
});
const organization = (
  slug: string,
  modules: CatalogModule[],
  extra: Partial<CatalogOrganization> = {},
): CatalogOrganization => ({
  directory: `${slug}_GEN3`,
  organization: slug,
  displayName: "Example Company",
  state: "current",
  issues: [],
  executable: true,
  teams: [],
  modules,
  repositories: [],
  ...extra,
});
const display = (
  id: string,
  title: string,
  extra: Partial<NonNullable<CatalogModule["display"]>> = {},
): NonNullable<CatalogModule["display"]> => ({ id, title, tags: [], ...extra });
const example = organization(
  "example",
  [
    module("mission-control", {
      path: "mission-control",
      display: display("mission-control", "Mission Control v3"),
    }),
    module("knowledgebase", {
      display: display("kb", "Knowledgebase", {
        description: "Znalosti, rozhodnutí a dokumentace",
      }),
    }),
    module("deals"),
    module("website", {
      executable: false,
      reason: "default-app-invalid",
    }),
    module("notes", {
      apps: [],
      defaultApp: null,
      executable: false,
      reason: "no-app",
    }),
  ],
  {
    repositories: [
      {
        slug: "firmware",
        path: "productionspace/firmware",
        checkedOut: false,
        url: null,
      },
    ],
  },
);
const second = organization("northwind", [module("orders")], {
  displayName: "Northwind Example",
});
const catalog: Catalog = { kind: "catalog", organizations: [example, second] };
const entry: PublicEntry = {
  launchpadOrigin: "https://launchpad.vm-01.example.lazurio.io",
  t3codeOrigin: "https://t3code.vm-01.example.lazurio.io",
  moduleOriginTemplate: "https://{module}.vm-01.example.lazurio.io",
};

test("the catalog fixture is one the page accepts", () => {
  expect(parseCatalog(JSON.parse(JSON.stringify(catalog)))).not.toBeNull();
});

test("the space Apps reports to the rail: the Organization's slug, the personal space, or none for an Organization the Folder cannot read", () => {
  const home = appsScope(catalog, { view: "home" }, cs);
  if (home === null) throw new Error("The fixture has an Organization");
  expect(appsSpaceOf(home)).toBe("example");
  const personal = appsScopes(
    {
      kind: "catalog",
      organizations: [],
      personalspace: organization("personalspace", [module("diary")], {
        directory: "personalspace",
      }),
    },
    cs,
  ).find((group) => group.sections === null);
  if (personal === undefined)
    throw new Error("The fixture has a personal space");
  expect(appsSpaceOf(personal)).toBe("personal");
  // Matěj 2026-10-05: an Organization checkout without its canonical
  // documents has no slug; it is not the personal space.
  const unreadable = appsScope(
    {
      kind: "catalog",
      organizations: [
        organization("example", [], {
          organization: null,
          state: null,
          executable: false,
          reason: "canonical-documents-required",
        }),
      ],
    },
    { view: "home" },
    cs,
  );
  if (unreadable === null) throw new Error("The fixture has an Organization");
  expect(appsSpaceOf(unreadable)).toBeNull();
});

test("the home shows the first Organization; an Organization or module route its own; a missing one none", () => {
  expect(appsScope(catalog, { view: "home" }, cs)?.organization).toBe(example);
  expect(
    appsScope(catalog, { view: "organization", organization: "northwind" }, cs)
      ?.organization,
  ).toBe(second);
  expect(
    appsScope(
      catalog,
      { view: "module", organization: "NorthWind", module: "orders" },
      cs,
    )?.organization,
  ).toBe(second);
  expect(
    appsScope(catalog, { view: "organization", organization: "missing" }, cs),
  ).toBeNull();
  expect(
    appsScope({ kind: "catalog", organizations: [] }, { view: "home" }, cs),
  ).toBeNull();
});

test("two sections, Workspace with every module in catalog order and Productionspace read-only, with Czech counts and no subtitles; clean tiles", () => {
  const group = appsScope(catalog, { view: "home" }, cs);
  if (group === null) throw new Error("The fixture has an Organization");
  const sections = appsSections(catalog, group, cs, null);
  expect(
    sections.map((section) => [
      section.kind,
      section.title,
      section.count,
      section.tiles.map((tile) => tile.name),
    ]),
  ).toEqual([
    [
      "workspace",
      "Workspace",
      "5 modulů",
      ["Mission Control", "Knowledgebase", "deals", "website", "notes"],
    ],
    ["productionspace", "Productionspace", "1 repozitář", ["firmware"]],
  ]);
  expect(sections.some((section) => "subtitle" in section)).toBe(false);
  const [mission, ...workspace] = sections[0]?.tiles ?? [];
  // The declared description first, otherwise the org-agnostic sentence of
  // the stone's key; "No app" without an app. No status row on a tile.
  expect(
    workspace.map((tile) => [
      tile.name,
      tile.description,
      tile.kind === "module" ? tile.stone.src : null,
    ]),
  ).toEqual([
    [
      "Knowledgebase",
      "Znalosti, rozhodnutí a dokumentace",
      "/.lazurio/stones/guide-96.png",
    ],
    [
      "deals",
      "Obchodní případy, nabídky a práce se zákazníky.",
      "/.lazurio/stones/deals-96.png",
    ],
    [
      "website",
      "Webový obsah, stránky a veřejná prezentace.",
      "/.lazurio/stones/website-lazurio-96.png",
    ],
    ["notes", "Bez aplikace", "/.lazurio/stones/clients-96.png"],
  ]);
  expect(workspace.some((tile) => "note" in tile)).toBe(false);
  expect(mission?.name).toBe("Mission Control");
  expect(mission?.kind === "module" && mission.stone).toEqual({
    key: "control",
    src: "/.lazurio/stones/mission-control-96.png",
    accent: "var(--lz-blue-500)",
  });
  // The menu's "Informace o modulu" is the module's overview.
  expect(mission?.info).toBe("/o/example/mission-control");
});

test("what a tile does: open the app, or say why not, in the wireframe's words", () => {
  const group = appsScope(catalog, { view: "home" }, cs);
  if (group === null) throw new Error("The fixture has an Organization");
  const [workspace, productionspace] = appsSections(catalog, group, cs, entry);
  expect(
    workspace?.tiles.map((tile) =>
      tile.action.kind === "open" ? tile.action.target.kind : tile.action.text,
    ),
  ).toEqual([
    "hosted",
    "hosted",
    "hosted",
    "Aplikace modulu website teď nejde spustit.",
    "Modul notes zatím nemá aplikaci.",
  ]);
  expect(productionspace?.tiles[0]?.action).toEqual({
    kind: "say",
    text: "Repozitář firmware nemá aplikaci.",
  });
  // A repository has no page: its menu leads at most to its GitHub page.
  expect(productionspace?.tiles[0]?.info).toBeNull();
});

test("a production repository's tile: read-only, no stone, its GitHub page as its information", () => {
  const connect: CatalogRepository = {
    slug: "connect",
    path: "productionspace/connect",
    checkedOut: true,
    url: "https://github.com/example/connect",
  };
  const withLink = organization("example", [module("deals")], {
    repositories: [connect],
  });
  const value: Catalog = { kind: "catalog", organizations: [withLink] };
  const group = appsScope(value, { view: "home" }, en);
  if (group === null) throw new Error("The fixture has an Organization");
  for (const host of [entry, null]) {
    const [, productionspace] = appsSections(value, group, en, host);
    expect(productionspace?.kind).toBe("productionspace");
    expect(productionspace?.tiles).toEqual([
      {
        kind: "repository",
        key: "r:connect",
        repository: connect,
        name: "connect",
        description: "productionspace/connect",
        action: { kind: "say", text: "The repository connect has no app." },
        info: "https://github.com/example/connect",
        favorite: false,
      },
    ]);
  }
});

test("favourites: first in their section in the column's order, in the column only those the catalog has, kept per Organization in the browser", () => {
  const group = appsScope(catalog, { view: "home" }, cs);
  if (group === null) throw new Error("The fixture has an Organization");
  const favorites = [
    moduleFavorite("deals"),
    repositoryFavorite("firmware"),
    moduleFavorite("gone"),
    moduleFavorite("mission-control"),
  ];
  const [workspace, productionspace] = appsSections(
    catalog,
    group,
    cs,
    null,
    favorites,
  );
  expect(workspace?.tiles.map((tile) => [tile.name, tile.favorite])).toEqual([
    ["deals", true],
    ["Mission Control", true],
    ["Knowledgebase", false],
    ["website", false],
    ["notes", false],
  ]);
  expect(productionspace?.tiles[0]?.favorite).toBe(true);
  expect(
    favoriteTiles(catalog, group, cs, null, favorites).map((tile) => tile.key),
  ).toEqual(["m:deals", "r:firmware", "m:mission-control"]);
  // The stored list: one per Organization, read defensively.
  expect(favoritesKey("Example")).toBe("lazurio.favorites:example");
  expect(parseFavorites(null)).toEqual([]);
  expect(parseFavorites("{ not json")).toEqual([]);
  expect(parseFavorites('{"m:deals": true}')).toEqual([]);
  expect(
    parseFavorites('["m:deals", "m:deals", "x:other", 7, "r:firmware"]'),
  ).toEqual(["m:deals", "r:firmware"]);
  expect(toggleFavorite(["m:a"], "m:b")).toEqual(["m:a", "m:b"]);
  expect(toggleFavorite(["m:a", "m:b"], "m:a")).toEqual(["m:b"]);
  expect(
    favoritesFirst(
      [{ key: "a" }, { key: "b" }, { key: "c" }],
      ["c", "x", "a"],
    ).map((item) => item.key),
  ).toEqual(["c", "a", "b"]);
});

test("the head links the Organization's name to its Dashboard; the personal space and the home stay plain", () => {
  // F36's addendum of 2026-10-06: the picker no longer leads to the
  // Organization's Dashboard; its name in the head does, as the shell
  // document names the page.
  const group = appsScope(catalog, { view: "home" }, cs);
  if (group === null) throw new Error("The fixture has an Organization");
  const dashboard = (slug: string) =>
    slug === "example" ? "https://dashboard.lazurio.ai/orgs/example" : null;
  expect(appsHeading(group, cs, dashboard)).toEqual({
    text: "Example Company",
    link: {
      href: "https://dashboard.lazurio.ai/orgs/example",
      title: "Přehled Organizace",
    },
  });
  expect(appsHeading(group, en, dashboard).link?.title).toBe(
    "Organization Dashboard",
  );
  // An Organization the shell document does not name: its name alone.
  expect(appsHeading(group, cs, () => null)).toEqual({
    text: "Example Company",
    link: null,
  });
  const unreadable = appsScope(
    {
      kind: "catalog",
      organizations: [
        organization("example", [], {
          organization: null,
          state: null,
          executable: false,
          reason: "canonical-documents-required",
        }),
      ],
    },
    { view: "home" },
    cs,
  );
  if (unreadable === null) throw new Error("The fixture has an Organization");
  expect(
    appsHeading(
      unreadable,
      cs,
      () => "https://dashboard.lazurio.ai/orgs/example",
    ).link,
  ).toBeNull();
  // The personal space is "Osobní", never a link; without a group the
  // home is the Launchpad.
  const personal = appsScopes(
    {
      kind: "catalog",
      organizations: [],
      personalspace: organization("personalspace", [module("diary")], {
        directory: "personalspace",
      }),
    },
    cs,
  ).find((scope) => scope.sections === null);
  if (personal === undefined) throw new Error("The fixture has one");
  expect(
    appsHeading(personal, cs, () => "https://dashboard.lazurio.ai/home"),
  ).toEqual({ text: "Osobní", link: null });
  expect(appsHeading(null, cs, dashboard)).toEqual({
    text: "Apps",
    link: null,
  });
});

test("Přístup k modulu: the module in its Organization's Dashboard, for its Owners and Stewards only", () => {
  const bound = organization("example", [...example.modules], {
    forgeLogin: "Example-Org",
    repositories: example.repositories,
  });
  const boundCatalog: Catalog = {
    kind: "catalog",
    organizations: [bound],
    personalspace: organization("personalspace", [module("diary")], {
      directory: "personalspace",
    }),
  };
  const group = appsScope(boundCatalog, { view: "home" }, cs);
  if (group === null) throw new Error("The fixture has an Organization");
  const [workspace, productionspace] = appsSections(
    boundCatalog,
    group,
    cs,
    entry,
  );
  const deals = workspace?.tiles.find((tile) => tile.key === "m:deals");
  const firmware = productionspace?.tiles[0];
  if (deals === undefined || firmware === undefined)
    throw new Error("The fixture has a module and a repository");
  const dashboard = (slug: string) =>
    slug === "example" ? "https://dashboard.lazurio.ai/orgs/example" : null;
  const target =
    "https://dashboard.lazurio.ai/orgs/example/settings?tab=modules&module=deals";
  // An Owner and a Steward; GitHub's answers, false until they come.
  expect(
    moduleAccessTarget(deals, group, dashboard, {
      owner: true,
      maintainer: false,
    }),
  ).toBe(target);
  expect(
    moduleAccessTarget(deals, group, dashboard, {
      owner: false,
      maintainer: true,
    }),
  ).toBe(target);
  const both = { owner: true, maintainer: true };
  expect(
    moduleAccessTarget(deals, group, dashboard, {
      owner: false,
      maintainer: false,
    }),
  ).toBeNull();
  // Never a production repository, never without the Dashboard page, never
  // an Organization bound to no GitHub login, never the Personalspace group.
  expect(moduleAccessTarget(firmware, group, dashboard, both)).toBeNull();
  expect(moduleAccessTarget(deals, group, () => null, both)).toBeNull();
  const unbound = appsScope(catalog, { view: "home" }, cs);
  if (unbound === null) throw new Error("The fixture has an Organization");
  const unboundDeals = appsSections(catalog, unbound, cs, entry)[0]?.tiles.find(
    (tile) => tile.key === "m:deals",
  );
  if (unboundDeals === undefined) throw new Error("The fixture has deals");
  expect(moduleAccessTarget(unboundDeals, unbound, dashboard, both)).toBeNull();
  const personal = appsScopes(boundCatalog, cs).find(
    (scope) => scope.sections === null,
  );
  if (personal === undefined) throw new Error("The fixture has one");
  const diary = appsSections(boundCatalog, personal, cs, entry)[0]?.tiles[0];
  if (diary === undefined) throw new Error("The fixture has a module");
  expect(moduleAccessTarget(diary, personal, dashboard, both)).toBeNull();
});

test("the module access page: only under an Organization page of the Dashboard, the module id encoded", () => {
  expect(
    moduleAccessUrl("https://dashboard.lazurio.ai/orgs/example-co", "web.app"),
  ).toBe(
    "https://dashboard.lazurio.ai/orgs/example-co/settings?tab=modules&module=web.app",
  );
  expect(
    moduleAccessUrl("https://dashboard.lazurio.ai/orgs/example", "a&b c"),
  ).toBe(
    "https://dashboard.lazurio.ai/orgs/example/settings?tab=modules&module=a%26b+c",
  );
  for (const dashboard of [
    null,
    "https://dashboard.lazurio.ai/",
    "https://dashboard.lazurio.ai/settings",
    "https://dashboard.lazurio.ai/orgs/Example",
    "https://dashboard.lazurio.ai/orgs/example/settings",
    "https://dashboard.lazurio.ai/orgs/example?tab=x",
    "http://dashboard.lazurio.ai/orgs/example",
    "not a url",
  ])
    expect(moduleAccessUrl(dashboard, "deals")).toBeNull();
});

// #376 (plan DEV-6662, Q8): the Workspace where "+ Nový modul" ends is there
// for an identity that GitHub's live answer confirms as the Organization's
// Owner, even before its first module, so the tile has its place and the
// Owner is not told to ask the Admin for access (the page draws that
// sentence only when there is no section at all). Anyone else, and
// everyone until the answer comes, keeps today's page.
test("an Owner sees the Organization's Workspace even without a module, so the new module's tile has its place; everyone else keeps today's sections", () => {
  const view = (sections: ReturnType<typeof appsSections>) =>
    sections.map((section) => [
      section.kind,
      section.title,
      section.count,
      section.tiles.map((tile) => tile.name),
    ]);
  const bare: Catalog = {
    kind: "catalog",
    organizations: [organization("example", [], { forgeLogin: "example-org" })],
  };
  const bareGroup = appsScope(bare, { view: "home" }, cs);
  if (bareGroup === null) throw new Error("The fixture has an Organization");
  // The Owner: Workspace with no tile of its own and "zatím žádné moduly".
  expect(view(appsSections(bare, bareGroup, cs, entry, [], true))).toEqual([
    ["workspace", "Workspace", "zatím žádné moduly", []],
  ]);
  expect(view(appsSections(bare, bareGroup, en, null, [], true))).toEqual([
    ["workspace", "Workspace", "no modules yet", []],
  ]);
  // Anyone else, and the Owner until GitHub answered: no section, so the
  // page keeps its sentence.
  expect(appsSections(bare, bareGroup, cs, entry)).toEqual([]);
  expect(appsSections(bare, bareGroup, cs, entry, [], false)).toEqual([]);
  // Production repositories only: the Owner's Workspace comes first.
  const firmware: CatalogRepository = {
    slug: "firmware",
    path: "productionspace/firmware",
    checkedOut: true,
    url: null,
  };
  const repositories: Catalog = {
    kind: "catalog",
    organizations: [
      organization("example", [], {
        forgeLogin: "example-org",
        repositories: [firmware],
      }),
    ],
  };
  const repositoriesGroup = appsScope(repositories, { view: "home" }, cs);
  if (repositoriesGroup === null)
    throw new Error("The fixture has an Organization");
  expect(
    view(appsSections(repositories, repositoriesGroup, cs, entry, [], true)),
  ).toEqual([
    ["workspace", "Workspace", "zatím žádné moduly", []],
    ["productionspace", "Productionspace", "1 repozitář", ["firmware"]],
  ]);
  expect(
    view(appsSections(repositories, repositoriesGroup, cs, entry)),
  ).toEqual([
    ["productionspace", "Productionspace", "1 repozitář", ["firmware"]],
  ]);
  // A Workspace with modules is the same for the Owner and anyone else.
  const group = appsScope(catalog, { view: "home" }, cs);
  if (group === null) throw new Error("The fixture has an Organization");
  expect(appsSections(catalog, group, cs, entry, [], true)).toEqual(
    appsSections(catalog, group, cs, entry, [], false),
  );
  // The personal space: for its verified holder (root decision 0185's
  // addendum of 2026-10-13) its Workspace stays in the same way.
  const personalCatalog: Catalog = {
    kind: "catalog",
    organizations: [],
    personalspace: organization("personalspace", [], {
      directory: "personalspace",
    }),
  };
  const personal = appsScopes(personalCatalog, cs).find(
    (scope) => scope.sections === null,
  );
  if (personal === undefined) throw new Error("The fixture has one");
  expect(
    view(appsSections(personalCatalog, personal, cs, entry, [], true)),
  ).toEqual([["personal", "Workspace", "zatím žádné moduly", []]]);
  expect(appsSections(personalCatalog, personal, cs, entry)).toEqual([]);
});

// Both "+ Nový modul" briefs (F36 addendum of 2026-10-14) are the person's
// own words and short: what they want, where the module goes, and the Folder's
// skill `new-module`, which holds every step. The wireframe's `moduleBrief`
// without a story (HumanAndMachine-ai/prototypes-lazurio#47).
const briefOpening = {
  cs: "Chci postavit nový modul do Workspace Lazuria.",
  en: "I want to build a new module in the Lazurio Workspace.",
} as const;
const briefSkill = {
  cs: "Použij skill `new-module`. Nejdřív se mě vyptej, k čemu modul bude a co mi má vyřešit, technické věci zvol sám a než začneš stavět, ukaž mi plán k potvrzení.",
  en: "Use the skill `new-module`. First ask me what the module is for and what it should solve for me, choose the technical details yourself, and before you start building, show me the plan to confirm.",
} as const;
// What earlier briefs carried, which the skill now owns.
const procedureInBriefs = [
  "lazurio-module-standard",
  "manual/new-module.md",
  "lazurio module create",
  "--dry-run",
  "worktree",
  "vite-react",
  "--teams",
];

test("the new module's prompt is the opening, the Organization with its GitHub login and the skill, in the person's language", () => {
  for (const [copy, locale, where] of [
    [cs, "cs", "Bude v Organizaci Example Company (GitHub example-org)."],
    [
      en,
      "en",
      "It will be in the Organization Example Company (GitHub example-org).",
    ],
  ] as const)
    expect(newModulePrompt("Example Company", "example-org", copy)).toBe(
      [briefOpening[locale], where, "", briefSkill[locale]].join("\n"),
    );
});

test("a tile opens the app on its own origin hosted, starts it locally, and falls back to the overview", () => {
  const [mission, knowledgebase, , website, notes] = example.modules as [
    CatalogModule,
    CatalogModule,
    CatalogModule,
    CatalogModule,
    CatalogModule,
  ];
  expect(tileTarget(catalog, example, knowledgebase, entry)).toEqual({
    kind: "hosted",
    href: "https://knowledgebase.vm-01.example.lazurio.io/",
  });
  expect(tileTarget(catalog, example, mission, null)).toEqual({
    kind: "start",
    start: "/api/modules/example/mission-control/start",
    status: "/api/modules/example/mission-control/status",
    overview: "/o/example/mission-control",
  });
  // No app, or one that cannot start: the overview, hosted or not.
  for (const host of [entry, null]) {
    expect(tileTarget(catalog, example, notes, host)).toEqual({
      kind: "overview",
      href: "/o/example/notes",
    });
    expect(tileTarget(catalog, example, website, host)).toEqual({
      kind: "overview",
      href: "/o/example/website",
    });
  }
  // A module refused only by its preparation opens its overview, which
  // says why and still stops a running app.
  expect(
    tileTarget(
      catalog,
      example,
      { ...knowledgebase, executable: false, preparationRefused: true },
      entry,
    ).kind,
  ).toBe("overview");
  // A module id the gateway serves no label for has no origin.
  expect(
    tileTarget(catalog, example, { ...knowledgebase, module: "api" }, entry),
  ).toEqual({ kind: "overview", href: "/o/example/api" });
  // Two candidates of one slug: each is named by its directory, never by
  // the slug they share.
  const twin = { ...example, directory: "example-copy" };
  const ambiguous: Catalog = {
    kind: "catalog",
    organizations: [example, twin],
  };
  expect(tileTarget(ambiguous, example, knowledgebase, null)).toMatchObject({
    kind: "start",
    start: "/api/modules/example_GEN3/knowledgebase/start",
  });
});

test("Czech plural forms, module names and descriptions", () => {
  const keys = {
    one: "appsModulesOne",
    few: "appsModulesFew",
    many: "appsModulesMany",
  } as const;
  expect(
    [0, 1, 2, 4, 5, 11].map((count) =>
      cs[pluralKey(count, keys)].replace("{count}", String(count)),
    ),
  ).toEqual([
    "0 modulů",
    "1 modul",
    "2 moduly",
    "4 moduly",
    "5 modulů",
    "11 modulů",
  ]);
  expect(en[pluralKey(1, keys)]).toBe("{count} module");
  expect(moduleName(module("crm"))).toBe("crm");
  expect(
    moduleName(module("crm", { display: display("crm", "CRM v12") })),
  ).toBe("CRM");
  // A title that is only a version keeps itself.
  expect(moduleName(module("x", { display: display("x", "v2") }))).toBe("v2");
  expect(
    moduleDescription(
      module("ledger", {
        display: display("ledger", "Ledger", { description: "  " }),
      }),
      en,
    ),
  ).toBe("Data, records, and their safe management.");
  expect(moduleStone(module("ledger")).key).toBe("database");
});

// The vendored brand assets are the pinned bytes (src/shell/vendor/README.md).
test("every vendored file has the hash its README records", async () => {
  const directory = join(import.meta.dir, "..", "src", "shell", "vendor");
  const readme = await readFile(join(directory, "README.md"), "utf8");
  const rows = [
    ...readme.matchAll(/\| `([^`]+)` \|(?: `[^`]+` \|)? `([0-9a-f]{64})` \|/g),
  ];
  expect(rows.length).toBe(22);
  for (const [, file, hash] of rows) {
    const bytes = await readFile(join(directory, file ?? ""));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(hash ?? "");
  }
});

// Root decision 0185's addendum of 2026-10-13 (DEV-6662, #359): after the
// personal space's modules its holder sees a quiet section "Co dalšího tu
// můžete dělat", four links into the apps that own those things. Chat and
// Automate come from the switch of the Environment as the column head draws
// it, so a start never leads elsewhere than its tab; where the app does not
// run, the start is muted with the switch's own words. Integrace and Soubory
// are the column's own routes and names.

// The switch of a personal Remote Environment with MausBot, of one without
// it, and of a workstation, which has neither Chat nor Automate: the shell
// document's producer, as the column head draws it.
const personalHost = "example.lazurio.io";
const withMausBot = binding({
  ...personalContext,
  entry: {
    ...handoverEntry(personalHost),
    mausbot: {
      external_origin: `https://mausbot.${personalHost}`,
      listen_port: 4102,
    },
  },
});
const switchOf = (
  locale: "cs" | "en",
  preset: "hosted-personal" | "local",
  machine: MachineBinding | null,
): readonly SwitchTab[] =>
  switchTabs(
    shellDocument({
      preset,
      machine,
      locale,
      catalog: { kind: "catalog", organizations: [] },
    }),
    shellMessages(locale),
    "apps",
  );
const startsView = (starts: readonly PersonalStart[]) =>
  starts.map((start) => [start.key, start.name, start.text, start.target]);

test("the personal space's starts: Chat and Automate lead where the switch's tabs do, or say its words where they do not run; Integrace and Soubory lead where the column does", () => {
  const chat = "https://t3code.example.lazurio.io/";
  const integrations = { kind: "route", href: "/integrations" } as const;
  const files = { kind: "route", href: "/files" } as const;
  // A personal Remote Environment with MausBot: four links, in this order.
  expect(
    startsView(
      personalStarts(switchOf("cs", "hosted-personal", withMausBot), cs),
    ),
  ).toEqual([
    [
      "chat",
      "Chat",
      "Zadejte agentovi první úkol",
      { kind: "app", app: "chat", href: chat },
    ],
    [
      "automate",
      "Automate",
      "Nastavte, co se má dít samo",
      {
        kind: "app",
        app: "automate",
        href: "https://mausbot.example.lazurio.io/",
      },
    ],
    ["integrations", "Integrace", "Připojte poštu a kalendář", integrations],
    ["files", "Soubory", "Nahrajte podklady pro agenty", files],
  ]);
  // Without MausBot, Automate is muted: no link, the switch's sentence.
  expect(
    startsView(
      personalStarts(
        switchOf("cs", "hosted-personal", personalWithEntry()),
        cs,
      ),
    ),
  ).toEqual([
    [
      "chat",
      "Chat",
      "Zadejte agentovi první úkol",
      { kind: "app", app: "chat", href: chat },
    ],
    ["automate", "Automate", "MausBot v tomto Prostředí neběží", null],
    ["integrations", "Integrace", "Připojte poštu a kalendář", integrations],
    ["files", "Soubory", "Nahrajte podklady pro agenty", files],
  ]);
  // A workstation runs neither Chat nor Automate (root decision 0185's
  // addendum, Q1): both muted, in English as the switch says it.
  expect(startsView(personalStarts(switchOf("en", "local", null), en))).toEqual(
    [
      ["chat", "Chat", "Chat does not run on this Environment", null],
      [
        "automate",
        "Automate",
        "MausBot does not run on this Environment",
        null,
      ],
      [
        "integrations",
        "Integrations",
        "Connect your mail and calendar",
        integrations,
      ],
      ["files", "Files", "Upload documents for the agents", files],
    ],
  );
  // No start ever leads elsewhere than its tab, nor says otherwise why not.
  for (const tabs of [
    switchOf("cs", "hosted-personal", withMausBot),
    switchOf("cs", "hosted-personal", personalWithEntry()),
    switchOf("en", "local", null),
  ]) {
    const starts = personalStarts(tabs, cs);
    for (const app of ["chat", "automate"] as const) {
      const tab = tabs.find((entry) => entry.app === app);
      const start = starts.find((entry) => entry.key === app);
      if (tab === undefined || start === undefined)
        throw new Error("The switch and the starts have both apps");
      expect(start.name).toBe(tab.label);
      expect(start.target === null ? null : start.target.href).toBe(tab.href);
      if (tab.href === null) expect(start.text).toBe(tab.missing ?? "");
    }
  }
  // Before the shell document is read there is no switch, and no start.
  expect(personalStarts([], cs)).toEqual([]);
});

test("Integrace and Soubory are the column's own items: the same routes, and their names from the same words", async () => {
  const html = await readFile(
    join(import.meta.dir, "..", "src", "launchpad", "index.html"),
    "utf8",
  );
  const item = (id: string) => {
    const found = new RegExp(
      `<a [^>]*href="([^"]+)" id="${id}"[^>]*>.*?data-message="([A-Za-z]+)"`,
    ).exec(html);
    if (found === null) throw new Error(`The column has #${id}`);
    return { href: found[1] ?? "", key: found[2] as MessageKey };
  };
  for (const copy of [cs, en]) {
    const starts = personalStarts(switchOf("cs", "local", null), copy);
    for (const [key, id] of [
      ["integrations", "integrations-open"],
      ["files", "files-open"],
    ] as const) {
      const start = starts.find((entry) => entry.key === key);
      const column = item(id);
      expect(start?.target).toEqual({ kind: "route", href: column.href });
      expect(start?.name).toBe(copy[column.key]);
    }
  }
});

// The personal space as the catalog lists it (#186): to its holder without a
// reason, with or without modules; to anyone else with the reason and none.
const personalspace = (
  modules: CatalogModule[],
  extra: Partial<CatalogOrganization> = {},
): Catalog => ({
  kind: "catalog",
  organizations: [],
  personalspace: organization("personalspace", modules, {
    directory: "personalspace",
    displayName: "Personalspace",
    state: null,
    ...extra,
  }),
});
const personalGroup = (value: Catalog) => {
  const group = appsScopes(value, cs).find((scope) => scope.sections === null);
  if (group === undefined) throw new Error("The fixture has a personal space");
  return group;
};
const homeView = (parts: readonly AppsHomePart[]) =>
  parts.map((part) =>
    part.kind === "empty"
      ? [part.kind, part.text]
      : part.kind === "section"
        ? [part.kind, part.section.title, part.section.tiles.map((t) => t.name)]
        : [part.kind, part.title, part.starts.map((start) => start.key)],
  );

test("the holder's personal space ends with the starts: after its sentence while it is empty, after its whole grid once it has modules", () => {
  const input = {
    entry,
    favorites: [] as string[],
    setup: false,
    tabs: switchOf("cs", "hosted-personal", personalWithEntry()),
  };
  const starts = [
    "starts",
    "Co dalšího tu můžete dělat",
    ["chat", "automate", "integrations", "files"],
  ];
  const empty = personalspace([]);
  expect(
    homeView(appsHomeParts(empty, personalGroup(empty), cs, input)),
  ).toEqual([["empty", "Osobní prostor je zatím prázdný."], starts]);
  const diary = module("diary", { organization: "personalspace" });
  const notes = module("notes", { organization: "personalspace" });
  const full = personalspace([diary, notes]);
  expect(homeView(appsHomeParts(full, personalGroup(full), cs, input))).toEqual(
    [["section", "Workspace", ["diary", "notes"]], starts],
  );
  // A favourite reorders the grid; the starts stay after all of it.
  expect(
    homeView(
      appsHomeParts(full, personalGroup(full), cs, {
        ...input,
        favorites: [moduleFavorite("notes")],
      }),
    ),
  ).toEqual([["section", "Workspace", ["notes", "diary"]], starts]);
  // In English, with the muted Automate of this Environment.
  const english = appsHomeParts(full, personalGroup(full), en, {
    ...input,
    tabs: switchOf("en", "hosted-personal", personalWithEntry()),
  }).at(-1);
  expect(english?.kind === "starts" && english.title).toBe(
    "What else you can do here",
  );
  expect(
    english?.kind === "starts" &&
      english.starts.map((start) => [start.key, start.target === null]),
  ).toEqual([
    ["chat", false],
    ["automate", true],
    ["integrations", false],
    ["files", false],
  ]);
});

test("no starts but the holder's: not for a personal space held by no one here, not while the first run's line shows, not before the switch is known, never in an Organization", () => {
  const input = {
    entry,
    favorites: [] as string[],
    setup: false,
    tabs: switchOf("cs", "hosted-personal", withMausBot),
  };
  // Listed with a reason (#186): its status line says why; nothing else.
  for (const reason of [
    "personalspace-unverified",
    "personalspace-foreign",
    "personalspace-not-owned",
    "personalspace-public",
    "personalspace-ambiguous",
    "github-signed-out",
    "github-unavailable",
    "github-identity-mismatch",
  ] as const) {
    const blocked = personalspace([], { executable: false, reason });
    expect(appsHomeParts(blocked, personalGroup(blocked), cs, input)).toEqual(
      [],
    );
  }
  // The first run's line says what is next: no sentence and no starts.
  const empty = personalspace([]);
  const full = personalspace([
    module("diary", { organization: "personalspace" }),
  ]);
  const setup = { ...input, setup: true };
  expect(
    homeView(appsHomeParts(empty, personalGroup(empty), cs, setup)),
  ).toEqual([]);
  expect(homeView(appsHomeParts(full, personalGroup(full), cs, setup))).toEqual(
    [["section", "Workspace", ["diary"]]],
  );
  // The shell document not read yet: the starts come once the switch is.
  expect(
    homeView(
      appsHomeParts(full, personalGroup(full), cs, { ...input, tabs: [] }),
    ),
  ).toEqual([["section", "Workspace", ["diary"]]]);
  // An Organization keeps its sections, or its sentence; never the starts.
  const group = appsScope(catalog, { view: "home" }, cs);
  if (group === null) throw new Error("The fixture has an Organization");
  expect(homeView(appsHomeParts(catalog, group, cs, input))).toEqual([
    [
      "section",
      "Workspace",
      ["Mission Control", "Knowledgebase", "deals", "website", "notes"],
    ],
    ["section", "Productionspace", ["firmware"]],
  ]);
  const bare: Catalog = {
    kind: "catalog",
    organizations: [organization("example", [])],
  };
  const bareGroup = appsScope(bare, { view: "home" }, cs);
  if (bareGroup === null) throw new Error("The fixture has an Organization");
  expect(homeView(appsHomeParts(bare, bareGroup, cs, input))).toEqual([
    ["empty", cs.catalogNoModules],
  ]);
  // Its Owner (#376) gets the empty Workspace instead of the sentence,
  // where the Organization is bound to a GitHub login the tile can name.
  const bound: Catalog = {
    kind: "catalog",
    organizations: [organization("example", [], { forgeLogin: "example-org" })],
  };
  const boundGroup = appsScope(bound, { view: "home" }, cs);
  if (boundGroup === null) throw new Error("The fixture has an Organization");
  expect(
    homeView(appsHomeParts(bound, boundGroup, cs, { ...input, owner: true })),
  ).toEqual([["section", "Workspace", []]]);
});

// "+ Nový modul" in the personal space (root decision 0185's addendum of
// 2026-10-13, plan DEV-6662 M1b): for its verified holder the Workspace is
// always there and ends with the tile, which hands over the prompt
// `new-personal-module` with the holder's login; the starts stay after it.
const offerView = (parts: readonly AppsHomePart[]) =>
  parts.map((part) =>
    part.kind === "section"
      ? [
          part.kind,
          part.section.title,
          part.section.count,
          part.section.tiles.map((t) => t.name),
          part.offer === null
            ? null
            : [part.offer.id, part.offer.organization, part.offer.text],
        ]
      : part.kind === "empty"
        ? [part.kind, part.text]
        : [part.kind],
  );

test("the holder's personal Workspace is always there and ends with + Nový modul, before the starts: alone while it is empty, after the grid once it has modules", () => {
  const input = {
    entry,
    favorites: [] as string[],
    setup: false,
    tabs: switchOf("cs", "hosted-personal", personalWithEntry()),
    holder: "Example",
  };
  const offer = [
    "new-personal-module",
    "Example",
    newPersonalModulePrompt("Example", cs),
  ];
  const empty = personalspace([]);
  // No sentence: the Workspace takes its place, its only tile the offer.
  expect(
    offerView(appsHomeParts(empty, personalGroup(empty), cs, input)),
  ).toEqual([
    ["section", "Workspace", "zatím žádné moduly", [], offer],
    ["starts"],
  ]);
  const full = personalspace([
    module("diary", { organization: "personalspace" }),
    module("notes", { organization: "personalspace" }),
  ]);
  expect(
    offerView(appsHomeParts(full, personalGroup(full), cs, input)),
  ).toEqual([
    ["section", "Workspace", "2 moduly", ["diary", "notes"], offer],
    ["starts"],
  ]);
  // In English, the prompt in English.
  expect(
    offerView(
      appsHomeParts(empty, personalGroup(empty), en, {
        ...input,
        tabs: switchOf("en", "hosted-personal", personalWithEntry()),
      }),
    ),
  ).toEqual([
    [
      "section",
      "Workspace",
      "no modules yet",
      [],
      [
        "new-personal-module",
        "Example",
        newPersonalModulePrompt("Example", en),
      ],
    ],
    ["starts"],
  ]);
  // The first run's line hides the starts, never the holder's Workspace.
  expect(
    offerView(
      appsHomeParts(empty, personalGroup(empty), cs, {
        ...input,
        setup: true,
      }),
    ),
  ).toEqual([["section", "Workspace", "zatím žádné moduly", [], offer]]);
});

test("no personal tile but the holder's: not before the holder is known, not for a blocked personal space, never in an Organization", () => {
  const input = {
    entry,
    favorites: [] as string[],
    setup: false,
    tabs: switchOf("cs", "hosted-personal", personalWithEntry()),
  };
  // The content status not read yet, or not present: today's home, the
  // sentence or the grid, and the starts.
  const empty = personalspace([]);
  const full = personalspace([
    module("diary", { organization: "personalspace" }),
  ]);
  for (const holder of [undefined, null]) {
    expect(
      offerView(
        appsHomeParts(empty, personalGroup(empty), cs, {
          ...input,
          ...(holder === undefined ? {} : { holder }),
        }),
      ),
    ).toEqual([["empty", cs.catalogPersonalspaceEmpty], ["starts"]]);
    expect(
      offerView(
        appsHomeParts(full, personalGroup(full), cs, {
          ...input,
          ...(holder === undefined ? {} : { holder }),
        }),
      ),
    ).toEqual([
      ["section", "Workspace", "1 modul", ["diary"], null],
      ["starts"],
    ]);
  }
  // Listed with a reason (#186): nothing, whatever login the page has.
  for (const reason of [
    "personalspace-unverified",
    "personalspace-foreign",
    "personalspace-public",
    "github-identity-mismatch",
  ] as const) {
    const blocked = personalspace([], { executable: false, reason });
    expect(
      appsHomeParts(blocked, personalGroup(blocked), cs, {
        ...input,
        holder: "example",
      }),
    ).toEqual([]);
  }
  // An Organization: its own offer only for its Owner; a holder's login
  // changes nothing there.
  const group = appsScope(catalog, { view: "home" }, cs);
  if (group === null) throw new Error("The fixture has an Organization");
  const offers = (owner: boolean) =>
    appsHomeParts(catalog, group, cs, { ...input, owner, holder: "example" })
      .flatMap((part) => (part.kind === "section" ? [part.offer] : []))
      .map((offer) => offer?.id ?? null);
  expect(offers(false)).toEqual([null, null]);
});

test("the offer: an Organization's Owner gets new-module, the personal space's holder new-personal-module, everyone else nothing", () => {
  const bound = organization("example", [], { forgeLogin: "Example-Org" });
  const unbound = organization("example", []);
  const scopeOf = (value: Catalog) => {
    const scope = appsScope(value, { view: "home" }, cs);
    if (scope === null) throw new Error("The fixture has an Organization");
    return scope;
  };
  const one = (value: CatalogOrganization): Catalog => ({
    kind: "catalog",
    organizations: [value],
  });
  const organizationGroup = scopeOf(one(bound));
  expect(
    newModuleOffer(organizationGroup, cs, { owner: true, holder: null }),
  ).toEqual({
    id: "new-module",
    organization: "Example-Org",
    text: newModulePrompt("Example Company", "Example-Org", cs),
  });
  for (const input of [
    { owner: false, holder: null },
    { owner: false, holder: "example" },
  ])
    expect(newModuleOffer(organizationGroup, cs, input)).toBeNull();
  // An Organization the manifest binds to no login: no link to make.
  expect(
    newModuleOffer(scopeOf(one(unbound)), cs, { owner: true, holder: null }),
  ).toBeNull();
  const held = personalspace([]);
  expect(
    newModuleOffer(personalGroup(held), cs, {
      owner: false,
      holder: "example",
    }),
  ).toEqual({
    id: "new-personal-module",
    organization: "example",
    text: newPersonalModulePrompt("example", cs),
  });
  // No holder, an Owner answer, a malformed login, a blocked space: none.
  for (const input of [
    { owner: false, holder: null },
    { owner: true, holder: null },
    { owner: false, holder: "a/b" },
    { owner: false, holder: "-x" },
    { owner: false, holder: "" },
  ])
    expect(newModuleOffer(personalGroup(held), cs, input)).toBeNull();
  const blocked = personalspace([], {
    executable: false,
    reason: "personalspace-foreign",
  });
  expect(
    newModuleOffer(personalGroup(blocked), cs, {
      owner: false,
      holder: "example",
    }),
  ).toBeNull();
});

test("the personal module's prompt is the opening, a private repository on the holder's account and the skill, in both languages, with no procedure of its own", () => {
  for (const [copy, locale, where] of [
    [
      cs,
      "cs",
      "Bude v mém osobním prostoru, jako soukromý repozitář na mém GitHub účtu Example.",
    ],
    [
      en,
      "en",
      "It will be in my personal space, as a private repository on my GitHub account Example.",
    ],
  ] as const)
    expect(newPersonalModulePrompt("Example", copy)).toBe(
      [briefOpening[locale], where, "", briefSkill[locale]].join("\n"),
    );
  for (const prompt of [
    newPersonalModulePrompt("Example", cs),
    newPersonalModulePrompt("Example", en),
    newModulePrompt("Example Company", "example-org", cs),
    newModulePrompt("Example Company", "example-org", en),
  ])
    for (const procedure of procedureInBriefs)
      expect([procedure, prompt.includes(procedure)]).toEqual([
        procedure,
        false,
      ]);
});

test("the holder's login: the content routes' personalspace item only when it is present", () => {
  const item = (
    state: "present" | "absent" | "blocked",
    login: string | null,
  ) => ({
    allowed: true,
    items: [
      {
        kind: "organization" as const,
        login: "example-org",
        state: "present" as const,
      },
      { kind: "personalspace" as const, login, state },
    ],
  });
  expect(personalHolderOf(item("present", "Example"))).toBe("Example");
  expect(personalHolderOf(item("blocked", "Example"))).toBeNull();
  expect(personalHolderOf(item("absent", "Example"))).toBeNull();
  expect(personalHolderOf(item("present", null))).toBeNull();
  expect(personalHolderOf(item("present", "a/b"))).toBeNull();
  expect(personalHolderOf({ allowed: false, items: [] })).toBeNull();
  expect(personalHolderOf(null)).toBeNull();
});
