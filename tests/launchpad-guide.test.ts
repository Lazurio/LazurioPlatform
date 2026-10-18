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
} from "../src/launchpad/guides";
import { integrationsHelp } from "../src/launchpad/integrations-view";
import { messages } from "../src/launchpad/messages";
import { type PageRoute, routeFrame } from "../src/launchpad/routes";
import { escapeLeavesSettings } from "../src/launchpad/shell";
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
import type { VaultStatus } from "../src/vault/flow";
import { guideTextFindings } from "./fixtures/guide-text";

// The Launchpad as the host of the shell's guide (decision F56 and its
// addendum of 2026-10-18, plan DEV-6612 PRs 4 and 5): every page of the Apps
// column has its "?" right after its heading, and exactly one. It plays a
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
): VaultGuideFacts => ({ vault: { status, environment }, person });
const known = (
  state: Extract<VaultPagePerson, { kind: "known" }>["state"],
): VaultPagePerson => ({ kind: "known", state, signIn: true });
const unknownPerson = (
  reason: Extract<VaultPagePerson, { kind: "unknown" }>["reason"],
): VaultPagePerson => ({ kind: "unknown", reason });

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
  read(ownBitwarden, "personal", known("not-invited")),
  read({ kind: "vault-status", state: "needs-connection" }, "personal"),
  read(unsupported("connection-unreadable"), "personal"),
  read(unsupported("no-vault"), null),
  read(unsupported("no-tailnet"), null),
  read(unsupported("workstation"), null),
  read(unsupported("handover-missing"), null),
];

/** Every combination of what the page knows. */
function* everyFacts(): Generator<PageGuideFacts> {
  for (const kind of kinds)
    for (const locale of locales)
      for (const composio of [null, false, true])
        for (const vault of vaultFacts) yield { kind, locale, composio, vault };
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
        // Only Trezor waits, while its vault's state is not read.
        expect({ name, waits: facts.vault.vault === null }).toEqual({
          name: "Trezor",
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
  for (const route of [
    { view: "integrations", tab: "custom" },
    { view: "integrations", tab: "custom", form: { server: "s" } },
  ] as const) {
    expect(help(route)).toBe("integrations-custom");
    expect(help(route, { composio: true })).toBe("integrations-custom");
  }
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
        expect(atMarks.get(own.id) ?? where).toBe(where);
        atMarks.set(own.id, where);
        expect(own.id).not.toBeOneOf([...principleIds]);
      }
  }
  expect(found).toEqual([]);
  expect([...atMarks.keys()].sort()).toEqual([
    "files-team",
    "integrations-composio",
    "integrations-custom",
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
  // this Environment has its passwords.
  const team = { vault: { vault: null, person: null } } as const;
  for (const locale of locales) {
    const guide = pageGuide(
      { view: "vault" },
      {
        ...team,
        kind: "team",
        locale,
        composio: null,
        vault: read(connected, "team", unknownPerson("not-managed")),
      },
      messages(locale, "team"),
    );
    expect(guide.help).toBe("vault-agents");
    const words = (parseGuides(guide.guides)?.[0]?.steps ?? []).map(
      (step) => step.text,
    );
    expect(words).toEqual(
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
    for (const text of words)
      expect(text).not.toMatch(/Bitwarden|svého|your|sdíl|share|ulož|store/i);
  }
  // A video where its words are true, and the guide nowhere else.
  const video = pageGuide(
    { view: "vault" },
    {
      kind: "work",
      locale: "cs",
      composio: null,
      vault: read(connected, "work", known("member")),
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
  ])
    for (const locale of locales)
      expect({ key, here: Object.hasOwn(messages(locale), key) }).toEqual({
        key,
        here: false,
      });
  expect(messages("cs").filesEmptyRoot).toBe("Zatím žádné soubory.");
  expect(messages("en").filesEmptyRoot).toBe("No files yet.");
});

test('the "?" of Trezor waits until the vault\'s state is read, in a Personal Environment too, and then shows what it plays', () => {
  const trezor = { view: "vault" } as const;
  const facts = (vault: VaultGuideFacts): PageGuideFacts => ({
    kind: "personal",
    locale: "cs",
    composio: null,
    vault,
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
