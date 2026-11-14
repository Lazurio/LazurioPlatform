import { roleCheck } from "./manual-mechanisms";
import type { Text } from "./render";

// `admin-request` (decision F14, proposed addendum of 2026-11-05): the one way
// an agent hands the Organization Admin something only the Organization Admin may do, so
// that a person without the role gets a request the Organization Admin can act on instead
// of a guess, a workaround or a "contact your Organization Admin". Until Lazurio carries
// requests itself (root decision 0230, whose first case is 0229's AI source
// in Getting started), the request is an issue in the Organization's root
// repository, the place the Folder already sends missing rights and open
// questions to (root decision 0163). The Organization Admin's side is `manual/admin.md`.

const t = (cs: string, en: string): Text => ({ cs, en });
const blank = t("", "");

export const adminRequestDescription = t(
  "Použij, když uživatel chce v Organizaci něco, co dělá Admin Organizace: přepnout Prostředí mezi AI poolem Organizace a vlastním účtem ChatGPT, připojit telefon v Prostředí na poolu, schválit nebo odebrat zařízení, nové Prostředí, kolegu, víc paměti nebo disku, nový modul (s potvrzeným popisem), roli modulu, zveřejnit produkční aplikaci, nasadit její novou verzi, přidat nebo odebrat roli v aplikaci, Integraci pro celou Organizaci nebo změnu serveru. Ověří živě roli; Adminovi Organizace ukáže jeho postup, ostatním připraví jednu žádost Adminovi Organizace s údaji, které potřebuje. Nikdy neobchází Admina Organizace, review ani síť.",
  "Use when the user wants something in an Organization that the Organization Admin does: switching an Environment between the Organization's AI pool and an own ChatGPT account, connecting a phone in an Environment on the pool, approving or removing a device, a new Environment, a colleague, more memory or disk, a new module (with a confirmed description), a Module role, publishing a production application, deploying its new version, adding or removing an application role, an Integration for the whole Organization or a server change. It checks the role live; it shows the Organization Admin their procedure and prepares one request to the Organization Admin, with the facts the Organization Admin needs, for everyone else. It never works around the Organization Admin, a review or the network.",
);

