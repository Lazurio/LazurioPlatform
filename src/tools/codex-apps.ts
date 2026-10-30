import { randomBytes } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { resolveOnPath } from "./status";

// The apps of the person's ChatGPT account in the operator's Codex ("Aplikace
// z ChatGPT", decision F42's addendum of 2026-10-27). Codex gives its agents
// every app, plugin and connector of the signed-in ChatGPT account as the MCP
// server `codex_apps`, and suggests more to install; where they are not
// allowed, Lazurio turns both off by Codex's own documented switches,
// `[apps._default] enabled = false` and `[features] tool_suggest = false` in
// `$CODEX_HOME/config.toml`, and by nothing else.
//
// Lazurio changes exactly those two keys of the person's configuration, and
// only their lines: every other byte stays. Each line carries a marker
// (`codexAppsMarker`), so where they are allowed again Lazurio removes the
// lines it wrote, and the tables it created, and nothing the person wrote. A
// `false` the person wrote, and Codex's own `features.apps = false`, already
// turn them off and are left as they are. An app the person
// turned on by name (`[apps.<id>] enabled = true`, which Codex prefers to
// the default) is the person's exception: never changed, only reported
// (`exceptions`). A configuration Lazurio cannot edit in place (the key in a
// dotted or inline form, a link, a file that does not parse) is refused and
// reported, never rewritten. Codex reads the file when a chat starts: new
// chats follow it, running ones keep their tools.

/** The comment that marks Lazurio's own line (and the table it created). */
export const codexAppsMarker = "# lazurio: chatgpt-apps";

/** How Codex's configuration has the ChatGPT account's apps:
 * - `on`: nothing turns them off;
 * - `off`: Lazurio's marked line, the person's own `enabled = false`, or
 *   Codex's `features.apps = false` (`by`); `exceptions` are the ids of the
 *   apps the person turned on by name, which Codex keeps on;
 * - with either, `suggestions`: whether Codex suggests plugins and
 *   connectors to install (`features.tool_suggest`);
 * - `unreadable`: the file could not be read or does not parse;
 * - `absent`: Codex is not installed here. */
export type CodexAppsFacts =
  | Readonly<{ state: "on"; suggestions: "on" | "off" }>
  | Readonly<{
      state: "off";
      by: "lazurio" | "person" | "feature";
      exceptions: readonly string[];
      suggestions: "on" | "off";
    }>
  | Readonly<{ state: "unreadable" }>
  | Readonly<{ state: "absent" }>;

/** Why Lazurio left the configuration as it was:
 * - `config-unreadable`: it could not be read or does not parse;
 * - `config-shape`: `apps._default` or `features` is there in a form Lazurio
 *   does not edit in place (dotted keys, an inline table);
 * - `config-not-regular`: `config.toml` is a link or not a file;
 * - `config-changed`: it changed while Lazurio wrote it;
 * - `write-failed`: the new file could not be written. */
export type CodexAppsRefusal =
  | "config-unreadable"
  | "config-shape"
  | "config-not-regular"
  | "config-changed"
  | "write-failed";

export type CodexAppsConverged = Readonly<{
  kind: "unchanged" | "changed" | "refused";
  reason?: CodexAppsRefusal;
  facts: CodexAppsFacts;
}>;

export type CodexAppsInput = Readonly<{
  home: string | undefined;
  path: string | undefined;
  platform: string;
  /** `CODEX_HOME` when the process names an absolute one; nothing else of
   * the environment is read. */
  env: Readonly<Record<string, string | undefined>>;
}>;

/** At most this much of `config.toml` is read. */
const configBytesMax = 1024 * 1024;

/** Codex's home: `CODEX_HOME` when absolute, else `~/.codex`; null where
 * the process names neither. */
export function codexHome(
  input: Pick<CodexAppsInput, "home" | "env">,
): string | null {
  const named = input.env.CODEX_HOME;
  if (named !== undefined && isAbsolute(named)) return named;
  return input.home !== undefined && isAbsolute(input.home)
    ? join(input.home, ".codex")
    : null;
}

