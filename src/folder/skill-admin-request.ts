import { roleCheck } from "./manual-mechanisms";
import type { Text } from "./render";

// `admin-request` (decision F14, proposed addendum of 2026-11-05): the one way
// an agent hands the Organization Admin something only the Admin may do, so
// that a person without the role gets a request the Admin can act on instead
// of a guess, a workaround or a "contact your Admin". Until Lazurio carries
// requests itself (root decision 0230, whose first case is 0229's AI source
// in Getting started), the request is an issue in the Organization's root
// repository, the place the Folder already sends missing rights and open
// questions to (root decision 0163). The Admin's side is `manual/admin.md`.

const t = (cs: string, en: string): Text => ({ cs, en });
const blank = t("", "");

export const adminRequestDescription = t(
  "Použij, když uživatel chce v Organizaci něco, co dělá její Admin: přepnout Prostředí mezi AI poolem Organizace a vlastním účtem ChatGPT, připojit telefon v Prostředí na poolu, schválit nebo odebrat zařízení, nové Prostředí, kolegu, víc paměti nebo disku, přístup k modulu jiného Teamu, Integraci pro celou Organizaci nebo změnu serveru. Ověří živě roli; Adminovi ukáže jeho postup, ostatním připraví jednu žádost Adminovi s údaji, které potřebuje. Nikdy neobchází Admina, review ani síť.",
  "Use when the user wants something in an Organization that its Admin does: switching an Environment between the Organization's AI pool and an own ChatGPT account, connecting a phone in an Environment on the pool, approving or removing a device, a new Environment, a colleague, more memory or disk, access to another Team's module, an Integration for the whole Organization or a server change. It checks the role live; it shows the Admin their procedure and prepares one request to the Admin, with the facts the Admin needs, for everyone else. It never works around the Admin, a review or the network.",
);

