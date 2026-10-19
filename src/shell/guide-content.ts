import type { ShellEnvironmentKind } from "./contract";
import { isExplanationId } from "./guide-protocol";
import { inKind, type KindLocale } from "./kind-name";

// What the guide says (decision F56; root decision 0180's addendum of
// 2026-10-18): the six principles of Lazurio, which the shell owns in both
// languages, and the explanations of a page, which its host owns and hands
// over with `provideGuides`, since they point at the host's own elements and
// change with its page. A port of the Lazurio prototype's guide
// (prototypes-lazurio bebea85, app/v1/src/guide.ts), English added; the
// principles' motion is guide-scenes.ts (F56's addendum (3)).
//
// Its rules, which tests/shell-guide.test.ts holds for every text: at most
// four steps (Trezor keeps the five lines of its approved video), each at
// most nine words and without a full stop, the brand's video titles; never
// Launchpad, Dashboard, Mašina or VM; three kinds of Environment; never
// "jen vám", "jen váš", "jen vaše" or "jen pro vás"; no "=" and no words of
// sameness: a laptop is not the agents' computer, and Lazurio is a window
// into that computer. A text about the Environment it plays in names its
// kind through the tokens of `inKind` ({Toto}, {tohoto}, {this}); the kind
// comes from the shell's document only, an automated Environment counting
// as work, never from an Organization's name (Lazurio/LazurioPlatform#499).

/** One step as it is drawn: its words, quieter words under them, and the
 * mark of the element it points at (`data-guide` of the host's page, or one
 * of `shellMarks`); null points at nothing, and the card stands in the
 * middle. */
export type GuideStep = Readonly<{
  text: string;
  sub: string | null;
  at: string | null;
}>;

export type GuideExplanation = Readonly<{
  id: string;
  title: string;
  steps: readonly GuideStep[];
  /** It explains Buddy: a person without Buddy is invited to get one at its
   * last step. */
  aboutBuddy: boolean;
  /** The documentation behind it, an https address: a quiet link in the
   * card at its last step (the prototype's `docs`; decision F56's addendum
   * of 2026-10-18), where a page's link to its documentation went; null for
   * none. */
  docs: string | null;
}>;

/** The marks the shell's own elements carry, which a step may name as it
 * names a mark of the host's page: the column head's gear, picker, switch
 * and its three tabs, and the rail's spaces (every one, your personal space,
 * the Organizations). Versioned with the shell, not part of interface v1: a
 * mark that is gone points at nothing. */
export const shellMarks = Object.freeze([
  "gear",
  "picker",
  "switch",
  "tab-apps",
  "tab-chat",
  "tab-automate",
  "rail",
  "rail-personal",
  "rail-organizations",
] as const);

/** The marks of a host's page the principles look for (a host that has
 * none of them gets the card in the middle): the Environment browser's
 * toggle, the Apps column's Soubory, Integrace and Trezor, a connected and a
 * not connected app of Integrace, and the vault's row and main button on
 * Trezor. */
export const principleMarks = Object.freeze([
  "browser",
  "nav-files",
  "nav-integrations",
  "nav-vault",
  "integration-on",
  "integration-connect",
  "vault-row",
  "vault-open",
] as const);

type Words = Readonly<Record<KindLocale, string>>;

type PrincipleStep = Readonly<{
  text: Words;
  sub?: Words;
  /** The words on your own computer, where the text about the agents'
   * virtual computer is not true (it has no kind). */
  computer?: Words;
  at: string;
}>;

type Principle = Readonly<{
  id: string;
  title: Words;
  aboutBuddy?: true;
  steps: readonly PrincipleStep[];
  /** The steps in a Personal Environment, where they differ. */
  personal?: readonly PrincipleStep[];
  /** Its documentation in each language (`GuideExplanation.docs`). */
  docs?: Words;
}>;

/** A page of Lazurio's documentation in each language, as the guide links
 * it from any app (`utm_source=guide`). */
const documentation = (page: string, campaign: string): Words => ({
  cs: `https://documentation.lazurio.ai/cs/${page}/?utm_source=guide&utm_medium=product&utm_campaign=${campaign}`,
  en: `https://documentation.lazurio.ai/en/${page}/?utm_source=guide&utm_medium=product&utm_campaign=${campaign}`,
});

const sharingBack: PrincipleStep = {
  text: {
    cs: "Sdílení můžete kdykoli vzít zpět",
    en: "You can stop sharing at any time",
  },
  at: "vault-open",
};

/** The six principles, in the order of the tour of Lazurio: from what you
 * look at to what agents may touch. Their ids are the prototype's, which
 * Buddy's frame asks for. */
