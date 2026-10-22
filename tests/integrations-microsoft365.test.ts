import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PresetName } from "../src/folder/presets";
import { recordOrganizationSettings } from "../src/folder/update-profile";
import { mfaRequired } from "../src/integrations/connect";
import {
  type Microsoft365Part,
  microsoft365AuthTemplate,
  microsoft365Parts,
  microsoft365PartsOf,
  microsoft365Scopes,
  microsoft365SpecId,
  microsoft365SpecSource,
} from "../src/integrations/microsoft365";
import {
  applyMicrosoft365,
  buildMicrosoft365Spec,
  executorSpecCharsMax,
  Microsoft365SpecError,
  mergeMicrosoft365Specs,
  microsoft365Description,
  readBounded,
} from "../src/integrations/microsoft365-executor";
import type { IntegrationsOverview } from "../src/integrations/model";
import {
  forgetMicrosoftSignInOf,
  microsoftSignInOrigins,
} from "../src/launchpad/server";
import { type FakeIntegration, mfaRefusal } from "./fixtures/fake-executor-api";
import {
  integrationsWorld,
  worldLaunchpad,
} from "./fixtures/integrations-world";
import { bindings } from "./fixtures/machine-bindings";

// The Organization's Microsoft 365 company app (DEV-6626 task 685, decision
// F42 addendum (c) of 2026-10-14) as the Organization Admin simplified it:
// one card, one Microsoft sign-in per account that connects mail, calendar,
// files and sites at once, several accounts side by side, "Odpojit" the only
// disconnect. On its real consumer, the Launchpad's Integrace over a
// synthetic Executor 1.6.10. A fictional tenant, app and addresses only.

const tenantId = "00000000-0000-4000-8000-0000000000aa";
const clientId = "00000000-0000-4000-8000-0000000000bb";
const returnAddress =
  "https://launchpad.vm-01.contoso.lazurio.io/api/integrations/oauth/callback";
const environmentView = (n: number) =>
  `https://browser.vm-01.contoso.lazurio.io/t/${String(n).repeat(32)}`;
const allApps = ["outlook", "one_drive", "share_point"];
const setting = (callbacks: readonly string[] = [returnAddress]) => ({
  tenant_id: tenantId,
  client_id: clientId,
  apps: allApps,
  callbacks: [...callbacks],
});
const authorize = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize`;
const token = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
const card = "microsoft_365";

// Small specs of the Graph shape, and parts pinned to their bytes, so that
// building and applying run without the network.
const synthetic = (
  paths: Record<string, unknown>,
  schemas: Record<string, unknown>,
  scopes: string[],
) =>
  JSON.stringify({
    openapi: "3.0.4",
    info: { title: "Part", version: "v1.0" },
    servers: [{ url: "https://graph.microsoft.com/v1.0" }],
    paths,
    components: {
      schemas,
      securitySchemes: {
        microsoftOAuth2: {
          type: "oauth2",
          flows: {
            authorizationCode: {
              authorizationUrl:
                "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
              tokenUrl:
                "https://login.microsoftonline.com/common/oauth2/v2.0/token",
              scopes: Object.fromEntries(scopes.map((s) => [s, ""])),
            },
          },
        },
      },
    },
    security: [{ microsoftOAuth2: scopes }],
  });
const shared = { type: "object", properties: { id: { type: "string" } } };
const texts: Record<string, string> = {
  mail: synthetic(
    { "/me/messages": { get: { operationId: "listMessages" } } },
    { "microsoft.graph.entity": shared },
    ["Mail.ReadWrite", "Mail.Send"],
  ),
  calendar: synthetic(
    { "/me/events": { get: { operationId: "listEvents" } } },
    { "microsoft.graph.entity": shared },
    ["Calendars.ReadWrite"],
  ),
  files: synthetic(
    { "/me/drive": { get: { operationId: "getDrive" } } },
    { "microsoft.graph.entity": shared },
    ["Files.ReadWrite.All", "Sites.ReadWrite.All"],
  ),
  sites: synthetic(
    { "/sites/{site-id}": { get: { operationId: "getSite" } } },
    { "microsoft.graph.entity": shared },
    ["Sites.ReadWrite.All"],
  ),
};
const sha = (text: string) =>
  createHash("sha256").update(Buffer.from(text)).digest("hex");
const syntheticParts: Microsoft365Part[] = Object.values(microsoft365Parts).map(
  (item) => ({
    ...item,
    url: `https://specs.example.test/${item.key}.json`,
    sha256: sha(texts[item.key] as string),
  }),
);
const fetched: string[] = [];
const fetchSynthetic = async (url: string) => {
  fetched.push(url);
  const key = /\/([a-z]+)\.json$/.exec(url)?.[1] ?? "";
  const text = texts[key];
  if (text === undefined) throw new Error("not found");
  return new Uint8Array(Buffer.from(text));
};

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  fetched.splice(0);
});

