import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  drawnMarks,
  type PageGuideFacts,
  pageGuide,
  pageHelpOf,
  pageHelpStates,
  type VaultGuideFacts,
  vaultHelp,
  vaultTakesRequests,
} from "../src/launchpad/guides";
import { integrationsHelp } from "../src/launchpad/integrations-view";
import { messages } from "../src/launchpad/messages";
import {
  type PageRoute,
  routeFrame,
  settingsSections,
} from "../src/launchpad/routes";
import { escapeLeavesSettings } from "../src/launchpad/shell";
import { optionalRows } from "../src/launchpad/start-view";
import {
  type ToolGuideTargets,
  toolGroups,
  toolGuideTargets,
} from "../src/launchpad/tools-view";
import type { VaultPagePerson } from "../src/launchpad/vault-page-view";
import {
  type ShellEnvironmentKind,
  shellEnvironmentKinds,
} from "../src/shell/contract";
import {
  type GuideExplanation,
  pageGuideIn,
  parseGuides,
  principleIds,
  principleIn,
  principleMarks,
  shellMarks,
} from "../src/shell/guide-content";
import type { ToolOverview } from "../src/tools/overview";
import type { VaultPhase, VaultStatus } from "../src/vault/flow";
import { guideTextFindings } from "./fixtures/guide-text";

// The Launchpad as the host of the shell's guide (decision F56 and its
// addendum of 2026-10-18, plan DEV-6612 PRs 4 and 5): every page of the Apps
// column and every section of Settings has its "?" right after its heading,
// and exactly one. It plays a
// principle of the shell or an explanation the Launchpad hands over, chosen
// only from facts the page knows (the kind of Environment, whether Composio
// is allowed, the vault core's answer and the person's place in the vault),
// never from an Organization's name (Lazurio/LazurioPlatform#499); Trezor's
// opens the approved video in place where its words are true. Every mark a
// step points at is on the served page, drawn by a panel once its data is
// read, or one of the shell's own, and the sentences the "?" replaced are
// gone from the page and its words in the same change, so the explanation is
// never missing. How it looks, moves and takes the focus, and the marks the
// panels draw, are checked in a browser (root decision 0178).

type Element = Readonly<{
  tag: string;
  attributes: ReadonlyMap<string, string>;
  parent: Element | null;
}>;

const page = await readFile(
  join(import.meta.dir, "..", "src", "launchpad", "index.html"),
  "utf8",
);

/** Every element of the page in document order, each with its parent. */
async function parse(source: string): Promise<Element[]> {
  const elements: Element[] = [];
  const open: Element[] = [];
  await new HTMLRewriter()
    .on("*", {
      element(element) {
        const node: Element = {
          tag: element.tagName,
          attributes: new Map(element.attributes),
          parent: open.at(-1) ?? null,
        };
        elements.push(node);
        if (element.canHaveContent && !element.selfClosing) {
          open.push(node);
          element.onEndTag(() => {
            open.pop();
          });
        }
      },
    })
    .transform(new Response(source))
    .text();
  return elements;
}

const elements = await parse(page);
const byId = (id: string) => {
  const found = elements.filter((node) => node.attributes.get("id") === id);
  expect(found).toHaveLength(1);
  return found[0] as Element;
};
const classes = (node: Element) =>
  (node.attributes.get("class") ?? "").split(/\s+/).filter(Boolean);
const childrenOf = (node: Element) =>
  elements.filter((each) => each.parent === node);
/** Whether an element shows in a frame: no ancestor of it names frames
 * without this one (`data-view`, the page's stylesheet and shell.ts). */
function inFrame(node: Element, frame: string): boolean {
  for (let each: Element | null = node; each !== null; each = each.parent) {
    const views = each.attributes.get("data-view");
    if (views !== undefined && !views.split(" ").includes(frame)) return false;
  }
  return true;
}
const marks = new Set(
  elements.flatMap((node) => {
    const mark = node.attributes.get("data-guide");
    return mark === undefined ? [] : [mark];
  }),
);
const helps = elements.filter((node) => classes(node).includes("page-help"));

const kinds: readonly (ShellEnvironmentKind | null)[] = [
  null,
  ...shellEnvironmentKinds,
];
const locales = ["cs", "en"] as const;

/** Every page with its "?", in the states its explanations differ by. */
const pages: readonly (readonly [string, PageRoute])[] = [
  ["Apps", { view: "home" }],
  ["Apps of an Organization", { view: "organization", organization: "x" }],
  ["Soubory", { view: "files", path: [] }],
  ["Integrace", { view: "integrations", tab: "all" }],
  ["Integrace, Připojené", { view: "integrations", tab: "connected" }],
  ["Integrace, an app's card", { view: "integrations", tab: "all", app: "a" }],
  ["Integrace, Vlastní", { view: "integrations", tab: "custom" }],
  [
    "Integrace, a custom server",
    { view: "integrations", tab: "custom", form: { server: null } },
  ],
  ["Trezor", { view: "vault" }],
  ...settingsSections.map(
    (section) =>
      [`Nastavení ${section}`, { view: "settings", section }] as const,
  ),
];

// --- The vault's facts (#499) -------------------------------------------

const lazurioVaultwarden = {
  vault: "https://vaultwarden.example.lazurio.io",
  account: "vaultwarden-ndbrmzvjpwxtt3q7m2e4fihgsa@example.lazurio.io",
  name: "Example vault",
  team: false,
  origin: "own",
} as const;
const connected: VaultStatus = {
  kind: "vault-status",
  state: "connected",
  ...lazurioVaultwarden,
  organizationId: "0b9e2f3a-5c1d-4e8f-9a7b-1c2d3e4f5a6b",
  collectionId: "6a5f4e3d-2c1b-4a9f-8e7d-6c5b4a3f2e1d",
  organization: lazurioVaultwarden.name,
  items: 3,
};
const ownBitwarden: VaultStatus = {
  ...connected,
  vault: "https://vault.bitwarden.eu",
  region: "eu",
};
const unsupported = (
  reason: Extract<VaultStatus, { state: "unsupported" }>["reason"],
): VaultStatus => ({ kind: "vault-status", state: "unsupported", reason });
const read = (
  status: VaultStatus,
  environment: VaultGuideFacts["vault"] extends infer V
    ? V extends { environment: infer E }
      ? E
      : never
    : never,
  person: VaultPagePerson | null = null,
  setup: VaultPhase | null = null,
): VaultGuideFacts => ({ vault: { status, environment, setup }, person });
const known = (
  state: Extract<VaultPagePerson, { kind: "known" }>["state"],
): VaultPagePerson => ({ kind: "known", state, signIn: true });
const unknownPerson = (
  reason: Extract<VaultPagePerson, { kind: "unknown" }>["reason"],
): VaultPagePerson => ({ kind: "unknown", reason });

/** A vault that does not take an agent's request yet, or never: its session
 * locked, a setup still running, its creation not confirmed, no answer, a
 * 0197 pilot. */
