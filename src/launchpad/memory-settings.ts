import { fold } from "./memory-layout";

// Apps → Brain, the graph's settings (plan LZD-0033 R11c): the wireframe's
// Obsidian graph controls (prototypes-lazurio `screens/BuddyMemory.tsx`,
// `docs/buddy-memory-graph.md`) over GBrain's pages: Filtry, Skupiny,
// Zobrazení, Síly and the local graph of an open memory. Pure: the panel
// draws them, and they are kept in the viewer's own browser, since the page
// only reads the memory. What GBrain's listing does not carry stays out:
// tags (`list_pages` has none), attachments and links to pages that do not
// exist (the server leaves them out), so their switches are not offered.

export type MemoryFilters = Readonly<{ search: string; orphans: boolean }>;
export type MemoryColorGroup = Readonly<{ query: string; color: SwatchId }>;
export type MemoryDisplay = Readonly<{
  arrows: boolean;
  textFade: number;
  nodeSize: number;
  linkThickness: number;
}>;
export type MemoryForces = Readonly<{
  center: number;
  repel: number;
  link: number;
  distance: number;
}>;
export type MemoryLocal = Readonly<{
  depth: number;
  incoming: boolean;
  outgoing: boolean;
}>;
export type MemorySettings = Readonly<{
  filters: MemoryFilters;
  groups: readonly MemoryColorGroup[];
  display: MemoryDisplay;
  forces: MemoryForces;
  local: MemoryLocal;
}>;

/** Group colours from the design system, as the wireframe offers them. */
export const swatches = [
  { id: "green", token: "--lz-green-600" },
  { id: "orange", token: "--lz-expressive-orange-figure" },
  { id: "orchid", token: "--lz-expressive-orchid-figure" },
  { id: "blue", token: "--lz-blue-600" },
  { id: "vermilion", token: "--lz-expressive-vermilion-figure" },
  { id: "yellow", token: "--lz-expressive-yellow-figure" },
  { id: "mint", token: "--lz-expressive-mint-figure" },
  { id: "ink", token: "--lz-ink" },
] as const;
export type SwatchId = (typeof swatches)[number]["id"];
const swatchIds: readonly string[] = swatches.map((swatch) => swatch.id);

/** The wireframe's defaults (Obsidian's), its groups read on GBrain's
 * folders and page types: people, companies, ideas. */
export const defaultMemorySettings: MemorySettings = Object.freeze({
  filters: { search: "", orphans: true },
  groups: [
    { query: "path:people", color: "green" },
    { query: "path:companies OR type:company", color: "orange" },
    { query: "path:ideas OR type:idea", color: "orchid" },
  ],
  display: { arrows: false, textFade: 0, nodeSize: 1, linkThickness: 1 },
  forces: { center: 0.52, repel: 10, link: 1, distance: 250 },
  local: { depth: 1, incoming: true, outgoing: true },
});

/** The sliders' ranges, as the wireframe has them. */
export const settingRanges = Object.freeze({
  textFade: { min: -3, max: 3, step: 0.1 },
  nodeSize: { min: 0.1, max: 5, step: 0.1 },
  linkThickness: { min: 0.1, max: 5, step: 0.1 },
  center: { min: 0, max: 1, step: 0.01 },
  repel: { min: 0, max: 20, step: 0.1 },
  link: { min: 0, max: 1, step: 0.01 },
  distance: { min: 30, max: 500, step: 1 },
  depth: { min: 1, max: 3, step: 1 },
});

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const number = (
  value: unknown,
  range: Readonly<{ min: number; max: number }>,
  fallback: number,
): number =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.min(range.max, Math.max(range.min, value))
    : fallback;
const flag = (value: unknown, fallback: boolean): boolean =>
  typeof value === "boolean" ? value : fallback;

/** Settings as a browser kept them: anything unknown or out of range falls
 * back to the default, so an old or edited value never breaks the map. */
export function parseMemorySettings(value: unknown): MemorySettings {
  const input = record(value);
  const d = defaultMemorySettings;
  const filters = record(input.filters);
  const display = record(input.display);
  const forces = record(input.forces);
  const local = record(input.local);
  const r = settingRanges;
  const groups = Array.isArray(input.groups)
    ? input.groups.slice(0, 12).flatMap((group) => {
        const item = record(group);
        return typeof item.query === "string" &&
          item.query.length <= 200 &&
          typeof item.color === "string" &&
          swatchIds.includes(item.color)
          ? [{ query: item.query, color: item.color as SwatchId }]
          : [];
      })
    : d.groups;
  return {
    filters: {
      search:
        typeof filters.search === "string" && filters.search.length <= 200
          ? filters.search
          : d.filters.search,
      orphans: flag(filters.orphans, d.filters.orphans),
    },
    groups,
    display: {
      arrows: flag(display.arrows, d.display.arrows),
      textFade: number(display.textFade, r.textFade, d.display.textFade),
      nodeSize: number(display.nodeSize, r.nodeSize, d.display.nodeSize),
      linkThickness: number(
        display.linkThickness,
        r.linkThickness,
        d.display.linkThickness,
      ),
    },
    forces: {
      center: number(forces.center, r.center, d.forces.center),
      repel: number(forces.repel, r.repel, d.forces.repel),
      link: number(forces.link, r.link, d.forces.link),
      distance: number(forces.distance, r.distance, d.forces.distance),
    },
    local: {
      depth: Math.round(number(local.depth, r.depth, d.local.depth)),
      incoming: flag(local.incoming, d.local.incoming),
      outgoing: flag(local.outgoing, d.local.outgoing),
    },
  };
}

