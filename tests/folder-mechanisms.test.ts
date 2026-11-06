import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { heldCzechLabels } from "../src/folder/held-labels";
import {
  moduleSentence,
  quotedLaunchpadLabels,
} from "../src/folder/manual-mechanisms";
import { presetProfile } from "../src/folder/presets";
import { renderOutputs } from "../src/folder/preview";
import { messages } from "../src/launchpad/messages";
import { bindings } from "./fixtures/machine-bindings";
import { tryBinding } from "./fixtures/try-environments";

// The chapters `mechanisms.md` and `admin.md` and the skill `admin-request`
// (decision F14, proposed addendum of 2026-11-05) explain Lazurio's mechanisms
// to the agents of people in an Organization. They stay true by construction
// where they can: the Launchpad's labels come from its catalog, and every
// decision they cite, with the status they claim for it, is held to the
// register in this repository.

const environments = [
  { preset: "local", machine: null, os: "macos" },
  { preset: "hosted-personal", machine: bindings.personal, os: "linux" },
  {
    preset: "hosted-organization-personal",
    machine: bindings.organization,
    os: "linux",
  },
  { preset: "hosted-organization-team", machine: bindings.team, os: "linux" },
  {
    preset: "hosted-organization-personal",
    machine: tryBinding(),
    os: "linux",
    visitors: true,
  },
] as const;

const newOutputs = [
  "manual/mechanisms.md",
  "manual/admin.md",
  ".agents/skills/admin-request/SKILL.md",
  ".claude/skills/admin-request/SKILL.md",
] as const;

function rendered(
  environment: (typeof environments)[number],
  locale: "cs" | "en",
): Readonly<Record<string, string>> {
  const outputs = renderOutputs({
    preset: environment.preset,
    machine: environment.machine,
    profile: presetProfile(environment.preset, environment.os, { locale }),
    tools: [],
    toolNotes: {},
  }) as Record<string, string | { content: string }>;
  return Object.fromEntries(
    Object.entries(outputs).map(([path, entry]) => [
      path,
      typeof entry === "string" ? entry : entry.content,
    ]),
  );
}

// Decisions cited before the register has them, while their register pull
// request is open (0229 and 0230 waited here). When the register gains a
// number, it leaves this list (the next test says so).
const pendingInRegister = new Set<string>();

const register = readFileSync(
  join(import.meta.dir, "..", "docs", "decision-register.md"),
  "utf8",
);
const statusOf = new Map<string, string>();
for (const entry of register.split("\n### ").slice(1)) {
  const number = entry.slice(0, 4);
  const status = /- \*\*Status:\*\* ([^·\n]+)/.exec(entry)?.[1] ?? "";
  if (/^\d{4}$/.test(number)) statusOf.set(number, status.trim());
}

