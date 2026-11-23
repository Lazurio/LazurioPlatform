import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readSyncRecord,
  recordSync,
  type SyncEntry,
} from "../src/content/sync-record";
import { initializeFolder } from "../src/folder/initialize-folder";
import { executionOs } from "../src/folder/platform";
import {
  appsSectionHead,
  appsSections,
  guestName,
  slugStone,
} from "../src/launchpad/apps-view";
import {
  catalogGroupEntry,
  catalogSelection,
  guestFacts,
  parseCatalog,
  withGuestAccess,
} from "../src/launchpad/catalog-view";
import { messages } from "../src/launchpad/messages";
import {
  newTabCopy,
  type UpdateJob,
  updateView,
} from "../src/launchpad/new-tab-view";
import { pageRoute, routePath, routeTitle } from "../src/launchpad/routes";
import type {
  Catalog,
  CatalogGuestModule,
  CatalogModule,
  CatalogOrganization,
} from "../src/organizations/catalog";
import { readFolderCatalog } from "../src/organizations/catalog";
import { runCatalogCommand } from "../src/organizations/cli";
import type { CliContext } from "../src/update/cli";
import { writeModule, writeOrganization } from "./fixtures/catalog-folder";
import {
  guestKnowledgebase,
  guestMissionControl,
} from "./fixtures/guest-modules";

// Decision F67's addendum of 2026-11-01 (DEV-6694 M7): Apps draws the guest
// Modules an Organization declares, one section per home Organization
// after its own, titled with the home's GitHub login and a quiet "nasdílený"
// badge. A guest is drawn like a module, read-only: never opened or
// started, its menu leads to GitHub, and one this Environment cannot read
// (never cloned here) is not shown at all. Synthetic names only.

const cli: CliContext = {
  identity: { version: "1.0.0", commit: "0".repeat(40), target: "fixture" },
  platform: process.platform,
  env: {},
  executable: "/nonexistent/lazurio",
};
const cs = messages("cs");
const en = messages("en");

const own: CatalogModule = {
  organization: "hostorg",
  module: "web",
  path: "workspace/web",
  teams: ["workspace"],
  teamsSource: "default",
  apps: [{ package: "app/package.json", kind: "runtime-declared" }],
  defaultApp: "app/package.json",
  state: "current",
  executable: true,
};
const guest = (
  module: string,
  home: string,
  checkedOut = true,
): CatalogGuestModule => ({
  organization: "hostorg",
  module,
  path: `workspace/${home}_GEN3/${module}`,
  homeOrganization: home,
  guest: true,
  checkedOut,
  url: `https://github.com/${home}/${module}`,
});
const host = (
  guests: readonly CatalogGuestModule[] | undefined,
): CatalogOrganization => ({
  directory: "HostOrg_GEN3",
  organization: "hostorg",
  displayName: "Host",
  state: "current",
  issues: [],
  executable: true,
  teams: [],
  modules: [own],
  repositories: [
    {
      slug: "firmware",
      path: "productionspace/firmware",
      checkedOut: true,
      url: null,
    },
  ],
  ...(guests === undefined ? {} : { guests }),
});
const catalogOf = (organization: CatalogOrganization): Catalog => ({
  kind: "catalog",
  organizations: [organization],
});

test("guest sections follow the host's own, one per home, only what is cloned here", () => {
  const organization = host([
    guest("knowledgebase", "HomeOrg"),
    guest("mission-control", "HomeOrg", false),
    guest("notes", "OtherHome"),
    guest("plans", "homeorg"),
  ]);
  const group = catalogGroupEntry(catalogOf(organization), organization, cs);
  expect(
    group.sections?.map((section) => [
      section.kind,
      section.title,
      section.kind === "guest" ? section.guests.map((item) => item.module) : [],
    ]),
  ).toEqual([
    ["workspace", cs.catalogSectionWorkspace, []],
    ["productionspace", cs.catalogSectionProductionspace, []],
    // The home's login as the slot declares it first; letter case ignored.
    ["guest", "HomeOrg", ["knowledgebase", "plans"]],
    ["guest", "OtherHome", ["notes"]],
  ]);
  // Guests are never modules of the host.
  expect(group.modules.map((entry) => entry.module.module)).toEqual(["web"]);
});

test("a guest nobody here can read makes no section, and an Organization without guests has none", () => {
  for (const guests of [
    undefined,
    [guest("mission-control", "HomeOrg", false)],
  ]) {
    const organization = host(guests);
    const group = catalogGroupEntry(catalogOf(organization), organization, cs);
    expect(group.sections?.map((section) => section.kind)).toEqual([
      "workspace",
      "productionspace",
    ]);
  }
});

