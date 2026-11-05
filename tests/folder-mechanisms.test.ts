import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { quotedLaunchpadLabels } from "../src/folder/manual-mechanisms";
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

// Decisions cited before the register has them: 0230 (requests to the Admin
// inside Lazurio) is being recorded by its own register pull request. When
// the register gains a number, it leaves this list (the next test says so).
const pendingInRegister = new Set(["0230"]);

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
      expect([locale, key, text.includes(catalog[key])]).toEqual([
        locale,
        key,
        true,
      ]);
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
