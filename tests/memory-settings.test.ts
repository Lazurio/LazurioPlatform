import { expect, test } from "bun:test";
import {
  fitView,
  forcesOf,
  layoutOf,
  tick,
} from "../src/launchpad/memory-layout";
import {
  defaultMemorySettings,
  loadMemorySettings,
  matchMemoryQuery,
  memoryGroupOf,
  parseMemoryQuery,
  parseMemorySettings,
  saveMemorySettings,
  shownGraph,
} from "../src/launchpad/memory-settings";
import { memoryTypeLabel } from "../src/launchpad/memory-view";
import { messages } from "../src/launchpad/messages";

// Apps → Brain's graph settings (plan LZD-0033 R11c): the wireframe's
// Obsidian controls over GBrain's pages. Synthetic memories only.

const nodes = [
  { id: "people/bob", title: "Bob", type: "person", born: 0 },
  { id: "people/alena", title: "Alena", type: "person", born: 1 },
  { id: "companies/example", title: "Example", type: "company", born: 2 },
  { id: "projects/novy-web", title: "Nový web", type: "project", born: 3 },
  { id: "concepts/kava", title: "Káva bez mléka", type: "concept", born: 4 },
  { id: "ideas/widget", title: "Widget počasí", type: "note", born: 5 },
];
const links = [
  { source: "people/bob", target: "companies/example" },
  { source: "people/alena", target: "companies/example" },
  { source: "projects/novy-web", target: "people/bob" },
  { source: "projects/novy-web", target: "people/alena" },
];

test("queries: path, file, type, words, quotes, not and OR, without diacritics", () => {
  const match = (query: string) =>
    nodes
      .filter((node) => matchMemoryQuery(parseMemoryQuery(query), node))
      .map((node) => node.id);
  expect(match("")).toHaveLength(nodes.length);
  expect(match("path:people")).toEqual(["people/bob", "people/alena"]);
  expect(match("file:novy")).toEqual(["projects/novy-web"]);
  expect(match("type:Company")).toEqual(["companies/example"]);
  expect(match("kava")).toEqual(["concepts/kava"]);
  expect(match('"bez mléka"')).toEqual(["concepts/kava"]);
  expect(match("path:people -alena")).toEqual(["people/bob"]);
  expect(match("type:company OR path:ideas")).toEqual([
    "companies/example",
    "ideas/widget",
  ]);
  // GBrain's listing has no tags or content: such terms match nothing.
  expect(match("tag:#idea")).toEqual([]);
});

test("the first matching group colours a memory; the defaults are the wireframe's", () => {
  const groups = defaultMemorySettings.groups;
  expect(groups.map((group) => group.color)).toEqual([
    "green",
    "orange",
    "orchid",
  ]);
  const of = (id: string) =>
    memoryGroupOf(
      groups,
      nodes.find((node) => node.id === id) as (typeof nodes)[0],
    );
  expect(of("people/bob")).toBe(0);
  expect(of("companies/example")).toBe(1);
  expect(of("ideas/widget")).toBe(2);
  expect(of("concepts/kava")).toBe(-1);
  expect(
    memoryGroupOf(
      [{ query: "  ", color: "ink" }],
      nodes[0] as (typeof nodes)[0],
    ),
  ).toBe(-1);
});

test("what shows: the search, lone memories, the local graph and the animation", () => {
  const settings = defaultMemorySettings;
  expect(shownGraph(nodes, links, settings, null).ids).toHaveLength(6);
  const noOrphans = shownGraph(
    nodes,
    links,
    { ...settings, filters: { ...settings.filters, orphans: false } },
    null,
  );
  expect(noOrphans.ids).toEqual([
    "people/bob",
    "people/alena",
    "companies/example",
    "projects/novy-web",
  ]);
  const searched = shownGraph(
    nodes,
    links,
    { ...settings, filters: { search: "path:people", orphans: true } },
    null,
  );
  expect(searched.ids).toEqual(["people/bob", "people/alena"]);
  expect(searched.links).toEqual([]);
  // Local graph of Bob: depth 1 both ways, then 2, then outgoing only.
  expect(shownGraph(nodes, links, settings, "people/bob").ids).toEqual([
    "people/bob",
    "companies/example",
    "projects/novy-web",
  ]);
  expect(
    shownGraph(
      nodes,
      links,
      { ...settings, local: { ...settings.local, depth: 2 } },
      "people/bob",
    ).ids,
  ).toEqual([
    "people/bob",
    "people/alena",
    "companies/example",
    "projects/novy-web",
  ]);
  expect(
    shownGraph(
      nodes,
      links,
      { ...settings, local: { depth: 3, incoming: false, outgoing: true } },
      "people/bob",
    ).ids,
  ).toEqual(["people/bob", "companies/example"]);
  // A local graph keeps its centre and lone memories off its rule, and
  // applies the search (the wireframe: every other filter still holds).
  expect(
    shownGraph(
      nodes,
      links,
      { ...settings, filters: { search: "kava", orphans: false } },
      "people/bob",
    ).ids,
  ).toEqual(["people/bob"]);
  expect(
    shownGraph(
      nodes,
      links,
      { ...settings, filters: { search: "path:companies", orphans: true } },
      "people/bob",
    ).ids,
  ).toEqual(["people/bob", "companies/example"]);
  // Animovat: only memories born before the step.
  expect(shownGraph(nodes, links, settings, null, 2).ids).toEqual([
    "people/bob",
    "people/alena",
  ]);
  // An unknown centre shows the whole graph.
  expect(shownGraph(nodes, links, settings, "gone").ids).toHaveLength(6);
});

