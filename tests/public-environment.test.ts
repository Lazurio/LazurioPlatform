import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeHandoverFolder } from "../src/folder/initialize-folder";
import {
  machineIdentity,
  parseMachineBinding,
} from "../src/folder/machine-binding";
import { executionOs } from "../src/folder/platform";
import { presetProfile } from "../src/folder/presets";
import { refreshFolder } from "../src/folder/update-profile";
import { bootJson, parseBoot } from "../src/launchpad/boot";
import { publicEntry } from "../src/launchpad/chat";
import { parseEntryAnswer } from "../src/launchpad/chat-view";
import type { ContentItem, ContentList } from "../src/launchpad/content-client";
import type { ContentFact } from "../src/launchpad/content-view";
import {
  appsSetupLine,
  autoStartStep,
  contentBlockedBy,
  firstProgress,
  freshTourProgress,
  idleAutoStart,
  nextBasic,
  shellSetup,
  startDecision,
  type TourFacts,
  tourStep,
  tourStop,
} from "../src/launchpad/first-run";
import type { AuthFetcher } from "../src/launchpad/hosted-trust";
import { messages } from "../src/launchpad/messages";
import {
  isPublicEnvironment,
  isToolsApiPath,
  publicRoute,
  withheldInPublic,
} from "../src/launchpad/public-environment";
import { pageRoute } from "../src/launchpad/routes";
import { startLaunchpad } from "../src/launchpad/server";
import { shellDocument } from "../src/launchpad/shell-document";
import {
  demoModule,
  demoStartView,
  type StartFacts,
  startCount,
  startView,
} from "../src/launchpad/start-view";
import { parseMachineContext } from "../src/machine/context";
import schema from "../src/machine/lazurio-machine.v1.schema.json";
import provenance from "../src/machine/schema-provenance.json";
import { readFolderCatalog } from "../src/organizations/catalog";
import {
  parseShell,
  parseShellAccount,
  type Shell,
  type ShellAccount,
} from "../src/shell/contract";
import { mergeAccount } from "../src/shell/merge";
import { shellMessages } from "../src/shell/messages";
import { columnHead } from "../src/shell/view";
import type { ToolRunner } from "../src/tools/status";
import { accountDocument } from "./fixtures/account-document";
import { writeOrganization } from "./fixtures/catalog-folder";
import {
  assignments,
  binding,
  bindings,
  entries,
  organizationWithEntry,
  withAudience,
} from "./fixtures/machine-bindings";
import organization from "./fixtures/machine-context.json";
import { freePort } from "./fixtures/ports";

// Root decision 0204 points 3, 4 and 6 and its line on 0201: a public
// Environment of the public reference Organization, which every Lazurio
// account may enter. Machines writes the handover's `entry.audience:
// "public"` for such a work VM (Machines #560, behind its own Platform
// gate); the Launchpad then runs a demo onboarding instead of Začínáme's
// sign-ins, says in the shell's column head that the Environment is public
// and shared, and has no Integrace and no Nastavení → Nástroje, whose rows
// sign tools in, and no Trezor without its own vault (with it:
// tests/public-vault.test.ts, plan DEV-6668 slice 6). Without the member
// nothing changes. Example names only.

const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
const { team: _, ...withoutTeam } = organization.owner;
const workVm = { ...organization, owner: withoutTeam };
const cs = messages("cs");
const en = messages("en");
const shellCs = shellMessages("cs");
const shellEn = shellMessages("en");
const posixTest = test.skipIf(process.platform === "win32");

// --- The handover and the binding -------------------------------------

test("the vendored schema carries Machines #560's entry.audience, exactly the constant public", () => {
  // Re-pinned since to Machines #633, which adds only
  // `entry.browser.local_port` (tests/environment-browser-loopback-entry.test.ts),
  // then to Machines #664, which adds only the `services` assignment and
  // list (tests/server-services-environment.test.ts), and then to Machines
  // #811 (v0.12.191), which adds only `entry.buddy` (tests/shell-buddy.test.ts).
  expect(provenance.source_pull_request).toBe(
    "https://github.com/HumanAndMachine-ai/Machines/pull/811",
  );
  const audience = (
    schema as unknown as {
      $defs: { entry: { properties: Record<string, unknown> } };
    }
  ).$defs.entry.properties.audience;
  expect(audience).toEqual({
    description: expect.any(String),
    const: "public",
  });
});