/** The input of a process: its PATH, home and `CODEX_HOME`. */
export function codexAppsInputOf(
  env: Readonly<Record<string, string | undefined>>,
  platform: string,
): CodexAppsInput {
  return Object.freeze({
    home: env.HOME,
    path: env.PATH,
    platform,
    env: Object.freeze({ CODEX_HOME: env.CODEX_HOME }),
  });
}

type Table = Record<string, unknown>;
const isTable = (value: unknown): value is Table =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function parseToml(text: string): Table | null {
  try {
    const value: unknown = Bun.TOML.parse(text);
    return isTable(value) ? value : null;
  } catch {
    return null;
  }
}

// ---- The text --------------------------------------------------------------

type Line = Readonly<{ text: string; eol: string }>;

function lines(text: string): Line[] {
  const result: Line[] = [];
  for (const part of text.split(/(?<=\n)/)) {
    if (part === "") continue;
    const eol = part.endsWith("\r\n")
      ? "\r\n"
      : part.endsWith("\n")
        ? "\n"
        : "";
    result.push({ text: part.slice(0, part.length - eol.length), eol });
  }
  return result;
}
const joined = (all: readonly Line[]) =>
  all.map((line) => line.text + line.eol).join("");

/** A table header's key as its segments (`[apps._default]`,
 * `[ apps . "_default" ]`), or null for any other line. An array of tables
 * (`[[…]]`) is a header too: it ends the table before it. */
function headerKey(line: string): readonly string[] | null {
  const match = /^\s*(\[\[?)([^\]]*)(\]\]?)\s*(#.*)?$/.exec(line);
  if (match === null) return null;
  if ((match[1] === "[[") !== (match[3] === "]]")) return null;
  const segments: string[] = [];
  const key = match[2] ?? "";
  const segment = /\s*(?:([A-Za-z0-9_-]+)|"([^"\\]*)"|'([^']*)')\s*(\.|$)/y;
  let at = 0;
  while (at < key.length) {
    segment.lastIndex = at;
    const part = segment.exec(key);
    if (part === null) return match[1] === "[[" ? ["[["] : null;
    segments.push(part[1] ?? part[2] ?? part[3] ?? "");
    at = segment.lastIndex;
    if (part[4] === "") break;
  }
  return match[1] === "[[" ? ["[[", ...segments] : segments;
}

/** One of the two keys Lazurio turns off: a boolean `key` in the table at
 * `table`. */
type Switch = Readonly<{ table: readonly string[]; key: string }>;
/** Every app of the account, the documented default (`codex_apps`). */
const appsSwitch: Switch = { table: ["apps", "_default"], key: "enabled" };
/** Codex's suggestions of plugins and connectors to install, with the
 * `<recommended_plugins>` block of its prompt. */
const suggestionsSwitch: Switch = { table: ["features"], key: "tool_suggest" };

const sameKey = (key: readonly string[] | null, path: readonly string[]) =>
  key !== null &&
  key.length === path.length &&
  key.every((segment, index) => segment === path[index]);

/** Where each line starts a table: a header outside a multi-line string. */
function headers(all: readonly Line[]): (readonly string[] | null)[] {
  let open: '"""' | "'''" | null = null;
  return all.map((line) => {
    if (open !== null) {
      if (line.text.split(open).length % 2 === 0) open = null;
      return null;
    }
    const key = headerKey(line.text);
    if (key !== null) return key;
    for (const quote of ['"""', "'''"] as const)
      if (line.text.split(quote).length % 2 === 0) {
        open = quote;
        break;
      }
    return null;
  });
}

const keyLine = (key: string) =>
  new RegExp(
    `^(\\s*)(?:${key}|"${key}"|'${key}')\\s*=\\s*(true|false)\\s*(#.*)?$`,
  );
// Lazurio's line: its marker last, or with the line it replaced, which the
// lift writes back (`enabled = false # lazurio: chatgpt-apps (was: …)`).
const markedLine = / # lazurio: chatgpt-apps(?: \(was: (.*)\))?\s*$/;
const marked = (text: string) => markedLine.test(text);

/** The table at `path`: its header's line and the lines of its body up to
 * the next header; null where there is none. */
function tableAt(
  all: readonly Line[],
  path: readonly string[],
): Readonly<{ header: number; end: number }> | null {
  const keys = headers(all);
  const header = keys.findIndex((key) => sameKey(key, path));
  if (header < 0) return null;
  let end = header + 1;
  while (end < all.length && keys[end] === null) end += 1;
  return { header, end };
}

