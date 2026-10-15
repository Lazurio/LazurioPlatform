import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  integrationsText,
  runIntegrationsCommand,
} from "../src/integrations/cli";
import {
  composioOrganizationRule,
  composioOrganizationVerdict,
  organizationKey,
} from "../src/integrations/composio-organization";
import type { IntegrationsOverview } from "../src/integrations/model";
import {
  composioOrganizationLine,
  parseIntegrations,
} from "../src/launchpad/integrations-view";
import { messages } from "../src/launchpad/messages";
import { organizationRule } from "../src/launchpad/tools-view";
import { readFolderCatalog } from "../src/organizations/catalog";
import { selectCatalogOrganization } from "../src/organizations/catalog-selection";
import { embeddedIdentity } from "../src/update/identity";
import { writeOrganization } from "./fixtures/catalog-folder";
import {
  captureConsole,
  composioCalls,
  type FakeComposioState,
  integrationsWorld,
  readComposioState,
  worldLaunchpad,
  writeComposioState,
} from "./fixtures/integrations-world";
import { bindings } from "./fixtures/machine-bindings";

// The Composio organization of an Environment (decision F42, addendum of
// 2026-10-13): each person has one Composio account and in it one
// organization of their own for each Lazurio Organization, named as the
// Organization is. An Organization's Environment works in the organization
// of its Organization's name, matched whatever the case, the spaces and the
// diacritics, made current by the Launchpad; where the account has none, or
// more than one, nothing of Composio counts and nothing connects through it.
// A personal Environment and a computer work in the one the person chose.

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function parent(): Promise<string> {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "lazurio-composio-organization-")),
  );
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

const listed = (current: string, ...names: string[]) =>
  names.map((name, index) => ({
    id: `org_${index + 1}`,
    name,
    current: name === current,
  }));

test("a name is one whatever its case, spaces and diacritics", () => {
  expect(organizationKey("Human and Machine")).toBe("humanandmachine");
  expect(organizationKey(" Příklad  ")).toBe(organizationKey("PRIKLAD"));
  // Punctuation is part of the name.
  expect(organizationKey("Příklad s.r.o.")).not.toBe(
    organizationKey("Příklad"),
  );
});

test("the verdict over the account's organizations", () => {
  const named = { kind: "named", name: "Human and Machine" } as const;
  expect(
    composioOrganizationVerdict(
      { kind: "chosen" },
      listed("jana_workspace", "jana_workspace", "humanandmachine"),
    ),
  ).toEqual({ kind: "chosen", current: "jana_workspace" });
  expect(
    composioOrganizationVerdict(
      named,
      listed("humanandmachine", "jana_workspace", "humanandmachine"),
    ),
  ).toEqual({
    kind: "matches",
    organization: { id: "org_2", name: "humanandmachine", current: true },
  });
  expect(
    composioOrganizationVerdict(
      named,
      listed("jana_workspace", "jana_workspace", "humanandmachine"),
    ),
  ).toEqual({
    kind: "elsewhere",
    organization: { id: "org_2", name: "humanandmachine", current: false },
    current: "jana_workspace",
  });
  expect(
    composioOrganizationVerdict(named, listed("spectoda", "spectoda")),
  ).toEqual({
    kind: "missing",
    name: "Human and Machine",
    current: "spectoda",
  });
  expect(
    composioOrganizationVerdict(
      named,
      listed("spectoda", "spectoda", "Human and Machine", "humanandmachine"),
    ),
  ).toEqual({
    kind: "ambiguous",
    name: "Human and Machine",
    current: "spectoda",
  });
});

test("the rule: an Organization's Environment by its Organization's name, unverified where it cannot be read, anything else chosen", async () => {
  const folder = join(await parent(), "Lazurio");
  await mkdir(folder, { recursive: true, mode: 0o700 });
  // No Organization of that slug in the Folder: unverified, never the
  // person's choice and never a guess (Pablo's review of #372).
  expect(await composioOrganizationRule(folder, bindings.organization)).toEqual(
    { kind: "unverified" },
  );
  await writeOrganization(folder, "example", {
    slug: "example",
    state: "current",
    modules: [],
    displayName: "Příklad s.r.o.",
  });
  expect(await composioOrganizationRule(folder, bindings.organization)).toEqual(
    { kind: "named", name: "Příklad s.r.o." },
  );
  expect(await composioOrganizationRule(folder, bindings.personal)).toEqual({
    kind: "chosen",
  });
  expect(await composioOrganizationRule(folder, null)).toEqual({
    kind: "chosen",
  });
});

