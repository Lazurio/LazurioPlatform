import { shellWord } from "../folder/refresh-needed";
import { layout, readSelector } from "./layout";
import {
  entryDirectory,
  inspectPathEntry,
  type ObservedEntry,
} from "./path-entry";

/** `lazurio install prompt` (decision F20): Lazurio is installed exactly the
 * standard way on every Environment. A deviation is reported, never silently
 * overwritten and never kept as a supported variant; an agent straightens it
 * following this prompt. Producing it reads the installation and writes
 * nothing; the prompt itself grants nothing.
 */
export const installDeviations = [
  /** No selector in the install base. */
  "not-installed",
  /** `~/.local/bin/lazurio` does not exist; `lazurio install` creates it. */
  "entry-missing",
  /** It links another or a removed Lazurio install base; `lazurio install`
   * replaces it. */
  "entry-stale",
  /** It is someone else's file, link or directory. */
  "entry-foreign",
  /** `~/.local` or `~/.local/bin` is itself not a plain directory. */
  "entry-parent",
  "entry-unreadable",
  /** `~/.local/bin` is not on the PATH of the process that asked. */
  "directory-not-on-path",
  /** Another program named `lazurio` resolves first on that PATH. */
  "shadowed",
] as const;
export type InstallDeviation = (typeof installDeviations)[number];

export type InstallFacts = Readonly<{
  platform: string;
  home: string;
  base: string;
  selector: string;
  /** The version the selector names; null when nothing is installed. */
  active: string | null;
  entry: ObservedEntry;
  deviations: readonly InstallDeviation[];
}>;

export async function readInstallFacts(
  input: Readonly<{
    base: string;
    home: string;
    pathVariable: string | undefined;
    platform: string;
  }>,
): Promise<InstallFacts | null> {
  const entry = await inspectPathEntry(input);
  if (entry === null) return null;
  const active = await readSelector(input.base);
  const deviations: InstallDeviation[] = [];
  if (active === null) deviations.push("not-installed");
  if (entry.state === "missing") deviations.push("entry-missing");
  if (entry.state === "replaceable") deviations.push("entry-stale");
  if (entry.state === "unreadable") deviations.push("entry-unreadable");
  if (entry.state === "conflict")
    deviations.push(
      entry.occupant?.kind === "parent" ? "entry-parent" : "entry-foreign",
    );
  if (!entry.directoryOnPath) deviations.push("directory-not-on-path");
  if (entry.shadowedBy !== null) deviations.push("shadowed");
  return Object.freeze({
    platform: input.platform,
    home: input.home,
    base: input.base,
    selector: layout(input.base).selector,
    active,
    entry,
    deviations: Object.freeze(deviations),
  });
}

type Text = Readonly<{ cs: string; en: string }>;

function found(facts: InstallFacts, deviation: InstallDeviation): Text {
  const { entry, base, selector } = facts;
  const directory = entryDirectory(facts.home);
  switch (deviation) {
    case "not-installed":
      return {
        cs: `V ${base} není nainstalované žádné Lazurio (${selector} neexistuje).`,
        en: `No Lazurio is installed in ${base} (${selector} does not exist).`,
      };
    case "entry-missing":
      return {
        cs: `${entry.path} neexistuje.`,
        en: `${entry.path} does not exist.`,
      };
    case "entry-stale":
      return {
        cs: `${entry.path} odkazuje na selektor jiné nebo odstraněné instalace Lazuria.`,
        en: `${entry.path} links to the selector of another or a removed Lazurio install base.`,
      };
    case "entry-foreign": {
      const what =
        entry.occupant?.kind === "link"
          ? {
              cs: `odkaz na ${entry.occupant.target}`,
              en: `a link to ${entry.occupant.target}`,
            }
          : entry.occupant?.kind === "file"
            ? { cs: "běžný soubor", en: "a regular file" }
            : { cs: "ani soubor, ani odkaz", en: "not a file or a link" };
      return {
        cs: `${entry.path} je ${what.cs}, který Lazuriu nepatří.`,
        en: `${entry.path} is ${what.en} that is not Lazurio's.`,
      };
    }
    case "entry-parent":
      return {
        cs: `${entry.occupant?.target} není obyčejný adresář, takže ${entry.path} nejde vytvořit.`,
        en: `${entry.occupant?.target} is not a plain directory, so ${entry.path} cannot be created.`,
      };
    case "entry-unreadable":
      return {
        cs: `${entry.path} nešlo prohlédnout.`,
        en: `${entry.path} could not be inspected.`,
      };
    case "directory-not-on-path":
      return {
        cs: `${directory} není v PATH procesu, který tenhle prompt vypsal.`,
        en: `${directory} is not on the PATH of the process that printed this prompt.`,
      };
    case "shadowed":
      return {
        cs: `V PATH se jako první najde jiný program jménem lazurio: ${entry.shadowedBy} (například starý root CLI, který Bun nalinkoval do ~/.bun/bin).`,
        en: `Another program named lazurio resolves first on PATH: ${entry.shadowedBy} (for example the legacy root CLI that Bun linked into ~/.bun/bin).`,
      };
  }
}

