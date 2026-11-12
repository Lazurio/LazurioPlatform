import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeHandoverFolder } from "../src/folder/initialize-folder";
import type { MachineBinding } from "../src/folder/machine-binding";
import { renderManual } from "../src/folder/manual";
import { executionOs } from "../src/folder/platform";
import { type PresetName, presetProfile } from "../src/folder/presets";
import { agentEntryView } from "../src/launchpad/agent-entry-view";
import { messages } from "../src/launchpad/messages";
import { processNewTabHost } from "../src/launchpad/new-tab-routes";
import { startLaunchpad } from "../src/launchpad/server";
import { unixSocketTransport } from "../src/organization-settings/relay";
import { type FakeRelay, fakeRelay } from "./fixtures/fake-relay";
import {
  binding,
  bindings,
  handoverEntry,
  withBrowser,
  withEnvironmentRelay,
} from "./fixtures/machine-bindings";
import organization from "./fixtures/machine-context.json";
import personal from "./fixtures/machine-context-personal.json";
import { freePort } from "./fixtures/ports";

// Plan LZD-0009 M9, LazurioPlatform step 2 of Lazurio Auth's contract
// `docs/agent-application-entry.md`: the agent rule in the Folder's manual,
// next to "Lazurio only in the user's own browser", exactly as the contract
// words it; and Settings → Tento Environment shows the Assigned User's
// switch ("Agents in colleagues' applications"), read through the
// Environment's relay as the Environment, with a link to the Dashboard page
// where the person switches it. Nothing here switches anything: that is the
// person's, in their own browser. Every name is invented.

const rule = {
  cs: "- **Aplikace kolegů.** `lazurio apps shared --json` vypíše aplikace, které kolegové uživateli zpřístupnili. Otevírej je jen příkazem `lazurio apps open <modul> --org <organizace>`: otevře tuto jednu aplikaci v okně tvého prohlížeče jednorázovým předáním, jako uživatele s jeho rolí aplikace. Adresu takové aplikace nikdy neskládej ani nepiš sám a nikdy se v ní nepřihlašuj. Kde stránka nabízí nástroje WebMCP, používej je. Jednáš s rolí uživatele: Publikaci (odeslání, schválení, smazání nebo cokoli, co uvidí ostatní a nejde snadno vrátit) nikdy nedokončíš bez jeho výslovného pokynu v tomto vlákně. Odpověď `agent_entry_off` znamená, že uživatel tuto možnost pro toto Prostředí vypnul: řekni mu, kde ji zapne (jeho Prostředí v Lazuriu, Nastavení), a nikdy ji neobcházej.",
  en: "- **Colleagues' applications.** `lazurio apps shared --json` lists the applications colleagues share with the user. Open one only with `lazurio apps open <module> --org <organization>`: it opens that one application in your browser window through a one-time hand-over, as the user with their application role. Never compose or type such an address yourself and never sign in there. Use the page's WebMCP tools where it offers them. You act with the user's role: never complete a Publication (sending, submitting, approving, deleting or anything others will see and cannot easily undo) without the user's explicit word in this thread. `agent_entry_off` means the user switched this off for this Environment: tell them where to switch it on (their Environment in Lazurio, Settings) and never get around it.",
} as const;
const beside = {
  cs: "- **Lazurio jen ve vlastním prohlížeči uživatele.**",
  en: "- **Lazurio only in the user's own browser.**",
} as const;

const manualOf = (
  preset: PresetName,
  machine: MachineBinding,
  locale: "cs" | "en",
) =>
  renderManual({
    preset,
    machine,
    profile: presetProfile(preset, "linux", { locale }),
  })["manual/this-machine.md"] as string;

