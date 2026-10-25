// The person's name in the forms Buddy writes it (decision F65; the
// prototype's `czechNames`, prototypes-lazurio #90 `buddy-setup.ts`): his
// persona keeps the nominative, the accusative of T3 Code's trace „Buddy za
// Matěje“ and the dative of a line to a bot, „Výsledek pošli Matějovi“
// (LazurioPlatform#565). Začínáme and Nastavení → Buddy guess the two from
// the name as the person types it, show them in those two sentences and let
// the person correct them (Opravit): nobody is asked about grammar. In
// English one form does for all three. Pure.

export type PersonNames = Readonly<{
  nominative: string;
  accusative: string;
  dative: string;
}>;

/** Masculine first names that end in -a, so they decline as Honza, not as
 * Anna. */
const masculineA = new Set([
  "honza",
  "jirka",
  "kuba",
  "pepa",
  "franta",
  "tonda",
  "vojta",
  "jarda",
  "ota",
  "míra",
  "láďa",
  "vláďa",
  "standa",
  "venca",
]);

/** The dative of a feminine -a stem by its last letter: Jitka → Jitce,
 * Petra → Petře, Vanda → Vandě. */
function feminineDative(stem: string): string {
  const last = stem.slice(-1);
  const lower = last.toLocaleLowerCase("cs");
  const head = stem.slice(0, -1);
  const keep = (replacement: string) =>
    last === lower ? replacement : replacement.toLocaleUpperCase("cs");
  if (stem.toLocaleLowerCase("cs").endsWith("ch"))
    return `${stem.slice(0, -2)}še`;
  if (lower === "k") return `${head}${keep("c")}e`;
  if (lower === "g" || lower === "h") return `${head}${keep("z")}e`;
  if (lower === "r") return `${head}${keep("ř")}e`;
  if (lower === "ň") return `${head}${keep("n")}ě`;
  if (lower === "ť") return `${head}${keep("t")}ě`;
  if (lower === "ď") return `${head}${keep("d")}ě`;
  if ("dtnbpvmf".includes(lower)) return `${stem}ě`;
  return `${stem}e`;
}

/** One word of a name in the accusative and the dative. */
function declineWord(word: string): readonly [string, string] {
  const lower = word.toLocaleLowerCase("cs");
  const stem = word.slice(0, -1);
  if (word.length < 2) return [word, word];
  // Novotný → Novotného, Novotnému; Nováková → Novákovou, Novákové.
  if (lower.endsWith("ý")) return [`${stem}ého`, `${stem}ému`];
  if (lower.endsWith("á")) return [`${stem}ou`, `${stem}é`];
  // Jiří → Jiřího, Jiřímu; Tony → Tonyho, Tonymu.
  if (lower.endsWith("í") || lower.endsWith("y") || lower.endsWith("i"))
    return [`${word}ho`, `${word}mu`];
  // Lucie, Marie, Alice → Lucii, Marii, Alici in both.
  if (lower.endsWith("e") || lower.endsWith("ě"))
    return [`${stem}i`, `${stem}i`];
  if (lower.endsWith("a")) {
    if (masculineA.has(lower)) return [`${stem}u`, `${stem}ovi`];
    return [`${stem}u`, feminineDative(stem)];
  }
  // Ivo, Pablo, Hugo → Iva, Pabla, Huga; Ivovi, Pablovi, Hugovi.
  if (lower.endsWith("o")) return [`${stem}a`, `${stem}ovi`];
  // Pavel → Pavl-, Marek → Mark-, Zdeněk → Zdeňk-; Daniel and Michael keep
  // the e.
  let base = word;
  const elided = /([^aeiouyáéíóúůýě])(e|ě)([lk])$/iu.exec(word);
  if (elided && lower.length > 3) {
    const [, before = "", vowel = "", end = ""] = elided;
    const softened =
      vowel === "ě"
        ? ({ n: "ň", d: "ď", t: "ť" } as Readonly<Record<string, string>>)[
            before
          ]
        : undefined;
    base = `${word.slice(0, -3)}${softened ?? before}${end}`;
  }
  const soft = /[jřšžčcťďňsxz]$/iu.test(base);
  return [soft ? `${base}e` : `${base}a`, `${base}ovi`];
}

/** The person's name in the forms Buddy writes it, guessed from the form
 * people say it in: Matěj → Matěje, Matějovi; Anna → Annu, Anně. Each word
 * on its own, so a surname follows its first name. A guess the person
 * corrects where it is wrong. */
export function czechNames(nominative: string): PersonNames {
  const words = nominative.trim().split(/\s+/u).filter(Boolean);
  const declined = words.map(declineWord);
  return {
    nominative: words.join(" "),
    accusative: declined.map(([accusative]) => accusative).join(" "),
    dative: declined.map(([, dative]) => dative).join(" "),
  };
}

/** The forms for a name as the person types it: in Czech guessed, the field
 * keeping what was typed; in English the one form in all three. */
export function namesFromInput(
  value: string,
  locale: "cs" | "en",
): PersonNames {
  if (locale === "en") {
    const name = value.trim();
    return { nominative: value, accusative: name, dative: name };
  }
  return { ...czechNames(value), nominative: value };
}
