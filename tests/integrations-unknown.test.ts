import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { presetProfile } from "../src/folder/presets";
import { renderOutputs } from "../src/folder/preview";
import type { IntegrationsCatalog } from "../src/integrations/catalog-schema";
import {
  integrationsText,
  runIntegrationsCommand,
} from "../src/integrations/cli";
import {
  composioOrganizationRule,
  ownerRereadMs,
  ownerRereads,
} from "../src/integrations/composio-organization";
import {
  type IntegrationApp,
  type IntegrationsOverview,
  type MergeInput,
  mergeIntegrations,
  unknownReasons,
} from "../src/integrations/model";
import { readIntegrations } from "../src/integrations/read";
import {
  cardView,
  noneConnectedText,
  offered,
  parseIntegrations,
  tabLabels,
  visibleApps,
} from "../src/launchpad/integrations-view";
import { messages } from "../src/launchpad/messages";
import { readFolderCatalog } from "../src/organizations/catalog";
import { toolsEnvironmentOf } from "../src/tools/overview";
import { runTool } from "../src/tools/status";
import { embeddedIdentity } from "../src/update/identity";
import {
  integrationsWorld,
  readComposioState,
  worldLaunchpad,
} from "./fixtures/integrations-world";
import { bindings } from "./fixtures/machine-bindings";

// Unknown is not "not connected" (decision F42, addendum of 2026-10-27).
// On a client Organization's Environments, `lazurio integrations list`
// answered `"connected": false, "accounts": []` for every Composio app
// whenever this Environment's Composio organization could not be verified,
// though the accounts were there and connected seven minutes later; agents
// told the person "Outlook is not connected" and took another way. Every
// such reading came seconds after an agent had started `lazurio update`,
// which fast-forwards the Organization's root while the rule of the Composio
// organization reads it. So: an app whose connecting source was not read or
// verified says so (`connected: null`, `unknown`), never false; the rule
// reads the Organization again where a write may be in the way; and the
// Folder tells agents what to do with an unknown app. Nothing of an
// unverified Composio is used: only the reporting changes.

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function parent(): Promise<string> {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "lazurio-integrations-unknown-")),
  );
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

const en = messages("en");
const cs = messages("cs");

// A small catalog: Outlook through Composio or the company app, Notion
// directly or through Composio, WhatsApp only by its tool, Gmail with
// gogcli on a personal Environment.
const app = (
  id: string,
  extra: Partial<IntegrationsCatalog["apps"][number]> = {},
): IntegrationsCatalog["apps"][number] => ({
  id,
  name: { cs: id, en: id },
  description: { cs: "Popis.", en: "About." },
  category: "other",
  composio: id,
  verified: "2026-10-27",
  ...extra,
});

const catalog: IntegrationsCatalog = {
  schema: "lazurio.integrations-catalog.v1",
  version: 1,
  generated: "2026-10-27",
  apps: [
    app("outlook", {
      direct: {
        integration: "microsoft-outlook",
        kind: "openapi",
        auth: "company-app:microsoft",
        verified: "2026-10-27",
      },
    }),
    app("notion", {
      direct: {
        integration: "notion-com",
        kind: "mcp",
        endpoint: "https://mcp.notion.example/mcp",
        auth: "dcr",
        verified: "2026-10-27",
      },
    }),
    app("gmail", { tool: "gogcli" }),
    {
      id: "whatsapp",
      name: { cs: "WhatsApp", en: "WhatsApp" },
      description: { cs: "Zprávy.", en: "Messages." },
      category: "chat",
      tool: "wacli",
      verified: "2026-10-27",
    },
  ],
};

const base: MergeInput = {
  catalog,
  locale: "en",
  scope: "organization",
  origin: null,
  policy: { allowed: true, source: "environment" },
  composioReady: true,
  composioOrganization: null,
  tools: { state: "ok", connected: [] },
  executor: { state: "ok", integrations: [], connections: [] },
  composio: { state: "ok", accounts: [] },
  readAt: "2026-10-27T10:31:47.000Z",
};

