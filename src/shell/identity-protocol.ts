import {
  acceptIdentityReply as acceptReply,
  browserMessage,
  identityReplyMessage,
  identityRequestOf as requestOf,
} from "../browser/contract/pure";
import { isEnvironmentId, isShellUrl } from "./contract";
import type { EnvironmentGlyph, EnvironmentIdentity } from "./view";

// How the Environment browser's view learns how the shell names its
// Environment (F39's addendum of 2026-10-12). The view (another origin, in a
// frame of an app's right panel) cannot read the person's account, which
// only the apps' origins relay; the app around it can. So the view asks its
// parent, and the shell library on the parent's page answers from its merged
// state, without a line of the app's own code: `defineShellElements`
// installs the answer wherever `/.lazurio/shell.js` runs. Unframed, the view
// draws the identity its own server put into the page, from the same
// producer and the same `environmentIdentity` (src/browser/people).
//
//   view → host: {type: "lazurio-browser:identity-request", v: 1}
//   host → view: {type: "lazurio-browser:identity", v: 1, identity}
//
// The messages, who may send them and their major are the Environment
// browser's contract (C9, src/browser/contract): the host answers only a
// frame of its own page on an origin of a view, about that origin's
// Environment, posting to exactly that origin; it answers again whenever its
// answer changes (the account arrives later). The view takes an answer only
// from its parent window, on its parent's origin. What the answer says is
// the shell's: `identity` is an `EnvironmentIdentity` or null (the host does
// not know that Environment), display words, an Organization's avatar
// address and initials, nothing else, and the view takes it only about its
// own Environment. Pure: no DOM, shared by the shell, the view and their
// tests.

export const identityMessage = Object.freeze({
  request: browserMessage.identityRequest,
  reply: browserMessage.identity,
});

/** The id of the element of the view page that carries its own identity:
 * `<script type="application/json">` with `identityJson`. */
export const viewIdentityElementId = "lazurio-environment-identity";

type Data = Readonly<Record<string, unknown>>;
const isRecord = (value: unknown): value is Data =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Display text: at most `max` characters, none of them a control
 * character, as the shell document's text. */
const display = (value: unknown, max: number): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= max &&
  ![...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  });

const glyphIcons: readonly string[] = ["laptop", "user", "users", "bot"];

/** A glyph of these three kinds and their exact members, or null. */
export function parseEnvironmentGlyph(value: unknown): EnvironmentGlyph | null {
  if (!isRecord(value)) return null;
  switch (value.kind) {
    case "avatar":
      return display(value.organization, 128) &&
        (value.avatar === null || isShellUrl(value.avatar)) &&
        display(value.initials, 8)
        ? Object.freeze({
            kind: "avatar",
            organization: value.organization,
            avatar: value.avatar as string | null,
            initials: value.initials,
          })
        : null;
    case "initials":
      return display(value.text, 8)
        ? Object.freeze({ kind: "initials", text: value.text })
        : null;
    case "icon":
      return typeof value.icon === "string" && glyphIcons.includes(value.icon)
        ? Object.freeze({
            kind: "icon",
            icon: value.icon as "laptop" | "user" | "users" | "bot",
          })
        : null;
    default:
      return null;
  }
}

/** An identity: an Environment id, its name and who line as the shell
 * document's text (the who line empty where the name already says the kind,
 * `environmentWho`), and its glyph; null for anything else. Members a later
 * version may add are ignored. */
export function parseEnvironmentIdentity(
  value: unknown,
): EnvironmentIdentity | null {
  if (!isRecord(value)) return null;
  const glyph = parseEnvironmentGlyph(value.glyph);
  if (
    !isEnvironmentId(value.id) ||
    !display(value.name, 128) ||
    !(value.who === "" || display(value.who, 128)) ||
    glyph === null
  )
    return null;
  return Object.freeze({
    id: value.id,
    name: value.name,
    who: value.who,
    glyph,
  });
}

/** An identity as the text of a `<script type="application/json">`: JSON
 * in which every `<` is escaped, so nothing in a name ends or opens an
 * element, and so are the line and paragraph separators (the boot
 * document's rule). `JSON.parse` reads it back unchanged. */
