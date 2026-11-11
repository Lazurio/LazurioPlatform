import { expect, test } from "bun:test";
import {
  type AppsHomePart,
  appsHomeParts,
  appsScope,
  appsScopes,
  appsSections,
  availabilityPageTemplate,
  availabilityUrl,
  groupDashboardSlug,
  guestTile,
  type ShareHere,
  sharedApplicationsSection,
  shareTarget,
  tileShareTarget,
  tileTarget,
} from "../src/launchpad/apps-view";
import type { CatalogGroupEntry } from "../src/launchpad/catalog-view";
import type { PublicEntry } from "../src/launchpad/chat";
import { messages } from "../src/launchpad/messages";
import type {
  Catalog,
  CatalogModule,
  CatalogOrganization,
} from "../src/organizations/catalog";
import type { AccountSharedApplication } from "../src/shell/contract";

// Decision 0231 and plan LZD-0009 M6 in Apps: the Organization's "Sdílené
// aplikace" (what colleagues made available from their Work Environments,
// shown as applications, never as Modules) and the Assigned User's
// "Zpřístupnit kolegům" beside an application of this Work Environment,
// which leads to the Dashboard's availability page and back. The roles have
// their names of decision 0234 in each language. Example names only.

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
  displayName: "Example Works",
  state: "current",
  issues: [],
  executable: true,
  teams: [],
  modules,
  repositories: [],
  ...extra,
});
const example = organization(
  "Example",
  [
    module("deals"),
    module("website", { executable: false, reason: "default-app-invalid" }),
    module("notes", {
      apps: [],
      defaultApp: null,
      executable: false,
      reason: "no-app",
    }),
    module("archive", {
      executable: false,
      preparationRefused: true,
      reason: "default-app-invalid",
    }),
  ],
  {
    forgeLogin: "example",
    repositories: [
      {
        slug: "firmware",
        path: "productionspace/firmware",
        checkedOut: false,
        url: null,
      },
    ],
    guests: [
      {
        organization: "Example",
        module: "handbook",
        path: "workspace/HomeOrg_GEN3/handbook",
        homeOrganization: "HomeOrg",
        guest: true,
        checkedOut: true,
        url: "https://github.com/HomeOrg/handbook",
      },
    ],
  },
);
const catalog: Catalog = {
  kind: "catalog",
  organizations: [example],
  personalspace: organization("personalspace", [module("diary")], {
    directory: "personalspace",
    displayName: "Personalspace",
    state: null,
  }),
};
const entry: PublicEntry = {
  launchpadOrigin: "https://launchpad.vm-03.example.lazurio.io",
  t3codeOrigin: "https://t3code.vm-03.example.lazurio.io",
  moduleOriginTemplate: "https://{module}.vm-03.example.lazurio.io",
};
const orgGroup = (): CatalogGroupEntry => {
  const group = appsScope(catalog, { view: "home" }, cs);
  if (group === null || group.sections === null)
    throw new Error("The fixture has an Organization");
  return group;
};
const personalGroup = (): CatalogGroupEntry => {
  const group = appsScopes(catalog, cs).find((item) => item.sections === null);
  if (group === undefined) throw new Error("The fixture has a personal space");
  return group;
};
// The shell document's Organization page, as the Dashboard addresses it.
const dashboard = (slug: string) =>
  slug.toLowerCase() === "example"
    ? "https://dashboard.lazurio.ai/orgs/example"
    : null;

// What the account lists for Ada: Bob's inspections application and Cyril's
// planner of the example Organization, one of another Organization, and
// one on this very Environment (vm-03.example), whose Module is a tile here.
const shared = (
  role: "admin" | "user",
  module: string,
  environment: string,
  host: AccountSharedApplication["host"],
  organization = "example",
): AccountSharedApplication => ({
  organization,
  module,
  name: module.charAt(0).toUpperCase() + module.slice(1),
  url: `https://${module}.${environment}.lazurio.io`,
  role,
  host,
});
const account: readonly AccountSharedApplication[] = [
  shared("user", "inspections", "vm-02.example", {
    login: "bob",
    name: "Bob Example",
  }),
  shared("admin", "planner", "vm-04.example", { login: "cyril" }),
  shared(
    "user",
    "ledger",
    "vm-07.other-example",
    { login: "dana" },
    "other-example",
  ),
  shared("admin", "deals", "vm-03.example", { login: "ada" }),
  shared("user", "inspections", "vm-02.example", { login: "bob" }),
];
const input = { dashboard, current: "vm-03.example" };

