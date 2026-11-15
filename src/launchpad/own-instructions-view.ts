import {
  ownInstructionsNotice,
  ownInstructionsProblem,
} from "../folder/own-instructions";
import { textFence, type VoiceLocale } from "../folder/voice";
import type { MessageKey } from "./messages";

// Settings → Komunikace agentů → „Vlastní pokyny pro agenty“ (root decision
// 0233, decision F14's addendum of 2026-11-06, Proposal A as decided): the
// model of the form own-instructions-panel.ts draws, of what a save answered
// and of the link „Poslat Lazuriu jako podnět“. Pure and free of Node, so
// the page and the tests share it.

type Copy = Readonly<Record<MessageKey, string>>;

/** What `POST /api/profile` says of the own instructions of this
 * Environment. Where `allowed` is false the server sends no text. */
export type OwnInstructionsView = Readonly<{
  allowed: boolean;
  ofOrganization: boolean;
  text: string;
  bytes: number;
  maxBytes: number;
}>;

/** The `ownInstructions` member of the profile answer, or null when it is
 * not one: the page then draws no form, as where there are none. */
export function parseOwnInstructionsView(
  value: unknown,
): OwnInstructionsView | null {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return null;
  const { allowed, ofOrganization, text, bytes, maxBytes } = value as Readonly<
    Record<string, unknown>
  >;
  if (
    typeof allowed !== "boolean" ||
    typeof ofOrganization !== "boolean" ||
    typeof text !== "string" ||
    typeof bytes !== "number" ||
    typeof maxBytes !== "number" ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1
  )
    return null;
  return Object.freeze({ allowed, ofOrganization, text, bytes, maxBytes });
}

/** What the bound counts: UTF-8 bytes, never characters. Czech takes up to
 * two bytes a character. */
export const utf8Bytes = (text: string): number =>
  new TextEncoder().encode(text).length;

export type OwnInstructionsDraft = {
  /** What is saved, as the profile was last read. */
  saved: OwnInstructionsView;
  /** What the form holds. */
  text: string;
  /** Not null while the person has yet to choose between this text and one
   * saved elsewhere in the meantime (an agent's `lazurio folder instructions
   * add`, another tab): `saved` is then that other text, and `base` is the
   * saved text this draft was started from. Nothing is saved before the
   * choice. */
  conflict: Readonly<{ base: string }> | null;
};
export const ownInstructionsDirty = (draft: OwnInstructionsDraft): boolean =>
  draft.text !== draft.saved.text;

/** What a profile reload makes of the form, an ordinary one and the one
 * after a refused save alike. An untouched form takes the saved text. A text
 * being written stays, and where the saved text is no longer the one it was
 * started from, the draft is in conflict: it keeps the person's text next to
 * the saved one until the person chooses, so that a save never replaces a
 * text the person has not seen. Only the revision moved (a tools change, a
 * change of the voice): the draft goes on as it was. The saved text is the
 * person's text already: there is nothing to choose and the form is clean.
 * The same rules hold for a reload during a conflict, against the text the
 * draft was started from. */
export function reconcileOwnInstructions(
  saved: OwnInstructionsView,
  draft?: OwnInstructionsDraft,
): OwnInstructionsDraft {
  const clean = { saved, text: saved.text, conflict: null };
  if (draft === undefined || draft.text === saved.text) return clean;
  if (draft.conflict === null && !ownInstructionsDirty(draft)) return clean;
  const base = draft.conflict?.base ?? draft.saved.text;
  return {
    saved,
    text: draft.text,
    conflict: saved.text === base ? null : { base },
  };
}

const fill = (text: string, values: Readonly<Record<string, number>>) =>
  text.replace(/\{([A-Za-z]+)\}/gu, (whole, name: string) =>
    Object.hasOwn(values, name) ? String(values[name]) : whole,
  );

/** Why the draft cannot be saved as it is, in one sentence, or null. The
 * empty draft is "none" and is saved as a removal. */
function draftProblem(draft: OwnInstructionsDraft, copy: Copy): string | null {
  const { maxBytes } = draft.saved;
  const problem = ownInstructionsProblem(draft.text);
  if (problem === "too-long" || utf8Bytes(draft.text) > maxBytes)
    return fill(copy.ownTooLong, { maxBytes });
  if (problem === "not-plain-text") return copy.ownNotPlain;
  if (problem === "blank") return copy.ownBlank;
  return null;
}

/** The form as it is drawn. */
export type OwnInstructionsForm = Readonly<{
  /** Whose the instructions are, on a Work Environment: there from the
   * first drawing, before anything is saved. The core's words. */
  notice: string | null;
  /** „N z 4096 bajtů“. */
  count: string;
  /** The draft is over the bound: the counter is an error. */
  over: boolean;
  /** The inline error, or null. */
  problem: string | null;
  /** The text saved elsewhere that the person has yet to choose against
   * (empty: the saved instructions were removed), or null. While it is
   * there, nothing can be saved or removed. */
  conflict: string | null;
  /** Which buttons can be pressed. */
  save: boolean;
  cancel: boolean;
  remove: boolean;
}>;

/** The form for one draft, or null where this Environment has no own
 * instructions (a Team Environment, an Environment with automations, a
 * public one): nothing of it is drawn there. */
