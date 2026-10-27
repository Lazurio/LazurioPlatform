import { afterEach, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runIntegrationsCommand } from "../src/integrations/cli";
import type { IntegrationsOverview } from "../src/integrations/model";
import { composioBuild } from "../src/tools/composio-build";
import { embeddedIdentity } from "../src/update/identity";
import {
  captureConsole,
  composioCalls,
  filesContaining,
  holdLink,
  holdList,
  type IntegrationsWorld,
  integrationsWorld,
  linkHeld,
  listHeld,
  readComposioState,
  releaseLink,
  releaseList,
  setAccountStatus,
  tokenCanary,
  worldLaunchpad,
  writeComposioState,
} from "./fixtures/integrations-world";

// The Integrace contract of the Launchpad (decision F42): one reading of the
// tools, the Environment's Executor and the person's Composio, each source
// on its own; connecting, polling and disconnecting behind the local
// admission; the Executor token never leaving the call to Executor; a key
// reaching Executor only; a Composio link only for the request that asked.

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup(
  options: Parameters<typeof integrationsWorld>[1] = {},
  launchpad: Parameters<typeof worldLaunchpad>[2] = {},
) {
  const parent = await realpath(
    await mkdtemp(join(tmpdir(), "lazurio-integrations-")),
  );
  cleanups.push(() => rm(parent, { recursive: true, force: true }));
  const world = await integrationsWorld(parent, options);
  cleanups.push(() => world.executor.stop());
  const app = await worldLaunchpad(parent, world, launchpad);
  cleanups.push(() => app.close());
  return { parent, world, app };
}

const notion = {
  slug: "notion-com",
  name: "Notion",
  kind: "mcp" as const,
  transport: "remote" as const,
  endpoint: "https://mcp.notion.com/mcp",
  auth: "oauth2" as const,
  tools: 12,
};
const invoices = {
  slug: "invoices",
  name: "invoices",
  kind: "mcp" as const,
  transport: "remote" as const,
  endpoint: "https://invoices.example.test/mcp?key=queryCanary0000",
  auth: "header" as const,
  tools: 6,
};

async function overview(app: Awaited<ReturnType<typeof setup>>["app"]) {
  const answer = await app.get("/api/integrations?refresh=1");
  expect(answer.status).toBe(200);
  const text = await answer.text();
  return { text, value: JSON.parse(text) as IntegrationsOverview };
}

test("one reading: the catalog with one path per app, tool and Executor and Composio accounts, custom servers; the token never leaves", async () => {
  const console = captureConsole();
  try {
    const { parent, world, app } = await setup(
      {
        composio: {
          accounts: [
            {
              id: "ca_1",
              toolkit: "gmail",
              status: "ACTIVE",
              alias: null,
              word_id: "castle",
            },
            {
              id: "ca_2",
              toolkit: "salesforce",
              status: "EXPIRED",
              alias: null,
              word_id: "river",
            },
            {
              id: "ca_3",
              toolkit: "todoist",
              status: "ACTIVE",
              alias: null,
              word_id: "stone",
            },
            // A toolkit the catalog does not know is listed all the same.
            {
              id: "ca_4",
              toolkit: "wispr_flow",
              status: "ACTIVE",
              alias: null,
              word_id: "meadow",
            },
          ],
        },
        executorSeed: {
          integrations: [notion, invoices],
          connections: [
            {
              owner: "org",
              name: "default",
              integration: "notion-com",
              template: "oauth2",
              identityLabel: "person@example.test",
              health: "healthy",
            },
            {
              owner: "org",
              name: "default",
              integration: "invoices",
              template: "header",
              identityLabel: null,
              health: null,
            },
          ],
        },
      },
      { tools: ["composio"] },
    );
    const { text, value } = await overview(app);
    const app_ = (id: string) => value.apps.find((item) => item.id === id);
    expect(value.sources).toEqual({
      tools: "ok",
      executor: "ok",
      composio: "ok",
    });
    expect(value.composio).toEqual({
      allowed: true,
      source: "environment",
      ready: true,
      // This composio removes an account only after a prompt.
      disconnect: false,
      // It is Composio's own CLI, not the build Lazurio pins, in the
      // standard path: the page offers its update.
      update: true,
      // "Aplikace v Composiu": the Apps of the person's Composio organization.
      apps: "https://dashboard.composio.dev/First/~/connect/apps",
      // A computer's Folder: the person chooses the organization.
      organization: null,
    });
    // gh is signed in: GitHub goes through its tool.
    expect(app_("github")).toMatchObject({
      path: { path: "tool", tool: "gh" },
      connected: true,
    });
    // Notion: one click, connected directly through Executor.
    expect(app_("notion")).toMatchObject({
      path: { path: "direct" },
      connected: true,
      accounts: [
        {
          path: "direct",
          selector: "org/notion-com/default",
          label: "person@example.test",
          state: "connected",
          spare: false,
        },
      ],
      link: null,
    });
    expect(app_("gmail")).toMatchObject({
      path: { path: "composio", signIn: false },
      connected: true,
      accounts: [{ path: "composio", selector: "castle", state: "connected" }],
    });
    // An account whose sign-in expired does not connect the app.
    expect(app_("salesforce")).toMatchObject({
      connected: false,
      accounts: [{ state: "expired" }],
    });
    // Not in the catalog, connected in Composio: listed by its toolkit,
    // named from it (decision F42, addendum of 2026-10-14) and connected.
    expect(app_("wispr_flow")).toMatchObject({
      name: "Wispr Flow",
      catalog: false,
      connected: true,
      path: { path: "composio", signIn: false },
      accounts: [
        {
          path: "composio",
          selector: "meadow",
          state: "connected",
          manage:
            "https://dashboard.composio.dev/First/~/connect/apps/wispr_flow",
        },
      ],
    });
    // Connected in Composio, the catalog's own app.
    expect(app_("todoist")?.accounts).toEqual([
      {
        path: "composio",
        selector: "stone",
        label: null,
        state: "connected",
        spare: false,
        manage: "https://dashboard.composio.dev/First/~/connect/apps/todoist",
      },
    ]);
    // A custom server, its address without the query (it may carry a key).
    expect(value.custom).toEqual([
      {
        id: "invoices",
        name: "invoices",
        kind: "remote",
        target: "https://invoices.example.test/mcp",
        state: "connected",
        tools: 6,
      },
    ]);
    expect(value.page).toBeNull();
    // Executor saw the token on every call; nothing else ever does.
    expect(world.executor.calls.length).toBeGreaterThan(0);
    expect(world.executor.calls.every((call) => call.authorized)).toBe(true);
    for (const secret of [tokenCanary, "queryCanary0000", "upstream-sample"])
      expect(text).not.toContain(secret);
    expect(console.text()).not.toContain(tokenCanary);
    expect(await filesContaining(join(parent, "Lazurio"), tokenCanary)).toEqual(
      [],
    );
  } finally {
    console.restore();
  }
});

// Executor 1.6.10 adds a server it cannot reach all the same and stamps its
// connection `degraded` with `tool_sync_failed` (#322): an app's account and a
// custom server then read as failing, never as connected.
test("an account whose tools Executor cannot sync reads as failing, never connected", async () => {
  const unreachable = {
    owner: "org" as const,
    name: "default",
    identityLabel: null,
    health: "degraded" as const,
    reason: "tool_sync_failed" as const,
  };
  const { app } = await setup({
    composio: false,
    executorSeed: {
      integrations: [
        { ...notion, broken: true },
        { ...invoices, broken: true },
      ],
      connections: [
        { ...unreachable, integration: "notion-com", template: "oauth2" },
        { ...unreachable, integration: "invoices", template: "header" },
      ],
    },
  });
  const { value } = await overview(app);
  expect(
    value.apps.find((item) => item.id === "notion")?.accounts,
  ).toMatchObject([{ selector: "org/notion-com/default", state: "failed" }]);
  expect(value.custom).toMatchObject([{ id: "invoices", state: "failed" }]);
});

test("Executor that is not this account's never gets the token, and the page still answers", async () => {
  const parent = await realpath(
    await mkdtemp(join(tmpdir(), "lazurio-integrations-")),
  );
  cleanups.push(() => rm(parent, { recursive: true, force: true }));
  const world = await integrationsWorld(parent, {
    executorSeed: { integrations: [notion] },
  });
  cleanups.push(() => world.executor.stop());
  const app = await worldLaunchpad(parent, world, {
    seams: { executor: world.executorHost(false) },
  });
  cleanups.push(() => app.close());
  const { value } = await overview(app);
  expect(value.sources.executor).toBe("unavailable");
  expect(value.sources.tools).toBe("ok");
  // GitHub still goes through gh; Notion lists no account and its path
  // stays, but whether Executor holds one was not read: unknown, never "not
  // connected" (decision F42, addendum of 2026-10-27).
  expect(value.apps.find((item) => item.id === "github")?.connected).toBe(true);
  expect(value.apps.find((item) => item.id === "notion")).toMatchObject({
    path: { path: "direct" },
    connected: null,
    unknown: "executor-unavailable",
    accounts: [],
  });
  expect(world.executor.calls).toEqual([]);
});

test("an Executor that is down and one without a token file are explicit, never 'nothing connected'", async () => {
  const { world, app } = await setup({ composio: false, gh: false });
  await world.executor.stop();
  const { value } = await overview(app);
  expect(value.sources).toEqual({
    tools: "ok",
    executor: "unreadable",
    composio: "unavailable",
  });
  // GitHub: gh signed out, no company app for its direct path, Composio
  // not installed: nothing here connects it, which was all read.
  expect(value.apps.find((item) => item.id === "github")).toMatchObject({
    connected: false,
  });
  expect(value.apps.find((item) => item.id === "github")?.unknown).toBe(
    undefined,
  );
  // Down is not gone: Notion keeps its direct path, and whether Executor
  // holds its account is unknown, not "not connected" (decision F42,
  // addendum of 2026-10-27).
  expect(value.apps.find((item) => item.id === "notion")).toMatchObject({
    path: { path: "direct" },
    connected: null,
    unknown: "executor-unreadable",
  });
});

test("an Environment without Executor says so, and Notion goes through Composio there", async () => {
  const { world, app } = await setup(
    { executorSeed: { integrations: [notion] } },
    { tools: ["composio"], seams: { executorPresent: false } },
  );
  const { value } = await overview(app);
  expect(value.sources.executor).toBe("absent");
  expect(value.apps.find((item) => item.id === "notion")?.path).toEqual({
    path: "composio",
    signIn: false,
  });
  // Notion's Executor integration is not this Environment's: no account.
  expect(value.apps.find((item) => item.id === "notion")?.accounts).toEqual([]);
  expect(value.custom).toEqual([]);
  // Connecting it starts Composio's link, never Executor's sign-in.
  const connect = await app.post("/api/integrations/connect", {
    app: "notion",
  });
  expect(((await connect.json()) as { kind: string }).kind).toBe("authorize");
  expect(
    world.executor.calls.some((call) => call.path.startsWith("/api/oauth")),
  ).toBe(false);
});

