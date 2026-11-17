import type { ShellEnvironmentKind } from "../shell/contract";
import type { MessageKey } from "./messages";

// Apps → Brain (plan LZD-0033 R11b): what the page draws from the server's
// answers, pure. memory-panel.ts turns it into elements; every server value
// is drawn as text.

type Copy = Readonly<Record<MessageKey, string>>;

export type MemoryMapModel =
  | Readonly<{
      state: "ready";
      nodes: readonly Readonly<{
        id: string;
        title: string;
        type: string;
      }>[];
      links: readonly Readonly<{ source: string; target: string }>[];
      truncated: boolean;
    }>
  | Readonly<{
      state: "empty" | "absent" | "no-access" | "unreachable" | "failed";
    }>;

export type MemoryPageModel =
  | Readonly<{
      state: "ready";
      id: string;
      title: string;
      type: string;
      tags: readonly string[];
      updated: string | null;
      body: string;
      facts: readonly Readonly<{
        text: string;
        kind: string;
        since: string | null;
      }>[];
      links: readonly string[];
      backlinks: readonly string[];
    }>
  | Readonly<{
      state: "missing" | "absent" | "no-access" | "unreachable" | "failed";
    }>;

/** Whether the Apps column lists Brain: only on a Personal Environment
 * that is not public (a public one has no person's memory), and not while
 * the kind or the entry is not known. The server's routes answer by the
 * same rule (server.ts). */
export const memoryListed = (
  kind: ShellEnvironmentKind | null,
  publicEnvironment: boolean | null,
): boolean => kind === "personal" && publicEnvironment === false;

const faults = ["absent", "no-access", "unreachable", "failed"] as const;
const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
const str = (value: unknown): string =>
  typeof value === "string" ? value : "";

/** `GET /api/memory` as the page draws it; anything it cannot read is a
 * failure, never a crash. */
export function parseMemoryMap(value: unknown): MemoryMapModel {
  const input =
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : {};
  // Not on this Environment (`404 memory-absent`): nothing to show.
  if (input.error === "memory-absent") return { state: "absent" };
  if (input.kind !== "memory") return { state: "failed" };
  const state = input.state;
  if (state === "empty" || (faults as readonly unknown[]).includes(state))
    return { state: state as Exclude<MemoryMapModel["state"], "ready"> };
  if (state !== "ready" || !Array.isArray(input.nodes))
    return { state: "failed" };
  const nodes = input.nodes.flatMap((node) => {
    const item = node as Record<string, unknown> | null;
    const id = str(item?.id);
    return id === ""
      ? []
      : [{ id, title: str(item?.title) || id, type: str(item?.type) }];
  });
  const ids = new Set(nodes.map((node) => node.id));
  const links = (Array.isArray(input.links) ? input.links : []).flatMap(
    (link) => {
      const item = link as Record<string, unknown> | null;
      const source = str(item?.source);
      const target = str(item?.target);
      return ids.has(source) && ids.has(target) ? [{ source, target }] : [];
    },
  );
  if (nodes.length === 0) return { state: "empty" };
  return { state: "ready", nodes, links, truncated: input.truncated === true };
}

/** `GET /api/memory/page`. */
export function parseMemoryPage(value: unknown): MemoryPageModel {
  const input =
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : {};
  if (input.kind !== "memory-page") return { state: "failed" };
  const state = input.state;
  if (state === "missing" || (faults as readonly unknown[]).includes(state))
    return { state: state as Exclude<MemoryPageModel["state"], "ready"> };
  if (state !== "ready" || str(input.id) === "") return { state: "failed" };
  return {
    state: "ready",
    id: str(input.id),
    title: str(input.title) || str(input.id),
    type: str(input.type),
    tags: strings(input.tags),
    updated: str(input.updated) || null,
    body: str(input.body),
    facts: (Array.isArray(input.facts) ? input.facts : []).flatMap((fact) => {
      const item = fact as Record<string, unknown> | null;
      const text = str(item?.text);
      return text === ""
        ? []
        : [{ text, kind: str(item?.kind), since: str(item?.since) || null }];
    }),
    links: strings(input.links),
    backlinks: strings(input.backlinks),
  };
}