const principles: readonly Principle[] = [
  {
    id: "environment",
    title: {
      cs: "Prostředí je počítač vašich agentů",
      en: "An Environment is your agents' computer",
    },
    steps: [
      {
        text: {
          cs: "{Toto} je virtuální počítač vašich agentů",
          en: "{This} is your agents' virtual computer",
        },
        computer: {
          cs: "Agenti pracují i na vašem počítači",
          en: "Agents work on your computer too",
        },
        at: "picker",
      },
      {
        text: {
          cs: "S vlastním prohlížečem a aplikacemi",
          en: "With its own browser and apps",
        },
        at: "browser",
      },
      {
        text: {
          cs: "Na něm pracují vaši agenti",
          en: "Your agents work on it",
        },
        at: "tab-chat",
      },
      {
        text: {
          cs: "Lazurio je okno do jejich počítače",
          en: "Lazurio is a window into their computer",
        },
        at: "switch",
      },
    ],
  },
  {
    id: "buddy",
    title: { cs: "Osobní Prostředí", en: "Personal Environment" },
    aboutBuddy: true,
    steps: [
      {
        text: {
          cs: "Toto je vaše Osobní Prostředí",
          en: "This is your Personal Environment",
        },
        at: "rail-personal",
      },
      {
        text: {
          cs: "Admin ani nikdo cizí do něj nevidí",
          en: "No Admin or stranger can see into it",
        },
        at: "rail-personal",
      },
      {
        text: {
          cs: "Pracovní Prostředí patří Organizaci",
          en: "A Work Environment belongs to the Organization",
        },
        at: "rail-organizations",
      },
      {
        text: { cs: "Její Admin do něj smí", en: "Its Admin may enter it" },
        at: "rail-organizations",
      },
    ],
  },
  {
    id: "reach",
    title: { cs: "Kam smějí agenti", en: "Where agents may go" },
    aboutBuddy: true,
    steps: [
      {
        text: {
          cs: "Osobní Prostředí a Pracovní Prostředí",
          en: "Personal Environment and Work Environment",
        },
        at: "rail",
      },
      {
        text: {
          cs: "Z Osobního Prostředí smějí do práce",
          en: "From the Personal Environment they may reach work",
        },
        sub: { cs: "tam, kam máte přístup vy", en: "where you have access" },
        at: "rail-personal",
      },
      {
        text: {
          cs: "Z práce do Osobního Prostředí nikdy",
          en: "From work into the Personal Environment, never",
        },
        at: "rail-organizations",
      },
      { text: { cs: "Jen jedním směrem", en: "One way only" }, at: "rail" },
    ],
  },
  {
    id: "files",
    title: { cs: "Soubory", en: "Files" },
    steps: [
      {
        text: {
          cs: "Soubor přetáhněte do chatu",
          en: "Drag a file into the chat",
        },
        at: "tab-chat",
      },
      {
        text: { cs: "Řekněte si o odkaz", en: "Ask for a link" },
        at: "tab-chat",
      },
      {
        text: { cs: "Odkaz soubor stáhne", en: "The link downloads the file" },
        at: "tab-chat",
      },
      {
        text: {
          cs: "Soubory jen ukazují, s čím agenti pracují",
          en: "Files only show what agents work with",
        },
        at: "nav-files",
      },
    ],
  },
  {
    id: "integrations",
    title: { cs: "Integrace", en: "Integrations" },
    // How Integrace work, the page's "Jak to funguje" before (F56's addendum
    // of 2026-10-18): the card's documentation link.
    docs: documentation("environment-app-connections", "app-connections"),
    steps: [
      {
        text: {
          cs: "Dejte agentům přístup do e-mailu",
          en: "Give the agents access to email",
        },
        at: "nav-integrations",
      },
      {
        text: { cs: "Agenti tam teď můžou", en: "Now the agents can go there" },
        sub: {
          cs: "všichni agenti a boti {tohoto}",
          en: "every agent and bot of {this}",
        },
        at: "integration-on",
      },
      {
        text: {
          cs: "Kde přihlášení není, tam nedosáhnou",
          en: "Where nothing is signed in, they cannot reach",
        },
        at: "integration-connect",
      },
      {
        text: {
          cs: "Kam ho přihlásíte, tam agenti můžou",
          en: "Where you sign it in, agents can go",
        },
        at: "integration-connect",
      },
    ],
  },
  {
    // The approved vault video of DEV-6631 (design-system-lazurio#93): its
    // five lines, so the product and its video say the same thing. In a
    // Personal Environment its adaptation: the person's own Bitwarden, the
    // agents' own account in it.
    id: "vault",
    title: { cs: "Trezor", en: "Vault" },
    steps: [
      {
        text: {
          cs: "Každá Organizace má vlastní trezor",
          en: "Every Organization has its own vault",
        },
        at: "nav-vault",
      },
      {
        text: {
          cs: "Každé Prostředí v ní má svůj",
          en: "Every Environment in it has its own",
        },
        at: "vault-row",
      },
      {
        text: {
          cs: "Lidé do něj sdílejí hesla ze svého Bitwardenu",
          en: "People share passwords into it from their Bitwarden",
        },
        at: "vault-row",
      },
      {
        text: {
          cs: "Agenti v Prostředí je najdou a použijí bez ptaní",
          en: "Agents in the Environment use them without asking",
        },
        sub: {
          cs: "Kdo má přístup do Prostředí, má i jeho hesla",
          en: "Whoever can enter the Environment has its passwords too",
        },
        at: "vault-open",
      },
      sharingBack,
    ],
    personal: [
      {
        text: {
          cs: "Agenti mají v Bitwardenu vlastní účet",
          en: "Agents have their own account in Bitwarden",
        },
        at: "vault-row",
      },
      {
        text: {
          cs: "Sdílíte do něj hesla ze svého Bitwardenu",
          en: "You share passwords into it from your Bitwarden",
        },
        at: "vault-row",
      },
      {
        text: {
          cs: "Agenti je najdou a použijí bez ptaní",
          en: "Agents find and use them without asking",
        },
        sub: {
          cs: "Kdo má přístup do Osobního Prostředí, má i tato hesla",
          en: "Whoever can enter the Personal Environment has these passwords too",
        },
        at: "vault-row",
      },
      { ...sharingBack, at: "vault-row" },
    ],
  },
];

