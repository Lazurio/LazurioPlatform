import { isStrip, targetIdOf, viewAddressOf } from "../browser/contract/pure";
import { currentEnvironment, type Shell } from "./contract";
import { shellElementInterface } from "./interface";

// Nová karta's protocol (decision F47 points 1 and 2): the messages between
// the shell element `<lazurio-new-tab>` (new-tab-element.ts), which an app of
// the Environment places in its right panel, and the Launchpad's page
// `/new-tab` it frames (src/launchpad/new-tab-page.ts). Both come from the
// same Launchpad, so the protocol is internal to it: `postMessage` between
// exactly the frame's window on the page's origin, and the page's parent on
// an origin of the Environment's own apps. Each side reads every message here,
// field by field, and ignores one that is not of these shapes; members a
// later version may add are ignored, as the shell's documents do. Pure: no
// DOM, shared by the element, the page and their tests.
//
//   page → host: {type: "lazurio-new-tab:ready"}
//                {type: "lazurio-new-tab:choice", choice}
//   host → page: {type: "lazurio-new-tab:host", strip, tools, focusAddress,
//                 lang, theme}

/** The Launchpad's page that draws Nová karta, on the origin of `apps`. */
export const newTabPagePath = "/new-tab";

/** The element's one event: `detail` is what the tab became. */
export const newTabEventName = "lazurio-new-tab";

export const newTabMessage = Object.freeze({
  ready: "lazurio-new-tab:ready",
  choice: "lazurio-new-tab:choice",
  host: "lazurio-new-tab:host",
});

/** One of the app's own surfaces, drawn under the address bar in this
 * order: a button with its label, the letter that opens it while nobody
 * types (`key`), and an icon by name from the page's own set (`icon`; an
 * unknown name draws the default one). */
export type NewTabTool = Readonly<{
  id: string;
  label: string;
  key?: string;
  icon?: string;
}>;

/** What Nová karta became (F47 point 2): a remote tab an address opened
 * (`page`), a tab chosen in Přehled (`tab`), each with its view
 * (`https://browser.<…>/t/<id>`, F39 point 1), or one of the app's tools. */
export type NewTabChoice =
  | Readonly<{ kind: "page"; tab: string; view: string }>
  | Readonly<{ kind: "tab"; tab: string; view: string }>
  | Readonly<{ kind: "tool"; id: string }>;

/** The app's colour roles (`--lazurio-*`) and their values. */
export type NewTabTheme = Readonly<Record<string, string>>;

export type NewTabHostMessage = Readonly<{
  type: typeof newTabMessage.host;
  /** The strip the tab is for: `launchpad`, or a T3 Code thread's
   * agent-browser session (`t3-<thread>`). */
  strip: string;
  tools: readonly NewTabTool[];
  /** The address bar takes the keys (the Launchpad); without it the
   * tools' letters do while nobody types (T3 Code). */
  focusAddress: boolean;
  lang: "cs" | "en";
  theme: NewTabTheme;
}>;

export type NewTabPageMessage =
  | Readonly<{ type: typeof newTabMessage.ready }>
  | Readonly<{ type: typeof newTabMessage.choice; choice: NewTabChoice }>;

type Data = Readonly<Record<string, unknown>>;
const isRecord = (value: unknown): value is Data =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const namePattern = /^[a-z0-9][a-z0-9-]{0,31}$/;
const keyPattern = /^[A-Za-z0-9]$/;
/** At most this many tools: T3 Code has six. */
export const maxNewTabTools = 12;
const maxLabelLength = 48;

const isLabel = (value: unknown): value is string =>
  typeof value === "string" &&
  value.trim() !== "" &&
  value.length <= maxLabelLength &&
  ![...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  });

/** An optional member: undefined when absent, the text when it matches
 * `pattern`, null for anything else. */
const optionalText = (
  value: unknown,
  pattern: RegExp,
): string | undefined | null =>
  value === undefined
    ? undefined
    : typeof value === "string" && pattern.test(value)
      ? value
      : null;

/** The app's tools, or null when `value` is not a list of them: at most
 * `maxNewTabTools`, each with an id and a label, an optional letter and an
 * optional icon name, no id or letter twice. */
