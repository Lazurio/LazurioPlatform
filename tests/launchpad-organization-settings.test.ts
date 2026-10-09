import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeHandoverFolder } from "../src/folder/initialize-folder";
import type { MachineBinding } from "../src/folder/machine-binding";
import { executionOs } from "../src/folder/platform";
import { type PresetName, presetProfile } from "../src/folder/presets";
import { updateTools } from "../src/folder/update-profile";
import type { AuthFetcher } from "../src/launchpad/hosted-trust";
import { startLaunchpad } from "../src/launchpad/server";
import { environmentSettingsSchema } from "../src/organization-settings/contract";
import { unixSocketTransport } from "../src/organization-settings/relay";
import { toolsEnvironmentOf } from "../src/tools/overview";
import { commit, fakeRelay, settingsAnswer } from "./fixtures/fake-relay";
import { integrationsWorld } from "./fixtures/integrations-world";
import {
  binding,
  handoverEntry,
  organizationWithRelay,
  withEnvironmentRelay,
} from "./fixtures/machine-bindings";
import personal from "./fixtures/machine-context-personal.json";

// Decision F45 end to end in the Launchpad: on a work Environment whose
// handover names the Environment's relay, the Launchpad asks the Dashboard
// for its Organization's settings when the page opens and on a refresh,
// applies them to the Folder, reports, and Settings → Tools and Integrace
// show what applies. A personal Environment asks nothing.

const os = executionOs(process.platform);
const v1 = commit("1");
const v2 = commit("2");
const off = { integrations: { composio: { allowed: false } } };
const on = { integrations: { composio: { allowed: true } } };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const freePort = () => {
  const probe = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(""),
  });
  const port = probe.port as number;
  probe.stop(true);
  return port;
};

const fetcher: AuthFetcher = async (_url, init) =>
  new Headers(init.headers).get("cookie") === "__Secure-lazurio-workspace=valid"
    ? new Response("ok")
    : new Response("no", { status: 401 });