const outlookAccount = {
  toolkit: "outlook",
  state: "connected",
  alias: null,
  wordId: "lantern",
} as const;

const apps = (input: Partial<MergeInput>) =>
  Object.fromEntries(
    mergeIntegrations({ ...base, ...input }).apps.map((item) => [
      item.id,
      { connected: item.connected, unknown: item.unknown },
    ]),
  );

test("the reading of 10:38: a Composio that was read says connected, and an account truly absent says false", () => {
  expect(
    apps({ composio: { state: "ok", accounts: [outlookAccount] } }),
  ).toEqual({
    outlook: { connected: true, unknown: undefined },
    notion: { connected: false, unknown: undefined },
    gmail: { connected: false, unknown: undefined },
    whatsapp: { connected: false, unknown: undefined },
  });
});

test("the reading of 10:31: Composio's organization not verified leaves every app it could connect unknown, never false", () => {
  const unverified = {
    composio: { state: "organization" },
    composioTarget: { name: null, state: "unverified" },
  } as const;
  const overview = mergeIntegrations({ ...base, ...unverified });
  // Nothing of an unverified Composio is used: no account is listed.
  expect(overview.sources.composio).toBe("organization");
  expect(overview.apps.every((item) => item.accounts.length === 0)).toBe(true);
  expect(apps(unverified)).toEqual({
    outlook: { connected: null, unknown: "composio-unverified" },
    // An older Composio account would be Notion's way too.
    notion: { connected: null, unknown: "composio-unverified" },
    gmail: { connected: null, unknown: "composio-unverified" },
    // Only its tool connects WhatsApp, and the tools were read.
    whatsapp: { connected: false, unknown: undefined },
  });
  // Not made current: the same, by its own reason.
  expect(
    apps({
      composio: { state: "organization" },
      composioTarget: { name: "Example", state: "elsewhere" },
    }).outlook,
  ).toEqual({ connected: null, unknown: "composio-elsewhere" });
  expect(apps({ composio: { state: "unreadable" } }).outlook).toEqual({
    connected: null,
    unknown: "composio-unreadable",
  });
});

test("a connected app stays connected whatever another source says", () => {
  const value = apps({
    tools: { state: "ok", connected: ["wacli"] },
    executor: { state: "unavailable" },
    composio: { state: "organization" },
    composioTarget: { name: null, state: "unverified" },
  });
  expect(value.whatsapp).toEqual({ connected: true, unknown: undefined });
  // A working direct account on Notion's path: connected, Executor read.
  expect(
    apps({
      executor: {
        state: "ok",
        integrations: [
          {
            slug: "notion-com",
            name: "Notion",
            kind: "remote",
            target: "https://mcp.notion.example/mcp",
            tools: null,
          },
        ],
        connections: [
          {
            id: "org/notion-com/default",
            integration: "notion-com",
            label: null,
            state: "connected",
          },
        ],
      },
      composio: { state: "organization" },
      composioTarget: { name: null, state: "unverified" },
    }).notion,
  ).toEqual({ connected: true, unknown: undefined });
});

test("Executor or the tools not read: the apps they could connect are unknown, by the agents' order", () => {
  expect(apps({ executor: { state: "unavailable" } })).toMatchObject({
    notion: { connected: null, unknown: "executor-unavailable" },
    // No company app: Executor cannot connect Outlook here.
    outlook: { connected: false },
  });
  expect(apps({ executor: { state: "unreadable" } }).notion).toEqual({
    connected: null,
    unknown: "executor-unreadable",
  });
  // The tools first: WhatsApp's tool may be signed in.
  expect(apps({ tools: { state: "unreadable" } })).toMatchObject({
    whatsapp: { connected: null, unknown: "tools-unreadable" },
    // gogcli does not count on an Organization's Environment.
    gmail: { connected: false },
  });
  expect(
    apps({ scope: "personal", tools: { state: "unreadable" } }).gmail,
  ).toEqual({ connected: null, unknown: "tools-unreadable" });
});

