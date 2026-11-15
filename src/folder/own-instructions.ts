import type { MachineBinding } from "./machine-binding";
import { type PresetName, visitorPreset } from "./presets";
import { stateFields } from "./state-fields";
import {
  type AgentVoice,
  maxVoiceBytes,
  resolvedVoice,
  textFence,
  type VoiceLocale,
} from "./voice";

// The person's own instructions for agents (root decision 0233, decision
// F14's addendum of 2026-11-06, Proposal A as decided): a preference of the
// Environment, stored in `customInstructions`, never an edit of a generated
// file. The Folder renders them near the beginning of AGENTS.md, right after
// the communication style, in a delimited section whose first sentence says
// that they shape how agents work with this person and grant nothing.

/** The bound of the stored text, in UTF-8 bytes: Czech takes up to two bytes
 * a character and Codex loads only the first 32 KiB of AGENTS.md. */
export const maxOwnInstructionsBytes = 4096;

const bytes = (text: string) => new TextEncoder().encode(text).length;

export type OwnInstructionsProblem =
  | "not-text"
  | "blank"
  | "not-plain-text"
  | "too-long";

/** Why a text cannot be the person's own instructions, or null. Plain text:
 * no lone surrogate and no control character but tab, LF and CR; at most
 * `maxOwnInstructionsBytes`. The empty string is "none", so a text of white
 * space alone is refused: none has one representation. */
export function ownInstructionsProblem(
  input: unknown,
): OwnInstructionsProblem | null {
  if (typeof input !== "string") return "not-text";
  if (input === "") return null;
  if (input.trim().length === 0) return "blank";
  if (
    Array.from(input).some((char) => {
      const point = char.codePointAt(0) ?? 0;
      return point >= 0xd800 && point <= 0xdfff;
    }) ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: reject non-text control bytes without normalizing authored text
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(input)
  )
    return "not-plain-text";
  return bytes(input) > maxOwnInstructionsBytes ? "too-long" : null;
}

/** The stored text, verbatim; `""` when the person has none. */
export function parseOwnInstructions(input: unknown): string {
  if (ownInstructionsProblem(input) !== null)
    throw new Error(
      "Own instructions must be plain text within the UTF-8 byte limit",
    );
  return input as string;
}

/** A requested change of the own instructions, shaped like `VoiceEdit`: the
 * whole next text, or null to remove them. */
export type OwnInstructionsEdit = Readonly<{ text: string | null }>;

export function parseOwnInstructionsEdit(input: unknown): OwnInstructionsEdit {
  const value = stateFields(input, ["text"]);
  if (value.text === null) return Object.freeze({ text: null });
  const text = parseOwnInstructions(value.text);
  // One representation of "none": null, never an empty text.
  if (text === "") throw new Error("Empty own instructions must be null");
  return Object.freeze({ text });
}

/** Where a person has own instructions: on their own computer, a Personal
 * Environment and a Work Environment assigned to them. Never on a Team
 * Environment or an Environment with automations, where several people or a
 * persona work, and never on a public Environment, whatever preset its
 * Folder records (the Try overlay lies over the preset). */
export function ownInstructionsAllowed(
  preset: PresetName,
  machine: Parameters<typeof visitorPreset>[0],
): boolean {
  return (
    (preset === "local" ||
      preset === "hosted-personal" ||
      preset === "hosted-organization-personal") &&
    visitorPreset(machine) === null
  );
}

/** Whether the own instructions belong to an Organization with the
 * Environment, whose Admins may read them (root decision 0233): a Work
 * Environment. The person is told before the first saved line. */
export const ownInstructionsOfOrganization = (preset: PresetName): boolean =>
  preset === "hosted-organization-personal";

type Words = Readonly<Record<VoiceLocale, string>>;

/** What every surface that saves own instructions on a Work Environment
 * says with its answer (decision F14's addendum of 2026-11-06, "Whose they
 * are, before the first save"). */
