import { expect, test } from "bun:test";
import { presetProfile } from "../src/folder/presets";
import { renderOutputs } from "../src/folder/preview";
import { journeys } from "./fixtures/journeys";

// A chat starts in the Folder's root (root decision 0189), where Codex loads
// only the Folder's `.agents/skills` and Claude Code announces a nested
// `.claude/skills` only once it works with a file in that checkout
// (Lazurio/LazurioPlatform#867). Every Environment tells its agents so, in
// AGENTS.md and in the manual, in both languages.

const agentsLine = {
  cs: "Její skilly ti harness z kořene Folderu nenačte: projdi popisy v `organizations/<org>/.agents/skills/*/SKILL.md` (`manual/working-here.md`).",
  en: "Your harness does not load its skills from the Folder's root: go through the descriptions in `organizations/<org>/.agents/skills/*/SKILL.md` (`manual/working-here.md`).",
} as const;

const manualParts = {
  cs: [
    "Codex skilly Organizace nenačte vůbec a Claude Code je ohlásí, až když pracuješ se soubory v jejím checkoutu.",
    "projdi `name` a `description` ve frontmatteru každého `organizations/<org>/.agents/skills/*/SKILL.md`",
    "Skilly nekopíruj ani neodkazuj do kořene Folderu.",
  ],
  en: [
    "Codex never loads the Organization's skills, and Claude Code announces them only once you work with files in its checkout.",
    "go through `name` and `description` in the frontmatter of every `organizations/<org>/.agents/skills/*/SKILL.md`",
    "Never copy or link skills into the Folder's root.",
  ],
} as const;

test("every Environment tells its agents to go through the Organization's skills, which the harness does not load from the Folder's root", () => {
  for (const journey of journeys)
    for (const locale of ["cs", "en"] as const) {
      const outputs = renderOutputs({
        preset: journey.preset,
        machine: journey.machine,
        profile: presetProfile(journey.preset, journey.os, { locale }),
      });
      const where = [journey.preset, journey.os, locale];
      const agents = outputs["AGENTS.md"];
      const manual = outputs["manual/working-here.md"];
      expect([...where, agents.includes(agentsLine[locale])]).toEqual([
        ...where,
        true,
      ]);
      for (const part of manualParts[locale])
        expect([...where, part, manual.includes(part)]).toEqual([
          ...where,
          part,
          true,
        ]);
    }
});