export function parseNewTabTools(value: unknown): readonly NewTabTool[] | null {
  if (!Array.isArray(value) || value.length > maxNewTabTools) return null;
  const tools: NewTabTool[] = [];
  const ids = new Set<string>();
  const keys = new Set<string>();
  for (const item of value) {
    if (!isRecord(item)) return null;
    const { id, label } = item;
    const key = optionalText(item.key, keyPattern);
    const icon = optionalText(item.icon, namePattern);
    if (
      typeof id !== "string" ||
      !namePattern.test(id) ||
      ids.has(id) ||
      !isLabel(label) ||
      key === null ||
      icon === null
    )
      return null;
    if (key !== undefined) {
      if (keys.has(key.toLowerCase())) return null;
      keys.add(key.toLowerCase());
    }
    ids.add(id);
    tools.push(
      Object.freeze({
        id,
        label,
        ...(key === undefined ? {} : { key }),
        ...(icon === undefined ? {} : { icon }),
      }),
    );
  }
  return Object.freeze(tools);
}

/** `value` when it is the view of the remote tab `tab` (upper case), a view
 * address of the contract's strict form (`viewAddressOf`, decision F50
 * point 2): `https://browser.<base>.lazurio.io/t/<tab>`, as written. Null
 * otherwise. */
export function newTabViewOf(value: unknown, tab: string): string | null {
  const address = viewAddressOf(value);
  return address !== null && address.tab === tab ? address.view : null;
}

/** A choice of these three kinds and their exact members, or null: a tab's
 * id in upper case, as the hub writes it, with that tab's view. */
export function parseNewTabChoice(value: unknown): NewTabChoice | null {
  if (!isRecord(value)) return null;
  switch (value.kind) {
    case "page":
    case "tab": {
      const tab = targetIdOf(value.tab);
      if (tab === null) return null;
      const view = newTabViewOf(value.view, tab);
      return view === null
        ? null
        : Object.freeze({ kind: value.kind, tab, view });
    }
    case "tool":
      return typeof value.id === "string" && namePattern.test(value.id)
        ? Object.freeze({ kind: "tool", id: value.id })
        : null;
    default:
      return null;
  }
}

/** A message of the page, or null for anything else. */
export function parseNewTabPageMessage(
  value: unknown,
): NewTabPageMessage | null {
  if (!isRecord(value)) return null;
  if (value.type === newTabMessage.ready)
    return Object.freeze({ type: newTabMessage.ready });
  if (value.type !== newTabMessage.choice) return null;
  const choice = parseNewTabChoice(value.choice);
  return choice === null
    ? null
    : Object.freeze({ type: newTabMessage.choice, choice });
}

/** The colour roles of the shell's interface v1 (F36's addendum of
 * 2026-10-04, evening), without the rail's width and the host's tone,
 * which are no colours. */
export const newTabThemeRoles: readonly string[] = Object.freeze(
  shellElementInterface.properties.filter(
    (property) =>
      property !== "--lazurio-rail-width" && property !== "--lazurio-host-tone",
  ),
);

const colourFunctions = new Set([
  "rgb",
  "rgba",
  "hsl",
  "hsla",
  "hwb",
  "lab",
  "lch",
  "oklab",
  "oklch",
  "color",
  "color-mix",
  "light-dark",
]);

/** A colour as `getComputedStyle` gives a role's value: a name, a hex
 * colour or a colour function, nothing that could load anything (no
 * `url()`, no `image()`, no other function), at most 160 characters.
 * Null otherwise. */