test("the manual's rule on colleagues' applications, exactly as the contract words it, right after Lazurio only in the user's own browser", () => {
  for (const locale of ["cs", "en"] as const) {
    for (const [preset, machine] of [
      ["hosted-organization-personal", bindings.organizationBrowser],
      ["hosted-personal", bindings.personalBrowser],
    ] as const) {
      const manual = manualOf(preset, machine, locale);
      expect(manual).toContain(rule[locale]);
      const lines = manual.split("\n");
      const at = lines.indexOf(rule[locale]);
      expect(lines[at - 1]?.startsWith(beside[locale])).toBe(true);
    }
    // Not on a Team Environment (out of the contract's scope), and not
    // where there is no Environment browser to open an application in.
    expect(
      manualOf("hosted-organization-team", bindings.teamBrowser, locale),
    ).not.toContain(rule[locale]);
    expect(
      manualOf("hosted-organization-personal", bindings.organization, locale),
    ).not.toContain(rule[locale]);
  }
});

const page = "https://dashboard.lazurio.ai/orgs/example/environments";

test("Settings → Tento Environment: the switch's state in the user's words and the Dashboard page where it is changed", () => {
  const cs = messages("cs", "work");
  const en = messages("en", "work");
  const on = agentEntryView({ available: true, agentEntry: "on", page }, cs);
  expect(on).toEqual({
    title: "Agenti v aplikacích kolegů",
    state: "Zapnuto",
    hint: expect.stringContaining("s vaší rolí aplikace"),
    link: { href: page, text: "Změnit v Lazuriu" },
  });
  expect(on?.hint).toContain("Publikace");
  expect(
    agentEntryView({ available: true, agentEntry: "off", page }, cs),
  ).toMatchObject({ state: "Vypnuto", link: { href: page } });
  // Unknown is never shown as off.
  const unknown = agentEntryView(
    { available: true, agentEntry: null, page },
    cs,
  );
  expect(unknown?.state).toBe("Stav teď nejde zjistit");
  expect(unknown?.link.href).toBe(page);
  expect(
    agentEntryView({ available: true, agentEntry: "on", page }, en),
  ).toMatchObject({
    title: "Agents in colleagues' applications",
    state: "On",
    link: { href: page, text: "Change in Lazurio" },
  });
  // Where the Environment has no switch, or before the answer: nothing.
  expect(agentEntryView({ available: false }, cs)).toBeNull();
  expect(agentEntryView(null, cs)).toBeNull();
  // The words follow the rules for Czech user text: Prostředí, formal
  // address, Lazurio rather than an internal name.
  for (const view of [
    on,
    unknown,
    agentEntryView({ available: true, agentEntry: "off", page }, cs),
  ])
    for (const text of [view?.title, view?.state, view?.hint, view?.link.text])
      expect(text ?? "").not.toMatch(
        /Launchpad|Dashboard|Environment|\btvoj|\bty\b/,
      );
});

// ---- The Launchpad's route ---------------------------------------------------

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const listAnswer = (agentEntry: "on" | "off") =>
  Response.json({
    schema: "lazurio.environment-shared-applications.v1",
    environment: "environment-work03",
    agentEntry,
    sharedApplications: [],
  });

async function hostedLaunchpad(
  preset: PresetName,
  document: Record<string, unknown>,
  host: string,
  listenPort: number,
  relay: FakeRelay | null,
) {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "agent-entry-")));
  cleanups.push(() => rm(parent, { recursive: true, force: true }));
  const folder = join(parent, "Lazurio");
  await mkdir(folder, { mode: 0o700 });
  await mkdir(join(folder, "organizations"), { mode: 0o755 });
  await mkdir(join(folder, "personalspace"), { mode: 0o700 });
  await initializeHandoverFolder(folder, {
    preset,
    machine: binding(document),
    profile: presetProfile(preset, executionOs(process.platform)),
  });
  const app = await startLaunchpad(
    folder,
    undefined,
    undefined,
    undefined,
    {
      fetcher: async (_url, init) =>
        new Headers(init.headers).get("cookie") ===
        "__Secure-lazurio-workspace=valid"
          ? new Response("ok")
          : new Response("no", { status: 401 }),
      ownerKey: async () => "Example",
      agentEntryTransport: () =>
        unixSocketTransport(relay?.socket ?? join(parent, "no-relay.sock")),
    },
    {
      path: parent,
      home: parent,
      platform: process.platform,
      run: async () => "timeout",
    },
    {},
    // Positions 7 to 15: recovery, module, documents, content, browser
    // view, vault, Executor, Integrace.
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    // The Organization's settings poller never asks the relay in this test.
    {
      transport: () => unixSocketTransport(join(parent, "no-relay.sock")),
      poller: { startupDelayMs: 3_600_000, intervalMs: 3_600_000 },
    },
    processNewTabHost({}, process.platform),
  );
  cleanups.push(() => app.close());
  const launchpad = `https://launchpad.${host}`;
  return async () => {
    const answer = await fetch(
      `http://127.0.0.1:${listenPort}/api/agent-entry`,
      {
        method: "POST",
        headers: {
          host: new URL(launchpad).host,
          cookie: "__Secure-lazurio-workspace=valid",
          origin: launchpad,
          "sec-fetch-site": "same-origin",
          "content-type": "application/json",
        },
        body: "{}",
      },
    );
    return { status: answer.status, body: await answer.json() };
  };
}