// The Machine handover names the owner by its lowercased GitHub login; a
// manifest keeps its capitals (a real Environment of rc.65: owner `example`,
// slug and login `Example`). The owner is the Organization that Organization
// settings select (F45, `selectCatalogOrganization`): by its slug whatever the
// case, else by its directory; a GitHub login alone selects nothing (Pablo's
// review of #398), and two slugs answering the owner select nothing either.
test("the rule takes the owning Organization that Organization settings select (F45), whatever the case", async () => {
  const owner = bindings.organization.owner;
  if (owner.kind !== "organization") throw new Error("organization binding");
  const agree = async (folder: string) => {
    const selection = selectCatalogOrganization(
      await readFolderCatalog(folder),
      owner.organization,
    );
    const rule = await composioOrganizationRule(folder, bindings.organization);
    expect(rule.kind === "named").toBe(selection.kind === "found");
    return rule;
  };

  const capitals = join(await parent(), "Lazurio");
  await mkdir(capitals, { recursive: true, mode: 0o700 });
  await writeOrganization(capitals, "Example_GEN3", {
    slug: "Example",
    state: "current",
    modules: [],
    displayName: "Example",
  });
  expect(await agree(capitals)).toEqual({ kind: "named", name: "Example" });

  // Only the GitHub login answers the owner: F45 reads no settings
  // (organization-absent), so Composio counts nothing either.
  const byLogin = join(await parent(), "Lazurio");
  await mkdir(byLogin, { recursive: true, mode: 0o700 });
  await writeOrganization(byLogin, "Corp", {
    slug: "ExampleCorp",
    forge: "Example",
    state: "current",
    modules: [],
    displayName: "Example Corp",
  });
  expect(await agree(byLogin)).toEqual({ kind: "unverified" });

  const twice = join(await parent(), "Lazurio");
  await mkdir(twice, { recursive: true, mode: 0o700 });
  for (const [directory, slug] of [
    ["One", "Example"],
    ["Two", "example"],
  ] as const)
    await writeOrganization(twice, directory, {
      slug,
      state: "current",
      modules: [],
      displayName: directory,
    });
  expect(await agree(twice)).toEqual({ kind: "unverified" });
});

const gmail = {
  id: "ca_1",
  toolkit: "gmail",
  status: "ACTIVE",
  alias: null,
  word_id: "castle",
};

async function launchpad(
  composio: Partial<FakeComposioState>,
  rule: { kind: "named"; name: string } | { kind: "unverified" } | null,
) {
  const directory = await parent();
  const world = await integrationsWorld(directory, {
    composio: { accounts: [gmail], ...composio },
  });
  cleanups.push(() => world.executor.stop());
  const app = await worldLaunchpad(directory, world, {
    tools: ["composio"],
    ...(rule === null ? {} : { seams: { composioOrganization: rule } }),
  });
  cleanups.push(() => app.close());
  const read = async () =>
    (await (
      await app.get("/api/integrations?refresh=1")
    ).json()) as IntegrationsOverview;
  return { world, app, read };
}