/** Executor holding the company app's integration as this release builds
 * it for the setting, so a connect downloads nothing. */
const seeded = (): FakeIntegration => {
  const parts = microsoft365PartsOf(allApps);
  return {
    slug: "m365",
    name: "Microsoft 365",
    kind: "openapi",
    transport: "remote",
    auth: "oauth2",
    tools: 5,
    description: microsoft365Description(microsoft365SpecId(parts)),
    authenticationTemplate: [
      {
        ...microsoft365AuthTemplate(parts, tenantId),
        scopes: [...microsoft365Scopes(parts)],
      },
    ],
  };
};

async function setup(
  options: Readonly<{
    preset?: PresetName;
    callbacks?: readonly string[];
    governed?: boolean;
    /** Composio allowed by the Organization (default: not). */
    composio?: boolean;
    seed?: FakeIntegration[];
  }> = {},
) {
  const parent = await realpath(
    await mkdtemp(join(tmpdir(), "lazurio-microsoft365-")),
  );
  cleanups.push(() => rm(parent, { recursive: true, force: true }));
  const world = await integrationsWorld(parent, {
    composio: false,
    executorSeed: { integrations: options.seed ?? [seeded()] },
  });
  cleanups.push(() => world.executor.stop());
  const opened: string[] = [];
  const forgotten: string[] = [];
  const preset = options.preset ?? "hosted-organization-personal";
  const app = await worldLaunchpad(parent, world, {
    locale: "cs",
    handover: {
      preset,
      machine:
        preset === "hosted-organization-team"
          ? bindings.team
          : preset === "hosted-organization-steward"
            ? bindings.automated
            : preset === "hosted-personal"
              ? bindings.personal
              : bindings.organization,
    },
    seams: {
      oauthCallback: returnAddress,
      environmentBrowser: async (url) => {
        opened.push(url);
        return { view: environmentView(opened.length) };
      },
      forgetMicrosoftSignIn: async () => {
        forgotten.push("forgotten");
        return true;
      },
    },
  });
  cleanups.push(() => app.close());
  if (preset !== "hosted-personal") {
    const recorded = await recordOrganizationSettings(app.folder, {
      integrations: {
        composio: { allowed: options.composio ?? false },
        ...(options.governed === false
          ? {}
          : { microsoft365: setting(options.callbacks) }),
      },
    });
    expect(recorded.kind).toBe("updated");
  }
  return { parent, world, app, opened, forgotten };
}

async function overview(app: Awaited<ReturnType<typeof setup>>["app"]) {
  const answer = await app.get("/api/integrations?refresh=1");
  expect(answer.status).toBe(200);
  return (await answer.json()) as IntegrationsOverview;
}

async function settled(
  app: Awaited<ReturnType<typeof setup>>["app"],
  session: string,
): Promise<Record<string, unknown>> {
  let progress: Record<string, unknown> = {};
  for (let tries = 0; tries < 100; tries += 1) {
    progress = (await (
      await app.post("/api/integrations/poll", { session })
    ).json()) as Record<string, unknown>;
    if (progress.kind !== "pending") break;
    await Bun.sleep(30);
  }
  return progress;
}

const calls = (
  world: Awaited<ReturnType<typeof setup>>["world"],
  method: string,
  path: string,
) =>
  world.executor.calls.filter(
    (call) => call.method === method && call.path === path,
  );

/** A return of the person's browser, a redirect never followed: the test
 * never reaches Microsoft. */
