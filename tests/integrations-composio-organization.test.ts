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
} from "../src/integrations/composio-organization";
import {
  composioOrganizationName,
  organizationKey,
} from "../src/integrations/composio-organization-name";
import type { IntegrationsOverview } from "../src/integrations/model";
import {
  composioOrganizationLine,
  disconnectFailure,
  parseIntegrations,
  refusalNote,
} from "../src/launchpad/integrations-view";
import { messages } from "../src/launchpad/messages";
import {
  type ComposioDialogView,
  composioConnectedLine,
  composioDialogView,
  organizationRule,
} from "../src/launchpad/tools-view";
import { readFolderCatalog } from "../src/organizations/catalog";
import { selectOwnerOrganization } from "../src/organizations/catalog-selection";
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
// of its Organization's name, matched by its letters and digits alone (note
// of 2026-10-17: Composio allows only letters, digits and underscores, so the
// person creates "LazurioExampleOrganization"), made current by the
// Launchpad; where the account has none, or more than one, nothing of
// Composio counts and nothing connects through it. A personal Environment
// and a computer work in the one the person chose.

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

test("a name is one whatever its case, diacritics, spaces, punctuation and underscores", () => {
  expect(organizationKey("Human and Machine")).toBe("humanandmachine");
  expect(organizationKey(" Příklad  ")).toBe(organizationKey("PRIKLAD"));
  for (const name of ["Rozjedeme.ai", "rozjedeme_ai", "RozjedemeAi"])
    expect(organizationKey(name)).toBe("rozjedemeai");
  // Only letters and digits count, and every one of them does.
  expect(organizationKey("Příklad s.r.o.")).toBe("prikladsro");
  expect(organizationKey("Příklad s.r.o.")).not.toBe(
    organizationKey("Příklad"),
  );
  expect(organizationKey("Studio 2")).not.toBe(organizationKey("Studio"));
});

// Composio's create screen (the Organization Admin's screenshot of
// 2026-10-17): "Must start with a letter. Only letters, numbers, and
// underscores allowed."
test("the name the person creates in Composio: the Organization's words in CamelCase, only letters and digits, starting with a letter", () => {
  for (const [display, composio] of [
    ["Lazurio Example Organization", "LazurioExampleOrganization"],
    ["Human and Machine", "HumanAndMachine"],
    ["Rozjedeme.ai", "RozjedemeAi"],
    ["Šťastná Firma", "StastnaFirma"],
    ["Příklad s.r.o.", "PrikladSRO"],
    ["lazurio_example_organization", "LazurioExampleOrganization"],
    ["LazurioExampleOrganization", "LazurioExampleOrganization"],
    ["Spectoda", "Spectoda"],
    ["iOS Studio", "IOSStudio"],
    ["3M Česko", "Org3MCesko"],
    ["  Acme -- Corp!  ", "AcmeCorp"],
  ] as const) {
    expect(composioOrganizationName(display)).toBe(composio);
    expect(composio).toMatch(/^[A-Za-z][A-Za-z0-9_]*$/);
  }
  // Nothing of the name left: no name.
  for (const display of ["", "   ", "!!!", "Пример"])
    expect(composioOrganizationName(display)).toBeNull();
});

