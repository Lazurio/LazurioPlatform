import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeHandoverFolder } from "../src/folder/initialize-folder";
import type { MachineBinding } from "../src/folder/machine-binding";
import { executionOs } from "../src/folder/platform";
import { type PresetName, presetProfile } from "../src/folder/presets";
import { refreshFolder } from "../src/folder/update-profile";
import { chatHref, parseEntryAnswer } from "../src/launchpad/chat-view";
import {
  type AiFact,
  type TourFacts,
  tourStop,
} from "../src/launchpad/first-run";
import type { AuthFetcher } from "../src/launchpad/hosted-trust";
import { messages } from "../src/launchpad/messages";
import { isPublicEnvironment } from "../src/launchpad/public-environment";
import { startLaunchpad } from "../src/launchpad/server";
import { shellDocument } from "../src/launchpad/shell-document";
import { demoModule, demoStartView } from "../src/launchpad/start-view";
import { readFolderCatalog } from "../src/organizations/catalog";
import { parseShell, type Shell } from "../src/shell/contract";
import { shellMessages } from "../src/shell/messages";
import { columnHead } from "../src/shell/view";
import { parseAiAnswer } from "../src/tools/ai";
import { runTool } from "../src/tools/status";
import { writeOrganization } from "./fixtures/catalog-folder";
import { fakeAiClis } from "./fixtures/fake-ai-clis";
import {
  assignments,
  binding,
  handoverEntry,
  withAudience,
  withBrowser,
  withSignOut,
} from "./fixtures/machine-bindings";
import { freePort } from "./fixtures/ports";

// try-01, the shared Team Environment of the public reference Organization
// LazurioExampleOrganization, as its handover is shaped (the try-01 preset
// shaping study, section 2 (C)): a workspace VM of the Organization assigned
// to a Team, with no tailnet (`network`) and no relay to the Dashboard, behind
// a gateway that admits any Lazurio account (`entry.audience: "public"`), with
// the person's sign-out and the Environment browser; once with its vault, once
// without. Its Folder is recorded as Work, as the live one most likely is, and
// as Team. Decision F55's addendum of 2026-10-20 (plan DEV-6668, slices 1 and
// 3): the column head says only what is true there and links the terms, and
// the demo's Chat row and tour stop follow the live AI fact. The controls are
// a member's Work Environment of the same Organization (lazurio-bob: assigned
// to one operator, no tailnet, not public) and a Team Environment (team-01,
// on the tailnet, not public); nothing changes on them.

const posixTest = test.skipIf(process.platform === "win32");

const organization = "lazurioexampleorganization";
const zone = `${organization}.lazurio.io`;
const host = (vm: string) => `${vm}.${zone}`;
const base = {
  schema_version: "lazurio.machine.v1",
  operator: {
    os_user: "operator",
    home: "/home/operator",
    lazurio_root: "/home/operator/Lazurio",
  },
  host: {
    kind: "virtualization-host",
    machine_id: "example-host",
    custody_repository: "LazurioExampleOrganization/infra",
    provider: "example",
  },
  installed: {
    machines_release: {
      repository: "HumanAndMachine-ai/Machines",
      version: "v1.0.0",
      commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    },
    deployment_head: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    recorded_at: "2026-01-01T00:00:00Z",
  },
  account: null,
} as const;
const owner = {
  kind: "organization",
  organization,
  organization_key: "LazurioExampleOrganization",
} as const;
// The entry Machines writes behind the Platform Launchpad: the sign-out and
// the Environment browser's view.
const entryOf = (vm: string, listenPort: number) =>
  withSignOut(withBrowser(handoverEntry(host(vm), listenPort), host(vm)));

/** try-01's handover: public, no network, no relay; `vault` with its account
 * in the vault of the Conglomerate Host. */
