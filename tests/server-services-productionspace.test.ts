import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { holderDirectory } from "../src/browser/contract/node";
import {
  launchpadStrip,
  parseHolderRecords,
} from "../src/browser/contract/pure";
import { addressKey } from "../src/browser/people/sleep";
import { initializeFolder } from "../src/folder/initialize-folder";
import { executionOs } from "../src/folder/platform";
import {
  appsHeading,
  appsHomeParts,
  appsScope,
  appsSections,
  newModuleOffer,
  repositoryAction,
} from "../src/launchpad/apps-view";
import {
  emptyStrip,
  reduceStrip,
  stripEntries,
} from "../src/launchpad/browser-panel-view";
import { organizationsOnly } from "../src/launchpad/catalog-reading";
import {
  catalogSelection,
  parseCatalog,
  repositoryFacts,
  serviceFacts,
  servicePageOf,
} from "../src/launchpad/catalog-view";
import { messages } from "../src/launchpad/messages";
import { launchpadHolderOf } from "../src/launchpad/new-tab/holder";
import { createNewTabRoutes } from "../src/launchpad/new-tab-routes";
import {
  pagePaths,
  pageRoute,
  routePath,
  routeTitle,
  servicePath,
  serviceRequest,
} from "../src/launchpad/routes";
import { startLaunchpad } from "../src/launchpad/server";
import { shellOrganizations } from "../src/launchpad/shell-document";
import {
  machineContextPath,
  parseMachineContext,
} from "../src/machine/context";
import schema from "../src/machine/lazurio-machine.v1.schema.json";
import {
  type Catalog,
  type CatalogOrganization,
  type CatalogRepository,
  catalogModules,
  handoverServerServices,
  noServerServices,
  readFolderCatalog,
  serverServicesOf,
  withServiceRepositories,
} from "../src/organizations/catalog";
import {
  catalogGroups,
  selectCatalogOrganization,
  selectOwnerOrganization,
} from "../src/organizations/catalog-selection";
import { runCatalogCommand } from "../src/organizations/cli";
import {
  isServicePage,
  serviceIdPattern,
  serviceKinds,
  servicePage,
  servicePagePaths,
} from "../src/organizations/server-services";
import { writeOrganization } from "./fixtures/catalog-folder";
import organizationContext from "./fixtures/machine-context.json";
import personalContext from "./fixtures/machine-context-personal.json";
import servicesContext from "./fixtures/machine-context-services.json";
import { writeOwnedFixture as writeFile } from "./fixtures/owned-files";

// DEV-6674 S2.2 phase 1 (root decision 0209 point 6 with its addenda of
// 2026-10-19 (a), (b) and (g); Machines docs/server-services.md §2.1;
// decision F32's addendum of 2026-10-24): in the Launchpad of Služby serveru
// Productionspace lists every service of the Environment's own handover that
// names a repository, merged with the Organization's declared productionspace
// repositories and one entry per repository. A service that has a page opens
// it on this Environment's loopback in its Environment browser, through Nová
// karta's open for the Launchpad's strip, so a second click is the same tab;
// `/service/<id>` opens it too and leaves the address. The handover below is
// shaped like the public reference Organization's services-01 (its AI pool
// `members` with CLIProxyAPI's Management Center, the AI gateway `try` from
// the same repository without a page, the public entry and DNS-01 without a
// repository), with the fixture's example names.

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function temporary(prefix: string) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

const cs = messages("cs", "work");
const en = messages("en", "work");
const members = "http://127.0.0.1:18402/management.html";
const cliProxy = "https://github.com/Lazurio/CLIProxyAPI";
const exampleServices = [
  { id: "entry", kind: "public-entry" },
  { id: "dns01", kind: "dns01" },
  { id: "try", kind: "ai-gateway", repository: "Lazurio/CLIProxyAPI" },
  {
    id: "members",
    kind: "ai-pool",
    repository: "Lazurio/CLIProxyAPI",
    page_port: 18402,
  },
];
const handover = { ...servicesContext, services: exampleServices };
const served = serverServicesOf(
  parseMachineContext(Buffer.from(JSON.stringify(handover))),
);

// ---- One truth with Machines -----------------------------------------------