test("Sdílené aplikace: the Organization's own, in the account's order, each once, as applications with who shares them and the role by its Czech name", () => {
  expect(sharedApplicationsSection(orgGroup(), account, cs, input)).toEqual({
    title: "Sdílené aplikace",
    count: "2 aplikace",
    tiles: [
      {
        key: "https://inspections.vm-02.example.lazurio.io",
        name: "Inspections",
        href: "https://inspections.vm-02.example.lazurio.io/",
        host: "Sdílí Bob Example",
        role: "Uživatel aplikace",
        roleKey: "user",
        stone: expect.objectContaining({ src: expect.any(String) }),
      },
      {
        key: "https://planner.vm-04.example.lazurio.io",
        name: "Planner",
        href: "https://planner.vm-04.example.lazurio.io/",
        host: "Sdílí cyril",
        role: "Admin aplikace",
        roleKey: "admin",
        stone: expect.objectContaining({ src: expect.any(String) }),
      },
    ],
  });
});

test("Shared applications in English: only the English names of the roles", () => {
  const section = sharedApplicationsSection(orgGroup(), account, en, input);
  expect(section?.title).toBe("Shared applications");
  expect(section?.count).toBe("2 applications");
  expect(
    section?.tiles.map((tile) => [tile.name, tile.host, tile.role]),
  ).toEqual([
    ["Inspections", "Shared by Bob Example", "Application User"],
    ["Planner", "Shared by cyril", "Application Admin"],
  ]);
  const one = sharedApplicationsSection(
    orgGroup(),
    account.slice(0, 1),
    en,
    input,
  );
  expect(one?.count).toBe("1 application");
  expect(
    sharedApplicationsSection(orgGroup(), account.slice(0, 1), cs, input)
      ?.count,
  ).toBe("1 aplikace");
  // Czech has its third form from five on.
  const five = Array.from({ length: 5 }, (_, index) =>
    shared("user", `tool-${index}`, "vm-02.example", { login: "bob" }),
  );
  expect(sharedApplicationsSection(orgGroup(), five, cs, input)?.count).toBe(
    "5 aplikací",
  );
  // Without a login or name, nobody is named.
  const nameless = [
    shared("user", "inspections", "vm-02.example", { login: null }),
  ];
  expect(
    sharedApplicationsSection(orgGroup(), nameless, cs, input)?.tiles[0]?.host,
  ).toBe("Sdílí ji někdo z Organizace");
  expect(
    sharedApplicationsSection(orgGroup(), nameless, en, input)?.tiles[0]?.host,
  ).toBe("Shared by someone in the Organization");
  // A name is display text, never a replacement pattern.
  const odd = [
    shared("user", "inspections", "vm-02.example", {
      login: "bob",
      name: "Bob $& Example",
    }),
  ];
  expect(
    sharedApplicationsSection(orgGroup(), odd, en, input)?.tiles[0]?.host,
  ).toBe("Shared by Bob $& Example");
});

test("a shared application is never a Module: no menu, favourite, overview, source, Chat or Environment entry to offer", () => {
  const section = sharedApplicationsSection(orgGroup(), account, cs, input);
  for (const tile of section?.tiles ?? []) {
    expect(Object.keys(tile).sort()).toEqual(
      ["host", "href", "key", "name", "role", "roleKey", "stone"].sort(),
    );
    // One click opens its origin, never this Environment's.
    expect(new URL(tile.href).pathname).toBe("/");
    expect(tile.href.includes("vm-03.example")).toBe(false);
  }
  // The Organization's Modules stay what they were.
  expect(
    appsSections(catalog, orgGroup(), cs, entry).flatMap((part) =>
      part.tiles.map((tile) => tile.name),
    ),
  ).not.toContain("Inspections");
});

test("unknown, invalid or empty says nothing: no section, never a claim that nothing is shared", () => {
  expect(sharedApplicationsSection(orgGroup(), null, cs, input)).toBeNull();
  expect(sharedApplicationsSection(orgGroup(), [], cs, input)).toBeNull();
  // Only another Organization's, or only this Environment's own.
  expect(
    sharedApplicationsSection(orgGroup(), account.slice(2, 4), cs, input),
  ).toBeNull();
  // The personal space has no shared applications.
  expect(
    sharedApplicationsSection(personalGroup(), account, cs, input),
  ).toBeNull();
  const quiet = appsHomeParts(catalog, orgGroup(), cs, {
    entry,
    favorites: [],
    setup: false,
    tabs: [],
    shared: null,
  });
  expect(quiet.some((part) => part.kind === "shared")).toBe(false);
  expect(JSON.stringify(quiet).includes(cs.appsSharedTitle)).toBe(false);
});

