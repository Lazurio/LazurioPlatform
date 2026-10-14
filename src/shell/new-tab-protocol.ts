import {
  isStrip,
  type NewTabChoice,
  type NewTabTool,
  parseNewTabChoice,
  parseNewTabTools,
  surfaceLanguageOf,
} from "../browser/contract/pure";
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
// later version may add are ignored, as the shell's documents do. What an
// app hands the element and hears back (its tools, the event and its choice)
// is the Environment browser's contract (C10, src/browser/contract). Pure:
// no DOM, shared by the element, the page and their tests.
//
//   page → host: {type: "lazurio-new-tab:ready"}
//                {type: "lazurio-new-tab:choice", choice}
//   host → page: {type: "lazurio-new-tab:host", strip, tools, focusAddress,
//                 lang, theme}

/** The Launchpad's page that draws Nová karta, on the origin of `apps`. */
export const newTabPagePath = "/new-tab";

export const newTabMessage = Object.freeze({
  ready: "lazurio-new-tab:ready",
  choice: "lazurio-new-tab:choice",
  host: "lazurio-new-tab:host",
});

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
  const lang = surfaceLanguageOf(value.lang);
  if (
    !isStrip(value.strip) ||
    tools === null ||
    typeof value.focusAddress !== "boolean" ||
    lang === null ||
    theme === null
  )
    return null;
  return Object.freeze({
    type: newTabMessage.host,
    strip: value.strip,
    tools,
    focusAddress: value.focusAddress,
    lang,
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
    lang: surfaceLanguageOf(input.lang) ?? input.locale,
    theme: Object.freeze(theme),
  });
}