test("a service's kinds, id and page port are exactly the vendored handover schema's", () => {
  const item = (
    schema as unknown as {
      $defs: {
        organization_workspace_vm: {
          properties: {
            services: {
              items: {
                properties: {
                  id: { pattern: string; maxLength: number };
                  kind: { enum: string[] };
                  page_port: { minimum: number; maximum: number };
                };
              };
            };
          };
        };
      };
    }
  ).$defs.organization_workspace_vm.properties.services.items.properties;
  expect<readonly string[]>([...serviceKinds]).toEqual(item.kind.enum);
  expect(serviceIdPattern.source).toBe(item.id.pattern);
  expect(item.id.maxLength).toBe(32);
  // The page's port is the schema's range, on loopback only.
  const { minimum, maximum } = item.page_port;
  expect(isServicePage(`http://127.0.0.1:${minimum}/management.html`)).toBe(
    true,
  );
  expect(isServicePage(`http://127.0.0.1:${maximum}/`)).toBe(true);
  for (const page of [
    `http://127.0.0.1:${minimum - 1}/management.html`,
    `http://127.0.0.1:${maximum + 1}/management.html`,
    "https://127.0.0.1:18402/management.html",
    "http://localhost:18402/management.html",
    "http://127.0.0.2:18402/management.html",
    "http://127.0.0.1:18402",
    "http://127.0.0.1:18402/management.html?key=x",
    "http://127.0.0.1:18402/management.html#/login",
    "javascript:alert(1)",
    1,
  ])
    expect([page, isServicePage(page)]).toEqual([page, false]);
});

test("the AI pool's page is CLIProxyAPI's Management Center at /management.html, as Machines renders it; no other kind has a page here, whatever port it names", () => {
  // Machines `workloads/workspace-vm/service-unit.ts`: the renderer of
  // `ai-pool` returns `page: {port: <bridge port + 10000>, path:
  // "/management.html"}`; `ai-gateway`, `diagnostics`, `public-entry` and
  // `dns01` return none and `http` has no renderer yet. Its
  // `serverServicesHandover` hands over only `page_port`, so the path is
  // this table until Machines hands it over itself.
  expect(servicePagePaths).toEqual({ "ai-pool": "/management.html" });
  for (const kind of serviceKinds)
    expect([kind, servicePage({ kind, page_port: 18402 })]).toEqual([
      kind,
      kind === "ai-pool" ? members : null,
    ]);
  expect(servicePage({ kind: "ai-pool" })).toBeNull();
});

// ---- The handover's services ------------------------------------------------

test("only Služby serveru's handover gives services, those that name a repository, in its order, each with its page and its repository's GitHub page", () => {
  expect(served).toEqual({
    owner: { login: "example", key: "Example" },
    services: [
      { id: "try", kind: "ai-gateway", page: null, url: cliProxy },
      { id: "members", kind: "ai-pool", page: members, url: cliProxy },
    ],
  });
  // Any other Environment gives none, even a handover that lists services
  // under another assignment: a page's port is Služby serveru's loopback.
  const parsed = (value: unknown) =>
    parseMachineContext(Buffer.from(JSON.stringify(value)));
  for (const other of [
    organizationContext,
    personalContext,
    { ...organizationContext, services: exampleServices },
    {
      ...handover,
      owner: { ...handover.owner, assignment: { kind: "team" } },
    },
  ])
    expect(serverServicesOf(parsed(other))).toBeNull();
  // Služby serveru without a service with a repository list none.
  expect(
    serverServicesOf(
      parsed({ ...handover, services: exampleServices.slice(0, 2) }),
    )?.services,
  ).toEqual([]);
});

test("the services are read from the root-custodied handover; a workstation or a missing handover has none", async () => {
  const uid = process.getuid?.() ?? 0;
  const root = join(await temporary("server-services-handover-"), "machine");
  await mkdir(root, { mode: 0o755 });
  const source = { platform: "linux", root, custodian: uid };
  expect(await handoverServerServices(source)).toBeNull();
  const file = join(root, machineContextPath);
  await mkdir(dirname(file), { recursive: true, mode: 0o755 });
  await writeFile(file, JSON.stringify(handover), { mode: 0o644 });
  expect(await handoverServerServices(source)).toEqual(served);
  expect(
    await handoverServerServices({ ...source, platform: "darwin" }),
  ).toBeNull();
});

// ---- Listing and one entry per repository ----------------------------------

const declared = (
  slug: string,
  url: string | null,
  checkedOut = false,
): CatalogRepository => ({
  slug,
  path: `productionspace/${slug}`,
  checkedOut,
  url,
});

