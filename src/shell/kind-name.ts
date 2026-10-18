import type { ShellEnvironmentKind } from "./contract";

// Three kinds of Environment in everything people read (root decision 0207,
// addendum of 2026-10-18; decision F28's addendum of the same day): Osobní,
// Pracovní and Týmové Prostředí, in English Personal, Work and Team
// Environment. An automated Environment is a work Environment with
// automations set up, not a fourth kind; the person's own computer has no
// kind at all, it is "váš počítač", "your computer". A text about the
// Environment the page is in names its kind instead of a bare "Prostředí".
// The kinds of `lazurio.shell.v1` (`automated`, `workstation`) stay as they
// are: only the words change. A port of `kindName`, `kindShort`, `kindDetail`
// and `inKind` of the Lazurio prototype (prototypes-lazurio affc81e,
// app/v1/src/data.ts and guide.ts), with English added. Pure, shared by the
// shell's elements and the Launchpad's catalog.

/** A Czech grammatical case a sentence needs. */
export type KindCase = "nom" | "gen" | "dat" | "acc" | "loc" | "ins";

/** Which word leads the phrase: "toto Pracovní Prostředí", "vaše Osobní
 * Prostředí". */
export type KindDeterminer = "this" | "your";

export type KindLocale = "cs" | "en";

/** The kind a person reads, counts and filters by: an automated Environment
 * is a work one. */
export type ShownKind = Exclude<ShellEnvironmentKind, "automated">;

export const shownKind = (kind: ShellEnvironmentKind): ShownKind =>
  kind === "automated" ? "work" : kind;

const noun: Readonly<Record<KindCase, string>> = {
  nom: "Prostředí",
  gen: "Prostředí",
  dat: "Prostředí",
  acc: "Prostředí",
  loc: "Prostředí",
  ins: "Prostředím",
};
// Osobní and Pracovní are soft adjectives, Týmové a hard one; Prostředí is
// neuter.
const soft: Readonly<Record<KindCase, string>> = {
  nom: "í",
  gen: "ího",
  dat: "ímu",
  acc: "í",
  loc: "ím",
  ins: "ím",
};
const hard: Readonly<Record<KindCase, string>> = {
  nom: "é",
  gen: "ého",
  dat: "ému",
  acc: "é",
  loc: "ém",
  ins: "ým",
};
const stems: Readonly<
  Record<Exclude<ShownKind, "workstation">, readonly [string, typeof soft]>
> = {
  personal: ["Osobn", soft],
  work: ["Pracovn", soft],
  team: ["Týmov", hard],
};
const thisNeuter: Readonly<Record<KindCase, string>> = {
  nom: "toto",
  gen: "tohoto",
  dat: "tomuto",
  acc: "toto",
  loc: "tomto",
  ins: "tímto",
};
const yourNeuter: Readonly<Record<KindCase, string>> = {
  nom: "vaše",
  gen: "vašeho",
  dat: "vašemu",
  acc: "vaše",
  loc: "vašem",
  ins: "vaším",
};
// Váš počítač is masculine inanimate, and "váš" is part of its name.
const computer: Readonly<Record<KindCase, string>> = {
  nom: "počítač",
  gen: "počítače",
  dat: "počítači",
  acc: "počítač",
  loc: "počítači",
  ins: "počítačem",
};
const thisMasculine: Readonly<Record<KindCase, string>> = {
  nom: "tento",
  gen: "tohoto",
  dat: "tomuto",
  acc: "tento",
  loc: "tomto",
  ins: "tímto",
};
const yourMasculine: Readonly<Record<KindCase, string>> = {
  nom: "váš",
  gen: "vašeho",
  dat: "vašemu",
  acc: "váš",
  loc: "vašem",
  ins: "vaším",
};
const english: Readonly<Record<Exclude<ShownKind, "workstation">, string>> = {
  personal: "Personal",
  work: "Work",
  team: "Team",
};

/** The kind of an Environment as a sentence says it: `kindName("team",
 * {case: "loc", determiner: "this"})` is "tomto Týmovém Prostředí",
 * `kindName("personal", {case: "acc", determiner: "your"})` "vaše Osobní
 * Prostředí", in English "this Team Environment" and "your Personal
 * Environment" (English has no case). Prostředí and the kind's adjective keep
 * their capitals (the design system's voice). The person's own computer has
 * no kind: "váš počítač" (no determiner or `your`), "tento počítač"
 * (`this`), "your computer", "this computer". */
