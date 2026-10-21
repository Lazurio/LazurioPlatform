import type { ShellEnvironmentKind } from "./contract";

// How Buddy's bubble asks the host page to explain something in place
// (decision F56; root decision 0180's addendum of 2026-10-18). The bubble is
// a frame served by the person's Personal Environment; it cannot draw
// outside its box or see the host's page. So the host's shell draws the
// guide (guide.ts), and the frame may only ask for an explanation by its id:
//
//   frame → host: {type: "lazurio.guide.play", v: 1, explainer: "<id>"}
//   host → frame: {type: "lazurio.guide.started" | "lazurio.guide.done" |
//                  "lazurio.guide.closed" | "lazurio.guide.busy",
//                  v: 1, explainer, kind?}
//
// The host takes a request only when all of these hold (`acceptGuidePlay`):
//   1. it comes from the window of the bubble's frame on this page;
//   2. its origin is exactly Buddy's origin as the shell's document names it
//      (https, never taken from the message);
//   3. its keys are exactly `type`, `v` and `explainer`: an added member
//      refuses the whole message, it is never just dropped;
//   4. `v` is 1;
//   5. `explainer` is an id (`^[a-z][a-z0-9-]{0,63}$`) the host knows: one of
//      the shell's principles, or an explanation of the page the host shows
//      now;
//   6. nothing plays and the onboarding tour does not want attention; else
//      the host answers `busy` and plays nothing.
// Only the id is copied. No HTML, text, selector or target crosses: the
// content and the elements it points at are the host's. Anything refused is
// dropped without an answer. Every answer goes to exactly Buddy's origin,
// never `*`. `kind` is a value of the shell's kinds, never a text: personal,
// work, team or workstation, an automated Environment counting as work.
//
// The "?" beside a page's heading plays its explanation directly, without a
// message. Buddy's bubble (decision F60, buddy-bubble.ts) wires the receiver
// below where the page's document names Buddy's origin, and its listener
// exists only once the bubble made its frame; this module and its vectors
// (`guide-vectors/v1/guide-protocol.json`) are the contract the frame's
// sender is built against. Pure: no DOM, no I/O.

export const guideMessage = Object.freeze({
  play: "lazurio.guide.play",
  started: "lazurio.guide.started",
  done: "lazurio.guide.done",
  closed: "lazurio.guide.closed",
  busy: "lazurio.guide.busy",
});

/** The protocol's major; a message without `v: 1` is no message of it. */
export const guideMajor = 1;

/** The schema of a vector file of this contract (as decision F50's). */
export const guideVectorsSchema = "lazurio.guide-vectors.v1";

const idPattern = /^[a-z][a-z0-9-]{0,63}$/;

/** An explanation's id, as a request names it and a host registers it. The
 * same grammar names a `data-guide` mark. */
export const isExplanationId = (value: unknown): value is string =>
  typeof value === "string" && idPattern.test(value);

/** Buddy's origin as a document may name it: exactly an https origin, no
 * path, query, fragment or credentials, its host in lower case. */
export function isBuddyOrigin(value: unknown): value is string {
  if (typeof value !== "string" || !value.startsWith("https://")) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.origin === value &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
}

/** The kinds an answer names. */
export type GuideReplyKind = "personal" | "work" | "team" | "workstation";

const replyKinds: Readonly<Record<ShellEnvironmentKind, GuideReplyKind>> = {
  personal: "personal",
  work: "work",
  team: "team",
  automated: "work",
  workstation: "workstation",
};

/** The kind an answer names for an Environment of `kind`: an automated one
 * is work; none for anything else. */
export const guideReplyKind = (kind: unknown): GuideReplyKind | null =>
  typeof kind === "string" && Object.hasOwn(replyKinds, kind)
    ? replyKinds[kind as ShellEnvironmentKind]
    : null;

/** A request as the host sees it: the event's data and origin, and whether
 * its source is the window of the bubble's frame on this page (the impure
 * side compares `event.source` with the frame's `contentWindow`). */
export type GuideRequest = Readonly<{
  data: unknown;
  origin: string;
  fromBuddyFrame: boolean;
}>;