test("Apps draws a guest like a module, read-only, with its home on the flag and a badge", () => {
  const organization = host([
    guest("knowledgebase", "HomeOrg"),
    guest("mission-control", "HomeOrg"),
  ]);
  const value = catalogOf(organization);
  for (const copy of [cs, en]) {
    const group = catalogGroupEntry(value, organization, copy);
    const section = appsSections(value, group, copy, null, [
      "g:homeorg/knowledgebase",
    ]).find((item) => item.kind === "guest");
    if (section === undefined) throw new Error("no guest section");
    expect(appsSectionHead(section, "/edit")).toEqual({
      flag: "HomeOrg",
      badge: { text: copy.appsGuestBadge, hint: copy.appsGuestHint },
      end: { kind: "count", count: section.count },
    });
    expect(section.tabs).toBeNull();
    expect(
      section.tiles.map((tile) =>
        tile.kind === "guest"
          ? [
              tile.name,
              tile.description,
              tile.stone.key,
              tile.info,
              tile.guest.url,
              tile.favorite,
            ]
          : null,
      ),
    ).toEqual([
      [
        "knowledgebase",
        copy.appsDescriptionKnowledge,
        "knowledge",
        "/o/hostorg/guest/HomeOrg/knowledgebase",
        "https://github.com/HomeOrg/knowledgebase",
        false,
      ],
      [
        "mission-control",
        copy.appsDescriptionControl,
        "control",
        "/o/hostorg/guest/HomeOrg/mission-control",
        "https://github.com/HomeOrg/mission-control",
        false,
      ],
    ]);
    // A click opens its read-only overview, never an app.
    for (const tile of section.tiles)
      expect(tile.action).toEqual({ kind: "route", href: tile.info ?? "" });
  }
  expect(cs.appsGuestBadge).toBe("nasdílený");
  expect(en.appsGuestBadge).toBe("shared");
});

test("a shared Module whose declaration was read is named and drawn by its default app, as an own module is (F67, addendum of 2026-11-22)", () => {
  const named: CatalogGuestModule = {
    ...guest("plans", "HomeOrg"),
    display: {
      id: "homeorg-plans-v3",
      title: "Mission Control v3",
      icon: "control",
      tags: ["planning"],
    },
  };
  const organization = host([named, guest("knowledgebase", "HomeOrg")]);
  const value = catalogOf(organization);
  // The page keeps its name and icon through its reader.
  const parsed = parseCatalog(JSON.parse(JSON.stringify(value)));
  expect(parsed?.organizations[0]?.guests?.[0]?.display).toEqual(named.display);
  for (const copy of [cs, en]) {
    const group = catalogGroupEntry(value, organization, copy);
    const section = appsSections(value, group, copy, null, []).find(
      (item) => item.kind === "guest",
    );
    if (section === undefined) throw new Error("no guest section");
    // Under its home's heading; the tile its name without the version, its
    // stone by its icon; the other still by its slot's id.
    expect(appsSectionHead(section, "/edit").flag).toBe("HomeOrg");
    expect(
      section.tiles.map((tile) =>
        tile.kind === "guest"
          ? [tile.name, tile.stone.key, tile.description, tile.info]
          : null,
      ),
    ).toEqual([
      [
        "Mission Control",
        "control",
        copy.appsDescriptionControl,
        "/o/hostorg/guest/HomeOrg/plans",
      ],
      [
        "knowledgebase",
        "knowledge",
        copy.appsDescriptionKnowledge,
        "/o/hostorg/guest/HomeOrg/knowledgebase",
      ],
    ]);
    // Still never an app: its overview, read-only.
    for (const tile of section.tiles)
      expect(tile.action).toEqual({ kind: "route", href: tile.info ?? "" });
  }
});

test("the page keeps a valid guest list and refuses a forged one", () => {
  const valid = catalogOf(host([guest("knowledgebase", "HomeOrg")]));
  expect(parseCatalog(JSON.parse(JSON.stringify(valid)))).not.toBeNull();
  for (const forged of [
    { ...guest("knowledgebase", "HomeOrg"), url: "https://example.com/x" },
    { ...guest("knowledgebase", "HomeOrg"), guest: false },
    { ...guest("knowledgebase", "HomeOrg"), homeOrganization: "-bad-" },
    // A shared Module carries its name and icon, never its app's own line.
    {
      ...guest("knowledgebase", "HomeOrg"),
      display: { id: "kb", title: "Knowledgebase", description: "x", tags: [] },
    },
    {
      ...guest("knowledgebase", "HomeOrg"),
      display: { id: "kb", title: "", tags: [] },
    },
  ])
    expect(
      parseCatalog(
        JSON.parse(
          JSON.stringify(
            catalogOf(host([forged as unknown as CatalogGuestModule])),
          ),
        ),
      ),
    ).toBeNull();
});