test("a handover's audience is read exactly as written and projected into the binding; without it nothing changes", () => {
  const input = { ...workVm, entry: withAudience(entries.organization) };
  const context = parseMachineContext(bytes(input));
  expect(JSON.stringify(context)).toBe(JSON.stringify(input));
  expect(context.entry?.audience).toBe("public");
  const recorded = bindings.organizationPublic;
  expect(recorded.entry?.audience).toBe("public");
  // Everything else of the entry is what it was without the member.
  const { audience: __, ...rest } = recorded.entry as NonNullable<
    typeof recorded.entry
  >;
  expect(rest).toEqual(bindings.organizationEntry.entry as typeof rest);
  // A declaration about the entry, outside the Machine's identity.
  expect(machineIdentity(recorded)).toEqual(
    machineIdentity(bindings.organizationEntry),
  );
  // The recorded binding reads back as itself, on a Team Environment too.
  for (const public_ of [recorded, bindings.teamPublic])
    expect(parseMachineBinding(JSON.parse(JSON.stringify(public_)))).toEqual(
      public_,
    );
  // Without it, the binding is byte for byte what it was.
  expect(JSON.stringify(bindings.organizationEntry)).not.toContain("audience");
  // The page learns it from the Launchpad's public entry, only when present.
  expect(publicEntry(recorded.entry ?? null)?.audience).toBe("public");
  const plain = publicEntry(bindings.organizationEntry.entry ?? null);
  expect(plain).not.toBeNull();
  expect(Object.hasOwn(plain as object, "audience")).toBe(false);
});

for (const [name, audience] of Object.entries({
  "another audience": "private",
  "another case": "Public",
  "a list": ["public"],
  "an object": { kind: "public" },
  "a boolean": true,
  "a null": null,
}))
  test(`the schema refuses ${name} as the audience, and no binding records it`, () => {
    expect(() =>
      parseMachineContext(
        bytes({
          ...workVm,
          entry: withAudience(entries.organization, audience),
        }),
      ),
    ).toThrow("machine-context-invalid");
    expect(() =>
      parseMachineBinding({
        ...bindings.organizationEntry,
        entry: { ...bindings.organizationEntry.entry, audience },
      }),
    ).toThrow();
  });