function tryHandover(listenPort = 20000, vault = false) {
  return {
    ...base,
    machine: {
      id: `${organization}-try-01`,
      kind: "workspace-vm",
      name: "try-01",
      vmid: 160,
    },
    owner: { ...owner, team: "workspace", assignment: assignments.team },
    entry: withAudience(entryOf("try-01", listenPort)),
    ...(vault
      ? {
          vault: {
            server_url: `https://vaultwarden.${zone}`,
            account: `vaultwarden-${"a".repeat(26)}@${host("try-01")}`,
            name: "LazurioExampleOrganization try 01",
          },
        }
      : {}),
  };
}
// A member's Work Environment: one operator, no tailnet, not public.
const bob = binding({
  ...base,
  machine: {
    id: `${organization}-lazurio-bob`,
    kind: "workspace-vm",
    name: "lazurio-bob",
    vmid: 161,
  },
  owner: {
    ...owner,
    assignment: { kind: "operator", github_login: "lazurio-bob", github_id: 1 },
  },
  entry: entryOf("lazurio-bob", 20000),
});
// The Team Environment: on the tailnet, not public. Its GitHub broker is
// Machines'; the handover carries none.
const team01 = binding({
  ...base,
  machine: {
    id: `${organization}-team-01`,
    kind: "workspace-vm",
    name: "team-01",
    vmid: 162,
  },
  owner: { ...owner, team: "workspace", assignment: assignments.team },
  network: {
    headscale_server_url: "https://network.example.invalid",
    headscale_hostname: `${organization}-team-01`,
  },
  entry: entryOf("team-01", 20000),
});

const work = "hosted-organization-personal";
const team = "hosted-organization-team";
// The Folder as it may be recorded, and the kind people are shown on it: the
// Try overlay preset shows a Team Environment whatever the record (F55's
// addendum of 2026-10-20, the Try overlay preset).
const recorded = [
  [work, "Týmové", "Team", "Work"],
  [team, "Týmové", "Team", "Team"],
] as const;
const catalog = { kind: "catalog", organizations: [] } as const;

/** The shell document of `machine` on `preset`, as a host's page reads it. */
function shellOf(preset: PresetName, machine: MachineBinding): Shell {
  const document = shellDocument({ preset, machine, locale: "cs", catalog });
  const shell = parseShell(JSON.parse(JSON.stringify(document)));
  if (shell === null) throw new Error("The shell document parses");
  return shell;
}
const heads = ["apps", "chat", "automate", "settings"] as const;
const noticeOf = (shell: Shell, locale: "cs" | "en", active: string) =>
  columnHead(shell, shellMessages(locale), {
    space: null,
    active,
    settings: null,
  })?.notice;

// The exact words, by the kind the recorded preset shows.
const czech = (kind: string) => ({
  text: `Toto ${kind} Prostředí je veřejné a sdílené a kdykoli se může smazat nebo založit znovu. Když se přihlásíte ke svému účtu, po použití se odhlaste, protože ostatní vidí, co tu necháte; ke GitHubu se tu přihlásit nejde.`,
  terms: {
    label: "Podmínky vyzkoušení Lazuria",
    href: "https://lazurio.ai/cs/vyzkouset/podminky/",
  },
});
const english = (kind: string) => ({
  text: `This ${kind} Environment is public and shared and can be wiped or deployed again at any time. If you sign in to your own account, sign out after use, because others see what you leave behind; GitHub sign-in is not available here.`,
  terms: {
    label: "Terms for trying Lazurio",
    href: "https://lazurio.ai/try/terms/",
  },
});

// --- Slice 1: the column head --------------------------------------------

test("try-01's column head says it can be wiped at any time, not every night, lets a visitor's own sign-in be signed out after use, says GitHub is not available and links the terms in the page's language", () => {
  for (const vault of [false, true])
    for (const [preset, cs, en] of recorded) {
      const shell = shellOf(preset, binding(tryHandover(20000, vault)));
      expect(shell.audience).toBe("public");
      for (const active of heads) {
        expect(noticeOf(shell, "cs", active)).toEqual(czech(cs));
        expect(noticeOf(shell, "en", active)).toEqual(english(en));
      }
      const words = JSON.stringify([
        noticeOf(shell, "cs", "apps"),
        noticeOf(shell, "en", "apps"),
      ]);
      // Nothing it cannot keep: no nightly reset exists, and a visitor may
      // sign in to an own account (the Owner's decision of 2026-10-20).
      for (const untrue of [
        "každou noc",
        "every night",
        "nightly",
        "nepřihlašujte",
        "Do not",
      ])
        expect([untrue, words.includes(untrue)]).toEqual([untrue, false]);
    }
});