test("a guest whose access was lost stays checked out but leaves Apps, and comes back once GitHub reads it again", async () => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "guest-apps-")));
  const folder = join(parent, "Lazurio");
  const locks = join(parent, "locks");
  await mkdir(locks);
  try {
    await initializeFolder(folder, {
      os: executionOs(process.platform),
      access: "local",
      purpose: "human",
      locale: "cs",
      detail: "concise",
      coordination: "direct",
    });
    const root = await writeOrganization(folder, "HostOrg_GEN3", {
      slug: "hostorg",
      forge: "HostOrg",
      state: "current",
      modules: [{ id: "web" }],
      slots: [guestKnowledgebase, guestMissionControl],
    });
    for (const id of ["knowledgebase", "mission-control"]) {
      const path = join(root, "workspace/HomeOrg_GEN3", id);
      await writeModule(path, "homeorg", { id, apps: false });
      await mkdir(join(path, ".git"));
    }
    const at = new Date().toISOString();
    const entry = (path: string, result: SyncEntry["result"]): SyncEntry => ({
      organization: "HostOrg",
      root: "organizations/HostOrg_GEN3",
      path,
      kind: path === "." ? "root" : "module",
      branch: "main",
      result,
      ...(result === "denied" ? { reason: "repository-denied" } : {}),
      at,
    });
    const shown = async () => {
      const catalog = withGuestAccess(
        await readFolderCatalog(folder),
        await readSyncRecord(locks, folder),
      );
      const organization = catalog.organizations[0];
      if (organization === undefined) throw new Error("no Organization");
      // Both stay checked out: nothing is removed.
      expect(organization.guests?.map((guest) => guest.checkedOut)).toEqual([
        true,
        true,
      ]);
      return (
        catalogGroupEntry(catalog, organization, cs).sections?.flatMap(
          (section) =>
            section.kind === "guest"
              ? section.guests.map((guest) => guest.module)
              : [],
        ) ?? []
      );
    };
    // No record yet: both shown.
    expect(await shown()).toEqual(["knowledgebase", "mission-control"]);
    // GitHub refused Mission Control at the last synchronization.
    await recordSync(
      locks,
      folder,
      [
        entry(".", "current"),
        entry("workspace/HomeOrg_GEN3/knowledgebase", "current"),
        entry("workspace/HomeOrg_GEN3/mission-control", "denied"),
      ],
      { replace: "all" },
      at,
    );
    expect(await shown()).toEqual(["knowledgebase"]);
    // Access back: the next synchronization reads it and it shows again.
    await recordSync(
      locks,
      folder,
      [entry("workspace/HomeOrg_GEN3/mission-control", "current")],
      { replace: "answered" },
      at,
    );
    expect(await shown()).toEqual(["knowledgebase", "mission-control"]);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("a shared Module cloned before and now refused by GitHub loses its name everywhere: the catalog, Apps, the update view and module list name it by its slot's id until GitHub reads it again (the review of #1187)", async () => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "guest-named-")));
  const folder = join(parent, "Lazurio");
  const locks = join(parent, "locks");
  await mkdir(locks);
  try {
    await initializeFolder(folder, {
      os: executionOs(process.platform),
      access: "local",
      purpose: "human",
      locale: "cs",
      detail: "concise",
      coordination: "direct",
    });
    const root = await writeOrganization(folder, "HostOrg_GEN3", {
      slug: "hostorg",
      forge: "HostOrg",
      state: "current",
      modules: [{ id: "web" }],
      slots: [guestMissionControl],
    });
    const path = join(root, "workspace/HomeOrg_GEN3/mission-control");
    await writeModule(path, "HomeOrg", {
      id: "mission-control",
      runtime: { title: "Mission Control v3", icon: "control" },
    });
    await mkdir(join(path, ".git"));
    const at = new Date().toISOString();
    const entry = (result: SyncEntry["result"]): SyncEntry => ({
      organization: "HostOrg",
      root: "organizations/HostOrg_GEN3",
      path: "workspace/HomeOrg_GEN3/mission-control",
      kind: "module",
      branch: "main",
      result,
      ...(result === "denied" ? { reason: "repository-denied" } : {}),
      at,
    });
    const seen = async () => {
      const record = await readSyncRecord(locks, folder);
      const catalog = withGuestAccess(await readFolderCatalog(folder), record);
      const guest = catalog.organizations[0]?.guests?.[0];
      if (guest === undefined) throw new Error("no guest");
      // The update view's row for it, from a run's line of it.
      const job = {
        id: "job",
        running: false,
        lines: [
          {
            part: "content",
            organization: "HostOrg",
            root: "organizations/HostOrg_GEN3",
            path: "workspace/HomeOrg_GEN3/mission-control",
            kind: "module",
            home: "HomeOrg",
            module: "mission-control",
            result: "current",
          },
        ],
      } as unknown as UpdateJob;
      const [row] = updateView(job, catalog, newTabCopy("cs")).rows;
      const listed = await runCatalogCommand(
        ["module", "list", "hostorg", "--folder", folder],
        cli,
        (at: string) => readFolderCatalog(at),
        async () => record,
      );
      return {
        revoked: guest.revoked === true,
        display: guest.display?.title ?? null,
        name: guestName(guest),
        row: row?.name,
        stone: row?.stone,
        listed: /Mission Control, shared/.test(listed.text),
      };
    };
    // Cloned and readable: its name everywhere.
    expect(await seen()).toEqual({
      revoked: false,
      display: "Mission Control v3",
      name: "Mission Control",
      row: "HomeOrg / Mission Control",
      stone: slugStone("mission-control").src,
      listed: true,
    });
    // GitHub refused it at the last synchronization; the checkout stays.
    await recordSync(locks, folder, [entry("denied")], { replace: "all" }, at);
    expect(await seen()).toEqual({
      revoked: true,
      display: null,
      name: "mission-control",
      row: "HomeOrg / mission-control",
      stone: slugStone("mission-control").src,
      listed: false,
    });
    // Access back: the next synchronization reads it, and the name returns.
    await recordSync(
      locks,
      folder,
      [entry("current")],
      { replace: "answered" },
      at,
    );
    expect((await seen()).row).toBe("HomeOrg / Mission Control");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("a guest's overview has its own address and says its state and what the person can do", () => {
  for (const path of [
    "/o/hostorg/guest/HomeOrg/knowledgebase",
    "/o/hostorg/guest/HomeOrg/knowledgebase/",
  ])
    expect(pageRoute(path)).toEqual({
      view: "guest",
      organization: "hostorg",
      home: "HomeOrg",
      module: "knowledgebase",
    });
  expect(
    routePath({
      view: "guest",
      organization: "hostorg",
      home: "HomeOrg",
      module: "knowledgebase",
    }),
  ).toBe("/o/hostorg/guest/HomeOrg/knowledgebase");
  // A module named "guest" keeps its own page.
  expect(pageRoute("/o/hostorg/guest")).toEqual({
    view: "module",
    organization: "hostorg",
    module: "guest",
  });
  const organization = host([
    guest("knowledgebase", "HomeOrg"),
    guest("mission-control", "HomeOrg", false),
    { ...guest("notes", "HomeOrg"), revoked: true },
  ]);
  const value = catalogOf(organization);
  const select = (home: string, module: string) =>
    catalogSelection(value, {
      view: "guest",
      organization: "hostorg",
      home,
      module,
    });
  // Letter case of the home ignored; an undeclared one is missing.
  expect(select("homeorg", "knowledgebase")).toMatchObject({
    kind: "guest",
    guest: { module: "knowledgebase" },
  });
  expect(select("HomeOrg", "nothing")).toEqual({ kind: "missing" });
  expect(select("OtherOrg", "knowledgebase")).toEqual({ kind: "missing" });
  const state = (module: string) =>
    guestFacts(
      (organization.guests ?? []).find((item) => item.module === module) ??
        guest(module, "HomeOrg"),
      cs,
    )[0]?.[1];
  expect(state("knowledgebase")).toBe(cs.appsGuestCloned);
  expect(state("mission-control")).toBe(
    cs.appsGuestAbsent.replace("{home}", "HomeOrg"),
  );
  expect(state("notes")).toBe(cs.appsGuestRevoked.replace("{home}", "HomeOrg"));
  for (const [, line] of guestFacts(guest("x", "HomeOrg"), en))
    expect(String(line)).not.toContain("{");
  expect(
    routeTitle(
      { view: "guest", organization: "hostorg", home: "HomeOrg", module: "kb" },
      cs,
    ).heading,
  ).toBe("kb");
});