test("Productionspace lists the declared repositories, then the repositories only services name; a declared one that is a service's carries it, whatever the letter case, and no repository is listed twice", () => {
  if (served === null) throw new Error("Služby serveru");
  const firmware = declared("firmware", "https://github.com/example/firmware");
  // Not declared: CLIProxyAPI follows the declared ones, without a path.
  expect(withServiceRepositories([firmware], served.services)).toEqual([
    firmware,
    {
      slug: "CLIProxyAPI",
      path: null,
      checkedOut: false,
      url: cliProxy,
      services: [
        { id: "try", kind: "ai-gateway", page: null },
        { id: "members", kind: "ai-pool", page: members },
      ],
    },
  ]);
  // Declared, with another letter case: that entry carries the services.
  const own = declared(
    "cliproxyapi",
    "https://github.com/lazurio/cliproxyapi",
    true,
  );
  expect(withServiceRepositories([own, firmware], served.services)).toEqual([
    {
      ...own,
      services: [
        { id: "try", kind: "ai-gateway", page: null },
        { id: "members", kind: "ai-pool", page: members },
      ],
    },
    firmware,
  ]);
  // No services: the declared repositories as they are.
  expect(withServiceRepositories([own, firmware], [])).toEqual([own, firmware]);
});

async function servicesFolder() {
  const parent = await temporary("server-services-folder-");
  const folder = join(parent, "Lazurio");
  await initializeFolder(folder, {
    os: executionOs(process.platform),
    access: "local",
    purpose: "human",
    locale: "cs",
    detail: "concise",
    coordination: "direct",
  });
  // The services Environment's Organization, bound to the handover's owner
  // by its own slug, with one productionspace repository of its own, and a
  // second Organization the services never join.
  await writeOrganization(folder, "Example_GEN3", {
    slug: "Example",
    state: "current",
    modules: [],
    slots: [
      {
        path: "productionspace/firmware",
        slug: "firmware",
        git: { url: "git@github.com:Example/firmware.git", branch: "main" },
      },
    ],
  });
  await writeOrganization(folder, "other", {
    slug: "other",
    state: "current",
    modules: [],
    slots: [
      {
        path: "productionspace/CLIProxyAPI",
        slug: "CLIProxyAPI",
        git: { url: "https://github.com/Lazurio/CLIProxyAPI.git" },
      },
    ],
  });
  return folder;
}

const repositoriesOf = (catalog: Catalog, slug: string) =>
  catalog.organizations.find((entry) => entry.organization === slug)
    ?.repositories;

test("the catalog lists Služby serveru's services in its owning Organization only; without them every catalog is as it was", async () => {
  const folder = await servicesFolder();
  const before = await readFolderCatalog(folder);
  const after = await readFolderCatalog(folder, undefined, async () => served);
  expect(repositoriesOf(after, "Example")).toEqual([
    {
      slug: "firmware",
      path: "productionspace/firmware",
      checkedOut: false,
      url: "https://github.com/Example/firmware",
    },
    {
      slug: "CLIProxyAPI",
      path: null,
      checkedOut: false,
      url: cliProxy,
      services: [
        { id: "try", kind: "ai-gateway", page: null },
        { id: "members", kind: "ai-pool", page: members },
      ],
    },
  ]);
  // Another Organization of the Folder, even one that declares the same
  // repository, is not the Environment's owner: unchanged.
  expect(repositoriesOf(after, "other")).toEqual(
    repositoriesOf(before, "other"),
  );
  expect(JSON.stringify(repositoriesOf(after, "other"))).not.toContain(
    "services",
  );
  // A non-services Environment, or no readable handover: the same catalog
  // as before, also where reading the services fails.
  for (const services of [
    async () => null,
    async () => {
      throw new Error("unreadable");
    },
  ])
    expect(await readFolderCatalog(folder, undefined, services)).toEqual(
      before,
    );
  // An owner the Folder does not hold: its Organizations stay as they were,
  // and the services are a group of their own beside them.
  const elsewhere = await readFolderCatalog(folder, undefined, async () =>
    served === null
      ? null
      : { ...served, owner: { login: "elsewhere", key: null } },
  );
  expect(elsewhere.organizations).toEqual(before.organizations);
  expect(elsewhere.serverServices?.organization).toBe("elsewhere");
  // The page's parser admits both answers.
  expect(parseCatalog(JSON.parse(JSON.stringify(after)))).toEqual(after);
  expect(parseCatalog(JSON.parse(JSON.stringify(elsewhere)))).toEqual(
    elsewhere,
  );
});

