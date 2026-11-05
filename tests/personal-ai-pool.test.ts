import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { initializeFolder } from "../src/folder/initialize-folder";
import { executionOs } from "../src/folder/platform";
import {
  appsHomeParts,
  appsScope,
  appsSections,
  appsTiles,
} from "../src/launchpad/apps-view";
import {
  catalogSelection,
  parseCatalog,
  repositoryFacts,
  serviceFacts,
  servicePageOf,
  servicesText,
} from "../src/launchpad/catalog-view";
import { messages } from "../src/launchpad/messages";
import { pageRoute, servicePath } from "../src/launchpad/routes";
import { startLaunchpad } from "../src/launchpad/server";
import {
  machineContextPath,
  parseMachineContext,
  parseMachineHandover,
} from "../src/machine/context";
import {
  type Catalog,
  type CatalogOrganization,
  type CatalogRepository,
  handoverServerServices,
  readFolderCatalog,
  serverServicesOf,
} from "../src/organizations/catalog";
import { selectOwnerOrganization } from "../src/organizations/catalog-selection";
import { runCatalogCommand } from "../src/organizations/cli";
import {
  heldBy,
  writeOrganization,
  writePersonalspaceModule,
} from "./fixtures/catalog-folder";
import { handoverEntry } from "./fixtures/machine-bindings";
import organizationContext from "./fixtures/machine-context.json";
import personalContext from "./fixtures/machine-context-personal.json";
import servicesContext from "./fixtures/machine-context-services.json";
import { writeOwnedFixture as writeFile } from "./fixtures/owned-files";

// Root decision 0181, its amendment of 2026-11-05 (plan LZD-0001; Machines
// #1099; decision F32's addendum of 2026-11-05): a person may switch on an AI
// pool of their own in their Personal Environment, on its loopback only.
// Machines names it in the personal branch's `services`; the Launchpad shows
// it in the personal Workspace as Služby serveru show theirs: the fork's
// read-only repository whose tile opens the pool's Management Center in the
// Environment browser. Every other Environment's catalog stays as it was.
// Synthetic names only.

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function temporary(prefix: string) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
const cs = messages("cs", "personal");
const en = messages("en", "personal");
const page = "http://127.0.0.1:18410/management.html";
const cliProxy = "https://github.com/Lazurio/CLIProxyAPI";
const pool = {
  id: "ai-pool",
  kind: "ai-pool",
  repository: "Lazurio/CLIProxyAPI",
  page_port: 18410,
} as const;
const handover = { ...personalContext, services: [pool] };
const served = serverServicesOf(parseMachineContext(bytes(handover)));
const poolEntry: CatalogRepository = {
  slug: "CLIProxyAPI",
  path: null,
  checkedOut: false,
  url: cliProxy,
  services: [{ id: "ai-pool", kind: "ai-pool", page }],
};

// ---- The handover -----------------------------------------------------------

test("the vendored schema takes a personal handover's one AI pool exactly as Machines writes it, and nothing else in its place", () => {
  expect(JSON.stringify(parseMachineContext(bytes(handover)))).toBe(
    JSON.stringify(handover),
  );
  // Without it the personal handover reads as before.
  expect(JSON.stringify(parseMachineContext(bytes(personalContext)))).toBe(
    JSON.stringify(personalContext),
  );
  const { page_port: _port, ...portless } = pool;
  for (const services of [
    [],
    [pool, pool],
    [portless],
    [{ ...pool, page_port: 18399 }],
    [{ ...pool, page_port: 18500 }],
    [{ ...pool, page_port: "18410" }],
    [{ ...pool, id: "members" }],
    [{ ...pool, kind: "ai-gateway" }],
    [{ ...pool, repository: "Example/CLIProxyAPI" }],
    [{ ...pool, hostname: "pool.example.invalid" }],
    { ...pool },
  ])
    expect([
      services,
      (() => {
        try {
          parseMachineContext(bytes({ ...handover, services }));
          return "accepted";
        } catch (error) {
          return (error as { code?: string }).code;
        }
      })(),
    ]).toEqual([
      services,
      Array.isArray(services) && services.length === 0
        ? "accepted"
        : "machine-context-invalid",
    ]);
});

