import { expect, test } from "bun:test";
import { presetProfile } from "../src/folder/presets";
import { renderOutputs } from "../src/folder/preview";
import { journeys } from "./fixtures/journeys";

// The agent consumes these generated documents, not the source root's rules.
// This checks the instruction contract; it is not evidence of model compliance.
test("every generated Folder teaches context discovery before choosing an app or URL", () => {
  for (const journey of journeys)
    for (const locale of ["cs", "en"] as const) {
      const outputs = renderOutputs({
        preset: journey.preset,
        machine: journey.machine,
        profile: presetProfile(journey.preset, journey.os, { locale }),
      });
      const agents = outputs["AGENTS.md"];
      const heading =
        locale === "cs"
          ? "## Nejdřív dohledat kontext"
          : "## Find the context first";
      const routing = agents.slice(
        agents.indexOf(heading),
        agents.indexOf(locale === "cs" ? "## Nástroje" : "## Tools"),
      );
      expect(agents).toContain(heading);
      expect(routing).toContain("manual/working-here.md");
      expect(routing).toContain("lazurio module list");
      expect(routing).toContain("runtime.url");
      expect(routing).toContain(
        locale === "cs" ? "zeptej se" : "ask the Operator",
      );
      expect(routing).toContain(
        locale === "cs"
          ? "není katalog interních modulů"
          : "is not the internal module catalog",
      );

      const manual = outputs["manual/working-here.md"];
      expect(manual).toContain("MAP.md");
      expect(manual).toContain("GLOSSARY.md");
      expect(manual).toContain("lazurio.organization.json");
      expect(manual).toContain("lazurio integrations list --json");
      expect(manual).toContain("gitignore");
      expect(manual).toContain(
        locale === "cs" ? "Nula nálezů" : "Zero matches",
      );
      expect(manual).toContain(
        locale === "cs" ? "obchodní záznam" : "business record",
      );
      if (journey.preset === "hosted-personal") {
        expect(routing).toContain("personalspace");
        expect(routing).not.toContain("lazurio organization list");
        expect(routing).toContain(
          locale === "cs" ? "pracovním Environmentu" : "work Environment",
        );
      } else {
        expect(routing).toContain("lazurio organization list --json");
        expect(routing).toContain("AGENTS.md");
      }
    }
});