test("the controls have no notice: a member's Work Environment and the Team Environment, neither of them public", () => {
  for (const [preset, machine] of [
    [work, bob],
    [team, team01],
  ] as const) {
    expect(isPublicEnvironment(machine.entry ?? null)).toBe(false);
    const shell = shellOf(preset, machine);
    expect(Object.hasOwn(shell, "audience")).toBe(false);
    for (const active of heads)
      for (const locale of ["cs", "en"] as const) {
        const head = columnHead(shell, shellMessages(locale), {
          space: null,
          active,
          settings: null,
        });
        expect(head).not.toBeNull();
        expect(Object.hasOwn(head as object, "notice")).toBe(false);
      }
  }
});

// --- Slice 3: the demo follows the AI fact ------------------------------

const cs = messages("cs");
const en = messages("en");
const chat = `https://t3code.${host("try-01")}`;
const module = { name: "deals", href: `/o/${organization}/deals` };
const facts = (preset: string, ai: AiFact, audience = true): TourFacts => ({
  preset,
  ...(audience ? { audience: "public" as const } : {}),
  ai,
  github: "missing",
  content: { state: "ready" },
});
const apps = { chat: true, automate: false };

// What the Chat row and the tour's Chat stop say, by the AI fact.
const said = {
  organization: {
    cs: "Chat odpovídá přes AI této Organizace.",
    en: "Chat answers through this Organization's AI.",
  },
  connected: {
    cs: "AI je v této ukázce připojené.",
    en: "AI is connected in this demo.",
  },
  none: {
    cs: "AI v této ukázce není připojené.",
    en: "AI is not connected in this demo.",
  },
} as const;
const byFact: Readonly<Record<AiFact, keyof typeof said>> = {
  organization: "organization",
  connected: "connected",
  missing: "none",
  unknown: "none",
  loading: "none",
};

test("try-01's Začínáme and tour say Chat answers through the Organization's AI when it provides one, and 'not connected' only while the AI is missing or not known", () => {
  for (const [preset] of recorded)
    for (const [ai, words] of Object.entries(byFact) as [
      AiFact,
      keyof typeof said,
    ][]) {
      for (const [locale, copy] of [
        ["cs", cs],
        ["en", en],
      ] as const) {
        const row = demoStartView({ chat, module, ai }, copy).rows.find(
          (each) => each.id === "chat",
        );
        expect([preset, ai, locale, row?.status]).toEqual([
          preset,
          ai,
          locale,
          said[words][locale],
        ]);
        // The row's other parts are what they were.
        expect(row?.text).toBe(copy.startDemoChatText);
        expect(row?.action).toEqual({
          label: copy.startOpen,
          href: chat,
          app: "chat",
        });
        expect(tourStop("chat", facts(preset, ai), apps, copy).text).toBe(
          `${copy.startDemoChatText} ${said[words][locale]}`,
        );
      }
    }
  // No model and no provider is named, whatever the AI.
  const all = JSON.stringify(
    (Object.keys(byFact) as AiFact[]).flatMap((ai) => [
      demoStartView({ chat, module, ai }, cs),
      demoStartView({ chat, module, ai }, en),
    ]),
  );
  for (const name of ["gpt", "GPT", "Codex", "ChatGPT", "Claude", "luna"])
    expect([name, all.includes(name)]).toEqual([name, false]);
});

test("the controls' tour says what it says everywhere, whatever the AI", () => {
  for (const [preset] of [
    [work, bob],
    [team, team01],
  ] as const)
    for (const ai of Object.keys(byFact) as AiFact[]) {
      expect(tourStop("chat", facts(preset, ai, false), apps, cs).text).toBe(
        "Práce s agenty.",
      );
      expect(tourStop("chat", facts(preset, ai, false), apps, en).text).toBe(
        "Work with agents.",
      );
    }
});

// --- Over HTTP, behind the gateway --------------------------------------

/** try-01 served by its own Launchpad behind a fake gateway that admits the
 * cookie `valid`, its Folder recorded as `preset`, with a fake Codex (no
 * Claude Code) whose answer the test switches through files in `home`. */