test("an auth-sourced personal handover never carries the pool: the person is not known yet", () => {
  const free = {
    ...personalContext,
    machine: {
      id: "personal-env-0007",
      kind: "personal-vm",
      name: "env-0007",
      vmid: 207,
    },
    owner: { kind: "assignment", source: "auth" },
    assignment_receipt: {
      path: "/etc/lazurio/assignment.json",
      schema_version: "lazurio.assignment.v1",
    },
    operator: {
      os_user: "env-0007",
      home: "/home/env-0007",
      lazurio_root: "/home/env-0007/Lazurio",
    },
    entry: JSON.parse(JSON.stringify(handoverEntry("{dns_slug}.lazurio.io"))),
  };
  expect(() => parseMachineHandover(bytes(free))).not.toThrow();
  expect(() =>
    parseMachineHandover(bytes({ ...free, services: [pool] })),
  ).toThrow("machine-context-invalid");
});

test("a personal handover with its pool gives the pool with no owning Organization; without `services`, and on every other Environment but Služby serveru, there is nothing", () => {
  expect(served).toEqual({
    owner: null,
    services: [{ id: "ai-pool", kind: "ai-pool", page, url: cliProxy }],
  });
  expect(serverServicesOf(parseMachineContext(bytes(personalContext)))).toBe(
    null,
  );
  // A work Environment that is not Služby serveru: none, as before.
  expect(
    serverServicesOf(parseMachineContext(bytes(organizationContext))),
  ).toBeNull();
  // Služby serveru keep their owner.
  expect(
    serverServicesOf(
      parseMachineContext(bytes({ ...servicesContext, services: [pool] })),
    )?.owner,
  ).toEqual({ login: "example", key: "Example" });
});

test("the pool is read from the root-custodied handover, as Služby serveru's services are", async () => {
  const uid = process.getuid?.() ?? 0;
  const root = join(await temporary("personal-ai-pool-handover-"), "machine");
  await mkdir(root, { mode: 0o755 });
  const source = { platform: "linux", root, custodian: uid };
  const file = join(root, machineContextPath);
  await mkdir(dirname(file), { recursive: true, mode: 0o755 });
  await writeFile(file, JSON.stringify(handover), { mode: 0o644 });
  expect(await handoverServerServices(source)).toEqual(served);
  await writeFile(file, JSON.stringify(personalContext), { mode: 0o644 });
  expect(await handoverServerServices(source)).toBeNull();
});

// ---- The catalog ------------------------------------------------------------