// ---- queries: the part of Obsidian's search syntax the graph uses ----------

export type MemoryQueryTerm = Readonly<{
  op: "path" | "file" | "type" | "text";
  value: string;
  negate: boolean;
}>;
/** OR of AND clauses; empty matches everything. */
export type MemoryQuery = readonly (readonly MemoryQueryTerm[])[];

/** `path:`, `file:`, `type:`, plain words, quotes, `-` for not and `OR`,
 * as in the wireframe (which also has `tag:` and `content:`, for which
 * GBrain's listing carries nothing; they match nothing here). */
export function parseMemoryQuery(input: string): MemoryQuery {
  const tokens = input.match(/-?(?:[a-z]+:)?"[^"]*"|\S+/gi) ?? [];
  const clauses: MemoryQueryTerm[][] = [[]];
  for (const token of tokens) {
    if (token === "OR") {
      clauses.push([]);
      continue;
    }
    const negate = token.startsWith("-") && token.length > 1;
    const body = negate ? token.slice(1) : token;
    const operator = /^([a-z]+):(.*)$/i.exec(body);
    const name = operator?.[1]?.toLowerCase();
    const op: MemoryQueryTerm["op"] | null =
      name === undefined
        ? "text"
        : name === "path" || name === "file" || name === "type"
          ? name
          : null;
    const value = (operator ? (operator[2] ?? "") : body).replace(
      /^"(.*)"$/,
      "$1",
    );
    if (value === "") continue;
    // An operator this page does not know matches nothing, as a term.
    clauses[clauses.length - 1]?.push({
      op: op ?? "path",
      value: op === null ? "\u0000" : fold(value),
      negate,
    });
  }
  return clauses.filter((clause) => clause.length > 0);
}

export type QueryNode = Readonly<{ id: string; title: string; type: string }>;

function matchTerm(term: MemoryQueryTerm, node: QueryNode): boolean {
  const path = fold(node.id);
  const file = fold(node.id.split("/").at(-1) ?? node.id);
  switch (term.op) {
    case "path":
      return path.includes(term.value);
    case "file":
      return file.includes(term.value);
    case "type":
      return fold(node.type) === term.value;
    default:
      return fold(node.title).includes(term.value) || path.includes(term.value);
  }
}

export function matchMemoryQuery(query: MemoryQuery, node: QueryNode): boolean {
  if (query.length === 0) return true;
  return query.some((clause) =>
    clause.every((term) => matchTerm(term, node) !== term.negate),
  );
}

/** The first group whose query matches colours the dot; -1 for none. */
export function memoryGroupOf(
  groups: readonly MemoryColorGroup[],
  node: QueryNode,
): number {
  return groups.findIndex(
    (group) =>
      group.query.trim() !== "" &&
      matchMemoryQuery(parseMemoryQuery(group.query), node),
  );
}

// ---- what the map shows ------------------------------------------------------

export type ShownGraph = Readonly<{
  ids: readonly string[];
  links: readonly Readonly<{ source: string; target: string }>[];
}>;

/** The graph the map shows: the search's memories (or the local graph of
 * `center` to its depth, in the directions chosen), without lone memories
 * where the filter says so (never in the local graph), and while it
 * animates only the memories born before `step`. */
export function shownGraph(
  nodes: readonly (QueryNode & Readonly<{ born?: number }>)[],
  links: readonly Readonly<{ source: string; target: string }>[],
  settings: MemorySettings,
  center: string | null,
  step: number | null = null,
): ShownGraph {
  let ids: Set<string>;
  if (center !== null && nodes.some((node) => node.id === center)) {
    const reach = new Set([center]);
    let frontier = [center];
    for (let depth = 1; depth <= settings.local.depth; depth += 1) {
      const next: string[] = [];
      for (const id of frontier)
        for (const link of links) {
          const other =
            settings.local.outgoing && link.source === id
              ? link.target
              : settings.local.incoming && link.target === id
                ? link.source
                : null;
          if (other !== null && !reach.has(other)) {
            reach.add(other);
            next.push(other);
          }
        }
      frontier = next;
    }
    ids = reach;
  } else {
    const query = parseMemoryQuery(settings.filters.search);
    ids = new Set(
      nodes
        .filter((node) => matchMemoryQuery(query, node))
        .map((node) => node.id),
    );
  }
  if (step !== null)
    for (const node of nodes) if ((node.born ?? 0) >= step) ids.delete(node.id);
  let kept = links.filter(
    (link) => ids.has(link.source) && ids.has(link.target),
  );
  if (center === null && !settings.filters.orphans) {
    const linked = new Set(kept.flatMap((link) => [link.source, link.target]));
    ids = new Set([...ids].filter((id) => linked.has(id)));
    kept = kept.filter((link) => ids.has(link.source) && ids.has(link.target));
  }
  return {
    ids: nodes.map((node) => node.id).filter((id) => ids.has(id)),
    links: kept,
  };
}

const storageKey = "lazurio.memory.graph.v1";

/** The settings this browser kept, or the defaults where it keeps none or
 * cannot (a private window, blocked storage). */
export function loadMemorySettings(
  storage: Pick<Storage, "getItem"> | null,
): MemorySettings {
  try {
    const text = storage?.getItem(storageKey) ?? null;
    return text === null
      ? defaultMemorySettings
      : parseMemorySettings(JSON.parse(text));
  } catch {
    return defaultMemorySettings;
  }
}

export function saveMemorySettings(
  storage: Pick<Storage, "setItem"> | null,
  settings: MemorySettings,
): void {
  try {
    storage?.setItem(storageKey, JSON.stringify(settings));
  } catch {}
}
