import {
  environmentIdOf,
  isEnvironmentId,
  isShellBuddyOrigin,
  isShellSlug,
  type Shell,
  type ShellEnvironmentKind,
} from "./contract";
import { isExplanationId } from "./guide-protocol";
import { visitOf } from "./last";
import { shellMessages } from "./messages";
import { environmentName, hereOf, organizationOf } from "./view";

// The messages between Buddy's bubble on a page of Lazurio and Buddy's frame
// in it (decision F60; root decision 0210 point 8, plan DEV-6676 P3). The
// host's shell (`<lazurio-buddy>`, buddy-bubble.ts) frames Buddy's origin,
// `https://buddy.<slug>.lazurio.io`, which the person's Osobní Prostředí
// serves, and tells the frame where the person asks from. The frame tells the
// host when it is ready and which size its window should have; it asks for an
// explanation of the guide with `lazurio.guide.play` (guide-protocol.ts,
// unchanged). Nothing else crosses: no token, never Buddy's name, character,
// state or conversation toward the host.
//
//   frame → host: {type: "lazurio.buddy.ready", v: 1}
//                 {type: "lazurio.buddy.layout", v: 1,
//                  mode: "panel" | "fullscreen" | "closed"}
//                 {type: "lazurio.guide.play", v: 1, explainer}  (F56)
//   host → frame: {type: "lazurio.buddy.context", v: 1, lang, theme,
//                  environment: {id, kind, name} | null,
//                  organization: {slug, name} | null,
//                  app, page: {path}, guide: {explainer, step} | null}
//
// The host sends the context after `ready` (again after every `ready`: the
// frame loaded anew) and after every change, never the same twice
// (`createBuddyContextSender`), only to the frame's window and only to
// exactly Buddy's origin, never `*`. Every message is checked on the side
// that takes it, and a defect drops the whole message without an answer:
// - the source: the host takes a message only from the window of its bubble's
//   frame, the frame only from its parent window;
// - the origin: the host only exactly Buddy's origin as the page's merged
//   shell document names it (`buddy.origin`, never taken from a message);
//   the frame only exactly the origin of the page around it, which must be
//   the Launchpad, T3 Code or MausBot of an Environment,
//   `https://(launchpad|t3code|mausbot).<base>.lazurio.io`
//   (`isBuddyHostOrigin`, `buddyHostOriginOf`);
// - the data: a plain object with exactly its keys at every level (an added
//   member refuses the message, it is never just dropped), `v` 1, the closed
//   values below and texts within their caps;
// - the frame takes a context only about the page's own Environment: its id
//   is the host origin's base host (`environmentIdOf`), and it is personal
//   exactly where that base host has one label.
//
// The context says only facts of the page: the language and the colour
// scheme it shows (`lang`, `theme`); the Environment, its kind (`personal`,
// `work` or `team`; an automated Environment is `work`) and its name as the
// Environment picker shows it; the Organization of the space the page is in
// (null in the personal space); the app (`chat`, `apps`, `automate`, or
// `settings` where the column head says so; null where the page has no
// column head); the page's path, only `location.pathname` (never its query
// or fragment, which may carry tokens); and the explanation the guide last
// showed on this page with its step, counted from 1, or null. Names are the
// shell's display texts (1 to 128 characters, no control characters), the
// path at most 512 characters. On your computer and on a page that is no
// Environment's there is no Buddy and no context.
//
// Exact keys mean that any new member is the protocol's v2. Pure: no DOM,
// no I/O; the bubble (host) and Buddy's frame build on it. Its executable
// vectors, `buddy-vectors/v1/buddy-protocol.json`, run with the runner of
// decision F50 like the guide's.

export const buddyMessage = Object.freeze({
  ready: "lazurio.buddy.ready",
  layout: "lazurio.buddy.layout",
  context: "lazurio.buddy.context",
});

/** The protocol's major; a message without `v: 1` is no message of it. */
export const buddyMajor = 1;

/** The schema of a vector file of this contract (as decision F50's). */
export const buddyVectorsSchema = "lazurio.buddy-vectors.v1";

