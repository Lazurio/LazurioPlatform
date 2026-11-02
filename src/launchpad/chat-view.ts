import type { PublicEntry } from "./chat";
import { isHttpsOrigin, isModuleOriginTemplate } from "./hosted-entry";
import { isEntryAudience } from "./public-environment";

// The page's side of Chat (launchpad-parity B8) and of Lazurio MausBot
// (DEV-6632): which link it shows, taken as the server answered it. The page
// composes no origin; it only accepts one that has the shape the recorded
// entry allows. It mints no pairing: since the addendum of 2026-10-31 to the
// decision of 2026-10-17 T3 Code and MausBot pair a browser themselves, and
// a click follows the plain origin.

/** Whether `GET /api/entry` answered that there is no entry: a
 * workstation's answer, which says as surely as an entry does that this is
 * no public Environment. Any other shape says nothing. */
export const isNoEntry = (value: unknown): boolean =>
  typeof value === "object" &&
  value !== null &&
  (value as { kind?: unknown }).kind === "entry" &&
  (value as { entry?: unknown }).entry === null;

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
    (entry.browserOrigin !== undefined &&
      !isHttpsOrigin(entry.browserOrigin)) ||
    (entry.audience !== undefined && !isEntryAudience(entry.audience))
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
    ...(entry.audience === undefined ? {} : { audience: entry.audience }),
  });
}

/** The Chat entry of the sidebar: T3 Code's origin, as recorded, or absent
 * (a workstation: T3 Code runs where the operator runs it, as the resident's
 * hidden button, `R:launchpad/public/app.js:2263-2265`). */
export function chatHref(entry: PublicEntry | null): string | null {
  return entry?.t3codeOrigin ?? null;
}

/** The Lazurio MausBot entry of the sidebar (DEV-6632): its origin, as
 * recorded, or absent (no MausBot on this Machine, or a workstation). */
export function mausbotHref(entry: PublicEntry | null): string | null {
  return entry?.mausbotOrigin ?? null;
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
 * (Lazurio/t3code#35): Chat's plain origin with `lazurio-prompt=<id>` and
 * `lazurio-org=<login>` in its fragment, no pairing token (the addendum of
 * 2026-10-31 to the decision of 2026-10-17). The fork keeps the link in the
 * tab across its own pairing (`captureLazurioPromptLink`). The fragment
 * never reaches a server or a log, and a T3 Code without the hand-off
 * ignores it. Null for an origin that is not one, or a prompt outside the
 * grammar. */
export function chatPromptHref(
  t3codeOrigin: string,
  prompt: PromptLink,
): string | null {
  if (!promptId.test(prompt.id) || !githubLogin.test(prompt.organization))
    return null;
  try {
    const url = new URL(t3codeOrigin);
    if (url.origin !== t3codeOrigin) return null;
    url.hash = new URLSearchParams([
      ["lazurio-prompt", prompt.id],
      ["lazurio-org", prompt.organization],
    ]).toString();
    return url.href;
  } catch {
    return null;
  }
}