export function themeValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text === "" || text.length > 160) return null;
  if (!/^[#a-zA-Z0-9 .,%()/+-]+$/.test(text)) return null;
  for (const [, name] of text.matchAll(/([a-zA-Z-]+)\s*\(/g))
    if (!colourFunctions.has((name ?? "").toLowerCase())) return null;
  return text;
}

/** The theme of a host message: only an object; an unknown role or an
 * unsafe value is left out, so its role keeps the design system's colour. */
export function parseNewTabTheme(value: unknown): NewTabTheme | null {
  if (!isRecord(value)) return null;
  const theme: Record<string, string> = {};
  for (const role of newTabThemeRoles) {
    const read = themeValue(value[role]);
    if (read !== null) theme[role] = read;
  }
  return Object.freeze(theme);
}

/** The host's message, or null for anything else. */
export function parseNewTabHostMessage(
  value: unknown,
): NewTabHostMessage | null {
  if (!isRecord(value) || value.type !== newTabMessage.host) return null;
  const tools = parseNewTabTools(value.tools);
  const theme = parseNewTabTheme(value.theme);
  if (
    !isStrip(value.strip) ||
    tools === null ||
    typeof value.focusAddress !== "boolean" ||
    (value.lang !== "cs" && value.lang !== "en") ||
    theme === null
  )
    return null;
  return Object.freeze({
    type: newTabMessage.host,
    strip: value.strip,
    tools,
    focusAddress: value.focusAddress,
    lang: value.lang,
    theme,
  });
}

/** The element's side: a message counts only from its own frame's window
 * on the page's origin, and a tool only when it is one of the element's. */
export function acceptNewTabPageMessage(
  event: Readonly<{ data: unknown; origin: string; fromFrame: boolean }>,
  pageOrigin: string | null,
  tools: readonly NewTabTool[],
): NewTabPageMessage | null {
  if (!event.fromFrame || pageOrigin === null || event.origin !== pageOrigin)
    return null;
  const message = parseNewTabPageMessage(event.data);
  if (
    message?.type === newTabMessage.choice &&
    message.choice.kind === "tool"
  ) {
    const id = message.choice.id;
    if (!tools.some((tool) => tool.id === id)) return null;
  }
  return message;
}

/** The page's side: a host message counts only from the page's parent on an
 * origin of the Environment's own apps (`newTabHostOrigins`). */
export function acceptNewTabHostMessage(
  event: Readonly<{ data: unknown; origin: string; fromParent: boolean }>,
  origins: readonly string[],
): NewTabHostMessage | null {
  if (!event.fromParent || !origins.includes(event.origin)) return null;
  return parseNewTabHostMessage(event.data);
}

/** The origins that may host Nová karta: the current Environment's own apps
 * in its shell document (`apps`, `chat`, `automate`), the same ones the
 * page's `frame-ancestors` names. Apps as a path is the page's own origin (a
 * workstation). None on a page that belongs to no Environment. */
export function newTabHostOrigins(
  shell: Shell,
  pageOrigin: string,
): readonly string[] {
  const environment = currentEnvironment(shell);
  if (environment === null) return [];
  const origins = new Set<string>();
  for (const address of [
    environment.apps.apps,
    environment.apps.chat,
    environment.apps.automate,
  ]) {
    if (address === null) continue;
    try {
      origins.add(new URL(address, pageOrigin).origin);
    } catch {}
  }
  return Object.freeze([...origins]);
}

/** Where the page posts `ready`: the origin of the window around it, where
 * the browser names it (`location.ancestorOrigins`, `ancestor`), when that
 * is one of the Environment's apps, and nowhere when it is another; where
 * the browser does not name it, every app origin, of which the browser
 * delivers only the one the parent is on. */
export function newTabReadyTargets(
  origins: readonly string[],
  ancestor: string | null,
): readonly string[] {
  if (ancestor === null || ancestor === "null") return origins;
  return origins.includes(ancestor) ? [ancestor] : [];
}

/** Where the element frames the page: `/new-tab` on the origin of the
 * current Environment's `apps` (a path on a workstation is the host page's
 * own origin). Null without a current Environment or a usable address. */
export function newTabFrameSource(
  shell: Shell | null,
  base: string,
): URL | null {
  if (shell === null) return null;
  const environment = currentEnvironment(shell);
  if (environment === null) return null;
  try {
    const apps = new URL(environment.apps.apps, base);
    if (apps.protocol !== "https:" && apps.protocol !== "http:") return null;
    return new URL(newTabPagePath, apps);
  } catch {
    return null;
  }
}

/** The element's message to its page, from its attributes, the shell
 * document's language and the host document's colour roles; null without a
 * valid strip, which the element then does not frame. A tools attribute
 * that is not a valid list gives no tools. */
export function newTabHostMessageOf(
  input: Readonly<{
    strip: string | null;
    tools: string | null;
    focusAddress: boolean;
    lang: string | null;
    /** The shell document's language, when the element has no `lang`. */
    locale: "cs" | "en";
    /** A colour role's value on the host's document (`getComputedStyle`). */
    role: (name: string) => string;
  }>,
): NewTabHostMessage | null {
  if (!isStrip(input.strip)) return null;
  let tools: readonly NewTabTool[] = [];
  if (input.tools !== null) {
    try {
      tools = parseNewTabTools(JSON.parse(input.tools)) ?? [];
    } catch {
      tools = [];
    }
  }
  const theme: Record<string, string> = {};
  for (const role of newTabThemeRoles) {
    const value = themeValue(input.role(role));
    if (value !== null) theme[role] = value;
  }
  return Object.freeze({
    type: newTabMessage.host,
    strip: input.strip,
    tools,
    focusAddress: input.focusAddress,
    lang:
      input.lang === "cs" || input.lang === "en" ? input.lang : input.locale,
    theme: Object.freeze(theme),
  });
}