posixTest(
  "a refresh records the audience the handover gained, and the generated texts then say there is no GitHub identity",
  async () => {
    const parent = await realpath(
      await mkdtemp(join(tmpdir(), "public-handover-")),
    );
    const folder = join(parent, "Lazurio");
    try {
      await mkdir(folder, { mode: 0o700 });
      await mkdir(join(folder, "organizations"), { mode: 0o700 });
      await initializeHandoverFolder(folder, {
        preset: "hosted-organization-personal",
        machine: bindings.organizationEntry,
        profile: presetProfile(
          "hosted-organization-personal",
          executionOs(process.platform),
        ),
      });
      const before = await readFile(join(folder, "AGENTS.md"), "utf8");
      const gained = binding({
        ...workVm,
        entry: withAudience(entries.organization),
      });
      expect(await refreshFolder(folder, gained)).toEqual({
        kind: "refreshed",
        revision: 2,
      });
      const preferences = JSON.parse(
        await readFile(join(folder, ".lazurio", "preferences.json"), "utf8"),
      );
      expect(preferences.machine.entry.audience).toBe("public");
      // Decision F55's addendum of 2026-10-17: a public Environment has no
      // GitHub identity, and its agents' texts say so instead of the
      // Operator's own sign-in.
      const after = await readFile(join(folder, "AGENTS.md"), "utf8");
      expect(before).toContain(
        "- Identity: the user's own sign-ins. GitHub is the authority for source code (repositories, review, Publication), and Headscale holds the network. Entry to Environments is to be held by the Lazurio account (the target of root decision 0192); until that move is done, the existing path decides, a Team Environment's GitHub Team, say (`manual/lazurio.md`).",
      );
      expect(after).not.toContain("the user's own sign-ins");
      expect(after).toContain("- Identity: no GitHub identity.");
      expect(after).toContain(
        "- GitHub: this Environment has no GitHub identity.",
      );
      expect(after).not.toContain("gh auth status");
      expect(await refreshFolder(folder, gained)).toEqual({
        kind: "unchanged",
      });
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  },
);

test("the entry's answer and the boot document carry the audience only as public", () => {
  const entry = publicEntry(bindings.organizationPublic.entry ?? null);
  expect(parseEntryAnswer({ kind: "entry", entry })).toEqual(entry);
  expect(isPublicEnvironment(parseEntryAnswer({ kind: "entry", entry }))).toBe(
    true,
  );
  for (const audience of ["private", null, true, ""])
    expect(
      parseEntryAnswer({ kind: "entry", entry: { ...entry, audience } }),
    ).toBeNull();
  const boot = {
    locale: "cs" as const,
    shell: null,
    catalog: null,
    entry,
    vaultInApps: null,
  };
  expect(parseBoot(bootJson(boot))?.entry).toEqual(entry);
  // Without the member: not public, and nothing in the answer says so.
  const plain = publicEntry(bindings.organizationEntry.entry ?? null);
  expect(
    isPublicEnvironment(parseEntryAnswer({ kind: "entry", entry: plain })),
  ).toBe(false);
  expect(isPublicEnvironment(null)).toBe(false);
  expect(bootJson({ ...boot, entry: plain })).not.toContain("audience");
});

// --- The demo onboarding ----------------------------------------------

const organizationItem: ContentItem = {
  kind: "organization",
  login: "example",
  name: "Example Company",
  state: "absent",
};
const listOf = (...items: ContentItem[]): ContentList => ({
  allowed: true,
  items,
});
const missing: ContentFact = { state: "missing", item: organizationItem };
const ready: ContentFact = { state: "ready" };

// A visitor's facts: nobody signed in to an AI or to GitHub, which a public
// Environment never asks for, on the presets a work VM of the public
// Organization may have.
const demoFacts = (
  preset: string,
  overrides: Partial<StartFacts> = {},
): StartFacts => ({
  preset,
  audience: "public",
  ai: "missing",
  aiReading: { state: "missing", providers: [] },
  github: "missing",
  githubLogin: null,
  content: ready,
  list: listOf({ ...organizationItem, state: "present" }),
  ...overrides,
});
const publicPresets = [
  "hosted-organization-personal",
  "hosted-organization-team",
] as const;

for (const preset of publicPresets)
  test(`a public ${preset} Environment has no basics: no AI step, no GitHub step, no vault, no count, no line and no prompt`, () => {
    for (const facts of [
      demoFacts(preset),
      demoFacts(preset, { github: "unknown", ai: "loading" }),
      demoFacts(preset, { content: missing, list: listOf(organizationItem) }),
    ]) {
      expect(startView(facts, cs)).toBeNull();
      expect(startCount(facts)).toBeNull();
      expect(nextBasic(facts)).toBeNull();
      expect(appsSetupLine(facts, cs)).toBeNull();
      expect(
        shellSetup({
          preset,
          audience: "public",
          ai: facts.ai,
          github: facts.github,
          list: facts.list,
          job: null,
        }),
      ).toBeUndefined();
      // No start request leads to a sign-in or an installation.
      expect(startDecision("sign-in-gh", facts)).toBe("drop");
      expect(startDecision("install-content", facts)).toBe("drop");
      // Nothing starts by itself when a basic seems to arrive.
      const arrived = autoStartStep(
        { ai: false, github: false, armed: true },
        { ...facts, ai: "connected", github: "connected" },
        false,
      );
      expect(arrived.start).toBe(false);
      expect(autoStartStep(idleAutoStart, facts, false).start).toBe(false);
    }
  });

for (const preset of publicPresets)
  test(`a public ${preset} Environment's content waits for no AI: only a known missing GitHub holds it, as a Team's`, () => {
    for (const github of ["unknown", "connected"] as const)
      expect(
        contentBlockedBy({ preset, audience: "public", ai: "missing", github }),
      ).toBeNull();
    expect(
      contentBlockedBy({
        preset,
        audience: "public",
        ai: "missing",
        github: "missing",
      }),
    ).toBe("github");
  });

for (const preset of publicPresets)
  test(`the tour of a public ${preset} Environment is the introduction from its first visit, and Chat says there is no AI`, () => {
    const facts: TourFacts = demoFacts(preset);
    expect(firstProgress(facts)).toEqual(freshTourProgress);
    expect(tourStep(facts, freshTourProgress, null)).toBe("apps");
    expect(tourStep(facts, freshTourProgress, "start")).toBe("apps");
    expect(tourStep(facts, { intro: 1 }, "general")).toBe("chat");
    expect(tourStep(facts, { intro: 4 }, null)).toBeNull();
    const apps = { chat: true, automate: false };
    expect(tourStop("chat", facts, apps, cs).text).toBe(
      "Práce s agenty. AI v této ukázce není připojené.",
    );
    expect(tourStop("chat", facts, apps, en).text).toBe(
      "Work with agents. AI is not connected in this demo.",
    );
    // Apps: the modules are the Organization's, not the visitor's.
    expect(tourStop("apps", facts, apps, cs).text).toBe(
      "Aplikace modulů této Organizace.",
    );
    expect(tourStop("apps", facts, apps, en).text).toBe(
      "The apps of this Organization's modules.",
    );
    expect(
      tourStop("apps", { ...facts, audience: undefined }, apps, cs).text,
    ).toBe("Aplikace vašich modulů.");
    // The other stops say what they say everywhere.
    for (const step of ["automate", "settings"] as const)
      expect(tourStop(step, facts, apps, cs)).toEqual(
        tourStop(step, { ...facts, audience: undefined }, apps, cs),
      );
  });

test("Začínáme of a public Environment: Apps, a module and Chat, which says AI is not connected while it is missing", () => {
  const chat = "https://t3code.workspace.example.lazurio.io";
  const module = { name: "deals", href: "/o/example/deals" };
  const ai = "missing";
  expect(demoStartView({ chat, module, ai }, cs)).toEqual({
    intro: "Vyzkoušejte si Lazurio v tomto ukázkovém Prostředí.",
    rows: [
      {
        id: "apps",
        title: "Apps",
        text: "Aplikace modulů této Organizace.",
        status: null,
        action: { label: "Otevřít", href: "/" },
      },
      {
        id: "module",
        title: "deals",
        text: "Vyzkoušejte modul této Organizace.",
        status: null,
        action: { label: "Otevřít", href: "/o/example/deals" },
      },
      {
        id: "chat",
        title: "Chat",
        text: "Práce s agenty.",
        status: "AI v této ukázce není připojené.",
        action: { label: "Otevřít", href: chat, app: "chat" },
      },
    ],
  });
  const english = demoStartView({ chat, module: null, ai }, en);
  expect(english.intro).toBe("Try Lazurio in this demo Environment.");
  expect(english.rows.map((row) => [row.id, row.title, row.text])).toEqual([
    ["apps", "Apps", "The apps of this Organization's modules."],
    ["module", "A module", "Open any module in Apps."],
    ["chat", "Chat", "Work with agents."],
  ]);
  expect(english.rows[1]?.action).toEqual({ label: "Open", href: "/" });
  expect(english.rows[2]?.status).toBe("AI is not connected in this demo.");
  // Where the Environment has no Chat, its row says so without a button.
  const noChat = demoStartView({ chat: null, module, ai }, en);
  expect(noChat.rows[2]?.action).toBeNull();
  // Nothing in it signs anything in.
  const words = JSON.stringify([
    demoStartView({ chat, module, ai }, cs),
    english,
  ]);
  for (const word of ["GitHub", "ChatGPT", "Claude", "Bitwarden", "Trezor"])
    expect(words).not.toContain(word);
});

test("without the member Začínáme, the count, the line and the tour are what they were", () => {
  const person = demoFacts("hosted-organization-personal", {
    audience: undefined,
    content: missing,
    list: listOf(organizationItem),
  });
  const view = startView(person, cs);
  expect(view?.steps.map((step) => step.basic)).toEqual([
    "ai",
    "github",
    "content",
  ]);
  expect(startCount(person)).toBe("0/3");
  expect(nextBasic(person)).toBe("ai");
  expect(appsSetupLine(person, cs)?.text).toBe(cs.setupAi);
  expect(tourStep(person, freshTourProgress, null)).toBe("gear");
  expect(contentBlockedBy(person)).toBe("ai");
  // A Team Environment still has no Začínáme and no tour.
  const team = demoFacts("hosted-organization-team", { audience: undefined });
  expect(startView(team, cs)).toBeNull();
  expect(firstProgress(team)).toBeNull();
  expect(tourStep(team, freshTourProgress, null)).toBeNull();
});

// --- Integrace, Trezor and Nastavení → Nástroje ---------------------------

// Without its own vault, which is what a caller that has not read the vault
// core gets (`withheldInPublic`'s default), Trezor is withheld with them.
test("a public Environment withholds Integrace, Trezor without its vault and Nastavení → Nástroje, and shows Apps and Settings in their place", () => {
  for (const path of [
    "/integrations",
    "/integrations/connected",
    "/integrations/custom",
    "/integrations/custom/new",
    "/integrations/app/gmail",
    "/vault",
    "/vault/requests/abcdefghijklmnopqrstuvwx",
    // Trezor's old addresses in Settings (F54 as amended on 2026-10-18).
    "/settings/vault",
    "/settings/vault/requests/abcdefghijklmnopqrstuvwx",
    "/settings/tools",
  ])
    expect([path, withheldInPublic(pageRoute(path))]).toEqual([path, true]);
  for (const path of [
    "/",
    "/o/example",
    "/o/example/deals",
    "/files",
    "/marketplace",
    "/settings",
    "/settings/start",
    "/settings/general",
    "/settings/machine",
    "/settings/ssh",
  ])
    expect([path, withheldInPublic(pageRoute(path))]).toEqual([path, false]);
  // The pages of the Apps column it withholds leave the Apps home in their
  // place, Nástroje the default Settings section.
  for (const path of [
    "/integrations/connected",
    "/vault",
    "/vault/requests/abcdefghijklmnopqrstuvwx",
    "/settings/vault",
  ])
    expect([path, publicRoute(pageRoute(path))]).toEqual([
      path,
      { view: "home" },
    ]);
  expect(publicRoute(pageRoute("/settings/tools"))).toEqual({
    view: "settings",
    section: "general",
  });
  for (const path of ["/", "/settings/start", "/o/example/deals"])
    expect(publicRoute(pageRoute(path))).toEqual(pageRoute(path));
});

test("a public Environment withholds Nástroje's whole API: every sign-in and sign-out, Bitwarden, Executor, installations and updates", () => {
  for (const path of [
    "/api/tools",
    "/api/tools/status",
    "/api/tools/login/start",
    "/api/tools/login/poll",
    "/api/tools/login/code",
    "/api/tools/login/cancel",
    "/api/tools/logout",
    "/api/tools/composio/organizations",
    "/api/tools/composio/organization",
    "/api/tools/bitwarden/status",
    "/api/tools/bitwarden/setup",
    "/api/tools/executor/setup",
    "/api/tools/install",
    "/api/tools/upgrade",
    "/api/tools/update",
  ])
    expect([path, isToolsApiPath(path)]).toEqual([path, true]);
  for (const path of [
    "/api/toolsx",
    "/api/ai",
    "/api/entry",
    "/api/content",
    "/api/profile",
  ])
    expect([path, isToolsApiPath(path)]).toEqual([path, false]);
});

// --- The shell's notice ------------------------------------------------

const catalog = { kind: "catalog", organizations: [] } as const;

test("the shell document says a public Environment is public, and has no setup there", () => {
  const document = shellDocument({
    preset: "hosted-organization-personal",
    machine: bindings.organizationPublic,
    locale: "cs",
    catalog,
    setup: { ai: "missing", github: "missing" },
  });
  expect(document.audience).toBe("public");
  expect(document.setup).toBeUndefined();
  const team = shellDocument({
    preset: "hosted-organization-team",
    machine: bindings.teamPublic,
    locale: "en",
    catalog,
  });
  expect(team.audience).toBe("public");
  // Without the member the document is what it was.
  for (const machine of [bindings.organizationEntry, null])
    expect(
      Object.hasOwn(
        shellDocument({
          preset: machine === null ? "local" : "hosted-organization-personal",
          machine,
          locale: "cs",
          catalog,
        }),
        "audience",
      ),
    ).toBe(false);
  // The person's account merged in keeps it.
  const merged = mergeAccount(
    document,
    parseShellAccount(accountDocument()) as ShellAccount,
  );
  expect(merged.audience).toBe("public");
});

const shellWith = (
  audience: unknown,
  current: string | null = "local",
): Shell | null =>
  parseShell({
    schema: "lazurio.shell.v1",
    locale: "cs",
    current,
    operator: { initials: "AB", login: "example", avatar: null },
    environments: [
      {
        id: "local",
        label: null,
        kind: "workstation",
        organizations: [],
        assignee: null,
        apps: { apps: "/", chat: null, automate: null },
      },
    ],
    organizations: [],
    dashboard: "https://dashboard.example.invalid/home",
    account: "https://dashboard.example.invalid/settings/account",
    addOrganization: null,
    ...(audience === undefined ? {} : { audience }),
  });

test("the shell document takes the audience only as public, and only beside a current Environment", () => {
  expect(shellWith("public")?.audience).toBe("public");
  for (const none of [undefined, null]) {
    const shell = shellWith(none);
    expect(shell).not.toBeNull();
    expect(Object.hasOwn(shell as Shell, "audience")).toBe(false);
  }
  for (const refused of ["private", "Public", true, 1, { public: true }])
    expect(shellWith(refused)).toBeNull();
  // A page that belongs to no Environment says nothing of one.
  expect(shellWith("public", null)).toBeNull();
  expect(shellWith(undefined, null)).not.toBeNull();
});

test("the column head says it in Apps, Chat and Automate in two short sentences, with the terms in the page's language", () => {
  // F55's addendum of 2026-10-20: no nightly wipe, a visitor's own sign-in
  // signed out after use, no GitHub sign-in, and the terms. The words on a
  // try-01-shaped Environment: tests/public-try-notice.test.ts.
  const shell = shellWith("public") as Shell;
  for (const active of ["apps", "chat", "automate", "settings"])
    expect(
      columnHead(shell, shellCs, { space: null, active, settings: null })
        ?.notice,
    ).toEqual({
      text: "Toto Prostředí je veřejné a sdílené a kdykoli se může smazat nebo založit znovu. Když se přihlásíte ke svému účtu, po použití se odhlaste, protože ostatní vidí, co tu necháte; ke GitHubu se tu přihlásit nejde.",
      terms: {
        label: "Podmínky vyzkoušení Lazuria",
        href: "https://lazurio.ai/cs/vyzkouset/podminky/",
      },
    });
  expect(
    columnHead(shell, shellEn, { space: null, active: "chat", settings: null })
      ?.notice,
  ).toEqual({
    text: "This Environment is public and shared and can be wiped or deployed again at any time. If you sign in to your own account, sign out after use, because others see what you leave behind; GitHub sign-in is not available here.",
    terms: {
      label: "Terms for trying Lazurio",
      href: "https://lazurio.ai/try/terms/",
    },
  });
  // Without the member no notice, not even the member.
  const plain = columnHead(shellWith(undefined) as Shell, shellCs, {
    space: null,
    active: "apps",
    settings: null,
  });
  expect(plain).not.toBeNull();
  expect(Object.hasOwn(plain as object, "notice")).toBe(false);
});

// --- Over HTTP, behind the gateway ------------------------------------

// A hosted work Environment in Czech with one Organization, gh signed out,
// behind a fake gateway that admits the cookie `valid`; `audience` makes it
// a public Environment.
async function hosted(audience: boolean) {
  const parent = await realpath(
    await mkdtemp(join(tmpdir(), "public-environment-")),
  );
  const home = join(parent, "home");
  const bin = join(home, ".local", "bin");
  await mkdir(bin, { recursive: true, mode: 0o700 });
  await Bun.write(join(bin, "gh"), "#!/bin/sh\nexit 1\n");
  await Bun.$`chmod 755 ${join(bin, "gh")}`;
  await mkdir(join(home, "Documents"), { mode: 0o700 });
  const folder = join(parent, "Lazurio");
  await mkdir(folder, { mode: 0o700 });
  await mkdir(join(folder, "organizations"), { mode: 0o755 });
  await mkdir(join(folder, "personalspace"), { mode: 0o700 });
  await writeOrganization(folder, "example_GEN3", {
    slug: "example",
    state: "current",
    modules: [{ id: "deals" }],
  });
  const preset = "hosted-organization-personal";
  const machine = organizationWithEntry(
    freePort(),
    "workspace.example.lazurio.io",
    false,
    false,
    audience,
  );
  const entry = machine.entry;
  if (entry === undefined) throw new Error("The fixture has an entry");
  await initializeHandoverFolder(folder, {
    preset,
    machine,
    profile: presetProfile(preset, executionOs(process.platform), {
      locale: "cs",
    }),
  });
  const fetcher: AuthFetcher = async (_url, init) =>
    new Headers(init.headers).get("cookie") ===
    "__Secure-lazurio-workspace=valid"
      ? new Response("ok")
      : new Response("no", { status: 401 });
  // Every command the Launchpad asks its tools, so a test can prove that
  // nothing was signed in, out or installed.
  const commands: string[][] = [];
  const run: ToolRunner = async (command) => {
    commands.push([...command]);
    return {
      exitCode: 1,
      stdout: "",
      stderr: "You are not logged into any GitHub hosts.",
    };
  };
  const app = await startLaunchpad(
    folder,
    undefined,
    undefined,
    undefined,
    { fetcher },
    { path: bin, home, platform: process.platform, run },
    {},
    undefined,
    undefined,
    { home, platform: process.platform, folder },
  );
  const host = new URL(entry.externalOrigin).host;
  const base = `http://127.0.0.1:${entry.listenPort}`;
  const headers = { host, cookie: "__Secure-lazurio-workspace=valid" };
  return {
    folder,
    commands,
    get: (path: string) => fetch(`${base}${path}`, { headers }),
    post: (path: string, body: unknown = {}) =>
      fetch(`${base}${path}`, {
        method: "POST",
        headers: {
          ...headers,
          origin: entry.externalOrigin,
          "sec-fetch-site": "same-origin",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      }),
    async close() {
      await app.close();
      await rm(parent, { recursive: true, force: true });
    },
  };
}

const withheldPages = [
  "/integrations",
  "/integrations/connected",
  "/integrations/app/gmail",
  "/vault",
  "/vault/requests/abcdefghijklmnopqrstuvwx",
  "/settings/vault",
  "/settings/vault/requests/abcdefghijklmnopqrstuvwx",
  "/settings/tools",
];
const shownPages = ["/", "/settings/start", "/settings/general", "/o/example"];
// Nástroje's routes and their bodies as the page sends them: the reading,
// every sign-in the rows offer (gh, Codex, Claude, Composio, wacli, neon),
// its steps and the sign-out, Composio's organizations, the vault's
// Bitwarden, Executor's setup, an installation and an update.
const toolRoutes: readonly (readonly [string, string, unknown])[] = [
  ["GET", "/api/tools/status", undefined],
  ["POST", "/api/tools/status", { signIn: true }],
  ...["gh", "codex", "claude", "composio", "wacli", "neon"].map(
    (tool) => ["POST", "/api/tools/login/start", { tool }] as const,
  ),
  ["POST", "/api/tools/login/poll", { tool: "gh", session: "x" }],
  [
    "POST",
    "/api/tools/login/code",
    { tool: "claude", session: "x", code: "x" },
  ],
  ["POST", "/api/tools/login/cancel", { tool: "gh", session: "x" }],
  ["POST", "/api/tools/logout", { tool: "gh" }],
  ["POST", "/api/tools/composio/organizations", {}],
  ["POST", "/api/tools/composio/organization", { id: "x" }],
  ["POST", "/api/tools/bitwarden/status", {}],
  ["POST", "/api/tools/bitwarden/setup", {}],
  ["POST", "/api/tools/executor/setup", {}],
  ["POST", "/api/tools/install", { tool: "wacli" }],
  ["POST", "/api/tools/upgrade", { tool: "composio" }],
  ["POST", "/api/tools/update", { expectedRevision: 1, tools: ["gh"] }],
];

// This Environment's vault core answers no vault of its own (a handover not
// at the production place), so Trezor answers as absent with them.
posixTest(
  "hosted, public: Integrace, Trezor without a vault and Nástroje answer as absent, the shell says it is public, the entry names the audience",
  async () => {
    const app = await hosted(true);
    try {
      for (const path of withheldPages) {
        const answer = await app.get(path);
        // The page itself, which shows Apps or Settings in its place.
        expect([path, answer.status]).toEqual([path, 404]);
        expect(answer.headers.get("content-type")).toStartWith("text/html");
        await answer.body?.cancel();
      }
      for (const path of shownPages) {
        const answer = await app.get(path);
        expect([path, answer.status]).toEqual([path, 200]);
        await answer.body?.cancel();
      }
      for (const [method, path] of [
        ["GET", "/api/integrations"],
        ["GET", "/api/integrations?refresh=1"],
        ["POST", "/api/integrations/connect"],
        ["GET", "/api/vault"],
        ["POST", "/api/vault/membership"],
        ["GET", "/api/vault/requests"],
        ["GET", "/api/vault/requests/abcdefghijklmnopqrstuvwx"],
        ["POST", "/api/vault/connect"],
        ["POST", "/api/vault/disconnect"],
      ] as const) {
        const answer =
          method === "GET" ? await app.get(path) : await app.post(path);
        expect([method, path, answer.status, await answer.json()]).toEqual([
          method,
          path,
          404,
          { error: "not-found" },
        ]);
      }
      const shell = await (await app.get("/.lazurio/shell.json")).json();
      expect(shell.audience).toBe("public");
      expect(shell.setup).toBeUndefined();
      const entry = await (await app.get("/api/entry")).json();
      expect(entry.entry.audience).toBe("public");
      // Začínáme's module is the Organization's first.
      expect(demoModule(await readFolderCatalog(app.folder))).toEqual({
        name: "deals",
        href: "/o/example/deals",
      });
    } finally {
      await app.close();
    }
  },
  30_000,
);

posixTest(
  "hosted, public: Nástroje offers no sign-in: its page and every route of its rows answer as absent, and no tool is asked to sign in, out, install or set up",
  async () => {
    const app = await hosted(true);
    try {
      const page = await app.get("/settings/tools");
      expect(page.status).toBe(404);
      expect(page.headers.get("content-type")).toStartWith("text/html");
      await page.body?.cancel();
      for (const [method, path, body] of toolRoutes) {
        const answer =
          method === "GET" ? await app.get(path) : await app.post(path, body);
        expect([method, path, answer.status, await answer.json()]).toEqual([
          method,
          path,
          404,
          { error: "not-found" },
        ]);
      }
      // Nothing was signed in, out, installed or set up for a visitor.
      expect(
        app.commands.filter((command) =>
          command.some((part) => /^(login|logout|install|setup)$/.test(part)),
        ),
      ).toEqual([]);
    } finally {
      await app.close();
    }
  },
  30_000,
);

posixTest(
  "hosted, not public: the same Environment serves Integrace, Trezor and Nástroje as before and its shell says nothing of an audience",
  async () => {
    const app = await hosted(false);
    try {
      for (const path of [...withheldPages, ...shownPages]) {
        const answer = await app.get(path);
        expect([path, answer.status]).toEqual([path, 200]);
        await answer.body?.cancel();
      }
      const shell = await (await app.get("/.lazurio/shell.json")).json();
      expect(Object.hasOwn(shell, "audience")).toBe(false);
      // Nástroje answer as before: the reading of the tools.
      const tools = await app.post("/api/tools/status", {});
      expect(tools.status).toBe(200);
      const overview = await tools.json();
      expect(
        overview.tools.some((tool: { name: string }) => tool.name === "gh"),
      ).toBe(true);
      const entry = await (await app.get("/api/entry")).json();
      expect(Object.hasOwn(entry.entry, "audience")).toBe(false);
    } finally {
      await app.close();
    }
  },
  30_000,
);

test("a Team Environment's handover with the member is public too: the assignment does not decide it", () => {
  expect(bindings.teamPublic.owner).toMatchObject({
    kind: "organization",
    assignment: { kind: assignments.team.kind },
  });
  expect(isPublicEnvironment(bindings.teamPublic.entry ?? null)).toBe(true);
  expect(isPublicEnvironment(bindings.teamEntry.entry ?? null)).toBe(false);
});