test("a state of this Environment that settles it is no unknown: Executor absent, Composio not installed, signed out, off or not allowed", () => {
  for (const input of [
    { executor: { state: "absent" } },
    { composio: { state: "unavailable" }, composioReady: false },
    { composio: { state: "signed-out" }, composioReady: false },
    { composio: { state: "off" }, composioReady: false },
    {
      policy: { allowed: false, source: "organization" },
      composio: { state: "organization" },
      composioTarget: { name: null, state: "unverified" },
    },
  ] as const)
    for (const [id, value] of Object.entries(apps(input)))
      expect([id, value]).toEqual([
        id,
        { connected: false, unknown: undefined },
      ]);
  // An expired account on its path, its source read: not connected.
  expect(
    apps({
      composio: {
        state: "ok",
        accounts: [{ ...outlookAccount, state: "expired" }],
      },
    }).outlook,
  ).toEqual({ connected: false, unknown: undefined });
});

test("lazurio integrations list in text: unknown apps by their reason, never under Connected: none", () => {
  const overview = mergeIntegrations({
    ...base,
    composio: { state: "organization" },
    composioTarget: { name: null, state: "unverified" },
  });
  const text = integrationsText(overview);
  expect(text).toContain("Connected: none that could be verified now.");
  expect(text).not.toContain("Connected: none.");
  expect(text).toContain(
    "  3 apps: this Environment's Composio organization could not be verified (composio-unverified)",
  );
  expect(text).toContain("never tell the user these are not connected");
  expect(text).not.toContain("Not working");
  // Everything read: nothing said about it.
  const read = integrationsText(
    mergeIntegrations({
      ...base,
      composio: { state: "ok", accounts: [outlookAccount] },
    }),
  );
  expect(read).toContain("Connected:\n  outlook (outlook) — through Composio");
  expect(read).not.toContain("Not verified");
});

const card = (
  item: IntegrationApp,
  locale: "cs" | "en" = "en",
): ReturnType<typeof cardView> =>
  cardView(
    item,
    catalog.apps.find((entry) => entry.id === item.id),
    {
      locale,
      scope: "organization",
      admin: false,
      dashboard: false,
      copy: locale === "cs" ? cs : en,
    },
  );

test("the page: an unknown card says it cannot be verified now, keeps its action, and Připojené never says none is connected", () => {
  const overview = mergeIntegrations({
    ...base,
    composio: { state: "organization" },
    composioTarget: { name: null, state: "unverified" },
  });
  // The route's answer as the page takes it.
  const page = parseIntegrations(JSON.parse(JSON.stringify(overview)));
  expect(page).toEqual(overview);
  if (page === null) throw new Error("the page refused the reading");
  const outlook = page.apps.find((item) => item.id === "outlook");
  if (outlook === undefined) throw new Error("Outlook listed");
  expect(card(outlook)).toEqual({
    line: "About.",
    connected: null,
    pathLabel: null,
    action: { kind: "connect", label: "Connect", path: "composio" },
    composio: true,
  });
  expect(en.integrationsUnknown).toBe("Can't verify right now");
  expect(cs.integrationsUnknown).toBe("Nelze teď ověřit");
  // Not counted as connected, offered where its path is, and Připojené
  // says the connections cannot be verified instead of "none".
  expect(tabLabels(page, en).connected).toBe("Connected");
  expect(offered(outlook)).toBe(true);
  expect(visibleApps(page, catalog.apps, "connected", "")).toEqual([]);
  expect(noneConnectedText(page, cs)).toBe(
    "Připojené aplikace teď nelze ověřit.",
  );
  expect(
    noneConnectedText(
      mergeIntegrations({ ...base, composio: { state: "ok", accounts: [] } }),
      cs,
    ),
  ).toBe("Zatím žádné připojené aplikace.");
});