/** The sizes of Buddy's window the frame may ask for. */
export const buddyLayouts = Object.freeze([
  "panel",
  "fullscreen",
  "closed",
] as const);
export type BuddyLayout = (typeof buddyLayouts)[number];

/** The kinds a context names: the three of root decision 0207. */
export const buddyContextKinds = Object.freeze([
  "personal",
  "work",
  "team",
] as const);
export type BuddyContextKind = (typeof buddyContextKinds)[number];

/** The apps a context names: the column head's `active`. */
export const buddyContextApps = Object.freeze([
  "chat",
  "apps",
  "automate",
  "settings",
] as const);
export type BuddyContextApp = (typeof buddyContextApps)[number];

/** The colour scheme the host page shows. */
export const buddyThemes = Object.freeze(["light", "dark"] as const);
export type BuddyTheme = (typeof buddyThemes)[number];

/** The caps of the context: its texts' lengths and the guide's steps. */
export const buddyContextLimits = Object.freeze({
  name: 128,
  path: 512,
  steps: 16,
});

/** The explanation the guide last showed on the page, and its step,
 * counted from 1. */
export type BuddyGuideStep = Readonly<{ explainer: string; step: number }>;

export type BuddyContextEnvironment = Readonly<{
  id: string;
  kind: BuddyContextKind;
  name: string;
}>;

export type BuddyContextOrganization = Readonly<{ slug: string; name: string }>;

export type BuddyContext = Readonly<{
  type: typeof buddyMessage.context;
  v: typeof buddyMajor;
  lang: "cs" | "en";
  theme: BuddyTheme;
  environment: BuddyContextEnvironment | null;
  organization: BuddyContextOrganization | null;
  app: BuddyContextApp | null;
  page: Readonly<{ path: string }>;
  guide: BuddyGuideStep | null;
}>;

/** A message of the frame the host acts on (besides `lazurio.guide.play`). */
export type BuddyFrameMessage =
  | Readonly<{ type: typeof buddyMessage.ready }>
  | Readonly<{ type: typeof buddyMessage.layout; mode: BuddyLayout }>;

type Data = Readonly<Record<string, unknown>>;

/** Plain data as `postMessage` delivers it: an object whose prototype is
 * `Object.prototype`, never a list, a class instance or one without a
 * prototype. */
const isPlain = (value: unknown): value is Data =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

/** Exactly `keys` as its own data members, nothing else (a `__proto__`
 * member or a symbol included). */
function hasExactly(value: Data, keys: readonly string[]): boolean {
  const own = Reflect.ownKeys(value);
  return (
    own.length === keys.length &&
    keys.every((key) => {
      const member = Object.getOwnPropertyDescriptor(value, key);
      return member !== undefined && "value" in member && member.enumerable;
    })
  );
}

/** A display text: 1 to `max` characters, none of them a control
 * character, as the shell documents' texts. */
const isText = (value: unknown, max: number): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= max &&
  ![...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  });

const isOneOf = <T extends string>(
  values: readonly T[],
  value: unknown,
): value is T =>
  typeof value === "string" && (values as readonly string[]).includes(value);

const pagePath = /^\/(?!\/)[^\s\\?#]*$/;

/** A page's path as a context names it: absolute, never `//…`, no
 * whitespace, backslash, query or fragment, at most 512 characters. */
export const isBuddyPagePath = (value: unknown): value is string =>
  isText(value, buddyContextLimits.path) && pagePath.test(value);

/** The apps whose pages host the bubble: the Launchpad, T3 Code and
 * MausBot of an Environment. */
const hostApps: readonly string[] = ["launchpad", "t3code", "mausbot"];

/** The Environment of a page that may host Buddy's bubble, by its origin:
 * exactly `https://(launchpad|t3code|mausbot).<base>.lazurio.io` (lower
 * case, no port, path or trailing slash), its id the base host
 * (`environmentIdOf`); null for any other origin: another app or a Module,
 * the Dashboard, another domain or depth. */
export function buddyHostEnvironment(origin: unknown): string | null {
  if (typeof origin !== "string") return null;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return null;
  }
  if (url.origin !== origin) return null;
  if (!hostApps.includes(url.hostname.split(".")[0] ?? "")) return null;
  return environmentIdOf(origin);
}

