// The part of Markdown Buddy's answers use, read into a small tree the page
// turns into DOM nodes (never HTML): paragraphs with their line breaks,
// headings shown as a strong line, lists, fenced code, inline code, bold,
// italics and links. A link is kept only for http, https and mailto; any
// other target stays text. Pure.

export type Inline =
  | Readonly<{ kind: "text"; text: string }>
  | Readonly<{ kind: "strong"; children: readonly Inline[] }>
  | Readonly<{ kind: "em"; children: readonly Inline[] }>
  | Readonly<{ kind: "code"; text: string }>
  | Readonly<{ kind: "link"; href: string; children: readonly Inline[] }>;

export type Block =
  | Readonly<{ kind: "paragraph"; lines: readonly (readonly Inline[])[] }>
  | Readonly<{ kind: "heading"; inline: readonly Inline[] }>
  | Readonly<{
      kind: "list";
      ordered: boolean;
      items: readonly (readonly Inline[])[];
    }>
  | Readonly<{ kind: "code"; text: string }>;

/** The address a link may lead to, or null. */
export function safeHref(target: string): string | null {
  if (!/^(?:https?:\/\/|mailto:)/i.test(target)) return null;
  try {
    const url = new URL(target);
    return ["http:", "https:", "mailto:"].includes(url.protocol)
      ? url.href
      : null;
  } catch {
    return null;
  }
}

const bareUrl = /https?:\/\/[^\s<>"]+/y;

export function readInline(text: string): Inline[] {
  const out: Inline[] = [];
  let plain = "";
  const flush = () => {
    if (plain !== "") out.push({ kind: "text", text: plain });
    plain = "";
  };
  let index = 0;
  while (index < text.length) {
    const rest = text.slice(index);
    const code = /^`([^`\n]+)`/.exec(rest);
    if (code) {
      flush();
      out.push({ kind: "code", text: code[1] as string });
      index += code[0].length;
      continue;
    }
    const link = /^\[([^\]\n]+)\]\(([^)\s]+)\)/.exec(rest);
    if (link) {
      const href = safeHref(link[2] as string);
      flush();
      if (href === null) out.push(...readInline(link[1] as string));
      else
        out.push({
          kind: "link",
          href,
          children: readInline(link[1] as string),
        });
      index += link[0].length;
      continue;
    }
    const strong = /^(\*\*|__)(?=\S)([^\n]*?\S)\1/.exec(rest);
    if (strong) {
      flush();
      out.push({ kind: "strong", children: readInline(strong[2] as string) });
      index += strong[0].length;
      continue;
    }
    const before = index === 0 ? "" : (text[index - 1] as string);
    const em = /^([*_])(?=\S)([^\n*_]*?\S)\1(?![\p{L}\p{N}])/u.exec(rest);
    if (em && !/[\p{L}\p{N}]/u.test(before)) {
      flush();
      out.push({ kind: "em", children: readInline(em[2] as string) });
      index += em[0].length;
      continue;
    }
    bareUrl.lastIndex = index;
    const url = bareUrl.exec(text);
    if (url && !/[\p{L}\p{N}]/u.test(before)) {
      // A sentence's last mark is not part of the address.
      const address = url[0].replace(/[.,;:!?)]+$/, "");
      const href = safeHref(address);
      if (href !== null) {
        flush();
        out.push({
          kind: "link",
          href,
          children: [{ kind: "text", text: address }],
        });
        index += address.length;
        continue;
      }
    }
    plain += text[index];
    index++;
  }
  flush();
  return out;
}

const listItem = /^\s{0,3}([-*•]|\d{1,3}[.)])\s+(.*)$/;

export function readMarkdown(source: string): Block[] {
  const blocks: Block[] = [];
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  const close = () => {
    if (paragraph.length > 0)
      blocks.push({ kind: "paragraph", lines: paragraph.map(readInline) });
    paragraph = [];
    if (list !== null)
      blocks.push({
        kind: "list",
        ordered: list.ordered,
        items: list.items.map(readInline),
      });
    list = null;
  };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] as string;
    if (/^\s{0,3}```/.test(line)) {
      close();
      const code: string[] = [];
      index++;
      while (
        index < lines.length &&
        !/^\s{0,3}```/.test(lines[index] as string)
      )
        code.push(lines[index++] as string);
      blocks.push({ kind: "code", text: code.join("\n") });
      continue;
    }
    if (line.trim() === "") {
      close();
      continue;
    }
    const heading = /^\s{0,3}#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      close();
      blocks.push({
        kind: "heading",
        inline: readInline(heading[1] as string),
      });
      continue;
    }
    const item = listItem.exec(line);
    if (item) {
      const ordered = /\d/.test(item[1] as string);
      if (paragraph.length > 0 || (list !== null && list.ordered !== ordered))
        close();
      list ??= { ordered, items: [] };
      list.items.push(item[2] as string);
      continue;
    }
    if (list !== null) close();
    paragraph.push(line);
  }
  close();
  return blocks;
}
