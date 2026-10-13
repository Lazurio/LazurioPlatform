import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { integrationsText } from "../src/integrations/cli";
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
import { writeOrganization } from "./fixtures/catalog-folder";
import {
  captureConsole,
  composioCalls,
  type FakeComposioState,
  integrationsWorld,
  readComposioState,
  worldLaunchpad,
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

test("the rule: an Organization's Environment by its Organization's name, anything else chosen", async () => {
  const folder = join(await parent(), "Lazurio");
  await mkdir(folder, { recursive: true, mode: 0o700 });
  // No Organization of that slug in the Folder: chosen, never a guess.
  expect(await composioOrganizationRule(folder, bindings.organization)).toEqual(
    { kind: "chosen" },
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

const gmail = {
  id: "ca_1",
  toolkit: "gmail",
  status: "ACTIVE",
  alias: null,
  word_id: "castle",
};

async function launchpad(
  composio: Partial<FakeComposioState>,
  rule: { kind: "named"; name: string } | null,
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

test("an account without the organization: nothing of Composio counts, connecting through it is refused, and the page and agents say why", async () => {
  const { world, app, read } = await launchpad(
    {
      organization: "jana_workspace",
      organizations: [{ id: "org_1", name: "jana_workspace" }],
    },
    { kind: "named", name: "Příklad" },
  );
  const overview = await read();
  expect(overview.sources.composio).toBe("organization");
  expect(overview.composio.organization).toEqual({
    name: "Příklad",
    state: "missing",
  });
  // The accounts of another organization are not this Environment's.
  const card = overview.apps.find((item) => item.id === "gmail");
  expect(card?.accounts).toEqual([]);
  expect(card?.connected).toBe(false);
  const salesforce = overview.apps.find((item) => item.id === "salesforce");
  expect(salesforce?.path).toEqual({ path: "composio", signIn: false });
  const refused = await app.post("/api/integrations/connect", {
    app: "salesforce",
  });
  expect(refused.status).toBe(409);
  expect(await refused.json()).toEqual({
    kind: "blocked",
    reason: "composio-organization",
  });
  // Nothing was switched or linked.
  const calls = await composioCalls(world.home);
  expect(calls.some((call) => call[0] === "link")).toBe(false);
  expect(calls.some((call) => call[0] === "orgs" && call[1] === "switch")).toBe(
    false,
  );
  expect(integrationsText(overview)).toContain(
    'Composio: the person\'s account has no organization named "Příklad"',
  );
});

test("more than one organization of the name: none is guessed", async () => {
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
  expect(overview.sources.composio).toBe("organization");
  expect(overview.composio.organization).toEqual({
    name: "Příklad",
    state: "ambiguous",
  });
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
    expect(reading.sources.composio).toBe(
      state === "matches" ? "ok" : "organization",
    );
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
  expect(
    composioOrganizationLine(overview("missing", "organization"), copy),
  ).toBe(
    "Ve vašem účtu Composia chybí organizace „Human and Machine“. Tento Environment patří Organizaci Human and Machine, a tak se přes Composio připojuje jen ve vaší vlastní organizaci stejného jména. Založte ji v Composiu a klikněte na Zkontrolovat připojení.",
  );
  expect(
    composioOrganizationLine(overview("ambiguous", "organization"), copy),
  ).toContain("víc organizací se jménem „Human and Machine“");
  expect(
    composioOrganizationLine(overview("elsewhere", "organization"), copy),
  ).toContain("nepodařilo přepnout");
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