/** Whether a page of this origin may host Buddy's bubble. */
export const isBuddyHostOrigin = (origin: unknown): origin is string =>
  buddyHostEnvironment(origin) !== null;

/** The origin of the page around Buddy's frame, as the frame learns it: the
 * browser's `location.ancestorOrigins[0]` (`ancestor`) where it names one,
 * else the origin of `document.referrer` (the bubble creates the frame with
 * `referrerpolicy="origin"`, so a browser without `ancestorOrigins` still
 * says it); null unless that is a host of the bubble (`isBuddyHostOrigin`).
 * A frame that navigated itself has its own origin as its referrer, which
 * is no host: it hears no context until the host frames it again. */
export function buddyHostOriginOf(
  ancestor: string | null | undefined,
  referrer: string | null | undefined,
): string | null {
  if (typeof ancestor === "string" && ancestor !== "" && ancestor !== "null")
    return isBuddyHostOrigin(ancestor) ? ancestor : null;
  if (typeof referrer !== "string" || referrer === "") return null;
  let origin: string;
  try {
    origin = new URL(referrer).origin;
  } catch {
    return null;
  }
  return isBuddyHostOrigin(origin) ? origin : null;
}

/** How the bubble frames Buddy (contract of decision F60): Nová karta's
 * sandbox (new-tab-element.ts), the frame on its own origin with its
 * cookie, scripts and forms, never navigating the page around it, whose
 * popups (the sign-in at the Osobní Prostředí's gateway, a link) open as
 * ordinary windows of the person's browser; a referrer that names the host's
 * origin, though the host page sends none (the Launchpad's `no-referrer`),
 * so the frame's `frame-ancestors` and `buddyHostOriginOf` know the host;
 * and the clipboard for copying an answer. Never `credentialless`. */
export const buddyFrameAttributes = Object.freeze({
  sandbox:
    "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox",
  referrerpolicy: "origin",
  allow: "clipboard-write",
});

/** Where the bubble frames Buddy: the root of his origin; null for an
 * origin that is no Buddy's (`isShellBuddyOrigin`). */
export const buddyFrameSource = (origin: unknown): string | null =>
  isShellBuddyOrigin(origin) ? `${origin}/` : null;

/** The picture of Buddy on the closed bubble: his character as his origin
 * serves it; null for an origin that is no Buddy's. */
export const buddyAvatarSource = (origin: unknown): string | null =>
  isShellBuddyOrigin(origin) ? `${origin}/assets/avatar.webp` : null;

/** `ready` as the frame sends it. */
export const buddyReady = (): Readonly<{
  type: typeof buddyMessage.ready;
  v: typeof buddyMajor;
}> => Object.freeze({ type: buddyMessage.ready, v: buddyMajor });

/** A request of the frame for its window's size; null for a size there is
 * none of. */
export function buddyLayoutRequest(mode: unknown): Readonly<{
  type: typeof buddyMessage.layout;
  v: typeof buddyMajor;
  mode: BuddyLayout;
}> | null {
  return isOneOf(buddyLayouts, mode)
    ? Object.freeze({ type: buddyMessage.layout, v: buddyMajor, mode })
    : null;
}

/** The host's side: a message of the frame it acts on, or null to drop it.
 * It counts only from the window of the bubble's frame on this page
 * (`fromBuddyFrame`: the impure side compares `event.source` with the
 * frame's `contentWindow`) and on exactly Buddy's origin as the page's
 * document names it. */
export function acceptBuddyFrameMessage(
  event: Readonly<{ data: unknown; origin: string; fromBuddyFrame: boolean }>,
  buddyOrigin: string | null,
): BuddyFrameMessage | null {
  if (event.fromBuddyFrame !== true) return null;
  if (!isShellBuddyOrigin(buddyOrigin) || event.origin !== buddyOrigin)
    return null;
  const data = event.data;
  if (!isPlain(data) || data.v !== buddyMajor) return null;
  if (data.type === buddyMessage.ready)
    return hasExactly(data, ["type", "v"])
      ? Object.freeze({ type: buddyMessage.ready })
      : null;
  if (
    data.type === buddyMessage.layout &&
    hasExactly(data, ["type", "v", "mode"]) &&
    isOneOf(buddyLayouts, data.mode)
  )
    return Object.freeze({ type: buddyMessage.layout, mode: data.mode });
  return null;
}