test("the owner is the one Organization settings and Composio name (`selectOwnerOrganization`): two candidates bound to the owner's login take no service and make no group, since which one owns this Machine is never guessed", async () => {
  const parent = await temporary("server-services-ambiguous-");
  const folder = join(parent, "Lazurio");
  await initializeFolder(folder, {
    os: executionOs(process.platform),
    access: "local",
    purpose: "human",
    locale: "cs",
    detail: "concise",
    coordination: "direct",
  });
  for (const slug of ["first", "second"])
    await writeOrganization(folder, slug, {
      slug,
      state: "current",
      modules: [],
      forge: "example",
    });
  const before = await readFolderCatalog(folder);
  const after = await readFolderCatalog(folder, undefined, async () => served);
  expect(selectOwnerOrganization(after, "example").kind).toBe("ambiguous");
  expect(after).toEqual(before);
  expect(after.serverServices).toBeUndefined();
});

// ---- Služby serveru whose Organization is not installed ----------------------

// The reference Organization's services-01 as Matěj found it on 2026-10-24:
// its Folder holds no Organization (the Organization install has not run
// there), and its Apps said only "There are no apps in this Work
// Environment yet". The handover still says what runs there.
async function emptyServicesFolder(withOrganizations = true) {
  const parent = await temporary("server-services-empty-");
  const folder = join(parent, "Lazurio");
  await initializeFolder(folder, {
    os: executionOs(process.platform),
    access: "local",
    purpose: "human",
    locale: "cs",
    detail: "concise",
    coordination: "direct",
  });
  if (!withOrganizations)
    await rm(join(folder, "organizations"), { recursive: true, force: true });
  return folder;
}

test("where the Folder holds no Organization of theirs, Služby serveru's services are a group of their own: named as the handover names its owner, with no root, no Teams and no modules, never among the Organizations", async () => {
  for (const withOrganizations of [true, false]) {
    const folder = await emptyServicesFolder(withOrganizations);
    const catalog = await readFolderCatalog(
      folder,
      undefined,
      async () => served,
    );
    expect(catalog).toEqual({
      kind: "catalog",
      organizations: [],
      serverServices: {
        directory: "",
        organization: "Example",
        displayName: null,
        state: null,
        issues: [],
        executable: false,
        teams: [],
        modules: [],
        repositories: [
          {
            slug: "CLIProxyAPI",
            path: null,
            checkedOut: false,
            url: cliProxy,
            services: [
              { id: "try", kind: "ai-gateway", page: null },
              { id: "members", kind: "ai-pool", page: members },
            ],
          },
        ],
      },
    });
    // Without a key the handover names its owner by its login.
    expect(
      (
        await readFolderCatalog(folder, undefined, async () =>
          served === null
            ? null
            : { ...served, owner: { login: "example", key: null } },
        )
      ).serverServices?.organization,
    ).toBe("example");
    // Without services, or anywhere but Služby serveru, there is none.
    for (const services of [async () => null, noServerServices])
      expect(await readFolderCatalog(folder, undefined, services)).toEqual({
        kind: "catalog",
        organizations: [],
      });
  }
});

test("no reader of Organizations takes the group for an installed one: not the routes that ask about one Organization, not the Machine's owner rule, not the rail's held Organizations, and it has no module to start", async () => {
  const folder = await emptyServicesFolder();
  const catalog = await readFolderCatalog(
    folder,
    undefined,
    async () => served,
  );
  const group = catalog.serverServices;
  if (group === undefined) throw new Error("The services group");
  // The page shows and selects it, by its slug in any letter case, never by
  // a directory.
  expect(catalogGroups(catalog)).toEqual([group]);
  for (const name of ["Example", "example"])
    expect(selectCatalogOrganization(catalog, name)).toEqual({
      kind: "found",
      organization: group,
    });
  expect(selectCatalogOrganization(catalog, "")).toEqual({ kind: "missing" });
  // The Owner question, a Steward's maintain and the prompts read the
  // installed Organizations only.
  expect(organizationsOnly(catalog)).toEqual({
    kind: "catalog",
    organizations: [],
  });
  // Organization settings and Composio: no Organization owns this Machine.
  expect(selectOwnerOrganization(catalog, "example")).toEqual({
    kind: "missing",
  });
  // The rail's held Organizations: none (the shell document names the owner
  // from the handover by itself).
  expect(shellOrganizations(catalog)).toEqual([]);
  // Nothing to start, prepare or found a module in.
  expect(catalogModules(catalog)).toEqual([]);
  expect(group.forgeLogin).toBeUndefined();
  expect(parseCatalog(JSON.parse(JSON.stringify(catalog)))).toEqual(catalog);
  // The page refuses a group that looks installed.
  for (const forged of [
    { ...group, directory: "Example_GEN3" },
    { ...group, forgeLogin: "Example" },
    { ...group, modules: [{ module: "x" }] },
    { ...group, repositories: [] },
    {
      ...group,
      repositories: [
        { slug: "x", path: "productionspace/x", checkedOut: true, url: null },
      ],
    },
  ])
    expect(
      parseCatalog(
        JSON.parse(JSON.stringify({ ...catalog, serverServices: forged })),
      ),
    ).toBeNull();
});