const returned = (
  app: Awaited<ReturnType<typeof setup>>["app"],
  path: string,
) =>
  fetch(new URL(path, app.url), {
    redirect: "manual",
    headers: { Authorization: `Bearer ${app.url.hash.slice(1)}` },
  });

test("the setting's apps choose the parts and one sign-in's scopes: least privilege, never sending", () => {
  expect(microsoft365SpecSource.commit).toMatch(/^[0-9a-f]{40}$/);
  const keys = (apps: string[]) =>
    microsoft365PartsOf(apps).map((item) => item.key);
  expect(keys(["outlook"])).toEqual(["mail", "calendar"]);
  expect(keys(["one_drive"])).toEqual(["files"]);
  // SharePoint walks a library's folders with the files' drive items.
  expect(keys(["share_point"])).toEqual(["files", "sites"]);
  expect(keys(allApps)).toEqual(["mail", "calendar", "files", "sites"]);
  expect(microsoft365Scopes(microsoft365PartsOf(allApps))).toEqual([
    "openid",
    "profile",
    "email",
    "offline_access",
    "User.Read",
    "Mail.ReadWrite",
    "Calendars.ReadWrite",
    "Files.ReadWrite.All",
    "Sites.Read.All",
  ]);
  for (const item of Object.values(microsoft365Parts)) {
    expect(item.url).toStartWith(
      `https://raw.githubusercontent.com/UsefulSoftwareCo/integrations/${microsoft365SpecSource.commit}/public/specs/microsoft-graph/`,
    );
    expect(item.sha256).toMatch(/^[0-9a-f]{64}$/);
  }
  // Another set of apps is another document.
  expect(microsoft365SpecId(microsoft365PartsOf(["outlook"]))).not.toBe(
    microsoft365SpecId(microsoft365PartsOf(allApps)),
  );
});

test("the parts merge into one document: every path, a shared component once, one scheme of the union", () => {
  const document = JSON.parse(
    mergeMicrosoft365Specs(
      Object.entries(texts).map(([key, text]) => ({ key, text })),
      syntheticParts,
    ),
  );
  expect(Object.keys(document.paths).sort()).toEqual([
    "/me/drive",
    "/me/events",
    "/me/messages",
    "/sites/{site-id}",
  ]);
  expect(document.components.schemas).toEqual({
    "microsoft.graph.entity": shared,
  });
  const scheme = document.components.securitySchemes.microsoftOAuth2;
  expect(Object.keys(scheme.flows.authorizationCode.scopes)).toEqual([
    ...microsoft365Scopes(syntheticParts),
  ]);
  expect(document.security).toEqual([
    { microsoftOAuth2: [...microsoft365Scopes(syntheticParts)] },
  ]);
  // The curated specs' own scopes never reach the document.
  for (const scope of ["Mail.Send", "Sites.ReadWrite.All"])
    expect(JSON.stringify(document)).not.toContain(scope);
  expect(JSON.stringify(document)).not.toContain("/common/");
});

test("a real conflict, an invalid part or a document too large for Executor fails clearly", () => {
  const merge = (overrides: Record<string, string>, charsMax?: number) =>
    mergeMicrosoft365Specs(
      Object.entries({ ...texts, ...overrides }).map(([key, text]) => ({
        key,
        text,
      })),
      syntheticParts,
      charsMax,
    );
  const failure = (run: () => unknown) => {
    try {
      run();
    } catch (error) {
      return error instanceof Microsoft365SpecError ? error.detail : "other";
    }
    return "none";
  };
  // The same path described differently.
  expect(
    failure(() =>
      merge({
        calendar: synthetic(
          { "/me/messages": { get: { operationId: "other" } } },
          {},
          [],
        ),
      }),
    ),
  ).toBe("spec-conflict");
  // The same component described differently.
  expect(
    failure(() =>
      merge({
        files: synthetic(
          {},
          { "microsoft.graph.entity": { type: "string" } },
          [],
        ),
      }),
    ),
  ).toBe("spec-conflict");
  expect(failure(() => merge({ sites: "{not json" }))).toBe("spec-invalid");
  expect(failure(() => merge({}, 100))).toBe("spec-too-large");
  expect(executorSpecCharsMax).toBe(32 * 1024 * 1024);
});