test("an Organization's Environment is made current in the organization of its Organization's name", async () => {
  const console = captureConsole();
  try {
    const { world, read } = await launchpad(
      {
        organization: "jana_workspace",
        organizations: [
          { id: "org_1", name: "jana_workspace" },
          { id: "org_2", name: "priklad" },
        ],
      },
      { kind: "named", name: "Příklad" },
    );
    const overview = await read();
    expect(overview.composio.organization).toEqual({
      name: "Příklad",
      state: "matches",
    });
    expect(overview.sources.composio).toBe("ok");
    // The CLI works in it now, and the accounts are its.
    expect((await readComposioState(world.home)).organization).toBe("priklad");
    expect(await composioCalls(world.home)).toContainEqual([
      "orgs",
      "switch",
      "--org-id",
      "org_2",
    ]);
    expect(
      overview.apps.find((app) => app.id === "gmail")?.accounts,
    ).toMatchObject([{ path: "composio", state: "connected" }]);
    // "Spravovat v Composiu" opens the organization it works in.
    expect(
      overview.apps.find((app) => app.id === "gmail")?.accounts[0]?.manage,
    ).toBe("https://dashboard.composio.dev/priklad/~/connect/apps/gmail");
    // "Aplikace v Composiu" opens that organization's Apps (F42, addendum
    // of 2026-10-14).
    expect(overview.composio.apps).toBe(
      "https://dashboard.composio.dev/priklad/~/connect/apps",
    );
    // Journaled as the operation and its outcome, never a name or an id.
    expect(console.text()).toContain("composio-organization");
    expect(console.text()).toContain("switched");
    expect(console.text()).not.toContain("org_2");
    // A second reading switches nothing.
    await read();
    expect(
      (await composioCalls(world.home)).filter(
        (call) => call[0] === "orgs" && call[1] === "switch",
      ),
    ).toHaveLength(1);
  } finally {
    console.restore();
  }
});

test("an account without the organization: Composio works in the person's current one, with a notice for the person and the agents (the Operator's decision)", async () => {
  const { world, app, read } = await launchpad(
    {
      organization: "jana_workspace",
      organizations: [{ id: "org_1", name: "jana_workspace" }],
    },
    { kind: "named", name: "Příklad" },
  );
  const overview = await read();
  expect(overview.sources.composio).toBe("ok");
  expect(overview.composio.organization).toEqual({
    name: "Příklad",
    state: "missing",
  });
  // Nothing breaks for a person who already connects through Composio.
  const card = overview.apps.find((item) => item.id === "gmail");
  expect(card?.accounts).toMatchObject([
    { path: "composio", state: "connected" },
  ]);
  expect(card?.connected).toBe(true);
  // Composio's Apps in the organization it works in meanwhile.
  expect(overview.composio.apps).toBe(
    "https://dashboard.composio.dev/jana_workspace/~/connect/apps",
  );
  const connect = await app.post("/api/integrations/connect", {
    app: "salesforce",
  });
  expect(connect.status).toBe(200);
  expect(await connect.json()).toMatchObject({ kind: "authorize" });
  // Linked in the current organization; nothing was switched.
  const calls = await composioCalls(world.home);
  expect(
    calls.some(
      (call) =>
        call[0] === "link" &&
        call[1] === "salesforce" &&
        !call.includes("--list"),
    ),
  ).toBe(true);
  expect(calls.some((call) => call[0] === "orgs" && call[1] === "switch")).toBe(
    false,
  );
  expect((await readComposioState(world.home)).organization).toBe(
    "jana_workspace",
  );
  expect(integrationsText(overview)).toContain(
    "Composio: the person's account has no organization named \"Příklad\" (this Environment's Organization), so Composio works in the person's current organization meanwhile.",
  );
  // Agents learn where the person connects an app the catalog does not list.
  expect(integrationsText(overview)).toContain(
    "An app the catalog does not list is connected by the person in Composio (https://dashboard.composio.dev/jana_workspace/~/connect/apps); it then shows here.",
  );
});

test("more than one organization of the name: none is guessed, Composio works in the current one with a notice", async () => {
  const { world, read } = await launchpad(
    {
      organization: "jana_workspace",
      organizations: [
        { id: "org_1", name: "jana_workspace" },
        { id: "org_2", name: "Příklad" },
        { id: "org_3", name: "priklad" },
      ],
    },
    { kind: "named", name: "Příklad" },
  );
  const overview = await read();
  expect(overview.sources.composio).toBe("ok");
  expect(overview.composio.organization).toEqual({
    name: "Příklad",
    state: "ambiguous",
  });
  expect((await readComposioState(world.home)).organization).toBe(
    "jana_workspace",
  );
});

