import { expect, test } from "bun:test";
import { parseAccount } from "../src/launchpad/account";
import {
  type AppsTile,
  appsScope,
  appsSections,
  connectAgentsPath,
  favoriteTiles,
  moduleApplication,
  type TileApplications,
} from "../src/launchpad/apps-view";
import type { CatalogGroupEntry } from "../src/launchpad/catalog-view";
import type { PublicEntry } from "../src/launchpad/chat";
import { messages } from "../src/launchpad/messages";
import type {
  Catalog,
  CatalogModule,
  CatalogOrganization,
} from "../src/organizations/catalog";
import {
  type AccountApplication,
  accountApplicationsMax,
  parseShellAccount,
} from "../src/shell/contract";
import { accountDocument } from "./fixtures/account-document";

// Decision 0249 in Apps: one tile per Module. Where the account names the
// Module's Application (`applications`, additive in `lazurio.account.v1`),
// the tile opens it at the Organization's own address and this
// Environment's app from `main` is the Module's development version, in the
// tile's menu. Without the member every tile behaves as before. Example
// names only.

const cs = messages("cs");

// --- The contract ----------------------------------------------------------

const deals = {
  organization: "example",
  module: "deals",
  name: "Deals",
  url: "https://deals.example.lazurio.app",
  role: "user" as const,
};

const applicationsOf = (value: unknown) =>
  parseShellAccount(accountDocument({ applications: value }));

test("valid: each Application in its exact shape and the account's order, unknown members dropped", () => {
  const read = applicationsOf([
    { ...deals, state: "running", extra: 1 },
    {
      ...deals,
      organization: "Other-Example",
      module: "ledger",
      name: "Ledger",
      url: "https://ledger.other-example.lazurio.app",
      role: "admin",
    },
  ]);
  expect(read?.applications).toEqual([
    {
      organization: "example",
      module: "deals",
      name: "Deals",
      url: "https://deals.example.lazurio.app",
      role: "user",
    },
    {
      organization: "Other-Example",
      module: "ledger",
      name: "Ledger",
      url: "https://ledger.other-example.lazurio.app",
      role: "admin",
    },
  ]);
});

test("`mcp` is a boolean hint: kept when it is one, left out otherwise, never refusing the entry", () => {
  const read = applicationsOf([
    { ...deals, mcp: true },
    {
      ...deals,
      module: "ledger",
      url: "https://ledger.example.lazurio.app",
      mcp: "yes",
    },
  ]);
  expect(read?.applications?.[0]?.mcp).toBe(true);
  expect(read?.applications?.[1]).not.toHaveProperty("mcp");
});

test("absent or null is none known; the rest of the document is read as without it", () => {
  expect(applicationsOf(undefined)?.applications).toBeUndefined();
  expect(applicationsOf(null)?.applications).toBeUndefined();
  expect(applicationsOf(undefined)).not.toBeNull();
});

test("an entry out of shape makes the whole document invalid", () => {
  for (const bad of [
    "deals",
    [{ ...deals, organization: "unlisted" }],
    [{ ...deals, url: "http://deals.example.lazurio.app" }],
    [{ ...deals, url: "https://deals.example.lazurio.app/" }],
    [{ ...deals, role: "owner" }],
    [{ ...deals, module: " deals" }],
    [{ ...deals, name: "" }],
    [deals, { ...deals, organization: "EXAMPLE" }],
    Array.from({ length: accountApplicationsMax + 1 }, (_, index) => ({
      ...deals,
      module: `m${index}`,
      url: `https://m${index}.example.lazurio.app`,
    })),
  ])
    expect(applicationsOf(bad)).toBeNull();
});

test("Apps reads them only from a document valid as a whole, else none", () => {
  expect(
    parseAccount(accountDocument({ applications: [deals] }))?.applications,
  ).toEqual([deals]);
  expect(parseAccount(accountDocument())?.applications).toEqual([]);
  expect(
    parseAccount(accountDocument({ applications: [{ ...deals, role: 1 }] }))
      ?.applications,
  ).toEqual([]);
});

