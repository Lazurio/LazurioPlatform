import { expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { stoneFilePaths } from "../src/shell/stone-files";
import {
  appBaseTitle,
  semanticAppIconKey,
  stoneAccents,
  stoneFiles,
  stoneKeys,
  stoneOf,
} from "../src/shell/stones";

// Decision F36: a module's Lazurio stone by a generic semantic key only, a
// port of the root Launchpad's `semanticAppIconKey` (its keys and token
// order), never by an Organization or a module's name.

test("a declared icon that is a known key wins over every token", () => {
  expect(
    semanticAppIconKey({ module: "invoices", id: "invoices", icon: "palette" }),
  ).toBe("palette");
  // An unknown declared icon falls back to the tokens.
  expect(semanticAppIconKey({ module: "invoices", icon: "rocket" })).toBe(
    "invoice",
  );
});

test("the fallback reads module id, app id and tags, in the root's order", () => {
  const key = (module: string, id = "", tags: string[] = []) =>
    semanticAppIconKey({ module, id, tags });
  expect(key("mission-control")).toBe("control");
  expect(key("knowledgebase")).toBe("book");
  expect(key("deals")).toBe("deal");
  expect(key("website")).toBe("website");
  expect(key("design-system")).toBe("palette");
  expect(key("crm")).toBe("deal");
  expect(key("notes", "app", ["docs"])).toBe("book");
  // The first matching group wins: datasheet before deal, pricebook before
  // deal, warehouse before product, deal before control.
  expect(key("sales-datasheets")).toBe("datasheet");
  expect(key("pricing-offers")).toBe("pricebook");
  expect(key("stock-catalog")).toBe("warehouse");
  expect(key("sales-automation")).toBe("deal");
  expect(key("infra")).toBe("system");
  expect(key("orders")).toBe("app");
  expect(semanticAppIconKey({})).toBe("app");
});

test("every key has a vendored stone and a colour; keys that share a drawing share its colour", async () => {
  const vendored = (
    await readdir(
      join(import.meta.dir, "..", "src", "shell", "vendor", "stones"),
    )
  ).sort();
  expect(Object.keys(stoneFilePaths).sort()).toEqual(vendored);
  expect(vendored).toHaveLength(13);
  for (const key of stoneKeys) {
    const file = stoneFiles[key];
    expect(vendored).toContain(file);
    expect(stoneAccents[file]).toStartWith("var(--lz-");
    expect(stoneOf(key).src).toBe(`/.lazurio/stones/${file}`);
  }
  expect(stoneOf("dashboard").accent).toBe(stoneOf("datasheet").accent);
});

test("a title loses its trailing version", () => {
  expect(appBaseTitle("Mission Control v3")).toBe("Mission Control");
  expect(appBaseTitle("Deals V12")).toBe("Deals");
  expect(appBaseTitle("v2 Planner")).toBe("v2 Planner");
  expect(appBaseTitle("v3")).toBe("v3");
});