test("the page refuses an unknown without its reason, a reason it does not know, or a reason beside a known state", () => {
  const overview = mergeIntegrations({ ...base });
  const notion = overview.apps.find((item) => item.id === "notion");
  if (notion === undefined) throw new Error("Notion listed");
  const with_ = (value: Record<string, unknown>) =>
    parseIntegrations(
      JSON.parse(
        JSON.stringify({ ...overview, apps: [{ ...notion, ...value }] }),
      ),
    );
  for (const reason of unknownReasons)
    expect(with_({ connected: null, unknown: reason })).not.toBeNull();
  expect(with_({ connected: null })).toBeNull();
  expect(with_({ connected: null, unknown: "composio-later" })).toBeNull();
  expect(
    with_({ connected: false, unknown: "composio-unverified" }),
  ).toBeNull();
  expect(with_({ connected: "unknown" })).toBeNull();
});

test("the Folder tells agents that an unknown app is not a disconnected one, in both languages", () => {
  for (const [locale, rule, manual] of [
    [
      "cs",
      '`"connected": null` u aplikace znamená, že se její stav teď nepodařilo ověřit (proč, říká `unknown`), ne že připojená není: nikdy to tak uživateli neříkej',
      "**Neověřeno neznamená nepřipojeno.**",
    ],
    [
      "en",
      '`"connected": null` on an app means its state could not be verified now (`unknown` says why), not that it is not connected: never tell the user so',
      "**Not verified does not mean not connected.**",
    ],
  ] as const) {
    const outputs = renderOutputs({
      preset: "hosted-organization-personal",
      machine: bindings.organizationEntry,
      profile: presetProfile("hosted-organization-personal", "linux", {
        locale,
      }),
      tools: [],
      toolNotes: {},
    });
    expect(outputs["AGENTS.md"]).toContain(rule);
    expect(outputs["manual/working-here.md"]).toContain(manual);
    // Retry, or try the operation through its path; a concrete failure
    // only; never Composio with an unverified organization.
    for (const text of [
      outputs["AGENTS.md"],
      outputs["manual/working-here.md"],
    ])
      expect(text).toContain("`composio-unverified`, `composio-elsewhere`");
  }
});

// The race (decision F42, addendum of 2026-10-27): a reading of the
// Folder's Organizations while `lazurio update` fast-forwards the owner's
// root is read again, so the account stays connected; where it never
// settles, the apps are unknown, never false.

const gmail = {
  id: "ca_1",
  toolkit: "gmail",
  status: "ACTIVE",
  alias: null,
  word_id: "castle",
};

/** An Organization's Environment whose Folder holds its root "Příklad",
 * with a Gmail account connected through Composio in the person's
 * organization of that name. */
async function organizationWorld() {
  const directory = await parent();
  const world = await integrationsWorld(directory, {
    composio: {
      accounts: [gmail],
      organization: "priklad",
      organizations: [
        { id: "org_1", name: "jana_workspace" },
        { id: "org_2", name: "priklad" },
      ],
    },
  });
  cleanups.push(() => world.executor.stop());
  const launchpad = await worldLaunchpad(directory, world, {
    tools: ["composio"],
    handover: {
      preset: "hosted-organization-personal",
      machine: bindings.organization,
      organization: { slug: "example", displayName: "Příklad" },
    },
  });
  await launchpad.close();
  const folder = join(directory, "Lazurio");
  const read = (
    organizationReading: Parameters<
      typeof readIntegrations
    >[0]["organizationReading"],
  ) =>
    readIntegrations({
      folder,
      tools: toolsEnvironmentOf(
        { PATH: world.path, HOME: world.home },
        process.platform,
        runTool,
      ),
      executor: world.executorHost(),
      executorPresent: true,
      ...(organizationReading === undefined ? {} : { organizationReading }),
    });
  return { world, folder, read };
}

const gmailOf = (overview: IntegrationsOverview) =>
  overview.apps.find((item) => item.id === "gmail");