function workDocument(host: string, relay: boolean, listenPort: number) {
  const { team: _team, ...withoutTeam } = organization.owner;
  const routed = withBrowser(handoverEntry(host, listenPort), host);
  return {
    ...organization,
    owner: withoutTeam,
    entry: relay ? withEnvironmentRelay(routed) : routed,
  };
}

test.skipIf(process.platform === "win32")(
  "POST /api/agent-entry: the switch read through the relay as this Environment, never as the person, and the Dashboard page",
  async () => {
    const host = "work03.example.lazurio.io";
    let state: "on" | "off" | "down" = "on";
    const relay = await fakeRelay(() =>
      state === "down" ? new Response("", { status: 502 }) : listAnswer(state),
    );
    cleanups.push(() => relay.close());
    const port = freePort();
    const ask = await hostedLaunchpad(
      "hosted-organization-personal",
      workDocument(host, true, port),
      host,
      port,
      relay,
    );
    expect(await ask()).toEqual({
      status: 200,
      body: { available: true, agentEntry: "on", page },
    });
    state = "off";
    expect((await ask()).body).toEqual({
      available: true,
      agentEntry: "off",
      page,
    });
    // Not readable now: unknown with its reason, never "off".
    state = "down";
    expect((await ask()).body).toEqual({
      available: true,
      agentEntry: null,
      reason: "relay-unreachable",
      page,
    });
    // Only the relay's read path, with nothing of the person: no cookie,
    // no token.
    expect(relay.requests.length).toBe(3);
    for (const request of relay.requests) {
      expect([request.method, request.path]).toEqual([
        "GET",
        "/shared-applications",
      ]);
      expect(request.headers.cookie).toBeUndefined();
      expect(request.headers.authorization).toBeUndefined();
    }
  },
);

test.skipIf(process.platform === "win32")(
  "POST /api/agent-entry: no switch where the Environment has no relay or is a Team's, and a personal one's page is the Dashboard home",
  async () => {
    const relay = await fakeRelay(() => listAnswer("on"));
    cleanups.push(() => relay.close());
    const host = "work03.example.lazurio.io";
    const port = freePort();
    const noRelay = await hostedLaunchpad(
      "hosted-organization-personal",
      workDocument(host, false, port),
      host,
      port,
      relay,
    );
    expect(await noRelay()).toEqual({
      status: 200,
      body: { available: false },
    });
    const teamPort = freePort();
    const team = await hostedLaunchpad(
      "hosted-organization-team",
      { ...workDocument(host, true, teamPort), owner: organization.owner },
      host,
      teamPort,
      relay,
    );
    expect((await team()).body).toEqual({ available: false });
    expect(relay.requests).toEqual([]);

    const personalHost = "example.lazurio.io";
    const personalPort = freePort();
    const own = await hostedLaunchpad(
      "hosted-personal",
      {
        ...personal,
        entry: withEnvironmentRelay(
          withBrowser(handoverEntry(personalHost, personalPort), personalHost),
        ),
      },
      personalHost,
      personalPort,
      relay,
    );
    expect((await own()).body).toEqual({
      available: true,
      agentEntry: "on",
      page: "https://dashboard.lazurio.ai/home",
    });
  },
);