/** What the host knows when a request comes. */
export type GuideHostState = Readonly<{
  /** Buddy's origin from the shell's document; null where there is none. */
  buddyOrigin: string | null;
  /** The ids it can play now: the principles and this page's explanations. */
  known: readonly string[];
  /** The explanation playing now, or null. */
  playing: string | null;
  /** Whether the onboarding tour (Začínáme) wants the person's attention. */
  tour: boolean;
}>;

export type GuideDecision = Readonly<{
  action: "play" | "busy";
  explainer: string;
}>;

const requestKeys = ["explainer", "type", "v"];

/** What the host does with a request: play it, answer `busy`, or (null)
 * drop it without an answer. */
export function acceptGuidePlay(
  request: GuideRequest,
  host: GuideHostState,
): GuideDecision | null {
  if (request.fromBuddyFrame !== true) return null;
  if (!isBuddyOrigin(host.buddyOrigin) || request.origin !== host.buddyOrigin)
    return null;
  const data = request.data;
  if (
    typeof data !== "object" ||
    data === null ||
    Array.isArray(data) ||
    Object.getPrototypeOf(data) !== Object.prototype
  )
    return null;
  const keys = Object.keys(data).sort();
  if (
    keys.length !== requestKeys.length ||
    keys.some((key, at) => key !== requestKeys[at])
  )
    return null;
  const { type, v, explainer } = data as Record<string, unknown>;
  if (type !== guideMessage.play || v !== guideMajor) return null;
  if (!isExplanationId(explainer) || !host.known.includes(explainer))
    return null;
  return Object.freeze({
    action: host.playing !== null || host.tour ? "busy" : "play",
    explainer,
  });
}

export type GuideReplyState = "started" | "done" | "closed" | "busy";

export type GuideReply = Readonly<{
  type: string;
  v: 1;
  explainer: string;
  kind?: GuideReplyKind;
}>;

/** An answer to the frame, with `kind` only where the Environment's kind is
 * known; null for anything that is no answer. */
export function guideReply(
  state: unknown,
  explainer: unknown,
  kind: unknown = null,
): GuideReply | null {
  if (
    (state !== "started" &&
      state !== "done" &&
      state !== "closed" &&
      state !== "busy") ||
    !isExplanationId(explainer)
  )
    return null;
  const named = guideReplyKind(kind);
  return Object.freeze({
    type: guideMessage[state],
    v: guideMajor,
    explainer,
    ...(named === null ? {} : { kind: named }),
  });
}

/** A frame's window, as the host answers it. */
export type GuideFrame = Readonly<{
  postMessage(message: unknown, targetOrigin: string): void;
}>;

/** The host's side, wired by Buddy's bubble (decision F60): a message event
 * to the page's window goes to `receive`, which plays an accepted request or
 * answers `busy`; `reply` answers the frame as an explanation starts, is done
 * or is closed. Every answer is posted to exactly `origin`, and only to the
 * bubble's frame. Nothing here listens: the caller decides whether a
 * listener exists at all. */
export function createGuideReceiver(
  seams: Readonly<{
    /** Buddy's origin from the shell's document. */
    origin: string;
    /** The window of the bubble's frame on this page, or null. */
    frame: () => GuideFrame | null;
    /** The ids the host can play now. */
    known: () => readonly string[];
    playing: () => string | null;
    tour: () => boolean;
    /** The Environment's kind as the shell's document names it. */
    kind: () => ShellEnvironmentKind | null;
    play: (explainer: string) => void;
  }>,
) {
  const reply = (state: GuideReplyState, explainer: string): boolean => {
    const frame = seams.frame();
    const message = guideReply(state, explainer, seams.kind());
    if (frame === null || message === null || !isBuddyOrigin(seams.origin))
      return false;
    try {
      frame.postMessage(message, seams.origin);
      return true;
    } catch {
      return false;
    }
  };
  return Object.freeze({
    receive(
      event: Readonly<{ data: unknown; origin: string; source: unknown }>,
    ): GuideDecision | null {
      const frame = seams.frame();
      const decision = acceptGuidePlay(
        {
          data: event.data,
          origin: event.origin,
          fromBuddyFrame: frame !== null && event.source === frame,
        },
        {
          buddyOrigin: seams.origin,
          known: seams.known(),
          playing: seams.playing(),
          tour: seams.tour(),
        },
      );
      if (decision === null) return null;
      if (decision.action === "busy") reply("busy", decision.explainer);
      else seams.play(decision.explainer);
      return decision;
    },
    reply,
  });
}