test("every part is checked against its pinned SHA-256 before anything is merged", async () => {
  await expect(
    buildMicrosoft365Spec(syntheticParts, fetchSynthetic),
  ).resolves.toContain("/me/messages");
  const tampered = syntheticParts.map((item) =>
    item.key === "files" ? { ...item, sha256: "0".repeat(64) } : item,
  );
  await expect(
    buildMicrosoft365Spec(tampered, fetchSynthetic),
  ).rejects.toMatchObject({ detail: "spec-mismatch" });
  await expect(
    buildMicrosoft365Spec(syntheticParts, async () => {
      throw new Error("offline");
    }),
  ).rejects.toMatchObject({ detail: "spec-unavailable" });
});

// The pinned files themselves, where a maintainer has them on disk
// (`LAZURIO_M365_SPECS=<directory of mail.json, calendar.json, files.json,
// sites.json>`): their hashes, and the merged document within what Executor
// parses.
test.skipIf(process.env.LAZURIO_M365_SPECS === undefined)(
  "the four pinned specs merge within Executor's 32 MiB",
  async () => {
    const directory = process.env.LAZURIO_M365_SPECS as string;
    const parts = microsoft365PartsOf(allApps);
    const text = await buildMicrosoft365Spec(parts, async (url) =>
      readFile(join(directory, url.slice(url.lastIndexOf("/") + 1))),
    );
    expect(text.length).toBeLessThan(executorSpecCharsMax);
    console.log(
      JSON.stringify({
        mergedChars: text.length,
        paths: Object.keys(JSON.parse(text).paths).length,
      }),
    );
  },
);

test("applying adds one integration from the merged blob with the tenant's template and one public client, then changes nothing", async () => {
  const { world } = await setup({ governed: false, seed: [] });
  const executor = world.executorHost();
  expect(
    await applyMicrosoft365(
      executor,
      setting(),
      fetchSynthetic,
      syntheticParts,
    ),
  ).toEqual({ outcome: "applied", detail: null });
  const added = calls(world, "POST", "/api/openapi/specs").map(
    (call) => call.body as Record<string, unknown>,
  );
  expect(added).toHaveLength(1);
  expect(added[0]).toMatchObject({
    slug: "m365",
    name: "Microsoft 365",
    description: microsoft365Description(microsoft365SpecId(syntheticParts)),
    spec: { kind: "blob" },
    authenticationTemplate: [
      {
        slug: "microsoft365",
        kind: "oauth2",
        authorizationUrl: authorize,
        tokenUrl: token,
        resource: null,
        scopes: [...microsoft365Scopes(syntheticParts)],
      },
    ],
  });
  expect(
    Object.keys(
      JSON.parse(
        (added[0]?.spec as { value: string } | undefined)?.value ?? "{}",
      ).paths,
    ),
  ).toHaveLength(4);
  expect(world.executor.clients).toEqual([
    {
      owner: "org",
      slug: "microsoft365",
      authorizationUrl: authorize,
      tokenUrl: token,
      grant: "authorization_code",
      clientId,
      secret: false,
    },
  ]);
  expect(calls(world, "POST", "/api/oauth/clients")[0]?.body).toMatchObject({
    clientSecret: "",
    resource: null,
  });
  // Idempotent: the same setting again downloads and writes nothing.
  const before = world.executor.calls.length;
  fetched.splice(0);
  expect(
    await applyMicrosoft365(
      executor,
      setting(),
      fetchSynthetic,
      syntheticParts,
    ),
  ).toEqual({ outcome: "applied", detail: null });
  expect(fetched).toEqual([]);
  expect(
    world.executor.calls
      .slice(before)
      .filter((call) => call.method !== "GET")
      .map((call) => call.path),
  ).toEqual([]);
});