test("the Organization's Dashboard slug is its page's, even where the Dashboard disambiguated it; without a page, the derived one", () => {
  expect(groupDashboardSlug(orgGroup(), dashboard)).toBe("example");
  const suffixed = (slug: string) =>
    slug === "Example" ? "https://dashboard.lazurio.ai/orgs/example-2" : null;
  expect(groupDashboardSlug(orgGroup(), suffixed)).toBe("example-2");
  expect(groupDashboardSlug(orgGroup(), () => null)).toBe("example");
  expect(groupDashboardSlug(personalGroup(), dashboard)).toBeNull();
  // The account names the disambiguated slug: only its entries show.
  const second = [
    shared(
      "user",
      "inspections",
      "vm-02.example-2",
      { login: "bob" },
      "example-2",
    ),
  ];
  expect(
    sharedApplicationsSection(orgGroup(), second, cs, {
      dashboard: suffixed,
      current: null,
    })?.tiles.map((tile) => tile.name),
  ).toEqual(["Inspections"]);
  expect(sharedApplicationsSection(orgGroup(), second, cs, input)).toBeNull();
});

const homeView = (parts: readonly AppsHomePart[]) =>
  parts.map((part) =>
    part.kind === "section" || part.kind === "shared"
      ? [part.kind, part.section.title]
      : [part.kind],
  );

test("the home places them right after the Workspace; first where the Organization shows none", () => {
  const section = sharedApplicationsSection(orgGroup(), account, cs, input);
  expect(
    homeView(
      appsHomeParts(catalog, orgGroup(), cs, {
        entry,
        favorites: [],
        setup: false,
        tabs: [],
        shared: section,
      }),
    ),
  ).toEqual([
    ["section", "Workspace"],
    ["shared", "Sdílené aplikace"],
    ["section", "Productionspace"],
    ["section", expect.any(String)],
  ]);
  // A colleague without a Module here: the plain sentence, then the
  // applications shared with them.
  const empty: Catalog = {
    kind: "catalog",
    organizations: [organization("Example", [], { forgeLogin: "example" })],
  };
  const group = appsScope(empty, { view: "home" }, cs);
  if (group === null) throw new Error("The fixture has an Organization");
  expect(
    homeView(
      appsHomeParts(empty, group, cs, {
        entry,
        favorites: [],
        setup: false,
        tabs: [],
        shared: sharedApplicationsSection(group, account, cs, input),
      }),
    ),
  ).toEqual([["empty"], ["shared", "Sdílené aplikace"]]);
});

// --- Zpřístupnit kolegům ------------------------------------------------

// Ada's Work Environment of the example Organization, assigned to her.
const here: ShareHere = {
  id: "vm-03.example",
  kind: "work",
  assignee: "ada",
  organizations: ["Example"],
  apps: {
    apps: "https://launchpad.vm-03.example.lazurio.io/",
    chat: "https://t3code.vm-03.example.lazurio.io/",
    automate: null,
  },
};
const share = (
  extra: Partial<Parameters<typeof shareTarget>[3]> = {},
  id = "deals",
  group: CatalogGroupEntry | null = orgGroup(),
  host: PublicEntry | null = entry,
) => {
  const found = example.modules.find((item) => item.module === id);
  if (found === undefined) throw new Error(`No module ${id}`);
  return shareTarget(group, found, tileTarget(catalog, example, found, host), {
    here,
    viewer: "ada",
    dashboard,
    path: "/o/example",
    ...extra,
  });
};

test("the Assigned User of this Work Environment gets it beside an application: the Dashboard's availability page with the way back", () => {
  const href = share();
  expect(href).toBe(
    `https://dashboard.lazurio.ai/orgs/example/environments/vm-03.example/availability?module=deals&return=${encodeURIComponent("https://launchpad.vm-03.example.lazurio.io/o/example")}`,
  );
  // The way back is this Launchpad's own Apps address, without a fragment,
  // whatever origin the page was reached by.
  const back = new URL(href ?? "").searchParams.get("return");
  expect(back).toBe("https://launchpad.vm-03.example.lazurio.io/o/example");
  expect(
    new URL(share({ path: "/o/example/deals?x=1#top" }) ?? "").searchParams.get(
      "return",
    ),
  ).toBe("https://launchpad.vm-03.example.lazurio.io/o/example/deals?x=1");
  // The login is compared without case.
  expect(share({ viewer: "Ada" })).toBe(href);
});

test("only on a Work Environment, only for its Assigned User, and only when the person at the browser is known", () => {
  for (const kind of ["personal", "team", "automated", "workstation"] as const)
    expect(share({ here: { ...here, kind } })).toBeNull();
  expect(share({ here: { ...here, assignee: null } })).toBeNull();
  expect(share({ viewer: "bob" })).toBeNull();
  expect(share({ viewer: null })).toBeNull();
  expect(share({ here: null })).toBeNull();
});