/** The ids of the six principles, in the tour's order. */
export const principleIds: readonly string[] = Object.freeze(
  principles.map((principle) => principle.id),
);

/** A principle as it plays in an Environment of `kind` (null: none known,
 * the plain words stay), in `locale`; null for an id that is none. */
export function principleIn(
  id: string,
  locale: KindLocale,
  kind: ShellEnvironmentKind | null,
): GuideExplanation | null {
  const principle = principles.find((entry) => entry.id === id);
  if (principle === undefined) return null;
  const steps =
    kind === "personal" && principle.personal !== undefined
      ? principle.personal
      : principle.steps;
  return Object.freeze({
    id: principle.id,
    title: inKind(principle.title[locale], kind),
    aboutBuddy: principle.aboutBuddy === true,
    docs: principle.docs?.[locale] ?? null,
    steps: Object.freeze(
      steps.map((step) =>
        Object.freeze({
          text: inKind(
            (kind === "workstation" && step.computer !== undefined
              ? step.computer
              : step.text)[locale],
            kind,
          ),
          sub: step.sub === undefined ? null : inKind(step.sub[locale], kind),
          at: step.at,
        }),
      ),
    ),
  });
}

/** Display text a host hands over: 1 to `max` characters, none of them a
 * control character. */
const display = (value: unknown, max: number): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= max &&
  ![...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  });

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The most explanations one page hands over, and the most steps of one. */
export const maxPageGuides = 32;
export const maxGuideSteps = 4;

function parseStep(value: unknown): GuideStep | null {
  if (!isRecord(value)) return null;
  const sub = value.sub ?? null;
  const at = value.at ?? null;
  if (
    !display(value.text, 120) ||
    (sub !== null && !display(sub, 160)) ||
    (at !== null && !isExplanationId(at))
  )
    return null;
  return Object.freeze({ text: value.text, sub, at });
}

/** A documentation address a host hands over: an https URL with a host and
 * no credentials, at most 2048 characters; the card opens it in a new tab. */
function isDocs(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname !== "" &&
      url.username === "" &&
      url.password === "" &&
      url.href === value
    );
  } catch {
    return false;
  }
}

/** The explanations a host hands over for the page it shows
 * (`provideGuides`): a list of `{id, title, steps: [{text, sub?, at?}],
 * docs?}`. An entry whose id is no id, names a principle or repeats an
 * earlier one, whose title is no display text, whose steps are not 1 to
 * four valid steps, or whose `docs` is no https address is left out;
 * members a later version may add are ignored. Null for anything but a
 * list: the host withdraws, and the guide is off. */
export function parseGuides(
  value: unknown,
): readonly GuideExplanation[] | null {
  if (!Array.isArray(value)) return null;
  const seen = new Set<string>();
  const kept: GuideExplanation[] = [];
  for (const entry of value) {
    if (kept.length >= maxPageGuides) break;
    if (!isRecord(entry) || !isExplanationId(entry.id)) continue;
    if (principleIds.includes(entry.id) || seen.has(entry.id)) continue;
    if (!display(entry.title, 80) || !Array.isArray(entry.steps)) continue;
    if (entry.steps.length === 0 || entry.steps.length > maxGuideSteps)
      continue;
    const steps = entry.steps.map(parseStep);
    if (steps.some((step) => step === null)) continue;
    const docs = entry.docs ?? null;
    if (docs !== null && !isDocs(docs)) continue;
    seen.add(entry.id);
    kept.push(
      Object.freeze({
        id: entry.id,
        title: entry.title,
        steps: Object.freeze(steps as GuideStep[]),
        aboutBuddy: false,
        docs,
      }),
    );
  }
  return Object.freeze(kept);
}

/** A host's explanation as it plays in an Environment of `kind`: its tokens
 * of `inKind` filled, as the principles' are. */
export const pageGuideIn = (
  guide: GuideExplanation,
  kind: ShellEnvironmentKind | null,
): GuideExplanation =>
  Object.freeze({
    ...guide,
    title: inKind(guide.title, kind),
    steps: Object.freeze(
      guide.steps.map((step) =>
        Object.freeze({
          ...step,
          text: inKind(step.text, kind),
          sub: step.sub === null ? null : inKind(step.sub, kind),
        }),
      ),
    ),
  });