test("other apps rebuild the document in place, another tenant replaces the template and the client, connections stay", async () => {
  const { world } = await setup({ governed: false, seed: [] });
  const executor = world.executorHost();
  const outlook = syntheticParts.filter((item) =>
    ["mail", "calendar"].includes(item.key),
  );
  await applyMicrosoft365(
    executor,
    { ...setting(), apps: ["outlook"] },
    fetchSynthetic,
    outlook,
  );
  world.executor.connections.push({
    owner: "org",
    name: "default",
    integration: "m365",
    template: "microsoft365",
    identityLabel: "ada@contoso.example",
    health: "healthy",
  });
  const other = "00000000-0000-4000-8000-0000000000cc";
  const before = world.executor.calls.length;
  expect(
    await applyMicrosoft365(
      executor,
      { ...setting(), tenant_id: other, client_id: other },
      fetchSynthetic,
      syntheticParts,
    ),
  ).toEqual({ outcome: "applied", detail: null });
  expect(
    world.executor.calls
      .slice(before)
      .filter((call) => call.method !== "GET")
      .map((call) => `${call.method} ${call.path}`),
  ).toEqual([
    "POST /api/openapi/integrations/m365/spec",
    "PATCH /api/integrations/m365",
    "POST /api/openapi/integrations/m365/config",
    "POST /api/oauth/clients",
  ]);
  const integration = world.executor.integrations.find(
    (item) => item.slug === "m365",
  );
  expect(
    Object.keys(JSON.parse(integration?.specBlob ?? "{}").paths),
  ).toHaveLength(4);
  expect(integration?.authenticationTemplate?.[0]).toMatchObject({
    authorizationUrl: `https://login.microsoftonline.com/${other}/oauth2/v2.0/authorize`,
  });
  expect(world.executor.clients).toMatchObject([{ clientId: other }]);
  // Applying never touches an account.
  expect(world.executor.connections).toHaveLength(1);
});

test("a squatter, a part that does not match its hash and an Executor that is down are said", async () => {
  const { world } = await setup({
    governed: false,
    seed: [
      {
        slug: "m365",
        name: "Someone's server",
        kind: "mcp",
        transport: "remote",
        endpoint: "https://mail.example.com/mcp",
        auth: "none",
        tools: 1,
      },
    ],
  });
  expect(
    await applyMicrosoft365(
      world.executorHost(),
      setting(),
      fetchSynthetic,
      syntheticParts,
    ),
  ).toEqual({ outcome: "failed", detail: "integration-conflict" });
  const fresh = await setup({ governed: false, seed: [] });
  expect(
    await applyMicrosoft365(
      fresh.world.executorHost(),
      setting(),
      fetchSynthetic,
      syntheticParts.map((item) => ({ ...item, sha256: "0".repeat(64) })),
    ),
  ).toEqual({ outcome: "failed", detail: "spec-mismatch" });
  expect(calls(fresh.world, "POST", "/api/openapi/specs")).toEqual([]);
  expect(await applyMicrosoft365(null, setting())).toEqual({
    outcome: "failed",
    detail: "executor-unavailable",
  });
  expect(
    await applyMicrosoft365(
      world.executorHost(false),
      setting(),
      fetchSynthetic,
      syntheticParts,
    ),
  ).toEqual({ outcome: "failed", detail: "executor-unavailable" });
});

test("where the company app is set up, Outlook, OneDrive and SharePoint are one card on every kind of Organization Environment", async () => {
  for (const preset of [
    "hosted-organization-personal",
    "hosted-organization-team",
    "hosted-organization-steward",
  ] as const) {
    const { app } = await setup({ preset });
    const value = await overview(app);
    const ids = value.apps.map((item) => item.id);
    expect(value.apps.find((item) => item.id === card)).toMatchObject({
      name: "Microsoft 365",
      path: { path: "direct" },
      connected: false,
    });
    for (const id of ["outlook", "one_drive", "share_point"])
      expect(ids).not.toContain(id);
    // Teams is no part of it (phase 2).
    expect(ids).toContain("microsoft_teams");
  }
}, 30_000);

