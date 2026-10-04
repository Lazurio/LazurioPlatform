import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  appsGithubNotice,
  appsScope,
  appsScopes,
  appsSections,
  favoriteTiles,
  moduleAccessTarget,
  moduleAccessUrl,
  moduleDescription,
  moduleName,
  moduleStone,
  newModulePrompt,
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
import { messages } from "../src/launchpad/messages";
import type {
  Catalog,
  CatalogModule,
  CatalogOrganization,
  CatalogRepository,
} from "../src/organizations/catalog";

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

test("the new module's prompt names the Organization and its GitHub login, in the person's language", () => {
  const prompt = newModulePrompt("Example Company", "example-org", cs);
  expect(prompt).toStartWith(
    "Chci založit nový modul v Organizaci Example Company (GitHub example-org).",
  );
  expect(prompt).toContain("lazurio module create example-org/<slug>");
  expect(prompt).not.toContain("{");
  expect(newModulePrompt("Example Company", "example-org", en)).toContain(
    "in the Organization Example Company (GitHub example-org)",
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

// An empty Apps catalog does not establish whether GitHub is signed in.
// Apps consumes the same observed status as Settings > Tools.
test("Apps directs a confirmed signed-out GitHub to the existing Tools flow", () => {
  const status = {
    sharedEnvironment: false,
    tools: [
      { name: "gh", installed: true, signIn: { state: "signed-out" as const } },
    ],
  };
  expect(appsGithubNotice(status, cs)).toEqual({
    title: "Přihlas se ke GitHubu",
    description: cs.appsGithubSignInDescription,
    action: cs.appsGithubSignInAction,
    href: "/settings/tools",
  });
  expect(appsGithubNotice(status, en)?.title).toBe("Sign in to GitHub");
  expect(
    appsGithubNotice({ ...status, sharedEnvironment: true }, cs),
  ).toBeNull();
  for (const signIn of [
    undefined,
    { state: "unknown" as const },
    { state: "signed-in" as const },
  ])
    expect(
      appsGithubNotice(
        {
          ...status,
          tools: [
            {
              name: "gh",
              installed: true,
              ...(signIn === undefined ? {} : { signIn }),
            },
          ],
        },
        cs,
      ),
    ).toBeNull();
  expect(appsGithubNotice(null, cs)).toBeNull();
  expect(appsGithubNotice({ ...status, tools: [] }, cs)).toBeNull();
  expect(
    appsGithubNotice(
      {
        ...status,
        tools: [
          {
            name: "gh",
            installed: false,
            signIn: { state: "signed-out" as const },
          },
        ],
      },
      cs,
    ),
  ).toBeNull();
  expect(
    appsGithubNotice(
      {
        ...status,
        tools: [
          {
            name: "codex",
            installed: true,
            signIn: { state: "signed-out" as const },
          },
        ],
      },
      cs,
    ),
  ).toBeNull();
});