function contextEnvironment(value: unknown): BuddyContextEnvironment | null {
  if (
    !isPlain(value) ||
    !hasExactly(value, ["id", "kind", "name"]) ||
    !isEnvironmentId(value.id) ||
    !isOneOf(buddyContextKinds, value.kind) ||
    !isText(value.name, buddyContextLimits.name)
  )
    return null;
  return Object.freeze({ id: value.id, kind: value.kind, name: value.name });
}

function contextOrganization(value: unknown): BuddyContextOrganization | null {
  if (
    !isPlain(value) ||
    !hasExactly(value, ["slug", "name"]) ||
    !isShellSlug(value.slug) ||
    !isText(value.name, buddyContextLimits.name)
  )
    return null;
  return Object.freeze({ slug: value.slug, name: value.name });
}

function contextGuide(value: unknown): BuddyGuideStep | null {
  if (
    !isPlain(value) ||
    !hasExactly(value, ["explainer", "step"]) ||
    !isExplanationId(value.explainer) ||
    typeof value.step !== "number" ||
    !Number.isInteger(value.step) ||
    value.step < 1 ||
    value.step > buddyContextLimits.steps
  )
    return null;
  return Object.freeze({ explainer: value.explainer, step: value.step });
}

const contextKeys = [
  "type",
  "v",
  "lang",
  "theme",
  "environment",
  "organization",
  "app",
  "page",
  "guide",
];

/** A context as data, field by field (no origin or source: `acceptBuddyContext`
 * adds those); a frozen copy, or null for anything else. */
export function parseBuddyContext(data: unknown): BuddyContext | null {
  if (
    !isPlain(data) ||
    !hasExactly(data, contextKeys) ||
    data.type !== buddyMessage.context ||
    data.v !== buddyMajor ||
    (data.lang !== "cs" && data.lang !== "en") ||
    !isOneOf(buddyThemes, data.theme) ||
    !(data.app === null || isOneOf(buddyContextApps, data.app))
  )
    return null;
  const environment =
    data.environment === null ? null : contextEnvironment(data.environment);
  const organization =
    data.organization === null ? null : contextOrganization(data.organization);
  const guide = data.guide === null ? null : contextGuide(data.guide);
  const page = data.page;
  if (
    (data.environment !== null && environment === null) ||
    (data.organization !== null && organization === null) ||
    (data.guide !== null && guide === null) ||
    !isPlain(page) ||
    !hasExactly(page, ["path"]) ||
    !isBuddyPagePath(page.path)
  )
    return null;
  return Object.freeze({
    type: buddyMessage.context,
    v: buddyMajor,
    lang: data.lang,
    theme: data.theme,
    environment,
    organization,
    app: data.app,
    page: Object.freeze({ path: page.path }),
    guide,
  });
}

/** The frame's side: the context of a message, or null to drop it. It counts
 * only from the frame's parent window (`fromParent`: `event.source ===
 * window.parent`, a framed page), on exactly `hostOrigin`, the origin of the
 * page around the frame (`buddyHostOriginOf`), which must be a host of the
 * bubble; and only about that page's own Environment: its id is the host
 * origin's base host, and it is personal exactly where that base host has
 * one label. Every host is an Environment's page, so a context without an
 * Environment is refused. */
export function acceptBuddyContext(
  event: Readonly<{ data: unknown; origin: string; fromParent: boolean }>,
  hostOrigin: string | null,
): BuddyContext | null {
  if (event.fromParent !== true) return null;
  const own = buddyHostEnvironment(hostOrigin);
  if (own === null || event.origin !== hostOrigin) return null;
  const context = parseBuddyContext(event.data);
  if (context === null || context.environment === null) return null;
  const { id, kind } = context.environment;
  if (id !== own || (kind === "personal") !== !id.includes(".")) return null;
  return context;
}