export function identityJson(identity: EnvironmentIdentity): string {
  return JSON.stringify(identity)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/** The identity a page carries (`identityJson`), or null: none, not JSON,
 * not an identity. */
export function parseEmbeddedIdentity(
  text: string | null | undefined,
): EnvironmentIdentity | null {
  if (!text) return null;
  try {
    return parseEnvironmentIdentity(JSON.parse(text));
  } catch {
    return null;
  }
}

/** Whether `source` is the window of a frame of the page whose window is
 * `self`: its parent is that window. A frame's window answers `parent` on
 * any origin; a port or a worker has none. Wherever the frame stands in the
 * page (a shadow root too), its window's parent is the page's. */
function frameOf(source: unknown, self: unknown): boolean {
  if (typeof source !== "object" || source === null || source === self)
    return false;
  try {
    return (source as { parent?: unknown }).parent === self;
  } catch {
    return false;
  }
}

/** The host's side: the Environment a request asks about, or null. A
 * request counts only from a frame of this page (`self`) on a view's
 * origin, and it asks about that origin's Environment, never another (the
 * contract's `identityRequestOf`). */
export function identityRequestOf(
  event: Readonly<{ data: unknown; origin: string; source: unknown }>,
  self: unknown,
): string | null {
  return requestOf({
    data: event.data,
    origin: event.origin,
    fromFrame: frameOf(event.source, self),
  });
}

/** A frame's window, as the host answers it. */
export type IdentityFrame = Readonly<{
  postMessage(message: unknown, targetOrigin: string): void;
  readonly closed?: boolean;
}>;

/** The most frames the host keeps answering; the earliest asker goes
 * first. A panel shows one view at a time, a few at most. */
export const maxIdentityFrames = 32;

/** The host's answers (installed by `defineShellElements`): each request of
 * a frame on a view's origin is answered at once with what the page knows,
 * the identity of that origin's Environment or null, posted to exactly that
 * origin; each change of the page's state answers every frame that asked
 * again, where its answer changed. A frame that asks again (a new page in
 * it) hears the answer anew; a closed one is forgotten. */
export function createIdentityResponder(
  seams: Readonly<{
    /** The page's own window. */
    self: unknown;
    /** The identity of an Environment from the page's merged state; null
     * where the page does not know it. */
    identity: (environment: string) => EnvironmentIdentity | null;
    /** Reads the page's documents, unless that is done or the host
     * provides them. */
    request: () => void;
  }>,
) {
  type Asked = { origin: string; environment: string; sent: string | null };
  const asked = new Map<IdentityFrame, Asked>();
  const answer = (frame: IdentityFrame, entry: Asked) => {
    const identity = seams.identity(entry.environment);
    const sent = JSON.stringify(identity);
    if (sent === entry.sent) return;
    entry.sent = sent;
    try {
      frame.postMessage(identityReplyMessage(identity), entry.origin);
    } catch {}
  };
  return Object.freeze({
    /** A message to the page's window. */
    receive(
      event: Readonly<{ data: unknown; origin: string; source: unknown }>,
    ): void {
      const environment = identityRequestOf(event, seams.self);
      if (environment === null) return;
      const frame = event.source as IdentityFrame;
      asked.delete(frame);
      if (asked.size >= maxIdentityFrames) {
        const [earliest] = asked.keys();
        if (earliest !== undefined) asked.delete(earliest);
      }
      const entry: Asked = { origin: event.origin, environment, sent: null };
      asked.set(frame, entry);
      seams.request();
      answer(frame, entry);
    },
    /** The page's state changed. */
    changed(): void {
      for (const [frame, entry] of asked) {
        if (frame.closed === true) asked.delete(frame);
        else answer(frame, entry);
      }
    },
  });
}

/** The view's side: an answer of its parent, or null. It counts only from
 * the parent window (`fromParent`), on the parent's origin as the browser
 * names it (`location.ancestorOrigins`, `ancestor`) or, where it names none,
 * on an app origin of an Environment (`https://<app>.<base>.lazurio.io`, the
 * only pages the view's `frame-ancestors` admits), as the contract takes it
 * (`acceptIdentityReply`); and only about the view's own Environment (`own`,
 * its origin's), or none (the host does not know it). It keeps the majors
 * the app's own message parser reads, which the view sends its messages in
 * (`messageMajor`; null where the app names none). */
export function acceptIdentityReply(
  event: Readonly<{ data: unknown; origin: string; fromParent: boolean }>,
  ancestor: string | null,
  own: string | null,
): Readonly<{
  identity: EnvironmentIdentity | null;
  majors: readonly number[] | null;
}> | null {
  const reply = acceptReply(event, ancestor);
  if (reply === null) return null;
  if (reply.identity === null)
    return Object.freeze({ identity: null, majors: reply.majors });
  const identity = parseEnvironmentIdentity(reply.identity);
  return identity === null || own === null || identity.id !== own
    ? null
    : Object.freeze({ identity, majors: reply.majors });
}
