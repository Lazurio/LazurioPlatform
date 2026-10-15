import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { words as browserWords } from "../src/browser/people/words";
import { renderManual } from "../src/folder/manual";
import { presetNames, presetProfile } from "../src/folder/presets";
import { environmentWording, renderInstructions } from "../src/folder/render";
import { messages } from "../src/launchpad/messages";
import { newTabCopy } from "../src/launchpad/new-tab-view";
import { shellMessages } from "../src/shell/messages";
import { renderOfflineGuide } from "../src/shell/offline-page";
import {
  activatableTools,
  mcpServerPrompt,
  toolPrompt,
} from "../src/tools/catalog";
import { bindings } from "./fixtures/machine-bindings";

// Decision F28: towards people the place they work in is the Environment,
// and a hosted one a Remote Environment. What people read in the Launchpad
// (both locales), the prompts they copy, and the instructions the Folder
// gives agents (who then talk to people) never call it Mašina, Machine or
// VM. "Machine" stays the technical term; the allowlist below is every
// place it may still appear, each with its reason.
const forbidden: readonly [string, RegExp][] = [
  ["Mašina (any case)", /[Mm]ašin/],
  ["VM", /\bVMs?\b/],
  ["Machine as a noun", /\bMachines?\b/],
];

// Removed before the scan, in this order (the rule first: it quotes a
// command). Keep it short: a new entry needs
// a reason people can check.
const allowlist: readonly [string, (text: string) => string][] = [
  // The rule itself has to name the words it replaces.
  [
    "the wording rule",
    (text) =>
      text
        .replaceAll(environmentWording.cs, "")
        .replaceAll(environmentWording.en, ""),
  ],
  // Commands, paths, identifiers, JSON keys and schema names are technical
  // and are quoted as code: `lazurio machine inspect`, `manual/this-machine.md`,
  // `personal-vm`, `launchpad.<machine>.<org>.lazurio.io`.
  ["code spans", (text) => text.replace(/`[^`\n]*`/g, "``")],
  // The technical term where the manual defines it (the glossary row and the
  // boundary bullet of manual/lazurio.md) is set in bold.
  [
    "**Machine**, the defined technical term",
    (text) => text.replaceAll("**Machine**", ""),
  ],
  // The product that hosts Remote Environments.
  [
    "Lazurio Machines, a product name",
    (text) => text.replaceAll("Lazurio Machines", ""),
  ],
  // The name of the principle (root AGENTS.md, "Koexistence Human and Machine").
  [
    "Human and Machine, a principle's name",
    (text) => text.replaceAll("Human and Machine", ""),
  ],
  // Czech "mašinérie" is machinery, another word.
  ["mašinérie (machinery)", (text) => text.replace(/mašinéri/g, "")],
];

function findings(where: string, text: string): string[] {
  const cleaned = allowlist.reduce(
    (current, [, strip]) => strip(current),
    text,
  );
  return cleaned
    .split("\n")
    .flatMap((line) =>
      forbidden
        .filter(([, pattern]) => pattern.test(line))
        .map(([word]) => `${where}: ${word}: ${line.trim()}`),
    );
}

test("the Launchpad's message catalog says Environment in both locales", () => {
  const found = (["en", "cs"] as const).flatMap((locale) =>
    Object.entries(messages(locale)).flatMap(([key, value]) =>
      findings(`messages.${locale}.${key}`, value),
    ),
  );
  expect(found).toEqual([]);
});

test("the shell elements say Environment in both locales (decision F36)", () => {
  const found = (["en", "cs"] as const).flatMap((locale) =>
    Object.entries(shellMessages(locale)).flatMap(([key, value]) =>
      findings(
        `shell.${locale}.${key}`,
        typeof value === "string" ? value : Object.values(value).join("\n"),
      ),
    ),
  );
  expect(found).toEqual([]);
});

test("the Launchpad page's own text says Environment", async () => {
  const html = await readFile(
    join(import.meta.dir, "..", "src", "launchpad", "index.html"),
    "utf8",
  );
  // What a person sees: text between tags, without comments, markup and
  // attribute values (ids, routes and icon names are identifiers).
  const text = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style)[\s\S]*?<\/\1>/g, "")
    .replace(/<[^>]*>/g, "\n");
  expect(findings("index.html", text)).toEqual([]);
});

test("the prompts a person copies for an agent say Environment", () => {
  const found = (["en", "cs"] as const).flatMap((locale) => [
    ...findings(`mcpServerPrompt.${locale}`, mcpServerPrompt(locale)),
    ...activatableTools().flatMap(({ name }) =>
      [false, true].flatMap((team) =>
        findings(
          `toolPrompt.${name}.${locale}${team ? ".team" : ""}`,
          toolPrompt(name, locale, { team }) ?? "",
        ),
      ),
    ),
  ]);
  expect(found).toEqual([]);
});

// Every preset, both locales, the recorded handovers that carry
// relationships or an entry, every catalog tool enabled and a note, so every
// generated paragraph is scanned.
const journeys = [
  ["local", null],
  ["hosted-personal", bindings.personalRelated],
  ["hosted-personal", bindings.personalEntry],
  ["hosted-organization-personal", bindings.related],
  ["hosted-organization-personal", bindings.organizationEntry],
  ["hosted-organization-team", bindings.team],
  ["hosted-organization-steward", bindings.automated],
] as const;

test("the generated Folder instructions and manual say Environment towards people and carry the rule", () => {
  const tools = activatableTools()
    .filter((tool) => tool.activation.tier !== "required")
    .map((tool) => tool.name)
    .sort();
  expect(new Set(journeys.map(([preset]) => preset))).toEqual(
    new Set(presetNames),
  );
  const found: string[] = [];
  for (const [preset, machine] of journeys)
    for (const locale of ["cs", "en"] as const) {
      const source = {
        preset,
        machine,
        profile: presetProfile(preset, preset === "local" ? "macos" : "linux", {
          locale,
        }),
        tools,
        toolNotes: { [tools[0] as string]: "A note for agents." },
      };
      const agents = renderInstructions(source);
      expect(agents).toContain(environmentWording[locale]);
      found.push(...findings(`${preset}/${locale}/AGENTS.md`, agents));
      for (const [path, text] of Object.entries(renderManual(source)))
        found.push(...findings(`${preset}/${locale}/${path}`, text));
    }
  expect(found).toEqual([]);
});

// Root decision 0170, addendum 2026-10-15 (F28 addendum of the same day):
// Czech that a person reads names the place Prostředí, a hosted one has no
// Czech name of its own, the product is Lazurio, the Organization is
// Organizace and demonstratives are tento, tato, toto. English is unchanged,
// and so are the rules written for agents in the Folder, which may keep the
// technical term Environment and the tenhle family; only the sentences an
// agent is told to say follow these words, and the rule itself is checked
// below by its content.
const letter = "\\p{L}";
const czechForbidden: readonly [string, RegExp][] = [
  ["Environment (any form)", /Environment/],
  ["Vzdálené Prostředí", /[Vv]zdálen\p{L}* [Pp]rostřed/u],
  // The kind is enough (the brand voice, "Druh Prostředí stačí"; Matěj
  // 2026-10-14): never a suffix "jen vaše" or "sdílené Teamem". A sentence
  // may still say in full words that a Team Prostředí is shared ("sdílené
  // celým Teamem").
  ["jen vaše", new RegExp(`(?<!${letter})jen va(š|s)${letter}*`, "iu")],
  ["sdílené Teamem", /sdílen\p{L}* Teamem/u],
  ["Launchpad as a name", /Launchpad/],
  ["Dashboard as a name", /Dashboard/],
  [
    "firma for the Organization",
    new RegExp(
      `(?<!${letter})[Ff]irm(a|y|ě|u|ou|ám|ách|ami)?(?!${letter})`,
      "u",
    ),
  ],
  [
    "the tenhle family",
    new RegExp(
      `(?<!${letter})[Tt](enhle|ahle|ohle|uhle|omhle|éhle|ohohle|yhle|ímhle|omuhle|ěmahle|ěchhle|ěmihle)(?!${letter})`,
      "u",
    ),
  ],
];

// Removed before the Czech scan: commands, paths and identifiers, which are
// quoted as code (`lazurio launchpad serve`). Nothing else is allowed.
function czechFindings(where: string, text: string): string[] {
  return [
    ...findings(where, text),
    ...text
      .replace(/`[^`\n]*`/g, "``")
      .split("\n")
      .flatMap((line) =>
        czechForbidden
          .filter(([, pattern]) => pattern.test(line))
          .map(([word]) => `${where}: ${word}: ${line.trim()}`),
      ),
  ];
}