test("only for an application of a Module of an Organization this Environment holds; never a Module without an app or one that cannot start", () => {
  expect(share({}, "notes")).toBeNull();
  expect(share({}, "website")).toBeNull();
  expect(share({}, "archive")).toBeNull();
  // A workstation's lifecycle start is no application of a Work
  // Environment.
  expect(share({}, "deals", orgGroup(), null)).toBeNull();
  // The personal space, a missing group, another Organization.
  expect(share({}, "deals", personalGroup())).toBeNull();
  expect(share({}, "deals", null)).toBeNull();
  expect(share({ here: { ...here, organizations: ["Other"] } })).toBeNull();
  // Without the Organization's Dashboard page there is nowhere to go.
  expect(share({ dashboard: () => null })).toBeNull();
  expect(
    share({ dashboard: () => "https://dashboard.lazurio.ai/settings" }),
  ).toBeNull();
  // A way back that would leave this Launchpad.
  expect(share({ path: "//elsewhere.example/" })).toBeNull();
  expect(share({ path: "o/example" })).toBeNull();
  expect(
    share({ here: { ...here, apps: { ...here.apps, apps: "/" } } }),
  ).toBeNull();
});

test("tiles: a Module's tile that opens its application here, never a guest Module, a repository or a Module without an app", () => {
  const group = orgGroup();
  const tiles = appsSections(catalog, group, cs, entry).flatMap(
    (section) => section.tiles,
  );
  const shareInput = { here, viewer: "ada", dashboard, path: "/" };
  expect(
    tiles
      .filter((tile) => tileShareTarget(tile, group, shareInput) !== null)
      .map((tile) => tile.name),
  ).toEqual(["deals"]);
  const [guest] = example.guests ?? [];
  if (guest === undefined) throw new Error("The fixture has a guest");
  expect(
    tileShareTarget(guestTile(catalog, example, guest, cs), group, shareInput),
  ).toBeNull();
  // The Personalspace's Modules never.
  const personal = personalGroup();
  expect(
    appsSections(catalog, personal, cs, entry)
      .flatMap((section) => section.tiles)
      .map((tile) => tileShareTarget(tile, personal, shareInput)),
  ).toEqual([null]);
});

test("the availability page's address: one template on the Organization page's origin, every value encoded in its place", () => {
  expect(availabilityPageTemplate).toBe(
    "/orgs/{organization}/environments/{environment}/availability?module={module}&return={return}",
  );
  const url = availabilityUrl(
    "https://dashboard.lazurio.ai/orgs/example",
    "vm-03.example",
    "deals&x=1",
    "https://launchpad.vm-03.example.lazurio.io/o/example?a=1&b=2",
  );
  expect(url).not.toBeNull();
  const parsed = new URL(url ?? "");
  expect(parsed.origin).toBe("https://dashboard.lazurio.ai");
  expect(parsed.pathname).toBe(
    "/orgs/example/environments/vm-03.example/availability",
  );
  expect([...parsed.searchParams]).toEqual([
    ["module", "deals&x=1"],
    ["return", "https://launchpad.vm-03.example.lazurio.io/o/example?a=1&b=2"],
  ]);
  for (const page of [
    null,
    "http://dashboard.lazurio.ai/orgs/example",
    "https://dashboard.lazurio.ai/",
    "https://dashboard.lazurio.ai/orgs/example/settings",
    "https://dashboard.lazurio.ai/orgs/example?tab=1",
    "https://dashboard.lazurio.ai/orgs/Example",
    "/orgs/example",
  ])
    expect(
      availabilityUrl(
        page,
        "vm-03.example",
        "deals",
        "https://launchpad.vm-03.example.lazurio.io/",
      ),
    ).toBeNull();
  for (const back of [
    "http://launchpad.vm-03.example.lazurio.io/",
    "/o/example",
    "https://launchpad.vm-03.example.lazurio.io/#top",
  ])
    expect(
      availabilityUrl(
        "https://dashboard.lazurio.ai/orgs/example",
        "vm-03.example",
        "deals",
        back,
      ),
    ).toBeNull();
});

test("the action's words in both languages", () => {
  expect([cs.appsShare, en.appsShare]).toEqual([
    "Zpřístupnit kolegům",
    "Share with colleagues",
  ]);
  expect(cs.appsShareHint).toContain("Přehled Organizace");
  expect(en.appsShareHint).toContain("Organization Dashboard");
  // Decision 0234: each language only its own names, never a bare Admin.
  expect([cs.appsRoleAdmin, cs.appsRoleUser]).toEqual([
    "Admin aplikace",
    "Uživatel aplikace",
  ]);
  expect([en.appsRoleAdmin, en.appsRoleUser]).toEqual([
    "Application Admin",
    "Application User",
  ]);
});