test("Apps of Služby serveru whose Organization is not installed: the Organization's name over a Productionspace with the service's link, its Dashboard page, and no Workspace or \"+ Nový modul\" even for an Owner", async () => {
  const folder = await emptyServicesFolder();
  const catalog = await readFolderCatalog(
    folder,
    undefined,
    async () => served,
  );
  const dashboard = (slug: string) =>
    slug.toLowerCase() === "example"
      ? "https://dashboard.example.invalid/orgs/example"
      : null;
  for (const [copy, flag, kinds, link] of [
    [
      cs,
      "Productionspace",
      "Brána AI · AI pool Organizace",
      "Otevřít stránku služby",
    ],
    [
      en,
      "Productionspace",
      "AI gateway · The Organization's AI pool",
      "Open the service's page",
    ],
  ] as const) {
    const group = appsScope(catalog, { view: "home" }, copy);
    if (group === null) throw new Error("The services group is the home");
    expect(group.name).toBe("Example");
    expect(group.href).toBe("/o/Example");
    expect(appsHeading(group, copy, dashboard)).toEqual({
      text: "Example",
      link: {
        href: "https://dashboard.example.invalid/orgs/example",
        title: copy.appsOrganizationDashboard,
      },
    });
    const parts = appsHomeParts(catalog, group, copy, {
      entry: null,
      favorites: [],
      holder: null,
      setup: false,
      tabs: [],
      // An Owner or Admin is who enters Služby serveru.
      owner: true,
    });
    expect(parts.map((part) => part.kind)).toEqual(["section"]);
    const [part] = parts;
    if (part?.kind !== "section") throw new Error("Productionspace");
    expect(part.offer).toBeNull();
    expect(part.section.kind).toBe("productionspace");
    expect(part.section.title).toBe(flag);
    const [tile] = part.section.tiles;
    expect(tile).toMatchObject({
      kind: "repository",
      name: "CLIProxyAPI",
      description: kinds,
      action: { kind: "service", service: "members", href: "/service/members" },
      info: "/o/Example/productionspace/CLIProxyAPI",
    });
    expect(copy.appsServiceOpen).toBe(link);
    expect(newModuleOffer(group, copy, { owner: true, holder: null })).toBe(
      null,
    );
  }
  // The service repository's page and the service's page resolve in it.
  const selection = catalogSelection(
    catalog,
    pageRoute("/o/Example/productionspace/CLIProxyAPI"),
  );
  expect(selection.kind).toBe("repository");
  expect(servicePageOf(catalog, "members")).toBe(members);
  // A module route in it has nothing to show.
  expect(
    catalogSelection(catalog, pageRoute("/o/Example/mission-control")),
  ).toEqual({ kind: "missing" });
});

const posixTest = test.skipIf(!["darwin", "linux"].includes(process.platform));

