import { expect, test } from "bun:test";
import { presetProfile } from "../src/folder/presets";
import { renderOutputs } from "../src/folder/preview";
import { activatableTools } from "../src/tools/catalog";
import { journeys } from "./fixtures/journeys";
import { bindings } from "./fixtures/machine-bindings";

// The Folder's Integrace (decision F42, root decision 0162 addendum of
// 2026-10-09): agents use an Integration where it is connected, in the order
// tool → Executor → Composio, never connect one themselves, send the card's
// link (or name the page where no browser reaches the Launchpad), add a
// custom MCP server only on instruction and always into Executor, and read
// the live state with `lazurio integrations list --json`. The texts it
// retires never come back.

const allTools = activatableTools()
  .filter((entry) => entry.activation.tier !== "required")
  .map((entry) => entry.name)
  .sort();

/** Every composition: each journey, both languages, with and without every
 * optional tool, and the hosted ones with an entry. */
function compositions() {
  const list: {
    name: string;
    origin: string | null;
    outputs: Record<string, string>;
    locale: "cs" | "en";
  }[] = [];
  const withEntry = [
    {
      preset: "hosted-personal",
      machine: bindings.personalEntry,
      os: "linux",
      origin: "https://launchpad.example.lazurio.io",
    },
    {
      preset: "hosted-organization-personal",
      machine: bindings.organizationEntry,
      os: "linux",
      origin: "https://launchpad.workspace.example.lazurio.io",
    },
  ] as const;
  for (const journey of [
    ...journeys.map((item) => ({ ...item, origin: null })),
    ...withEntry,
  ])
    for (const locale of ["cs", "en"] as const)
      for (const tools of [[], allTools])
        list.push({
          name: `${journey.preset} ${journey.os} ${locale} ${tools.length}`,
          origin: journey.origin,
          locale,
          outputs: renderOutputs({
            preset: journey.preset,
            machine: journey.machine,
            profile: presetProfile(journey.preset, journey.os, { locale }),
            tools,
          }),
        });
  return list;
}

test("AGENTS.md says what an Integrace is, the order, the command and that agents never connect one", () => {
  for (const { name, origin, outputs, locale } of compositions()) {
    const agents = outputs["AGENTS.md"] ?? "";
    const cs = locale === "cs";
    expect([
      name,
      agents.includes(cs ? "## Integrace" : "## Integrations"),
    ]).toEqual([name, true]);
    expect(agents).toContain("`lazurio integrations list --json`");
    expect(agents).toContain(
      cs
        ? "v tomhle pořadí: nástroj aplikace, potom Executor (MCP server `executor` tvého harnessu nebo příkaz `executor`), potom Composio (`composio execute`)."
        : "in this order: the app's tool, then Executor (your harness's MCP server `executor`, or the `executor` command), then Composio (`composio execute`).",
    );
    expect(agents).toContain(
      cs
        ? "Integraci nikdy nepřipojuj sám: přihlášení je souhlas člověka."
        : "Never connect an Integration yourself: the sign-in is the person's consent.",
    );
    expect(agents).toContain(
      cs
        ? "a vždy do Executoru tohohle Environmentu (Apps → Integrace → Vlastní), nikdy jen do svého harnessu"
        : "and always to this Environment's Executor (Apps → Integrations → Custom), never only to your harness",
    );
    // The Integrace section follows the tools.
    const tools = agents.indexOf(cs ? "## Nástroje" : "## Tools");
    const integrations = agents.indexOf(
      cs ? "## Integrace" : "## Integrations",
    );
    expect(tools).toBeGreaterThan(0);
    expect(integrations).toBeGreaterThan(tools);
    for (const text of Object.values(outputs)) {
      if (origin === null) {
        // Without an entry no browser reaches the Launchpad: the page is
        // named, never a link.
        expect(text).not.toContain("/integrations");
      } else {
        expect(agents).toContain(`\`${origin}/integrations/app/<id>\``);
      }
    }
    if (origin === null)
      expect(agents).toContain(
        cs
          ? "Když chybí, řekni mu, ať ji připojí v Launchpadu v Apps → Integrace."
          : "When one is missing, ask them to connect it in the Launchpad under Apps → Integrations.",
      );
  }
});

test("the manual has the Integrace chapter, the page where the Launchpad is reachable and the card's link", () => {
  for (const { name, origin, outputs, locale } of compositions()) {
    const working = outputs["manual/working-here.md"] ?? "";
    const machine = outputs["manual/this-machine.md"] ?? "";
    const cs = locale === "cs";
    expect([
      name,
      working.includes(cs ? "## Integrace" : "## Integrations"),
    ]).toEqual([name, true]);
    expect(working).toContain("`lazurio integrations list --json`");
    expect(working).toContain(
      cs
        ? "**Integraci nepřipojuj sám.**"
        : "**Never connect an Integration yourself.**",
    );
    expect(machine).toContain(
      cs ? "### Integrace a MCP" : "### Integrations and MCP",
    );
    // Where a browser reaches the Launchpad, the routing names the page;
    // the card's link is the section's and the chapter's (`link`).
    if (origin !== null)
      expect(machine).toContain(
        `${cs ? "Integrace" : "Integrations"} \`${origin}/integrations\``,
      );
    expect(working).toContain(
      cs
        ? "pošli mu odkaz na její kartu (`link` v `lazurio integrations list --json`)"
        : "send them the link to its card (`link` in `lazurio integrations list --json`)",
    );
  }
});

test("the retired texts are gone: no raw Composio link, no per-harness MCP setup, no single-broker rule", () => {
  for (const { name, outputs } of compositions())
    for (const [path, text] of Object.entries(outputs)) {
      for (const phrase of [
        "composio link",
        "Send the link the command returns",
        "Odkaz, který příkaz vrátí, pošli Operátorovi",
        "no cloud connector other than Composio",
        "Jiné cloudové konektory než Composio nezřizuj",
        "claude mcp add",
        "~/.codex/config.toml",
        "MCP servers come after the catalog CLIs",
        "MCP servery přicházejí na řadu až po CLI z katalogu",
        "Connect applications such as Outlook, Teams or a calendar through Composio",
        "Aplikace jako Outlook, Teams nebo kalendář napojuj přes Composio",
      ])
        expect([name, path, phrase, text.includes(phrase)]).toEqual([
          name,
          path,
          phrase,
          false,
        ]);
    }
});