test("every Environment renders the two chapters and the skill in both languages, with the same structure", () => {
  for (const environment of environments) {
    const cs = rendered(environment, "cs");
    const en = rendered(environment, "en");
    for (const path of newOutputs) {
      expect([environment.preset, path, typeof cs[path]]).toEqual([
        environment.preset,
        path,
        "string",
      ]);
      const csLines = (cs[path] ?? "").split("\n");
      const enLines = (en[path] ?? "").split("\n");
      expect([path, csLines.length]).toEqual([path, enLines.length]);
      const headings = (lines: string[]) =>
        lines.map((line) => /^#+ /.exec(line)?.[0] ?? "").join("|");
      expect(headings(csLines)).toBe(headings(enLines));
    }
    expect(cs[".agents/skills/admin-request/SKILL.md"]).toBe(
      cs[".claude/skills/admin-request/SKILL.md"],
    );
  }
});

test("the chapters quote the Launchpad's labels from its own catalog and leak no placeholder", () => {
  const environment = environments[2];
  for (const locale of ["cs", "en"] as const) {
    const outputs = rendered(environment, locale);
    const text = `${outputs["manual/mechanisms.md"]}\n${outputs["manual/admin.md"]}`;
    const catalog = messages(locale);
    for (const key of quotedLaunchpadLabels)
      expect([
        locale,
        key,
        text.includes(
          (locale === "cs" ? heldCzechLabels[key] : undefined) ?? catalog[key],
        ),
      ]).toEqual([locale, key, true]);
    expect(text).not.toMatch(/\{(toto|tomto|this|tohoto|v tomto)\}/);
  }
});

test("every decision the chapters and the skill cite is in the register, and a status they claim is the register's", () => {
  const outputs = rendered(environments[2], "en");
  const text = newOutputs.map((path) => outputs[path]).join("\n");
  const cited = new Set(text.match(/\b0\d{3}\b/g) ?? []);
  expect(cited.size).toBeGreaterThan(10);
  for (const number of cited)
    expect([
      number,
      statusOf.has(number) || pendingInRegister.has(number),
    ]).toEqual([number, true]);
  // "(decision 0228, not yet deployed)", "(decision 0229, not yet deployed)",
  // "(decision 0192, target model)".
  const claims = [
    ...text.matchAll(
      /decisions? (\d{4}), (not yet deployed|proposed|target model)/g,
    ),
  ];
  expect(claims.length).toBeGreaterThan(3);
  for (const [, number, claim] of claims) {
    if (pendingInRegister.has(number ?? "")) continue;
    expect([number, statusOf.get(number ?? "")?.includes(claim ?? "")]).toEqual(
      [number, true],
    );
  }
});

test("a decision leaves the pending list once the register has it", () => {
  for (const number of pendingInRegister)
    expect([number, statusOf.has(number)]).toEqual([number, false]);
});

// Decision F14, addendum of 2026-11-05: the chapter explains modules in the
// words the skill new-module uses, and no text of a Folder says what the code
// no longer does (`src/content/sync.ts`, F9's addendum of 2026-11-01).
test("the chapter explains modules, and no generated text says the product does not synchronize or recommends a database outside the Organization", () => {
  for (const environment of environments)
    for (const locale of ["cs", "en"] as const) {
      const outputs = rendered(environment, locale);
      const cs = locale === "cs";
      const chapter = outputs["manual/mechanisms.md"] ?? "";
      for (const phrase of [
        cs ? "## Moduly" : "## Modules",
        moduleSentence[locale],
        cs ? "### Kde leží data" : "### Where the data lives",
        "`data/v2/`",
        "`<slug>-data`",
        "Dolt",
        "`admin-request`",
        "`new-module`",
        "`docs/adoption.md`",
        "`lazurio organization sync`",
        "`restricted`",
        cs
          ? "Přehledu Organizace → Moduly → Přístup"
          : "Dashboard → Modules → Access",
        "`~/Documents/`",
        // The manifest names every module, so only reading is out of reach.
        cs
          ? "agent ho nepřečte; jméno z manifestu Organizace vidět může"
          : "the agent cannot read it; its name may still show in the Organization's manifest",
      ])
        expect([phrase, chapter.includes(phrase)]).toEqual([phrase, true]);
      const all = Object.values(outputs).join("\n");
      for (const claim of [
        "Synchronizaci obsahu produkt zatím neumí",
        "The product does not synchronize",
        "Synchronizaci repozitářů Organizací produkt zatím neumí",
        "doporučujeme **Neon**",
        "we recommend **Neon**",
      ])
        expect([claim, all.includes(claim)]).toEqual([claim, false]);
      expect(all).not.toContain(cs ? "Zkontrolovat přístupy" : "Check access");
      const holdsOrganizations = environment.preset !== "hosted-personal";
      expect(
        (outputs["manual/troubleshooting.md"] ?? "").includes(
          "`lazurio organization sync`",
        ),
      ).toBe(holdsOrganizations);
    }
});

test("AGENTS.md sends what only the Admin does to admin-request and mechanisms.md, except on a public Environment", () => {
  for (const environment of environments) {
    const isPublic = "visitors" in environment;
    for (const locale of ["cs", "en"] as const) {
      const agents = rendered(environment, locale)["AGENTS.md"] ?? "";
      const named =
        agents.includes("`admin-request`") &&
        agents.includes("`manual/mechanisms.md`");
      expect([environment.preset, locale, named]).toEqual([
        environment.preset,
        locale,
        !isPublic,
      ]);
    }
  }
});
