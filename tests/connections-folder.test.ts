import { expect } from "bun:test";
import { presetProfile } from "../src/folder/presets";
import { renderOutputs } from "../src/folder/preview";
import { mcpServerPrompt } from "../src/tools/catalog";
import { contract } from "./fixtures/contract";
import { journeys } from "./fixtures/journeys";
import { bindings } from "./fixtures/machine-bindings";

// What the generated Folder tells agents about connected apps and MCP
// servers (decision F42, proposed, docs/connected-apps.md section 8). RED BY
// DESIGN until the text slices land (section 15).

const organizationOrigin = "https://launchpad.workspace.example.lazurio.io";
const withEntry = [
  [
    "hosted-personal",
    bindings.personalEntry,
    "https://launchpad.example.lazurio.io",
  ],
  [
    "hosted-organization-personal",
    bindings.organizationEntry,
    organizationOrigin,
  ],
  ["hosted-organization-team", bindings.teamEntry, organizationOrigin],
  ["hosted-organization-steward", bindings.automatedEntry, organizationOrigin],
] as const;

// Today's instruction to run `composio link` and send its link: retired.
const rawLink = {
  cs: [
    "Odkaz, který příkaz vrátí, pošli Operátorovi",
    "který vrátí odkaz, a ten otevře Operátor",
  ],
  en: [
    "Send the link the command returns to the Operator",
    "which returns a link for the Operator to open",
  ],
};
// F18's rule that MCP servers stay out of the Folder: retired by 0162's
// addendum of 2026-10-08, point 8.
const outsideTheFolder = {
  cs: [
    "Do Folderu se MCP servery nikdy nezapisují",
    "do Folderu se MCP servery nezapisují",
    "MCP server do Lazurio Folderu nezapisuj",
  ],
  en: [
    "MCP servers are never recorded in the Folder",
    "MCP servers are never written into the Folder",
    "Do not record the MCP server in the Lazurio Folder",
  ],
};

contract(
  "agents send the Launchpad's connections link for a missing app, never a raw Composio link",
  () => {
    for (const [preset, machine, origin] of withEntry)
      for (const locale of ["cs", "en"] as const) {
        const outputs = renderOutputs({
          preset,
          machine,
          profile: presetProfile(preset, "linux", { locale }),
          tools: ["composio"],
        });
        for (const path of [
          "AGENTS.md",
          "manual/this-machine.md",
          "manual/working-here.md",
        ] as const)
          expect(outputs[path]).toContain(`${origin}/connections/`);
        for (const text of Object.values(outputs))
          for (const retired of rawLink[locale])
            expect(text).not.toContain(retired);
      }
    // Without an entry no browser reaches the Launchpad: the page by its
    // name, and no link.
    for (const journey of journeys.filter((entry) => entry.machine === null))
      for (const locale of ["cs", "en"] as const) {
        const outputs = renderOutputs({
          preset: journey.preset,
          machine: null,
          profile: presetProfile(journey.preset, journey.os, { locale }),
          tools: ["composio"],
        });
        expect(outputs["manual/working-here.md"]).toContain(
          locale === "cs" ? "Připojené aplikace" : "Connected apps",
        );
        for (const text of Object.values(outputs)) {
          expect(text).not.toContain("/connections/");
          for (const retired of rawLink[locale])
            expect(text).not.toContain(retired);
        }
      }
  },
);

contract(
  "MCP servers belong to the Environment: agents add one only into its list, with lazurio mcp add",
  () => {
    for (const journey of journeys)
      for (const locale of ["cs", "en"] as const) {
        const outputs = renderOutputs({
          preset: journey.preset,
          machine: journey.machine,
          profile: presetProfile(journey.preset, journey.os, { locale }),
        });
        expect(outputs["AGENTS.md"]).toContain("`lazurio mcp add`");
        for (const text of Object.values(outputs))
          for (const retired of outsideTheFolder[locale])
            expect(text).not.toContain(retired);
      }
    for (const locale of ["cs", "en"] as const) {
      const prompt = mcpServerPrompt(locale);
      expect(prompt).toContain("lazurio mcp add");
      // Never into one harness's own configuration.
      expect(prompt).not.toContain("`claude mcp add`");
      expect(prompt).not.toContain("~/.codex/config.toml");
      for (const retired of outsideTheFolder[locale])
        expect(prompt).not.toContain(retired);
    }
  },
);
