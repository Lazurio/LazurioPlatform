import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeHandoverFolder } from "../src/folder/initialize-folder";
import type { MachineBinding } from "../src/folder/machine-binding";
import { visitorsChapter } from "../src/folder/manual";
import { outputPaths } from "../src/folder/outputs";
import { executionOs } from "../src/folder/platform";
import {
  type PresetName,
  presetProfile,
  selectablePresets,
  tryPreset,
} from "../src/folder/presets";
import { renderOutputs } from "../src/folder/preview";
import {
  instructionSource,
  instructionTemplateRevision,
  isOlderTemplateRevision,
  visitorsHeading,
  visitorsOf,
  visitorsSection,
} from "../src/folder/render";
import { parseFolderPreferences } from "../src/folder/state";
import { refreshFolder } from "../src/folder/update-profile";
import { binding, bindings } from "./fixtures/machine-bindings";
import {
  controls,
  tryCases,
  tryHandover,
  withoutVisitors,
} from "./fixtures/try-environments";

// Plan DEV-6668 slice 5, decision F55's addendum of 2026-10-20 (3): the
// section of the generated instructions for the agents visitors talk to in a
// public Environment, rendered where the Try overlay preset says
// `instructions: "visitors"`, on try-01's handover recorded as Work and as
// Team, without and with its vault, in both languages.

const locales = ["cs", "en"] as const;
type Locale = (typeof locales)[number];

function render(preset: PresetName, machine: MachineBinding, locale: Locale) {
  return renderOutputs({
    preset,
    machine,
    profile: presetProfile(preset, "linux", { locale }),
  });
}

/** The visitors' section as AGENTS.md and `manual/this-machine.md` hold it:
 * from its heading to the next heading of the same level. */
function section(content: string, locale: Locale): string {
  const heading = `## ${visitorsHeading[locale]}\n`;
  const start = content.indexOf(heading);
  if (start === -1 || content.indexOf(heading, start + 1) !== -1)
    throw new Error("The visitors' section is not there once");
  const end = content.indexOf("\n## ", start + heading.length);
  return content.slice(start, end === -1 ? undefined : end);
}

const expected = {
  github: {
    cs: "Ke GitHubu se tu přihlásit nejde.",
    en: "GitHub sign-in is not available here.",
  },
  signOut: {
    cs: "Ke svému AI nebo jinému účtu se návštěvník smí přihlásit sám, na vlastní riziko, a po použití se má odhlásit.",
    en: "A visitor may sign in to their own AI or other account themselves, at their own risk, and should sign out after use.",
  },
  signNobodyIn: {
    cs: "- **Nikoho nikam nepřihlašuj.**",
    en: "- **Sign nobody in to anything.**",
  },
  shared: {
    cs: "Všichni, kdo sem vstoupí, sdílejí toto Prostředí a vidí, co tu kdo nechal. Návštěvníka nikdy nežádej o hesla, klíče ani osobní údaje a nic takového nezapisuj do souborů.",
    en: "Everyone who enters shares this Environment and sees what is left here. Never ask a visitor for passwords, keys or personal data, and never put such data into files.",
  },
  publish: {
    cs: "Žádný push, pull request, issue, e-mail ani jiný krok navenek. Rozpracovaná práce zůstává jen tady a může zmizet: toto Prostředí se může kdykoli smazat nebo založit znovu.",
    en: "No push, pull request, issue, e-mail or other outward action. Work in progress stays only here and may be wiped: this Environment can be wiped or deployed again at any time.",
  },
  withheld: {
    cs: "Návštěvníci nemají Integrace ani Nastavení → Nástroje",
    en: "Visitors do not have Integrations or Settings → Tools",
  },
  vault: {
    cs: "Trezor, jen pokud ho toto Prostředí má (ověř to příkazem `lazurio vault status`)",
    en: "the Vault, only where this Environment has one (check with `lazurio vault status`)",
  },
  browser: { cs: "prohlížeč Prostředí", en: "the Environment browser" },
  browserManual: {
    cs: "- **Prohlížeč Prostředí:**",
    en: "- **The Environment browser:**",
  },
  language: {
    cs: "Odpovídej jazykem, kterým návštěvník píše; česky mu vykej.",
    en: "Answer in the visitor's language; in Czech, address them formally (vykání).",
  },
};

// A reset the Environment does not have, and any model (the Owner's
// decision of 2026-10-20: the model comes from the Codex configuration).
const nightly =
  /every night|nightly|each night|at night|každou noc|v noci|noční|nočn/i;
const modelInSection =
  /GPT|Luna|Claude|Opus|Sonnet|Haiku|Gemini|Llama|Mistral|o\d-mini/i;
const modelAnywhere = /GPT-\d|gpt-\d|\bLuna\b/;