test("without the setting the cards stay as they are, the company app waiting or Composio where it is allowed", async () => {
  const { app } = await setup({ governed: false });
  const value = await overview(app);
  expect(value.apps.map((item) => item.id)).not.toContain(card);
  expect(value.apps.find((item) => item.id === "outlook")?.path).toEqual({
    path: null,
    missing: "company-app",
    provider: "microsoft",
    action: "ask-admin",
  });
  const allowed = await setup({ governed: false, composio: true });
  expect(
    (await overview(allowed.app)).apps.find((item) => item.id === "outlook")
      ?.path,
  ).toMatchObject({ path: "composio" });
  // Accounts left from before the setting went keep their card, so that
  // "Odpojit" still reaches them; nothing connects there.
  const left = await setup({ governed: false });
  left.world.executor.connections.push({
    owner: "org",
    name: "default",
    integration: "m365",
    template: "microsoft365",
    identityLabel: "ada@contoso.example",
    health: "healthy",
  });
  expect(
    (await overview(left.app)).apps.find((item) => item.id === card),
  ).toMatchObject({
    connected: false,
    path: { path: null, missing: "company-app" },
    accounts: [{ selector: "org/m365/default", label: "ada@contoso.example" }],
  });
  expect(
    await (
      await left.app.post("/api/integrations/disconnect", {
        app: card,
        path: "direct",
        account: "org/m365/default",
        confirm: true,
      })
    ).json(),
  ).toEqual({ kind: "disconnected" });
  // A personal Environment has no company app (root decision 0194 point 5).
  const personal = await setup({ preset: "hosted-personal" });
  expect(
    (await overview(personal.app)).apps.map((item) => item.id),
  ).not.toContain(card);
}, 30_000);

test("one Microsoft sign-in connects the account: mail, calendar, files and sites at once, in the person's own browser", async () => {
  const { world, app, opened, forgotten } = await setup();
  const started = (await (
    await app.post("/api/integrations/connect", { app: card })
  ).json()) as { kind: string; session: string; url: string };
  expect(started.kind).toBe("authorize");
  expect(opened).toEqual([]);
  const url = new URL(started.url);
  expect(`${url.origin}${url.pathname}`).toBe(authorize);
  expect(url.searchParams.get("client_id")).toBe(clientId);
  expect(url.searchParams.get("redirect_uri")).toBe(returnAddress);
  expect(url.searchParams.get("scope")).toBe(
    "openid profile email offline_access User.Read Mail.ReadWrite Calendars.ReadWrite Files.ReadWrite.All Sites.Read.All",
  );
  // The manual client, never one registered dynamically; no label of ours.
  expect(calls(world, "POST", "/api/oauth/clients/register-dynamic")).toEqual(
    [],
  );
  expect(calls(world, "POST", "/api/oauth/start")[0]?.body).toEqual({
    client: "microsoft365",
    clientOwner: "org",
    owner: "org",
    name: "default",
    integration: "m365",
    template: "microsoft365",
    newConnection: true,
    redirectUri: returnAddress,
  });
  // Microsoft returns the window; one return, and it is connected.
  const back = await returned(
    app,
    `/api/integrations/oauth/callback?state=${url.searchParams.get("state")}&code=codeCanary0001&session_state=x`,
  );
  expect(back.status).toBe(200);
  expect(await back.text()).toContain("Microsoft 365");
  expect(await settled(app, started.session)).toEqual({
    kind: "connected",
    app: card,
  });
  expect(
    world.executor.connections.map((item) => [item.integration, item.name]),
  ).toEqual([["m365", "default"]]);
  expect(
    (await overview(app)).apps.find((item) => item.id === card),
  ).toMatchObject({
    connected: true,
    accounts: [
      {
        path: "direct",
        selector: "org/m365/default",
        label: "person@example.test",
        state: "connected",
      },
    ],
  });
  // Nothing was opened in the Environment browser, so nothing is cleared.
  expect(forgotten).toEqual([]);
});

