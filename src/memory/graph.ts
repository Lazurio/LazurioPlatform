import {
  type GbrainReader,
  type MemoryHandover,
  MemoryUnavailable,
  ToolRefused,
} from "./gbrain-reader";

// The map of the person's memory (plan LZD-0033 R11b) from GBrain's read
// tools: every page `list_pages` lists, and between them the links
// `get_links` returns for each. GBrain has no export of the whole graph
// (checked with the fork's update to v0.60.733.0 on 2026-11-17), so the
// map is put together page by page, a few at a time, and kept a short while.
// A link to a page the map does not have (not created yet, private, beyond
// the cap) is left out, as Obsidian's "Existing files only" does by default.

/** One memory on the map: a GBrain page. */
export type MemoryNode = Readonly<{
  /** The page's slug, unique within the map (one source per map). */
  id: string;
  title: string;
  /** GBrain's page type (person, company, project, concept, …). */
  type: string;
  updated: string | null;
  /** When it came into the memory among the map's pages: 0 the oldest
   * (Zobrazení → Animovat replays the memory growing in this order).
   * GBrain's listing carries no creation time, so this is its rank in
   * `list_pages` sorted `created_desc`. */
  born: number;
}>;

/** A link between two pages, one per direction. */
export type MemoryLink = Readonly<{ source: string; target: string }>;

export type MemoryGraph = Readonly<{
  nodes: readonly MemoryNode[];
  links: readonly MemoryLink[];
  /** The memory has more pages than the map reads (`memoryPageCap`). */
  truncated: boolean;
}>;

/** One fact GBrain keeps about the page's entity (its `## Facts` fence). */
export type MemoryFact = Readonly<{
  text: string;
  kind: string;
  since: string | null;
}>;

/** A page opened from the map. */
export type MemoryPage = Readonly<{
  id: string;
  title: string;
  type: string;
  tags: readonly string[];
  updated: string | null;
  /** The page's Markdown without its facts fence. */
  body: string;
  facts: readonly MemoryFact[];
  /** Slugs this page links to and that link here. */
  links: readonly string[];
  backlinks: readonly string[];
}>;

/** At most this many pages on one map; a bigger memory is cut and says so. */
export const memoryPageCap = 2000;
const pageLimit = 100;
const linkLimit = 500;
/** How many `get_links` calls run at once on the loopback. */
const concurrency = 6;

/** A slug as GBrain takes it: printable, no control characters. */
export function isMemorySlug(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 512 &&
    ![...value].some((char) => {
      const code = char.charCodeAt(0);
      return code < 0x20 || code === 0x7f;
    }) &&
    !value.startsWith("/")
  );
}

const text = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : fallback;
const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** Rows of a list answer; anything else is an answer this release cannot
 * read. */
function rows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new MemoryUnavailable("failed");
  return value.flatMap((row) => {
    const item = record(row);
    return item === null ? [] : [item];
  });
}

/** Whether `_meta.pagination` says more rows follow. */
function truncatedOf(meta: unknown): boolean {
  return record(record(meta)?.pagination)?.truncated === true;
}

async function pagesOf(reader: GbrainReader, handover: MemoryHandover) {
  const nodes: MemoryNode[] = [];
  const seen = new Set<string>();
  let truncated = false;
  for (let offset = 0; ; offset += pageLimit) {
    const answer = await reader.call(handover, "list_pages", {
      sort: "created_desc",
      limit: pageLimit,
      ...(offset > 0 ? { offset } : {}),
    });
    const list = rows(answer.value);
    for (const row of list) {
      const slug = text(row.slug);
      if (!isMemorySlug(slug) || seen.has(slug) || row.deleted_at) continue;
      seen.add(slug);
      nodes.push({
        id: slug,
        title: text(row.title).trim() || slug,
        type: text(row.type).trim() || "note",
        updated: text(row.updated_at_iso) || text(row.updated_at) || null,
        born: 0,
      });
    }
    if (!truncatedOf(answer.meta) || list.length === 0) break;
    if (nodes.length >= memoryPageCap) {
      truncated = true;
      break;
    }
  }
  const kept = nodes.slice(0, memoryPageCap);
  // Newest first in the listing: the last row is the oldest.
  return {
    nodes: kept.map((node, index) => ({
      ...node,
      born: kept.length - 1 - index,
    })),
    truncated,
  };
}

/** Every link of one page (`get_links`, following its cursor). */
async function linksOf(
  reader: GbrainReader,
  handover: MemoryHandover,
  slug: string,
  tool: "get_links" | "get_backlinks" = "get_links",
): Promise<string[]> {
  const out: string[] = [];
  let cursor: string | undefined;
  for (let round = 0; round < 20; round += 1) {
    let answer: Awaited<ReturnType<GbrainReader["call"]>>;
    try {
      answer = await reader.call(handover, tool, {
        slug,
        limit: linkLimit,
        ...(cursor === undefined ? {} : { cursor }),
      });
    } catch (error) {
      // A page that went away meanwhile has no links; any other refusal is
      // a fault of the reading, never a quietly shorter map.
      if (isPageNotFound(error)) return out;
      throw asFault(error);
    }
    const list = rows(answer.value);
    for (const row of list)
      out.push(text(tool === "get_links" ? row.to_slug : row.from_slug));
    const last = list.at(-1);
    const next = last === undefined ? "" : text(last.next_cursor);
    if (last?.truncated !== true || next === "") break;
    cursor = next;
  }
  return out.filter(isMemorySlug);
}