export const adminRequest: readonly Text[] = [
  t(
    "Lidé nevědí, co v Lazuriu smí sami a co patří Adminovi Organizace, a „obraťte se na Admina Organizace“ jim nepomůže. Tvoje práce je zjistit, jestli věc opravdu potřebuje Admina Organizace, a když ano, předat mu ji tak, aby ji mohl udělat bez dalšího doptávání. Co jednotlivé mechanismy znamenají a kdo je dělá, je v `manual/mechanisms.md`.",
    "People do not know what they may do in Lazurio themselves and what belongs to the Organization Admin, and “ask your Organization Admin” does not help them. Your job is to find out whether the matter really needs the Organization Admin and, if it does, to hand it over so that the Organization Admin can act without asking back. What each mechanism means and who does it is in `manual/mechanisms.md`.",
  ),
  blank,
  t("## Postup", "## Steps"),
  t(
    "1. **Pojmenuj jednu věc.** Co přesně uživatel chce, pro které Prostředí, zařízení nebo modul a proč. Podle tabulky Kdo co dělá v `manual/mechanisms.md` ověř, jestli to nezvládne sám: telefon s vlastním účtem, přihlášení AI mimo pool nebo vlastní Integraci udělá v Nastavení a žádost není potřeba. Ukaž mu kde.",
    "1. **Name one thing.** What exactly the user wants, for which Environment, device or module, and why. Check against the table Who does what in `manual/mechanisms.md` whether they can do it alone: a phone with an own account, an AI sign-in off the pool or their own Integration they do in Settings, and no request is needed. Show them where.",
  ),
  t(
    "2. **Ověř roli.** Když je uživatel Admin Organizace, žádost nepiš: pokračuj podle `manual/admin.md` a skillu Organizace pro danou věc.",
    "2. **Check the role.** When the user is the Organization Admin, write no request: continue by `manual/admin.md` and the Organization's skill for the matter.",
  ),
  ...roleCheck.map((line) =>
    line.cs === "" ? line : { cs: `   ${line.cs}`, en: `   ${line.en}` },
  ),
  t(
    "Jde-li pouze o roli v již nasazené aplikaci vlastního modulu, Správce modulu nebo Přispěvatel modulu přejde přímo ke společnému oddílu Role produkční aplikace v `manual/admin.md` a na stejnou stránku v Přehledu Organizace bez žádosti Adminovi Organizace, ale jen s ověřeným živým grantem a nasazeným ověřovatelem role modulu (`manual/admin.md`, oddíl Role produkční aplikace). Postupy pro správu celé Organizace přeskočí. Bez živého grantu, záznamu modulu nebo ověřovatele tato cesta není splněná: připrav jednu žádost Adminovi Organizace. Toto právo nepotvrzuje záznam modulu a neschvaluje zveřejnění ani novou nasazovanou verzi; ty zůstávají Adminovi Organizace.",
    "For only an application-role change in an already deployed app of their own module, a Module Maintainer or Module Contributor goes directly to the shared Production application roles section of `manual/admin.md` and the same Organization Dashboard page without an Organization Admin request, but only with a verified live grant and deployed Module role observer (`manual/admin.md`, section Production application roles). They skip the procedures for Organization-wide administration. Without the live grant, Module record or observer this path does not qualify: prepare one Organization Admin request. This right confirms no Module record and approves neither publication nor a newly deployed version; those remain the Organization Admin's.",
  ),
  t(
    "3. **Seber údaje, které Admin Organizace potřebuje.** Jméno Prostředí (`manual/this-machine.md`), co ukazuje Začínáme nebo Připojení, jméno zařízení, druh účtu (ChatGPT Business, nebo osobní), termín, kdy změna nevadí, a co přeruší. U nového modulu popis, který uživatel potvrdil (shrnutí ze skillu `new-module`), a Teamy, které ho mají dostat; u role modulu slug modulu, roli (Čtenář modulu, Přispěvatel modulu, nebo Správce modulu) a Team nebo člověka, který ji má dostat. Pracovní e-mail jen tehdy, když ho Admin Organizace potřebuje k pozvánce. Hesla, tokeny, párovací ani ověřovací kódy nikdy.",
    "3. **Collect what the Organization Admin needs.** The Environment's name (`manual/this-machine.md`), what Getting started or Connections show, the device's name, the kind of account (ChatGPT Business or personal), a time when the change does no harm and what it interrupts. For a new module the description the user confirmed (the summary of the skill `new-module`) and the Teams that should get it; for a Module role the module's slug, the role (Module Reader, Module Contributor or Module Maintainer) and the Team or person who should get it. A work e-mail only when the Organization Admin needs it for an invitation. Never passwords, tokens, pairing or verification codes.",
  ),
  t(
    "4. **Najdi kořenový repozitář a Adminy Organizace.** Repozitář je `origin` checkoutu Organizace v `organizations/`; na Osobním Prostředí, kde checkout Organizace není, ho najdeš v `gh repo list <org>`. Kdo na žádost odpoví, vypíše příkaz výš: do nasazení role v Lazurio Auth jsou to aktivní Vlastníci Organizace, kteří na žádosti odpovídají jako Admin Organizace a vstup do Prostředí tím nezískávají (rozhodnutí 0230 a 0245). Ověř `gh api repos/<org>/<kořenový-repozitář> --jq .has_issues`; při `false` pokračuj oddílem Když issue nejde. Podívej se, jestli stejná žádost už není otevřená; existující doplň komentářem, druhou nezakládej.",
    "4. **Find the root repository and the Organization Admins.** The repository is the `origin` of the Organization's checkout in `organizations/`; in a Personal Environment, which has no checkout of the Organization, find it in `gh repo list <org>`. The command above lists who answers the request: until the role in Lazurio Auth is deployed, these are the active Organization Owners, who answer requests as the Organization Admin and get no entry to an Environment by that (decisions 0230 and 0245). Check `gh api repos/<org>/<root-repository> --jq .has_issues`; on `false` follow When an issue is not possible. Look whether the same request is already open; add to an existing one with a comment instead of filing a second.",
  ),
  t(
    "5. **Zapiš jednu žádost** jako issue (`gh issue create -R <org>/<repozitář> --title … --body-file …`). Název „Žádost pro Admina: <co> (<modul nebo Prostředí>)“, text podle vzoru níže, Adminy Organizace zmiň v textu. Zkus je i přiřadit; když GitHub přiřazení nedovolí, zmínka stačí. Žádost je běžná pracovní evidence jako otevřená otázka (rozhodnutí 0163): o věc požádal uživatel, takže ji zapiš bez dalšího ptaní. E-mail, WhatsApp ani jinou zprávu Adminovi Organizace neposílej; nanejvýš ji připrav jako koncept.",
    "5. **File one request** as an issue (`gh issue create -R <org>/<repository> --title … --body-file …`). Title “Request for the Admin: <what> (<module or Environment>)”, the text by the template below, the Organization Admins mentioned in the text. Try to assign them too; when GitHub does not allow the assignment, the mention is enough. A request is ordinary working evidence like an open question (decision 0163): the user asked for the matter, so file it without asking again. Send the Organization Admin no e-mail, WhatsApp or other message; at most prepare it as a draft.",
  ),
  t(
    "6. **Řekni uživateli**, kde žádost je, kdo ji dostal a co bude dál, včetně toho, co pak udělá sám (třeba přihlášení v Začínáme po přechodu z poolu). Pokračuj na všem, co na odpovědi Admina Organizace nestojí, a při další práci se na stav žádosti podívej, nepřipomínej ji opakovaně.",
    "6. **Tell the user** where the request is, who got it and what happens next, including what they will then do themselves (signing in at Getting started after leaving the pool, say). Continue with everything that does not wait for the Organization Admin, and look at the request's state during later work instead of reminding repeatedly.",
  ),
  blank,
  t(
    "## Druhy žádosti pro produkční aplikaci",
    "## Production application request kinds",
  ),
  t(
    "Pro všechny tři druhy uveď Organizaci, modul (slug a repozitář), skutečný odkaz, pokud už existuje, a co má Admin Organizace schválit. Potřebná tajemství uváděj jen názvem, účelem a stavem v trezoru Organizace; hodnoty nikdy. Nevyžaduj jméno Prostředí od člověka, který má používat jen aplikaci.",
    "For all three kinds give the Organization, module (slug and repository), actual link if one exists and what the Organization Admin is to approve. List required secrets only by name, purpose and state in the Organization's vault, never values. Do not require an Environment's name from someone who is to use only the app.",
  ),
  t(
    "- **Zveřejnit aplikaci:** účel a kdo ji bude používat, tag vydané verze a přesný commit, odkazy na zelenou CI, sestavení a health, role přes `appAccess`, kdo dostane Uživatel aplikace nebo Admin aplikace podle Lazurio username nebo propojeného GitHub loginu, dosavadní a nový zapisovatel dat a zda se mění, potřebná tajemství a zda nabízí `/mcp`. Nehotové vydání označ jako blokaci, nevydávej ho za připravené.",
    "- **Publish an application:** purpose and who will use it, release tag and exact commit, links to green CI, build and health, roles through `appAccess`, who receives Application User or Application Admin by Lazurio username or linked GitHub login, current and new data writer and whether it changes, required secrets and whether it offers `/mcp`. Mark an unfinished release as a blocker; do not present it as ready.",
  ),
  t(
    "- **Nasadit novou verzi aplikace:** navíc aktuálně nasazený tag a commit, navrhovaný tag a commit, co se pro lidi mění, zda se mění schéma nebo zapisovatel dat, postup přechodu a přerušení práce. Výslovně napiš i „zapisovatel se nemění“, když zůstává stejný; role a tajemství uveď jako změnu nebo beze změny.",
    "- **Deploy a new application version:** also the currently deployed tag and commit, proposed tag and commit, what changes for people, whether the schema or data writer changes, cutover steps and work interruption. Explicitly say “the writer does not change” when it stays the same; list roles and secrets as changed or unchanged.",
  ),
  t(
    "- **Přidat nebo odebrat roli v aplikaci:** přesná akce, aplikace a nasazené vydání, příjemce (Lazurio username nebo propojený GitHub login; subject jen pokud už je ověřený, případně identifikátor Teamu nebo celé Organizace podle podporovaného postupu), současná a chtěná role Uživatel aplikace nebo Admin aplikace. Výslovně uveď, zda se mění zapisovatel a potřebná tajemství; běžná změna role je nemění. GitHub login nenahrazuje identitu Lazurio účtu a role aplikace nedává zdrojový kód ani celé Prostředí.",
    "- **Add or remove an application role:** exact action, app and deployed release, recipient (Lazurio username or linked GitHub login; subject only if already verified, or the Team or whole Organization identifier by the supported procedure), current and intended Application User or Application Admin role. Explicitly state whether the writer and required secrets change; an ordinary role change changes neither. A GitHub login does not replace Lazurio account identity, and an application role grants neither source code nor the whole Environment.",
  ),
  t(
    "Žádost je v kořenovém repozitáři Organizace, ne v repozitáři nasazení. Pull request nasazení z ní dnes připraví agent Admina Organizace podle `manual/admin.md`, oddíl Produkční aplikace Organizace; cílově Admin Organizace schvaluje v Přehledu Organizace a pull request za něj otevře Lazurio (rozhodnutí 0239, zatím nenasazené). Uživateli řekni jednou větou: „Žádost <odkaz> schválí Admin Organizace <ověřené jméno>; nasazení schválí mergem navazujícího pull requestu.“ Bez role Admina Organizace nic nenasazuj ani nepublikuj.",
    "The request belongs in the Organization's root repository, not the Deployment Repo. Today the Organization Admin's agent prepares the deployment pull request from it by `manual/admin.md`, section Production applications of an Organization; as the target the Organization Admin approves in the Organization's Dashboard and Lazurio opens the pull request for them (decision 0239, not yet deployed). Tell the user in one sentence: “Organization Admin <verified name> will approve request <link>; they approve deployment by merging its linked pull request.” Without the Organization Admin role deploy and publish nothing.",
  ),
  blank,
  t("## Vzor žádosti", "## Request template"),
  t("```markdown", "```markdown"),
  t("**Co:** <jedna akce>", "**What:** <one action>"),
  t(
    "**Pro koho a kde:** <Organizace, jméno a Lazurio účet/subject; GitHub login, je-li relevantní>[, modul `<slug>`][, Prostředí nebo zařízení, týká-li se ho žádost]",
    "**For whom and where:** <Organization, name and Lazurio account/subject; GitHub login if relevant>[, module `<slug>`][, Environment or device if the request concerns it]",
  ),
  t("**Proč:** <k čemu to potřebuje>", "**Why:** <what they need it for>"),
  t(
    "**Stav teď:** <co agent ověřil, třeba co ukazuje Začínáme>",
    "**State now:** <what the agent checked, such as what Getting started shows>",
  ),
  t(
    "**Aplikace, jde-li o ni:** <druh žádosti, modul/repozitář, aktuální a navržený tag + commit, CI/build/health, příjemci a přesné role podle Lazurio účtu (subject, je-li známý), zapisovatel teď → potom, mění se ano/ne, názvy tajemství a stav v trezoru, MCP ano/ne>",
    "**Application, when relevant:** <request kind, module/repository, current and proposed tag + commit, CI/build/health, recipients and exact roles by Lazurio account (subject if known), writer now → afterwards, changes yes/no, secret names and vault state, MCP yes/no>",
  ),
  t(
    "**Kdy:** <termín, nebo kdykoli; co změna přeruší>",
    "**When:** <a time, or any time; what the change interrupts>",
  ),
  t(
    "**Potom uživatel:** <co udělá sám, až Admin Organizace skončí>",
    "**Then the user:** <what they do themselves once the Organization Admin is done>",
  ),
  t(
    "**Postup pro Admina Organizace:** `manual/admin.md`, oddíl <oddíl>",
    "**Procedure for the Organization Admin:** `manual/admin.md`, section <section>",
  ),
  blank,
  t("@<admin> …", "@<admin> …"),
  blank,
  t(
    "<podpis agenta podle AGENTS.md>",
    "<the agent's signature as AGENTS.md says>",
  ),
  t("```", "```"),
  blank,
  t("## Když issue nejde", "## When an issue is not possible"),
  t(
    "- **Kořenový repozitář má vypnuté Issues** (ověřeně `has_issues: false`): žádost nepřesouvej do infra repozitáře ani jiné Organizace, nepřiřazuj ji operátorovi Lazuria a netvrď, že byla založena. Připrav stejný celý text pro Admina Organizace s přesným cílovým repozitářem a doporučením zapnout Settings → General → Features → Issues. Bez role Admina Organizace nastavení neměň. Agent Admina Organizace ho s jeho mandátem a živým právem správy může zapnout (`gh api --method PATCH repos/<org>/<repo> -F has_issues=true`), zpětně přečíst a pak založit žádost, pokud ji stále potřebuje.",
    "- **The root repository has Issues disabled** (verified `has_issues: false`): never move the request to an infra repository or another Organization, assign it to a Lazurio operator or claim it was filed. Prepare the same full text for the Organization Admin with the exact target repository and a recommendation to enable Settings → General → Features → Issues. Without the Organization Admin role do not change the setting. The Organization Admin's agent may enable it within their mandate and live administration right (`gh api --method PATCH repos/<org>/<repo> -F has_issues=true`), read it back and then file the request if still needed.",
  ),
  t(
    "- **Uživatel nemá do kořenového repozitáře přístup** (lidé ho k Lazuriu nepotřebují, rozhodnutí 0245) nebo GitHub zápis odmítne: dej uživateli stejný text jako krátkou zprávu pro Admina Organizace a odeslání nech na něm.",
    "- **The user has no access to the root repository** (people do not need one for Lazurio, decision 0245) or GitHub refuses the write: give the user the same text as a short message for the Organization Admin and leave sending it to them.",
  ),
  t(
    "- **Týmové Prostředí**: issue zakládá identita Teamu, kterou sdílí celý Team, takže jméno v textu žadatele neověřuje. Jmenuj člověka, který o věc žádá, a řekni mu, ať žádost potvrdí svým vlastním účtem komentářem v issue; bez toho ji Admin Organizace vede jako neověřenou.",
    "- **A Team Environment**: the Team's identity, which the whole Team shares, files the issue, so a name in the text does not verify the requester. Name the person who asks and tell them to confirm the request with their own account in a comment on the issue; without that the Organization Admin treats it as unverified.",
  ),
  t(
    "- **Veřejné Prostředí** nic nezakládá: vysvětli, jak by to v Organizaci šlo.",
    "- **A public Environment** files nothing: explain how it would go in an Organization.",
  ),
  blank,
  t("## Nikdy", "## Never"),
  t(
    "Nedělej práci Admina Organizace jinou cestou: nepřihlašuj vlastní účet na poolu, neměň server, síť ani repozitář nasazení, nežádej o zápis do repozitáře jen kvůli žádosti a nepiš Adminovi Organizace jménem uživatele bez jeho souhlasu.",
    "Do not do the Organization Admin's work another way: do not sign in an own account on the pool, do not change a server, the network or the Deployment Repo, do not ask for write access to a repository just for a request, and do not write to the Organization Admin in the user's name without their consent.",
  ),
];