/** The prepared prompt for an agent who straightens this installation. */
export function installPrompt(
  facts: InstallFacts,
  locale: "cs" | "en",
): string {
  const { entry, base, selector, platform } = facts;
  const directory = entryDirectory(facts.home);
  // This installation by its own path: `lazurio` may be another program.
  const run = shellWord(selector);
  const pick = (text: Text) => text[locale];
  const standard: Text = {
    cs: `Standardní instalace Lazuria na téhle Mašině (${platform}): instalační základna ${base} drží nainstalované verze a selektor ${selector}, odkaz na aktivní verzi; příkaz ${entry.path} je symbolický odkaz na ten selektor; ${directory} je v PATH operátora a žádný jiný program jménem lazurio se v PATH nenajde dřív. Lazurio se instaluje jednopříkazovým instalátorem (install.sh) nebo \`lazurio install\` a aktualizuje výhradně příkazem \`lazurio update\`.`,
    en: `The standard Lazurio installation on this Machine (${platform}): the install base ${base} holds the installed versions and the selector ${selector}, a link to the active version; the command ${entry.path} is a symbolic link to that selector; ${directory} is on the operator's PATH and no other program named lazurio resolves before it. Lazurio is installed by the one-command installer (install.sh) or \`lazurio install\` and updated only with \`lazurio update\`.`,
  };
  const state: Text =
    facts.deviations.length === 0
      ? {
          cs: `Zjištěno: nic se neodchyluje, aktivní verze je ${facts.active}. Instalace je standardní; nic neměň a jen to ověř podle posledního odstavce.`,
          en: `Found: nothing deviates, the active version is ${facts.active}. The installation is standard; change nothing and only prove it as in the last paragraph.`,
        }
      : {
          cs: [
            `Zjištěno${facts.active === null ? "" : ` (aktivní verze ${facts.active})`}:`,
            ...facts.deviations.map(
              (deviation) => `- ${found(facts, deviation).cs}`,
            ),
          ].join("\n"),
          en: [
            `Found${facts.active === null ? "" : ` (active version ${facts.active})`}:`,
            ...facts.deviations.map(
              (deviation) => `- ${found(facts, deviation).en}`,
            ),
          ].join("\n"),
        };
  return [
    pick({
      cs: "Úkol: srovnej instalaci Lazuria na téhle Mašině do standardní podoby. Pravidlo operátora: Lazurio je na každém Environmentu nainstalované přesně standardně; odchylku nahlásíš a srovnáš podle tohohle postupu, nikdy ji potichu nepřepíšeš a nikdy ji nenecháš jako podporovanou variantu.",
      en: "Task: straighten the Lazurio installation on this Machine to the standard. The operator's rule: Lazurio is installed exactly the standard way on every Environment; a deviation is reported and straightened by this procedure, never silently overwritten and never kept as a supported variant.",
    }),
    pick(standard),
    pick(state),
    pick({
      cs: `Bez ptaní smíš: číst stav (\`${run} install prompt --json\`, \`${run} --version --json\`, \`${run} update status --json\`, \`command -v lazurio\`); spustit \`${run} install\`, který je konvergentní — vytvoří chybějící ${entry.path} a nahradí jen odkaz na instalační základnu Lazuria, nic jiného; a když Lazurio nainstalované není, nainstalovat ho oficiálním instalátorem \`curl -fsSL https://lazurio.ai/install | sh\`.`,
      en: `Without asking you may: read the state (\`${run} install prompt --json\`, \`${run} --version --json\`, \`${run} update status --json\`, \`command -v lazurio\`); run \`${run} install\`, which is convergent — it creates a missing ${entry.path} and replaces only a link to a Lazurio install base, nothing else; and when Lazurio is not installed, install it with the official installer \`curl -fsSL https://lazurio.ai/install | sh\`.`,
    }),
    pick({
      cs: `Jen na výslovný pokyn operátora v téhle konverzaci: odsunout soubor, odkaz nebo adresář, který Lazuriu nepatří, z ${entry.path} nebo z jeho nadřazené cesty (přejmenovat na pojmenovanou zálohu vedle, nikdy nemazat); upravit shell profil (například ~/.profile, ~/.bashrc, ~/.zprofile nebo ~/.zshrc), aby ${directory} byl v PATH před každým adresářem s jiným lazurio; odstranit odkaz starého root CLI nebo jiný program jménem lazurio, který tuhle instalaci zakrývá (například odkaz, který \`bun link\` dal do ~/.bun/bin) — nejdřív operátorovi ukaž, co to je.`,
      en: `Only on the operator's explicit instruction in this conversation: move aside a file, link or directory that is not Lazurio's from ${entry.path} or from a directory on its path (rename it to a named backup next to it, never delete it); edit a shell profile (for example ~/.profile, ~/.bashrc, ~/.zprofile or ~/.zshrc) so that ${directory} is on PATH before every directory holding another lazurio; remove the legacy root CLI link or another program named lazurio that shadows this installation (for example a link \`bun link\` placed in ~/.bun/bin) — show the operator what it is first.`,
    }),
    pick({
      cs: "Nikdy: sudo, ruční zápis do instalační základny, kopie spustitelného souboru jinam, druhá instalace Lazuria vedle standardní, ani změna verze fungující instalace (to je `lazurio update`).",
      en: "Never: sudo, writing into the install base by hand, a copy of the executable anywhere else, a second Lazurio beside the standard one, or a change of a working installation's version (that is `lazurio update`).",
    }),
    pick({
      cs: `Důkaz úspěchu, v novém přihlašovacím shellu operátora: \`command -v lazurio\` vypíše ${entry.path}; \`lazurio --version\` vypíše aktivní verzi; \`lazurio update status\` ukáže tutéž verzi jako aktivní a žádné state-invalid; \`lazurio install prompt --json\` hlásí \`"standard": true\`.`,
      en: `Proof of success, in a new login shell of the operator: \`command -v lazurio\` prints ${entry.path}; \`lazurio --version\` prints the active version; \`lazurio update status\` shows that version active and no state-invalid; \`lazurio install prompt --json\` reports \`"standard": true\`.`,
    }),
    pick({
      cs: "Když cílového stavu nedosáhneš, přestaň, nahlas přesně, co chybí, a nic neobcházej.",
      en: "If you cannot reach the target state, stop, report exactly what is missing and work around nothing.",
    }),
  ].join("\n\n");
}