const lockedVault: VaultStatus = {
  ...connected,
  organization: null,
  items: null,
  locked: true,
};
const creatingVault: VaultStatus = {
  kind: "vault-status",
  state: "creating",
  ...lazurioVaultwarden,
};
const unreachableVault: VaultStatus = {
  kind: "vault-status",
  state: "unreachable",
  ...lazurioVaultwarden,
  reason: "timeout",
};
const pilotVault: VaultStatus = {
  ...connected,
  name: null,
  origin: "pilot-0197",
};

/** Every combination of the vault's facts the page meets. */
const vaultFacts: readonly VaultGuideFacts[] = [
  { vault: null, person: null },
  read(connected, "work", known("member")),
  read(connected, "work", known("no-account")),
  read(connected, "work", unknownPerson("sign-in-not-required")),
  read(connected, "work", unknownPerson("no-username")),
  read(connected, "work"),
  read(connected, "team", unknownPerson("not-managed")),
  read(connected, "automated", unknownPerson("not-managed")),
  read(connected, "team", unknownPerson("not-managed"), "sign-in"),
  read(lockedVault, "work", known("no-account")),
  read(creatingVault, "team", unknownPerson("not-managed")),
  read(unreachableVault, "work", unknownPerson("not-managed")),
  read(pilotVault, "work", unknownPerson("no-vault")),
  read(ownBitwarden, "personal", known("not-invited")),
  read({ kind: "vault-status", state: "needs-connection" }, "personal"),
  read(unsupported("connection-unreadable"), "personal"),
  read(unsupported("no-vault"), null),
  read(unsupported("no-tailnet"), null),
  read(unsupported("workstation"), null),
  read(unsupported("handover-missing"), null),
];

/** What Nástroje's panel can report (`toolGuideTargets`): not read yet,
 * a sign-in to make and a switch, a connection made and no switch, a
 * switch and nothing to connect, nothing at all. */
const toolFacts: readonly (ToolGuideTargets | null)[] = [
  null,
  {
    connect: { tool: "composio", part: "action" },
    agents: { tool: "composio" },
  },
  { connect: { tool: "composio", part: "state" }, agents: null },
  { connect: null, agents: { tool: "wacli" } },
  { connect: null, agents: null },
];

/** What the page knows, in every kind and language: each fact in each of
 * its values, the others as on a page that read everything (each page reads
 * one of them). */
function* everyFacts(): Generator<PageGuideFacts> {
  for (const kind of kinds)
    for (const locale of locales) {
      const base: PageGuideFacts = {
        kind,
        locale,
        composio: null,
        vault: read(connected, "work", known("member")),
        start: "basics",
        tools: toolFacts[1] ?? null,
      };
      for (const composio of [null, false, true]) yield { ...base, composio };
      for (const vault of vaultFacts) yield { ...base, vault };
      for (const start of ["basics", "demo", "none", null] as const)
        yield { ...base, start };
      for (const tools of toolFacts) yield { ...base, tools };
      // An Osobní Prostředí with Buddy (decision F65): Začínáme explains his
      // step, and Nastavení → Buddy has its own guide.
      for (const start of ["basics", null] as const)
        yield { ...base, start, buddy: true };
    }
}

/** What a "?" plays: the shell's principle, or one the Launchpad hands
 * over. */
function played(
  id: string,
  guides: readonly GuideExplanation[],
  locale: "cs" | "en",
  kind: ShellEnvironmentKind | null,
): GuideExplanation | null {
  const principle = principleIn(id, locale, kind);
  if (principle !== null) return principle;
  const own = guides.find((guide) => guide.id === id);
  return own === undefined ? null : pageGuideIn(own, kind);
}

test('every page has one "?", right after its heading, and its frame shows no other', () => {
  expect(helps.map((node) => node.attributes.get("id"))).toEqual([
    "page-help",
    "catalog-help",
    "integrations-page-help",
  ]);
  for (const help of helps) {
    expect(help.tag).toBe("button");
    expect(help.attributes.get("type")).toBe("button");
    // Shown once the page knows what it plays (ui.ts), never by itself.
    expect(help.attributes.has("hidden")).toBe(true);
    // What it plays is set by the page, not served.
    expect(help.attributes.has("data-guide-help")).toBe(false);
  }
  // Right after the heading: the header's in the breadcrumb's item of the
  // page, Integrace's beside its title; the Apps home's is kept beside the
  // heading catalog-panel.ts draws in its head.
  const heading = byId("page-heading");
  const crumb = childrenOf(heading.parent as Element);
  expect(crumb.indexOf(byId("page-help"))).toBe(crumb.indexOf(heading) + 1);
  const titles = childrenOf(byId("integrations-page-help").parent as Element);
  expect(titles.map((node) => node.attributes.get("id") ?? node.tag)).toEqual([
    "h1",
    "integrations-page-help",
  ]);
  expect(titles[0]?.attributes.has("data-page-heading")).toBe(true);
  expect(byId("catalog-help").parent).toBe(byId("catalog-head-name"));
  for (const [name, route] of pages) {
    const id = pageHelpOf(route);
    const frame = routeFrame(route);
    const shown = helps.filter((help) => inFrame(help, frame));
    expect({
      name,
      shown: shown.map((help) => help.attributes.get("id")),
    }).toEqual({ name, shown: [id ?? ""] });
  }
  // A module's overview, the Marketplace and one agent's request have no
  // explaining sentence to take over, and no "?".
  for (const route of [
    { view: "module", organization: "x", module: "y" },
    { view: "marketplace" },
  ] as const)
    expect(pageHelpOf(route)).toBeNull();
  expect(
    helps.filter((help) => inFrame(help, routeFrame({ view: "marketplace" }))),
  ).toEqual([]);
  for (const facts of everyFacts())
    expect(
      pageGuide({ view: "vault", request: "r" }, facts, messages(facts.locale)),
    ).toEqual({ help: null, video: null, guides: [] });
  // The shell's element the guide draws in, outside every view.
  const buddy = elements.filter((node) => node.tag === "lazurio-buddy");
  expect(buddy).toHaveLength(1);
  for (let node = buddy[0]?.parent ?? null; node !== null; node = node.parent)
    expect(node.attributes.has("data-view")).toBe(false);
});