posixTest(
  "the Launchpad's catalog and `lazurio organization list --json` answer the same services; the page is served under a service's link",
  async () => {
    const folder = await servicesFolder();
    const home = join(dirname(folder), "home");
    await mkdir(home);
    const app = await startLaunchpad(folder, undefined, undefined, undefined, {
      serverServices: async () => served,
    });
    const session = new URL(app.url);
    try {
      const answer = await fetch(new URL("/api/catalog", session), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: session.origin,
          Authorization: `Bearer ${session.hash.slice(1)}`,
        },
        body: "{}",
      });
      expect(answer.status).toBe(200);
      const value = await answer.json();
      const cli = await runCatalogCommand(
        ["organization", "list", "--folder", folder, "--json"],
        {
          identity: { version: "1.0.0", commit: "0".repeat(40), target: "x" },
          platform: process.platform,
          env: { HOME: home },
          executable: join(home, "lazurio"),
          hostedFolder: async () => undefined,
        },
        (path) => readFolderCatalog(path, undefined, async () => served),
      );
      expect(value).toEqual(JSON.parse(cli.text));
      expect(
        repositoriesOf(value as Catalog, "Example")?.map((entry) => entry.slug),
      ).toEqual(["firmware", "CLIProxyAPI"]);
      // A service's link and a service repository's page are pages of the
      // Launchpad: the same document as its home, without the credential.
      const home_ = await (await fetch(new URL("/", session.origin))).text();
      for (const path of [
        servicePath("members"),
        "/o/Example/productionspace/CLIProxyAPI",
      ]) {
        const page = await fetch(new URL(path, session.origin));
        expect([path, page.status]).toEqual([path, 200]);
        expect(await page.text()).toBe(home_);
      }
    } finally {
      expect((await app.close()).kind).toBe("closed");
    }
  },
  30_000,
);

posixTest(
  "a Launchpad whose Folder holds no Organization answers Služby serveru's services group as `lazurio organization list --json` does, and nothing that acts on an installed Organization reaches it",
  async () => {
    const folder = await emptyServicesFolder();
    const home = join(dirname(folder), "home");
    await mkdir(home);
    const app = await startLaunchpad(folder, undefined, undefined, undefined, {
      serverServices: async () => served,
    });
    const session = new URL(app.url);
    const headers = {
      Origin: session.origin,
      Authorization: `Bearer ${session.hash.slice(1)}`,
    };
    try {
      const answer = await fetch(new URL("/api/catalog", session), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: "{}",
      });
      expect(answer.status).toBe(200);
      const value = (await answer.json()) as Catalog;
      const cli = await runCatalogCommand(
        ["organization", "list", "--folder", folder, "--json"],
        {
          identity: { version: "1.0.0", commit: "0".repeat(40), target: "x" },
          platform: process.platform,
          env: { HOME: home },
          executable: join(home, "lazurio"),
          hostedFolder: async () => undefined,
        },
        (path) => readFolderCatalog(path, undefined, async () => served),
      );
      expect(value).toEqual(JSON.parse(cli.text));
      expect(value.organizations).toEqual([]);
      expect(value.serverServices?.organization).toBe("Example");
      // The human table lists the installed Organizations only.
      const table = await runCatalogCommand(
        ["organization", "list", "--folder", folder],
        {
          identity: { version: "1.0.0", commit: "0".repeat(40), target: "x" },
          platform: process.platform,
          env: { HOME: home },
          executable: join(home, "lazurio"),
          hostedFolder: async () => undefined,
        },
        (path) => readFolderCatalog(path, undefined, async () => served),
      );
      expect(table.text).toBe(
        "No Organizations in this Folder's organizations/.",
      );
      // The Owner question reads the installed Organizations only: none.
      expect(
        await (
          await fetch(new URL("/api/organizations/Example/owner", session), {
            headers,
          })
        ).json(),
      ).toEqual({ kind: "organization-owner", owner: false });
      // Module start reads the Folder's own Organizations: none is Example.
      expect(
        await (
          await fetch(
            new URL("/api/modules/Example/mission-control/status", session),
            { headers },
          )
        ).json(),
      ).toMatchObject({ kind: "blocked", reason: "organization-unknown" });
    } finally {
      expect((await app.close()).kind).toBe("closed");
    }
  },
  30_000,
);

// ---- What the page shows ------------------------------------------------------

function servicesCatalog(): Catalog {
  if (served === null) throw new Error("Služby serveru");
  const organization: CatalogOrganization = {
    directory: "Example_GEN3",
    organization: "Example",
    displayName: "Example",
    forgeLogin: "Example",
    state: "current",
    issues: [],
    executable: true,
    teams: [],
    modules: [],
    repositories: withServiceRepositories(
      [declared("firmware", "https://github.com/Example/firmware")],
      served.services,
    ),
  };
  return { kind: "catalog", organizations: [organization] };
}