test("several accounts side by side, and Odpojit removes only that one", async () => {
  const { world, app } = await setup({ callbacks: [] });
  for (const [state, identity] of [
    ["state1", "ada@contoso.example"],
    ["state2", "bob@contoso.example"],
  ] as const) {
    const started = (await (
      await app.post("/api/integrations/connect", { app: card })
    ).json()) as { session: string };
    world.executor.finish(state, true, identity);
    expect(await settled(app, started.session)).toEqual({
      kind: "connected",
      app: card,
    });
  }
  const accounts = (await overview(app)).apps.find(
    (item) => item.id === card,
  )?.accounts;
  expect(accounts?.map((item) => [item.selector, item.label])).toEqual([
    ["org/m365/default", "ada@contoso.example"],
    ["org/m365/default2", "bob@contoso.example"],
  ]);
  expect(
    await (
      await app.post("/api/integrations/disconnect", {
        app: card,
        path: "direct",
        account: "org/m365/default",
        confirm: true,
      })
    ).json(),
  ).toEqual({ kind: "disconnected" });
  expect(
    world.executor.connections.map((item) => [item.name, item.identityLabel]),
  ).toEqual([["default2", "bob@contoso.example"]]);
});

test("where the Launchpad's callback is not registered, the sign-in runs in the Environment browser, whose Microsoft session is then cleared", async () => {
  const { world, app, opened, forgotten } = await setup({ callbacks: [] });
  const started = (await (
    await app.post("/api/integrations/connect", { app: card })
  ).json()) as { kind: string; session: string; view: string };
  expect(started).toEqual({
    kind: "authorize",
    session: expect.any(String),
    view: environmentView(1),
  });
  const start = calls(world, "POST", "/api/oauth/start")[0]?.body as Record<
    string,
    unknown
  >;
  expect(start.redirectUri).toBeUndefined();
  expect(new URL(opened[0] ?? "").searchParams.get("redirect_uri")).toBe(
    "http://localhost:4789/api/oauth/callback",
  );
  world.executor.finish("state1", true);
  expect(await settled(app, started.session)).toEqual({
    kind: "connected",
    app: card,
  });
  for (let tries = 0; tries < 20 && forgotten.length === 0; tries += 1)
    await Bun.sleep(20);
  expect(forgotten).toEqual(["forgotten"]);
  // A sign-in that fails there is cleared up too.
  const failing = (await (
    await app.post("/api/integrations/connect", { app: card })
  ).json()) as { session: string };
  world.executor.finish("state2", false);
  expect(await settled(app, failing.session)).toEqual({
    kind: "ended",
    reason: "failed",
  });
  for (let tries = 0; tries < 20 && forgotten.length < 2; tries += 1)
    await Bun.sleep(20);
  expect(forgotten).toEqual(["forgotten", "forgotten"]);
});

test("every answer of Microsoft that wants MFA is recognised, in Executor's summary or its detail, and no other (#596)", () => {
  for (const code of ["50076", "50074", "50079", "50072"])
    for (const field of ["error", "errorDetails"])
      expect(
        mfaRequired({
          ok: false,
          [field]: `OAuth token exchange failed: AADSTS${code}: …`,
        }),
      ).toBe(true);
  for (const text of [
    "access_denied",
    "AADSTS65001: The user or administrator has not consented",
    "AADSTS500761",
    "AADSTS7000218: client_assertion or client_secret",
  ])
    expect(mfaRequired({ ok: false, error: text, errorDetails: text })).toBe(
      false,
    );
  expect(mfaRequired({ ok: false })).toBe(false);
});