test("what each page's '?' plays is known in every kind, language and fact, and what the prototype has", () => {
  for (const facts of everyFacts()) {
    const copy = messages(facts.locale, facts.kind);
    for (const [name, route] of pages) {
      const guide = pageGuide(route, facts, copy);
      // What the Launchpad hands over is exactly what the shell keeps.
      const handed = parseGuides(guide.guides);
      expect(handed?.length).toBe(guide.guides.length);
      // A "?" plays one thing: an explanation or a video, or waits.
      expect(guide.help !== null && guide.video !== null).toBe(false);
      if (guide.video !== null) {
        expect({ name, video: guide.video }).toEqual({
          name: "Trezor",
          video: "vault-overview",
        });
        continue;
      }
      if (guide.help === null) {
        // Only Trezor waits, while its vault's state is not read;
        // Nástroje, while its tools are not read; Začínáme, where it has
        // no basics to explain (a public demo, a Team or Automated
        // Environment) or the profile is not read; and Nastavení → Buddy,
        // where the Environment has no Buddy (decision F65).
        const waiting: Readonly<Record<string, boolean>> = {
          Trezor: facts.vault.vault === null,
          "Nastavení tools": facts.tools === null,
          "Nastavení start": facts.start !== "basics",
          "Nastavení buddy": facts.buddy !== true,
        };
        expect({ name, waits: waiting[name] ?? false }).toEqual({
          name,
          waits: true,
        });
        continue;
      }
      expect({
        name,
        help: guide.help,
        known:
          played(guide.help, handed ?? [], facts.locale, facts.kind) !== null,
      }).toEqual({ name, help: guide.help, known: true });
    }
  }
  const facts = (fields: Partial<PageGuideFacts> = {}): PageGuideFacts => ({
    kind: "work",
    locale: "cs",
    composio: null,
    vault: { vault: null, person: null },
    start: "basics",
    tools: toolFacts[1] ?? null,
    ...fields,
  });
  const help = (route: PageRoute, fields: Partial<PageGuideFacts> = {}) =>
    pageGuide(route, facts(fields), messages("cs")).help;
  // Apps: the Environment, the agents' computer, as the prototype has it.
  expect(help({ view: "home" })).toBe("environment");
  expect(help({ view: "organization", organization: "a" })).toBe("environment");
  // Soubory: the principle, in a Team Environment the Launchpad's own.
  expect(help({ view: "files", path: [] })).toBe("files");
  expect(help({ view: "files", path: [] }, { kind: "team" })).toBe(
    "files-team",
  );
  // Integrace: the principle; where Composio is allowed its model; on
  // Vlastní and its form the custom servers.
  const all = { view: "integrations", tab: "all" } as const;
  expect(help(all)).toBe("integrations");
  expect(help(all, { composio: false })).toBe("integrations");
  expect(help(all, { composio: true })).toBe("integrations-composio");
  expect(help(all, { composio: true, kind: "team" })).toBe(
    "integrations-composio-team",
  );
  for (const route of [
    { view: "integrations", tab: "custom" },
    { view: "integrations", tab: "custom", form: { server: "s" } },
  ] as const) {
    expect(help(route)).toBe("integrations-custom");
    expect(help(route, { composio: true })).toBe("integrations-custom");
  }
  // Settings: each section its own, a Team Environment's where it differs.
  const section = (name: (typeof settingsSections)[number]) =>
    ({ view: "settings", section: name }) as const;
  expect(
    settingsSections.map((name) => help(section(name), { kind: "work" })),
  ).toEqual([
    "settings-start",
    "settings-general",
    "settings-communication",
    "settings-machine",
    "settings-tools",
    "settings-ssh",
    "settings-recovery",
    // Nastavení → Buddy only with Buddy (decision F65).
    null,
  ]);
  expect(
    settingsSections.map((name) => help(section(name), { kind: "team" })),
  ).toEqual([
    "settings-start",
    "settings-general",
    "settings-communication-team",
    "settings-machine",
    "settings-tools-team",
    "settings-ssh-team",
    "settings-recovery",
    null,
  ]);
  expect(help(section("buddy"), { kind: "personal", buddy: true })).toBe(
    "settings-buddy",
  );
  expect(help(section("start"), { kind: "personal", buddy: true })).toBe(
    "settings-start-buddy",
  );
  // Začínáme only where it has the basics.
  for (const start of ["demo", "none", null] as const)
    expect(help(section("start"), { start })).toBeNull();
  // Your computer is not the agents' virtual computer.
  const steps = (kind: ShellEnvironmentKind) =>
    pageGuide(
      section("machine"),
      facts({ kind }),
      messages("cs", kind),
    ).guides[0]?.steps.map((step) => step.text);
  expect(steps("workstation")).toEqual([
    "Váš počítač, na kterém pracují i agenti",
    "Komu patří a kdo na něm pracuje",
    "Technické údaje pro podporu",
  ]);
  expect(steps("team")?.[0]).toBe(
    "Toto Týmové Prostředí je virtuální počítač vašich agentů",
  );
});

test("every mark a step points at is on the served page, drawn by a panel once read, or the shell's own", () => {
  const known = new Set<string>([...marks, ...drawnMarks, ...shellMarks]);
  for (const facts of everyFacts()) {
    const copy = messages(facts.locale, facts.kind);
    for (const [name, route] of pages) {
      const guide = pageGuide(route, facts, copy);
      const handed = parseGuides(guide.guides) ?? [];
      const explanations = [
        ...(guide.help === null
          ? []
          : [played(guide.help, handed, facts.locale, facts.kind)]),
        ...handed,
      ];
      for (const explanation of explanations)
        for (const step of explanation?.steps ?? [])
          expect({
            name,
            at: step.at,
            known: known.has(step.at ?? ""),
          }).toEqual({ name, at: step.at, known: true });
    }
  }
  // Every mark the principles look for on a host's page is the Launchpad's
  // (F56's honest limits: they come with the pages' "?").
  for (const mark of principleMarks)
    expect({
      mark,
      here: marks.has(mark) || (drawnMarks as readonly string[]).includes(mark),
    }).toEqual({ mark, here: true });
  // On the elements they name.
  for (const [id, mark] of [
    ["files-open", "nav-files"],
    ["integrations-open", "nav-integrations"],
    ["vault-open", "nav-vault"],
    ["files-body", "files-list"],
    ["integrations-composio", "composio-apps"],
    ["vault-page-actions", "vault-open"],
    ["vault-connect-picture", "vault-row"],
  ] as const)
    expect([id, byId(id).attributes.get("data-guide")]).toEqual([id, mark]);
  expect(
    elements
      .find((node) => classes(node).includes("browser-toggle"))
      ?.attributes.get("data-guide"),
  ).toBe("browser");
  expect(byId("vault-page-group")).toBe(
    elements.find((node) => node.attributes.get("data-guide") === "vault-row")
      ?.parent as Element,
  );
  // The panels' marks are none of the page's.
  for (const mark of drawnMarks) expect(marks.has(mark)).toBe(false);
});