// The Czech string literals of a source file whose words are not exported
// (the CLI's human output and the prepared prompts built from facts): every
// literal with a Czech letter outside comments. A literal that spans lines is
// read line by line.
async function czechLiterals(path: string): Promise<string> {
  const source = await readFile(join(import.meta.dir, "..", path), "utf8");
  return source
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .flatMap((line) =>
      [
        ...line.matchAll(
          /"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`|'(?:[^'\\]|\\.)*'/g,
        ),
      ]
        .map(([literal]) => literal.slice(1, -1))
        .filter((literal) => /[ěščřžýáíéůúňťď]/i.test(literal)),
    )
    .join("\n");
}

test("Czech that people read says Prostředí, Lazurio, Organizace and tento (0170 addendum 2026-10-15)", async () => {
  const found = [
    ...Object.entries(messages("cs")).flatMap(([key, value]) =>
      czechFindings(`messages.cs.${key}`, value),
    ),
    ...Object.entries(shellMessages("cs")).flatMap(([key, value]) =>
      czechFindings(
        `shell.cs.${key}`,
        typeof value === "string" ? value : Object.values(value).join("\n"),
      ),
    ),
    ...Object.entries(newTabCopy("cs")).flatMap(([key, value]) =>
      czechFindings(`newTab.cs.${key}`, value),
    ),
    ...Object.entries(browserWords.cs).flatMap(([key, value]) =>
      czechFindings(`browserWords.cs.${key}`, value),
    ),
    ...czechFindings(
      "offline page",
      renderOfflineGuide({
        locale: "cs",
        environment: "Pracovní",
        organization: "Example",
        tailnet: "headscale.example.lazurio.io",
        docs: "https://documentation.lazurio.ai/cs/guide/tailscale/",
        dashboard: "https://dashboard.lazurio.ai/home",
      })
        .replace(/<(script|style)[\s\S]*?<\/\1>/g, "")
        .replace(/<[^>]*>/g, "\n"),
    ),
    ...czechFindings("mcpServerPrompt.cs", mcpServerPrompt("cs")),
    ...activatableTools().flatMap(({ name, activation }) => [
      ...czechFindings(`purpose.${name}.cs`, activation.purpose.cs),
      ...[false, true].flatMap((team) =>
        czechFindings(
          `toolPrompt.${name}.cs${team ? ".team" : ""}`,
          toolPrompt(name, "cs", { team }) ?? "",
        ),
      ),
    ]),
  ];
  for (const path of [
    "src/browser/cli.ts",
    "src/files/cli.ts",
    "src/doctor/cli.ts",
    "src/launchpad/chat-cli.ts",
    "src/tools/team-github.ts",
    "src/recover/prompt.ts",
    "src/update/install-prompt.ts",
  ])
    found.push(...czechFindings(path, await czechLiterals(path)));
  expect(found).toEqual([]);
});

