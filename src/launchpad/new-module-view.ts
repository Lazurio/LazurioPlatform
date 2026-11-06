import {
  type NewModuleOffer,
  newModulePrompt,
  newModuleRequestPrompt,
  newPersonalModulePrompt,
} from "./apps-view";
import type { MessageKey } from "./messages";

type Copy = Readonly<Record<MessageKey, string>>;

// Pure presentation of the dialog "+ Nový modul" (decision F36's addendum of
// 2026-11-05): three screens, what a module is, what it should do, and the
// whole brief before it goes to Chat. The same dialog speaks to an
// Organization Admin, to a member, who asks the Organization Admin instead (the Steward
// too), and to the holder of the personal space, who founds a module there.
// new-module-dialog.ts draws it. Nothing here decides who may do what: the
// prompt route asks GitHub again.

/** The longest description the dialog takes, and the Launchpad keeps. */
export const newModuleDescriptionLength = 4000;

/** A description as it goes into a prompt: the person's words without blank
 * edges and without control characters but line breaks and tabs. Null for
 * nothing left, anything but text, and more than the dialog takes. */
export function newModuleDescription(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = [...value.replace(/\r\n?/g, "\n")]
    .filter((character) => {
      const code = character.charCodeAt(0);
      return (
        character === "\n" ||
        character === "\t" ||
        (code >= 0x20 && code !== 0x7f)
      );
    })
    .join("")
    .trim();
  return text === "" || text.length > newModuleDescriptionLength ? null : text;
}

/** The whole prompt of an offer with what the person wrote: the plain brief
 * without a description, the one with "Moje představa:" with it. */
export function newModuleBrief(
  offer: NewModuleOffer,
  description: string,
  copy: Copy,
): string {
  const told = newModuleDescription(description);
  if (offer.variant === "personal")
    return newPersonalModulePrompt(offer.organization, copy, told);
  const prompt =
    offer.variant === "member" ? newModuleRequestPrompt : newModulePrompt;
  return prompt(
    offer.name ?? offer.organization,
    offer.organization,
    copy,
    told,
  );
}

export const newModuleSteps = ["what", "describe", "brief"] as const;
export type NewModuleStep = (typeof newModuleSteps)[number];

/** The examples of an offer, each a label and the description it puts in the
 * field: the company's in an Organization, everyday ones in the personal
 * space. */
export function newModuleExamples(
  offer: NewModuleOffer,
  copy: Copy,
): readonly Readonly<{ label: string; story: string }>[] {
  return offer.variant === "personal"
    ? [
        {
          label: copy.newModuleExampleExpenses,
          story: copy.newModuleExampleExpensesStory,
        },
        {
          label: copy.newModuleExampleRecipes,
          story: copy.newModuleExampleRecipesStory,
        },
        {
          label: copy.newModuleExampleTrip,
          story: copy.newModuleExampleTripStory,
        },
      ]
    : [
        {
          label: copy.newModuleExampleOrders,
          story: copy.newModuleExampleOrdersStory,
        },
        {
          label: copy.newModuleExampleClients,
          story: copy.newModuleExampleClientsStory,
        },
        {
          label: copy.newModuleExampleWebsite,
          story: copy.newModuleExampleWebsiteStory,
        },
      ];
}

/** One screen of the dialog, as it is drawn. */
export type NewModuleScreen =
  | Readonly<{
      step: "what";
      title: string;
      intro: string;
      parts: readonly Readonly<{ term: string; text: string }>[];
      /** Who builds it: the agent, or the Organization Admin the person asks. */
      who: string;
      /** Whether "Nebo začněte šablonou" leads anywhere: templates go into an
       * Organization only, so the personal space has no such link. */
      template: boolean;
      /** Whether "Přehrát video" stands here: the video of modules tells of
       * an Organization, with the Organization Admin and its templates. */
      video: boolean;
    }>
  | Readonly<{
      step: "describe";
      title: string;
      text: string;
      mentionTitle: string;
      mentions: readonly string[];
      examplesTitle: string;
      examples: ReturnType<typeof newModuleExamples>;
    }>
  | Readonly<{ step: "brief"; title: string; text: string; brief: string }>;

export function newModuleScreen(
  step: NewModuleStep,
  offer: NewModuleOffer,
  description: string,
  copy: Copy,
): NewModuleScreen {
  const member = offer.variant === "member";
  switch (step) {
    case "what":
      return {
        step,
        title: copy.appsNewModule,
        intro:
          offer.variant === "personal"
            ? copy.newModuleIntroPersonal
            : copy.newModuleIntro,
        parts: [
          {
            term: copy.newModulePartProcess,
            text: copy.newModulePartProcessText,
          },
          { term: copy.newModulePartData, text: copy.newModulePartDataText },
          { term: copy.newModulePartApp, text: copy.newModulePartAppText },
        ],
        who: member ? copy.newModuleByAdmin : copy.newModuleByAgent,
        template: offer.variant !== "personal",
        video: offer.variant !== "personal",
      };
    case "describe":
      return {
        step,
        title: copy.newModuleDescribeTitle,
        text: copy.newModuleDescribeText,
        mentionTitle: copy.newModuleMentionTitle,
        mentions: [
          copy.newModuleMentionProblem,
          copy.newModuleMentionWho,
          copy.newModuleMentionSee,
          copy.newModuleMentionData,
          copy.newModuleMentionAuto,
          copy.newModuleMentionAccess,
        ],
        examplesTitle: copy.newModuleExamples,
        examples: newModuleExamples(offer, copy),
      };
    case "brief":
      return {
        step,
        title: member ? copy.newModuleRequestTitle : copy.newModuleBriefTitle,
        text: member ? copy.newModuleRequestText : copy.newModuleBriefText,
        brief: newModuleBrief(offer, description, copy),
      };
  }
}

/** The id the Launchpad gave a kept description (`POST /api/prompts/brief`),
 * or null for any other answer: the brief then goes through the clipboard. */
export function parseBriefAnswer(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const answer = value as { kind?: unknown; id?: unknown };
  return answer.kind === "prompt-brief" && typeof answer.id === "string"
    ? answer.id
    : null;
}