export const adminRequest: readonly Text[] = [
  t(
    "Lidé nevědí, co v Lazuriu smí sami a co patří Adminovi, a „obraťte se na Admina“ jim nepomůže. Tvoje práce je zjistit, jestli věc opravdu potřebuje Admina, a když ano, předat mu ji tak, aby ji mohl udělat bez dalšího doptávání. Co jednotlivé mechanismy znamenají a kdo je dělá, je v `manual/mechanisms.md`.",
    "People do not know what they may do in Lazurio themselves and what belongs to the Admin, and “ask your Admin” does not help them. Your job is to find out whether the matter really needs the Admin and, if it does, to hand it over so that the Admin can act without asking back. What each mechanism means and who does it is in `manual/mechanisms.md`.",
  ),
  blank,
  t("## Postup", "## Steps"),
  t(
    "1. **Pojmenuj jednu věc.** Co přesně uživatel chce, pro které Prostředí, zařízení nebo modul a proč. Podle tabulky Kdo co dělá v `manual/mechanisms.md` ověř, jestli to nezvládne sám: telefon s vlastním účtem, přihlášení AI mimo pool nebo vlastní Integraci udělá v Nastavení a žádost není potřeba. Ukaž mu kde.",
    "1. **Name one thing.** What exactly the user wants, for which Environment, device or module, and why. Check against the table Who does what in `manual/mechanisms.md` whether they can do it alone: a phone with an own account, an AI sign-in off the pool or their own Integration they do in Settings, and no request is needed. Show them where.",
  ),
  t(
    "2. **Ověř roli.** Když je uživatel Admin, žádost nepiš: pokračuj podle `manual/admin.md` a skillu Organizace pro danou věc.",
    "2. **Check the role.** When the user is the Admin, write no request: continue by `manual/admin.md` and the Organization's skill for the matter.",
  ),
  ...roleCheck.map((line) =>
    line.cs === "" ? line : { cs: `   ${line.cs}`, en: `   ${line.en}` },
  ),
  t(
    "3. **Seber údaje, které Admin potřebuje.** Jméno Prostředí (`manual/this-machine.md`), co ukazuje Začínáme nebo Připojení, jméno zařízení, druh účtu (ChatGPT Business, nebo osobní), termín, kdy změna nevadí, a co přeruší. Pracovní e-mail jen tehdy, když ho Admin potřebuje k pozvánce. Hesla, tokeny, párovací ani ověřovací kódy nikdy.",
    "3. **Collect what the Admin needs.** The Environment's name (`manual/this-machine.md`), what Getting started or Connections show, the device's name, the kind of account (ChatGPT Business or personal), a time when the change does no harm and what it interrupts. A work e-mail only when the Admin needs it for an invitation. Never passwords, tokens, pairing or verification codes.",
  ),
  t(
    "4. **Najdi kořenový repozitář a Adminy.** Repozitář je `origin` checkoutu Organizace v `organizations/`; na Osobním Prostředí, kde checkout Organizace není, ho najdeš v `gh repo list <org>`. Adminy vypíše příkaz výš. Podívej se, jestli stejná žádost už není otevřená; existující doplň komentářem, druhou nezakládej.",
    "4. **Find the root repository and the Admins.** The repository is the `origin` of the Organization's checkout in `organizations/`; in a Personal Environment, which has no checkout of the Organization, find it in `gh repo list <org>`. The command above lists the Admins. Look whether the same request is already open; add to an existing one with a comment instead of filing a second.",
  ),
  t(
    "5. **Zapiš jednu žádost** jako issue (`gh issue create -R <org>/<repozitář> --title … --body-file …`). Název „Žádost pro Admina: <co> (<Prostředí>)“, text podle vzoru níže, Adminy zmiň v textu. Zkus je i přiřadit; když GitHub přiřazení nedovolí, zmínka stačí. Žádost je běžná pracovní evidence jako otevřená otázka (rozhodnutí 0163): o věc požádal uživatel, takže ji zapiš bez dalšího ptaní. E-mail, WhatsApp ani jinou zprávu Adminovi neposílej; nanejvýš ji připrav jako koncept.",
    "5. **File one request** as an issue (`gh issue create -R <org>/<repository> --title … --body-file …`). Title “Request for the Admin: <what> (<Environment>)”, the text by the template below, the Admins mentioned in the text. Try to assign them too; when GitHub does not allow the assignment, the mention is enough. A request is ordinary working evidence like an open question (decision 0163): the user asked for the matter, so file it without asking again. Send the Admin no e-mail, WhatsApp or other message; at most prepare it as a draft.",
  ),
  t(
    "6. **Řekni uživateli**, kde žádost je, kdo ji dostal a co bude dál, včetně toho, co pak udělá sám (třeba přihlášení v Začínáme po přechodu z poolu). Pokračuj na všem, co na odpovědi Admina nestojí, a při další práci se na stav žádosti podívej, nepřipomínej ji opakovaně.",
    "6. **Tell the user** where the request is, who got it and what happens next, including what they will then do themselves (signing in at Getting started after leaving the pool, say). Continue with everything that does not wait for the Admin, and look at the request's state during later work instead of reminding repeatedly.",
  ),
  blank,
  t("## Vzor žádosti", "## Request template"),
  t("```markdown", "```markdown"),
  t("**Co:** <jedna akce>", "**What:** <one action>"),
  t(
    "**Pro koho a kde:** <jméno a GitHub login>, Prostředí `<jméno>`[, zařízení `<jméno>`][, modul `<slug>`]",
    "**For whom and where:** <name and GitHub login>, Environment `<name>`[, device `<name>`][, module `<slug>`]",
  ),
  t("**Proč:** <k čemu to potřebuje>", "**Why:** <what they need it for>"),
  t(
    "**Stav teď:** <co agent ověřil, třeba co ukazuje Začínáme>",
    "**State now:** <what the agent checked, such as what Getting started shows>",
  ),
  t(
    "**Kdy:** <termín, nebo kdykoli; co změna přeruší>",
    "**When:** <a time, or any time; what the change interrupts>",
  ),
  t(
    "**Potom uživatel:** <co udělá sám, až Admin skončí>",
    "**Then the user:** <what they do themselves once the Admin is done>",
  ),
  t(
    "**Postup pro Admina:** `manual/admin.md`, oddíl <oddíl>",
    "**Procedure for the Admin:** `manual/admin.md`, section <section>",
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
    "- **Uživatel nemá do kořenového repozitáře přístup** (lidé ho k Lazuriu nepotřebují, rozhodnutí 0192) nebo GitHub zápis odmítne: dej uživateli stejný text jako krátkou zprávu pro Admina a odeslání nech na něm.",
    "- **The user has no access to the root repository** (people do not need one for Lazurio, decision 0192) or GitHub refuses the write: give the user the same text as a short message for the Admin and leave sending it to them.",
  ),
  t(
    "- **Týmové Prostředí**: issue zakládá identita Teamu, proto v textu jmenuj člověka, který o věc žádá.",
    "- **A Team Environment**: the Team's identity files the issue, so name the person who asks in the text.",
  ),
  t(
    "- **Veřejné Prostředí** nic nezakládá: vysvětli, jak by to v Organizaci šlo.",
    "- **A public Environment** files nothing: explain how it would go in an Organization.",
  ),
  blank,
  t("## Nikdy", "## Never"),
  t(
    "Nedělej Adminovu práci jinou cestou: nepřihlašuj vlastní účet na poolu, neměň server, síť ani repozitář nasazení, nežádej o zápis do repozitáře jen kvůli žádosti a nepiš Adminovi jménem uživatele bez jeho souhlasu.",
    "Do not do the Admin's work another way: do not sign in an own account on the pool, do not change a server, the network or the Deployment Repo, do not ask for write access to a repository just for a request, and do not write to the Admin in the user's name without their consent.",
  ),
];