test("every name Composio allows for the Organization matches it, the one the dialog asks for included", () => {
  const verdict = (display: string, name: string, current = true) =>
    composioOrganizationVerdict({ kind: "named", name: display }, [
      { id: "org_1", name: "jana_workspace", current: !current },
      { id: "org_2", name, current },
    ]).kind;
  for (const name of [
    "LazurioExampleOrganization",
    "lazurio_example_organization",
    "lazurioexampleorganization",
  ]) {
    expect(verdict("Lazurio Example Organization", name)).toBe("matches");
    expect(verdict("Lazurio Example Organization", name, false)).toBe(
      "elsewhere",
    );
  }
  // The real organizations keep matching.
  for (const [display, name] of [
    ["Human and Machine", "humanandmachine"],
    ["Spectoda", "spectoda"],
    ["Lumbio", "lumbio"],
  ] as const)
    expect(verdict(display, name)).toBe("matches");
  // Each Organization's own Composio name matches it.
  for (const display of [
    "Lazurio Example Organization",
    "Šťastná Firma",
    "Příklad s.r.o.",
    "Rozjedeme.ai",
    "3M Česko",
  ]) {
    expect(verdict(display, composioOrganizationName(display) ?? "")).toBe(
      "matches",
    );
    // Composio stores the name it was given in lower case (its create form,
    // 2026-10-19: "Will be created as lazurioexampleorganization").
    expect(
      verdict(display, (composioOrganizationName(display) ?? "").toLowerCase()),
    ).toBe("matches");
  }
  expect(verdict("Lazurio Example Organization", "LazurioExample")).toBe(
    "missing",
  );
  // A name Composio had to start with "Org" matches in both forms; the two
  // together are two of the name.
  expect(verdict("3M Česko", "Org3MCesko")).toBe("matches");
  expect(verdict("3M Česko", "3m_cesko")).toBe("matches");
  expect(
    composioOrganizationVerdict({ kind: "named", name: "3M Česko" }, [
      { id: "org_1", name: "Org3MCesko", current: true },
      { id: "org_2", name: "3mcesko", current: false },
    ]).kind,
  ).toBe("ambiguous");
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
// settings select (F45, `selectOwnerOrganization`): by the GitHub login its
// manifest binds whatever the case, by its slug only where it binds none, else
// by its directory; both read the one owner rule (Pablo's review of #398), so
// a login-only owner (slug `Example`, login `ExampleCo`) names the same
// Organization in both, another Organization's slug never takes the owner
// (Pablo's review of #457), and two candidates select nothing.
test("the rule takes the owning Organization that Organization settings select (F45), whatever the case", async () => {
  const owner = bindings.organization.owner;
  if (owner.kind !== "organization") throw new Error("organization binding");
  const agree = async (folder: string) => {
    const selection = selectOwnerOrganization(
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

  // Only the GitHub login answers the owner: F45 and Composio both select
  // the Organization by it and agree on its name.
  const byLogin = join(await parent(), "Lazurio");
  await mkdir(byLogin, { recursive: true, mode: 0o700 });
  await writeOrganization(byLogin, "Corp", {
    slug: "ExampleCorp",
    forge: "Example",
    state: "current",
    modules: [],
    displayName: "Example Corp",
  });
  expect(await agree(byLogin)).toEqual({
    kind: "named",
    name: "Example Corp",
  });

  // The owner's login is another Organization's slug (Pablo's review of
  // #457): the Organization bound to the login owns the Machine; the one
  // whose slug it is binds another login and is never taken for it.
  const slugOfAnother = join(await parent(), "Lazurio");
  await mkdir(slugOfAnother, { recursive: true, mode: 0o700 });
  await writeOrganization(slugOfAnother, "Alpha_GEN3", {
    slug: "Alpha",
    forge: "Example",
    state: "current",
    modules: [],
    displayName: "Alpha Org",
  });
  await writeOrganization(slugOfAnother, "Example_GEN3", {
    slug: "Example",
    forge: "OtherLogin",
    state: "current",
    modules: [],
    displayName: "Other Org",
  });
  expect(await agree(slugOfAnother)).toEqual({
    kind: "named",
    name: "Alpha Org",
  });

  // Two manifests binding the same login select nothing: neither is guessed.
  const twinLogins = join(await parent(), "Lazurio");
  await mkdir(twinLogins, { recursive: true, mode: 0o700 });
  for (const directory of ["CorpA", "CorpB"] as const)
    await writeOrganization(twinLogins, directory, {
      slug: `${directory}Slug`,
      forge: "Example",
      state: "current",
      modules: [],
      displayName: directory,
    });
  expect(await agree(twinLogins)).toEqual({ kind: "unverified" });

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
    'Composio: the user\'s account has no organization named "Priklad" (this Environment\'s Organization "Příklad", named as Composio accepts it), so Composio works in their current organization meanwhile.',
  );
  // Agents learn where the person connects an app the catalog does not list.
  expect(integrationsText(overview)).toContain(
    "An app the catalog does not list is connected by the user in Composio (https://dashboard.composio.dev/jana_workspace/~/connect/apps); it then shows here.",
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
    "connected by the user in Composio",
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

// The sign-in dialog after the sign-in (decision F42, addendum (2) of
// 2026-10-13, note of 2026-10-17): the person signed in while Composio's CLI
// had "First" selected. The dialog asks to create the organization, finds it
// by itself on a later reading once the person created it, and then names
// the account with the organization current after the reading switched,
// never the one the sign-in named.
test("the sign-in dialog asks to create a missing organization, finds it on a later reading, and names the one current after the switch", async () => {
  const directory = await parent();
  const world = await integrationsWorld(directory, {
    composio: {
      accounts: [gmail],
      organization: "First",
      organizations: [{ id: "org_1", name: "First" }],
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
  const copy = messages("cs");
  const read = async () =>
    composioDialogView(
      await (await app.post("/api/tools/composio/organizations", {})).json(),
      "op@example.com",
      copy,
    );
  // The name Composio accepts, the one the person types there.
  expect(await read()).toEqual({ kind: "create", name: "Priklad" });
  // Nothing switched while it is missing: the person's current one works.
  expect((await readComposioState(world.home)).organization).toBe("First");
  // The person creates it in Composio's dashboard.
  const state = await readComposioState(world.home);
  await writeComposioState(world.home, {
    ...state,
    organizations: [
      ...(state.organizations ?? []),
      { id: "org_2", name: "priklad" },
    ],
  });
  const connected = await read();
  expect(connected).toEqual({
    kind: "connected",
    account: "op@example.com",
    organization: "priklad",
    choices: null,
  });
  if (connected.kind !== "connected") throw new Error("not connected");
  expect(composioConnectedLine(connected)).toBe("op@example.com · priklad");
  expect((await readComposioState(world.home)).organization).toBe("priklad");
});

// The end-to-end test of 2026-10-19: the dialog said "Composio je
// připojené", and "Vybrat aplikace" opened Apps → Integrace, which still
// said the organization was missing. The reading the Launchpad keeps for a
// minute was the one made while it was missing; the dialog's reading that
// found the organization must not leave it behind.
test("the dialog finding the organization leaves no stale reading behind: Integrace says it without a refresh", async () => {
  const directory = await parent();
  const world = await integrationsWorld(directory, {
    composio: {
      accounts: [gmail],
      organization: "First",
      organizations: [{ id: "org_1", name: "First" }],
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
  // The page's reading, as Apps → Integrace makes it without a refresh.
  const reading = async () =>
    (
      (await (
        await app.get("/api/integrations")
      ).json()) as IntegrationsOverview
    ).composio.organization;
  expect(await reading()).toEqual({ name: "Příklad", state: "missing" });
  // The person creates it in Composio's dashboard, and the dialog finds it.
  const state = await readComposioState(world.home);
  await writeComposioState(world.home, {
    ...state,
    organizations: [
      ...(state.organizations ?? []),
      { id: "org_2", name: "priklad" },
    ],
  });
  expect(
    await (await app.post("/api/tools/composio/organizations", {})).json(),
  ).toMatchObject({ organization: { name: "Příklad", state: "matches" } });
  expect(await reading()).toEqual({ name: "Příklad", state: "matches" });
});

test("the sign-in dialog says in one sentence when its organization is there twice or cannot be made current", async () => {
  const copy = messages("cs");
  const cases: [Partial<FakeComposioState>, ComposioDialogView][] = [
    [
      {
        organization: "First",
        organizations: [
          { id: "org_1", name: "First" },
          { id: "org_2", name: "priklad" },
          { id: "org_3", name: "Příklad" },
        ],
      },
      { kind: "rename", name: "Priklad" },
    ],
    [
      {
        organization: "First",
        switchFails: true,
        organizations: [
          { id: "org_1", name: "First" },
          { id: "org_2", name: "priklad" },
        ],
      },
      {
        kind: "problem",
        message:
          "Composio se nepodařilo přepnout do vaší organizace „Priklad“.",
      },
    ],
  ];
  for (const [composio, view] of cases) {
    const directory = await parent();
    const world = await integrationsWorld(directory, {
      composio: { accounts: [gmail], ...composio },
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
    expect(
      composioDialogView(
        await (await app.post("/api/tools/composio/organizations", {})).json(),
        "op@example.com",
        copy,
      ),
    ).toEqual(view);
  }
});

test("a personal Environment's sign-in dialog leaves the choice to the person", async () => {
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
  // The dialog: connected in the current one, with the choice of the two.
  expect(composioDialogView(answer, "op@example.com", messages("en"))).toEqual({
    kind: "connected",
    account: "op@example.com",
    organization: "First",
    choices: [
      { id: "org_1", label: "First", current: true },
      { id: "org_2", label: "Second", current: false },
    ],
  });
  expect((await readComposioState(world.home)).organization).toBe("First");
  // The person chooses the other one: Integrace's links lead there at once,
  // not after the reading the Launchpad keeps for a minute.
  const apps = async () =>
    (
      (await (
        await app.get("/api/integrations")
      ).json()) as IntegrationsOverview
    ).composio.apps;
  expect(await apps()).toBe(
    "https://dashboard.composio.dev/First/~/connect/apps",
  );
  expect(
    await (
      await app.post("/api/tools/composio/organization", { id: "org_2" })
    ).json(),
  ).toMatchObject({ kind: "composio-organization-selected" });
  expect(await apps()).toBe(
    "https://dashboard.composio.dev/Second/~/connect/apps",
  );
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
    "Ve vašem účtu Composia chybí organizace „HumanAndMachine“. Toto Prostředí patří Organizaci Human and Machine a má se přes Composio připojovat ve vaší vlastní organizaci tohoto jména; dokud ji nezaložíte, připojuje se v organizaci, kterou máte vybranou. Založte ji v Composiu. Až ji založíte, Lazurio bude pokračovat samo.",
  );
  expect(composioOrganizationLine(overview("ambiguous", "ok"), copy)).toContain(
    "víc organizací se jménem „HumanAndMachine“. Dokud nezůstane jen jedna",
  );
  expect(
    composioOrganizationLine(overview("elsewhere", "organization"), copy),
  ).toContain("nepodařilo přepnout do vaší organizace „HumanAndMachine“");
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

test("in a Team Environment the page names the Team's Composio account, elsewhere the person's own (decision F42, note of 2026-10-19)", () => {
  const overview = (state: "missing" | "ambiguous" | "elsewhere") =>
    ({
      sources: { tools: "ok", executor: "ok", composio: "ok" },
      composio: {
        allowed: true,
        source: "organization",
        ready: true,
        disconnect: false,
        organization: { name: "Lazurio Example Organization", state },
      },
    }) as unknown as IntegrationsOverview;
  const cs = messages("cs", "team");
  const en = messages("en", "team");
  expect(composioOrganizationLine(overview("missing"), cs, true)).toBe(
    "V týmovém účtu Composia chybí organizace „LazurioExampleOrganization“. Toto Týmové Prostředí patří Organizaci Lazurio Example Organization a má se přes Composio připojovat v organizaci tohoto jména v týmovém účtu; dokud ji nezaložíte, připojuje se v organizaci, kterou má účet vybranou. Založte ji v Composiu. Až ji založíte, Lazurio bude pokračovat samo.",
  );
  expect(composioOrganizationLine(overview("missing"), en, true)).toBe(
    "The Team's Composio account has no organization named “LazurioExampleOrganization”. This Team Environment belongs to the Organization Lazurio Example Organization and should connect through Composio in the Team account's organization of that name; until you create it, it connects in the organization the account has selected. Create it in Composio. Once it exists, Lazurio continues on its own.",
  );
  expect(composioOrganizationLine(overview("ambiguous"), cs, true)).toBe(
    "V týmovém účtu Composia je víc organizací se jménem „LazurioExampleOrganization“. Dokud nezůstane jen jedna, připojuje se toto Týmové Prostředí v organizaci, kterou má účet vybranou. Tu navíc v Composiu přejmenujte. Až ji přejmenujete, Lazurio bude pokračovat samo.",
  );
  expect(composioOrganizationLine(overview("ambiguous"), en, true)).toBe(
    "The Team's Composio account has more than one organization named “LazurioExampleOrganization”. Until only one is left, this Team Environment connects in the organization the account has selected. Rename the extra one in Composio. Once it is renamed, Lazurio continues on its own.",
  );
  // Elsewhere, and where nothing says the Environment is a Team's, the
  // person's own account as before.
  const work = messages("cs", "work");
  for (const team of [false, undefined]) {
    expect(composioOrganizationLine(overview("missing"), work, team)).toBe(
      "Ve vašem účtu Composia chybí organizace „LazurioExampleOrganization“. Toto Pracovní Prostředí patří Organizaci Lazurio Example Organization a má se přes Composio připojovat ve vaší vlastní organizaci tohoto jména; dokud ji nezaložíte, připojuje se v organizaci, kterou máte vybranou. Založte ji v Composiu. Až ji založíte, Lazurio bude pokračovat samo.",
    );
    expect(
      composioOrganizationLine(overview("ambiguous"), work, team),
    ).toStartWith("Ve vašem účtu Composia je víc organizací");
  }
  // A link or a removal refused for the organization says the same.
  expect(
    refusalNote("composio-organization", overview("missing"), cs, true).text,
  ).toStartWith("V týmovém účtu Composia chybí organizace");
  expect(
    refusalNote("composio-organization", overview("missing"), work).text,
  ).toStartWith("Ve vašem účtu Composia chybí organizace");
  expect(
    disconnectFailure(
      { reason: "composio-organization" },
      overview("ambiguous"),
      cs,
      true,
    ),
  ).toStartWith("V týmovém účtu Composia je víc organizací");
  expect(
    disconnectFailure(
      { reason: "composio-organization" },
      overview("ambiguous"),
      work,
    ),
  ).toStartWith("Ve vašem účtu Composia je víc organizací");
  // The line that names the organization the switch failed for is the same
  // in either (the organization of the account signed in here).
  expect(composioOrganizationLine(overview("elsewhere"), cs, true)).toBe(
    composioOrganizationLine(overview("elsewhere"), cs, false),
  );
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