test("settings are kept in the browser and anything odd falls back to the default", () => {
  const kept = new Map<string, string>();
  const storage = {
    getItem: (key: string) => kept.get(key) ?? null,
    setItem: (key: string, value: string) => void kept.set(key, value),
  };
  expect(loadMemorySettings(storage)).toEqual(defaultMemorySettings);
  const changed = {
    ...defaultMemorySettings,
    display: { ...defaultMemorySettings.display, arrows: true, nodeSize: 2 },
  };
  saveMemorySettings(storage, changed);
  expect(loadMemorySettings(storage)).toEqual(changed);
  expect(loadMemorySettings(null)).toEqual(defaultMemorySettings);
  const throwing = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
  };
  expect(loadMemorySettings(throwing)).toEqual(defaultMemorySettings);
  expect(() => saveMemorySettings(throwing, changed)).not.toThrow();
  kept.set("lazurio.memory.graph.v1", "not json");
  expect(loadMemorySettings(storage)).toEqual(defaultMemorySettings);
  const odd = parseMemorySettings({
    filters: { search: 7, orphans: "yes" },
    groups: [
      { query: "path:x", color: "purple" },
      { query: "path:y", color: "mint" },
    ],
    display: { textFade: 99, nodeSize: -1 },
    forces: { distance: 10_000 },
    local: { depth: 2.6 },
  });
  expect(odd.filters).toEqual(defaultMemorySettings.filters);
  expect(odd.groups).toEqual([{ query: "path:y", color: "mint" }]);
  expect(odd.display.textFade).toBe(3);
  expect(odd.display.nodeSize).toBe(0.1);
  expect(odd.forces.distance).toBe(500);
  expect(odd.local.depth).toBe(3);
});

test("the sliders' forces move the layout; the view frames the centre of mass", () => {
  const ids = nodes.map((node) => node.id);
  const spread = (distance: number) => {
    const laid = layoutOf(ids, links);
    const forces = forcesOf({ ...defaultMemorySettings.forces, distance });
    let alpha = 1;
    for (let step = 0; step < 300; step += 1)
      alpha = tick(laid.nodes, laid.links, alpha, forces);
    const [a, b] = laid.nodes as [
      (typeof laid.nodes)[0],
      (typeof laid.nodes)[0],
    ];
    const c = laid.nodes[2] as (typeof laid.nodes)[0];
    return Math.hypot(a.x - c.x, a.y - c.y) + Math.hypot(b.x - c.x, b.y - c.y);
  };
  expect(spread(500)).toBeGreaterThan(spread(30));
  // One lone memory far out does not pull the frame off the cluster.
  const cluster = [
    { x: 100, y: 0 },
    { x: 110, y: 10 },
    { x: 90, y: -10 },
    { x: 105, y: 5 },
    { x: -200, y: 0 },
  ];
  const view = fitView(cluster, 800, 600);
  const cx = cluster.reduce((sum, node) => sum + node.x, 0) / cluster.length;
  expect(view.x).toBeCloseTo(400 - cx * view.k);
  for (const node of cluster) {
    const x = node.x * view.k + view.x;
    expect(x).toBeGreaterThan(0);
    expect(x).toBeLessThan(800);
  }
});

test("known page types read in the page's language; others as GBrain wrote them", () => {
  const cs = messages("cs", "personal");
  const en = messages("en", "personal");
  expect(memoryTypeLabel("person", cs)).toBe("Osoba");
  expect(memoryTypeLabel("Company", cs)).toBe("Společnost");
  expect(memoryTypeLabel("concept", en)).toBe("Concept");
  expect(memoryTypeLabel("recipe", cs)).toBe("recipe");
});