/** The colour group of a memory, as the wireframe's default groups colour
 * the graph (`path:people` green, `path:companies` orange, `tag:#idea`
 * orchid), read from GBrain's slug folders and page types; anything else
 * is a plain grey dot. */
export type MemoryGroup = "person" | "company" | "idea" | null;
export function memoryGroup(id: string, type: string): MemoryGroup {
  const folder = id.split("/")[0]?.toLowerCase() ?? "";
  const kind = type.toLowerCase();
  if (folder === "people" || kind === "person") return "person";
  if (folder === "companies" || kind === "company") return "company";
  if (folder === "ideas" || kind === "idea") return "idea";
  return null;
}

/** The sentence of a map that has nothing to draw. */
export function memoryStateLine(
  state: Exclude<MemoryMapModel["state"], "ready">,
  copy: Copy,
): string {
  switch (state) {
    case "empty":
      return copy.memoryEmpty;
    case "absent":
      return copy.memoryAbsent;
    case "no-access":
      return copy.memoryNoAccess;
    case "unreachable":
      return copy.memoryUnreachable;
    default:
      return copy.memoryFailed;
  }
}

/** Whether "Načíst znovu" can help: a fault that may pass, or a memory
 * that may fill. */
export const memoryRetries = (
  state: Exclude<MemoryMapModel["state"], "ready">,
): boolean => state !== "absent";

const fill = (template: string, values: Readonly<Record<string, string>>) =>
  template.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? "");

/** "12 vzpomínek · 30 spojnic", in the page's language and its plural. */
export function memoryCount(
  nodes: number,
  links: number,
  copy: Copy,
  locale: "cs" | "en",
): string {
  const rules = new Intl.PluralRules(locale);
  const number = new Intl.NumberFormat(locale);
  const form = (
    count: number,
    one: MessageKey,
    few: MessageKey,
    other: MessageKey,
  ) => {
    const rule = rules.select(count);
    return fill(copy[rule === "one" ? one : rule === "few" ? few : other], {
      count: number.format(count),
    });
  };
  return `${form(nodes, "memoryNodesOne", "memoryNodesFew", "memoryNodesOther")} · ${form(
    links,
    "memoryLinksOne",
    "memoryLinksFew",
    "memoryLinksOther",
  )}`;
}

export const memoryTruncatedLine = (
  count: number,
  copy: Copy,
  locale: "cs" | "en",
) =>
  fill(copy.memoryTruncated, {
    count: new Intl.NumberFormat(locale).format(count),
  });

/** A date as the page's language writes it; null for none or one it
 * cannot read. */
export function memoryDate(
  value: string | null,
  locale: "cs" | "en",
): string | null {
  if (value === null) return null;
  const time = Date.parse(value);
  if (Number.isNaN(time)) return null;
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(time);
}

/** The slug a Markdown link of page `from` points at: relative to its
 * folder, without `.md` and its heading, decoded; null for an external or
 * empty one. */
export function linkSlug(from: string, href: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("#")) return null;
  let path = href.split("#")[0] ?? "";
  try {
    path = decodeURIComponent(path);
  } catch {}
  if (path === "") return null;
  const parts = path.startsWith("/") ? [] : from.split("/").slice(0, -1);
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  const slug = parts.join("/").replace(/\.md$/i, "");
  return slug === "" ? null : slug;
}

/** A Markdown block as the page draws it. Only what memory pages use:
 * headings, paragraphs, lists, quotes and code; anything else is a
 * paragraph of its text. */