test("Microsoft refusing the code for MFA says so, and the sign-in runs again in the Environment browser, where it asks for the code (#596)", async () => {
  const { world, app, opened } = await setup();
  const started = (await (
    await app.post("/api/integrations/connect", { app: card })
  ).json()) as { kind: string; session: string; url: string };
  expect(started.kind).toBe("authorize");
  expect(opened).toEqual([]);
  const url = new URL(started.url);
  expect(url.searchParams.get("redirect_uri")).toBe(returnAddress);
  // The person signed in without MFA; Microsoft refuses Executor's code.
  const back = await returned(
    app,
    `/api/integrations/oauth/callback?state=${url.searchParams.get("state")}&code=mfa:refused`,
  );
  expect(back.status).toBe(200);
  const page = await back.text();
  expect(page).toContain("vícefázové ověření");
  expect(page).toContain("v prohlížeči Prostředí");
  expect(await settled(app, started.session)).toEqual({
    kind: "ended",
    reason: "mfa-required",
    retry: "environment-browser",
  });
  expect(world.executor.connections).toEqual([]);
  // Again in the Environment browser: it returns to Executor there, never
  // to the Launchpad, even with the Launchpad's callback registered.
  const again = (await (
    await app.post("/api/integrations/connect", {
      app: card,
      browser: "environment",
    })
  ).json()) as { kind: string; session: string; view: string };
  expect(again).toEqual({
    kind: "authorize",
    session: expect.any(String),
    view: environmentView(1),
  });
  const start = calls(world, "POST", "/api/oauth/start").at(-1)?.body as Record<
    string,
    unknown
  >;
  expect(start.redirectUri).toBeUndefined();
  expect(new URL(opened[0] ?? "").searchParams.get("redirect_uri")).toBe(
    "http://localhost:4789/api/oauth/callback",
  );
  world.executor.finish("state2", true, "ada@contoso.example");
  expect(await settled(app, again.session)).toEqual({
    kind: "connected",
    app: card,
  });
  // Refused there too, nothing better is offered than saying so.
  const third = (await (
    await app.post("/api/integrations/connect", {
      app: card,
      browser: "environment",
    })
  ).json()) as { session: string };
  world.executor.finish("state3", false, undefined, mfaRefusal);
  expect(await settled(app, third.session)).toEqual({
    kind: "ended",
    reason: "mfa-required",
    retry: null,
  });
  // Any other browser is refused before anything starts.
  const invalid = await app.post("/api/integrations/connect", {
    app: card,
    browser: "own",
  });
  expect(invalid.status).toBe(400);
  expect(await invalid.json()).toEqual({ error: "invalid-browser" });
});

test("an expired account signs in again under its own name; an Executor that is down is said", async () => {
  const { world, app } = await setup();
  world.executor.connections.push({
    owner: "org",
    name: "default",
    integration: "m365",
    template: "microsoft365",
    identityLabel: "ada@contoso.example",
    health: "expired",
  });
  const again = (await (
    await app.post("/api/integrations/connect", {
      app: card,
      account: "org/m365/default",
    })
  ).json()) as { kind: string };
  expect(again.kind).toBe("authorize");
  const body = calls(world, "POST", "/api/oauth/start").at(-1)?.body as Record<
    string,
    unknown
  >;
  expect(body).toMatchObject({ name: "default", integration: "m365" });
  expect(body.newConnection).toBeUndefined();
  const down = await setup();
  await down.world.executor.stop();
  const refused = await down.app.post("/api/integrations/connect", {
    app: card,
  });
  expect(refused.status).toBe(409);
});

test("the Environment browser forgets Microsoft's sign-in origin by origin, and only where it has a browser", async () => {
  expect(forgetMicrosoftSignInOf(null, () => async () => ({}))).toBeNull();
  const entry = bindings.organizationBrowser.entry;
  if (entry === undefined) throw new Error("fixture without entry");
  const asked: unknown[] = [];
  const forget = forgetMicrosoftSignInOf(
    entry,
    () => async (method, params) => {
      asked.push([method, params]);
      return {};
    },
  );
  expect(await forget?.()).toBe(true);
  expect(asked).toEqual(
    microsoftSignInOrigins.map((origin) => [
      "Storage.clearDataForOrigin",
      { origin, storageTypes: "all" },
    ]),
  );
  const failing = forgetMicrosoftSignInOf(entry, () => async () => {
    throw new Error("no browser endpoint");
  });
  expect(await failing?.()).toBe(false);
});

test("a pinned part without Content-Length stops downloading the moment it passes the cap", async () => {
  const chunk = new Uint8Array(64 * 1024);
  let sent = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      sent += chunk.byteLength;
      controller.enqueue(chunk);
    },
    cancel() {
      cancelled = true;
    },
  });
  const response = new Response(body);
  expect(response.headers.get("content-length")).toBeNull();
  await expect(readBounded(response, 1024 * 1024)).rejects.toThrow("too large");
  expect(cancelled).toBe(true);
  // At most a chunk or two past the cap was pulled, never the whole stream.
  expect(sent).toBeLessThanOrEqual(1024 * 1024 + 3 * chunk.byteLength);

  const small = new Response(new Uint8Array([1, 2, 3]));
  expect(Array.from(await readBounded(small, 1024))).toEqual([1, 2, 3]);
});
