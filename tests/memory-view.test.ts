import { expect, test } from "bun:test";
import {
  findNodes,
  fitView,
  layoutForces,
  layoutOf,
  radiusOf,
  tick,
} from "../src/launchpad/memory-layout";
import {
  linkSlug,
  markdownBlocks,
  markdownRuns,
  memoryCount,
  memoryGroup,
  memoryListed,
  memoryRetries,
  memoryStateLine,
  parseMemoryMap,
  parseMemoryPage,
} from "../src/launchpad/memory-view";
import { messages } from "../src/launchpad/messages";

const cs = messages("cs", "personal");
const en = messages("en", "personal");

test("Brain is listed only on a Personal Environment known not to be public", () => {
  expect(memoryListed("personal", false)).toBe(true);
  expect(memoryListed("personal", true)).toBe(false);
  expect(memoryListed("personal", null)).toBe(false);
  for (const kind of ["work", "team", "automated", "workstation"] as const)
    expect(memoryListed(kind, false)).toBe(false);
  expect(memoryListed(null, false)).toBe(false);
});

test("the map's answer is read defensively; every state has its sentence", () => {
  expect(parseMemoryMap(null)).toEqual({ state: "failed" });
  expect(parseMemoryMap({ error: "memory-absent" })).toEqual({
    state: "absent",
  });
  expect(parseMemoryMap({ kind: "memory", state: "weird" })).toEqual({
    state: "failed",
  });
  expect(parseMemoryMap({ kind: "memory", state: "ready", nodes: [] })).toEqual(
    { state: "empty" },
  );
  expect(
    parseMemoryMap({
      kind: "memory",
      state: "ready",
      nodes: [{ id: "a", title: "A", type: "person" }, { id: "" }, { id: "b" }],
      links: [
        { source: "a", target: "b" },
        { source: "a", target: "gone" },
      ],
      truncated: true,
    }),
  ).toEqual({
    state: "ready",
    nodes: [
      { id: "a", title: "A", type: "person" },
      { id: "b", title: "b", type: "" },
    ],
    links: [{ source: "a", target: "b" }],
    truncated: true,
  });
  for (const state of [
    "empty",
    "absent",
    "no-access",
    "unreachable",
    "failed",
  ] as const) {
    expect(memoryStateLine(state, cs).length).toBeGreaterThan(10);
    expect(memoryStateLine(state, en).length).toBeGreaterThan(10);
  }
  expect(memoryRetries("absent")).toBe(false);
  expect(memoryRetries("unreachable")).toBe(true);
  expect(memoryRetries("empty")).toBe(true);
});

test("a page's answer keeps only what it can read", () => {
  expect(parseMemoryPage({ kind: "memory-page", state: "missing" })).toEqual({
    state: "missing",
  });
  const page = parseMemoryPage({
    kind: "memory-page",
    state: "ready",
    id: "people/bob",
    title: "Bob",
    type: "person",
    tags: ["a", 1],
    updated: "2026-11-17T11:00:00Z",
    body: "# Bob",
    facts: [{ text: "Fakt", kind: "fact", since: null }, { text: "" }],
    links: ["x", null],
    backlinks: [],
  });
  expect(page).toMatchObject({
    state: "ready",
    tags: ["a"],
    facts: [{ text: "Fakt", kind: "fact", since: null }],
    links: ["x"],
  });
});

test("counts follow each language's plural", () => {
  expect(memoryCount(1, 1, cs, "cs")).toBe("1 vzpomínka · 1 spojnice");
  expect(memoryCount(3, 4, cs, "cs")).toBe("3 vzpomínky · 4 spojnice");
  expect(memoryCount(5, 0, cs, "cs")).toBe("5 vzpomínek · 0 spojnic");
  expect(memoryCount(1234, 2, cs, "cs")).toBe(
    `${new Intl.NumberFormat("cs").format(1234)} vzpomínek · 2 spojnice`,
  );
  expect(memoryCount(1, 2, en, "en")).toBe("1 memory · 2 links");
});

test("groups colour people, companies and ideas, as the wireframe's defaults", () => {
  expect(memoryGroup("people/bob", "note")).toBe("person");
  expect(memoryGroup("x", "Person")).toBe("person");
  expect(memoryGroup("companies/example", "")).toBe("company");
  expect(memoryGroup("ideas/x", "")).toBe("idea");
  expect(memoryGroup("concepts/x", "concept")).toBeNull();
});

test("a Markdown link of a page resolves to a slug of the memory", () => {
  expect(linkSlug("people/bob", "../companies/example.md")).toBe(
    "companies/example",
  );
  expect(linkSlug("people/bob", "alena.md")).toBe("people/alena");
  expect(linkSlug("people/bob", "./alena.md#Práce")).toBe("people/alena");
  expect(linkSlug("people/bob", "/projects/novy%20web.md")).toBe(
    "projects/novy web",
  );
  expect(linkSlug("people/bob", "https://example.com")).toBeNull();
  expect(linkSlug("people/bob", "mailto:x@example.com")).toBeNull();
  expect(linkSlug("people/bob", "#nadpis")).toBeNull();
});