function valueAt(parsed: Table, path: readonly string[]): unknown {
  let node: unknown = parsed;
  for (const segment of path) {
    if (!isTable(node) || !Object.hasOwn(node, segment)) return undefined;
    node = node[segment];
  }
  return node;
}

/** The table at `path` of a copy, made where it is not there. */
function tableIn(parsed: Table, path: readonly string[]): Table {
  let node = parsed;
  for (const segment of path) {
    const next = isTable(node[segment]) ? (node[segment] as Table) : {};
    node[segment] = next;
    node = next;
  }
  return node;
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(sorted(left)) === JSON.stringify(sorted(right));
}
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (!isTable(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sorted(value[key])]),
  );
}

/** Whether something already turns the switch off: its own `false`, or
 * Codex's `features.apps = false`, which turns off both. */
const alreadyOff = (parsed: Table, switch_: Switch) =>
  valueAt(parsed, [...switch_.table, switch_.key]) === false ||
  valueAt(parsed, ["features", "apps"]) === false;

/** The text with one switch off by Lazurio's marked line; the same text
 * where something already turns it off; null where Lazurio cannot do it in
 * place. Checked to parse to exactly the same configuration but that key. */
function switchOff(text: string, switch_: Switch): string | null {
  const parsed = parseToml(text);
  if (parsed === null) return null;
  if (alreadyOff(parsed, switch_)) return text;
  const all = lines(text);
  const table = tableAt(all, switch_.table);
  const header = `[${switch_.table.join(".")}]`;
  let candidate: string;
  if (table === null) {
    // Defined some other way (dotted keys, an inline table, only through a
    // table under it): not Lazurio's to rewrite.
    if (valueAt(parsed, switch_.table) !== undefined) return null;
    // The file keeps its final newline, or its lack of one: without it,
    // Lazurio's table ends without one too, so taking the table away gives
    // back every byte (`switchLifted`).
    const block = `${header} ${codexAppsMarker}\n${switch_.key} = false ${codexAppsMarker}`;
    candidate =
      text === ""
        ? `${block}\n`
        : text.endsWith("\n")
          ? `${text}\n${block}\n`
          : `${text}\n\n${block}`;
  } else {
    const pattern = keyLine(switch_.key);
    const at = all
      .slice(table.header + 1, table.end)
      .findIndex((line) => pattern.test(line.text));
    const next = [...all];
    if (at >= 0) {
      const index = table.header + 1 + at;
      const line = all[index] as Line;
      const indent = pattern.exec(line.text)?.[1] ?? "";
      // The person's line stays readable beside Lazurio's and comes back
      // byte for byte: everything after its indent, trailing spaces too, and
      // its own end of line.
      next[index] = {
        text: `${indent}${switch_.key} = false ${codexAppsMarker} (was: ${line.text.slice(indent.length)})`,
        eol: line.eol,
      };
    } else {
      // A header that ends the file without a newline gets one; Lazurio's
      // line then ends the file without one, as the header did.
      const head = all[table.header] as Line;
      next[table.header] = {
        text: head.text,
        eol: head.eol === "" ? "\n" : head.eol,
      };
      next.splice(table.header + 1, 0, {
        text: `${switch_.key} = false ${codexAppsMarker}`,
        eol: head.eol,
      });
    }
    candidate = joined(next);
  }
  const expected = structuredClone(parsed);
  tableIn(expected, switch_.table)[switch_.key] = false;
  return sameValue(parseToml(candidate), expected) ? candidate : null;
}

/** The text without Lazurio's marked line of one switch (the person's own
 * line written back where Lazurio's replaced one), and without the table
 * where Lazurio created it and nothing else is in it now; the same text
 * where Lazurio's line is not there. */
