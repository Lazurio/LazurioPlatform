import { expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeFolder } from "../src/folder/initialize-folder";
import { executionOs } from "../src/folder/platform";
import {
  appsScope,
  appsScopes,
  appsSectionHead,
  appsSections,
  workspaceTabsTarget,
} from "../src/launchpad/apps-view";
import {
  type CatalogGroupEntry,
  parseCatalog,
  workspaceTabs,
} from "../src/launchpad/catalog-view";
import { messages } from "../src/launchpad/messages";
import {
  type Catalog,
  type CatalogModule,
  type CatalogOrganization,
  readFolderCatalog,
} from "../src/organizations/catalog";
import { writeOrganization } from "./fixtures/catalog-folder";

// Decision F32's addendum of 2026-10-16: an Organization arranges its
// Workspace into its own tabs, one setting (`workspace.tabs`, root decision
// 0194) in its root's `lazurio.organization.json`, the same for every member.
// The catalog reads it with the rest of the Organization; Apps shows it.

const cs = messages("cs");

async function withFolder(run: (folder: string) => Promise<void>) {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "tabs-")));
  const folder = join(parent, "Lazurio");
  try {
    await initializeFolder(folder, {
      os: executionOs(process.platform),
      access: "local",
      purpose: "human",
      locale: "cs",
      detail: "concise",
      coordination: "direct",
    });
    await run(folder);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

async function withSettings(root: string, settings: unknown) {
  const file = join(root, "lazurio.organization.json");
  const document = JSON.parse(await readFile(file, "utf8"));
  await writeFile(file, JSON.stringify({ ...document, settings }));
}

const tabs = [
  { name: "Každodenní práce", modules: ["deals"] },
  { name: "Finance", modules: ["invoices", "pricing"] },
  { name: "Sklad", modules: ["stock", "gone"] },
];

test("the catalog reads the Organization's tabs from its root; an invalid section or none declares no tabs", async () => {
  await withFolder(async (folder) => {
    const root = await writeOrganization(folder, "example_GEN3", {
      slug: "example",
      state: "current",
      modules: [
        { id: "deals" },
        { id: "invoices" },
        { id: "pricing" },
        { id: "stock" },
        { id: "notes", apps: false },
      ],
    });
    const plain = await readFolderCatalog(folder);
    expect(plain.organizations[0]?.workspaceTabs).toBeUndefined();
    await withSettings(root, { workspace: { tabs } });
    const read = await readFolderCatalog(folder);
    expect(read.organizations[0]?.workspaceTabs).toEqual(tabs);
    // The page accepts what the server answers.
    expect(parseCatalog(JSON.parse(JSON.stringify(read)))).not.toBeNull();
    // Two tabs of one name break the section: nothing of it applies, and
    // the Workspace stays one list with every module.
    await withSettings(root, {
      workspace: {
        tabs: [
          { name: "Finance", modules: [] },
          { name: "finance", modules: [] },
        ],
      },
    });
    const invalid = await readFolderCatalog(folder);
    expect(invalid.organizations[0]?.workspaceTabs).toBeUndefined();
    expect(invalid.organizations[0]?.modules.length).toBe(5);
  });
});

const module = (
  id: string,
  extra: Partial<CatalogModule> = {},
): CatalogModule => ({
  organization: "example",
  module: id,
  path: `workspace/${id}`,
  teams: [],
  teamsSource: "default",
  apps: [{ package: "app/package.json", kind: "runtime-declared" }],
  defaultApp: "app/package.json",
  state: "current",
  executable: true,
  ...extra,
});
const organization = (
  modules: CatalogModule[],
  extra: Partial<CatalogOrganization> = {},
): CatalogOrganization => ({
  directory: "example_GEN3",
  organization: "example",
  displayName: "Example Company",
  forgeLogin: "example",
  state: "current",
  issues: [],
  executable: true,
  teams: [],
  modules,
  repositories: [
    {
      slug: "firmware",
      path: "productionspace/firmware",
      checkedOut: false,
      url: null,
    },
  ],
  ...extra,
});
const modules = [
  module("mission-control", { path: "mission-control" }),
  module("deals"),
  module("invoices"),
  module("pricing"),
  module("stock"),
  // Declared, but never materialized here: no tile (F32 addendum of
  // 2026-10-15), so its tab shows nothing and is left out.
  module("payroll", { absent: true }),
];
const example = organization(modules, {
  workspaceTabs: [...tabs, { name: "Mzdy", modules: ["payroll"] }],
});
const catalog: Catalog = { kind: "catalog", organizations: [example] };

test("the catalog fixture is one the page accepts", () => {
  expect(parseCatalog(JSON.parse(JSON.stringify(catalog)))).not.toBeNull();
  const wrong = organization(modules, {
    workspaceTabs: [{ name: "Finance", modules: ["../deals"] }],
  });
  expect(parseCatalog({ kind: "catalog", organizations: [wrong] })).toBeNull();
});

test("Apps shows the tabs in the Organization's order; a module in no tab is in the first; a tab with nothing here is left out", () => {
  const group = appsScope(catalog, { view: "home" }, cs);
  if (group === null) throw new Error("The fixture has an Organization");
  const [workspace, productionspace] = appsSections(catalog, group, cs, null, [
    "m:pricing",
  ]);
  expect(workspace?.kind).toBe("workspace");
  expect(
    workspace?.tabs?.map((tab) => [
      tab.name,
      tab.tiles.map((tile) => tile.key),
    ]),
  ).toEqual([
    // mission-control is in no tab: the first one holds it.
    ["Každodenní práce", ["m:mission-control", "m:deals"]],
    // Favourites first within a tab.
    ["Finance", ["m:pricing", "m:invoices"]],
    // "gone" names no module here: no tile.
    ["Sklad", ["m:stock"]],
  ]);
  // The Workspace beside its tabs is unchanged: every module that is here,
  // once, and Productionspace as before.
  expect(workspace?.tiles.map((tile) => tile.key).sort()).toEqual([
    "m:deals",
    "m:invoices",
    "m:mission-control",
    "m:pricing",
    "m:stock",
  ]);
  expect(productionspace?.tabs).toBeNull();
  expect(productionspace?.tiles.map((tile) => tile.key)).toEqual([
    "r:firmware",
  ]);
});

test("the Workspace's head: the flag first, then the tabs' switch with 'Upravit karty' after it and no count; every other section keeps its count", () => {
  // Decision F32's addendum of 2026-10-19 (prototypes-lazurio#73): the
  // switch stands at the head's right end and the flag on the rule. Where
  // each part stands to the pixel is checked in a browser.
  const group = appsScope(catalog, { view: "home" }, cs);
  if (group === null) throw new Error("The fixture has an Organization");
  const [workspace, productionspace] = appsSections(catalog, group, cs, null);
  if (workspace === undefined || productionspace === undefined)
    throw new Error("The fixture has both sections");
  const edit =
    "https://dashboard.lazurio.ai/orgs/example/settings?tab=modules&focus=workspace-tabs";
  const head = appsSectionHead(workspace, edit);
  expect(head.flag).toBe("Workspace");
  if (head.end.kind !== "tabs") throw new Error("The Workspace has tabs");
  expect(head.end.tabs.map((tab) => tab.name)).toEqual([
    "Každodenní práce",
    "Finance",
    "Sklad",
  ]);
  expect(head.end.edit).toBe(edit);
  // Anyone but the Owner: the switch alone.
  expect(appsSectionHead(workspace, null).end).toMatchObject({
    kind: "tabs",
    edit: null,
  });
  // Productionspace never has tabs: its count, and no edit even for the Owner.
  expect(appsSectionHead(productionspace, edit)).toEqual({
    flag: "Productionspace",
    badge: null,
    end: { kind: "count", count: productionspace.count },
  });
  // A Workspace without tabs keeps its count.
  expect(appsSectionHead({ ...workspace, tabs: null }, edit)).toEqual({
    flag: "Workspace",
    badge: null,
    end: { kind: "count", count: workspace.count },
  });
});

test("fewer than two tabs with modules here show none: the plain Workspace", () => {
  const group = appsScope(catalog, { view: "home" }, cs) as CatalogGroupEntry;
  const here = group.modules.filter((entry) =>
    ["deals", "invoices"].includes(entry.module.module),
  );
  expect(workspaceTabs(undefined, here)).toBeNull();
  expect(workspaceTabs([], here)).toBeNull();
  // Everything here is in the first tab: one tab, so no row of tabs.
  expect(
    workspaceTabs(
      [
        { name: "Vše", modules: [] },
        { name: "Sklad", modules: ["stock"] },
      ],
      here,
    ),
  ).toBeNull();
  expect(
    workspaceTabs(
      [
        { name: "Vše", modules: [] },
        { name: "Finance", modules: ["invoices"] },
      ],
      here,
    )?.map((tab) => [
      tab.name,
      tab.modules.map((entry) => entry.module.module),
    ]),
  ).toEqual([
    ["Vše", ["deals"]],
    ["Finance", ["invoices"]],
  ]);
});

test("only the Organization's Owner is led to arrange the tabs, in its Dashboard; never the personal space or a repository", () => {
  const withPersonal: Catalog = {
    ...catalog,
    personalspace: organization(
      [module("diary", { organization: "personalspace" })],
      {
        directory: "personalspace",
        organization: "personalspace",
        repositories: [],
      },
    ),
  };
  const group = appsScope(withPersonal, { view: "home" }, cs);
  if (group === null) throw new Error("The fixture has an Organization");
  const [workspace, productionspace] = appsSections(
    withPersonal,
    group,
    cs,
    null,
  );
  const deals = workspace?.tiles.find((tile) => tile.key === "m:deals");
  const firmware = productionspace?.tiles[0];
  if (deals === undefined || firmware === undefined)
    throw new Error("The fixture has a module and a repository");
  const dashboard = (slug: string) =>
    slug === "example" ? "https://dashboard.lazurio.ai/orgs/example" : null;
  expect(workspaceTabsTarget(deals, group, dashboard, true)).toBe(
    "https://dashboard.lazurio.ai/orgs/example/settings?tab=modules&module=deals&focus=workspace-tabs",
  );
  expect(workspaceTabsTarget(null, group, dashboard, true)).toBe(
    "https://dashboard.lazurio.ai/orgs/example/settings?tab=modules&focus=workspace-tabs",
  );
  // Anyone but the Owner, a repository, an Organization without its
  // Dashboard page: nothing.
  expect(workspaceTabsTarget(deals, group, dashboard, false)).toBeNull();
  expect(workspaceTabsTarget(firmware, group, dashboard, true)).toBeNull();
  expect(workspaceTabsTarget(deals, group, () => null, true)).toBeNull();
  const personal = appsScopes(withPersonal, cs).find(
    (scope) => scope.sections === null,
  );
  if (personal === undefined) throw new Error("The fixture has one");
  const [personalWorkspace] = appsSections(withPersonal, personal, cs, null);
  expect(personalWorkspace?.tabs).toBeNull();
  const diary = personalWorkspace?.tiles[0];
  if (diary === undefined) throw new Error("The fixture has a diary");
  expect(workspaceTabsTarget(diary, personal, dashboard, true)).toBeNull();
});

test("the Czech words are the decided ones", () => {
  expect(cs.appsMoveToTab).toBe("Přesunout do karty");
  expect(cs.appsTabsEdit).toBe("Upravit karty");
});