test("an organization of the name that cannot be made current: nothing of Composio counts, nothing is written", async () => {
  const { world, app, read } = await launchpad(
    {
      organization: "jana_workspace",
      removeYes: true,
      switchFails: true,
      organizations: [
        { id: "org_1", name: "jana_workspace" },
        { id: "org_2", name: "priklad" },
      ],
    },
    { kind: "named", name: "Příklad" },
  );
  const overview = await read();
  expect(overview.sources.composio).toBe("organization");
  expect(overview.composio.organization).toEqual({
    name: "Příklad",
    state: "elsewhere",
  });
  // No way to Composio's Apps where its organization cannot be told.
  expect(overview.composio.apps).toBeNull();
  expect(integrationsText(overview)).not.toContain(
    "connected by the person in Composio",
  );
  expect(overview.apps.find((item) => item.id === "gmail")?.accounts).toEqual(
    [],
  );
  for (const [path, body] of [
    ["/api/integrations/connect", { app: "salesforce" }],
    [
      "/api/integrations/disconnect",
      { app: "gmail", path: "composio", account: "castle", confirm: true },
    ],
  ] as const) {
    const answer = await app.post(path, body);
    expect(answer.status).toBe(409);
    expect(await answer.json()).toEqual({
      kind: "blocked",
      reason: "composio-organization",
    });
  }
  const calls = await composioCalls(world.home);
  expect(
    calls.some((call) => call[0] === "link" && !call.includes("--list")),
  ).toBe(false);
  expect(calls.some(removes)).toBe(false);
});

test("an Organization's Environment whose Organization's name cannot be read: nothing of Composio counts, nothing is written (Pablo's review of #372)", async () => {
  const directory = await parent();
  const world = await integrationsWorld(directory, {
    composio: {
      accounts: [gmail],
      organization: "jana_workspace",
      removeYes: true,
      organizations: [
        { id: "org_1", name: "jana_workspace" },
        { id: "org_2", name: "priklad" },
      ],
    },
  });
  cleanups.push(() => world.executor.stop());
  const app = await worldLaunchpad(directory, world, {
    tools: ["composio"],
    handover: {
      preset: "hosted-organization-personal",
      machine: bindings.organization,
      organization: { slug: "example", displayName: "Příklad" },
    },
  });
  cleanups.push(() => app.close());
  const read = async () =>
    (await (
      await app.get("/api/integrations?refresh=1")
    ).json()) as IntegrationsOverview;
  expect((await read()).composio.organization?.state).toBe("matches");
  // The Organization's root becomes unreadable, and another organization is
  // chosen behind the cached reading.
  await rm(join(directory, "Lazurio", "organizations", "example"), {
    recursive: true,
    force: true,
  });
  await app.post("/api/tools/composio/organization", { id: "org_1" });
  for (const [path, body] of [
    ["/api/integrations/connect", { app: "salesforce" }],
    [
      "/api/integrations/disconnect",
      { app: "gmail", path: "composio", account: "castle", confirm: true },
    ],
  ] as const) {
    const answer = await app.post(path, body);
    expect(answer.status).toBe(409);
    expect(await answer.json()).toEqual({
      kind: "blocked",
      reason: "composio-organization",
    });
  }
  const calls = await composioCalls(world.home);
  expect(
    calls.some((call) => call[0] === "link" && !call.includes("--list")),
  ).toBe(false);
  expect(calls.some(removes)).toBe(false);
  const overview = await read();
  expect(overview.sources.composio).toBe("organization");
  expect(overview.composio.organization).toEqual({
    name: null,
    state: "unverified",
  });
  expect(overview.composio.apps).toBeNull();
  expect(overview.apps.find((item) => item.id === "gmail")?.accounts).toEqual(
    [],
  );
  // Nothing is switched where the name is unknown.
  expect((await readComposioState(world.home)).organization).toBe(
    "jana_workspace",
  );
});