function switchLifted(text: string, switch_: Switch): string | null {
  const parsed = parseToml(text);
  if (parsed === null) return null;
  const all = lines(text);
  const table = tableAt(all, switch_.table);
  if (table === null) return text;
  const pattern = keyLine(switch_.key);
  const at = all
    .slice(table.header + 1, table.end)
    .findIndex(
      (line) => pattern.exec(line.text)?.[2] === "false" && marked(line.text),
    );
  if (at < 0) return text;
  const next = [...all];
  const index = table.header + 1 + at;
  const line = all[index] as Line;
  const was = markedLine.exec(line.text)?.[1];
  const expected = structuredClone(parsed);
  const owner = tableIn(expected, switch_.table);
  if (was !== undefined) {
    const indent = pattern.exec(line.text)?.[1] ?? "";
    const restored = pattern.exec(was);
    if (restored === null) return null;
    next[index] = { text: `${indent}${was}`, eol: line.eol };
    owner[switch_.key] = restored[2] === "true";
    const candidate = joined(next);
    return sameValue(parseToml(candidate), expected) ? candidate : null;
  }
  next.splice(index, 1);
  const end = table.end - 1;
  const body = next.slice(table.header + 1, end);
  const created =
    marked((next[table.header] as Line).text) &&
    body.every((item) => item.text.trim() === "");
  delete owner[switch_.key];
  if (created) {
    // The table Lazurio created, and the blank line it put before it.
    let from = table.header;
    if (from > 0 && (next[from - 1] as Line).text.trim() === "") from -= 1;
    next.splice(from, end - from);
    // The table goes from the copy too, and each parent left empty.
    for (let depth = switch_.table.length; depth > 0; depth -= 1) {
      const parent =
        depth === 1
          ? expected
          : tableIn(expected, switch_.table.slice(0, depth - 1));
      const name = switch_.table[depth - 1] as string;
      if (
        isTable(parent[name]) &&
        Object.keys(parent[name] as Table).length === 0
      )
        delete parent[name];
      else break;
    }
  }
  // A file without a final newline keeps that: what Lazurio's lines ended
  // goes back to its line before them (`switchOff`).
  const last = next.at(-1);
  if (!text.endsWith("\n") && last !== undefined)
    next[next.length - 1] = { text: last.text, eol: "" };
  const candidate = joined(next);
  return sameValue(parseToml(candidate), expected) ? candidate : null;
}

/** The configuration with the apps and Codex's suggestions turned off by
 * Lazurio's marked lines, the same text where something already turns them
 * off, or null where Lazurio cannot do both in place. Pure. */
export function codexAppsOffText(text: string): string | null {
  const apps = switchOff(text, appsSwitch);
  return apps === null ? null : switchOff(apps, suggestionsSwitch);
}

/** The configuration without Lazurio's marked lines (the suggestions' first:
 * the reverse of `codexAppsOffText`), or null where the result would not
 * parse to the same configuration without them. */
export function codexAppsLiftedText(text: string): string | null {
  const suggestions = switchLifted(text, suggestionsSwitch);
  return suggestions === null ? null : switchLifted(suggestions, appsSwitch);
}

/** How a configuration's text has the apps (`on`, `off` or `unreadable`)
 * and Codex's suggestions. */
export function codexAppsOfText(text: string): CodexAppsFacts {
  const parsed = parseToml(text);
  if (parsed === null) return { state: "unreadable" };
  const suggestions = alreadyOff(parsed, suggestionsSwitch)
    ? ("off" as const)
    : ("on" as const);
  if (valueAt(parsed, ["features", "apps"]) === false)
    return { state: "off", by: "feature", exceptions: [], suggestions };
  if (valueAt(parsed, ["apps", "_default", "enabled"]) !== false)
    return { state: "on", suggestions };
  const apps = valueAt(parsed, ["apps"]) as Table;
  const all = lines(text);
  const table = tableAt(all, appsSwitch.table);
  const pattern = keyLine(appsSwitch.key);
  const lazurio =
    table !== null &&
    all
      .slice(table.header + 1, table.end)
      .some(
        (line) => pattern.exec(line.text)?.[2] === "false" && marked(line.text),
      );
  const exceptions = Object.keys(apps)
    .filter(
      (id) =>
        id !== "_default" &&
        isTable(apps[id]) &&
        (apps[id] as Table).enabled === true,
    )
    .sort();
  return Object.freeze({
    state: "off" as const,
    by: lazurio ? ("lazurio" as const) : ("person" as const),
    exceptions: Object.freeze(exceptions),
    suggestions,
  });
}