test("a service repository's tile says what its services are and opens the one page among them; any other repository stays read-only without a link", () => {
  const catalog = servicesCatalog();
  for (const [copy, kinds] of [
    [cs, "Brána AI · AI pool Organizace"],
    [en, "AI gateway · The Organization's AI pool"],
  ] as const) {
    const group = appsScope(catalog, { view: "home" }, copy);
    if (group === null) throw new Error("The catalog has an Organization");
    const sections = appsSections(catalog, group, copy, null);
    // Služby serveru have no workspace module: Productionspace alone.
    expect(sections.map((section) => section.kind)).toEqual([
      "productionspace",
    ]);
    const [firmware, proxy] = sections[0]?.tiles ?? [];
    expect(firmware).toMatchObject({
      name: "firmware",
      description: "productionspace/firmware",
      action: { kind: "say" },
      info: "https://github.com/Example/firmware",
    });
    expect(proxy).toMatchObject({
      key: "r:CLIProxyAPI",
      name: "CLIProxyAPI",
      description: kinds,
      // The AI pool's page; the AI gateway from the same repository has
      // none.
      action: { kind: "service", service: "members", href: "/service/members" },
      // Its own page, a route of the Launchpad.
      info: "/o/Example/productionspace/CLIProxyAPI",
    });
  }
  expect(servicePageOf(catalog, "members")).toBe(members);
  for (const id of ["try", "entry", "dns01", "unknown"])
    expect([id, servicePageOf(catalog, id)]).toEqual([id, null]);
});

test("the link only where a service has a page: a repository of page-less services says it has no app; with several pages its own page lets the person choose", () => {
  const catalog = servicesCatalog();
  const group = appsScope(catalog, { view: "home" }, cs);
  if (group === null) throw new Error("The catalog has an Organization");
  const repository = (services: CatalogRepository["services"]) => ({
    slug: "CLIProxyAPI",
    path: null,
    checkedOut: false,
    url: cliProxy,
    ...(services === undefined ? {} : { services }),
  });
  for (const services of [
    [{ id: "try", kind: "ai-gateway" as const, page: null }],
    [{ id: "entry", kind: "public-entry" as const, page: null }],
    undefined,
  ])
    expect(repositoryAction(catalog, group, repository(services), cs)).toEqual({
      kind: "say",
      text: "Repozitář CLIProxyAPI nemá aplikaci.",
    });
  // Two AI pools of one repository: no guess which, its page.
  expect(
    repositoryAction(
      catalog,
      group,
      repository([
        { id: "team-01", kind: "ai-pool", page: members },
        {
          id: "team-02",
          kind: "ai-pool",
          page: "http://127.0.0.1:18403/management.html",
        },
      ]),
      cs,
    ),
  ).toEqual({ kind: "route", href: "/o/Example/productionspace/CLIProxyAPI" });
});

test("a service repository has a page of its own, read-only, with a card per service; a repository without a service has none", () => {
  const catalog = servicesCatalog();
  const route = pageRoute("/o/Example/productionspace/CLIProxyAPI");
  expect(route).toEqual({
    view: "repository",
    organization: "Example",
    repository: "CLIProxyAPI",
  });
  expect(routePath(route)).toBe("/o/Example/productionspace/CLIProxyAPI");
  expect(pageRoute("/o/Example/productionspace/CLIProxyAPI/")).toEqual(route);
  expect(routeTitle(route, cs, () => "Example")).toEqual({
    heading: "CLIProxyAPI",
    document: "CLIProxyAPI · Example — Lazurio",
  });
  const selection = catalogSelection(catalog, route);
  if (selection.kind !== "repository") throw new Error("Its page");
  expect(selection.repository.slug).toBe("CLIProxyAPI");
  // A production repository without a service has no page (F32).
  expect(
    catalogSelection(catalog, {
      view: "repository",
      organization: "Example",
      repository: "firmware",
    }),
  ).toEqual({ kind: "missing" });
  // Read-only; no folder where the Organization does not declare it.
  expect(repositoryFacts(selection.repository, cs)).toEqual([
    ["Přístup", "Jen ke čtení"],
  ]);
  expect(
    repositoryFacts(
      { ...selection.repository, path: "productionspace/CLIProxyAPI" },
      en,
    ),
  ).toEqual([
    ["Access", "Read-only"],
    ["Folder", "productionspace/CLIProxyAPI"],
  ]);
  const [gateway, pool] = selection.repository.services ?? [];
  if (gateway === undefined || pool === undefined) throw new Error("Two");
  expect(serviceFacts(pool, "Služby serveru", cs)).toEqual([
    ["Název", "members"],
    ["Druh", "AI pool Organizace"],
    ["Běží v", "Služby serveru"],
    ["Stránka služby", "127.0.0.1:18402/management.html"],
  ]);
  expect(serviceFacts(gateway, "Server services", en)).toEqual([
    ["Name", "try"],
    ["Kind", "AI gateway"],
    ["Runs in", "Server services"],
  ]);
});