test("the exact visitors' section of try-01, in AGENTS.md and in manual/this-machine.md, in both languages", () => {
  const [team] = tryCases.filter(
    (entry) => entry.preset === "hosted-organization-team" && !entry.withVault,
  );
  if (team === undefined) throw new Error("No try-01 recorded as Team");
  for (const locale of locales) {
    const outputs = render(team.preset, team.machine, locale);
    expect({
      agents: section(outputs["AGENTS.md"], locale),
      manual: section(outputs["manual/this-machine.md"], locale),
    }).toMatchSnapshot(locale);
  }
});

test("try-01's agents get the visitors' section whatever its Folder recorded, Work or Team, without and with vault", () => {
  for (const locale of locales) {
    const other = locale === "cs" ? "en" : "cs";
    const seen = new Set<string>();
    for (const entry of tryCases) {
      expect([entry.name, visitorsOf(entry.machine)]).toEqual([
        entry.name,
        tryPreset,
      ]);
      const outputs = render(entry.preset, entry.machine, locale);
      const agents = section(outputs["AGENTS.md"], locale);
      const manual = section(outputs["manual/this-machine.md"], locale);
      // The same section, whatever the recorded preset or vault.
      seen.add(`${agents}\n\0\n${manual}`);
      for (const text of [agents, manual]) {
        // The terms and privacy pages are the record's, in the visitor's
        // language: the Folder's first, then the other one.
        for (const pages of [
          tryPreset.notice.terms,
          tryPreset.notice.privacy,
        ]) {
          expect(text).toContain(`\`${pages[locale]}\``);
          expect(text).toContain(`\`${pages[other]}\``);
          expect(text.indexOf(pages[locale])).toBeLessThan(
            text.indexOf(pages[other]),
          );
        }
        for (const sentence of [
          expected.github,
          expected.signOut,
          expected.signNobodyIn,
          expected.shared,
          expected.publish,
          expected.withheld,
          expected.language,
        ])
          expect(text).toContain(sentence[locale]);
        expect(text).not.toMatch(modelInSection);
        expect(text).not.toContain("Lazurio for GitHub");
      }
      // What to explain: the browser where the entry routes it, the vault
      // only where `lazurio vault status` finds one.
      expect(agents).toContain(expected.browser[locale]);
      expect(agents).toContain(expected.vault[locale]);
      expect(manual).toContain(expected.browserManual[locale]);
      expect(manual).toContain("`lazurio vault status`");
      // Nothing generated promises a nightly reset or names a model.
      for (const [path, content] of Object.entries(outputs)) {
        expect([path, nightly.test(content)]).toEqual([path, false]);
        expect([path, modelAnywhere.test(content)]).toEqual([path, false]);
      }
    }
    expect(seen.size).toBe(1);
  }
});

test("the section stands where agents read it first: AGENTS.md before the working rules, the manual right after the preset", () => {
  for (const entry of tryCases)
    for (const locale of locales) {
      const outputs = render(entry.preset, entry.machine, locale);
      const agents = outputs["AGENTS.md"];
      const heading = `## ${visitorsHeading[locale]}`;
      const identity = locale === "cs" ? "- Identita: " : "- Identity: ";
      const work =
        locale === "cs" ? "## Jak se tu pracuje" : "## How work is done here";
      expect(agents.indexOf(identity)).toBeLessThan(agents.indexOf(heading));
      expect(agents.indexOf(heading)).toBeLessThan(agents.indexOf(work));
      const manual = outputs["manual/this-machine.md"];
      const preset = locale === "cs" ? "## Preset `" : "## Preset `";
      const zones = locale === "cs" ? "## Zóny: " : "## Zones: ";
      expect(manual.indexOf(preset)).toBeLessThan(manual.indexOf(heading));
      expect(manual.indexOf(heading)).toBeLessThan(manual.indexOf(zones));
      // No other generated file carries it.
      for (const [path, content] of Object.entries(outputs))
        if (path !== "AGENTS.md" && path !== "manual/this-machine.md")
          expect([path, content.includes(heading)]).toEqual([path, false]);
    }
});

test("the renderer reads no vault: try-01's files are the same bytes without and with its vault", () => {
  for (const preset of [
    "hosted-organization-personal",
    "hosted-organization-team",
  ] as const)
    for (const locale of locales) {
      const [without, withVault] = [false, true].map((vault) => {
        const entry = tryCases.find(
          (each) => each.preset === preset && each.withVault === vault,
        );
        if (entry === undefined) throw new Error("No try-01 case");
        return render(preset, entry.machine, locale);
      });
      expect(withVault).toEqual(without as typeof withVault);
    }
});

test("a public Environment without the Environment browser gets the section without it", () => {
  for (const [preset, machine] of [
    ["hosted-organization-team", bindings.teamPublic],
    ["hosted-organization-personal", bindings.organizationPublic],
  ] as const) {
    expect(machine.entry?.browserOrigin).toBeUndefined();
    for (const locale of locales) {
      const outputs = render(preset, machine, locale);
      const agents = section(outputs["AGENTS.md"], locale);
      const manual = section(outputs["manual/this-machine.md"], locale);
      expect(agents).not.toContain(expected.browser[locale]);
      expect(manual).not.toContain(expected.browserManual[locale]);
      expect(agents).toContain(expected.vault[locale]);
      expect(agents).toContain(expected.github[locale]);
    }
  }
});