export type MarkdownBlock =
  | Readonly<{ kind: "heading"; level: number; text: string }>
  | Readonly<{ kind: "paragraph"; text: string }>
  | Readonly<{ kind: "list"; ordered: boolean; items: readonly string[] }>
  | Readonly<{ kind: "quote"; text: string }>
  | Readonly<{ kind: "code"; text: string }>;

export function markdownBlocks(markdown: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let quote: string[] = [];
  const flush = () => {
    if (paragraph.length > 0)
      blocks.push({ kind: "paragraph", text: paragraph.join(" ") });
    if (list !== null) blocks.push({ kind: "list", ...list });
    if (quote.length > 0) blocks.push({ kind: "quote", text: quote.join(" ") });
    paragraph = [];
    list = null;
    quote = [];
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (/^\s*```/.test(line)) {
      flush();
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^\s*```/.test(lines[index] ?? "")) {
        code.push(lines[index] ?? "");
        index += 1;
      }
      blocks.push({ kind: "code", text: code.join("\n") });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      blocks.push({
        kind: "heading",
        level: heading[1]?.length ?? 1,
        text: (heading[2] ?? "").replace(/\s+#+\s*$/, ""),
      });
      continue;
    }
    if (/^\s*$/.test(line) || /^\s*<!--.*-->\s*$/.test(line)) {
      flush();
      continue;
    }
    const item = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/.exec(line);
    if (item) {
      const ordered = item[2] !== undefined;
      if (
        paragraph.length > 0 ||
        quote.length > 0 ||
        (list !== null && list.ordered !== ordered)
      )
        flush();
      list ??= { ordered, items: [] };
      list.items.push(item[3] ?? "");
      continue;
    }
    const quoted = /^\s*>\s?(.*)$/.exec(line);
    if (quoted) {
      if (paragraph.length > 0 || list !== null) flush();
      quote.push(quoted[1] ?? "");
      continue;
    }
    if (list !== null && /^\s{2,}\S/.test(line)) {
      const items = list.items;
      items[items.length - 1] = `${items[items.length - 1]} ${line.trim()}`;
      continue;
    }
    if (list !== null || quote.length > 0) flush();
    paragraph.push(line.trim());
  }
  flush();
  return blocks;
}

/** An inline run of a block: plain text, emphasis, code, or a link (to a
 * page of the memory by its slug, or out to an http(s) address). */
export type MarkdownRun =
  | Readonly<{ kind: "text"; text: string }>
  | Readonly<{ kind: "strong" | "em" | "code"; text: string }>
  | Readonly<{ kind: "page"; text: string; slug: string }>
  | Readonly<{ kind: "external"; text: string; href: string }>;

export function markdownRuns(text: string, from: string): MarkdownRun[] {
  const runs: MarkdownRun[] = [];
  const pattern =
    /`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\s][^*]*)\*|\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]|!?\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > last)
      runs.push({ kind: "text", text: text.slice(last, index) });
    last = index + match[0].length;
    if (match[1] !== undefined) runs.push({ kind: "code", text: match[1] });
    else if (match[2] !== undefined || match[3] !== undefined)
      runs.push({ kind: "strong", text: match[2] ?? match[3] ?? "" });
    else if (match[4] !== undefined) runs.push({ kind: "em", text: match[4] });
    else if (match[5] !== undefined) {
      const target = match[5].trim();
      runs.push({
        kind: "page",
        text: (match[6] ?? target).trim(),
        slug: target.replace(/\.md$/i, ""),
      });
    } else {
      const label = match[7] ?? "";
      const href = match[8] ?? "";
      if (/^https?:\/\//i.test(href))
        runs.push({ kind: "external", text: label || href, href });
      else {
        const slug = linkSlug(from, href);
        runs.push(
          slug === null
            ? { kind: "text", text: label }
            : { kind: "page", text: label || slug, slug },
        );
      }
    }
  }
  if (last < text.length) runs.push({ kind: "text", text: text.slice(last) });
  return runs;
}
