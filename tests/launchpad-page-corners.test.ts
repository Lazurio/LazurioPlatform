import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

// The controls of the pages' heads in the page's two top corners (Matěj
// 2026-10-12, evening; the wireframe's apps-corner). One Browser toggle,
// which browser-panel.ts collects once by its class as it starts, shows
// where the panel is offered and presses while the panel is open, stands in
// the top right corner after the Apps home's Guide. The corner is the page's,
// left of the panel, outside every view and head, so the toggle is drawn
// wherever the page is, stays in view beside the open panel, and the focus
// can always come back to it. The column's toggle stands in the band on top
// of the column with the Lazurio lockup (Matěj 2026-10-17), one at the page's
// top left while the column is hidden, and the panel strip's while the page
// steps aside. Page heads hold only their titles and the "?" right after
// them (decision F56, tests/launchpad-guide.test.ts): Integrace's "Jak to
// funguje" moved into the guide's card (its addendum of 2026-10-18), and
// Integrace keep their search and refresh with the tabs. How it looks and
// moves, and the focus, are checked in a browser, not here (root decision
// 0178).

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

const classes = (node: Element) =>
  (node.attributes.get("class") ?? "").split(/\s+/).filter(Boolean);
const withClass = (name: string) =>
  elements.filter((node) => classes(node).includes(name));
function byId(id: string): Element {
  const found = elements.filter((node) => node.attributes.get("id") === id);
  expect(found).toHaveLength(1);
  return found[0] as Element;
}
function only(name: string): Element {
  const found = withClass(name);
  expect(found).toHaveLength(1);
  return found[0] as Element;
}
function inside(node: Element, container: Element): boolean {
  for (let parent = node.parent; parent !== null; parent = parent.parent)
    if (parent === container) return true;
  return false;
}
const childrenOf = (container: Element) =>
  elements.filter((node) => node.parent === container);
/** Whether `container` holds an element with this `data-message`. */
const says = (container: Element, key: string) =>
  elements.some(
    (node) =>
      inside(node, container) && node.attributes.get("data-message") === key,
  );

test("the page's two top corners come first in the page, outside every view, so they are the same on every route", () => {
  const top = only("page-top");
  expect(childrenOf(byId("page"))[0]).toBe(top);
  expect(childrenOf(top).map(classes)).toEqual([
    ["page-corner", "page-corner-start"],
    ["page-corner", "page-corner-end"],
  ]);
  for (let node: Element | null = top; node !== null; node = node.parent)
    expect(node.attributes.has("data-view")).toBe(false);
  // The page's, beside the panel and never in it: the open panel never
  // covers the corner, and with the page stepped aside it goes with it.
  const panel = byId("browser-panel");
  expect(panel.parent).toBe(byId("page").parent);
  expect(inside(top, panel)).toBe(false);
});

test("one Browser toggle, in the page's top right corner, as browser-panel.ts finds, shows and labels it", () => {
  const toggle = only("browser-toggle");
  expect(toggle.tag).toBe("button");
  expect(inside(toggle, byId("page-corner"))).toBe(true);
  expect(toggle.attributes.get("aria-controls")).toBe("browser-panel");
  expect(toggle.attributes.get("aria-expanded")).toBe("false");
  // Hidden until the entry says the panel is offered (`render`).
  expect(toggle.attributes.has("hidden")).toBe(true);
  expect(says(toggle, "browserToggle")).toBe(true);
  // Never inside a view, a head or anything else a script hides.
  for (let node = toggle.parent; node !== null; node = node.parent) {
    expect(node.attributes.has("data-view")).toBe(false);
    expect(node.attributes.has("hidden")).toBe(false);
    expect(["header", "main", "nav"]).not.toContain(node.tag);
  }
});

