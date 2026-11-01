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
import { appsSectionHead, appsSections } from "../src/launchpad/apps-view";
import {
  catalogGroupEntry,
  parseCatalog,
  withGuestAccess,
} from "../src/launchpad/catalog-view";
import { messages } from "../src/launchpad/messages";
import type {
  Catalog,
  CatalogGuestModule,
  CatalogModule,
  CatalogOrganization,
} from "../src/organizations/catalog";
import { readFolderCatalog } from "../src/organizations/catalog";
import { writeModule, writeOrganization } from "./fixtures/catalog-folder";
import {
  guestKnowledgebase,
  guestMissionControl,
} from "./fixtures/guest-modules";

// Decision F67's addendum of 2026-11-01 (DEV-6694 M7): Apps draws the guest
// Modules an Organization declares, one section per home Organization
// after its own, titled with the home's GitHub login and a quiet "hostující"
// badge. A guest is drawn like a module, read-only: never opened or
// started, its menu leads to GitHub, and one this Environment cannot read
// (never cloned here) is not shown at all. Synthetic names only.

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
              tile.favorite,
            ]
          : null,
      ),
    ).toEqual([
      [
        "knowledgebase",
        copy.appsDescriptionBook,
        "book",
        "https://github.com/HomeOrg/knowledgebase",
        false,
      ],
      [
        "mission-control",
        copy.appsDescriptionControl,
        "control",
        "https://github.com/HomeOrg/mission-control",
        false,
      ],
    ]);
    // A click never opens or starts anything: it says where the app lives.
    for (const tile of section.tiles) {
      expect(tile.action.kind).toBe("say");
      if (tile.action.kind === "say") {
        expect(tile.action.text).toContain("HomeOrg");
        expect(tile.action.text).not.toContain("{");
      }
    }
  }
  expect(cs.appsGuestBadge).toBe("hostující");
});

test("the page keeps a valid guest list and refuses a forged one", () => {
  const valid = catalogOf(host([guest("knowledgebase", "HomeOrg")]));
  expect(parseCatalog(JSON.parse(JSON.stringify(valid)))).not.toBeNull();
  for (const forged of [
    { ...guest("knowledgebase", "HomeOrg"), url: "https://example.com/x" },
    { ...guest("knowledgebase", "HomeOrg"), guest: false },
    { ...guest("knowledgebase", "HomeOrg"), homeOrganization: "-bad-" },
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