// ---- The file ---------------------------------------------------------------

type Read =
  | Readonly<{ kind: "text"; text: string; mode: number | null }>
  | Readonly<{ kind: "refused"; reason: CodexAppsRefusal }>;

async function readConfig(file: string): Promise<Read> {
  let mode: number | null = null;
  try {
    const status = await lstat(file);
    if (!status.isFile())
      return { kind: "refused", reason: "config-not-regular" };
    if (status.size > configBytesMax)
      return { kind: "refused", reason: "config-unreadable" };
    mode = status.mode & 0o777;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { kind: "text", text: "", mode: null };
    return { kind: "refused", reason: "config-unreadable" };
  }
  try {
    return { kind: "text", text: await readFile(file, "utf8"), mode };
  } catch {
    return { kind: "refused", reason: "config-unreadable" };
  }
}

async function codexInstalled(input: CodexAppsInput): Promise<boolean> {
  return (
    (await resolveOnPath("codex", input.path, input.platform)) !== undefined
  );
}

/** How the operator's Codex has the ChatGPT account's apps. Reads only. */
export async function observeCodexApps(
  input: CodexAppsInput,
): Promise<CodexAppsFacts> {
  if (!(await codexInstalled(input))) return { state: "absent" };
  const home = codexHome(input);
  if (home === null) return { state: "unreadable" };
  const file = join(home, "config.toml");
  const read = await readConfig(file);
  // A link is read where it leads: only writing through it is refused.
  if (read.kind === "refused" && read.reason === "config-not-regular") {
    const text = await readFile(file, "utf8").catch(() => null);
    return text === null || Buffer.byteLength(text) > configBytesMax
      ? { state: "unreadable" }
      : codexAppsOfText(text);
  }
  return read.kind === "text"
    ? codexAppsOfText(read.text)
    : { state: "unreadable" };
}

/** Makes Codex's configuration say what the policy allows: off by Lazurio's
 * marked line where they are not allowed, Lazurio's line gone where they
 * are. Idempotent; writes only when the text changes, by a new file renamed
 * over the old one, with the old one's mode, and only where the old one did
 * not change meanwhile. Where Codex is not installed nothing is written. */
export async function convergeCodexApps(
  input: CodexAppsInput,
  allowed: boolean,
): Promise<CodexAppsConverged> {
  if (!(await codexInstalled(input)))
    return { kind: "unchanged", facts: { state: "absent" } };
  const home = codexHome(input);
  if (home === null)
    return {
      kind: "refused",
      reason: "config-unreadable",
      facts: { state: "unreadable" },
    };
  const file = join(home, "config.toml");
  const read = await readConfig(file);
  if (read.kind === "refused")
    return {
      kind: "refused",
      reason: read.reason,
      facts: await observeCodexApps(input),
    };
  const facts = codexAppsOfText(read.text);
  if (facts.state === "unreadable")
    return { kind: "refused", reason: "config-unreadable", facts };
  const next = allowed
    ? codexAppsLiftedText(read.text)
    : codexAppsOffText(read.text);
  if (next === null) return { kind: "refused", reason: "config-shape", facts };
  if (next === read.text) return { kind: "unchanged", facts };
  if (read.mode === null) await mkdir(home, { recursive: true, mode: 0o700 });
  const temporary = join(
    home,
    `.config.toml.lazurio-${randomBytes(6).toString("hex")}`,
  );
  try {
    const handle = await open(temporary, "wx", read.mode ?? 0o600);
    try {
      await handle.writeFile(next, "utf8");
      await handle.chmod(read.mode ?? 0o600);
      await handle.sync();
    } finally {
      await handle.close();
    }
    const again = await readConfig(file);
    if (again.kind !== "text" || again.text !== read.text) {
      await unlink(temporary).catch(() => undefined);
      return {
        kind: "refused",
        reason: "config-changed",
        facts: await observeCodexApps(input),
      };
    }
    await rename(temporary, file);
  } catch {
    await unlink(temporary).catch(() => undefined);
    return {
      kind: "refused",
      reason: "write-failed",
      facts: await observeCodexApps(input),
    };
  }
  return { kind: "changed", facts: await observeCodexApps(input) };
}