// A Folder with a Personalspace (an owner directory with one module) and an
// Organization that declares CLIProxyAPI itself: the pool is the person's,
// never that Organization's.
async function personalFolder(options: { modules?: boolean } = {}) {
  const parent = await temporary("personal-ai-pool-folder-");
  const folder = join(parent, "Lazurio");
  await initializeFolder(folder, {
    os: executionOs(process.platform),
    access: "local",
    purpose: "human",
    locale: "cs",
    detail: "concise",
    coordination: "direct",
  });
  const owner = join(folder, "personalspace", "example_GEN3");
  await mkdir(owner, { recursive: true });
  if (options.modules !== false)
    await writePersonalspaceModule(folder, "example_GEN3", "example", {
      id: "notes",
    });
  await writeOrganization(folder, "other", {
    slug: "other",
    state: "current",
    modules: [],
    forge: "example",
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

test("the Personalspace group lists the pool's repository, read-only and without a path; no Organization gets it, and without the pool every catalog is as it was", async () => {
  const folder = await personalFolder();
  const holder = heldBy("example");
  const before = await readFolderCatalog(folder, holder);
  const after = await readFolderCatalog(folder, holder, async () => served);
  if (before.personalspace === undefined) throw new Error("Personalspace");
  expect(before.personalspace.repositories).toEqual([]);
  expect(after.personalspace).toEqual({
    ...before.personalspace,
    repositories: [poolEntry],
  });
  // The Organization that declares the same repository, and whose login is
  // the person's, is not the pool's owner: unchanged, and no group of
  // Služby serveru appears.
  expect(after.organizations).toEqual(before.organizations);
  expect(after.serverServices).toBeUndefined();
  expect(selectOwnerOrganization(after, "example").kind).toBe("found");
  // No pool, or none readable: the same catalog as before.
  for (const services of [
    async () => null,
    async () => {
      throw new Error("unreadable");
    },
    async () => (served === null ? null : { ...served, services: [] }),
  ])
    expect(await readFolderCatalog(folder, holder, services)).toEqual(before);
  // A group listed with a reason (not decided yet) carries it too: the pool
  // runs here whatever the Personalspace's state.
  const unverified = await readFolderCatalog(
    folder,
    undefined,
    async () => served,
  );
  expect(unverified.personalspace?.reason).toBe("personalspace-unverified");
  expect(unverified.personalspace?.repositories).toEqual([poolEntry]);
  // The page's parser admits it.
  expect(parseCatalog(JSON.parse(JSON.stringify(after)))).toEqual(after);
});

test("a Folder without a Personalspace group lists the pool nowhere", async () => {
  const folder = await personalFolder();
  await rm(join(folder, "personalspace"), { recursive: true, force: true });
  const before = await readFolderCatalog(folder);
  expect(before.personalspace).toBeUndefined();
  expect(
    await readFolderCatalog(folder, undefined, async () => served),
  ).toEqual(before);
});

// ---- What Apps shows ----------------------------------------------------------

function personalCatalog(modules: boolean): Catalog {
  const personalspace: CatalogOrganization = {
    directory: "personalspace",
    organization: "personalspace",
    displayName: "Personalspace",
    state: null,
    issues: [],
    executable: true,
    teams: [],
    modules: modules
      ? [
          {
            organization: "personalspace",
            module: "notes",
            path: "workspace/notes",
            teams: [],
            teamsSource: "none",
            apps: [],
            defaultApp: null,
            name: "Notes",
            state: null,
            executable: true,
          } as unknown as CatalogOrganization["modules"][number],
        ]
      : [],
    repositories: [poolEntry],
  };
  return { kind: "catalog", organizations: [], personalspace };
}

test("the personal Workspace shows the pool's tile after the modules, in the person's words, opening its page; with no module it still shows", () => {
  for (const modules of [true, false])
    for (const [copy, kind, link] of [
      [cs, "Váš AI pool", "Otevřít stránku služby"],
      [en, "Your AI pool", "Open the service's page"],
    ] as const) {
      const catalog = personalCatalog(modules);
      const group = appsScope(catalog, { view: "home" }, copy);
      if (group === null) throw new Error("The personal space is the home");
      expect(group.sections).toBeNull();
      const tiles = appsTiles(catalog, group, copy, null, []);
      expect(tiles.repositories).toHaveLength(1);
      const sections = appsSections(catalog, group, copy, null);
      expect(sections.map((section) => section.kind)).toEqual(["personal"]);
      const [section] = sections;
      expect(section?.title).toBe(copy.catalogSectionWorkspace);
      expect(section?.tiles.map((tile) => tile.kind)).toEqual(
        modules ? ["module", "repository"] : ["repository"],
      );
      expect(section?.tiles.at(-1)).toMatchObject({
        kind: "repository",
        key: "r:CLIProxyAPI",
        name: "CLIProxyAPI",
        description: kind,
        action: {
          kind: "service",
          service: "ai-pool",
          href: "/service/ai-pool",
        },
        info: "/o/personalspace/productionspace/CLIProxyAPI",
      });
      expect(copy.appsServiceOpen).toBe(link);
      // A starred pool comes first, as any favourite.
      expect(
        appsSections(catalog, group, copy, null, ["r:CLIProxyAPI"])[0]?.tiles[0]
          ?.kind,
      ).toBe("repository");
      // Not the plain sentence of an empty space.
      expect(
        appsHomeParts(catalog, group, copy, {
          entry: null,
          favorites: [],
          setup: false,
          tabs: [],
        }).map((part) => part.kind),
      ).toEqual(["section"]);
    }
});

test("the pool's page is its repository's read-only page in the Personalspace group, and `/service/ai-pool` finds its Management Center", () => {
  const catalog = personalCatalog(true);
  const route = pageRoute("/o/personalspace/productionspace/CLIProxyAPI");
  const selection = catalogSelection(catalog, route);
  if (selection.kind !== "repository") throw new Error("Its page");
  expect(selection.organization).toBe(
    catalog.personalspace as CatalogOrganization,
  );
  expect(repositoryFacts(selection.repository, cs)).toEqual([
    ["Přístup", "Jen ke čtení"],
  ]);
  const [service] = selection.repository.services ?? [];
  if (service === undefined) throw new Error("The pool");
  expect(serviceFacts(service, "Osobní Prostředí", cs, true)).toEqual([
    ["Název", "ai-pool"],
    ["Druh", "Váš AI pool"],
    ["Běží v", "Osobní Prostředí"],
    ["Stránka služby", "127.0.0.1:18410/management.html"],
  ]);
  expect(servicesText([service], en, true)).toBe("Your AI pool");
  // An Organization's pool keeps the Organization's words.
  expect(servicesText([service], cs)).toBe("AI pool Organizace");
  expect(servicePath("ai-pool")).toBe("/service/ai-pool");
  expect(servicePageOf(catalog, "ai-pool")).toBe(page);
  // Without the pool there is no such page and no such service.
  const without: Catalog = {
    ...catalog,
    personalspace: {
      ...(catalog.personalspace as CatalogOrganization),
      repositories: [],
    },
  };
  expect(catalogSelection(without, route)).toEqual({ kind: "missing" });
  expect(servicePageOf(without, "ai-pool")).toBeNull();
  const group = appsScope(without, { view: "home" }, cs);
  if (group === null) throw new Error("The personal space");
  expect(appsTiles(without, group, cs, null, []).repositories).toEqual([]);
});

// ---- The real server ----------------------------------------------------------

const posixTest = test.skipIf(!["darwin", "linux"].includes(process.platform));

posixTest(
  "the Launchpad's catalog and `lazurio organization list --json` list the pool in the Personalspace group alike, and serve the page under the pool's link",
  async () => {
    const folder = await personalFolder();
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
      const listed = JSON.parse(cli.text) as Catalog;
      expect(value.personalspace?.repositories).toEqual([poolEntry]);
      expect(listed.personalspace?.repositories).toEqual([poolEntry]);
      expect(value.organizations).toEqual(listed.organizations);
      expect(JSON.stringify(value.organizations)).not.toContain("services");
      expect(value.serverServices).toBeUndefined();
      const parsed = parseCatalog(value);
      if (parsed === null) throw new Error("The page reads the answer");
      expect(servicePageOf(parsed, "ai-pool")).toBe(page);
      // The pool's link and its repository's page are pages of the
      // Launchpad: the same document as its home, without the credential.
      const document = await (await fetch(new URL("/", session.origin))).text();
      for (const path of [
        servicePath("ai-pool"),
        "/o/personalspace/productionspace/CLIProxyAPI",
      ]) {
        const response = await fetch(new URL(path, session.origin));
        expect([path, response.status]).toEqual([path, 200]);
        expect(await response.text()).toBe(document);
      }
    } finally {
      expect((await app.close()).kind).toBe("closed");
    }
  },
  30_000,
);

posixTest(
  "a Launchpad whose handover names no pool lists the Personalspace group as before",
  async () => {
    const folder = await personalFolder({ modules: false });
    const app = await startLaunchpad(folder, undefined, undefined, undefined, {
      serverServices: async () =>
        serverServicesOf(parseMachineContext(bytes(personalContext))),
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
      const value = (await answer.json()) as Catalog;
      expect(value.personalspace?.repositories).toEqual([]);
      expect(JSON.stringify(value)).not.toContain("services");
    } finally {
      expect((await app.close()).kind).toBe("closed");
    }
  },
  30_000,
);