test("where the person chooses, the organization is never read or changed", async () => {
  const { world, read } = await launchpad(
    {
      organization: "jana_workspace",
      organizations: [
        { id: "org_1", name: "jana_workspace" },
        { id: "org_2", name: "priklad" },
      ],
    },
    null,
  );
  const overview = await read();
  expect(overview.composio.organization).toBeNull();
  expect(overview.sources.composio).toBe("ok");
  // The organization the person chose.
  expect(overview.composio.apps).toBe(
    "https://dashboard.composio.dev/jana_workspace/~/connect/apps",
  );
  expect(
    (await composioCalls(world.home)).some((call) => call[0] === "orgs"),
  ).toBe(false);
});

test("an Organization's Environment by its Folder: the sign-in dialog makes the organization current or says it is missing, and the reading agrees", async () => {
  for (const [organizations, state] of [
    [
      [
        { id: "org_1", name: "First" },
        { id: "org_2", name: "priklad" },
      ],
      "matches",
    ],
    [[{ id: "org_1", name: "First" }], "missing"],
  ] as const) {
    const directory = await parent();
    const world = await integrationsWorld(directory, {
      composio: {
        accounts: [gmail],
        organization: "First",
        organizations: [...organizations],
      },
    });
    cleanups.push(() => world.executor.stop());
    const app = await worldLaunchpad(directory, world, {
      tools: ["composio"],
      handover: {
        preset: "hosted-organization-personal",
        machine: bindings.organization,
        organization: { slug: "example", displayName: "Příklad" },
      },
    });
    cleanups.push(() => app.close());
    const answer = (await (
      await app.post("/api/tools/composio/organizations", {})
    ).json()) as Record<string, unknown>;
    expect(answer).toMatchObject({
      kind: "composio-organizations",
      organization: { name: "Příklad", state },
    });
    expect((await readComposioState(world.home)).organization).toBe(
      state === "matches" ? "priklad" : "First",
    );
    const reading = (await (
      await app.get("/api/integrations?refresh=1")
    ).json()) as IntegrationsOverview;
    expect(reading.composio.organization).toEqual({ name: "Příklad", state });
    // Missing: the person's current organization, with a notice.
    expect(reading.sources.composio).toBe("ok");
  }
});

test("a personal Environment's sign-in dialog leaves the choice to the person, with the advice", async () => {
  const directory = await parent();
  const world = await integrationsWorld(directory, {
    composio: {
      organization: "First",
      organizations: [
        { id: "org_1", name: "First" },
        { id: "org_2", name: "Second" },
      ],
    },
  });
  cleanups.push(() => world.executor.stop());
  const app = await worldLaunchpad(directory, world, {
    tools: ["composio"],
    handover: { preset: "hosted-personal", machine: bindings.personal },
  });
  cleanups.push(() => app.close());
  const answer = await (
    await app.post("/api/tools/composio/organizations", {})
  ).json();
  expect(answer).toEqual({
    kind: "composio-organizations",
    organizations: [
      { id: "org_1", name: "First", current: true },
      { id: "org_2", name: "Second", current: false },
    ],
    organization: null,
    personal: true,
  });
  expect(organizationRule(answer)).toEqual({ kind: "chosen", personal: true });
  expect((await readComposioState(world.home)).organization).toBe("First");
});

test("the page's words for each state of the organization", () => {
  const copy = messages("cs");
  const overview = (
    state: "matches" | "missing" | "ambiguous" | "elsewhere",
    source: "ok" | "organization",
  ) =>
    ({
      sources: { tools: "ok", executor: "ok", composio: source },
      composio: {
        allowed: true,
        source: "organization",
        ready: true,
        disconnect: false,
        organization: { name: "Human and Machine", state },
      },
    }) as unknown as IntegrationsOverview;
  expect(composioOrganizationLine(overview("matches", "ok"), copy)).toBeNull();
  expect(composioOrganizationLine(overview("missing", "ok"), copy)).toBe(
    "Ve vašem účtu Composia chybí organizace „Human and Machine“. Toto Prostředí patří Organizaci Human and Machine a má se přes Composio připojovat ve vaší vlastní organizaci stejného jména; dokud ji nezaložíte, připojuje se v organizaci, kterou máte vybranou. Založte ji v Composiu a klikněte na Zkontrolovat připojení.",
  );
  expect(composioOrganizationLine(overview("ambiguous", "ok"), copy)).toContain(
    "víc organizací se jménem „Human and Machine“. Dokud nezůstane jen jedna",
  );
  expect(
    composioOrganizationLine(overview("elsewhere", "organization"), copy),
  ).toContain("nepodařilo přepnout do vaší organizace „Human and Machine“");
  expect(
    composioOrganizationLine(
      {
        ...overview("matches", "organization"),
        composio: {
          ...overview("matches", "organization").composio,
          organization: { name: null, state: "unverified" },
        },
      },
      copy,
    ),
  ).toBe(copy.integrationsComposioOrganizationUnverified);
  expect(
    organizationRule({
      kind: "composio-organizations",
      organizations: [],
      organization: { name: "Human and Machine", state: "missing" },
    }),
  ).toEqual({ kind: "named", name: "Human and Machine", state: "missing" });
  // Anything else is the person's choice.
  expect(organizationRule({ organization: { name: "", state: "x" } })).toEqual({
    kind: "chosen",
    personal: false,
  });
});

