import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { presetNames } from "../src/folder/presets";
import {
  type PageFrame,
  pageRoute,
  routeFrame,
  vaultPath,
} from "../src/launchpad/routes";
import { vaultInApps } from "../src/launchpad/vault-page-view";

// Trezor is a page of the Apps column (Matěj 2026-10-17 in the wireframe,
// prototypes-lazurio affc81e; F53's addendum of 2026-10-18): the column is
// Všechny moduly, Soubory, Integrace and Trezor, Settings no longer list it,
// and its page has the header of Files, its title alone. Not on this
// computer, and a public Environment's stylesheet hides it as before
// (decision F55). The page's markup as the browser gets it, read with the
// same HTMLRewriter as the page's corners; how it looks is checked in a
// browser, not here (root decision 0178).

type Element = Readonly<{
  tag: string;
  attributes: ReadonlyMap<string, string>;
  parent: Element | null;
}>;

const page = await readFile(
  join(import.meta.dir, "..", "src", "launchpad", "index.html"),
  "utf8",
);

/** Every element of the page in document order, each with its parent. */
async function parse(source: string): Promise<Element[]> {
  const elements: Element[] = [];
  const open: Element[] = [];
  await new HTMLRewriter()
    .on("*", {
      element(element) {
        const node: Element = {
          tag: element.tagName,
          attributes: new Map(element.attributes),
          parent: open.at(-1) ?? null,
        };
        elements.push(node);
        if (element.canHaveContent && !element.selfClosing) {
          open.push(node);
          element.onEndTag(() => {
            open.pop();
          });
        }
      },
    })
    .transform(new Response(source))
    .text();
  return elements;
}

const elements = await parse(page);

function byId(id: string): Element {
  const found = elements.filter((node) => node.attributes.get("id") === id);
  expect([id, found.length]).toEqual([id, 1]);
  return found[0] as Element;
}
const classes = (node: Element) =>
  (node.attributes.get("class") ?? "").split(/\s+/).filter(Boolean);
function inside(node: Element, container: Element): boolean {
  for (let parent = node.parent; parent !== null; parent = parent.parent)
    if (parent === container) return true;
  return false;
}
const within = (container: Element) =>
  elements.filter((node) => inside(node, container));
const views = (node: Element) =>
  (node.attributes.get("data-view") ?? "").split(/\s+/).filter(Boolean);
/** The `data-message` of the element's text, where it has one. */
const message = (node: Element) =>
  within(node)
    .find((child) => child.attributes.has("data-message"))
    ?.attributes.get("data-message");
const icon = (node: Element) =>
  within(node)
    .find((child) => child.tag === "use")
    ?.attributes.get("href");

/** The page's own stylesheet (not the fonts'), its rules as written. */
const stylesheet = [...page.matchAll(/<style>([\s\S]*?)<\/style>/g)]
  .map((match) => match[1])
  .join("\n");
/** The selectors of the one rule whose selectors include `selector`. */
function ruleWith(selector: string): readonly string[] {
  const rules = [...stylesheet.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map((match) => ({
      selectors: (match[1] ?? "")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean),
      body: (match[2] ?? "").trim(),
    }))
    .filter((rule) => rule.selectors.includes(selector));
  expect([selector, rules.length]).toEqual([selector, 1]);
  return rules[0]?.selectors ?? [];
}

test("the Apps column is Všechny moduly, Soubory, Integrace and Trezor, in this order, each a link of the page", () => {
  const top = elements.find(
    (node) =>
      node.tag === "ul" &&
      classes(node).includes("column-top") &&
      inside(node, byId("catalog-nav")),
  ) as Element;
  expect(top).toBeDefined();
  const links = within(top).filter((node) => node.tag === "a");
  expect(
    links.map((link) => [
      link.attributes.get("id"),
      link.attributes.get("href"),
      message(link),
    ]),
  ).toEqual([
    ["catalog-home", "/", "appsAll"],
    ["files-open", "/files", "filesTitle"],
    ["integrations-open", "/integrations", "integrationsTitle"],
    ["vault-open", "/vault", "vaultPageTitle"],
  ]);
  // Each moves within the page, and Trezor's opens its page in Apps.
  for (const link of links)
    expect(link.attributes.has("data-route")).toBe(true);
  const vault = byId("vault-open");
  expect(icon(vault)).toBe("#i-lock");
  expect(pageRoute(vault.attributes.get("href") ?? "")).toEqual({
    view: "vault",
  });
  expect(vaultPath).toBe("/vault");
  // Its own item, which ui.ts hides on this computer (`vaultInApps`) and
  // the public rule by the link it holds.
  const item = byId("vault-nav");
  expect(item.tag).toBe("li");
  expect(vault.parent).toBe(item);
  expect(item.attributes.has("hidden")).toBe(false);
});