test("the Launchpad's explanations keep the guide's rules in both languages and every kind, at the same marks", () => {
  const found: string[] = [];
  const atMarks = new Map<string, string>();
  const ids = new Set<string>();
  for (const facts of everyFacts()) {
    const copy = messages(facts.locale, facts.kind);
    for (const [, route] of pages)
      for (const own of parseGuides(pageGuide(route, facts, copy).guides) ??
        []) {
        const filled = pageGuideIn(own, facts.kind);
        found.push(
          ...guideTextFindings(filled).map(
            (line) => `${facts.locale}/${facts.kind}: ${line}`,
          ),
        );
        const where = JSON.stringify(
          filled.steps.map((step) => [step.at, step.sub === null]),
        );
        // Czech and English at the same marks, for the same facts.
        const key = JSON.stringify([own.id, { ...facts, locale: null }]);
        expect(atMarks.get(key) ?? where).toBe(where);
        atMarks.set(key, where);
        ids.add(own.id);
        expect(own.id).not.toBeOneOf([...principleIds]);
      }
  }
  expect(found).toEqual([]);
  expect([...ids].sort()).toEqual([
    "files-team",
    "integrations-composio",
    "integrations-composio-team",
    "integrations-custom",
    "settings-buddy",
    "settings-communication",
    "settings-communication-team",
    "settings-general",
    "settings-machine",
    "settings-recovery",
    "settings-ssh",
    "settings-ssh-team",
    "settings-start",
    "settings-start-buddy",
    "settings-tools",
    "settings-tools-team",
    "vault-agents",
  ]);
  expect(messages("en").pageHelp).toBe("How does it work?");
  expect(messages("cs").pageHelp).toBe("Jak to funguje?");
});

test("Integrace's 'Jak to funguje' is the guide's card's now: each of its explanations links the documentation", () => {
  for (const locale of locales) {
    const copy = messages(locale, "work");
    for (const composio of [null, false, true])
      for (const route of [
        { view: "integrations", tab: "all" },
        { view: "integrations", tab: "custom" },
      ] as const) {
        const guide = pageGuide(
          route,
          {
            kind: "work",
            locale,
            composio,
            vault: { vault: null, person: null },
            start: "basics",
            tools: null,
          },
          copy,
        );
        const handed = parseGuides(guide.guides) ?? [];
        const explanation = played(guide.help ?? "", handed, locale, "work");
        const docs = explanation?.docs ?? "";
        // The principle's in the shell, the Launchpad's own with the page's
        // link: the same documentation page in the page's language.
        expect(docs).toStartWith(
          `https://documentation.lazurio.ai/${locale}/environment-app-connections/`,
        );
        if (guide.help !== "integrations")
          expect(docs).toBe(integrationsHelp(locale));
      }
  }
});

test("Integrace's '?' where Composio is allowed: the Team's Composio account in a Team Environment, the person's own elsewhere (decision F42, note of 2026-10-19)", () => {
  const route = { view: "integrations", tab: "all" } as const;
  const explanation = (
    kind: ShellEnvironmentKind | null,
    locale: "cs" | "en",
  ) => {
    const guide = pageGuide(
      route,
      {
        kind,
        locale,
        composio: true,
        vault: { vault: null, person: null },
        start: "basics",
        tools: null,
      },
      messages(locale, kind),
    );
    const own = guide.guides.find((each) => each.id === guide.help);
    return {
      help: guide.help,
      steps: own?.steps.map((step) => [step.text, step.sub ?? null]),
    };
  };
  expect(explanation("team", "cs")).toEqual({
    help: "integrations-composio-team",
    steps: [
      ["Composio přihlásíte týmovým účtem", "Ne osobním účtem nikoho z Teamu"],
      [
        "Pro každou Organizaci v něm jedna organizace",
        "Nikoho dalšího do ní nezvěte",
      ],
      // The Team's account has no Personal Environment.
      ["Co v ní připojíte, používají agenti v Prostředí Organizace", null],
      [
        "Jiné účty v dalším Prostředí potřebují další účet Composia",
        "Tři Prostředí s jinými účty, tři účty Composia",
      ],
    ],
  });
  expect(explanation("team", "en").steps?.[0]).toEqual([
    "Sign in to Composio with the Team's account",
    "Not anyone's personal account",
  ]);
  // Every other kind keeps the person's own account.
  for (const kind of [
    "work",
    "automated",
    "personal",
    "workstation",
    null,
  ] as const)
    expect(explanation(kind, "cs")).toEqual({
      help: "integrations-composio",
      steps: [
        [
          "Composio přihlásíte svým vlastním účtem",
          "Organizace společné Composio nemá",
        ],
        [
          "Pro každou Organizaci v něm jedna organizace",
          "Nikoho dalšího do ní nezvěte",
        ],
        [
          "Co v ní připojíte, používají agenti v Prostředí Organizace",
          "Osobní Prostředí používá výchozí organizaci účtu",
        ],
        [
          "Jiné účty v dalším Prostředí potřebují další účet Composia",
          "Tři Prostředí s jinými účty, tři účty Composia",
        ],
      ],
    });
});