test("the local admission holds: no token, no answer; a write needs the same origin", async () => {
  const { app } = await setup({ composio: false });
  expect((await fetch(new URL("/api/integrations", app.url))).status).toBe(403);
  const foreign = await fetch(new URL("/api/integrations/connect", app.url), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${app.url.hash.slice(1)}`,
      Origin: "http://evil.example",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ app: "deepwiki" }),
  });
  expect(foreign.status).toBe(403);
  // Exact bodies and queries only.
  expect((await app.get("/api/integrations?refresh=yes")).status).toBe(400);
  expect(
    (await app.post("/api/integrations/connect", { app: "deepwiki", extra: 1 }))
      .status,
  ).toBe(400);
  expect(
    (await app.post("/api/integrations/poll", { session: "nope" })).status,
  ).toBe(400);
});

test("a one-click app without sign-in connects at once", async () => {
  const { world, app } = await setup({ composio: false });
  world.executor.probes.set("https://mcp.deepwiki.com/mcp", {
    requiresOAuth: false,
  });
  const answer = await app.post("/api/integrations/connect", {
    app: "deepwiki",
  });
  expect(answer.status).toBe(200);
  expect(await answer.json()).toEqual({ kind: "connected", app: "deepwiki" });
  expect(world.executor.integrations.map((item) => item.slug)).toEqual([
    "deepwiki-com",
  ]);
  const { value } = await overview(app);
  expect(value.apps.find((item) => item.id === "deepwiki")).toMatchObject({
    path: { path: "direct" },
    connected: true,
  });
});

// A slug is never an app's identity (review of 2026-10-09): a server that
// holds DeepWiki's slug but points elsewhere is listed as custom, its account
// is not DeepWiki's, and connecting DeepWiki refuses instead of reusing it,
// before anything is probed, added or connected.
test("a server under an app's slug with another endpoint is never taken for the app; connecting it refuses", async () => {
  const { world, app } = await setup({
    composio: false,
    executorSeed: {
      integrations: [
        {
          slug: "deepwiki-com",
          name: "DeepWiki",
          kind: "mcp",
          transport: "remote",
          endpoint: "https://evil.example/mcp",
          auth: "none",
          tools: 2,
        },
      ],
      connections: [
        {
          owner: "org",
          name: "default",
          integration: "deepwiki-com",
          template: "none",
          identityLabel: null,
          health: null,
        },
      ],
    },
  });
  world.executor.probes.set("https://mcp.deepwiki.com/mcp", {
    requiresOAuth: false,
  });
  const { value } = await overview(app);
  expect(value.apps.find((item) => item.id === "deepwiki")).toMatchObject({
    connected: false,
    accounts: [],
  });
  expect(value.custom).toMatchObject([
    { id: "deepwiki-com", kind: "remote", target: "https://evil.example/mcp" },
  ]);
  const answer = await app.post("/api/integrations/connect", {
    app: "deepwiki",
  });
  expect(answer.status).toBe(409);
  expect(await answer.json()).toEqual({
    kind: "blocked",
    reason: "integration-conflict",
  });
  expect(
    world.executor.calls.filter(
      (call) =>
        call.method === "POST" &&
        ["/api/mcp/probe", "/api/mcp/servers", "/api/connections"].includes(
          call.path,
        ),
    ),
  ).toEqual([]);
  // Removed in Vlastní, DeepWiki connects at its own endpoint.
  const removed = await app.post("/api/integrations/custom/remove", {
    id: "deepwiki-com",
    confirm: true,
  });
  expect(await removed.json()).toEqual({ kind: "removed" });
  const again = await app.post("/api/integrations/connect", {
    app: "deepwiki",
  });
  expect(await again.json()).toEqual({ kind: "connected", app: "deepwiki" });
  expect(
    world.executor.integrations.map((item) => [item.slug, item.endpoint]),
  ).toEqual([["deepwiki-com", "https://mcp.deepwiki.com/mcp"]]);
});

// The app's slug held by another server refuses the connect even where the
// app's own server is there too under another slug (re-review of
// 2026-10-10): agents find Executor's integrations by slug, so the squatter
// goes first. Nothing is probed, added or connected; no POST at all.
test("a squatted app slug refuses the connect even next to the app's server under another slug", async () => {
  const { world, app } = await setup({
    composio: false,
    executorSeed: {
      integrations: [
        {
          slug: "deepwiki-alias",
          name: "DeepWiki",
          kind: "mcp",
          transport: "remote",
          endpoint: "https://mcp.deepwiki.com/mcp",
          auth: "none",
          tools: 3,
        },
        {
          slug: "deepwiki-com",
          name: "DeepWiki",
          kind: "mcp",
          transport: "remote",
          endpoint: "https://evil.example/mcp",
          auth: "none",
          tools: 2,
        },
      ],
      connections: [],
    },
  });
  world.executor.probes.set("https://mcp.deepwiki.com/mcp", {
    requiresOAuth: false,
  });
  // The app's server is DeepWiki's, whatever its slug; the squatter is custom.
  const { value } = await overview(app);
  expect(value.custom).toMatchObject([
    { id: "deepwiki-com", target: "https://evil.example/mcp" },
  ]);
  const before = world.executor.calls.length;
  const answer = await app.post("/api/integrations/connect", {
    app: "deepwiki",
  });
  expect(answer.status).toBe(409);
  expect(await answer.json()).toEqual({
    kind: "blocked",
    reason: "integration-conflict",
  });
  expect(
    world.executor.calls.slice(before).filter((call) => call.method === "POST"),
  ).toEqual([]);
  expect(world.executor.connections).toEqual([]);
});

// Signing in again an account without sign-in is a real retry (review of
// 2026-10-09): Executor re-syncs its tools and checks it, and only a working
// account answers connected. A broken server stays failing and says so, also
// when the person connects the app anew without a name, and also after the
// check's verdict (`degraded`, `probe_failed`) replaced the sync's (#322).
test("retrying a failing account without sign-in checks it for real and never reports a false success", async () => {
  const deepwiki = {
    slug: "deepwiki-com",
    name: "DeepWiki",
    kind: "mcp" as const,
    transport: "remote" as const,
    endpoint: "https://mcp.deepwiki.com/mcp",
    auth: "none" as const,
    tools: 2,
    broken: true,
  };
  const { world, app } = await setup({
    composio: false,
    executorSeed: {
      integrations: [deepwiki],
      connections: [
        {
          owner: "org",
          name: "default",
          integration: "deepwiki-com",
          template: "none",
          identityLabel: null,
          // What Executor 1.6.10 stamps when it cannot sync a server's tools.
          health: "degraded",
          reason: "tool_sync_failed",
        },
      ],
    },
  });
  world.executor.probes.set("https://mcp.deepwiki.com/mcp", {
    requiresOAuth: false,
  });
  const failing = (await overview(app)).value.apps.find(
    (item) => item.id === "deepwiki",
  );
  expect(failing?.accounts).toMatchObject([
    { selector: "org/deepwiki-com/default", state: "failed" },
  ]);
  for (const body of [
    { app: "deepwiki", account: "org/deepwiki-com/default" },
    { app: "deepwiki" },
  ]) {
    const answer = await app.post("/api/integrations/connect", body);
    expect(answer.status).toBe(409);
    expect(await answer.json()).toEqual({
      kind: "blocked",
      reason: "still-failing",
    });
  }
  expect(
    world.executor.calls
      .filter((call) => call.method === "POST")
      .map((call) => call.path)
      .filter((path) => path.startsWith("/api/connections/")),
  ).toEqual([
    "/api/connections/org/deepwiki-com/default/refresh",
    "/api/connections/org/deepwiki-com/default/health",
    "/api/connections/org/deepwiki-com/default/refresh",
    "/api/connections/org/deepwiki-com/default/health",
  ]);
  expect(
    (await overview(app)).value.apps.find((item) => item.id === "deepwiki")
      ?.accounts,
  ).toMatchObject([{ state: "failed" }]);
  // The server works again: the same retry repairs the account.
  deepwiki.broken = false;
  const integration = world.executor.integrations.find(
    (item) => item.slug === "deepwiki-com",
  );
  if (integration !== undefined) integration.broken = false;
  const repaired = await app.post("/api/integrations/connect", {
    app: "deepwiki",
    account: "org/deepwiki-com/default",
  });
  expect(await repaired.json()).toEqual({ kind: "connected", app: "deepwiki" });
  expect(
    (await overview(app)).value.apps.find((item) => item.id === "deepwiki"),
  ).toMatchObject({ connected: true, accounts: [{ state: "connected" }] });
});

test("a one-click OAuth app on this computer: the authorization URL to open, then connected", async () => {
  const { world, app } = await setup({ composio: false });
  world.executor.probes.set("https://mcp.linear.app/mcp", {
    requiresOAuth: true,
  });
  const started = (await (
    await app.post("/api/integrations/connect", { app: "linear", name: "Work" })
  ).json()) as { kind: string; session: string; url: string };
  expect(started.kind).toBe("authorize");
  expect(started.url).toBe("https://auth.example.test/authorize?state=state1");
  // Executor registered a client dynamically and started the flow with the
  // name given; its callback is Executor's own on localhost.
  const register = world.executor.calls.find(
    (call) => call.path === "/api/oauth/clients/register-dynamic",
  );
  expect(register?.body).toMatchObject({
    owner: "org",
    redirectUri: "http://localhost:4789/api/oauth/callback",
    clientName: "Lazurio",
    originIntegration: "linear-app",
  });
  expect(
    world.executor.calls.find((call) => call.path === "/api/oauth/start")?.body,
  ).toMatchObject({
    owner: "org",
    integration: "linear-app",
    name: "work",
    identityLabel: "Work",
    newConnection: true,
  });
  expect(
    await (
      await app.post("/api/integrations/poll", { session: started.session })
    ).json(),
  ).toEqual({ kind: "pending" });
  world.executor.finish("state1", true);
  let progress: unknown = null;
  for (let tries = 0; tries < 50; tries += 1) {
    progress = await (
      await app.post("/api/integrations/poll", { session: started.session })
    ).json();
    if ((progress as { kind: string }).kind !== "pending") break;
    await Bun.sleep(50);
  }
  expect(progress).toEqual({ kind: "connected", app: "linear" });
  const { value } = await overview(app);
  expect(value.apps.find((item) => item.id === "linear")).toMatchObject({
    connected: true,
    accounts: [{ label: "Work", state: "connected" }],
  });
});

test("an OAuth flow the person does not finish, or cancels, ends without a connection", async () => {
  const { world, app } = await setup({ composio: false });
  world.executor.probes.set("https://mcp.linear.app/mcp", {
    requiresOAuth: true,
  });
  const first = (await (
    await app.post("/api/integrations/connect", { app: "linear" })
  ).json()) as { session: string };
  world.executor.finish("state1", false);
  let progress: unknown = null;
  for (let tries = 0; tries < 50; tries += 1) {
    progress = await (
      await app.post("/api/integrations/poll", { session: first.session })
    ).json();
    if ((progress as { kind: string }).kind !== "pending") break;
    await Bun.sleep(50);
  }
  expect(progress).toEqual({ kind: "ended", reason: "failed" });
  const second = (await (
    await app.post("/api/integrations/connect", { app: "linear" })
  ).json()) as { session: string };
  expect(
    await (
      await app.post("/api/integrations/cancel", { session: second.session })
    ).json(),
  ).toEqual({ kind: "cancelled" });
  expect(
    world.executor.calls.some(
      (call) => call.path === "/api/oauth/cancel" && call.authorized,
    ),
  ).toBe(true);
  expect(world.executor.connections).toEqual([]);
});

// A direct sign-in in the person's own browser (decision F42, addendum of
// 2026-10-13): on a Remote Environment the Launchpad registers its own
// address with an authorization server that takes it and hands the server's
// return to Executor's callback; the Environment browser stays for a server
// that returns only to Executor on localhost.
const returnAddress =
  "https://launchpad.workspace.example.lazurio.io/api/integrations/oauth/callback";
const environmentView = `https://browser.workspace.example.lazurio.io/t/${"0".repeat(32)}`;

async function remote(
  locale: "cs" | "en" = "en",
): Promise<Awaited<ReturnType<typeof setup>> & { opened: string[] }> {
  const opened: string[] = [];
  const context = await setup(
    { composio: false },
    {
      locale,
      seams: {
        oauthCallback: returnAddress,
        environmentBrowser: async (url) => {
          opened.push(url);
          return { view: environmentView };
        },
      },
    },
  );
  context.world.executor.probes.set("https://mcp.linear.app/mcp", {
    requiresOAuth: true,
  });
  return { ...context, opened };
}

async function settled(
  app: Awaited<ReturnType<typeof setup>>["app"],
  session: string,
): Promise<unknown> {
  let progress: unknown = null;
  for (let tries = 0; tries < 50; tries += 1) {
    progress = await (
      await app.post("/api/integrations/poll", { session })
    ).json();
    if ((progress as { kind: string }).kind !== "pending") break;
    await Bun.sleep(50);
  }
  return progress;
}

const registeredFor = (world: IntegrationsWorld) =>
  world.executor.calls
    .filter((call) => call.path === "/api/oauth/clients/register-dynamic")
    .map((call) => (call.body as { redirectUri: string }).redirectUri);

const handedOn = (world: IntegrationsWorld) =>
  world.executor.calls.filter((call) =>
    call.path.startsWith("/api/oauth/callback"),
  );

test("on a Remote Environment a direct sign-in opens in the person's own browser and returns to the Launchpad", async () => {
  const { world, app, opened } = await remote();
  const started = (await (
    await app.post("/api/integrations/connect", { app: "linear", name: "Work" })
  ).json()) as { kind: string; session: string; url?: string; view?: string };
  // An address for a window of the person's browser, not the Environment
  // browser's view.
  expect(started).toEqual({
    kind: "authorize",
    session: expect.any(String),
    url: "https://auth.example.test/authorize?state=state1",
  });
  expect(opened).toEqual([]);
  // The client is registered with the Launchpad's own address, and the flow
  // returns there.
  expect(registeredFor(world)).toEqual([returnAddress]);
  expect(
    world.executor.calls.find((call) => call.path === "/api/oauth/start")?.body,
  ).toMatchObject({ redirectUri: returnAddress, name: "work" });
  // The server returns the person's browser with what it adds of its own.
  const back = await app.get(
    "/api/integrations/oauth/callback?state=state1&code=codeCanary0001&scope=read&iss=https%3A%2F%2Fauth.example.test",
  );
  expect(back.status).toBe(200);
  expect(back.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(back.headers.get("referrer-policy")).toBe("no-referrer");
  expect(back.headers.get("cache-control")).toBe("no-store");
  const page = await back.text();
  expect(page).toContain(
    "Linear is connected. You can close this window and go back to Lazurio.",
  );
  expect(page).not.toContain("codeCanary0001");
  expect(page).not.toContain("<script");
  // Executor's callback got exactly what it reads, with the token.
  expect(handedOn(world)).toEqual([
    {
      method: "GET",
      path: "/api/oauth/callback?state=state1&code=codeCanary0001",
      authorized: true,
      body: null,
    },
  ]);
  expect(await settled(app, started.session)).toEqual({
    kind: "connected",
    app: "linear",
  });
  expect(
    (await overview(app)).value.apps.find((item) => item.id === "linear"),
  ).toMatchObject({
    connected: true,
    accounts: [{ label: "Work", state: "connected" }],
  });
  // A reload hands nothing on again and still says how it went.
  const again = await app.get(
    "/api/integrations/oauth/callback?state=state1&code=codeCanary0001",
  );
  expect(again.status).toBe(200);
  expect(await again.text()).toContain("Linear is connected.");
  expect(handedOn(world)).toHaveLength(1);
});

test("a sign-in the person refuses at the server returns to the Launchpad and ends without a connection", async () => {
  const { world, app } = await remote("cs");
  const started = (await (
    await app.post("/api/integrations/connect", { app: "linear" })
  ).json()) as { session: string };
  const back = await app.get(
    "/api/integrations/oauth/callback?state=state1&error=access_denied&error_description=The%20person%20said%20no",
  );
  expect(back.status).toBe(200);
  const page = await back.text();
  expect(page).toContain('<html lang="cs">');
  expect(page).toContain(
    "Přihlášení k aplikaci Linear se nepodařilo dokončit. Vraťte se do Lazuria a zkuste to znovu.",
  );
  expect(handedOn(world).map((call) => call.path)).toEqual([
    "/api/oauth/callback?state=state1&error=access_denied&error_description=The+person+said+no",
  ]);
  expect(await settled(app, started.session)).toEqual({
    kind: "ended",
    reason: "failed",
  });
  expect(world.executor.connections).toEqual([]);
});

test("a server that registers only loopback addresses keeps the sign-in in the Environment browser", async () => {
  const { world, app, opened } = await remote();
  world.executor.authorizationServer.loopbackOnly = true;
  const started = (await (
    await app.post("/api/integrations/connect", { app: "linear" })
  ).json()) as { kind: string; session: string; view?: string };
  expect(started).toEqual({
    kind: "authorize",
    session: expect.any(String),
    view: environmentView,
  });
  expect(opened).toEqual(["https://auth.example.test/authorize?state=state1"]);
  // Refused for the Launchpad's address, registered for Executor's own.
  expect(registeredFor(world)).toEqual([
    returnAddress,
    "http://localhost:4789/api/oauth/callback",
  ]);
  expect(
    world.executor.calls.find((call) => call.path === "/api/oauth/start")?.body,
  ).not.toHaveProperty("redirectUri");
  // Its state never returns through the Launchpad.
  const back = await app.get(
    "/api/integrations/oauth/callback?state=state1&code=codeCanary0002",
  );
  expect(back.status).toBe(400);
  expect(await back.text()).toContain(
    "This sign-in is no longer valid. Start connecting again in Lazurio.",
  );
  expect(handedOn(world)).toEqual([]);
  // Executor's own callback finishes it, as before.
  world.executor.finish("state1", true);
  expect(await settled(app, started.session)).toEqual({
    kind: "connected",
    app: "linear",
  });
});

test("the person's own browser is preferred to a client ID metadata document, which keeps the Environment browser alone", async () => {
  const both = await remote();
  both.world.executor.authorizationServer.metadataDocument = true;
  const own = (await (
    await both.app.post("/api/integrations/connect", { app: "linear" })
  ).json()) as { url?: string };
  expect(own.url).toBe("https://auth.example.test/authorize?state=state1");
  expect(registeredFor(both.world)).toEqual([returnAddress]);
  expect(
    both.world.executor.calls.some(
      (call) => call.path === "/api/oauth/clients",
    ),
  ).toBe(false);

  const only = await remote();
  only.world.executor.authorizationServer.registration = false;
  only.world.executor.authorizationServer.metadataDocument = true;
  const local = (await (
    await only.app.post("/api/integrations/connect", { app: "linear" })
  ).json()) as { view?: string };
  expect(local.view).toBe(environmentView);
  expect(registeredFor(only.world)).toEqual([]);
  expect(
    only.world.executor.calls.find((call) => call.path === "/api/oauth/clients")
      ?.body,
  ).toMatchObject({
    clientId: "https://executor.sh/api/oauth/client-id-metadata/local.json",
  });
});

test("a return no sign-in here waits for is refused without reaching Executor", async () => {
  const { world, app } = await remote();
  await app.post("/api/integrations/connect", { app: "linear" });
  for (const query of [
    "code=codeCanary0003",
    "state=state9&code=codeCanary0003",
    "state=state1&state=state1&code=codeCanary0003",
    `state=state1&code=${"c".repeat(8 * 1024 + 1)}`,
  ]) {
    const answer = await app.get(`/api/integrations/oauth/callback?${query}`);
    expect(answer.status).toBe(400);
    expect(await answer.text()).toContain("This sign-in is no longer valid.");
  }
  expect(
    (
      await app.post("/api/integrations/oauth/callback", {
        state: "state1",
        code: "codeCanary0003",
      })
    ).status,
  ).toBe(405);
  // A cancelled sign-in no longer takes its return either.
  const second = (await (
    await app.post("/api/integrations/connect", { app: "linear" })
  ).json()) as { session: string };
  await app.post("/api/integrations/cancel", { session: second.session });
  const late = await app.get(
    "/api/integrations/oauth/callback?state=state2&code=codeCanary0003",
  );
  expect(late.status).toBe(200);
  expect(await late.text()).toContain("This sign-in is no longer valid.");
  expect(handedOn(world)).toEqual([]);
});

test("a sign-in cancelled while its return proves Executor's listener is never handed on", async () => {
  const { world, app } = await remote();
  const started = (await (
    await app.post("/api/integrations/connect", { app: "linear" })
  ).json()) as { session: string };
  const hold = world.holdListener();
  const proofs = async (count: number) => {
    for (let tries = 0; tries < 500 && hold.held() < count; tries += 1)
      await Bun.sleep(10);
    expect(hold.held()).toBeGreaterThanOrEqual(count);
  };
  // The long poll waits at the proof, then the return does (Pablo's review
  // of #368: the cancel came between the proofs and the request).
  await proofs(1);
  const back = app.get(
    "/api/integrations/oauth/callback?state=state1&code=codeCanary0005",
  );
  await proofs(2);
  // The cancel ends the sign-in at once, then waits at the proof itself.
  const cancelled = app.post("/api/integrations/cancel", {
    session: started.session,
  });
  await proofs(3);
  hold.release();
  const page = await back;
  expect(page.status).toBe(200);
  expect(await page.text()).toContain("This sign-in is no longer valid.");
  expect(await (await cancelled).json()).toEqual({ kind: "cancelled" });
  expect(handedOn(world)).toEqual([]);
  expect(await settled(app, started.session)).toEqual({
    kind: "ended",
    reason: "cancelled",
  });
  expect(world.executor.connections).toEqual([]);
});

test("a return Executor cannot take ends the sign-in, and the page says so", async () => {
  const { world, app } = await remote();
  const started = (await (
    await app.post("/api/integrations/connect", { app: "linear" })
  ).json()) as { session: string };
  await world.executor.stop();
  const back = await app.get(
    "/api/integrations/oauth/callback?state=state1&code=codeCanary0004",
  );
  expect(back.status).toBe(200);
  expect(await back.text()).toContain(
    "The sign-in to Linear could not be finished.",
  );
  expect(await settled(app, started.session)).toEqual({
    kind: "ended",
    reason: "failed",
  });
});

test("through Composio: the link only for the request that asked, then connected; never journaled", async () => {
  const console = captureConsole();
  try {
    const { world, app } = await setup({}, { tools: ["composio"] });
    // Salesforce has only Composio.
    const answer = await app.post("/api/integrations/connect", {
      app: "salesforce",
    });
    const started = (await answer.json()) as {
      kind: string;
      session: string;
      url: string;
    };
    expect(started.kind).toBe("authorize");
    expect(started.url).toBe("https://connect.composio.dev/link/lk_fake101");
    expect(await composioCalls(world.home)).toContainEqual([
      "link",
      "salesforce",
      "--no-wait",
      "--no-browser",
    ]);
    expect(
      await (
        await app.post("/api/integrations/poll", { session: started.session })
      ).json(),
    ).toEqual({ kind: "pending" });
    await setAccountStatus(world.home, "ca_101", "ACTIVE");
    expect(
      await (
        await app.post("/api/integrations/poll", { session: started.session })
      ).json(),
    ).toEqual({ kind: "connected", app: "salesforce" });
    // The reading answers no link URL anywhere, and nothing journals it.
    const { text } = await overview(app);
    expect(text).not.toContain("lk_fake101");
    expect(console.text()).not.toContain("lk_fake101");
    expect(console.text()).toContain("integrations");
    expect(console.text()).toContain("salesforce");
  } finally {
    console.restore();
  }
});

// A Composio sign-in nobody finishes is no account (decision F42, addendum
// of 2026-10-12): a pending account is listed only while a sign-in started
// here waits for its toolkit, and never one left by an earlier sign-in, also
// in the page's cached reading and when the person tries the same toolkit
// again.
test("a Composio sign-in nobody finishes is listed only while one started here waits, and never again", async () => {
  const { app } = await setup(
    {
      composio: {
        accounts: [
          // Left by a sign-in that was never finished, in no session here.
          {
            id: "ca_9",
            toolkit: "salesforce",
            status: "INITIATED",
            alias: null,
            word_id: "harbor",
          },
        ],
      },
    },
    { tools: ["composio"] },
  );
  const salesforce = async (refresh: boolean) => {
    const answer = await app.get(
      refresh ? "/api/integrations?refresh=1" : "/api/integrations",
    );
    const value = (await answer.json()) as IntegrationsOverview;
    return value.apps
      .find((item) => item.id === "salesforce")
      ?.accounts.map((account) => [account.selector, account.state]);
  };
  expect(await salesforce(true)).toEqual([]);
  // The person tries Salesforce again: the cached reading reads again and
  // lists the pending account of this sign-in, not the old one.
  const started = (await (
    await app.post("/api/integrations/connect", { app: "salesforce" })
  ).json()) as { kind: string; session: string };
  expect(started.kind).toBe("authorize");
  expect(await salesforce(false)).toEqual([["word101", "pending"]]);
  expect(await salesforce(true)).toEqual([["word101", "pending"]]);
  expect(
    await (
      await app.post("/api/integrations/cancel", { session: started.session })
    ).json(),
  ).toEqual({ kind: "cancelled" });
  // Cancelled: nothing waits, and no pending account is listed.
  expect(await salesforce(false)).toEqual([]);
  // Two sign-ins of the toolkit at once (Pablo's review of #337): each
  // lists its own pending account; cancelling the later one leaves only
  // the earlier's, cancelling that too leaves none.
  const first = (await (
    await app.post("/api/integrations/connect", { app: "salesforce" })
  ).json()) as { session: string };
  const second = (await (
    await app.post("/api/integrations/connect", { app: "salesforce" })
  ).json()) as { session: string };
  expect(await salesforce(true)).toEqual([
    ["word102", "pending"],
    ["word103", "pending"],
  ]);
  await app.post("/api/integrations/cancel", { session: second.session });
  expect(await salesforce(false)).toEqual([["word102", "pending"]]);
  expect(await salesforce(true)).toEqual([["word102", "pending"]]);
  await app.post("/api/integrations/cancel", { session: first.session });
  expect(await salesforce(false)).toEqual([]);
});

// Two sign-ins of one toolkit at once whose links would answer out of order
// (Pablo's third review of #337): the second starts only once the first has
// its session, so the sessions keep the links' order and cancelling either
// leaves only the other's pending account.
test("two Composio sign-ins of one toolkit at once keep their own pending accounts, however the links answer", async () => {
  for (const cancelled of ["first", "second"] as const) {
    const { world, app } = await setup({}, { tools: ["composio"] });
    const salesforce = async (refresh: boolean) => {
      const answer = await app.get(
        refresh ? "/api/integrations?refresh=1" : "/api/integrations",
      );
      const value = (await answer.json()) as IntegrationsOverview;
      return value.apps
        .find((item) => item.id === "salesforce")
        ?.accounts.map((account) => [account.selector, account.state]);
    };
    // The first link has created its pending account; its answer is held.
    await holdLink(world.home, "salesforce");
    const first = app.post("/api/integrations/connect", { app: "salesforce" });
    await linkHeld(world.home, "salesforce");
    const second = app.post("/api/integrations/connect", { app: "salesforce" });
    // Time for the second to link, were it not waiting for the first.
    await Bun.sleep(1_500);
    expect(
      (await readComposioState(world.home)).accounts.map(
        (account) => account.word_id,
      ),
    ).toEqual(["word101"]);
    await releaseLink(world.home, "salesforce");
    const one = (await (await first).json()) as {
      kind: string;
      session: string;
    };
    const two = (await (await second).json()) as {
      kind: string;
      session: string;
    };
    expect([one.kind, two.kind]).toEqual(["authorize", "authorize"]);
    expect(await salesforce(true)).toEqual([
      ["word101", "pending"],
      ["word102", "pending"],
    ]);
    await app.post("/api/integrations/cancel", {
      session: cancelled === "first" ? one.session : two.session,
    });
    const left = cancelled === "first" ? "word102" : "word101";
    expect(await salesforce(false)).toEqual([[left, "pending"]]);
    expect(await salesforce(true)).toEqual([[left, "pending"]]);
  }
  // Two rounds of a held link and a deliberate wait: beyond bun's default
  // five seconds, as `bun run check` runs it (Pablo's fourth review of #337).
}, 30_000);

test("a second Composio account needs a name, and a name in use is refused before anything runs", async () => {
  const { world, app } = await setup(
    {
      composio: {
        accounts: [
          {
            id: "ca_1",
            toolkit: "salesforce",
            status: "ACTIVE",
            alias: "Work",
            word_id: "castle",
          },
        ],
      },
    },
    { tools: ["composio"] },
  );
  const refused = async (body: unknown) => {
    const answer = await app.post("/api/integrations/connect", body);
    expect(answer.status).toBe(409);
    return answer.json();
  };
  expect(await refused({ app: "salesforce" })).toEqual({
    kind: "blocked",
    reason: "name-required",
  });
  expect(await refused({ app: "salesforce", name: "work" })).toEqual({
    kind: "blocked",
    reason: "name-taken",
  });
  expect(
    (await composioCalls(world.home)).filter((call) =>
      call.includes("--no-wait"),
    ),
  ).toEqual([]);
});

// A toolkit the catalog does not know is listed from Composio's accounts
// (decision F42, addendum of 2026-10-14), and its card offers another
// account: connecting it links that toolkit by its slug, with the same name
// rules as a catalog app's (#534: it ended in "app-unknown").
test("another account of a toolkit the catalog does not know connects by its toolkit, with the same name rules", async () => {
  const { world, app } = await setup(
    {
      composio: {
        accounts: [
          {
            id: "ca_7",
            toolkit: "wispr_flow",
            status: "ACTIVE",
            alias: "Work",
            word_id: "meadow",
          },
        ],
      },
    },
    { tools: ["composio"] },
  );
  const post = async (body: unknown) => {
    const answer = await app.post("/api/integrations/connect", body);
    return { status: answer.status, value: await answer.json() };
  };
  expect(await post({ app: "wispr_flow" })).toEqual({
    status: 409,
    value: { kind: "blocked", reason: "name-required" },
  });
  expect(await post({ app: "wispr_flow", name: "work" })).toEqual({
    status: 409,
    value: { kind: "blocked", reason: "name-taken" },
  });
  const started = await post({ app: "wispr_flow", name: "Bob's test, #2" });
  expect(started.value).toMatchObject({ kind: "authorize" });
  expect(started.status).toBe(200);
  expect(started.value).toMatchObject({ kind: "authorize" });
  expect(
    (await composioCalls(world.home)).filter((call) =>
      call.includes("--no-wait"),
    ),
  ).toEqual([
    [
      "link",
      "wispr_flow",
      "--no-wait",
      "--no-browser",
      "--alias",
      "Bob's test, #2",
    ],
  ]);
});

// Names and the way to Composio's dashboard (decision F42, addendum of
// 2026-10-11, #312): `connections list` leaves out a single account's alias,
// so the reading asks `link <toolkit> --list` for it, once per such toolkit,
// and keeps it as long as it keeps itself; each Composio account links to the
// app's page in the organization Composio's sign-in probe named.
test("a toolkit's only active account is named in the reading, read once and kept with it", async () => {
  const { world, app } = await setup(
    {
      composio: {
        accounts: [
          {
            id: "ca_1",
            toolkit: "gmail",
            status: "ACTIVE",
            alias: "Work",
            word_id: "castle",
          },
          // Two accounts: `connections list` names them itself.
          {
            id: "ca_2",
            toolkit: "slack",
            status: "ACTIVE",
            alias: "Team",
            word_id: "river",
          },
          {
            id: "ca_3",
            toolkit: "slack",
            status: "ACTIVE",
            alias: "Community",
            word_id: "stone",
          },
          // Expired: `--list` lists only active accounts, so it stays unnamed.
          {
            id: "ca_4",
            toolkit: "salesforce",
            status: "EXPIRED",
            alias: "Sales",
            word_id: "field",
          },
          // Active without a name in Composio.
          {
            id: "ca_5",
            toolkit: "notion",
            status: "ACTIVE",
            alias: null,
            word_id: "cloud",
          },
        ],
      },
    },
    { tools: ["composio"] },
  );
  const lists = async () =>
    (await composioCalls(world.home)).filter((call) => call.includes("--list"));
  const read = async (path: string) => {
    const answer = await app.get(path);
    expect(answer.status).toBe(200);
    return (await answer.json()) as IntegrationsOverview;
  };
  const value = await read("/api/integrations");
  const accounts = (id: string) =>
    value.apps
      .find((item) => item.id === id)
      ?.accounts.map((account) => [account.label, account.manage]);
  const manage = (toolkit: string) =>
    `https://dashboard.composio.dev/First/~/connect/apps/${toolkit}`;
  expect(accounts("gmail")).toEqual([["Work", manage("gmail")]]);
  expect(accounts("slack")).toEqual([
    ["Team", manage("slack")],
    ["Community", manage("slack")],
  ]);
  expect(accounts("salesforce")).toEqual([[null, manage("salesforce")]]);
  expect(accounts("notion")).toEqual([[null, manage("notion")]]);
  // One call per toolkit whose only account is active and unnamed.
  expect((await lists()).sort()).toEqual([
    ["link", "gmail", "--list"],
    ["link", "notion", "--list"],
  ]);
  // The kept reading asks nothing again; a refresh reads the names anew.
  await read("/api/integrations");
  expect(await lists()).toHaveLength(2);
  const state = await readComposioState(world.home);
  await writeComposioState(world.home, {
    ...state,
    accounts: state.accounts.map((account) =>
      account.id === "ca_1" ? { ...account, alias: "Personal" } : account,
    ),
  });
  const again = await read("/api/integrations?refresh=1");
  expect(
    again.apps.find((item) => item.id === "gmail")?.accounts[0]?.label,
  ).toBe("Personal");
  expect(await lists()).toHaveLength(4);
});

// The names outlive the reading (half an hour, by toolkit and word id), so
// a new reading asks nothing for an unchanged account; connecting, signing
// in again or disconnecting an account of a toolkit asks its toolkit again,
// and "Zkontrolovat připojení" (`?refresh=1`) asks every name again.
test("a name is read once for many readings; a connect, a disconnect and a refresh read again", async () => {
  const { world, app } = await setup(
    {
      composio: {
        accounts: [
          {
            id: "ca_1",
            toolkit: "gmail",
            status: "ACTIVE",
            alias: "Work",
            word_id: "castle",
          },
          {
            id: "ca_2",
            toolkit: "salesforce",
            status: "ACTIVE",
            alias: "Sales",
            word_id: "field",
          },
          {
            id: "ca_3",
            toolkit: "todoist",
            status: "ACTIVE",
            alias: "Home",
            word_id: "stone",
          },
        ],
      },
    },
    { tools: ["composio"] },
  );
  const lookups = async () => {
    const calls = (await composioCalls(world.home)).filter(
      (call) => call[0] === "link" && call[2] === "--list",
    );
    return ["gmail", "salesforce", "todoist"].map(
      (toolkit) => calls.filter((call) => call[1] === toolkit).length,
    );
  };
  const labels = async (path: string) => {
    const answer = await app.get(path);
    expect(answer.status).toBe(200);
    const value = (await answer.json()) as IntegrationsOverview;
    return ["gmail", "salesforce", "todoist"].map(
      (id) => value.apps.find((item) => item.id === id)?.accounts[0]?.label,
    );
  };
  expect(await labels("/api/integrations")).toEqual(["Work", "Sales", "Home"]);
  expect(await lookups()).toEqual([1, 1, 1]);
  // Connecting Salesforce again (here refused: a second account needs a
  // name) forgets its names; its own check asks `--list` once.
  const refused = await app.post("/api/integrations/connect", {
    app: "salesforce",
  });
  expect(await refused.json()).toEqual({
    kind: "blocked",
    reason: "name-required",
  });
  expect(await lookups()).toEqual([1, 2, 1]);
  // Disconnecting Gmail (here refused: this CLI has no `--yes`) forgets its
  // names and the reading.
  const kept = await app.post("/api/integrations/disconnect", {
    app: "gmail",
    path: "composio",
    account: "castle",
    confirm: true,
  });
  expect(await kept.json()).toEqual({
    kind: "blocked",
    reason: "disconnect-unsupported",
  });
  // The new reading asks Gmail and Salesforce again, never Todoist.
  expect(await labels("/api/integrations")).toEqual(["Work", "Sales", "Home"]);
  expect(await lookups()).toEqual([2, 3, 1]);
  // "Zkontrolovat připojení" asks every name again.
  expect(await labels("/api/integrations?refresh=1")).toEqual([
    "Work",
    "Sales",
    "Home",
  ]);
  expect(await lookups()).toEqual([3, 4, 2]);
});

// Review of 2026-10-11 (#315): "Zkontrolovat připojení" reads by a reading
// of its own while an older reading still waits for its lookup, and that
// older lookup's answer, once it comes, is not kept.
test("a refresh reads names afresh while an older lookup still runs, and the older answer is not kept", async () => {
  const { world, app } = await setup(
    {
      composio: {
        accounts: [
          {
            id: "ca_1",
            toolkit: "gmail",
            status: "ACTIVE",
            alias: "Old",
            word_id: "castle",
          },
        ],
      },
    },
    { tools: ["composio"] },
  );
  const label = async (answer: Response) => {
    expect(answer.status).toBe(200);
    const value = (await answer.json()) as IntegrationsOverview;
    return value.apps.find((item) => item.id === "gmail")?.accounts[0]?.label;
  };
  const lookups = async () =>
    (await composioCalls(world.home)).filter(
      (call) =>
        call[0] === "link" && call[1] === "gmail" && call[2] === "--list",
    ).length;
  await holdList(world.home, "gmail");
  const older = app.get("/api/integrations");
  await listHeld(world.home, "gmail");
  // The person renames the account in Composio and checks the connections.
  const state = await readComposioState(world.home);
  await writeComposioState(world.home, {
    ...state,
    accounts: state.accounts.map((account) => ({ ...account, alias: "New" })),
  });
  expect(await label(await app.get("/api/integrations?refresh=1"))).toBe("New");
  expect(await lookups()).toBe(2);
  // The older lookup answers what it read; its reading shows it, nothing
  // keeps it.
  await releaseList(world.home, "gmail");
  expect(await label(await older)).toBe("Old");
  expect(await label(await app.get("/api/integrations"))).toBe("New");
  // A new reading (Vlastní changed nothing, the reading is read again)
  // takes the kept name and asks nothing.
  await app.post("/api/integrations/custom/remove", {
    id: "nothing",
    confirm: true,
  });
  expect(await label(await app.get("/api/integrations"))).toBe("New");
  expect(await lookups()).toBe(2);
});

test("the link to Composio's dashboard: the organization's name encoded, the person's current one where none is known", async () => {
  for (const [organization, expected] of [
    [
      "Žluťoučký kůň & Co",
      "https://dashboard.composio.dev/%C5%BDlu%C5%A5ou%C4%8Dk%C3%BD%20k%C5%AF%C5%88%20%26%20Co/~/connect/apps/gmail",
    ],
    [null, "https://dashboard.composio.dev/~/org/connect/apps/gmail"],
  ] as const) {
    const { app } = await setup(
      {
        composio: {
          organization,
          accounts: [
            {
              id: "ca_1",
              toolkit: "gmail",
              status: "ACTIVE",
              alias: null,
              word_id: "castle",
            },
          ],
        },
      },
      { tools: ["composio"] },
    );
    const { value } = await overview(app);
    expect(
      value.apps.find((item) => item.id === "gmail")?.accounts[0]?.manage,
    ).toBe(expected);
  }
});

test("Composio not signed in: the card's path asks for its sign-in first", async () => {
  const { app } = await setup(
    { composio: { signedIn: false } },
    { tools: ["composio"] },
  );
  const { value } = await overview(app);
  expect(value.sources.composio).toBe("signed-out");
  // Signed out: the page asks for the sign-in, not for the update.
  expect(value.composio.update).toBe(false);
  expect(value.apps.find((item) => item.id === "salesforce")?.path).toEqual({
    path: "composio",
    signIn: true,
  });
  const answer = await app.post("/api/integrations/connect", {
    app: "salesforce",
  });
  expect(answer.status).toBe(409);
  expect(await answer.json()).toEqual({
    kind: "blocked",
    reason: "composio-signed-out",
  });
});

test("disconnecting needs an explicit confirmation; Executor's account goes, Composio's only where its CLI can", async () => {
  const { world, app } = await setup(
    {
      composio: {
        accounts: [
          {
            id: "ca_1",
            toolkit: "gmail",
            status: "ACTIVE",
            alias: null,
            word_id: "castle",
          },
        ],
      },
      executorSeed: {
        integrations: [notion],
        connections: [
          {
            owner: "org",
            name: "default",
            integration: "notion-com",
            template: "oauth2",
            identityLabel: null,
            health: "healthy",
          },
        ],
      },
    },
    { tools: ["composio"] },
  );
  const direct = {
    app: "notion",
    path: "direct",
    account: "org/notion-com/default",
  };
  expect((await app.post("/api/integrations/disconnect", direct)).status).toBe(
    400,
  );
  expect(
    (
      await app.post("/api/integrations/disconnect", {
        ...direct,
        confirm: false,
      })
    ).status,
  ).toBe(400);
  // An account of another app is not this app's to disconnect.
  expect(
    await (
      await app.post("/api/integrations/disconnect", {
        ...direct,
        app: "linear",
        confirm: true,
      })
    ).json(),
  ).toEqual({ kind: "blocked", reason: "account-unknown" });
  expect(
    await (
      await app.post("/api/integrations/disconnect", {
        ...direct,
        confirm: true,
      })
    ).json(),
  ).toEqual({ kind: "disconnected" });
  expect(world.executor.connections).toEqual([]);
  const composio = {
    app: "gmail",
    path: "composio",
    account: "castle",
    confirm: true,
  };
  // Composio 0.4.x asks for a confirmation no Launchpad answers for a person:
  // the page offers no "Odpojit" for its accounts.
  expect((await overview(app)).value.composio.disconnect).toBe(false);
  const unsupported = await app.post("/api/integrations/disconnect", composio);
  expect(unsupported.status).toBe(409);
  expect(await unsupported.json()).toEqual({
    kind: "blocked",
    reason: "disconnect-unsupported",
  });
  expect((await readComposioState(world.home)).accounts).toHaveLength(1);
  // A Composio CLI with `--yes`: removed, and proved by reading again.
  const state = await readComposioState(world.home);
  const { writeComposioState } = await import("./fixtures/integrations-world");
  await writeComposioState(world.home, { ...state, removeYes: true });
  expect((await overview(app)).value.composio.disconnect).toBe(true);
  expect(
    await (await app.post("/api/integrations/disconnect", composio)).json(),
  ).toEqual({ kind: "disconnected" });
  expect((await readComposioState(world.home)).accounts).toEqual([]);
});

// Lazurio's build of Composio's CLI (decision F42, addendum (3)): its list
// names every account (the alias, else the provider's identity) and gives
// its id, so the reading runs no `link <toolkit> --list` at all, and
// "Odpojit" removes an account by that id without a prompt.
test("Lazurio's build: names from the list without a lookup, and Odpojit removes by the account's id", async () => {
  const { parent, world, app } = await setup(
    {
      composio: {
        lazurioBuild: true,
        removeYes: true,
        accounts: [
          {
            id: "ca_1",
            toolkit: "gmail",
            status: "ACTIVE",
            alias: "work",
            word_id: "castle",
            display_name: "ada@example.com",
          },
          // A toolkit's only account without an alias: its identity names it.
          {
            id: "ca_2",
            toolkit: "notion",
            status: "ACTIVE",
            alias: null,
            word_id: "cloud",
            display_name: "grace@example.com",
          },
          {
            id: "ca_3",
            toolkit: "slack",
            status: "ACTIVE",
            alias: "Team",
            word_id: "river",
          },
          // Neither an alias nor an identity: "účet".
          {
            id: "ca_4",
            toolkit: "slack",
            status: "ACTIVE",
            alias: null,
            word_id: "stone",
          },
          {
            id: "ca_5",
            toolkit: "salesforce",
            status: "EXPIRED",
            alias: null,
            word_id: "field",
            display_name: "sales@example.com",
          },
        ],
      },
    },
    { tools: ["composio"] },
  );
  const lookups = async () =>
    (await composioCalls(world.home)).filter((call) => call.includes("--list"));
  const accounts = (value: IntegrationsOverview, id: string) =>
    value.apps
      .find((item) => item.id === id)
      ?.accounts.map((account) => [
        account.label,
        account.selector,
        account.state,
      ]);
  const { value } = await overview(app);
  expect(accounts(value, "gmail")).toEqual([["work", "ca_1", "connected"]]);
  expect(accounts(value, "notion")).toEqual([
    ["grace@example.com", "ca_2", "connected"],
  ]);
  expect(accounts(value, "slack")).toEqual([
    ["Team", "ca_3", "connected"],
    [null, "ca_4", "connected"],
  ]);
  expect(accounts(value, "salesforce")).toEqual([
    ["sales@example.com", "ca_5", "expired"],
  ]);
  expect(value.composio.disconnect).toBe(true);
  // It is the build Lazurio pins: no update offered (decision F42, addendum
  // (b) of 2026-10-14).
  expect(value.composio.update).toBe(false);
  expect(await lookups()).toEqual([]);
  // `lazurio integrations list --json` carries the same names and ids, and
  // reads no name either.
  const cli = await runIntegrationsCommand(
    ["list", "--json", "--folder", join(parent, "Lazurio")],
    {
      identity: embeddedIdentity(),
      platform: process.platform,
      env: { PATH: world.path, HOME: world.home },
      executable: process.execPath,
      executorEndpoint: world.executorHost(),
      executorPresent: true,
    },
  );
  expect(cli.code).toBe(0);
  const listed = JSON.parse(cli.stdout ?? "") as IntegrationsOverview;
  expect(listed.composio.update).toBe(false);
  const text = await runIntegrationsCommand(
    ["list", "--folder", join(parent, "Lazurio")],
    {
      identity: embeddedIdentity(),
      platform: process.platform,
      env: { PATH: world.path, HOME: world.home },
      executable: process.execPath,
      executorEndpoint: world.executorHost(),
      executorPresent: true,
    },
  );
  expect(text.stdout).not.toContain("Composio should be updated");
  for (const id of ["gmail", "notion", "slack", "salesforce"])
    expect(accounts(listed, id)).toEqual(accounts(value, id));
  expect(await lookups()).toEqual([]);
  // "Odpojit" names the account by its id and removes it without a prompt.
  const removed = await app.post("/api/integrations/disconnect", {
    app: "gmail",
    path: "composio",
    account: "ca_1",
    confirm: true,
  });
  expect(await removed.json()).toEqual({ kind: "disconnected" });
  expect(
    (await composioCalls(world.home)).filter(
      (call) =>
        call[0] === "connections" &&
        call[1] === "remove" &&
        !call.includes("--help"),
    ),
  ).toEqual([["connections", "remove", "ca_1", "--yes"]]);
  expect(
    (await readComposioState(world.home)).accounts.map((account) => account.id),
  ).toEqual(["ca_2", "ca_3", "ca_4", "ca_5"]);
  // Where the list gives ids, a word id names no account here.
  const byWord = await app.post("/api/integrations/disconnect", {
    app: "notion",
    path: "composio",
    account: "cloud",
    confirm: true,
  });
  expect(byWord.status).toBe(409);
  expect(await byWord.json()).toEqual({
    kind: "blocked",
    reason: "account-unknown",
  });
  expect((await readComposioState(world.home)).accounts).toHaveLength(4);
  // After the change the reading again names everything from the list.
  expect(accounts((await overview(app)).value, "notion")).toEqual([
    ["grace@example.com", "ca_2", "connected"],
  ]);
  expect(await lookups()).toEqual([]);
});

// An Environment still on Lazurio's earlier build, 0.4.3-lazurio.1 (decision
// F42, note of 2026-10-19): Settings → Tools reads it as not the build
// Lazurio pins and offers the update there; Integrace asks for nothing,
// since that build already disconnects and names accounts, which is all its
// line and the agents' line say the update brings.
test("an earlier Lazurio build: the update stays in Settings → Tools, Integrace and agents are not asked for it", async () => {
  const { parent, world, app } = await setup(
    {
      composio: {
        lazurioBuild: true,
        removeYes: true,
        version: "0.4.3-lazurio.1",
        accounts: [
          {
            id: "ca_1",
            toolkit: "gmail",
            status: "ACTIVE",
            alias: "work",
            word_id: "castle",
            display_name: "ada@example.com",
          },
        ],
      },
    },
    { tools: ["composio"] },
  );
  const status = (await (await app.post("/api/tools/status", {})).json()) as {
    tools: { name: string }[];
  };
  expect(status.tools.find((tool) => tool.name === "composio")).toMatchObject({
    installed: true,
    version: "0.4.3-lazurio.1",
    pinned: composioBuild.version,
    standardPath: true,
  });
  expect(composioBuild.version).not.toBe("0.4.3-lazurio.1");
  const { value } = await overview(app);
  expect(value.composio.ready).toBe(true);
  expect(value.composio.disconnect).toBe(true);
  expect(value.composio.update).toBe(false);
  expect(
    value.apps.find((item) => item.id === "gmail")?.accounts[0]?.label,
  ).toBe("work");
  const text = await runIntegrationsCommand(
    ["list", "--folder", join(parent, "Lazurio")],
    {
      identity: embeddedIdentity(),
      platform: process.platform,
      env: { PATH: world.path, HOME: world.home },
      executable: process.execPath,
      executorEndpoint: world.executorHost(),
      executorPresent: true,
    },
  );
  expect(text.code).toBe(0);
  expect(text.stdout).not.toContain("Composio should be updated");
});

async function noKey(
  parent: string,
  world: IntegrationsWorld,
  text: string,
  key: string,
) {
  expect(text).not.toContain(key);
  expect(await filesContaining(join(parent, "Lazurio"), key)).toEqual([]);
  // It reached Executor, and only there.
  expect(JSON.stringify(world.executor.calls)).toContain(key);
}

/** The bodies Executor got for one call, in order. */
const bodiesOf = (world: IntegrationsWorld, method: string, path: string) =>
  world.executor.calls
    .filter((call) => call.method === method && call.path === path)
    .map((call) => call.body as Record<string, unknown>);

test("Vlastní: a command with its arguments, environment variables and working directory; the values go to Executor only", async () => {
  const console = captureConsole();
  try {
    const { parent, world, app } = await setup({ composio: false });
    const token = "envTokenCanary0000000000";
    const region = "envRegionCanary000000000";
    const answer = await app.post("/api/integrations/custom/add", {
      type: "stdio",
      name: "Files",
      command: "npx",
      // One argument per row, as typed: never split, a space kept.
      args: ["-y", "@example/files-mcp", "--root", "/tmp/my files"],
      env: [
        { name: "FILES_TOKEN", value: token },
        { name: "FILES_REGION", value: region },
      ],
      cwd: "~/code",
    });
    const text = await answer.text();
    expect(answer.status).toBe(200);
    expect(JSON.parse(text)).toEqual({ kind: "connected", app: "files" });
    expect(bodiesOf(world, "POST", "/api/mcp/servers")).toEqual([
      {
        transport: "stdio",
        name: "Files",
        command: "npx",
        args: ["-y", "@example/files-mcp", "--root", "/tmp/my files"],
        // `~` is this account's home, which Executor's service shares.
        cwd: `${world.home}/code`,
        env: { FILES_TOKEN: token, FILES_REGION: region },
      },
    ]);
    expect(world.executor.connections).toMatchObject([
      {
        integration: "files",
        template: "env",
        values: { FILES_TOKEN: token, FILES_REGION: region },
      },
    ]);
    const { text: reading, value } = await overview(app);
    // A command's own line and environment are never in the reading.
    expect(value.custom).toMatchObject([
      { id: "files", kind: "command", target: null },
    ]);
    // Its edit form: the configuration and the variables' names only.
    const settings = await app.get("/api/integrations/custom/server?id=files");
    const form = await settings.text();
    expect(settings.status).toBe(200);
    expect(JSON.parse(form)).toEqual({
      kind: "custom-server",
      id: "files",
      type: "stdio",
      name: "Files",
      command: "npx",
      args: ["-y", "@example/files-mcp", "--root", "/tmp/my files"],
      cwd: `${world.home}/code`,
      env: ["FILES_TOKEN", "FILES_REGION"],
    });
    expect(`${reading}${form}`).not.toContain("legacy-env-value");
    for (const key of [token, region])
      await noKey(
        parent,
        world,
        `${text}${reading}${form}${console.text()}`,
        key,
      );
    // The journal names the operation, the server and the outcome only.
    expect(console.text()).toContain("custom-add");
  } finally {
    console.restore();
  }
});

test("Vlastní: a server at a URL with a Bearer token and two headers; the values go to Executor only", async () => {
  const console = captureConsole();
  try {
    const { parent, world, app } = await setup({ composio: false });
    const bearer = "bearerTokenCanary000000000";
    const apiKey = "headerKeyCanary0000000000";
    const endpoint = "https://mcp.invoices.example.test/mcp";
    world.executor.probes.set(endpoint, { requiresOAuth: false });
    const answer = await app.post("/api/integrations/custom/add", {
      type: "http",
      name: "Invoices",
      url: endpoint,
      bearer,
      headers: [
        { name: "X-Api-Key", value: apiKey },
        { name: "X-Region", value: "eu" },
      ],
    });
    const text = await answer.text();
    expect(answer.status).toBe(200);
    expect(JSON.parse(text)).toEqual({ kind: "connected", app: "invoices" });
    // The probe sends what every call will: the token and both headers.
    expect(bodiesOf(world, "POST", "/api/mcp/probe")).toEqual([
      {
        endpoint,
        headers: {
          Authorization: `Bearer ${bearer}`,
          "X-Api-Key": apiKey,
          "X-Region": "eu",
        },
      },
    ]);
    // The server declares the keys by name; their values are its account's.
    expect(bodiesOf(world, "POST", "/api/mcp/servers")).toEqual([
      {
        transport: "remote",
        name: "Invoices",
        endpoint,
        remoteTransport: "auto",
        authenticationTemplate: [
          {
            slug: "apikey",
            type: "apiKey",
            headers: {
              Authorization: ["Bearer ", { type: "variable", name: "token" }],
              "X-Api-Key": [{ type: "variable", name: "header-x-api-key" }],
              "X-Region": [{ type: "variable", name: "header-x-region" }],
            },
          },
        ],
      },
    ]);
    expect(bodiesOf(world, "POST", "/api/connections")).toEqual([
      {
        owner: "org",
        name: "default",
        integration: "invoices",
        template: "apikey",
        values: {
          token: bearer,
          "header-x-api-key": apiKey,
          "header-x-region": "eu",
        },
      },
    ]);
    const { text: reading, value } = await overview(app);
    expect(value.custom).toMatchObject([
      { id: "invoices", kind: "remote", target: endpoint, state: "connected" },
    ]);
    const settings = await app.get(
      "/api/integrations/custom/server?id=invoices",
    );
    const form = await settings.text();
    expect(JSON.parse(form)).toEqual({
      kind: "custom-server",
      id: "invoices",
      type: "http",
      name: "Invoices",
      url: endpoint,
      bearer: true,
      headers: ["X-Api-Key", "X-Region"],
    });
    for (const key of [bearer, apiKey])
      await noKey(
        parent,
        world,
        `${text}${reading}${form}${console.text()}`,
        key,
      );
    // Removing needs an explicit confirmation.
    expect(
      (await app.post("/api/integrations/custom/remove", { id: "invoices" }))
        .status,
    ).toBe(400);
    expect(
      await (
        await app.post("/api/integrations/custom/remove", {
          id: "invoices",
          confirm: true,
        })
      ).json(),
    ).toEqual({ kind: "removed" });
    expect(world.executor.integrations).toEqual([]);
  } finally {
    console.restore();
  }
});

test("Vlastní: a server at a URL without keys that needs a sign-in starts it", async () => {
  const { world, app } = await setup({ composio: false });
  const endpoint = "https://mcp.signin.example.test/mcp";
  world.executor.probes.set(endpoint, { requiresOAuth: true });
  const answer = await app.post("/api/integrations/custom/add", {
    type: "http",
    name: "Sign In",
    url: endpoint,
    headers: [],
  });
  expect(answer.status).toBe(200);
  expect(await answer.json()).toMatchObject({
    kind: "authorize",
    url: expect.stringContaining("https://auth.example.test/authorize"),
  });
  expect(bodiesOf(world, "POST", "/api/mcp/servers")).toMatchObject([
    { transport: "remote", endpoint, auth: { kind: "oauth2" } },
  ]);
  expect(bodiesOf(world, "POST", "/api/oauth/start")).toMatchObject([
    { integration: "sign_in", name: "default", newConnection: true },
  ]);
});

test("Vlastní: an edit keeps what it does not change; changing a key sends every key again", async () => {
  const console = captureConsole();
  try {
    const { parent, world, app } = await setup({
      composio: false,
      executorSeed: { integrations: [notion] },
    });
    const first = "firstValueCanary000000000";
    const second = "secondValueCanary00000000";
    await app.post("/api/integrations/custom/add", {
      type: "stdio",
      name: "Files",
      command: "npx",
      args: ["files-mcp"],
      env: [{ name: "FILES_TOKEN", value: first }],
    });
    const update = (body: Record<string, unknown>) =>
      app.post("/api/integrations/custom/update", {
        id: "files",
        type: "stdio",
        name: "Files",
        command: "npx",
        args: ["files-mcp"],
        env: [{ name: "FILES_TOKEN", value: null }],
        ...body,
      });
    // The name, the arguments and the working directory change in place;
    // the variable is kept as Executor stores it.
    const kept = await update({
      name: "Company files",
      args: ["files-mcp", "--readonly"],
      cwd: "/srv/files",
    });
    expect(kept.status).toBe(200);
    expect(await kept.json()).toEqual({ kind: "saved", app: "files" });
    expect(bodiesOf(world, "PATCH", "/api/integrations/files")).toEqual([
      { name: "Company files" },
    ]);
    expect(bodiesOf(world, "POST", "/api/mcp/servers/files/config")).toEqual([
      {
        config: {
          transport: "stdio",
          command: "npx",
          args: ["files-mcp", "--readonly"],
          cwd: "/srv/files",
          // Set elsewhere, carried through, never shown.
          env: { LEGACY: "legacy-env-value" },
          authenticationTemplate: [
            { slug: "env", kind: "stdio_env", vars: ["FILES_TOKEN"] },
          ],
        },
      },
    ]);
    expect(world.executor.connections).toMatchObject([
      { integration: "files", values: { FILES_TOKEN: first } },
    ]);
    // Another variable changes the account: a kept one is refused, as the
    // page says, and nothing is asked of Executor.
    const calls = world.executor.calls.length;
    const partial = await update({
      env: [
        { name: "FILES_TOKEN", value: null },
        { name: "FILES_REGION", value: "eu" },
      ],
    });
    expect(partial.status).toBe(400);
    expect(
      world.executor.calls.slice(calls).map((call) => call.method),
    ).toEqual(["GET", "GET", "GET"]);
    const again = await update({
      env: [
        { name: "FILES_TOKEN", value: second },
        { name: "FILES_REGION", value: "eu" },
      ],
    });
    expect(await again.json()).toEqual({ kind: "saved", app: "files" });
    expect(world.executor.connections).toMatchObject([
      {
        integration: "files",
        template: "env",
        values: { FILES_TOKEN: second, FILES_REGION: "eu" },
      },
    ]);
    expect(
      bodiesOf(world, "POST", "/api/mcp/servers/files/config").at(-1),
    ).toMatchObject({
      config: {
        authenticationTemplate: [
          {
            slug: "env",
            kind: "stdio_env",
            vars: ["FILES_TOKEN", "FILES_REGION"],
          },
        ],
      },
    });
    // Without variables the account carries no key.
    expect(await (await update({ env: [] })).json()).toEqual({
      kind: "saved",
      app: "files",
    });
    expect(world.executor.connections).toMatchObject([
      { integration: "files", template: "none" },
    ]);
    expect(world.executor.connections[0]?.values).toBeUndefined();
    // The type stays: another is refused; so is a catalog app's server.
    const typed = await app.post("/api/integrations/custom/update", {
      id: "files",
      type: "http",
      name: "Files",
      url: "https://files.example.test/mcp",
      headers: [],
    });
    expect([typed.status, await typed.json()]).toEqual([
      409,
      { kind: "blocked", reason: "type-fixed" },
    ]);
    const notionEdit = await app.post("/api/integrations/custom/update", {
      id: "notion-com",
      type: "http",
      name: "Notion",
      url: "https://mcp.notion.com/mcp",
      headers: [],
    });
    expect(await notionEdit.json()).toEqual({
      kind: "blocked",
      reason: "account-unknown",
    });
    expect(
      await (
        await app.get("/api/integrations/custom/server?id=notion-com")
      ).json(),
    ).toEqual({ kind: "blocked", reason: "account-unknown" });
    for (const key of [first, second])
      await noKey(parent, world, console.text(), key);
  } finally {
    console.restore();
  }
});

test("Vlastní: an edited address keeps its stored key in the query; the token is kept or sent again with every header; a new address takes every key again", async () => {
  const { world, app } = await setup({ composio: false });
  const stored = "https://mcp.query.example.test/mcp?key=queryCanary000000";
  const shown = "https://mcp.query.example.test/mcp";
  const bearer = "keptBearerCanary000000000";
  world.executor.probes.set(stored, { requiresOAuth: false });
  await app.post("/api/integrations/custom/add", {
    type: "http",
    name: "Query",
    url: stored,
    bearer,
    headers: [],
  });
  const form = await (
    await app.get("/api/integrations/custom/server?id=query")
  ).text();
  // The page never sees the query, which may carry a key.
  expect(JSON.parse(form)).toMatchObject({ url: shown, bearer: true });
  expect(form).not.toContain("queryCanary");
  const update = (body: Record<string, unknown>) =>
    app.post("/api/integrations/custom/update", {
      id: "query",
      type: "http",
      name: "Query",
      url: shown,
      bearer: null,
      headers: [],
      ...body,
    });
  // The address as shown and the token as stored: nothing changes.
  expect(await (await update({})).json()).toEqual({
    kind: "saved",
    app: "query",
  });
  expect(bodiesOf(world, "POST", "/api/mcp/servers/query/config")).toEqual([]);
  expect(world.executor.integrations[0]?.endpoint).toBe(stored);
  // A header beside the kept token: the token must come again.
  expect(
    (await update({ headers: [{ name: "X-Team", value: "a" }] })).status,
  ).toBe(400);
  const newer = "newBearerCanary0000000000";
  expect(
    await (
      await update({ bearer: newer, headers: [{ name: "X-Team", value: "a" }] })
    ).json(),
  ).toEqual({ kind: "saved", app: "query" });
  expect(world.executor.connections).toMatchObject([
    {
      integration: "query",
      template: "apikey",
      values: { token: newer, "header-x-team": "a" },
    },
  ]);
  expect(world.executor.integrations[0]?.endpoint).toBe(stored);
  // A new address is a change of the keys (review 5485707630): with the
  // stored ones kept it is refused before anything is probed or changed,
  // here at an address that refuses a probe without its token.
  const moved = "https://mcp.moved.example.test/mcp";
  world.executor.probes.set(moved, {
    requiresOAuth: false,
    authorization: `Bearer ${newer}`,
  });
  const before = world.executor.calls.length;
  const kept = await update({
    url: moved,
    bearer: null,
    headers: [{ name: "X-Team", value: null }],
  });
  expect([kept.status, await kept.json()]).toEqual([
    400,
    { error: "keys-required" },
  ]);
  // Only the reading of the server: no probe, no config, no account.
  expect(world.executor.calls.slice(before).map((call) => call.method)).toEqual(
    ["GET", "GET", "GET"],
  );
  expect(world.executor.integrations[0]?.endpoint).toBe(stored);
  // Every key typed again: the new address is probed with them, the
  // server moves, and its account is made anew with them.
  const again = await update({
    url: moved,
    bearer: newer,
    headers: [{ name: "X-Team", value: "b" }],
  });
  expect(await again.json()).toEqual({ kind: "saved", app: "query" });
  expect(bodiesOf(world, "POST", "/api/mcp/probe").at(-1)).toEqual({
    endpoint: moved,
    headers: { Authorization: `Bearer ${newer}`, "X-Team": "b" },
  });
  expect(world.executor.integrations[0]?.endpoint).toBe(moved);
  expect(world.executor.connections).toMatchObject([
    {
      integration: "query",
      template: "apikey",
      values: { token: newer, "header-x-team": "b" },
    },
  ]);
});

test("Vlastní: a new address for a server without stored keys is probed and saved as before", async () => {
  const { world, app } = await setup({ composio: false });
  const first = "https://mcp.open.example.test/mcp";
  const moved = "https://mcp.open-moved.example.test/mcp";
  world.executor.probes.set(first, { requiresOAuth: false });
  world.executor.probes.set(moved, { requiresOAuth: false });
  await app.post("/api/integrations/custom/add", {
    type: "http",
    name: "Open",
    url: first,
    headers: [],
  });
  const answer = await app.post("/api/integrations/custom/update", {
    id: "open",
    type: "http",
    name: "Open",
    url: moved,
    headers: [],
  });
  expect(await answer.json()).toEqual({ kind: "saved", app: "open" });
  expect(bodiesOf(world, "POST", "/api/mcp/probe").at(-1)).toEqual({
    endpoint: moved,
  });
  expect(world.executor.integrations[0]?.endpoint).toBe(moved);
  expect(world.executor.connections).toMatchObject([
    { integration: "open", template: "none" },
  ]);
  // One that signs in signs in again at its new address.
  const signIn = "https://mcp.signin.example.test/mcp";
  const signInMoved = "https://mcp.signin-moved.example.test/mcp";
  world.executor.probes.set(signIn, { requiresOAuth: true });
  world.executor.probes.set(signInMoved, { requiresOAuth: true });
  await app.post("/api/integrations/custom/add", {
    type: "http",
    name: "Sign In",
    url: signIn,
    headers: [],
  });
  const resigned = await app.post("/api/integrations/custom/update", {
    id: "sign_in",
    type: "http",
    name: "Sign In",
    url: signInMoved,
    headers: [],
  });
  expect(await resigned.json()).toMatchObject({ kind: "authorize" });
  expect(world.executor.integrations.at(-1)?.endpoint).toBe(signInMoved);
});

test("Vlastní: what the form refuses, the route refuses before Executor is asked", async () => {
  const { world, app } = await setup({ composio: false });
  const http = {
    type: "http",
    name: "x",
    url: "https://x.example.test/mcp",
    headers: [],
  };
  const stdio = {
    type: "stdio",
    name: "x",
    command: "run",
    args: [],
    env: [],
  };
  const refused: [Record<string, unknown>, unknown][] = [
    [{ ...http, name: "" }, [{ field: "name", problem: "required" }]],
    [{ ...http, name: "a\nb" }, [{ field: "name", problem: "invalid" }]],
    [
      { ...http, url: "ftp://x.example.test/" },
      [{ field: "url", problem: "invalid" }],
    ],
    [
      { ...http, url: "http://x.example.test/mcp" },
      [{ field: "url", problem: "insecure" }],
    ],
    [
      { ...http, headers: [{ name: "Bad Header", value: "v" }] },
      [{ field: "header", index: 0, part: "name", problem: "invalid" }],
    ],
    [
      {
        ...http,
        headers: [
          { name: "X-A", value: "v" },
          { name: "x-a", value: "w" },
        ],
      },
      [{ field: "header", index: 1, part: "name", problem: "duplicate" }],
    ],
    [
      {
        ...http,
        bearer: "t",
        headers: [{ name: "authorization", value: "v" }],
      },
      [{ field: "header", index: 0, part: "name", problem: "taken" }],
    ],
    [
      { ...http, headers: [{ name: "X-A", value: "v\r\nX-B: w" }] },
      [{ field: "header", index: 0, part: "value", problem: "invalid" }],
    ],
    [{ ...http, bearer: "" }, [{ field: "bearer", problem: "required" }]],
    [{ ...http, bearer: null }, [{ field: "bearer", problem: "required" }]],
    [
      { ...stdio, env: [{ name: "1BAD", value: "v" }] },
      [{ field: "env", index: 0, part: "name", problem: "invalid" }],
    ],
    [
      { ...stdio, env: [{ name: "OK", value: null }] },
      [{ field: "env", index: 0, part: "value", problem: "required" }],
    ],
    [{ ...stdio, command: " " }, [{ field: "command", problem: "required" }]],
    [{ ...stdio, cwd: "code" }, [{ field: "cwd", problem: "invalid" }]],
  ];
  for (const [body, problems] of refused) {
    const answer = await app.post("/api/integrations/custom/add", body);
    expect([body, answer.status, await answer.json()]).toEqual([
      body,
      400,
      { error: "invalid-server", problems },
    ]);
  }
  // Plain http on this computer is allowed.
  world.executor.probes.set("http://127.0.0.1:8931/mcp", {
    requiresOAuth: false,
  });
  expect(
    (
      await app.post("/api/integrations/custom/add", {
        ...http,
        name: "Local",
        url: "http://127.0.0.1:8931/mcp",
      })
    ).status,
  ).toBe(200);
  const calls = world.executor.calls.length;
  // Another shape: a field of the other type, a missing one, an unknown one.
  for (const body of [
    { ...http, command: "run" },
    { ...stdio, args: undefined },
    { ...stdio, args: ["a", 1] },
    { ...http, headers: [{ name: "X", value: "v", extra: true }] },
    { ...http, type: "sse" },
    { ...http, kind: "url" },
  ])
    expect((await app.post("/api/integrations/custom/add", body)).status).toBe(
      400,
    );
  expect(world.executor.calls.length).toBe(calls);
  // An edit names its server; the reading of one asks for exactly one id.
  expect(
    (await app.post("/api/integrations/custom/update", { ...http })).status,
  ).toBe(400);
  expect((await app.get("/api/integrations/custom/server")).status).toBe(400);
  expect(
    (await app.get("/api/integrations/custom/server?id=a&id=b")).status,
  ).toBe(400);
  expect(
    await (await app.get("/api/integrations/custom/server?id=missing")).json(),
  ).toEqual({ kind: "blocked", reason: "account-unknown" });
});

test("`lazurio integrations list --json` answers what the route answers", async () => {
  const { parent, world, app } = await setup(
    {
      composio: {
        accounts: [
          {
            id: "ca_1",
            toolkit: "wispr_flow",
            status: "ACTIVE",
            alias: null,
            word_id: "meadow",
          },
        ],
      },
      executorSeed: {
        integrations: [notion],
        connections: [
          {
            owner: "org",
            name: "default",
            integration: "notion-com",
            template: "oauth2",
            identityLabel: "person@example.test",
            health: "expired",
          },
        ],
      },
    },
    { tools: ["composio"] },
  );
  const { value } = await overview(app);
  const cli = await runIntegrationsCommand(
    ["list", "--json", "--folder", join(parent, "Lazurio")],
    {
      identity: embeddedIdentity(),
      platform: process.platform,
      env: { PATH: world.path, HOME: world.home },
      executable: process.execPath,
      executorEndpoint: world.executorHost(),
      executorPresent: true,
      now: () => new Date("2026-10-09T12:00:00.000Z"),
    },
  );
  expect(cli.code).toBe(0);
  expect(JSON.parse(cli.stdout ?? "")).toEqual(value);
  expect(cli.stdout).not.toContain(tokenCanary);
  const text = await runIntegrationsCommand(
    ["list", "--folder", join(parent, "Lazurio")],
    {
      identity: embeddedIdentity(),
      platform: process.platform,
      env: { PATH: world.path, HOME: world.home },
      executable: process.execPath,
      executorEndpoint: world.executorHost(),
      executorPresent: true,
    },
  );
  // Its only account's sign-in expired: not connected, but the agent sees
  // that the person has to sign in again.
  expect(text.stdout).toContain(
    "Not working (the user signs in again on the card):\n  Notion (notion) — directly (Executor) · expired",
  );
  expect(text.stdout).toContain("GitHub (github) — through gh");
  // An app the catalog does not know, by its name and its toolkit, and
  // where the person connects such apps (decision F42, addendum of
  // 2026-10-14).
  expect(text.stdout).toContain("  Wispr Flow (wispr_flow) — through Composio");
  expect(text.stdout).toContain(
    "An app the catalog does not list is connected by the user in Composio (https://dashboard.composio.dev/First/~/connect/apps); it then shows here.",
  );
  // Composio's own CLI, not the build Lazurio pins: the person updates it;
  // an agent only on their instruction (decision F42, addendum (b) of
  // 2026-10-14).
  expect(value.composio.update).toBe(true);
  expect(text.stdout).toContain(
    "Composio should be updated: the user does it in the Launchpad under Settings → Tools (Update); until then accounts cannot be disconnected from here and some have no name. Do not update it yourself unless they ask you to.",
  );
  // A wrong invocation is a usage error.
  expect(
    (
      await runIntegrationsCommand(["list", "--folder", "relative"], {
        identity: embeddedIdentity(),
        platform: process.platform,
        env: {},
        executable: process.execPath,
      })
    ).code,
  ).toBe(2);
});
