import { type RecoveryEvidence, readableJson } from "./evidence";
import type { PreparedIssue, RefusedIssue } from "./issue";
import { searchText, shellWord } from "./issue";

/** The repair agent's assignment (docs/recovery-mode.md D), in the shape of
 * the tool prompts (`toolPrompt`, src/tools/catalog.ts): the task, first read
 * the real state, the mandate, what never happens, the target state and the
 * stop rule, built from the live facts of this run. Text only: producing it
 * repairs nothing, files nothing and grants nothing. It stays on this
 * Machine; the evidence in it is the sanitized bundle, the same that may
 * leave. */
export type PromptFacts = Readonly<{
  evidence: RecoveryEvidence;
  issue: PreparedIssue | RefusedIssue;
  /** The Folder this run read, for the commands that name it. */
  folder: string | undefined;
  /** A unit `lazurio install --service` wrote supervises the Launchpad. */
  supervised: boolean;
}>;

type Text = Readonly<{ cs: string; en: string }>;

const code = (value: string) => `\`${value}\``;

export function recoveryPrompt(
  facts: PromptFacts,
  locale: "cs" | "en",
): string {
  const { evidence, issue, folder, supervised } = facts;
  const pick = (text: Text) => text[locale];
  const folderWord = folder ?? "<Folder>";
  const folderArgument = folder === undefined ? "<Folder>" : shellWord(folder);
  // The rerun must read the Folder this run read: on a workstation only
  // --folder names it. Without one, the rerun detects it the same way.
  const recover = code(
    folder === undefined
      ? "lazurio recover --json"
      : `lazurio recover --json --folder ${folderArgument}`,
  );
  const { journal: _, ...fields } = evidence;
  const units = supervised
    ? {
        cs: ` ${code(`lazurio install --service systemd-user --folder ${folderArgument}`)}, aby se sjednotily jednotky služby; ${code("systemctl --user restart lazurio-launchpad.service")};`,
        en: ` ${code(`lazurio install --service systemd-user --folder ${folderArgument}`)} to converge the service units; ${code("systemctl --user restart lazurio-launchpad.service")};`,
      }
    : { cs: "", en: "" };
  const byHand = supervised
    ? {
        cs: ` Když ${code("lazurio")} vůbec nespustíš, přečti stav ručně: ${code("systemctl --user status lazurio-launchpad.service")} a ${code("journalctl --user --unit lazurio-launchpad.service --lines 80")}.`,
        en: ` If ${code("lazurio")} does not run at all, read the state by hand: ${code("systemctl --user status lazurio-launchpad.service")} and ${code("journalctl --user --unit lazurio-launchpad.service --lines 80")}.`,
      }
    : { cs: "", en: "" };
  const github: Text =
    issue.kind === "prepared"
      ? {
          cs: `7. **Na GitHub to zapiš v každém případě**, do veřejného repozitáře ${code(issue.repository)}; trvalý mandát pro issues (root rozhodnutí 0163) ti to dovoluje bez ptaní. Nejdřív hledej duplicitu: ${code(searchText(issue))}. Otevřená shoda dostane komentář s tělem; uzavřená shoda je regrese a dostane nové issue, které na ni odkáže; jinak issue vytvoř přesně příkazem, který vypsal ${code("lazurio recover")} (${code("issue.shell")} v ${code("--json")}). Tělo si před odesláním přečti a odstraň, co sanitizer přehlédl; když si nejsi jistý, že je veřejně bezpečné, neodesílej ho a předej ho operátorovi. Bez přihlášení ke GitHubu nebo bez sítě dej operátorovi připravené tělo a odkaz ${code("issue.link")}.`,
          en: `7. **Record it on GitHub either way**, in the public repository ${code(issue.repository)}; the standing mandate for issues (root decision 0163) lets you do it without asking. First search for a duplicate: ${code(searchText(issue))}. An open match gets a comment with the body; a closed match is a regression and gets a new issue that links it; otherwise create the issue with exactly the command ${code("lazurio recover")} printed (${code("issue.shell")} in ${code("--json")}). Read the body before you send it and remove anything the sanitizer missed; when you are not sure it is public-safe, do not send it: hand it to the operator. Without a GitHub sign-in or network, give the operator the prepared body and the link ${code("issue.link")}.`,
        }
      : {
          cs: `7. **Na GitHub nic neodesílej.** Lazurio odmítlo připravit veřejné tělo issue: po sanitizaci v něm zůstalo ${issue.found.map(code).join(", ")}. Řekni to operátorovi; důkazy zůstávají na téhle Mašině.`,
          en: `7. **Send nothing to GitHub.** Lazurio refused to prepare a public issue body: ${issue.found.map(code).join(", ")} survived sanitization. Tell the operator; the evidence stays on this Machine.`,
        };
  return [
    pick({
      cs: `**Úkol:** Lazurio na téhle Mašině potřebuje opravu (kontrola ${code(evidence.check)}, kód ${code(evidence.code)}, zjištěno ${evidence.detectedAt}). Oprav ho směrem dopředu. Když to nejde, zapiš na GitHub vše, co je potřeba pro opravené vydání.`,
      en: `**Task:** Lazurio on this Machine needs a repair (check ${code(evidence.check)}, code ${code(evidence.code)}, detected ${evidence.detectedAt}). Repair it forward. When you cannot, file everything needed for a fixed release as a GitHub Issue.`,
    }),
    `${pick({
      cs: "**Důkazy**, které Lazurio sebralo a sanitizovalo:",
      en: "**Evidence** collected and sanitized by Lazurio:",
    })}\n\n\`\`\`json\n${readableJson(fields)}\n\`\`\``,
    pick({
      cs: `1. Skutečný stav si přečti sám: ${recover}.${byHand.cs}`,
      en: `1. Read the current state yourself: ${recover}.${byHand.en}`,
    }),
    pick({
      cs: "2. Než cokoli změníš, pojmenuj operátorovi příčinu dvěma větami.",
      en: "2. Name the cause to the operator in two sentences before you change anything.",
    }),
    pick({
      cs: `3. **Sám smíš:** spouštět příkazy, které jen čtou; ${code("lazurio update")} na vydání novější než aktivní;${units.cs} ${code("lazurio folder-resume")} nebo ${code("lazurio profile-resume")}, abys dokončil přerušenou změnu Folderu.`,
      en: `3. **On your own you may:** run read-only commands; ${code("lazurio update")} to a release newer than the active one;${units.en} ${code("lazurio folder-resume")} or ${code("lazurio profile-resume")} to finish an interrupted Folder change.`,
    }),
    pick({
      cs: `4. **Jen na výslovný pokyn operátora v tomhle chatu:** mazání, přesouvání nebo úpravy souborů ve Folderu (${code(folderWord)}), v ${code("organizations/")}, ${code("personalspace/")} nebo v instalační bázi; opuštění přerušené změny Folderu; změny nástrojů, přihlášení nebo klíčů; ${code("sudo")}.`,
      en: `4. **Only on the operator's explicit instruction in this chat:** deleting, moving or editing files in the Folder (${code(folderWord)}), ${code("organizations/")}, ${code("personalspace/")} or the install base; retiring an interrupted Folder change; changes of tools, sign-ins or keys; ${code("sudo")}.`,
    }),
    pick({
      cs: `5. **Nikdy:** ${code("lazurio update rollback")} ani jiný návrat ke starší verzi; instalace verze pod aktivní verzí nebo pod high-water mark; kopírování starší spustitelné verze kamkoli; ruční úpravy ${code("bin/lazurio")} nebo ${code("update/high-water")}; mazání stavu aktualizací, abys obešel ${code("state-invalid")}; vypsání tajemství.`,
      en: `5. **Never:** ${code("lazurio update rollback")} or any other way back to an earlier version; installing a version below the active one or the high-water mark; copying an older executable anywhere; editing ${code("bin/lazurio")} or ${code("update/high-water")} by hand; deleting update state to get past ${code("state-invalid")}; printing a secret.`,
    }),
    pick({
      cs: `6. **Úspěch je doložený**, když ${recover} odpoví ${code('"verdict": "healthy"')} a stránka Launchpadu se normálně načte. Řekni operátorovi, co bylo špatně a co jsi změnil.`,
      en: `6. **Success is proven** when ${recover} answers ${code('"verdict": "healthy"')} and the Launchpad page loads normally. Tell the operator what was wrong and what you changed.`,
    }),
    pick(github),
    pick({
      cs: "8. Když to žádné vydání neopraví, řekni operátorovi, že Lazurio na téhle Mašině zůstane rozbité až do opraveného vydání a že T3 Code, nástrojů ani repozitářů se to netýká. Tam skonči; nic neobcházej.",
      en: "8. If no release repairs it, tell the operator that Lazurio stays broken on this Machine until a fixed release, and that T3 Code, the tools and the repositories are not affected. Stop there; work around nothing.",
    }),
  ].join("\n\n");
}