export function ownInstructionsForm(
  draft: OwnInstructionsDraft,
  state: Readonly<{ busy: boolean; needsRefresh: boolean }>,
  locale: VoiceLocale,
  copy: Copy,
): OwnInstructionsForm | null {
  if (!draft.saved.allowed) return null;
  const bytes = utf8Bytes(draft.text);
  const problem = draftProblem(draft, copy);
  const dirty = ownInstructionsDirty(draft);
  const conflict = draft.conflict !== null;
  return Object.freeze({
    notice: draft.saved.ofOrganization ? ownInstructionsNotice[locale] : null,
    count: fill(copy.ownCount, { bytes, maxBytes: draft.saved.maxBytes }),
    over: bytes > draft.saved.maxBytes,
    problem,
    conflict: conflict ? draft.saved.text : null,
    save:
      !state.busy &&
      !state.needsRefresh &&
      !conflict &&
      dirty &&
      problem === null,
    // In a conflict Cancel takes the saved text, as „Použít uložené znění“.
    cancel: !state.busy && dirty,
    remove: !state.busy && !conflict && draft.text !== "",
  });
}

const sizes = ["voiceBytes", "instructionsBytes", "maxBytes"] as const;

/** The sentence of `person-text-too-large` with its three sizes, for the
 * voice form and this one: the custom voice and the own instructions share
 * one budget. Null when the answer is not that refusal with its sizes. */
export function personTextTooLarge(value: unknown, copy: Copy): string | null {
  if (typeof value !== "object" || value === null) return null;
  const answer = value as Readonly<Record<string, unknown>>;
  if (answer.reason !== "person-text-too-large") return null;
  const numbers: Record<string, number> = {};
  for (const name of sizes) {
    const size = answer[name];
    if (typeof size !== "number" || !Number.isSafeInteger(size)) return null;
    numbers[name] = size;
  }
  return fill(copy.personTextTooLarge, numbers);
}

/** What a save answered, as the form says it. `needsRefresh` is the voice
 * form's rule: the page's revision or kind is no longer the Folder's, so
 * nothing is saved again before the current settings are loaded. A text
 * that is refused for its size needs no reload, only a shorter text. */
export function ownInstructionsOutcome(
  ok: boolean,
  value: unknown,
  removed: boolean,
  maxBytes: number,
  copy: Copy,
): Readonly<{ saved: boolean; notice: string; needsRefresh: boolean }> {
  const answer =
    typeof value === "object" && value !== null
      ? (value as Readonly<Record<string, unknown>>)
      : {};
  if (ok && (answer.kind === "updated" || answer.kind === "unchanged"))
    return {
      saved: true,
      notice: removed ? copy.ownRemoved : copy.ownSaved,
      needsRefresh: false,
    };
  const refused = (notice: string, needsRefresh = false) => ({
    saved: false,
    notice,
    needsRefresh,
  });
  const budget = personTextTooLarge(value, copy);
  if (budget !== null) return refused(budget);
  if (answer.reason === "voice-context-too-large")
    return refused(copy.ownContextLarge);
  if (answer.reason === "own-instructions-unavailable")
    return refused(copy.ownUnavailable, true);
  if (answer.reason === "stale-revision") return refused(copy.voiceStale, true);
  if (answer.error === "invalid-own-instructions") {
    if (answer.problem === "too-long")
      return refused(fill(copy.ownTooLong, { maxBytes }));
    if (answer.problem === "not-plain-text") return refused(copy.ownNotPlain);
    if (answer.problem === "blank") return refused(copy.ownBlank);
  }
  return refused(copy.voiceFailed, true);
}

// „Poslat Lazuriu jako podnět“ (the decision's "explicit choice on each
// save, never automatic"): a link to GitHub's new-issue form of this
// product's public repository, filled with the saved text. The product
// sends nothing: the person's browser opens the form and the person submits
// it there under their own sign-in. The issue is written in English, the
// repository's language, whatever the page's.
export const suggestionIssues =
  "https://github.com/Lazurio/LazurioPlatform/issues/new";
export const suggestionTitle = "Own instructions as a product suggestion";
const suggestionLead =
  "I chose to share the own instructions for agents that I saved in Lazurio's Settings as a product suggestion.";
export const suggestionTruncated =
  "[… truncated: the saved text is longer than this link can carry]";
/** The longest address the link may be: what browsers and GitHub take
 * without cutting it. */
export const suggestionUrlLimit = 7000;

function suggestionUrl(text: string, truncated: boolean): string {
  // A fence the text cannot close, as the Folder renders it.
  const fence = textFence(text);
  const body = [
    suggestionLead,
    "",
    `${fence}text`,
    text,
    fence,
    ...(truncated ? ["", suggestionTruncated] : []),
  ].join("\n");
  return `${suggestionIssues}?title=${encodeURIComponent(suggestionTitle)}&body=${encodeURIComponent(body)}`;
}

/** The link for one saved text. A text whose address would be longer than
 * `suggestionUrlLimit` (Czech takes six characters of an address for one of
 * its letters) is cut at a whole character to the longest beginning that
 * fits, and the issue says so in a line after the text. */
export function suggestionLink(
  text: string,
): Readonly<{ href: string; truncated: boolean }> {
  const whole = suggestionUrl(text, false);
  if (whole.length <= suggestionUrlLimit)
    return Object.freeze({ href: whole, truncated: false });
  // By code points: a pair of surrogates is never split.
  const points = Array.from(text);
  let fits = 0;
  let over = points.length;
  while (over - fits > 1) {
    const middle = Math.floor((fits + over) / 2);
    if (
      suggestionUrl(points.slice(0, middle).join(""), true).length <=
      suggestionUrlLimit
    )
      fits = middle;
    else over = middle;
  }
  return Object.freeze({
    href: suggestionUrl(points.slice(0, fits).join(""), true),
    truncated: true,
  });
}