test("Trezor's '?' is chosen from the kind, the vault core's answer and the person's place in the vault (#499)", () => {
  // A Personal Environment: its own Bitwarden, the agents' own account in
  // it, once the vault's state is read; nothing before.
  for (const facts of vaultFacts)
    expect(vaultHelp("personal", facts)).toBe(
      facts.vault === null ? null : "vault",
    );
  expect(
    principleIn("vault", "cs", "personal")?.steps.map((step) => step.text),
  ).toEqual([
    "Agenti mají v Bitwardenu vlastní účet",
    "Sdílíte do něj hesla ze svého Bitwardenu",
    "Agenti je najdou a použijí bez ptaní",
    "Sdílení můžete kdykoli vzít zpět",
  ]);
  const table: readonly (readonly [
    string,
    ShellEnvironmentKind | null,
    VaultGuideFacts,
    ReturnType<typeof vaultHelp>,
  ])[] = [
    ["not read yet", "work", { vault: null, person: null }, null],
    ["a member", "work", read(connected, "work", known("member")), "video"],
    // Only a member shares into the vault: no account or no master password
    // yet, and removed in the vault, are no members (Pablo's review of
    // #502).
    [
      "no account yet",
      "work",
      read(connected, "work", known("no-account")),
      "vault-agents",
    ],
    [
      "no master password yet",
      "work",
      read(connected, "work", known("awaiting-password")),
      "vault-agents",
    ],
    [
      "removed",
      "work",
      read(connected, "work", known("revoked")),
      "vault-agents",
    ],
    ...(["not-invited", "invitation-pending", "accepted"] as const).map(
      (state) =>
        [
          `a ${state} person of a Work Environment's vault`,
          "work",
          read(connected, "work", known(state)),
          "vault-agents",
        ] as const,
    ),
    [
      "not read yet in a Personal Environment",
      "personal",
      { vault: null, person: null },
      null,
    ],
    [
      "a vault that takes no Lazurio sign-in yet",
      "work",
      read(connected, "work", unknownPerson("sign-in-not-required")),
      "vault-agents",
    ],
    [
      "a sign-in without a username",
      "work",
      read(connected, "work", unknownPerson("no-username")),
      "vault-agents",
    ],
    [
      "the person not asked yet",
      "work",
      read(connected, "work"),
      "vault-agents",
    ],
    [
      "a Team Environment (try-01)",
      "team",
      read(connected, "team", unknownPerson("not-managed")),
      "vault-agents",
    ],
    [
      "an Automated Environment",
      "automated",
      read(connected, "automated", unknownPerson("not-managed")),
      "vault-agents",
    ],
    ["no vault yet", "work", read(unsupported("no-vault"), null), "video"],
    ["none by design", "team", read(unsupported("no-tailnet"), null), "video"],
    [
      "this computer",
      "workstation",
      read(unsupported("workstation"), null),
      "video",
    ],
    [
      "a personal vault the kind is not known of",
      null,
      read(ownBitwarden, "personal", known("member")),
      "vault",
    ],
    [
      "a personal vault waiting for its Bitwarden",
      null,
      read({ kind: "vault-status", state: "needs-connection" }, "personal"),
      "vault",
    ],
  ];
  for (const [name, kind, facts, expected] of table)
    expect({ name, help: vaultHelp(kind, facts) }).toEqual({
      name,
      help: expected,
    });
  // Where nobody who enters is added, the words promise no Bitwarden of
  // one's own and ask nobody to store a password; they say that everyone in
  // this Environment has its passwords. A vault that takes an agent's
  // request adds how a value the agent asks for gets into it (the test
  // below), which no account in the vault is needed for.
  for (const locale of locales) {
    const guide = pageGuide(
      { view: "vault" },
      {
        kind: "team",
        locale,
        composio: null,
        vault: read(connected, "team", unknownPerson("not-managed")),
        start: "none",
        tools: null,
      },
      messages(locale, "team"),
    );
    expect(guide.help).toBe("vault-agents");
    const words = (parseGuides(guide.guides)?.[0]?.steps ?? []).map(
      (step) => step.text,
    );
    const rule = words.slice(0, 3);
    expect(rule).toEqual(
      locale === "cs"
        ? [
            "Toto Týmové Prostředí má vlastní trezor",
            "Agenti z něj berou hesla bez ptaní",
            "Hesla vidí každý v tomto Týmovém Prostředí",
          ]
        : [
            "This Team Environment has its own vault",
            "Agents take passwords from it without asking",
            "Everyone in this Team Environment sees its passwords",
          ],
    );
    for (const text of rule)
      expect(text).not.toMatch(/Bitwarden|svého|your|sdíl|share|ulož|store/i);
    expect(words.slice(3)).toEqual([messages(locale).guideVaultRequest]);
  }
  // A video where its words are true, and the guide nowhere else.
  const video = pageGuide(
    { view: "vault" },
    {
      kind: "work",
      locale: "cs",
      composio: null,
      vault: read(connected, "work", known("member")),
      start: "basics",
      tools: null,
    },
    messages("cs", "work"),
  );
  expect(video).toEqual({ help: null, video: "vault-overview", guides: [] });
});

// The sentences the "?" took over (the Lazurio prototype's REMOVED list as
// the Launchpad wrote them, and its own sentences that said the same): on
// Soubory the introduction, the Team note and the empty folder's
// explanation (PR 4); on Integrace the line under the title and the corner's
// "Jak to funguje"; on Trezor the rule and the section of an Environment
// without a vault, whose video its "?" opens.
const removed = [
  "S čím pracují vaši agenti.",
  "Celý Team může tyto soubory číst a měnit.",
  "Nahrajte podklady pro agenty.",
  "Agenti sem ukládají hotové soubory",
  "celý Team vidí a mění stejnou složku",
  "Agents save finished files here",
  "the whole Team sees and changes the same folder",
  "What your agents work with",
  "Připojené aplikace, které používají všichni agenti a boti",
  "Connected apps every agent and bot of",
  "Kdo má přístup do Prostředí, má všechna jeho hesla.",
  "Whoever has access to the Environment has all of its passwords.",
  "V Organizaci má každé Prostředí vlastní trezor.",
  "In an Organization, every Environment has its own vault.",
  // Settings (the prototype's list for Nastavení Prostředí as the Launchpad
  // wrote it, and its own sentences that said the same).
  "Zpřístupní vaše repozitáře a moduly.",
  "Opens your repositories and modules.",
  "Jazyk této stránky a agentů.",
  "The language of this page and of the agents.",
  "Jak agenti vysvětlují svou práci",
  "How agents explain their work",
  "Zda agenti pracují přímo, nebo delegují",
  "Whether agents work directly, or delegate",
  "Nastavte, jak mají agenti",
  "Set how agents communicate",
  "jeden společný tón pro všechny",
  "uses the same voice",
  "Text si můžete upravit.",
  "Edit the text to suit you.",
  "Zjištěno v",
  "Checked at",
  "Bez nich tu nic nefunguje.",
  "Nothing works here without them.",
  "Hodí se skoro každému.",
  "Useful to almost everyone.",
  "Zapněte jen to, co používáte.",
  "Turn on only what you use.",
  "Vlastní MCP servery přidáte v Apps",
  "You add custom MCP servers in Apps",
  "přes SSH z terminálu na svém počítači",
  "over SSH from a terminal on your own computer",
  "zařízení přidané tady se přihlašuje do účtu Teamu",
  "a device added here signs in to the Team's account",
  "Otevře si tuto stránku ve svém panelu prohlížeče",
  "It opens this page in its browser panel",
  "Váš agent je zapíše do vašeho počítače.",
  "Your agent writes these on your computer.",
  "Agent opraví Lazurio směrem dopředu",
  "The agent repairs forward",
  "Opravný agent ho založí",
  "The repair agent files it",
  "Tato stránka issue jen připraví",
  "This page only prepares the issue",
];

test("the sentences the '?' replaced are gone from the page and its words", () => {
  const catalog = locales.flatMap((locale) =>
    kinds.flatMap((kind) => Object.values(messages(locale, kind))),
  );
  for (const sentence of removed) {
    expect({ sentence, page: page.includes(sentence) }).toEqual({
      sentence,
      page: false,
    });
    expect({
      sentence,
      words: catalog.some((text) => text.includes(sentence)),
    }).toEqual({ sentence, words: false });
  }
  for (const id of [
    "files-shared",
    "integrations-help",
    "vault-page-rule",
    "vault-explainer",
    "locale-hint",
    "detail-hint",
    "coordination-hint",
    "voice-shared",
    "voice-hint",
    "tools-shared",
    "tools-checked",
    "ssh-shared",
  ])
    expect({
      id,
      here: elements.some((n) => n.attributes.get("id") === id),
    }).toEqual({ id, here: false });
  for (const key of [
    "filesIntro",
    "filesShared",
    "integrationsSubtitle",
    "vaultPageRule",
    "vaultExplainerText",
    "startGithubMissing",
    "localeHint",
    "detailHint",
    "coordinationHint",
    "voiceIntro",
    "voiceShared",
    "voiceHint",
    "toolsChecked",
    "toolsTierRequiredNote",
    "toolsTierRecommendedNote",
    "toolsTierOptionalNote",
    "toolsMcpText",
    "sshIntro",
    "sshShared",
    "sshPromptNote",
    "sshComputerNote",
  ])
    for (const locale of locales)
      expect({ key, here: Object.hasOwn(messages(locale), key) }).toEqual({
        key,
        here: false,
      });
  expect(messages("cs").filesEmptyRoot).toBe("Zatím žádné soubory.");
  expect(messages("en").filesEmptyRoot).toBe("No files yet.");
});

