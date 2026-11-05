import { afterEach, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseContentList } from "../src/launchpad/content-client";
import {
  organizationArrived,
  presentOrganizations,
} from "../src/launchpad/content-view";
import { composioFact } from "../src/launchpad/first-run";
import { messages } from "../src/launchpad/messages";
import { optionalRows } from "../src/launchpad/start-view";
import {
  composioDialogView,
  curatedActions,
  heldLine,
  loginEndMessage,
  organizationRule,
  parseLoginState,
  parseToolsOverview,
  signInMode,
} from "../src/launchpad/tools-view";
import type { ToolsOverview } from "../src/tools/overview";
import { writeOrganization } from "./fixtures/catalog-folder";
import {
  composioCalls,
  type FakeComposioState,
  integrationsWorld,
  readComposioState,
  worldLaunchpad,
} from "./fixtures/integrations-world";
import { bindings } from "./fixtures/machine-bindings";

// Composio on an Organization's Environment before its Organization is
// there (decision F42): the Organization's root could not be cloned yet,
// because the person was not in its Team on GitHub (organization settings
// journal `organization-absent`). Začínáme still offered "Připojit" for
// Composio; the sign-in landed in the organization Composio's CLI selects,
// the person's own, and "Používají agenti" followed it there. Now the
// Launchpad holds Composio's sign-in while the organization of this
// Environment cannot be told: Nástroje and Začínáme offer none and say why
// and what comes first, a sign-in started anyway is refused before
// `composio login` runs, and once the Organization is here everything is
// offered as before.

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const cs = messages("cs");
const en = messages("en");

async function organizationEnvironment(composio: Partial<FakeComposioState>) {
  const parent = await realpath(
    await mkdtemp(join(tmpdir(), "lazurio-composio-absent-")),
  );
  cleanups.push(() => rm(parent, { recursive: true, force: true }));
  const world = await integrationsWorld(parent, {
    composio: {
      accounts: [],
      organization: "jana_workspace",
      organizations: [
        { id: "org_1", name: "jana_workspace" },
        { id: "org_2", name: "priklad" },
      ],
      ...composio,
    },
  });
  cleanups.push(() => world.executor.stop());
  // The Machine's handover binds the Organization `example`; its root is
  // not in the Folder.
  const app = await worldLaunchpad(parent, world, {
    tools: [],
    handover: {
      preset: "hosted-organization-personal",
      machine: bindings.organization,
    },
  });
  cleanups.push(() => app.close());
  return { world, app };
}

type App = Awaited<ReturnType<typeof organizationEnvironment>>["app"];

async function toolsOverview(app: App): Promise<ToolsOverview> {
  const answer = await app.post("/api/tools/status", {
    signIn: true,
    fresh: true,
  });
  expect(answer.status).toBe(200);
  const overview = parseToolsOverview(await answer.json());
  if (overview === null) throw new Error("the page refused the overview");
  return overview;
}

const composioOf = (overview: ToolsOverview) => {
  const tool = overview.tools.find((entry) => entry.name === "composio");
  if (tool === undefined) throw new Error("no composio row");
  return tool;
};

const composioOn = async (app: App) =>
  (
    (await (await app.post("/api/tools/status", {})).json()) as {
      tools: { name: string; enabled: boolean }[];
    }
  ).tools.find((tool) => tool.name === "composio")?.enabled;

test("without its Organization, Composio's sign-in is neither offered nor started, and Začínáme says why and what comes first", async () => {
  const { world, app } = await organizationEnvironment({ signedIn: false });

  // Nástroje: no sign-in on Composio's row, and the sentence says why.
  const overview = await toolsOverview(app);
  const composio = composioOf(overview);
  expect(composio.held).toBe("organization-absent");
  expect(curatedActions(composio, cs).primary).toBeNull();
  expect(signInMode(composio, cs)).toBeNull();
  expect(heldLine(composio, cs)).toBe(cs.toolsComposioHeld);
  expect(cs.toolsComposioHeld).toContain("Začínáme");
  expect(en.toolsComposioHeld).toContain("Getting started");
  // No other tool is held.
  expect(
    overview.tools.filter((tool) => tool.held !== undefined).map((t) => t.name),
  ).toEqual(["composio"]);

  // Začínáme: the row stays, without "Připojit", with the reason.
  const fact = composioFact(overview);
  expect(fact).toBe("organization-absent");
  const [row] = optionalRows(
    {
      preset: "hosted-organization-personal",
      composio: fact,
      sshDevices: null,
      bitwarden: false,
    },
    cs,
  );
  expect(row).toEqual({
    id: "composio",
    title: "Composio",
    text: cs.startComposioText,
    status: "Čeká na Organizaci",
    note: cs.toolsComposioHeld,
    action: null,
  });

  // A sign-in asked for anyway (an old page, a link): refused before
  // Composio's CLI runs, so nothing lands in the person's own organization
  // and agents are not switched to it.
  const started = await app.post("/api/tools/login/start", {
    tool: "composio",
  });
  expect(started.status).toBe(409);
  const refused = await started.json();
  expect(refused).toEqual({
    kind: "blocked",
    reason: "organization-absent",
    tool: "composio",
  });
  const calls = await composioCalls(world.home);
  expect(calls.some((call) => call[0] === "login")).toBe(false);
  expect((await readComposioState(world.home)).signedIn).toBe(false);
  expect(await composioOn(app)).toBe(false);
  // The dialog says the same sentence, and offers no retry.
  const state = parseLoginState(refused);
  if (state === null) throw new Error("the page refused the answer");
  expect(loginEndMessage(state, cs)).toEqual({
    message: cs.toolsComposioHeld,
    agent: false,
    retry: false,
  });

  // What the open Začínáme lists before the download: the Organization is
  // not in the Folder.
  const listed = async () =>
    presentOrganizations(
      parseContentList(await (await app.get("/api/content")).json()),
    );
  const before = await listed();
  expect(before.has("example")).toBe(false);

  // The Organization arrives (the person was added to its Team): Composio
  // is offered and starts as before.
  await writeOrganization(app.folder, "example", {
    slug: "example",
    state: "current",
    modules: [],
    displayName: "Příklad",
  });
  // The open page sees the download finish in its next content listing,
  // and that arrival is what reads the tools again (ui.ts, review on #829):
  // the row offers the sign-in without a reload or "Zkontrolovat znovu".
  const arrived = await listed();
  expect(arrived.has("example")).toBe(true);
  expect(organizationArrived(before, arrived)).toBe(true);
  // The first listing of a page, and a listing without a new Organization,
  // read nothing again.
  expect(organizationArrived(null, arrived)).toBe(false);
  expect(organizationArrived(arrived, arrived)).toBe(false);
  const after = composioOf(await toolsOverview(app));
  expect(after.held).toBeUndefined();
  expect(composioFact(await toolsOverview(app))).not.toBe(
    "organization-absent",
  );
  expect(curatedActions(after, cs).primary?.mode).toBe("login");
  const again = (await (
    await app.post("/api/tools/login/start", { tool: "composio" })
  ).json()) as { kind: string };
  expect(again.kind).toBe("pending");
}, 30_000);