test("a reading during lazurio update's write is read again, and the connected account stays connected", async () => {
  const { folder, read } = await organizationWorld();
  // The catalog's reader throws once, as in the middle of a fast-forward.
  let reads = 0;
  const waits: number[] = [];
  const overview = await read({
    readCatalog: async (path) => {
      reads += 1;
      if (reads === 1) throw new Error("ENOENT during the write");
      return readFolderCatalog(path);
    },
    wait: async (ms) => {
      waits.push(ms);
    },
  });
  expect(waits).toEqual([ownerRereadMs]);
  expect(overview.composio.organization).toEqual({
    name: "Příklad",
    state: "matches",
  });
  expect(gmailOf(overview)).toMatchObject({
    connected: true,
    accounts: [{ path: "composio", state: "connected" }],
  });
  expect(gmailOf(overview)?.unknown).toBeUndefined();

  // The owner's manifest half written when the reading starts, whole again
  // when the wait ends: the real reader isolates the root, the rule reads
  // it again.
  const manifest = join(
    folder,
    "organizations",
    "example",
    "lazurio.organization.json",
  );
  const whole = await readFile(manifest, "utf8");
  await writeFile(manifest, whole.slice(0, whole.length / 2));
  const midWrite = await read({
    wait: async () => {
      await writeFile(manifest, whole);
    },
  });
  expect(gmailOf(midWrite)?.connected).toBe(true);
});

test("a reading that never settles: the account is unknown, never not connected, and nothing is switched", async () => {
  const { world, read } = await organizationWorld();
  await (async () => {
    const state = await readComposioState(world.home);
    expect(state.organization).toBe("priklad");
  })();
  const waits: number[] = [];
  const overview = await read({
    readCatalog: async () => {
      throw new Error("still being written");
    },
    wait: async (ms) => {
      waits.push(ms);
    },
  });
  expect(waits).toEqual(
    Array.from({ length: ownerRereads }, () => ownerRereadMs),
  );
  expect(overview.sources.composio).toBe("organization");
  expect(overview.composio.organization).toEqual({
    name: null,
    state: "unverified",
  });
  expect(gmailOf(overview)).toMatchObject({
    connected: null,
    unknown: "composio-unverified",
    accounts: [],
  });
  expect((await readComposioState(world.home)).organization).toBe("priklad");
});

test("an Organization that is not in the Folder is unverified at once: nothing to wait for", async () => {
  const folder = await parent();
  const waits: number[] = [];
  expect(
    await composioOrganizationRule(folder, bindings.organization, {
      wait: async (ms) => {
        waits.push(ms);
      },
    }),
  ).toEqual({ kind: "unverified" });
  expect(waits).toEqual([]);
});

test("lazurio integrations list --json: an unverified Composio says connected null with its reason, and the text names it", async () => {
  const { world, folder } = await organizationWorld();
  const context = {
    identity: embeddedIdentity(),
    platform: process.platform,
    env: { PATH: world.path, HOME: world.home },
    executable: process.execPath,
    executorEndpoint: world.executorHost(),
    executorPresent: true,
  };
  const list = (json: boolean) =>
    runIntegrationsCommand(
      ["list", ...(json ? ["--json"] : []), "--folder", folder],
      context,
    );
  const before = JSON.parse(
    (await list(true)).stdout ?? "",
  ) as IntegrationsOverview;
  expect(gmailOf(before)?.connected).toBe(true);
  // The Organization's root gone for good: unverified after no wait.
  await rm(join(folder, "organizations", "example"), {
    recursive: true,
    force: true,
  });
  const after = await list(true);
  expect(after.code).toBe(0);
  const overview = JSON.parse(after.stdout ?? "") as IntegrationsOverview;
  expect(overview.sources.composio).toBe("organization");
  expect(gmailOf(overview)).toMatchObject({
    connected: null,
    unknown: "composio-unverified",
  });
  expect(
    overview.apps.filter(
      (item) => item.connected === false && item.path.path === "composio",
    ),
  ).toEqual([]);
  // gh still connects GitHub; the Composio apps are named as not verified.
  const text = (await list(false)).stdout ?? "";
  expect(text).toContain("Connected:\n  GitHub (github) — through gh");
  expect(text).toMatch(
    /Not verified now[^\n]*\n {2}\d+ apps: this Environment's Composio organization could not be verified \(composio-unverified\)/,
  );
});