// No page has a sentence under its title (Matěj 2026-10-24, the design
// system's "Vysvětlení na vyžádání", design-system-lazurio#110,
// Lazurio/LazurioPlatform#631; F56's addendum (6) of 2026-10-24). Settings
// and Integrace lost theirs with the "?"; the last two went with it:
// Začínáme of a public Environment, whose group "Vyzkoušejte" says what to
// try, and Trezor's line on how a value gets into the vault, with its
// "Otevřít Chat", which Matěj moved into Trezor's "?" the same day (the test
// below). What stays under a title is a state: Začínáme's count, an empty
// state, an error, a page that is not available here.
test("no page has a sentence under its title: Začínáme of a public Environment's is gone, and Trezor's is its '?''s now", () => {
  const catalog = locales.flatMap((locale) =>
    kinds.flatMap((kind) => Object.entries(messages(locale, kind))),
  );
  /** The words that hold `sentence`, in any language and kind. */
  const keysWith = (sentence: string) =>
    [
      ...new Set(
        catalog.flatMap(([key, text]) =>
          text.includes(sentence) ? [key] : [],
        ),
      ),
    ].sort();
  for (const sentence of [
    "Vyzkoušejte si Lazurio v tomto ukázkovém Prostředí.",
    "Try Lazurio in this demo Environment.",
  ])
    expect({
      sentence,
      page: page.includes(sentence),
      keys: keysWith(sentence),
    }).toEqual({ sentence, page: false, keys: [] });
  for (const [sentence, key] of [
    ["Potřebuje agent heslo nebo klíč?", "guideVaultRequest"],
    ["Řekněte mu to v Chatu.", "guideVaultRequestSub"],
    ["Does an agent need a password or a key?", "guideVaultRequest"],
    ["Tell it in Chat.", "guideVaultRequestSub"],
  ] as const)
    expect({
      sentence,
      page: page.includes(sentence),
      keys: keysWith(sentence),
    }).toEqual({ sentence, page: false, keys: [key] });
  expect(
    elements.some((n) => n.attributes.get("id") === "vault-page-guide"),
  ).toBe(false);
  for (const key of ["startDemoIntro", "vaultPageGuide", "vaultPageGuideChat"])
    for (const locale of locales)
      expect({ key, here: Object.hasOwn(messages(locale), key) }).toEqual({
        key,
        here: false,
      });
  // The states that stay under a title.
  expect(messages("cs").startIntro).toBe("Hotovo {done} ze {total} kroků.");
  expect(messages("en").startNotHere).toBe("There is nothing to set up here.");
});

// Trezor's line moved into its "?" (Matěj's decision of 2026-10-24; F56's
// addendum (6)): one more step of `vault-agents`, the sentence Matěj
// approved, exactly where the vault takes an agent's request
// (`vaultTakesRequests`: the line's own condition) and nowhere else, so the
// "?" never describes what is not there. A member's approved video and a
// Personal Environment's principle `vault` carry no step of the Launchpad.
test("Trezor's '?' says how a value the agent asks for gets into the vault, exactly where the vault takes a request", () => {
  // The approved sentence, unchanged: its first sentence is the step, the
  // rest the quieter line without the final full stop.
  expect(
    `${messages("cs").guideVaultRequest} ${messages("cs").guideVaultRequestSub}.`,
  ).toBe(
    "Potřebuje agent heslo nebo klíč? Řekněte mu to v Chatu. O hodnotu si řekne tady, vy ji vyplníte a uloží se rovnou do trezoru.",
  );
  expect(
    `${messages("en").guideVaultRequest} ${messages("en").guideVaultRequestSub}.`,
  ).toBe(
    "Does an agent need a password or a key? Tell it in Chat. It asks for the value here, you fill it in, and it goes straight into the vault.",
  );
  // Where the vault takes a request: connected, unlocked, no setup running,
  // never a 0197 pilot, whose collection takes none.
  const takes: readonly (readonly [
    string,
    VaultGuideFacts["vault"],
    boolean,
  ])[] = [
    ["not read yet", null, false],
    ["connected", read(connected, "work").vault, true],
    ["a Team's, connected", read(connected, "team").vault, true],
    [
      "a personal Bitwarden, connected",
      read(ownBitwarden, "personal").vault,
      true,
    ],
    ...(["install", "account", "vault", "sign-in"] as const).map(
      (phase) =>
        [
          `connected, its setup at ${phase}`,
          read(connected, "work", null, phase).vault,
          false,
        ] as const,
    ),
    ["locked", read(lockedVault, "work").vault, false],
    ["its creation not confirmed", read(creatingVault, "team").vault, false],
    ["not answering", read(unreachableVault, "work").vault, false],
    ["a 0197 pilot", read(pilotVault, "work").vault, false],
    [
      "a personal Bitwarden not connected",
      read({ kind: "vault-status", state: "needs-connection" }, "personal")
        .vault,
      false,
    ],
    ["no vault yet", read(unsupported("no-vault"), null).vault, false],
    ["this computer", read(unsupported("workstation"), null).vault, false],
  ];
  for (const [name, vault, expected] of takes)
    expect({ name, takes: vaultTakesRequests(vault) }).toEqual({
      name,
      takes: expected,
    });

  // The step in every kind, language and fact: exactly in `vault-agents`
  // with a vault that takes a request, last, at the switch's Chat.
  const trezor = { view: "vault" } as const;
  const shown = (
    kind: ShellEnvironmentKind | null,
    locale: "cs" | "en",
    vault: VaultGuideFacts,
  ) => {
    const copy = messages(locale, kind);
    const guide = pageGuide(
      trezor,
      { kind, locale, composio: null, vault, start: "basics", tools: null },
      copy,
    );
    const handed = parseGuides(guide.guides) ?? [];
    const steps =
      guide.help === null
        ? []
        : (played(guide.help, handed, locale, kind)?.steps ?? []);
    return {
      guide,
      steps,
      request: steps.filter((step) => step.text === copy.guideVaultRequest),
      copy,
    };
  };
  for (const kind of kinds)
    for (const locale of locales)
      for (const vault of vaultFacts) {
        const { guide, steps, request, copy } = shown(kind, locale, vault);
        const expected =
          guide.help === "vault-agents" && vaultTakesRequests(vault.vault);
        expect({
          kind,
          locale,
          vault: JSON.stringify(vault),
          help: guide.help,
          request: request.length,
        }).toEqual({
          kind,
          locale,
          vault: JSON.stringify(vault),
          help: guide.help,
          request: expected ? 1 : 0,
        });
        if (expected)
          expect(steps.at(-1)).toEqual({
            text: copy.guideVaultRequest,
            sub: copy.guideVaultRequestSub,
            at: "tab-chat",
          });
      }

  // Where it shows and where not, by name.
  const named: readonly (readonly [
    string,
    ShellEnvironmentKind,
    VaultGuideFacts,
    ReturnType<typeof vaultHelp> | "video",
    boolean,
  ])[] = [
    [
      "a Work Environment, no account yet",
      "work",
      read(connected, "work", known("no-account")),
      "vault-agents",
      true,
    ],
    [
      "a Work Environment, its vault takes no Lazurio sign-in yet",
      "work",
      read(connected, "work", unknownPerson("sign-in-not-required")),
      "vault-agents",
      true,
    ],
    [
      "a Work Environment, the person not asked yet",
      "work",
      read(connected, "work"),
      "vault-agents",
      true,
    ],
    [
      "a Team Environment, as a public one's vault is",
      "team",
      read(connected, "team", unknownPerson("not-managed")),
      "vault-agents",
      true,
    ],
    [
      "an Automated Environment",
      "automated",
      read(connected, "automated", unknownPerson("not-managed")),
      "vault-agents",
      true,
    ],
    [
      "a Team Environment while its setup signs in",
      "team",
      read(connected, "team", unknownPerson("not-managed"), "sign-in"),
      "vault-agents",
      false,
    ],
    [
      "a locked vault",
      "work",
      read(lockedVault, "work", known("no-account")),
      "vault-agents",
      false,
    ],
    [
      "a vault being created",
      "team",
      read(creatingVault, "team", unknownPerson("not-managed")),
      "vault-agents",
      false,
    ],
    [
      "a 0197 pilot",
      "work",
      read(pilotVault, "work", unknownPerson("no-vault")),
      "vault-agents",
      false,
    ],
    [
      "a Work Environment's member: the approved video",
      "work",
      read(connected, "work", known("member")),
      "video",
      false,
    ],
    [
      "a Personal Environment's connected Bitwarden: the principle",
      "personal",
      read(ownBitwarden, "personal", known("member")),
      "vault",
      false,
    ],
    [
      "a Personal Environment waiting for its Bitwarden: the principle",
      "personal",
      read({ kind: "vault-status", state: "needs-connection" }, "personal"),
      "vault",
      false,
    ],
    [
      "no vault yet: the video",
      "work",
      read(unsupported("no-vault"), null),
      "video",
      false,
    ],
  ];
  for (const [name, kind, vault, help, step] of named)
    for (const locale of locales) {
      const { guide, request } = shown(kind, locale, vault);
      expect({
        name,
        locale,
        help: guide.video === null ? guide.help : "video",
        step: request.length === 1,
      }).toEqual({ name, locale, help, step });
    }
});