test("Markdown blocks and runs: only text, never markup", () => {
  expect(
    markdownBlocks(
      "# Bob\n\nPrvní\nřádek.\n\n- a\n- b\n  dál\n\n1. jedna\n\n> citát\n\n```\n<b>kód</b>\n```\n<!-- x -->",
    ),
  ).toEqual([
    { kind: "heading", level: 1, text: "Bob" },
    { kind: "paragraph", text: "První řádek." },
    { kind: "list", ordered: false, items: ["a", "b dál"] },
    { kind: "list", ordered: true, items: ["jedna"] },
    { kind: "quote", text: "citát" },
    { kind: "code", text: "<b>kód</b>" },
  ]);
  expect(
    markdownRuns(
      "Vede [Example](../companies/example.md), **tučně**, *kurzíva*, `kód`, [[people/alena|Alena]] a [web](https://example.com) <img src=x>",
      "people/bob",
    ),
  ).toEqual([
    { kind: "text", text: "Vede " },
    { kind: "page", text: "Example", slug: "companies/example" },
    { kind: "text", text: ", " },
    { kind: "strong", text: "tučně" },
    { kind: "text", text: ", " },
    { kind: "em", text: "kurzíva" },
    { kind: "text", text: ", " },
    { kind: "code", text: "kód" },
    { kind: "text", text: ", " },
    { kind: "page", text: "Alena", slug: "people/alena" },
    { kind: "text", text: " a " },
    { kind: "external", text: "web", href: "https://example.com" },
    { kind: "text", text: " <img src=x>" },
  ]);
  // A link that is no http(s) address and no page stays its text.
  expect(markdownRuns("[x](javascript:alert(1))", "a")).toEqual([
    { kind: "text", text: "x" },
    { kind: "text", text: ")" },
  ]);
});

test("the layout: d3's spiral, degrees, a settling simulation, a dragged dot held", () => {
  const ids = ["a", "b", "c", "d"];
  const { nodes, links } = layoutOf(ids, [
    { source: "a", target: "b" },
    { source: "a", target: "c" },
    { source: "a", target: "a" },
    { source: "a", target: "gone" },
  ]);
  expect(links).toHaveLength(2);
  expect(nodes.map((node) => node.degree)).toEqual([2, 1, 1, 0]);
  // The same memory opens in the same shape.
  expect(layoutOf(ids, []).nodes.map((node) => [node.x, node.y])).toEqual(
    layoutOf(ids, []).nodes.map((node) => [node.x, node.y]),
  );
  let alpha = 1;
  for (let step = 0; step < 300; step += 1) alpha = tick(nodes, links, alpha);
  expect(alpha).toBeLessThan(layoutForces.alphaMin * 2);
  for (const node of nodes) {
    expect(Number.isFinite(node.x) && Number.isFinite(node.y)).toBe(true);
  }
  const [a, b] = nodes as [(typeof nodes)[0], (typeof nodes)[0]];
  const distance = Math.hypot(a.x - b.x, a.y - b.y);
  expect(distance).toBeGreaterThan(20);
  expect(distance).toBeLessThan(400);
  // Linked dots end nearer than the unlinked one.
  const d = nodes[3] as (typeof nodes)[0];
  expect(Math.hypot(a.x - d.x, a.y - d.y)).toBeGreaterThan(distance * 0.8);
  a.fx = 500;
  a.fy = -500;
  tick(nodes, links, 0.5);
  expect([a.x, a.y]).toEqual([500, -500]);
  expect(radiusOf({ degree: 0 })).toBeLessThan(radiusOf({ degree: 9 }));
});

test("a large map settles in time and stays finite", () => {
  const ids = Array.from({ length: 1500 }, (_, index) => `n${index}`);
  const pairs = ids.slice(1).map((id, index) => ({
    source: id,
    target: `n${Math.floor(index / 3)}`,
  }));
  const { nodes, links } = layoutOf(ids, pairs);
  const started = performance.now();
  let alpha = 1;
  for (let step = 0; step < 120; step += 1) alpha = tick(nodes, links, alpha);
  expect(performance.now() - started).toBeLessThan(15_000);
  expect(nodes.every((node) => Number.isFinite(node.x + node.y))).toBe(true);
});

test("the view frames the map; find matches words without case or diacritics", () => {
  const view = fitView(
    [
      { x: -100, y: -50 },
      { x: 100, y: 50 },
    ],
    800,
    600,
  );
  expect(view.k).toBe(1.1);
  expect(view.x).toBe(400);
  expect(view.y).toBe(300);
  const nodes = [
    { id: "concepts/ranni-prehled", title: "Ranní přehled" },
    { id: "projects/prehled-skladu", title: "Přehled skladu" },
    { id: "people/bob", title: "Bob" },
  ];
  expect(findNodes(nodes, "prehled").map((node) => node.id)).toEqual([
    "projects/prehled-skladu",
    "concepts/ranni-prehled",
  ]);
  expect(findNodes(nodes, "RANNÍ přeh").map((node) => node.id)).toEqual([
    "concepts/ranni-prehled",
  ]);
  expect(findNodes(nodes, "people").map((node) => node.id)).toEqual([
    "people/bob",
  ]);
  expect(findNodes(nodes, "  ")).toEqual([]);
});