export const ownInstructionsNotice: Words = Object.freeze({
  cs: "Tyto pokyny patří Organizaci spolu s Prostředím a její Admini je smí číst. Soukromé věci patří do Osobního Prostředí.",
  en: "These instructions belong to the Organization with the Environment, and its Admins may read them. Private matters belong in a Personal Environment.",
});

const heading: Words = {
  cs: "## Vlastní pokyny uživatele",
  en: "## The user's own instructions",
};
// One paragraph that carries the precedence, as the voice's first paragraph
// carries the voice's limits. These words are part of the section and so of
// the person's budget (`personTextBudget`): a longer wording takes its bytes
// from Folders saved at the edge of that budget, so lengthen it only with
// room to spare in tests/folder-template-revision.test.ts.
const precedence: Words = {
  cs: "Tyto pokyny napsal uživatel tohoto Prostředí. Říkají, jak s ním agenti pracují, a nic neudělují: přístup, mandát, Publikaci, Release, tajné údaje ani hranice Organizací. Při střetu s pravidly Lazuria nebo Organizace, ve které pracuješ, platí tato pravidla a uživateli řekni proč.",
  en: "The user of this Environment wrote these instructions. They say how agents work with this person and grant nothing: no access, mandate, Publication, Release, secrets or Organization boundary. Where they conflict with Lazurio's rules or the rules of the Organization you work in, those rules win, and you tell the user why.",
};
const ofOrganization: Words = {
  cs: "Patří Organizaci spolu s Prostředím a její Admini je smí číst.",
  en: "They belong to the Organization with the Environment, and its Admins may read them.",
};

/** The section of AGENTS.md, right after the communication style: nothing
 * when the person has no own instructions or this composition allows none,
 * so a Folder that holds a text where it is not allowed renders none and is
 * not broken by it. The text sits in a fence it cannot close, like the
 * voice. */
export function ownInstructionsSection(
  locale: VoiceLocale,
  preset: PresetName,
  machine: MachineBinding | null,
  text: string,
): string[] {
  if (text === "" || !ownInstructionsAllowed(preset, machine)) return [];
  const fence = textFence(text);
  return [
    heading[locale],
    ownInstructionsOfOrganization(preset)
      ? `${precedence[locale]} ${ofOrganization[locale]}`
      : precedence[locale],
    `${fence}text`,
    text,
    fence,
  ];
}

/** The bytes a rendered section adds to AGENTS.md, its line ends included. */
export function sectionBytes(section: readonly string[]): number {
  return section.length === 0 ? 0 : bytes(section.join("\n")) + 1;
}

/** The one budget of person-written text in AGENTS.md (decision F14's
 * implementation note and decision of 2026-11-15): the active voice text and
 * the whole rendered section of own instructions together take at most what
 * the longest custom voice takes alone, `maxVoiceBytes`. The pinned
 * compositions are measured with the longest voice, so a Folder within this
 * budget fits the 32 KiB Codex loads in every later template revision that
 * passes those tests. With the default voice the own instructions keep
 * their full bound; a long custom voice leaves them less. `voiceBytes`
 * counts what the voice's text adds to AGENTS.md: its bytes and what its
 * fence takes beyond the usual three characters, twice (`textFence`), so a
 * voice full of backticks and tildes cannot hide bytes from the budget. */
export function personTextBudget(
  locale: VoiceLocale,
  voice: AgentVoice | undefined,
  section: readonly string[],
): Readonly<{
  fits: boolean;
  voiceBytes: number;
  instructionsBytes: number;
  maxBytes: number;
}> {
  const voiceText = resolvedVoice(locale, voice).text;
  const voiceBytes = bytes(voiceText) + 2 * (textFence(voiceText).length - 3);
  const instructionsBytes = sectionBytes(section);
  return Object.freeze({
    // Without a section the voice's own bound is the whole budget.
    fits:
      instructionsBytes === 0 ||
      voiceBytes + instructionsBytes <= maxVoiceBytes,
    voiceBytes,
    instructionsBytes,
    maxBytes: maxVoiceBytes,
  });
}