/** The kind a context names for an Environment of `kind`: an automated one
 * is work; none for your computer, which has no Buddy. */
export const buddyContextKind = (
  kind: ShellEnvironmentKind,
): BuddyContextKind | null =>
  kind === "automated"
    ? "work"
    : kind === "workstation"
      ? null
      : (kind as BuddyContextKind);

/** What the host knows of its page when it builds a context. */
export type BuddyContextFacts = Readonly<{
  /** The page's merged shell document. */
  shell: Shell;
  /** The `space` of the page's column head (`hereOf`), or null. */
  space: string | null;
  /** The `active` of the page's column head, or null without one. */
  active: string | null;
  /** `<lazurio-buddy lang>`; else the document's language. */
  lang: string | null;
  /** `location.pathname`; never the whole address. */
  path: string;
  theme: BuddyTheme;
  guide: BuddyGuideStep | null;
}>;

/** The context of the page now (the host's side): the current Environment
 * and the Organization of the space the page is in, as the last visit says
 * them (`visitOf`, last.ts), the Environment named as the picker names it, in
 * `lang`; a path that is no page path is sent as `/`. Null on a page that is
 * no Environment's and on your computer. Only a message `parseBuddyContext`
 * takes is ever returned. */
export function buddyContext(facts: BuddyContextFacts): BuddyContext | null {
  const visit = visitOf(facts.shell, hereOf(facts.shell, facts.space));
  if (visit === null) return null;
  const environment = facts.shell.environments.find(
    (entry) => entry.id === visit.environment,
  );
  const kind =
    environment === undefined ? null : buddyContextKind(environment.kind);
  if (environment === undefined || kind === null) return null;
  const lang =
    facts.lang === "cs" || facts.lang === "en"
      ? facts.lang
      : facts.shell.locale;
  const organization =
    visit.organization === null
      ? undefined
      : organizationOf(facts.shell, visit.organization);
  return parseBuddyContext({
    type: buddyMessage.context,
    v: buddyMajor,
    lang,
    theme: facts.theme === "dark" ? "dark" : "light",
    environment: {
      id: environment.id,
      kind,
      name: environmentName(environment, shellMessages(lang)),
    },
    organization:
      organization === undefined
        ? null
        : { slug: organization.slug, name: organization.name },
    app: isOneOf(buddyContextApps, facts.active) ? facts.active : null,
    page: { path: isBuddyPagePath(facts.path) ? facts.path : "/" },
    guide: facts.guide,
  });
}

/** A frame's window, as the host posts to it. */
export type BuddyFrameWindow = Readonly<{
  postMessage(message: unknown, targetOrigin: string): void;
}>;

/** The host's sends of the context (the impure side wires it): after the
 * frame's `ready` always, then on every change only when the context differs
 * from the one sent last; nothing before `ready`, without a frame or a
 * context, and nowhere but the frame's window on exactly Buddy's `origin`. */
export function createBuddyContextSender(
  seams: Readonly<{
    /** Buddy's origin from the page's merged document. */
    origin: string;
    /** The window of the bubble's frame, or null. */
    frame: () => BuddyFrameWindow | null;
    /** The context of the page now (`buddyContext`), or null. */
    context: () => BuddyContext | null;
  }>,
) {
  let ready = false;
  let sent: string | null = null;
  const send = (force: boolean): boolean => {
    if (!ready || !isShellBuddyOrigin(seams.origin)) return false;
    const frame = seams.frame();
    const context = seams.context();
    if (frame === null || context === null) return false;
    const text = JSON.stringify(context);
    if (!force && text === sent) return false;
    try {
      frame.postMessage(context, seams.origin);
    } catch {
      return false;
    }
    sent = text;
    return true;
  };
  return Object.freeze({
    /** The frame is ready (it loaded, or loaded again): it hears the
     * context anew. */
    ready(): boolean {
      ready = true;
      return send(true);
    },
    /** Something the context says may have changed. */
    changed(): boolean {
      return send(false);
    },
    /** The frame is gone: nothing until a frame is ready again. */
    reset(): void {
      ready = false;
      sent = null;
    },
  });
}
