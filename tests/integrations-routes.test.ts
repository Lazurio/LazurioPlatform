import { afterEach, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runIntegrationsCommand } from "../src/integrations/cli";
import type { IntegrationsOverview } from "../src/integrations/model";
import { embeddedIdentity } from "../src/update/identity";
import {
  captureConsole,
  composioCalls,
  filesContaining,
  type IntegrationsWorld,
  integrationsWorld,
  readComposioState,
  setAccountStatus,
  tokenCanary,
  worldLaunchpad,
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
            // A toolkit the catalog does not know is listed all the same.
            {
              id: "ca_3",
              toolkit: "todoist",
              status: "INITIATED",
              alias: null,
              word_id: "stone",
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
    expect(app_("salesforce")).toMatchObject({
      connected: true,
      accounts: [{ state: "expired" }],
    });
    // Not in the catalog, connected in Composio: listed by its toolkit.
    expect(app_("todoist")?.accounts).toEqual([
      {
        path: "composio",
        selector: "stone",
        label: null,
        state: "pending",
        spare: false,
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
  // GitHub still goes through gh; Notion has no account, its path stays.
  expect(value.apps.find((item) => item.id === "github")?.connected).toBe(true);
  expect(value.apps.find((item) => item.id === "notion")).toMatchObject({
    connected: false,
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
  expect(value.apps.find((item) => item.id === "github")).toMatchObject({
    connected: false,
  });
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

test("Composio not signed in: the card's path asks for its sign-in first", async () => {
  const { app } = await setup(
    { composio: { signedIn: false } },
    { tools: ["composio"] },
  );
  const { value } = await overview(app);
  expect(value.sources.composio).toBe("signed-out");
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
  // Composio 0.4.x asks for a confirmation no Launchpad answers for a person.
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
  expect(
    await (await app.post("/api/integrations/disconnect", composio)).json(),
  ).toEqual({ kind: "disconnected" });
  expect((await readComposioState(world.home)).accounts).toEqual([]);
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

test("Vlastní: a server at a URL with a header key; the key goes to Executor only", async () => {
  const console = captureConsole();
  try {
    const { parent, world, app } = await setup({ composio: false });
    const key = "headerKeyCanary0000000000";
    world.executor.probes.set("https://mcp.invoices.example.test/mcp", {
      requiresOAuth: false,
    });
    const answer = await app.post("/api/integrations/custom/add", {
      name: "Invoices",
      kind: "url",
      target: "https://mcp.invoices.example.test/mcp",
      secretName: "Authorization",
      secretValue: key,
    });
    const text = await answer.text();
    expect(answer.status).toBe(200);
    expect(JSON.parse(text)).toEqual({ kind: "connected", app: "invoices" });
    expect(world.executor.connections).toMatchObject([
      { integration: "invoices", template: "header", secret: key },
    ]);
    const { text: reading, value } = await overview(app);
    expect(value.custom).toMatchObject([
      { id: "invoices", kind: "remote", state: "connected", tools: 3 },
    ]);
    await noKey(parent, world, `${text}${reading}${console.text()}`, key);
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

test("Vlastní: a command with its variable; a catalog app's integration is never removed as custom", async () => {
  const { parent, world, app } = await setup({
    composio: false,
    executorSeed: { integrations: [notion] },
  });
  const key = "variableKeyCanary000000";
  const answer = await app.post("/api/integrations/custom/add", {
    name: "Files",
    kind: "command",
    target: 'npx -y "@example/files-mcp" --root /tmp',
    secretName: "FILES_TOKEN",
    secretValue: key,
  });
  const text = await answer.text();
  expect(JSON.parse(text)).toEqual({ kind: "connected", app: "files" });
  expect(world.executor.integrations.at(-1)).toMatchObject({
    transport: "stdio",
    command: "npx",
    args: ["-y", "@example/files-mcp", "--root", "/tmp"],
  });
  const { text: reading, value } = await overview(app);
  // A command's own line and environment are never shown.
  expect(value.custom).toMatchObject([
    { id: "files", kind: "command", target: null },
  ]);
  expect(reading).not.toContain("legacy-env-value");
  await noKey(parent, world, `${text}${reading}`, key);
  expect(
    await (
      await app.post("/api/integrations/custom/remove", {
        id: "notion-com",
        confirm: true,
      })
    ).json(),
  ).toEqual({ kind: "blocked", reason: "account-unknown" });
  // Bad input is refused before Executor is asked.
  for (const body of [
    { name: "", kind: "url", target: "https://x.example.test/mcp" },
    { name: "x", kind: "url", target: "ftp://x.example.test/" },
    {
      name: "x",
      kind: "url",
      target: "https://x.example.test/",
      secretName: "Bad Header",
      secretValue: "v",
    },
    {
      name: "x",
      kind: "command",
      target: "run",
      secretName: "1BAD",
      secretValue: "v",
    },
    { name: "x", kind: "command", target: "run", secretName: "OK" },
  ])
    expect((await app.post("/api/integrations/custom/add", body)).status).toBe(
      400,
    );
});

test("`lazurio integrations list --json` answers what the route answers", async () => {
  const { parent, world, app } = await setup(
    {
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
    },
  );
  expect(text.stdout).toContain(
    "Notion (notion) — directly (Executor) · expired",
  );
  expect(text.stdout).toContain("GitHub (github) — through gh");
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