export function kindName(
  kind: ShellEnvironmentKind,
  options: Readonly<{
    locale?: KindLocale;
    case?: KindCase;
    determiner?: KindDeterminer;
  }> = {},
): string {
  const shown = shownKind(kind);
  const grammaticalCase = options.case ?? "nom";
  if (options.locale === "en") {
    if (shown === "workstation")
      return `${options.determiner === "this" ? "this" : "your"} computer`;
    const name = `${english[shown]} Environment`;
    return options.determiner === undefined
      ? name
      : `${options.determiner} ${name}`;
  }
  if (shown === "workstation") {
    const lead = options.determiner === "this" ? thisMasculine : yourMasculine;
    return `${lead[grammaticalCase]} ${computer[grammaticalCase]}`;
  }
  const [stem, endings] = stems[shown];
  const name = `${stem}${endings[grammaticalCase]} ${noun[grammaticalCase]}`;
  if (options.determiner === undefined) return name;
  const lead = options.determiner === "this" ? thisNeuter : yourNeuter;
  return `${lead[grammaticalCase]} ${name}`;
}

/** First letter up, for a phrase that starts a sentence or a label. */
export const capitalized = (text: string, locale: KindLocale = "cs"): string =>
  `${text.charAt(0).toLocaleUpperCase(locale)}${text.slice(1)}`;

/** The kind as a label: Osobní, Pracovní or Týmové Prostředí, or Váš
 * počítač; Personal, Work or Team Environment, or Your computer. */
export const kindLabel = (
  kind: ShellEnvironmentKind,
  locale: KindLocale,
): string => capitalized(kindName(kind, { locale }), locale);

/** The kind in one word, for the line beside an Environment's name: Osobní,
 * Pracovní, Týmové, or Váš počítač, which is no kind; Personal, Work, Team,
 * Your computer. */
export function kindShort(
  kind: ShellEnvironmentKind,
  locale: KindLocale,
): string {
  const shown = shownKind(kind);
  if (shown === "workstation") return kindLabel(shown, locale);
  return locale === "en"
    ? english[shown]
    : kindName(shown).replace(` ${noun.nom}`, "");
}

/** The kind with what sets it apart, where it helps (Obecné's choice, Toto
 * Prostředí's facts): an automated Environment says its automations, so a
 * choice never shows two equal "Pracovní Prostředí". */
export const kindDetail = (
  kind: ShellEnvironmentKind,
  locale: KindLocale,
): string =>
  kind === "automated"
    ? `${kindLabel(kind, locale)} ${locale === "en" ? "with automations" : "s automatizacemi"}`
    : kindLabel(kind, locale);

// The current Environment in a text's words (Matěj 2026-10-18: never a bare
// "Prostředí" for the one you are in). A Czech text says {toto}, {tohoto},
// {tomuto}, {tomto} or {tímto}, an English one {this}, each with a capital to
// start a sentence ({Toto}, {This}), and the page fills in the kind it is
// in: "Lazurio {v tomto} kontroluje samo sebe" reads "Lazurio v tomto
// Pracovním Prostředí …". {toto} also stands for the accusative, which has
// the same form. On a computer the preposition changes with the noun, so
// "v" and "in" are part of their own token: {v tomto} is "v tomto Týmovém
// Prostředí" but "na tomto počítači", {in this} "in this Team Environment"
// but "on this computer". Without a kind the plain words stay: "toto
// Prostředí", "this Environment".
const thisCases: Readonly<Record<string, KindCase>> = {
  toto: "nom",
  tohoto: "gen",
  tomuto: "dat",
  tomto: "loc",
  tímto: "ins",
};
const token =
  /\{([Vv] tomto|[Tt]oto|[Tt]ohoto|[Tt]omuto|[Tt]omto|[Tt]ímto|[Ii]n this|[Tt]his)\}/gu;

/** The phrase of one token, in lower case. */
function phrase(name: string, kind: ShellEnvironmentKind | null): string {
  if (name === "in this")
    return kind === null
      ? "in this Environment"
      : kind === "workstation"
        ? "on this computer"
        : `in ${kindName(kind, { locale: "en", determiner: "this" })}`;
  if (name === "this")
    return kind === null
      ? "this Environment"
      : kindName(kind, { locale: "en", determiner: "this" });
  if (name === "v tomto")
    return kind === null
      ? "v tomto Prostředí"
      : kind === "workstation"
        ? "na tomto počítači"
        : `v ${kindName(kind, { case: "loc", determiner: "this" })}`;
  const grammaticalCase = thisCases[name] ?? "nom";
  return kind === null
    ? `${name} ${noun[grammaticalCase]}`
    : kindName(kind, { case: grammaticalCase, determiner: "this" });
}

/** A text with its tokens filled for an Environment of `kind`; null is an
 * Environment of no known kind (an unknown preset, a page that is no
 * Environment's), which keeps the plain words, never a wrong kind. */
export function inKind(
  text: string,
  kind: ShellEnvironmentKind | null,
): string {
  return text.replace(token, (_, name: string) => {
    const lower = name.toLocaleLowerCase("cs");
    const filled = phrase(lower, kind);
    return name === lower ? filled : capitalized(filled);
  });
}

/** Whether a text still holds a token of `inKind`. */
export const hasKindToken = (text: string): boolean =>
  new RegExp(token.source, "u").test(text);