test('the kind is enough in English too: no "only yours" or "shared by the Team" as a label', () => {
  const labels = [
    ...Object.values(messages("en")),
    ...Object.values(shellMessages("en")).flatMap((value) =>
      typeof value === "string" ? [value] : Object.values(value),
    ),
  ];
  expect(
    labels.filter((text) => /only yours|shared by the Team/i.test(text)),
  ).toEqual([]);
});

test("the generated rule tells agents to say Prostředí in Czech and Environment in English", () => {
  for (const locale of ["cs", "en"] as const) {
    const rule = environmentWording[locale];
    expect(rule).toContain("Prostředí");
    expect(rule).toContain("Remote Environment");
    expect(rule).toContain("Prostředí na serveru");
    expect(rule).toContain("Lazurio");
    expect(rule).toContain("0170");
    expect(rule).toContain("2026-10-15");
  }
});

// The guard must see what it guards: an old sentence is caught, and the
// allowlist does not hide a user-facing noun next to an allowed term.
test("the guard catches the old wording and the allowlist hides only its entries", () => {
  expect(findings("t", "Lazurio on this Machine is healthy.")).toHaveLength(1);
  expect(findings("t", "Lazurio na téhle Mašině je v pořádku.")).toHaveLength(
    1,
  );
  expect(findings("t", "- Pracovní VM Organizace.")).toHaveLength(1);
  expect(
    findings("t", "Run `lazurio machine inspect` on a hosted Machine."),
  ).toHaveLength(1);
  expect(
    findings(
      "t",
      "Run `lazurio machine inspect`; ask Lazurio Machines; the **Machine** it runs on; vlastní mašinérií.",
    ),
  ).toEqual([]);
  for (const old of [
    "Na tomto Environmentu neběží.",
    "Tenhle Remote Environment",
    "Vzdálené Prostředí",
    "Otevřít v Launchpadu",
    "Nastavit v Dashboardu",
    "Přehled firmy",
    "Tahle záložka",
    "Osobní · jen vaše",
    "Team Lazurio · sdílené Teamem",
  ])
    expect(czechFindings("t", old)).not.toEqual([]);
  expect(
    czechFindings(
      "t",
      "Toto Prostředí na serveru spustí `lazurio launchpad serve`; firemní účet; proměnné prostředí; bude sdílené celým Teamem.",
    ),
  ).toEqual([]);
});