/** GBrain's answer that no page has the slug (or none this key may read:
 * a private page answers the same, by GBrain's rule). */
const isPageNotFound = (error: unknown): boolean =>
  error instanceof ToolRefused && error.code === "page_not_found";

/** Any other refusal of a tool is a failed reading. */
const asFault = (error: unknown): unknown =>
  error instanceof ToolRefused ? new MemoryUnavailable("failed") : error;

/** Runs `work` over `items`, `limit` at a time, in order of the results. */
async function pool<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await work(items[index] as T);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, lane),
  );
  return results;
}

/** The whole map, read now. */
export async function readMemoryGraph(
  reader: GbrainReader,
): Promise<MemoryGraph> {
  const handover = await reader.connection();
  const { nodes, truncated } = await pagesOf(reader, handover);
  const ids = new Set(nodes.map((node) => node.id));
  const targets = await pool(nodes, concurrency, (node) =>
    linksOf(reader, handover, node.id),
  );
  const links: MemoryLink[] = [];
  const pairs = new Set<string>();
  nodes.forEach((node, index) => {
    for (const target of targets[index] ?? []) {
      if (target === node.id || !ids.has(target)) continue;
      const key = `${node.id}\n${target}`;
      if (pairs.has(key)) continue;
      pairs.add(key);
      links.push({ source: node.id, target });
    }
  });
  return { nodes, links, truncated };
}

/** One page for the panel, or null where GBrain has none by that slug (or
 * none this key may read). */
export async function readMemoryPage(
  reader: GbrainReader,
  slug: string,
): Promise<MemoryPage | null> {
  const handover = await reader.connection();
  let answer: Awaited<ReturnType<GbrainReader["call"]>>;
  try {
    answer = await reader.call(handover, "get_page", { slug });
  } catch (error) {
    if (isPageNotFound(error)) return null;
    throw asFault(error);
  }
  const page = record(answer.value);
  if (page === null) throw new MemoryUnavailable("failed");
  const [links, backlinks] = await Promise.all([
    linksOf(reader, handover, slug, "get_links"),
    linksOf(reader, handover, slug, "get_backlinks"),
  ]);
  const { body, facts } = splitFacts(text(page.compiled_truth));
  const tags = Array.isArray(page.tags)
    ? page.tags.filter((tag): tag is string => typeof tag === "string")
    : [];
  return {
    id: text(page.slug, slug),
    title: text(page.title).trim() || slug,
    type: text(page.type).trim() || "note",
    tags,
    updated: text(page.updated_at) || null,
    body,
    facts,
    links: [...new Set(links)].filter((item) => item !== slug),
    backlinks: [...new Set(backlinks)].filter((item) => item !== slug),
  };
}

const factsBegin = "<!--- gbrain:facts:begin -->";
const factsEnd = "<!--- gbrain:facts:end -->";

/** The page's Markdown without its facts fence (and the `## Facts` heading
 * right before it), and the fence's live facts: not struck out, not
 * private, not past their `valid_until`. The fence's cells escape `|` as
 * `\|` and a newline as `<br>` (GBrain's `escapeFenceCell`). */
export function splitFacts(
  markdown: string,
  now: Date = new Date(),
): Readonly<{ body: string; facts: MemoryFact[] }> {
  const begin = markdown.indexOf(factsBegin);
  const end = markdown.indexOf(factsEnd, begin + 1);
  if (begin < 0 || end < 0) return { body: markdown.trim(), facts: [] };
  const before = markdown
    .slice(0, begin)
    .replace(/(^|\n)#{1,6}\s*Facts\s*\n\s*$/i, "$1");
  const after = markdown.slice(end + factsEnd.length);
  const facts: MemoryFact[] = [];
  for (const line of markdown
    .slice(begin + factsBegin.length, end)
    .split("\n")) {
    const cells = fenceCells(line);
    if (cells === null || cells.length < 10) continue;
    const [number, claim, kind, , visibility, , validFrom, validUntil] = cells;
    if (!/^\d+$/.test(number ?? "")) continue;
    if (visibility === "private") continue;
    if (/^~~[\s\S]+~~$/.test(claim ?? "")) continue;
    if (validUntil && Date.parse(validUntil) < now.getTime()) continue;
    const fact = (claim ?? "").replace(/<br>/g, "\n").trim();
    if (fact === "") continue;
    facts.push({
      text: fact,
      kind: kind || "fact",
      since: validFrom || null,
    });
  }
  return { body: `${before.trimEnd()}\n${after}`.trim(), facts };
}

function fenceCells(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.includes("|", 1)) return null;
  const inner = trimmed.replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let cell = "";
  for (let i = 0; i < inner.length; i += 1) {
    const char = inner[i];
    if (char === "\\" && inner[i + 1] === "|") {
      cell += "|";
      i += 1;
    } else if (char === "|") {
      cells.push(cell.trim());
      cell = "";
    } else cell += char;
  }
  cells.push(cell.trim());
  return cells;
}
