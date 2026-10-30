import { afterEach, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { integrationsCatalog } from "../src/integrations/catalog";
import type {
  IntegrationApp,
  IntegrationsOverview,
} from "../src/integrations/model";
import {
  type ComposioToolsReading,
  cardView,
  composioSignIn,
  composioSignInNote,
  noteAfterReading,
  parseIntegrations,
  toolStatesKey,
} from "../src/launchpad/integrations-view";
import { messages } from "../src/launchpad/messages";
import { parseToolsOverview } from "../src/launchpad/tools-view";
import {
  type FakeComposioState,
  integrationsWorld,
  readComposioState,
  worldLaunchpad,
} from "./fixtures/integrations-world";

// Apps → Integrace right after Composio's sign-in (decision F42, note of
// 2026-10-19). "Připojit" on a Composio app sent the person to Settings →
// Tools instead of connecting, until the page was reloaded: the Integrace
// were read once, when the sign-in changed, before the sign-in switched
// "Používají agenti" on; nothing read them again, and the Launchpad kept
// that reading for a minute, so even its connect refused. Now a recorded
// change of the tools and a completed sign-in make the next reading
// current; the page reads again when a tool is installed or switched on or
// off; and Composio signed in but off for agents says so on the card.

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup(
  composio: Partial<FakeComposioState>,
  tools: readonly string[],
) {
  const parent = await realpath(
    await mkdtemp(join(tmpdir(), "lazurio-composio-ready-")),
  );
  cleanups.push(() => rm(parent, { recursive: true, force: true }));
  const world = await integrationsWorld(parent, { composio });
  cleanups.push(() => world.executor.stop());
  const app = await worldLaunchpad(parent, world, { tools });
  cleanups.push(() => app.close());
  return { world, app };
}

type App = Awaited<ReturnType<typeof setup>>["app"];

// The page's reading, as a card asks for it: the Launchpad's kept one.
async function reading(app: App): Promise<IntegrationsOverview> {
  const answer = await app.get("/api/integrations");
  expect(answer.status).toBe(200);
  return (await answer.json()) as IntegrationsOverview;
}
// A reading as the page holds it, through the page's own parser.
const parsed = (overview: IntegrationsOverview) => {
  const value = parseIntegrations(overview);
  if (value === null) throw new Error("the page refused the reading");
  return value;
};
const salesforce = (overview: IntegrationsOverview) =>
  overview.apps.find((item) => item.id === "salesforce")?.path;

// "Používají agenti" of one tool, as Settings → Tools switches it.
async function switchTool(app: App, name: string, on: boolean) {
  const status = (await (await app.post("/api/tools/status", {})).json()) as {
    revision: number;
    tools: { name: string; tier: string; enabled: boolean }[];
  };
  const enabled = status.tools
    .filter((tool) => tool.tier !== "required" && tool.enabled)
    .map((tool) => tool.name)
    .filter((tool) => tool !== name);
  const answer = await app.post("/api/tools/update", {
    expectedRevision: status.revision,
    tools: (on ? [...enabled, name] : enabled).sort(),
  });
  expect(((await answer.json()) as { kind: string }).kind).toBe("updated");
}

async function connect(app: App) {
  const answer = await app.post("/api/integrations/connect", {
    app: "salesforce",
  });
  return { status: answer.status, value: (await answer.json()) as unknown };
}

// Composio's "Používají agenti" as Settings → Tools reads it.
async function composioOn(app: App): Promise<boolean | undefined> {
  const status = (await (await app.post("/api/tools/status", {})).json()) as {
    tools: { name: string; enabled: boolean }[];
  };
  return status.tools.find((tool) => tool.name === "composio")?.enabled;
}

// Composio's sign-in as the dialog starts it; the person authorizes in
// Composio's tab, so the CLI's next check signs in. Answers the handle.
async function signInStarted(
  world: Awaited<ReturnType<typeof setup>>["world"],
  app: App,
): Promise<string> {
  const started = (await (
    await app.post("/api/tools/login/start", { tool: "composio" })
  ).json()) as { kind: string; session: string };
  expect(started.kind).toBe("pending");
  const key = (await readComposioState(world.home)).pendingLogin ?? "";
  await Bun.write(join(world.home, ".fake-composio", "approve"), key);
  return started.session;
}

test("switching Composio on for agents makes the next reading current, and Připojit connects", async () => {
  // Signed in, "Používají agenti" off: the reading the page keeps says so.
  const { app } = await setup({}, []);
  const before = await reading(app);
  expect(before.sources.composio).toBe("off");
  expect(salesforce(before)).toEqual({ path: "composio", signIn: true });
  expect(await connect(app)).toEqual({
    status: 409,
    value: { kind: "blocked", reason: "composio-signed-out" },
  });

  await switchTool(app, "composio", true);
  // Without a refresh: the Launchpad read again after the change.
  const after = await reading(app);
  expect(after.sources.composio).toBe("ok");
  expect(salesforce(after)).toEqual({ path: "composio", signIn: false });
  const started = await connect(app);
  expect(started.status).toBe(200);
  expect(started.value).toMatchObject({
    kind: "authorize",
    url: "https://connect.composio.dev/link/lk_fake101",
  });

  // Off again: said so at once, and nothing connects through it.
  await switchTool(app, "composio", false);
  expect((await reading(app)).sources.composio).toBe("off");
});

test("a sign-in completed in the Launchpad makes the next reading current; signed out, Připojit still asks for it", async () => {
  const { world, app } = await setup({ signedIn: false, pollScale: 0.02 }, [
    "composio",
  ]);
  const before = await reading(app);
  expect(before.sources.composio).toBe("signed-out");
  expect(salesforce(before)).toEqual({ path: "composio", signIn: true });
  // Really signed out: the connect asks for the sign-in, as before.
  expect(await connect(app)).toEqual({
    status: 409,
    value: { kind: "blocked", reason: "composio-signed-out" },
  });

  const started = (await (
    await app.post("/api/tools/login/start", { tool: "composio" })
  ).json()) as { kind: string; session: string };
  expect(started.kind).toBe("pending");
  // The person authorizes in Composio's tab; the CLI's next check signs in.
  const key = (await readComposioState(world.home)).pendingLogin ?? "";
  await Bun.write(join(world.home, ".fake-composio", "approve"), key);
  let state = started.kind;
  for (let i = 0; i < 100 && state === "pending"; i++) {
    await Bun.sleep(100);
    state = (
      (await (
        await app.post("/api/tools/login/poll", {
          tool: "composio",
          session: started.session,
        })
      ).json()) as { kind: string }
    ).kind;
  }
  expect(state).toBe("signed-in");

  // Without a refresh: the sign-in made the Launchpad read again.
  const after = await reading(app);
  expect(after.sources.composio).toBe("ok");
  expect(salesforce(after)).toEqual({ path: "composio", signIn: false });
  expect((await connect(app)).value).toMatchObject({ kind: "authorize" });

  // The page's line asking for the sign-in (#545): kept by the reading
  // taken while signed out, dropped by the first one after the sign-in;
  // any other note, and a reading that failed, leave the note as it is.
  const cs = messages("cs");
  const asks = composioSignInNote("opened", cs);
  expect(asks?.text).toBe(cs.integrationsComposioSignIn);
  expect(noteAfterReading(asks, parsed(before), cs)).toEqual(asks);
  expect(noteAfterReading(asks, parsed(after), cs)).toBeNull();
  expect(noteAfterReading(asks, null, cs)).toEqual(asks);
  const other = { text: cs.integrationsConnectFailed, tone: "danger" as const };
  expect(noteAfterReading(other, parsed(after), cs)).toEqual(other);
}, 30_000);

// #682 (Matěj 2026-10-28): after Composio's sign-in in Začínáme
// "Používají agenti" stayed off, so Integrace said agents do not use it.
// The page turned it on itself after its reading, and a second reading the
// organizations' check started at the same time left that page busy, so the
// change was dropped; a page closed meanwhile never made it. The Launchpad
// now turns it on as the sign-in ends (F19's addendum of 2026-10-28).
test("a sign-in completed in the Launchpad turns Composio on for agents before it answers signed in; a person may turn it off again", async () => {
  const { world, app } = await setup({ signedIn: false, pollScale: 0.02 }, []);
  expect(await composioOn(app)).toBe(false);
  const session = await signInStarted(world, app);
  let state = "pending";
  for (let i = 0; i < 100 && state === "pending"; i++) {
    await Bun.sleep(100);
    state = (
      (await (
        await app.post("/api/tools/login/poll", { tool: "composio", session })
      ).json()) as { kind: string }
    ).kind;
  }
  expect(state).toBe("signed-in");
  // The reading right after the answer, as the page makes it, shows the
  // switch on; Integrace say Composio connects apps, with nothing reloaded.
  expect(await composioOn(app)).toBe(true);
  const after = await reading(app);
  expect(after.sources.composio).toBe("ok");
  expect(salesforce(after)).toEqual({ path: "composio", signIn: false });

  // Off again by the person: it stays off, the next readings do not turn
  // it back on.
  await switchTool(app, "composio", false);
  await app.post("/api/tools/status", { signIn: true, fresh: true });
  expect(await composioOn(app)).toBe(false);
  expect((await reading(app)).sources.composio).toBe("off");
}, 30_000);

test("a sign-in that ends with its page closed, nobody polling it, still turns Composio on for agents", async () => {
  const { world, app } = await setup({ signedIn: false, pollScale: 0.02 }, []);
  await signInStarted(world, app);
  // No poll: the dialog was closed, or the page left.
  let on = await composioOn(app);
  for (let i = 0; i < 100 && on !== true; i++) {
    await Bun.sleep(100);
    on = await composioOn(app);
  }
  expect(on).toBe(true);
  expect((await reading(app)).sources.composio).toBe("ok");
}, 30_000);

test("the page reads the Integrace again when a tool is installed or switched on or off", () => {
  const tools = (
    ...entries: [string, boolean, boolean][]
  ): Parameters<typeof toolStatesKey>[0] => ({
    tools: entries.map(([name, installed, enabled]) => ({
      name,
      installed,
      enabled,
    })),
  });
  const off = toolStatesKey(
    tools(["gh", true, true], ["composio", true, false]),
  );
  // The same states: the same key, whatever else of the reading changed.
  expect(
    toolStatesKey(tools(["gh", true, true], ["composio", true, false])),
  ).toBe(off);
  // Composio switched on for agents, or installed: another key.
  expect(
    toolStatesKey(tools(["gh", true, true], ["composio", true, true])),
  ).not.toBe(off);
  expect(
    toolStatesKey(tools(["gh", true, true], ["composio", false, false])),
  ).not.toBe(off);
  // Not read yet, or unreadable: a key of its own.
  expect(toolStatesKey(null)).toBe("null");
  expect(toolStatesKey(null)).not.toBe(off);
});

test("Composio signed in but off for agents: the card says so with the switch's words and opens Settings → Tools", () => {
  const cs = messages("cs");
  const en = messages("en");
  const entry = integrationsCatalog.apps.find((item) => item.id === "gmail");
  const gmail: IntegrationApp = {
    id: "gmail",
    name: "Gmail",
    path: { path: "composio", signIn: true },
    connected: false,
    accounts: [],
    catalog: true,
    link: null,
  };
  const options = (copy: typeof cs, composioOff: boolean) => ({
    locale: copy === cs ? ("cs" as const) : ("en" as const),
    scope: "organization" as const,
    admin: false,
    dashboard: true,
    copy,
    composioOff,
  });
  expect(cardView(gmail, entry, options(cs, true))).toEqual({
    line: "Composio je připojené, ale agenti ho nepoužívají: v Nástrojích má vypnuté „Používají agenti“.",
    connected: false,
    pathLabel: null,
    // Settings → Tools at Composio's row, its switch focused.
    action: { kind: "open-tools", label: "Otevřít Nástroje", tool: "composio" },
    composio: false,
  });
  expect(cardView(gmail, entry, options(en, true)).line).toBe(
    "Composio is connected, but agents don't use it: “Used by agents” is off in Tools.",
  );
  // Signed out: Připojit, which asks for Composio's sign-in, as before.
  expect(cardView(gmail, entry, options(cs, false)).action).toEqual({
    kind: "connect",
    label: "Připojit",
    path: "composio",
  });
  // Ready: the same card connects.
  expect(
    cardView(
      { ...gmail, path: { path: "composio", signIn: false } },
      entry,
      options(cs, true),
    ).action,
  ).toMatchObject({ kind: "connect", path: "composio" });
});

test("the page reads the reading's off state", () => {
  const overview = {
    kind: "integrations",
    locale: "cs",
    scope: "organization",
    page: null,
    composio: {
      allowed: true,
      source: "environment",
      ready: false,
      disconnect: false,
      update: false,
      apps: null,
      organization: null,
    },
    sources: { tools: "ok", executor: "ok", composio: "off" },
    tools: [],
    apps: [],
    custom: [],
    readAt: "2026-10-19T12:00:00.000Z",
  };
  expect(parseIntegrations(overview)?.sources.composio).toBe("off");
});

// "Připojit" asking for Composio's sign-in reads the tools live first, and
// only a reading that proves Composio signed out (or not installed) sends
// the person to Settings → Tools (Pablo's review of #523). A read that
// failed, answered something that is not a reading, or was superseded by a
// later read proves nothing: the person stays on Integrace and is told to
// try again.

const tools = (
  composio: Partial<{ installed: boolean; signIn: { state: string } }> | null,
): ComposioToolsReading => ({
  tools: [
    { name: "gh", installed: true, signIn: { state: "signed-out" } },
    ...(composio === null
      ? []
      : [{ name: "composio", installed: true, ...composio }]),
  ],
});

// Composio's sign-in as a card asks for it, with where it went.
async function signIn(read: () => Promise<ComposioToolsReading | null>) {
  const went: string[] = [];
  const answer = await composioSignIn(read, () => {
    went.push("tools");
    return true;
  });
  return { answer, went };
}

const stays = { answer: "unreadable" as const, went: [] as string[] };

test("a tools read that failed or answered no reading sends nobody away: Integrace say to try again", async () => {
  const cs = messages("cs");
  const en = messages("en");
  // `/api/tools/status` failed: the tools panel answers no reading.
  expect(await signIn(async () => null)).toEqual(stays);
  // It answered, but not a reading.
  expect(
    await signIn(async () =>
      parseToolsOverview({ kind: "tools-status", tools: "composio" }),
    ),
  ).toEqual(stays);
  // A reading that does not know Composio's sign-in (its probe timed out, or
  // did not run), or has no Composio, proves no sign-out either.
  for (const composio of [{ signIn: { state: "unknown" } }, {}, null])
    expect(await signIn(async () => tools(composio))).toEqual(stays);
  // The line the card says, through the page's notice.
  expect(composioSignInNote("unreadable", cs)).toEqual({
    text: "Stav Composia se nepodařilo načíst. Zkuste to znovu.",
    tone: "warning",
  });
  expect(composioSignInNote("unreadable", en)).toEqual({
    text: "Composio's state could not be read. Try again.",
    tone: "warning",
  });
});

test("a read a later read superseded decides nothing; the later one decides", async () => {
  // Two "Připojit" close together: the first read is overtaken by the
  // second, and the tools panel answers a superseded read with no reading,
  // never with the reading the page shows by then.
  let first: (reading: ComposioToolsReading | null) => void = () => {};
  const went: string[] = [];
  const earlier = composioSignIn(
    () =>
      new Promise((resolve) => {
        first = resolve;
      }),
    () => {
      went.push("earlier");
      return true;
    },
  );
  const later = composioSignIn(
    async () => tools({ signIn: { state: "signed-in" } }),
    () => {
      went.push("later");
      return true;
    },
  );
  expect(await later).toBe("signed-in");
  first(null);
  expect(await earlier).toBe("unreadable");
  expect(went).toEqual([]);
});

test("a Composio really signed out, or not installed, still opens its sign-in in Settings → Tools", async () => {
  const cs = messages("cs");
  for (const composio of [
    { signIn: { state: "signed-out" } },
    { installed: false },
    { installed: false, signIn: { state: "unknown" } },
  ])
    expect(await signIn(async () => tools(composio))).toEqual({
      answer: "opened",
      went: ["tools"],
    });
  // Settings → Tools could not open the sign-in itself: the person is there
  // all the same.
  expect(
    await composioSignIn(
      async () => tools({ signIn: { state: "signed-out" } }),
      () => false,
    ),
  ).toBe("settings");
  // Signed in after all: nobody goes anywhere; the card reads the Integrace
  // again and its form opens.
  expect(
    await signIn(async () => tools({ signIn: { state: "signed-in" } })),
  ).toEqual({ answer: "signed-in", went: [] });
  for (const answer of ["opened", "settings"] as const)
    expect(composioSignInNote(answer, cs)).toEqual({
      text: cs.integrationsComposioSignIn,
      tone: "info",
    });
  expect(composioSignInNote("signed-in", cs)).toBeNull();
});