async function tryLaunchpad(preset: PresetName) {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "public-try-")));
  const home = join(parent, "home");
  await mkdir(join(home, "Documents"), { recursive: true, mode: 0o700 });
  const bin = await fakeAiClis(home, ["codex"]);
  const folder = join(parent, "Lazurio");
  await mkdir(folder, { mode: 0o700 });
  await mkdir(join(folder, "organizations"), { mode: 0o755 });
  await mkdir(join(folder, "personalspace"), { mode: 0o700 });
  await writeOrganization(folder, "LazurioExampleOrganization_GEN3", {
    slug: organization,
    forge: "LazurioExampleOrganization",
    state: "current",
    modules: [{ id: "deals" }],
  });
  const handover = tryHandover(freePort());
  const machine = binding(handover);
  const entry = machine.entry;
  if (entry === undefined) throw new Error("The fixture has an entry");
  // A new choice on a Team assignment is Team alone. The live Folder kept
  // Work from a handover that stated no assignment yet, and a refresh keeps
  // a preset chosen then: recorded so here too.
  const { assignment: _, ...unassigned } = handover.owner;
  await initializeHandoverFolder(folder, {
    preset,
    machine:
      preset === team ? machine : binding({ ...handover, owner: unassigned }),
    profile: presetProfile(preset, executionOs(process.platform), {
      locale: "cs",
    }),
  });
  if (preset !== team)
    expect((await refreshFolder(folder, machine)).kind).toBe("refreshed");
  const fetcher: AuthFetcher = async (_url, init) =>
    new Headers(init.headers).get("cookie") ===
    "__Secure-lazurio-workspace=valid"
      ? new Response("ok")
      : new Response("no", { status: 401 });
  const app = await startLaunchpad(
    folder,
    undefined,
    undefined,
    undefined,
    { fetcher },
    { path: bin, home, platform: process.platform, run: runTool },
    {},
    undefined,
    undefined,
    { home, platform: process.platform, folder },
  );
  const headers = {
    host: new URL(entry.externalOrigin).host,
    cookie: "__Secure-lazurio-workspace=valid",
  };
  return {
    folder,
    home,
    get: async (path: string): Promise<unknown> => {
      const answer = await fetch(
        `http://127.0.0.1:${entry.listenPort}${path}`,
        { headers },
      );
      expect([path, answer.status]).toEqual([path, 200]);
      return answer.json();
    },
    async close() {
      await app.close();
      await rm(parent, { recursive: true, force: true });
    },
  };
}

for (const [preset, kindCs, kindEn, recordedAs] of recorded)
  posixTest(
    `hosted try-01 recorded as ${recordedAs}: its shell document draws the notice, and Začínáme and the tour follow GET /api/ai as Codex answers it`,
    async () => {
      const app = await tryLaunchpad(preset);
      try {
        const shell = parseShell(await app.get("/.lazurio/shell.json"));
        if (shell === null) throw new Error("The shell document parses");
        expect(noticeOf(shell, "cs", "chat")).toEqual(czech(kindCs));
        expect(noticeOf(shell, "en", "chat")).toEqual(english(kindEn));
        const entry = parseEntryAnswer(await app.get("/api/entry"));
        expect(isPublicEnvironment(entry)).toBe(true);
        const chatHere = chatHref(entry);
        expect(chatHere).toBe(chat);
        const moduleHere = demoModule(await readFolderCatalog(app.folder));
        expect(moduleHere).toEqual(module);
        // What the page draws once GET /api/ai answers.
        const drawn = async () => {
          const reading = parseAiAnswer(await app.get("/api/ai?fresh=1"));
          if (reading === null) throw new Error("The AI answers");
          const row = demoStartView(
            { chat: chatHere, module: moduleHere, ai: reading.state },
            cs,
          ).rows.find((each) => each.id === "chat");
          return {
            ai: reading.state,
            row: row?.status,
            tour: tourStop("chat", facts(preset, reading.state), apps, en).text,
          };
        };
        // The Organization's AI pool: a Codex provider that needs no OpenAI
        // sign-in.
        await writeFile(join(app.home, "codex.provided"), "");
        expect(await drawn()).toEqual({
          ai: "organization",
          row: said.organization.cs,
          tour: `Work with agents. ${said.organization.en}`,
        });
        // Without it, Codex signed out and no Claude Code: missing.
        await rm(join(app.home, "codex.provided"));
        expect(await drawn()).toEqual({
          ai: "missing",
          row: said.none.cs,
          tour: `Work with agents. ${said.none.en}`,
        });
        // Someone signed Codex in to a ChatGPT account here.
        await mkdir(join(app.home, ".codex"), { recursive: true });
        await writeFile(join(app.home, ".codex", "auth.json"), "{}");
        expect(await drawn()).toEqual({
          ai: "connected",
          row: said.connected.cs,
          tour: `Work with agents. ${said.connected.en}`,
        });
      } finally {
        await app.close();
      }
    },
    30_000,
  );