// ---- The link `/service/<id>` -----------------------------------------------

test("`/service/<id>` asks once for a service's page and is no route of its own: the page shows the Apps home under `/` in its place", () => {
  expect(servicePath("members")).toBe("/service/members");
  expect(pagePaths).toContain("/service/:id");
  for (const path of ["/service/members", "/service/members/"]) {
    expect(serviceRequest(path)).toBe("members");
    // The frame shows the canonical path of the route it shows, so the
    // link leaves the address (replaced, never pushed: Back never asks
    // again) and a reload opens nothing.
    expect(routePath(pageRoute(path))).toBe("/");
  }
  for (const path of [
    "/service",
    "/service/",
    "/service/Members",
    "/service/members/page",
    "/service/members%2Fx",
    `/service/${"a".repeat(33)}`,
    "/services/members",
    "/",
  ])
    expect([path, serviceRequest(path)]).toEqual([path, null]);
});

// ---- One tab per service ------------------------------------------------------

test("a second click on a service is its tab again: the same open for the Launchpad's strip, which the hub answers with the strip's tab of that page and the Launchpad holds once", async () => {
  // The hub's rule of F57 point 7: a tab of the strip that shows the same
  // page (origin, path, query; never the fragment the Management Center
  // routes by) is the tab. Here a loopback hub keeps it by that rule.
  const pages = new Map<string, string>();
  const seen: unknown[] = [];
  const hub = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const { url, strip } = (await request.json()) as {
        url: string;
        strip: string;
      };
      seen.push({ url, strip });
      const key = `${strip}|${addressKey(url)}`;
      const known = pages.get(key);
      const id = known ?? (pages.size + 1).toString(16).padStart(32, "0");
      pages.set(key, id);
      return Response.json(
        {
          id: id.toUpperCase(),
          view: `https://browser.example/t/${id.toUpperCase()}`,
          ...(known === undefined ? {} : { reused: true }),
        },
        { status: known === undefined ? 201 : 200 },
      );
    },
  });
  cleanups.push(() => hub.stop(true));
  const runtime = await temporary("server-services-runtime-");
  const holder = launchpadHolderOf(runtime, {
    bootClock: async () => ({
      boot: "6f2c1d0e-1a2b-4c3d-8e4f-5a6b7c8d9e0f",
      at: 100,
    }),
    readFile: (path) => readFile(path, "utf8"),
  });
  const routes = createNewTabRoutes({
    browser: {
      origin: "https://browser.example",
      listenPort: hub.port as number,
    },
    holder,
    host: {
      runtimeDirectory: runtime,
      run: null,
      readFile: (path) => readFile(path, "utf8"),
      bootClock: async () => null,
      log: () => undefined,
    },
    modules: async () => [],
    headers: {},
  });
  // What the tile asks, twice: the catalog's page for the Launchpad's strip.
  const page = servicePageOf(servicesCatalog(), "members");
  const open = async () => {
    const request = new Request("http://127.0.0.1/api/new-tab/open", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: page, strip: launchpadStrip }),
    });
    const response = await routes.handle(
      request,
      new URL(request.url),
      () => undefined,
    );
    return { status: response.status, body: await response.json() };
  };
  const first = await open();
  const second = await open();
  expect(first.status).toBe(201);
  expect(second).toEqual(first);
  expect(seen).toEqual([
    { url: members, strip: "launchpad" },
    { url: members, strip: "launchpad" },
  ]);
  // The Management Center's own routes stay the same page.
  expect(addressKey(`${members}#/login`)).toBe(addressKey(members));
  // The Launchpad holds the one tab once.
  const directory = holderDirectory({ XDG_RUNTIME_DIR: runtime }) as string;
  const held = parseHolderRecords(
    "launchpad.json",
    await readFile(join(directory, "launchpad.json"), "utf8"),
  );
  expect(held?.tabs.map((tab) => tab.id)).toEqual([first.body.tab]);
  // The panel shows that tab again (its `showView`), never a second entry.
  const tab = first.body.tab as string;
  const once = reduceStrip(emptyStrip, { kind: "show", tab });
  const twice = reduceStrip(once, { kind: "show", tab });
  expect(stripEntries(twice)).toEqual(stripEntries(once));
  expect(stripEntries(twice).map((entry) => entry.kind)).toEqual(["tab"]);
});
