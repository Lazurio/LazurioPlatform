import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  appDirectory,
  appsMatch,
  appsScope,
  appsSections,
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
} from "../src/organizations/catalog";

// Decision F36: the Apps home as pure functions, like the catalog's view
// tests. One Organization at a time, its sections Organizace, Workspace and
// Productionspace with counts, and where each tile leads: the module's own
// origin hosted, start-then-open locally, the overview without an app.

const cs = messages("cs");
const en = messages("en");

const module = (
  id: string,
  extra: Partial<CatalogModule> = {},
): CatalogModule => ({
  organization: "example",
  module: id,
  path: `workspace/${id}`,
  layout: "workspace",
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
const example = organization(
  "example",
  [
    module("mission-control", {
      path: "mission-control",
      layout: "organization",
    }),
    module("knowledgebase"),
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
        slug: "infra",
        layout: "organization",
        path: "infra",
        checkedOut: true,
        url: "https://github.com/example/infra",
      },
      {
        slug: "firmware",
        layout: "productionspace",
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

test("three sections in order with Czech counts; status only by exception; a module without an app is no failure", () => {
  const group = appsScope(catalog, { view: "home" }, cs);
  if (group === null) throw new Error("The fixture has an Organization");
  const sections = appsSections(catalog, group, cs, null);
  expect(
    sections.map((section) => [
      section.layout,
      section.title,
      section.count,
      section.subtitle,
      section.tiles.map((tile) => tile.name),
    ]),
  ).toEqual([
    [
      "organization",
      "Organizace",
      "2 moduly",
      null,
      ["mission-control", "infra"],
    ],
    [
      "workspace",
      "Workspace",
      "4 moduly",
      "Example Company Workspace",
      ["knowledgebase", "deals", "website", "notes"],
    ],
    [
      "productionspace",
      "Productionspace",
      "1 repozitář",
      "Repozitáře Organizace s vlastním releasem, jen pro čtení",
      ["firmware"],
    ],
  ]);
  const workspace = sections[1]?.tiles ?? [];
  expect(workspace.map((tile) => tile.note?.text ?? null)).toEqual([
    null,
    null,
    "Nelze spustit",
    null,
  ]);
  expect(workspace.map((tile) => tile.description)).toEqual([
    "app/v1",
    "app/v1",
    "app/v1",
    "Bez aplikace",
  ]);
  expect(workspace[0]?.mark).toBe("KN");
  const firmware = sections[2]?.tiles[0];
  expect(firmware?.kind === "repository" && firmware.href).toBe(null);
  expect(firmware?.note?.text).toBe("Nenaklonovaný");
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
  expect(appDirectory("app/v1/package.json")).toBe("app/v1");
  expect(appDirectory("package.json")).toBe(".");
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
  expect(rows.length).toBe(8);
  for (const [, file, hash] of rows) {
    const bytes = await readFile(join(directory, file ?? ""));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(hash ?? "");
  }
});