test("the page takes a reading with the organization's state, and refuses a malformed one", async () => {
  const { read } = await launchpad(
    {
      organization: "jana_workspace",
      organizations: [{ id: "org_1", name: "jana_workspace" }],
    },
    { kind: "named", name: "Příklad" },
  );
  const overview = await read();
  expect(parseIntegrations(overview)).toEqual(overview);
  for (const organization of [
    { name: "", state: "missing" },
    { name: "Příklad", state: "unknown" },
    "Příklad",
  ])
    expect(
      parseIntegrations({
        ...overview,
        composio: { ...overview.composio, organization },
      }),
    ).toBeNull();
});

// Pablo's review of #372: the page's reading is a minute old, and the CLI's
// choice may change in between (Settings → Tools, `lazurio tools
// composio-org`); a link or a removal asks the organization live.
const lastIndex = (
  calls: string[][],
  match: (call: string[]) => boolean,
): number => {
  for (let index = calls.length - 1; index >= 0; index -= 1)
    if (match(calls[index] as string[])) return index;
  return -1;
};
// A removal, not the reading's `connections remove --help`.
const removes = (call: string[]) =>
  call[0] === "connections" && call[1] === "remove" && !call.includes("--help");

const switches = (calls: string[][]) =>
  calls
    .filter((call) => call[0] === "orgs" && call[1] === "switch")
    .map((call) => call[3]);

test("a link after the organization was switched away goes to this Environment's organization again", async () => {
  const { world, app, read } = await launchpad(
    {
      organization: "jana_workspace",
      organizations: [
        { id: "org_1", name: "jana_workspace" },
        { id: "org_2", name: "priklad" },
      ],
    },
    { kind: "named", name: "Příklad" },
  );
  expect((await read()).composio.organization?.state).toBe("matches");
  // Another organization chosen behind the cached reading.
  expect(
    await (
      await app.post("/api/tools/composio/organization", { id: "org_1" })
    ).json(),
  ).toMatchObject({ kind: "composio-organization-selected", id: "org_1" });
  const answer = await app.post("/api/integrations/connect", {
    app: "salesforce",
  });
  expect(answer.status).toBe(200);
  expect(await answer.json()).toMatchObject({ kind: "authorize" });
  const calls = await composioCalls(world.home);
  // Back to this Environment's organization before the link, never after.
  expect(switches(calls)).toEqual(["org_2", "org_1", "org_2"]);
  const back = lastIndex(
    calls,
    (call) => call[0] === "orgs" && call[1] === "switch",
  );
  const link = calls.findIndex(
    (call) => call[0] === "link" && call[1] === "salesforce",
  );
  expect(back).toBeLessThan(link);
  expect((await readComposioState(world.home)).organization).toBe("priklad");
});