test('the "?" of Trezor waits until the vault\'s state is read, in a Personal Environment too, and then shows what it plays', () => {
  const trezor = { view: "vault" } as const;
  const facts = (vault: VaultGuideFacts): PageGuideFacts => ({
    kind: "personal",
    locale: "cs",
    composio: null,
    vault,
    start: "basics",
    tools: null,
  });
  const states = (vault: VaultGuideFacts, off = false) =>
    pageHelpStates(
      trezor,
      pageGuide(trezor, facts(vault), messages("cs", "personal")),
      off,
    );
  // The page as it loads: every "?" hidden, nothing to play.
  const hidden = { hidden: true, plays: null, controls: null };
  expect(states({ vault: null, person: null })).toEqual({
    "page-help": hidden,
    "catalog-help": hidden,
    "integrations-page-help": hidden,
  });
  // `GET /api/vault` answered: the header's "?" plays the principle.
  const waiting = read(
    { kind: "vault-status", state: "needs-connection" },
    "personal",
  );
  expect(states(waiting)).toEqual({
    "page-help": { hidden: false, plays: "vault", controls: null },
    "catalog-help": hidden,
    "integrations-page-help": hidden,
  });
  // Recovery mode: none.
  expect(states(waiting, true)["page-help"]).toEqual(hidden);
  // A Work Environment's member: the video in place, no explanation played.
  const member = pageGuide(
    trezor,
    { ...facts(read(connected, "work", known("member"))), kind: "work" },
    messages("cs", "work"),
  );
  expect(pageHelpStates(trezor, member, false)["page-help"]).toEqual({
    hidden: false,
    plays: null,
    controls: "vault-video",
  });
  // A removed person sees the words without the sharing.
  const removed = pageGuide(
    trezor,
    { ...facts(read(connected, "work", known("revoked"))), kind: "work" },
    messages("cs", "work"),
  );
  expect(pageHelpStates(trezor, removed, false)["page-help"]).toEqual({
    hidden: false,
    plays: "vault-agents",
    controls: null,
  });
});

test("Escape on Settings while the guide explains closes the explanation, not Settings", () => {
  const settings = {
    view: "settings",
    guiding: false,
    dialog: false,
    typing: false,
  } as const;
  expect(escapeLeavesSettings(settings)).toBe(true);
  // The guide's listener is added when an explanation opens, after the
  // shell's: the shell asks the guide first.
  expect(escapeLeavesSettings({ ...settings, guiding: true })).toBe(false);
  expect(escapeLeavesSettings({ ...settings, dialog: true })).toBe(false);
  expect(escapeLeavesSettings({ ...settings, typing: true })).toBe(false);
  for (const view of ["home", "files", "vault", "integrations"] as const)
    expect(escapeLeavesSettings({ ...settings, view })).toBe(false);
});

// What a removed sentence said that no step of its section's "?" says stays
// beside its choice (Pablo's review of #503): what the preset is, what the
// optional rows Composio and Trezor v Bitwardenu give, and what the evidence
// of a recovery carries before a person files it to the public repository.
test("what no step says stays beside its choice: the preset, Composio, Trezor v Bitwardenu, the evidence", () => {
  const hint = byId("preset-hint");
  expect(hint.attributes.get("data-message")).toBe("presetHint");
  expect(byId("preset").attributes.get("aria-describedby")).toBe("preset-hint");
  for (const locale of locales) {
    const copy = messages(locale);
    for (const key of [
      "presetHint",
      "startComposioText",
      "startBitwardenText",
      "recoveryEvidenceText",
    ] as const)
      expect({ locale, key, said: copy[key].length > 0 }).toEqual({
        locale,
        key,
        said: true,
      });
    const rows = optionalRows(
      {
        preset: "hosted-organization-personal",
        composio: "missing",
        sshDevices: 0,
        bitwarden: true,
      },
      copy,
    );
    expect(
      Object.fromEntries(rows.map((row) => [row.id, row.text])),
    ).toMatchObject({
      composio: copy.startComposioText,
      bitwarden: copy.startBitwardenText,
    });
  }
  // The steps of Obecné do not name the preset; its hint does.
  const general = pageGuide(
    { view: "settings", section: "general" },
    {
      kind: "work",
      locale: "cs",
      composio: null,
      vault: { vault: null, person: null },
      start: "basics",
      tools: null,
    },
    messages("cs", "work"),
  );
  expect(
    general.guides[0]?.steps.some((step) => /předvolb|druh/i.test(step.text)),
  ).toBe(false);
});

