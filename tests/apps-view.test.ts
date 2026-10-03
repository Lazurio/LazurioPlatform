import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  appsMatch,
  appsScope,
  appsSections,
  moduleDescription,
  moduleName,
  moduleStone,
  pluralKey,
  tileTarget,
} from "../src/launchpad/apps-view";
import { parseCatalog } from "../src/launchpad/catalog-view";
import type { PublicEntry } from "../src/launchpad/chat";
import { messages } from "../src/launchpad/messages";
import type {
  Catalog,
  CatalogModule,
  CatalogOrganization,
  CatalogRepository,
} from "../src/organizations/catalog";

// Decision F36: the Apps home as pure functions, like the catalog's view
// tests. One Organization at a time, its two sections Workspace (every
// module) and Productionspace (production repositories, read-only) with
// counts, and where each tile leads: the module's own origin hosted,
// start-then-open locally, the overview without an app.

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

test("two sections, Workspace with every module in catalog order and Productionspace read-only, with Czech counts; status only by exception; a module without an app is no failure", () => {
  const group = appsScope(catalog, { view: "home" }, cs);
  if (group === null) throw new Error("The fixture has an Organization");
  const sections = appsSections(catalog, group, cs, null);
  expect(
    sections.map((section) => [
      section.kind,
      section.title,
      section.count,
      section.subtitle,
      section.tiles.map((tile) => tile.name),
    ]),
  ).toEqual([
    [
      "workspace",
      "Workspace",
      "5 modulů",
      "Example Company Workspace",
      ["Mission Control", "Knowledgebase", "deals", "website", "notes"],
    ],
    [
      "productionspace",
      "Productionspace",
      "1 repozitář",
      "Repozitáře Organizace s vlastním releasem, jen pro čtení",
      ["firmware"],
    ],
  ]);
  const [mission, ...workspace] = sections[0]?.tiles ?? [];
  expect(workspace.map((tile) => tile.note?.text ?? null)).toEqual([
    null,
    null,
    "Nelze spustit",
    null,
  ]);
  // The declared description first, otherwise the org-agnostic sentence of
  // the stone's key; "No app" without an app.
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
  expect(mission?.name).toBe("Mission Control");
  expect(mission?.kind === "module" && mission.stone).toEqual({
    key: "control",
    src: "/.lazurio/stones/mission-control-96.png",
    accent: "var(--lz-blue-500)",
  });
  const firmware = sections[1]?.tiles[0];
  expect(firmware?.kind === "repository" && firmware.href).toBe(null);
  expect(firmware?.note?.text).toBe("Nenaklonovaný");
  expect(firmware?.note?.tone).toBe("muted");
});

test("a production repository's tile has no action: no lifecycle target, no page, no status dot; at most its GitHub page", () => {
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
        repository: connect,
        name: "connect",
        description: "productionspace/connect",
        note: null,
        href: "https://github.com/example/connect",
      },
    ]);
    // Nothing a module tile has: no target to start or open, no stone.
    const [tile] = productionspace?.tiles ?? [];
    expect(tile && "target" in tile).toBe(false);
    expect(tile && "stone" in tile).toBe(false);
  }
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

test("Czech plural forms, app directories and the column's search", () => {
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
  expect(appsMatch("knowledgebase", " KNOW ")).toBe(true);
  expect(appsMatch("deals", "know")).toBe(false);
});

// The vendored brand assets are the pinned bytes (src/shell/vendor/README.md).
test("every vendored file has the hash its README records", async () => {
  const directory = join(import.meta.dir, "..", "src", "shell", "vendor");
  const readme = await readFile(join(directory, "README.md"), "utf8");
  const rows = [
    ...readme.matchAll(/\| `([^`]+)` \|(?: `[^`]+` \|)? `([0-9a-f]{64})` \|/g),
  ];
  expect(rows.length).toBe(21);
  for (const [, file, hash] of rows) {
    const bytes = await readFile(join(directory, file ?? ""));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(hash ?? "");
  }
});