test("a link or a removal when the organization is gone since the reading happens in the person's current one, as the Operator decided", async () => {
  const { world, app, read } = await launchpad(
    {
      organization: "jana_workspace",
      removeYes: true,
      organizations: [
        { id: "org_1", name: "jana_workspace" },
        { id: "org_2", name: "priklad" },
      ],
    },
    { kind: "named", name: "Příklad" },
  );
  expect((await read()).composio.organization?.state).toBe("matches");
  // The organization is renamed in Composio, and another one is current.
  const state = await readComposioState(world.home);
  await writeComposioState(world.home, {
    ...state,
    organization: "jana_workspace",
    organizations: [
      { id: "org_1", name: "jana_workspace" },
      { id: "org_2", name: "Something else" },
    ],
  });
  const connect = await app.post("/api/integrations/connect", {
    app: "salesforce",
  });
  expect(connect.status).toBe(200);
  expect(await connect.json()).toMatchObject({ kind: "authorize" });
  const removal = await app.post("/api/integrations/disconnect", {
    app: "gmail",
    path: "composio",
    account: "castle",
    confirm: true,
  });
  expect(await removal.json()).toEqual({ kind: "disconnected" });
  // Neither switched anywhere: there is no organization of the name.
  const calls = await composioCalls(world.home);
  expect(switches(calls)).toEqual(["org_2"]);
  expect((await readComposioState(world.home)).organization).toBe(
    "jana_workspace",
  );
  expect((await read()).composio.organization).toEqual({
    name: "Příklad",
    state: "missing",
  });
});

test("a removal after the organization was switched away removes in this Environment's organization", async () => {
  const { world, app, read } = await launchpad(
    {
      organization: "jana_workspace",
      removeYes: true,
      organizations: [
        { id: "org_1", name: "jana_workspace" },
        { id: "org_2", name: "priklad" },
      ],
    },
    { kind: "named", name: "Příklad" },
  );
  expect((await read()).composio.organization?.state).toBe("matches");
  await app.post("/api/tools/composio/organization", { id: "org_1" });
  const removal = await app.post("/api/integrations/disconnect", {
    app: "gmail",
    path: "composio",
    account: "castle",
    confirm: true,
  });
  expect(await removal.json()).toEqual({ kind: "disconnected" });
  const calls = await composioCalls(world.home);
  const back = lastIndex(
    calls,
    (call) => call[0] === "orgs" && call[1] === "switch",
  );
  const remove = calls.findIndex(removes);
  expect(remove).toBeGreaterThan(-1);
  expect(switches(calls).at(-1)).toBe("org_2");
  expect(back).toBeLessThan(remove);
});

test("lazurio integrations list says on stderr that it made the organization current, without its name or id", async () => {
  const directory = await parent();
  const world = await integrationsWorld(directory, {
    composio: {
      accounts: [gmail],
      organization: "jana_workspace",
      organizations: [
        { id: "org_1", name: "jana_workspace" },
        { id: "org_2", name: "priklad" },
      ],
    },
  });
  cleanups.push(() => world.executor.stop());
  // The Organization's Environment's Folder, read by the CLI alone.
  const app = await worldLaunchpad(directory, world, {
    tools: ["composio"],
    handover: {
      preset: "hosted-organization-personal",
      machine: bindings.organization,
      organization: { slug: "example", displayName: "Příklad" },
    },
  });
  await app.close();
  const context = {
    identity: embeddedIdentity(),
    platform: process.platform,
    env: { PATH: world.path, HOME: world.home },
    executable: process.execPath,
    executorEndpoint: world.executorHost(),
    executorPresent: true,
  };
  const first = await runIntegrationsCommand(
    ["list", "--folder", join(directory, "Lazurio")],
    context,
  );
  expect(first.code).toBe(0);
  expect(first.stderr).toBe(
    JSON.stringify({
      scope: "integrations",
      event: "composio-organization",
      outcome: "switched",
    }),
  );
  expect(first.stdout).not.toContain("org_2");
  expect((await readComposioState(world.home)).organization).toBe("priklad");
  // Nothing to switch, nothing said.
  const second = await runIntegrationsCommand(
    ["list", "--json", "--folder", join(directory, "Lazurio")],
    context,
  );
  expect(second.stderr).toBeUndefined();
  expect(JSON.parse(second.stdout ?? "").composio.organization).toEqual({
    name: "Příklad",
    state: "matches",
  });
});