// Nástroje's steps follow what its page draws (Pablo's review of #503), as
// Trezor's follow the vault: the tools as the panel lays them out
// (`toolGroups`), what it marks (`toolGuideTargets`), and the steps the "?"
// plays at those marks.
test("Nástroje's '?' says only what its page can show: no steps on connecting where nothing can be connected, as in a Team Environment with gh alone", () => {
  const tool = (fields: Partial<ToolOverview>): ToolOverview => ({
    name: "composio",
    command: "composio",
    tier: "recommended",
    setup: "launchpad",
    enabled: false,
    offered: true,
    purpose: "Purpose.",
    usage: "Usage.",
    source: "https://docs.composio.dev/docs/cli",
    installed: true,
    prompt: "Task.",
    ...fields,
  });
  const signedIn = { state: "signed-in", account: "a@example.com" } as const;
  const gh = tool({
    name: "gh",
    command: "gh",
    tier: "required",
    enabled: true,
    signIn: signedIn,
  });
  /** The page as drawn for `tools`: each step's words, its mark, and what
   * that mark is on (the tool and its part), in Czech. */
  const drawn = (
    kind: ShellEnvironmentKind,
    tools: readonly ToolOverview[],
  ) => {
    const copy = messages("cs", kind);
    const targets = toolGuideTargets(
      toolGroups(tools, copy),
      copy,
      kind === "team",
    );
    const guide = pageGuide(
      { view: "settings", section: "tools" },
      {
        kind,
        locale: "cs",
        composio: null,
        vault: { vault: null, person: null },
        start: "basics",
        tools: targets,
      },
      copy,
    );
    const on = (at: string) =>
      at === "tool-connect"
        ? targets.connect
        : at === "tool-agents"
          ? targets.agents && { ...targets.agents, part: "switch" }
          : "tools";
    return {
      help: guide.help,
      steps: (guide.guides[0]?.steps ?? []).map((step) => [
        step.text,
        step.at,
        on(step.at),
      ]),
    };
  };
  // A Team Environment with gh alone, working as the Organization's
  // identity: nothing to connect and no switch to move. What the page is,
  // and that the Team shares it.
  expect(drawn("team", [gh])).toEqual({
    help: "settings-tools-team",
    steps: [["Toto Týmové Prostředí sdílí celý Team", "tools", "tools"]],
  });
  // A team account connected here, beside gh: the steps on team accounts
  // point at its line, the switch at its switch.
  expect(drawn("team", [gh, tool({ signIn: signedIn })])).toEqual({
    help: "settings-tools-team",
    steps: [
      ["Toto Týmové Prostředí sdílí celý Team", "tools", "tools"],
      [
        "Přihlašujte se tu týmovými účty",
        "tool-connect",
        { tool: "composio", part: "state" },
      ],
      [
        "Co přihlásíte, může používat každý z Teamu",
        "tool-connect",
        { tool: "composio", part: "state" },
      ],
      [
        "Přepínač určí, jestli ho agenti používají",
        "tool-agents",
        { tool: "composio", part: "switch" },
      ],
    ],
  });
  // A team account still to connect: its sign-in.
  expect(drawn("team", [gh, tool({})]).steps[1]?.[2]).toEqual({
    tool: "composio",
    part: "action",
  });
  // A Work Environment with a sign-in to make: the four steps.
  expect(drawn("work", [gh, tool({})])).toEqual({
    help: "settings-tools",
    steps: [
      [
        "Nástroje, které agenti v tomto Pracovním Prostředí používají",
        "tools",
        "tools",
      ],
      [
        "Připojíte je svým účtem",
        "tool-connect",
        { tool: "composio", part: "action" },
      ],
      [
        "Kam je připojíte, tam agenti můžou",
        "tool-connect",
        { tool: "composio", part: "action" },
      ],
      [
        "Přepínač určí, jestli ho agenti používají",
        "tool-agents",
        { tool: "composio", part: "switch" },
      ],
    ],
  });
  // A Work Environment whose only tool the Organization does not allow:
  // nothing to connect, and its switch does not move.
  expect(drawn("work", [tool({ organization: { allowed: false } })])).toEqual({
    help: "settings-tools",
    steps: [
      [
        "Nástroje, které agenti v tomto Pracovním Prostředí používají",
        "tools",
        "tools",
      ],
    ],
  });
  // Everything connected in a Work Environment: gh's own line is a
  // connection the person made.
  expect(drawn("work", [gh, tool({ signIn: signedIn })]).steps[1]?.[2]).toEqual(
    { tool: "gh", part: "state" },
  );
  // The vault's own row and a tool not offered here are no targets of
  // either step (Pablo's review of #503): a Team Environment with gh and
  // Trezor v Bitwardenu alone, and one with a switched-on tool it does not
  // offer (listed only so that it can be switched off), say only what the
  // page is.
  const vaultRow = tool({ name: "bitwarden", command: "bw" });
  const unoffered = tool({
    name: "wacli",
    command: "wacli",
    enabled: true,
    offered: false,
  });
  for (const tools of [
    [gh, vaultRow],
    [gh, unoffered],
    [gh, vaultRow, unoffered],
  ]) {
    const copy = messages("cs", "team");
    expect(toolGuideTargets(toolGroups(tools, copy), copy, true)).toEqual({
      connect: null,
      agents: null,
    });
    expect(drawn("team", tools)).toEqual({
      help: "settings-tools-team",
      steps: [["Toto Týmové Prostředí sdílí celý Team", "tools", "tools"]],
    });
  }
  // Beside them, an offered tool still takes both steps.
  expect(
    drawn("work", [gh, vaultRow, unoffered, tool({})]).steps.map(
      (step) => step[2],
    ),
  ).toEqual([
    "tools",
    { tool: "composio", part: "action" },
    { tool: "composio", part: "action" },
    { tool: "composio", part: "switch" },
  ]);
  // Before the tools are read the "?" waits.
  const unread = pageGuide(
    { view: "settings", section: "tools" },
    {
      kind: "team",
      locale: "cs",
      composio: null,
      vault: { vault: null, person: null },
      start: "basics",
      tools: null,
    },
    messages("cs", "team"),
  );
  expect(
    pageHelpStates({ view: "settings", section: "tools" }, unread, false)[
      "page-help"
    ],
  ).toEqual({ hidden: true, plays: null, controls: null });
});