test("the controls, and try-01 without its audience, get no visitors' section", () => {
  const handover = tryHandover();
  const { audience: _, ...entry } = handover.entry;
  for (const control of [
    ...controls,
    {
      name: "try-01's handover without the audience",
      preset: "hosted-organization-team" as const,
      machine: binding({ ...handover, entry }),
    },
  ]) {
    expect([control.name, visitorsOf(control.machine)]).toEqual([
      control.name,
      null,
    ]);
    for (const locale of locales) {
      expect(visitorsSection(control.machine, locale)).toEqual([]);
      expect(visitorsChapter(control.machine)).toEqual([]);
      for (const [path, content] of Object.entries(
        render(control.preset, control.machine, locale),
      ))
        expect([
          control.name,
          path,
          content.includes(visitorsHeading[locale]),
        ]).toEqual([control.name, path, false]);
    }
  }
});

// --- An existing public Environment re-renders on refresh -------------------

const posixTest = test.skipIf(process.platform === "win32");

/** try-01's Folder recorded with `preset`: Team as `folder-init` records it,
 * Work as an adoption before the Team assignment left it (the history of
 * tests/try-overlay-preset.test.ts). */
async function tryFolder(preset: PresetName) {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "try-visitors-")));
  const folder = join(parent, "Lazurio");
  await mkdir(folder, { mode: 0o700 });
  await mkdir(join(folder, "organizations"), { mode: 0o755 });
  await mkdir(join(folder, "personalspace"), { mode: 0o700 });
  const handover = tryHandover();
  const machine = binding(handover);
  const profile = presetProfile(preset, executionOs(process.platform), {
    locale: "cs",
  });
  if (selectablePresets(machine).includes(preset)) {
    await initializeHandoverFolder(folder, { preset, machine, profile });
    return { parent, folder, machine, revision: 1 };
  }
  const { assignment: _, ...earlier } = handover.owner;
  await initializeHandoverFolder(folder, {
    preset,
    machine: binding({ ...handover, owner: earlier }),
    profile,
  });
  expect(await refreshFolder(folder, machine)).toEqual({
    kind: "refreshed",
    revision: 2,
  });
  return { parent, folder, machine, revision: 2 };
}

/** The Folder as the release before this section left it: every generated
 * file without the visitors' section and with the previous template
 * revision, its manifest recording that revision and those files' digests. */
async function renderedBeforeTheSection(
  folder: string,
  machine: MachineBinding,
) {
  const previous = "base-instructions-58";
  expect(isOlderTemplateRevision(previous)).toBe(true);
  const strip = withoutVisitors(machine, "cs");
  const path = join(folder, ".lazurio", "instructions.json");
  const manifest = JSON.parse(await readFile(path, "utf8"));
  const outputs: Record<string, string> = {};
  for (const output of outputPaths) {
    const content = strip(
      output,
      await readFile(join(folder, output), "utf8"),
    ).replaceAll(instructionTemplateRevision, previous);
    await writeFile(join(folder, output), content);
    outputs[output] = createHash("sha256").update(content).digest("hex");
  }
  await writeFile(
    path,
    JSON.stringify({ ...manifest, templateRevision: previous, outputs }),
  );
}

posixTest(
  "an existing try-01 Folder of the previous template revision gets the visitors' section on the next refresh, recorded as Work and as Team",
  async () => {
    for (const preset of [
      "hosted-organization-personal",
      "hosted-organization-team",
    ] as const) {
      const { parent, folder, machine, revision } = await tryFolder(preset);
      try {
        await renderedBeforeTheSection(folder, machine);
        const agents = await readFile(join(folder, "AGENTS.md"), "utf8");
        expect(agents).not.toContain(visitorsHeading.cs);
        expect(await refreshFolder(folder, machine)).toEqual({
          kind: "refreshed",
          revision: revision + 1,
        });
        // Exactly what this product renders from the Folder's own record
        // (its OS and its tools).
        const current = renderOutputs(
          instructionSource(
            parseFolderPreferences(
              JSON.parse(
                await readFile(
                  join(folder, ".lazurio", "preferences.json"),
                  "utf8",
                ),
              ),
            ),
          ),
        );
        for (const output of outputPaths)
          expect([
            output,
            await readFile(join(folder, output), "utf8"),
          ]).toEqual([output, current[output]]);
        expect(
          section(await readFile(join(folder, "AGENTS.md"), "utf8"), "cs"),
        ).toContain(tryPreset.notice.terms.cs);
        const manifest = JSON.parse(
          await readFile(join(folder, ".lazurio", "instructions.json"), "utf8"),
        );
        expect(manifest.templateRevision).toBe(instructionTemplateRevision);
        // A second refresh has nothing to do.
        expect(await refreshFolder(folder, machine)).toEqual({
          kind: "unchanged",
        });
      } finally {
        await rm(parent, { recursive: true, force: true });
      }
    }
  },
);
