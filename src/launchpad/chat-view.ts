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
    (entry.mausbotOrigin !== undefined && !isHttpsOrigin(entry.mausbotOrigin))
  )
    return null;
  return Object.freeze({
    launchpadOrigin: entry.launchpadOrigin,
    t3codeOrigin: entry.t3codeOrigin,
    moduleOriginTemplate: entry.moduleOriginTemplate,
    ...(entry.mausbotOrigin === undefined
      ? {}
      : { mausbotOrigin: entry.mausbotOrigin }),
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
