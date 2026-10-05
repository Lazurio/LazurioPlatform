import type { PublicEntry } from "./chat";
import { isHttpsOrigin, isModuleOriginTemplate } from "./hosted-entry";

// The page's side of Chat (launchpad-parity B8) and of Lazurio MausBot
// (DEV-6632): which link it shows, taken as the server answered it. The page
// composes no origin; it only accepts one that has the shape the recorded
// entry allows, and a pairing link only on that same origin.

/** The answer of `GET /api/entry`: the recorded entry's public parts, or
 * null (a workstation, or an answer of any other shape). */
export function parseEntryAnswer(value: unknown): PublicEntry | null {
  if (typeof value !== "object" || value === null) return null;
  const answer = value as { kind?: unknown; entry?: unknown };
  if (answer.kind !== "entry" || answer.entry === null) return null;
  if (typeof answer.entry !== "object" || answer.entry === undefined)
    return null;
  const entry = answer.entry as Record<string, unknown>;
  if (
    !isHttpsOrigin(entry.launchpadOrigin) ||
    !isHttpsOrigin(entry.t3codeOrigin) ||
    !isModuleOriginTemplate(entry.moduleOriginTemplate) ||
    (entry.mausbotOrigin !== undefined &&
      !isHttpsOrigin(entry.mausbotOrigin)) ||
    (entry.browserOrigin !== undefined && !isHttpsOrigin(entry.browserOrigin))
  )
    return null;
  return Object.freeze({
    launchpadOrigin: entry.launchpadOrigin,
    t3codeOrigin: entry.t3codeOrigin,
    moduleOriginTemplate: entry.moduleOriginTemplate,
    ...(entry.mausbotOrigin === undefined
      ? {}
      : { mausbotOrigin: entry.mausbotOrigin }),
    ...(entry.browserOrigin === undefined
      ? {}
      : { browserOrigin: entry.browserOrigin }),
  });
}

/** The Chat entry of the sidebar: T3 Code's origin, as recorded, or absent
 * (a workstation: T3 Code runs where the operator runs it, as the resident's
 * hidden button, `R:launchpad/public/app.js:2263-2265`). */
export function chatHref(entry: PublicEntry | null): string | null {
  return entry?.t3codeOrigin ?? null;
}

/** The pairing link of `POST /api/chat/pair`, only as T3 Code's own pairing
 * route on the recorded origin: `/pair`, no query, a `token` fragment.
 * Anything else is null, and the page follows the plain origin instead. */
export function chatPairLink(
  value: unknown,
  t3codeOrigin: string,
): string | null {
  return pairLink(
    value,
    "chat-link",
    t3codeOrigin,
    /^#token=[A-Za-z0-9_-]{8,128}$/,
  );
}

/** The Lazurio MausBot entry of the sidebar (DEV-6632): its origin, as
 * recorded, or absent (no MausBot on this Machine, or a workstation). */
export function mausbotHref(entry: PublicEntry | null): string | null {
  return entry?.mausbotOrigin ?? null;
}

/** The pairing link of `POST /api/mausbot/pair`, only as OpenMausBot's own
 * pairing route on the recorded origin: `/pair`, no query, a `code`
 * fragment. Anything else is null, and the page follows the plain origin. */
export function mausbotPairLink(
  value: unknown,
  mausbotOrigin: string,
): string | null {
  return pairLink(
    value,
    "mausbot-link",
    mausbotOrigin,
    /^#code=[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/,
  );
}

function pairLink(
  value: unknown,
  kind: string,
  origin: string,
  fragment: RegExp,
): string | null {
  if (typeof value !== "object" || value === null) return null;
  const answer = value as { kind?: unknown; url?: unknown };
  if (answer.kind !== kind || typeof answer.url !== "string") return null;
  try {
    const url = new URL(answer.url);
    if (
      url.origin !== origin ||
      url.pathname !== "/pair" ||
      url.search ||
      url.username ||
      url.password ||
      !fragment.test(url.hash) ||
      url.href !== answer.url
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}

/** The answer of `GET /api/chat/prompt-handoff`: whether Chat on this
 * Environment takes a prepared prompt by link (Lazurio/t3code#35). Any
 * other answer is no, and "+ Nový modul" copies the prompt instead. */
export function parsePromptHandoff(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { kind?: unknown }).kind === "chat-prompt-handoff" &&
    (value as { accepted?: unknown }).accepted === true
  );
}

/** A prepared prompt as a link names it: its id and the Organization's
 * GitHub login, never its text (`GET /.lazurio/prompts/<id>?org=<login>`). */
export type PromptLink = Readonly<{ id: string; organization: string }>;

const promptId = /^[a-z][a-z0-9-]{0,63}$/;
const githubLogin = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;

/** Chat's address with a prepared prompt for the T3 Code fork
 * (Lazurio/t3code#35): the pairing link, or Chat's plain origin, with
 * `lazurio-prompt=<id>` and `lazurio-org=<login>` added to its fragment.
 * The fragment never reaches a server or a log, the pairing token stays as
 * it was, and a T3 Code without the hand-off ignores both. Null for an
 * address that is not on Chat's recorded origin, or a prompt outside the
 * grammar. */
export function chatPromptHref(
  href: string,
  t3codeOrigin: string,
  prompt: PromptLink,
): string | null {
  if (!promptId.test(prompt.id) || !githubLogin.test(prompt.organization))
    return null;
  try {
    const url = new URL(href);
    if (url.origin !== t3codeOrigin || url.username || url.password)
      return null;
    const fragment = new URLSearchParams(url.hash.slice(1));
    fragment.set("lazurio-prompt", prompt.id);
    fragment.set("lazurio-org", prompt.organization);
    url.hash = fragment.toString();
    return url.href;
  } catch {
    return null;
  }
}