// --- The tiles -------------------------------------------------------------

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
const catalog: Catalog = {
  kind: "catalog",
  organizations: [
    organization("Example", [
      module("deals"),
      module("planner"),
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
    ]),
  ],
  personalspace: organization("personalspace", [], {
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
const group = (): CatalogGroupEntry => {
  const found = appsScope(catalog, { view: "home" }, cs);
  if (found === null || found.sections === null)
    throw new Error("The fixture has an Organization");
  return found;
};
const application = (
  module: string,
  organization = "example",
): AccountApplication => ({
  organization,
  module,
  name: module,
  url: `https://${module}.${organization}.lazurio.app`,
  role: "user",
});
const tilesWith = (applications?: TileApplications) =>
  appsSections(catalog, group(), cs, entry, [], false, applications).flatMap(
    (section) => section.tiles,
  );
const tile = (tiles: readonly AppsTile[], id: string) => {
  const found = tiles.find(
    (item) => item.kind === "module" && item.entry.module.module === id,
  );
  if (found === undefined || found.kind !== "module")
    throw new Error(`No tile ${id}`);
  return found;
};

test("a Module with an Application: the tile opens the Application, the development version is in the menu", () => {
  const tiles = tilesWith({
    slug: "example",
    list: [application("deals"), application("planner", "other-example")],
  });
  expect(tile(tiles, "deals").action).toEqual({
    kind: "open",
    target: { kind: "application", href: "https://deals.example.lazurio.app/" },
  });
  expect(tile(tiles, "deals").development).toEqual({
    kind: "hosted",
    href: "https://deals.vm-03.example.lazurio.io/",
  });
  // Another Organization's Application of a Module with the same slug is not this one's.
  expect(tile(tiles, "planner").action).toEqual({
    kind: "open",
    target: {
      kind: "hosted",
      href: "https://planner.vm-03.example.lazurio.io/",
    },
  });
  expect(tile(tiles, "planner").development).toBeNull();
});

test("without the account's Applications, or without the group's slug, every tile is as before", () => {
  const before = tilesWith();
  for (const applications of [
    undefined,
    { slug: null, list: [application("deals")] },
    { slug: "example", list: [] },
  ])
    expect(tilesWith(applications)).toEqual(before);
  expect(tile(before, "deals").development).toBeNull();
});

test("the frame's names (decision 0249): a tile without an Application opens STAGING, and beside an Application the menu's item is STAGING", () => {
  for (const locale of ["cs", "en"] as const) {
    const copy = messages(locale);
    expect(copy.appsDevelopment).toBe("STAGING");
    expect(copy.appsOpenAppNamed).toContain("STAGING");
    expect(copy.appsOpenAppNamedSame).toContain("STAGING");
    expect(copy.appsOpenApplicationNamed).not.toContain("STAGING");
  }
});

test("a Module whose app cannot start here still opens its Application, without a development version", () => {
  const tiles = tilesWith({
    slug: "example",
    list: [application("notes"), application("archive")],
  });
  // No app on this Environment, and a preparation the Launchpad refused.
  for (const id of ["notes", "archive"]) {
    expect(tile(tiles, id).action).toEqual({
      kind: "open",
      target: {
        kind: "application",
        href: `https://${id}.example.lazurio.app/`,
      },
    });
    expect(tile(tiles, id).development).toBeNull();
  }
  // Without an Application the same tiles keep saying why nothing opens.
  const before = tilesWith();
  expect(tile(before, "notes").action.kind).toBe("say");
  expect(tile(before, "archive").action.kind).toBe("say");
});

test("favourites follow the same tile", () => {
  const [favourite] = favoriteTiles(catalog, group(), cs, entry, ["m:deals"], {
    slug: "example",
    list: [application("deals")],
  });
  expect(favourite?.action).toEqual({
    kind: "open",
    target: { kind: "application", href: "https://deals.example.lazurio.app/" },
  });
});

test("the match ignores the Organization's case and needs the exact Module", () => {
  const list = [application("deals", "Example")];
  expect(moduleApplication({ slug: "example", list }, "deals")).toEqual(
    list[0] ?? null,
  );
  expect(moduleApplication({ slug: "example", list }, "deal")).toBeNull();
});

// --- "Připojit k agentům" (plan LZD-0037) ----------------------------------

test("an Application that offers MCP gets the filled-in page of Integrace in its tile's menu; one without, none", () => {
  const tiles = tilesWith({
    slug: "example",
    list: [
      { ...application("deals"), name: "Obchodní případy", mcp: true },
      application("planner"),
    ],
  });
  expect(tile(tiles, "deals").agents).toEqual({
    origin: "https://deals.example.lazurio.app",
    path: "/integrations/custom/new?name=Obchodn%C3%AD+p%C5%99%C3%ADpady&url=https%3A%2F%2Fdeals.example.lazurio.app%2Fmcp",
  });
  expect(tile(tiles, "planner").agents).toBeNull();
  expect(
    tilesWith(undefined).every(
      (item) => item.kind !== "module" || item.agents === null,
    ),
  ).toBe(true);
});

test("the path carries at most 64 characters of the name, counted as characters", () => {
  const long = "Ž".repeat(70);
  const path = connectAgentsPath({
    ...application("deals"),
    name: long,
    mcp: true,
  });
  const query = new URLSearchParams((path ?? "").split("?")[1]);
  expect(query.get("name")).toBe("Ž".repeat(64));
  expect(query.get("url")).toBe("https://deals.example.lazurio.app/mcp");
  expect(connectAgentsPath({ ...application("deals"), mcp: false })).toBeNull();
  expect(connectAgentsPath(null)).toBeNull();
});