test("beside Trezor the column stays the Apps column, the Marketplace at its foot", () => {
  const apps = elements.find((node) =>
    classes(node).includes("column-apps"),
  ) as Element;
  expect(views(apps)).toContain("vault");
  expect(views(apps)).toContain("integrations");
  const settings = elements.find((node) =>
    classes(node).includes("column-settings"),
  ) as Element;
  expect(views(settings)).toEqual(["settings"]);
  const market = byId("marketplace-open").parent?.parent as Element;
  expect(market.tag).toBe("ul");
  expect(views(market)).toEqual(views(apps));
});

test("Settings no longer list Trezor, and nothing on the page leads to its old address", () => {
  const nav = byId("settings-nav");
  const links = within(nav).filter((node) => node.tag === "a");
  expect(links.map((link) => link.attributes.get("data-section"))).toEqual([
    "start",
    "general",
    "communication",
    "machine",
    "tools",
    "ssh",
    "recovery",
  ]);
  for (const link of links)
    expect(link.attributes.get("href") ?? "").not.toContain("vault");
  // No link anywhere in the page goes to `/settings/vault` (its routes still
  // answer: F54 as amended, tests/launchpad-routes.test.ts).
  for (const node of elements)
    expect(node.attributes.get("href") ?? "").not.toStartWith(
      "/settings/vault",
    );
  // Začínáme's vault row opens Trezor in Apps.
  const open = within(byId("start-vault-group")).find(
    (node) => node.tag === "a",
  ) as Element;
  expect(open.attributes.get("href")).toBe("/vault");
  expect(open.attributes.has("data-route")).toBe(true);
});

test("Trezor's page is a view of its own with Files' header: its title alone, no Settings crumb, its refresh as the header's action", () => {
  const view = byId("view-vault");
  expect(view.tag).toBe("main");
  expect(views(view)).toEqual(["vault"]);
  const section = byId("section-vault");
  expect(section.parent).toBe(view);
  // Not a Settings section: none of Settings' rules shows or hides it.
  expect(section.attributes.has("data-section")).toBe(false);
  expect(inside(section, byId("view-settings"))).toBe(false);
  expect(section.attributes.get("aria-labelledby")).toBe("page-heading");
  // What the panels draw into stays in it: the agents' requests, one
  // request's page, the vault and how it works without one.
  for (const id of [
    "vault-requests",
    "vault-request",
    "vault-page-group",
    "vault-explainer",
    "vault-connect",
    "vault-bitwarden",
  ])
    expect([id, inside(byId(id), section)]).toEqual([id, true]);
  // The header of Settings and Files stands over Trezor too, with the
  // page's heading and without the crumb that leads to Settings.
  const header = elements.find(
    (node) => node.tag === "header" && classes(node).includes("topbar"),
  ) as Element;
  expect(views(header)).toEqual(["settings", "files", "vault"]);
  expect(views(byId("crumb-parent"))).toEqual(["settings"]);
  expect(inside(byId("page-heading"), header)).toBe(true);
  const refresh = byId("vault-page-refresh");
  expect(inside(refresh, header)).toBe(true);
  expect(refresh.attributes.get("data-section-action")).toBe("vault");
});

test("the first paint shows exactly the frame of the route, Trezor's too, and its refresh only there", () => {
  const frames: readonly PageFrame[] = [
    "catalog",
    "files",
    "integrations",
    "vault",
    "marketplace",
    "settings",
  ];
  const hiding = ruleWith(
    'html[data-frame="vault"] [data-view]:not([data-view~="vault"])',
  );
  for (const frame of frames)
    expect(hiding).toContain(
      `html[data-frame="${frame}"] [data-view]:not([data-view~="${frame}"])`,
    );
  // Every frame a view names is one the routes give.
  for (const node of elements)
    for (const name of views(node))
      expect([name, frames.includes(name as PageFrame)]).toEqual([name, true]);
  expect(routeFrame(pageRoute("/vault"))).toBe("vault");
  // Its refresh belongs to its frame, as Files' does.
  expect(hiding).toContain(
    'html:not([data-frame="vault"]) [data-section-action="vault"]',
  );
  expect(hiding).not.toContain(
    'html:not([data-section="vault"]) [data-section-action="vault"]',
  );
});

test("a public Environment's stylesheet hides Trezor in the Apps column as it hid it in Settings (decision F55)", () => {
  const selectors = ruleWith(
    'html[data-audience="public"] li:has(> #integrations-open)',
  );
  expect(selectors).toEqual([
    'html[data-audience="public"] li:has(> #integrations-open)',
    'html[data-audience="public"] li:has(> #vault-open)',
    'html[data-audience="public"] #settings-nav li:has(> a[data-section="tools"])',
    'html[data-audience="public"] #start-refresh',
  ]);
  // The rule's item holds the link it names, right under it.
  expect(byId("vault-open").parent?.tag).toBe("li");
});

test("the Apps column lists Trezor everywhere but on this computer", () => {
  expect(vaultInApps("local")).toBe(false);
  for (const preset of presetNames.filter((name) => name !== "local"))
    expect([preset, vaultInApps(preset)]).toEqual([preset, true]);
  // Not known yet (the profile still being read): listed, so that a Remote
  // Environment never shows it late.
  expect(vaultInApps(null)).toBe(true);
});
