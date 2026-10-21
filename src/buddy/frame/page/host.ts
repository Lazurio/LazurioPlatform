import {
  type EnvironmentKind,
  environmentKinds,
  isEnvironmentId,
  isExplainerId,
  isPagePath,
  type PageApp,
  type PageContext,
  pageApps,
} from "../../contract/runtime";
import { hostEnvironmentOf } from "../hosts";

// The frame's side of the host protocol `lazurio.buddy.*` v1 (buddy-web-v1
// CONTRACT section 2; the host's side is the shell's
// `src/shell/buddy-protocol.ts`, built apart and reconciled against this
// text):
//
//   frame → host: {type: "lazurio.buddy.ready", v: 1}
//                 {type: "lazurio.buddy.layout", v: 1, mode: "panel" | "fullscreen" | "closed"}
//   host → frame: {type: "lazurio.buddy.context", v: 1, lang, theme,
//                  environment: {id, kind, name} | null,
//                  organization: {slug, name} | null, app, page: {path},
//                  guide: {explainer, step} | null}
//
// The frame takes a context only when all of these hold (`acceptContext`):
//   1. it comes from the frame's parent window, and the frame is framed;
//   2. its origin is exactly the host origin the frame read at its load
//      (`hostOriginAtLoad` in hosts.ts) and that origin may host the frame
//      (`hostEnvironmentOf`);
//   3. its keys are exactly the ones above, at every level, in plain
//      objects: a member more refuses the whole message;
//   4. its strings are bounded and its enums closed: `lang` cs or en,
//      `theme` light or dark, `kind` personal, work or team, `app` apps,
//      settings, chat, automate or null;
//   5. `environment.id` is the Environment of the host's origin, so a page
//      cannot claim to be another Environment.
// Anything refused is dropped without an answer, and the frame works
// without context. It keeps only the last context, in memory. Messages to
// the host go only to its exact origin, never `*`. Pure: no DOM.

export const buddyMessage = Object.freeze({
  ready: "lazurio.buddy.ready",
  layout: "lazurio.buddy.layout",
  context: "lazurio.buddy.context",
});

export type Layout = "panel" | "fullscreen" | "closed";
export type Lang = "cs" | "en";
export type Theme = "light" | "dark";

/** The context the host sends: the page's context and how to show it. */
export type HostContext = Readonly<{
  lang: Lang;
  theme: Theme;
  context: PageContext;
}>;

export const readyMessage = () =>
  Object.freeze({ type: buddyMessage.ready, v: 1 });

export const layoutMessage = (mode: Layout) =>
  Object.freeze({ type: buddyMessage.layout, v: 1, mode });

type Data = Readonly<Record<string, unknown>>;

function plain(value: unknown): value is Data {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactly(value: Data, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return (
    own.length === keys.length && keys.every((key) => Object.hasOwn(value, key))
  );
}

function line(value: unknown, max: number): value is string {
  if (typeof value !== "string" || value.trim() === "") return false;
  if ([...value].length > max) return false;
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f || (code >= 0xd800 && code <= 0xdfff))
      return false;
  }
  return true;
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

/** A message event as the frame sees it: its data and origin, and whether
 * its source is the frame's parent window. */
export type HostEvent = Readonly<{
  data: unknown;
  origin: string;
  fromParent: boolean;
}>;

/** The context of a message from the host, or null to drop it. */
export function acceptContext(
  event: HostEvent,
  frameOrigin: string,
  hostOrigin: string | null,
): HostContext | null {
  if (!event.fromParent || hostOrigin === null) return null;
  if (event.origin !== hostOrigin) return null;
  const hostEnvironment = hostEnvironmentOf(frameOrigin, hostOrigin);
  if (hostEnvironment === null) return null;
  const data = event.data;
  if (!plain(data) || !exactly(data, contextKeys)) return null;
  if (data.type !== buddyMessage.context || data.v !== 1) return null;
  if (data.lang !== "cs" && data.lang !== "en") return null;
  if (data.theme !== "light" && data.theme !== "dark") return null;
  const environment = data.environment;
  if (
    !plain(environment) ||
    !exactly(environment, ["id", "kind", "name"]) ||
    !isEnvironmentId(environment.id) ||
    environment.id !== hostEnvironment ||
    !environmentKinds.includes(environment.kind as EnvironmentKind) ||
    !line(environment.name, 128)
  )
    return null;
  const organization = data.organization;
  if (
    organization !== null &&
    (!plain(organization) ||
      !exactly(organization, ["slug", "name"]) ||
      !line(organization.slug, 128) ||
      organization.slug.trim() !== organization.slug ||
      !line(organization.name, 128))
  )
    return null;
  if (data.app !== null && !pageApps.includes(data.app as PageApp)) return null;
  const page = data.page;
  if (!plain(page) || !exactly(page, ["path"]) || !isPagePath(page.path))
    return null;
  const guide = data.guide;
  if (
    guide !== null &&
    (!plain(guide) ||
      !exactly(guide, ["explainer", "step"]) ||
      !isExplainerId(guide.explainer) ||
      typeof guide.step !== "number" ||
      !Number.isInteger(guide.step) ||
      guide.step < 0 ||
      guide.step > 63)
  )
    return null;
  return Object.freeze({
    lang: data.lang,
    theme: data.theme,
    context: Object.freeze({
      environment: Object.freeze({
        id: environment.id,
        kind: environment.kind as EnvironmentKind,
        name: environment.name,
      }),
      organization:
        organization === null
          ? null
          : Object.freeze({
              slug: (organization as Data).slug as string,
              name: (organization as Data).name as string,
            }),
      app: data.app as PageApp | null,
      page: Object.freeze({ path: page.path }),
      guide:
        guide === null
          ? null
          : Object.freeze({
              explainer: (guide as Data).explainer as string,
              step: (guide as Data).step as number,
            }),
    }),
  });
}