test("the corner holds the Guide on the Apps home and Integrace's Composio link, then the toggle; Jak to funguje is the guide's card's now", () => {
  const corner = byId("page-corner");
  expect(
    childrenOf(corner).map(
      (node) => node.attributes.get("id") ?? classes(node).join(" "),
    ),
  ).toEqual(["catalog-guide", "integrations-composio", "ghost browser-toggle"]);
  expect(
    elements.some((node) => node.attributes.get("id") === "integrations-help"),
  ).toBe(false);
  // "Aplikace v Composiu" beside Jak to funguje (decision F42, addendum of
  // 2026-10-14): Integrace only, a new tab of the person's browser, hidden
  // until the reading carries Composio's Apps (integrations-panel.ts render).
  const composio = byId("integrations-composio");
  expect(composio.tag).toBe("a");
  expect(composio.attributes.get("data-view")).toBe("integrations");
  expect(composio.attributes.get("target")).toBe("_blank");
  expect(composio.attributes.get("rel")).toBe("noopener noreferrer");
  expect(composio.attributes.has("hidden")).toBe(true);
  expect(composio.attributes.has("href")).toBe(false);
  expect(says(composio, "integrationsComposioApps")).toBe(true);
  for (const [id, frame, word] of [
    ["catalog-guide", "catalog", "appsGuide"],
  ] as const) {
    const link = byId(id);
    expect(link.tag).toBe("a");
    expect(link.attributes.get("data-view")).toBe(frame);
    expect(link.attributes.get("target")).toBe("_blank");
    expect(link.attributes.get("rel")).toBe("noopener noreferrer");
    expect(says(link, word)).toBe(true);
  }
});

test("page heads hold only their titles and their '?': no toggle, help link, search or refresh in the head of any page", () => {
  const heads = [
    byId("catalog-head"),
    only("market-head"),
    only("integrations-head"),
    only("topbar"),
  ];
  const controls = elements.filter(
    (node) =>
      classes(node).includes("column-toggle") ||
      classes(node).includes("browser-toggle") ||
      ["catalog-guide", "integrations-search", "integrations-refresh"].includes(
        node.attributes.get("id") ?? "",
      ),
  );
  expect(controls).toHaveLength(7);
  for (const head of heads)
    for (const control of controls) expect(inside(control, head)).toBe(false);
});

test("the column starts with its band, the toggle and the Lazurio lockup, above the shell's column head; one toggle at the page's top left while it is hidden", () => {
  const toggles = withClass("column-toggle");
  expect(toggles).toHaveLength(3);
  for (const toggle of toggles) {
    expect(toggle.tag).toBe("button");
    expect(toggle.attributes.get("aria-controls")).toBe("sidebar");
    expect(toggle.attributes.get("aria-expanded")).toBe("true");
  }
  // The band on top of the column (Matěj 2026-10-17), then the shell's
  // column head right under it: the head offers no slot and takes nothing of
  // the host, so the band is the page's own, beside it in the column. It is
  // the same on every route: inside no view.
  const band = only("column-band");
  const head = byId("column-head");
  expect(head.tag).toBe("lazurio-column-head");
  expect(childrenOf(byId("sidebar")).slice(0, 2)).toEqual([band, head]);
  expect(band.attributes.has("data-view")).toBe(false);
  // In it the toggle that hides the column, then the app's name: the design
  // system's approved lockup, the whole vendored file (its bytes are pinned
  // by the vendor README), named for screen readers, never the symbol beside
  // a word (content/brand/logo/logo.md).
  const inBand = childrenOf(band);
  expect(inBand).toHaveLength(2);
  const [toggle, lockup] = inBand as [Element, Element];
  expect(toggles).toContain(toggle);
  expect(lockup.tag).toBe("img");
  expect(classes(lockup)).toEqual(["column-lockup"]);
  expect(lockup.attributes.get("src")).toBe(
    "../shell/vendor/lazurio/lockup-color.svg",
  );
  expect(lockup.attributes.get("alt")).toBe("Lazurio");
  expect(
    elements.filter(
      (node) =>
        node.tag === "img" &&
        (node.attributes.get("src") ?? "").includes("symbol-color"),
    ),
  ).toEqual([]);
  // At the page's top left, while the column is hidden.
  expect(
    toggles.filter((toggle) => inside(toggle, only("page-corner-start"))),
  ).toHaveLength(1);
  // In the panel's strip, while the page also steps aside.
  expect(
    toggles.filter((toggle) => inside(toggle, only("browser-strip"))),
  ).toHaveLength(1);
});

test("Integrace keep their search and Zkontrolovat připojení on the page, with the tabs and outside their navigation", () => {
  const view = byId("view-integrations");
  const bar = only("integrations-bar");
  const tabs = byId("integrations-tabs");
  expect(inside(bar, view)).toBe(true);
  expect(tabs.parent).toBe(bar);
  const search = byId("integrations-search");
  const refresh = byId("integrations-refresh");
  for (const control of [search, refresh]) {
    expect(inside(control, bar)).toBe(true);
    expect(inside(control, tabs)).toBe(false);
  }
  // Their words, for screen readers: the search's label, the refresh's name.
  expect(
    search.parent === null ? false : says(search.parent, "integrationsSearch"),
  ).toBe(true);
  expect(says(refresh, "integrationsRefresh")).toBe(true);
});