async function launchpad(
  preset: PresetName,
  machine: MachineBinding,
  answer: () => Response,
) {
  const parent = await realpath(
    await mkdtemp(join(tmpdir(), "launchpad-organization-settings-")),
  );
  cleanups.push(() => rm(parent, { recursive: true, force: true }));
  const folder = join(parent, "Lazurio");
  await mkdir(folder, { mode: 0o700 });
  await mkdir(join(folder, "organizations"), { mode: 0o755 });
  if (preset === "hosted-personal")
    await mkdir(join(folder, "personalspace"), { mode: 0o700 });
  await initializeHandoverFolder(folder, {
    preset,
    machine,
    profile: presetProfile(preset, os),
  });
  await updateTools(folder, 1, ["composio"]);
  const relay = await fakeRelay((request) =>
    request.path === "/organization/settings/report"
      ? Response.json({}, { status: 202 })
      : answer(),
  );
  cleanups.push(() => relay.close());
  const world = await integrationsWorld(parent);
  cleanups.push(() => world.executor.stop());
  const entry = machine.entry;
  if (entry === undefined) throw new Error("The fixture has an entry");
  const app = await startLaunchpad(
    folder,
    undefined,
    undefined,
    undefined,
    { fetcher },
    toolsEnvironmentOf(
      { PATH: world.path, HOME: world.home },
      process.platform,
    ),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    // Executor's setup (decision F44) is not part of these tests.
    undefined,
    {
      executor: world.executorHost(),
      executorPresent: true,
      environmentBrowser: null,
    },
    {
      // The handover's socket is under /run; the test's relay is its own.
      transport: () => unixSocketTransport(relay.socket),
      client: { retryDelaysMs: [10, 10] },
      // Only the page and the refreshes ask here, every time.
      poller: { startupDelayMs: 3_600_000, nudgeGapMs: 0 },
    },
  );
  cleanups.push(async () => {
    await app.close();
  });
  const base = `http://127.0.0.1:${entry.listenPort}`;
  const host = new URL(entry.externalOrigin).host;
  const valid = { host, cookie: "__Secure-lazurio-workspace=valid" };
  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: {
        ...valid,
        origin: entry.externalOrigin,
        "sec-fetch-site": "same-origin",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  const tools = async () =>
    (await (await post("/api/tools/status", { signIn: true })).json()) as {
      tools: {
        name: string;
        enabled: boolean;
        organization?: { allowed: boolean; chosen: boolean };
      }[];
      organizationSettings?: Record<string, unknown>;
    };
  const integrations = async () =>
    (await (
      await fetch(`${base}/api/integrations?refresh=1`, { headers: valid })
    ).json()) as { composio: { allowed: boolean; source: string } };
  return { folder, relay, base, valid, tools, integrations };
}

const delivered = (version: string, settings: unknown) =>
  settingsAnswer(
    {
      schema_version: environmentSettingsSchema,
      organization: { github_org_id: 123, login: "Example" },
      version,
      settings,
    },
    version,
  );

test.skipIf(process.platform === "win32")(
  "a work Environment with the relay applies its Organization's settings on a refresh, reports, and its surfaces follow",
  async () => {
    let answer = () => delivered(v1, off);
    const work = await launchpad(
      "hosted-organization-personal",
      organizationWithRelay(freePort()),
      () => answer(),
    );
    const first = await work.tools();
    expect(first.tools.find((tool) => tool.name === "composio")).toMatchObject({
      enabled: false,
      organization: { allowed: false, chosen: true },
    });
    expect(first.organizationSettings).toMatchObject({
      source: "dashboard",
      version: v1,
      error: null,
      unapplied: [],
    });
    // Asked without a version, then reported what it applied.
    const [asked, reported] = work.relay.requests;
    expect(asked?.method).toBe("GET");
    expect(asked?.headers["if-none-match"]).toBeUndefined();
    expect(reported?.path).toBe("/organization/settings/report");
    expect(JSON.parse(reported?.body ?? "")).toMatchObject({
      version: v1,
      last_error: null,
      items: [
        {
          key: "integrations.composio.allowed",
          outcome: "applied",
          detail: null,
        },
      ],
    });
    expect(
      await readFile(join(work.folder, "AGENTS.md"), "utf8"),
    ).not.toContain("- `composio` (");
    expect((await work.integrations()).composio).toMatchObject({
      allowed: false,
      source: "organization",
    });

    // The Organization allows it again: the next refresh brings the
    // person's choice back.
    answer = () => delivered(v2, on);
    const second = await work.tools();
    expect(second.tools.find((tool) => tool.name === "composio")).toMatchObject(
      {
        enabled: true,
        organization: { allowed: true, chosen: true },
      },
    );
    expect(second.organizationSettings).toMatchObject({ version: v2 });
    expect(
      work.relay.requests.filter((request) => request.method === "GET").at(-1)
        ?.headers["if-none-match"],
    ).toBe(`"${v1}"`);
    expect((await work.integrations()).composio).toMatchObject({
      allowed: true,
      source: "organization",
    });

    // The Dashboard does not answer: the version applied last stays.
    answer = () =>
      Response.json({ error: "github_unavailable" }, { status: 503 });
    const third = await work.tools();
    expect(third.organizationSettings).toMatchObject({
      version: v2,
      error: "dashboard_unreachable",
    });
    expect(third.tools.find((tool) => tool.name === "composio")?.enabled).toBe(
      true,
    );
  },
  60_000,
);

test.skipIf(process.platform === "win32")(
  "opening the page asks the Organization's settings",
  async () => {
    const work = await launchpad(
      "hosted-organization-personal",
      organizationWithRelay(freePort()),
      () => delivered(v1, off),
    );
    const page = await fetch(`${work.base}/`, { headers: work.valid });
    expect(page.status).toBe(200);
    await page.text();
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (work.relay.requests.length > 0) break;
      await Bun.sleep(20);
    }
    expect(work.relay.requests[0]?.path).toBe("/organization/settings");
  },
);

test.skipIf(process.platform === "win32")(
  "a personal Environment asks nothing, whatever its handover names",
  async () => {
    const machine = binding({
      ...personal,
      entry: withEnvironmentRelay(
        handoverEntry("example.lazurio.io", freePort()),
      ),
    });
    const own = await launchpad("hosted-personal", machine, () =>
      delivered(v1, off),
    );
    const read = await own.tools();
    expect(read.organizationSettings).toBeUndefined();
    expect(read.tools.find((tool) => tool.name === "composio")).toMatchObject({
      enabled: true,
    });
    expect(
      read.tools.find((tool) => tool.name === "composio")?.organization,
    ).toBeUndefined();
    const page = await fetch(`${own.base}/`, { headers: own.valid });
    await page.text();
    await Bun.sleep(100);
    expect(own.relay.requests).toEqual([]);
  },
);
