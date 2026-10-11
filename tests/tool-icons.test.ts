import { expect, test } from "bun:test";
import { toolCatalog } from "../src/tools/catalog";
import { toolIcons } from "../src/tools/icons";

test("every tool logo belongs to a curated tool and is a bundled, inert drawing", () => {
  const names = new Set(toolCatalog.map((tool) => tool.name));
  for (const [name, icon] of Object.entries(toolIcons)) {
    expect(names.has(name)).toBe(true);
    if ("svg" in icon) {
      // A vendor's own mark: a plain SVG, nothing that runs or loads.
      expect(icon.svg.startsWith("<svg")).toBe(true);
      expect(icon.svg).not.toMatch(/<script|href|on[a-z]+=/i);
      expect(icon.source).toMatch(/^https:\/\//);
      continue;
    }
    expect(icon.path).toMatch(/^[MmLlHhVvCcSsQqTtAaZz0-9.,\s-]+$/);
    expect(icon.hex).toMatch(/^[0-9A-F]{6}$/);
    expect(icon.source).toMatch(/^simple-icons@\d+\.\d+\.\d+\/[a-z0-9]+$/);
  }
  // The tools a person meets first carry their logo.
  for (const name of ["gh", "codex", "composio", "bitwarden", "wacli"])
    expect(toolIcons[name]).toBeDefined();
});