test("signed in before the Organization arrived: nothing is switched, and the dialog says the Organization is not here yet", async () => {
  const { world, app } = await organizationEnvironment({ signedIn: true });
  const answer = (await (
    await app.post("/api/tools/composio/organizations", {})
  ).json()) as Record<string, unknown>;
  expect(answer).toMatchObject({
    kind: "composio-organizations",
    organization: { name: null, state: "unverified", absent: true },
  });
  expect(organizationRule(answer)).toEqual({
    kind: "unverified",
    absent: true,
  });
  expect(composioDialogView(answer, "op@example.com", cs)).toEqual({
    kind: "problem",
    message: cs.toolsComposioHeld,
  });
  // The person's own organization stays current, never guessed away.
  expect((await readComposioState(world.home)).organization).toBe(
    "jana_workspace",
  );
  // Začínáme and Nástroje: still waiting, and only "Sign out" is offered.
  const composio = composioOf(await toolsOverview(app));
  expect(composio.held).toBe("organization-absent");
  expect(
    composioFact({ revision: 1, sharedEnvironment: false, tools: [composio] }),
  ).toBe("organization-absent");
  expect(curatedActions(composio, cs)).toEqual({
    primary: null,
    logout: true,
    linkSsh: false,
  });
}, 30_000);

test("an Organization whose name cannot be read holds the sign-in too, and points to the agent", async () => {
  const parent = await realpath(
    await mkdtemp(join(tmpdir(), "lazurio-composio-unreadable-")),
  );
  cleanups.push(() => rm(parent, { recursive: true, force: true }));
  const world = await integrationsWorld(parent, {
    composio: { accounts: [], signedIn: false },
  });
  cleanups.push(() => world.executor.stop());
  const app = await worldLaunchpad(parent, world, {
    seams: {
      composioOrganization: { kind: "unverified", reason: "unreadable" },
    },
  });
  cleanups.push(() => app.close());
  const composio = composioOf(await toolsOverview(app));
  expect(composio.held).toBe("organization-unreadable");
  expect(heldLine(composio, cs)).toBe(cs.toolsComposioOrgUnverified);
  const started = await app.post("/api/tools/login/start", {
    tool: "composio",
  });
  expect(started.status).toBe(409);
  const state = parseLoginState(await started.json());
  if (state === null) throw new Error("the page refused the answer");
  expect(loginEndMessage(state, en)).toEqual({
    message: en.toolsComposioOrgUnverified,
    agent: true,
    retry: false,
  });
  expect(
    (await composioCalls(world.home)).some((call) => call[0] === "login"),
  ).toBe(false);
}, 30_000);

test("the page accepts held only on Composio, and only its two reasons", () => {
  const tool = {
    name: "composio",
    command: "composio",
    tier: "optional",
    setup: "launchpad",
    enabled: false,
    offered: true,
    installed: true,
    purpose: "Apps",
    usage: "composio",
    source: "https://composio.dev",
    prompt: "Install Composio",
  };
  const overview = (entry: Record<string, unknown>) =>
    parseToolsOverview({
      kind: "tools-status",
      revision: 1,
      locale: "cs",
      sharedEnvironment: false,
      hosted: true,
      mcpPrompt: "MCP",
      tools: [entry],
    });
  expect(overview({ ...tool, held: "organization-absent" })).not.toBeNull();
  expect(overview({ ...tool, held: "organization-unreadable" })).not.toBeNull();
  expect(overview({ ...tool, held: "later" })).toBeNull();
  expect(
    overview({ ...tool, name: "wacli", held: "organization-absent" }),
  ).toBeNull();
  expect(
    parseLoginState({
      kind: "blocked",
      tool: "wacli",
      reason: "organization-absent",
    }),
  ).toBeNull();
});
