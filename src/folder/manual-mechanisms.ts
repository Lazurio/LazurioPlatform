import { type MessageKey, messages } from "../launchpad/messages";
import type { Text } from "./render";

// Two chapters of the agent manual (decision F14) for the agents of people in
// an Organization's Environments, who asked them how Lazurio's mechanisms work
// and got guesses (2026-11-05): `mechanisms.md` explains to every agent what
// each mechanism is, what the person does alone and where, and what only the
// Organization Admin does; `admin.md` holds the Admin's procedures. Both are
// the same on every Machine of one locale, like `lazurio.md`. The Organization
// keeps only its own facts (who its Admins are, its temporary paths) in its
// repository and skills; the product's model lives here, versioned with the
// product, so a customer's copy cannot go stale.
//
// Every label of the Launchpad quoted here comes from its message catalog, so
// a renamed button renames the manual too (and, through the pinned digest,
// forces a new template revision). Every decision cited is in
// `docs/decision-register.md`; a test checks both.

const t = (cs: string, en: string): Text => ({ cs, en });
const blank = t("", "");
const ucs = messages("cs");
const uen = messages("en");

/** A path through the Launchpad, in its own words: Nastavení → Připojení. */
const nav = (...keys: readonly MessageKey[]): Text => ({
  cs: keys.map((key) => ucs[key]).join(" → "),
  en: keys.map((key) => uen[key]).join(" → "),
});
const phonePath = nav("settingsTitle", "connectionsTitle", "phoneTitle");
const computerPath = nav("settingsTitle", "connectionsTitle", "computerTitle");
const aiPath = nav("settingsTitle", "startTitle", "startAiTitle");
const integrationsPath = nav("integrationsTitle");
const recoveryPath = nav("settingsTitle", "recoveryTitle");

/** The labels the chapters quote, for the test that holds them to the
 * Launchpad. */
export const quotedLaunchpadLabels: readonly MessageKey[] = Object.freeze([
  "settingsTitle",
  "connectionsTitle",
  "phoneTitle",
  "phonePair",
  "phoneDevices",
  "phoneRemove",
  "phoneStateOrganizationAi",
  "phoneStateTeam",
  "computerTitle",
  "computerConnect",
  "sshTitle",
  "startTitle",
  "startAiTitle",
  "startAiOrganization",
  "startAiSignInChatgpt",
  "startAiSignInClaude",
  "integrationsTitle",
  "recoveryTitle",
]);

// The live check of the role, shared by both chapters and the skill
// `admin-request`. Until decision 0228 is deployed and Lazurio Auth answers
// for the role, the Platform's own role check reads an active Owner of the
// GitHub Organization as the Admin (`src/content/role.ts`); the text says so
// and names the target.
export const roleCheck: readonly Text[] = [
  t(
    "Roli ověř živě, nikdy podle jména, persony ani souboru v repozitáři. `<org>` je GitHub organizace kořenového repozitáře Organizace (`git -C organizations/<složka> remote get-url origin`):",
    "Check the role live, never by a name, a persona or a file in a repository. `<org>` is the GitHub organization of the Organization's root repository (`git -C organizations/<folder> remote get-url origin`):",
  ),
  blank,
  t("```sh", "```sh"),
  t(
    "gh api user/memberships/orgs/<org> --jq '.role + \" \" + .state'   # admin active = Admin",
    "gh api user/memberships/orgs/<org> --jq '.role + \" \" + .state'   # admin active = Admin",
  ),
  t(
    "gh api 'orgs/<org>/members?role=admin' --jq '.[].login'          # kdo jsou Admini",
    "gh api 'orgs/<org>/members?role=admin' --jq '.[].login'          # who the Admins are",
  ),
  t("```", "```"),
  blank,
  t(
    "Admin Organizace je cílově role Lazuria, kterou jmenuje Owner GitHub Organizace v Přehledu Organizace (rozhodnutí 0228, zatím nenasazené). Dokud Lazurio roli samo nehlásí, platí za Admina aktivní Owner GitHub Organizace (`admin active`); tak to čte i Lazurio při instalaci Organizace. `member active` je člen bez role Admina. Když GitHub neodpoví, roli neznáš a postupuj jako u člena. Na Týmovém Prostředí jedná identita Teamu, která Adminem není nikdy. Z výpisu Adminů vynech boty a persony. `AGENTS.md` Organizace může Adminy jmenovat a říct, kde mají správní stanoviště; to je vodítko, ne oprávnění.",
    "The Organization Admin is, as the target, a role of Lazurio that an Owner of the GitHub Organization appoints in the Organization's Dashboard (decision 0228, not yet deployed). Until Lazurio reports the role itself, an active Owner of the GitHub Organization (`admin active`) counts as the Admin; that is how Lazurio reads it when it installs an Organization, too. `member active` is a member without the Admin role. When GitHub does not answer, you do not know the role, so proceed as for a member. In a Team Environment the Team's identity acts, and it is never an Admin. Leave bots and personas out of the list of Admins. The Organization's `AGENTS.md` may name its Admins and say where their administrative station is; that is a pointer, not a right.",
  ),
];

export const mechanisms: readonly Text[] = [
  t(
    "Lidé se agentů ptají, jak co v Lazuriu funguje, a chtějí po nich věci, které patří Adminovi Organizace. Tato kapitola říká u každého mechanismu, co to je, co člověk udělá sám a kde, a co za něj udělá Admin. Odpovídej podle ní, ne odhadem. Co smí jen Admin, za uživatele bez role Admina nedělej a nehledej cestu kolem: připrav žádost skillem `admin-request`. Postupy Admina jsou v `manual/admin.md`, nastavení tohoto Prostředí v `manual/this-machine.md`.",
    "People ask agents how things work in Lazurio and ask them for things that belong to the Organization Admin. For each mechanism this chapter says what it is, what the person does alone and where, and what the Admin does for them. Answer from it, not from a guess. What only the Admin may do, do not do for a user without the Admin role and do not look for a way around it: prepare a request with the skill `admin-request`. The Admin's procedures are in `manual/admin.md`, this Environment's setup in `manual/this-machine.md`.",
  ),
  blank,
  t(
    "Rozhodnutí se stavem „rozhodnuto, zatím nenasazeno“ nebo „navrženo“ popisuj jako cíl, ne jako funkci, kterou člověk najde. Stav najdeš v rejstříku rozhodnutí (`manual/lazurio.md`, oddíl Pravidla hry jsou veřejná). Co popisuje Organizace ve svém `AGENTS.md` nebo skillech jako dočasnou cestu, má před cílem přednost, dokud produkt cíl nedodá.",
    "Describe a decision whose status is “decided, not yet deployed” or “proposed” as a target, not as a feature the person will find. You find the status in the decision register (`manual/lazurio.md`, section The rules of the game are public). Where the Organization's `AGENTS.md` or skills describe a temporary path, it takes precedence over the target until the product delivers it.",
  ),
  blank,
  t("## Kdo je kdo", "## Who is who"),
  t(
    "- **Uživatel** je člověk, pro kterého pracuješ; v Pracovním Prostředí ten, komu ho Organizace přiřadila (`manual/roles.md`).",
    "- **The user** is the person you work for; in a Work Environment, the one the Organization assigned it to (`manual/roles.md`).",
  ),
  t(
    "- **Admin Organizace** spravuje Prostředí, zařízení, zdroj AI a přístupy své Organizace a smí do jejích Prostředí servisně vstoupit (rozhodnutí 0202, 0228). Organizace má obvykle jednoho Admina, může mít víc.",
    "- **The Organization Admin** manages the Environments, devices, AI source and access of their Organization and may enter its Environments for service (decisions 0202, 0228). An Organization usually has one Admin and may have more.",
  ),
  t(
    "- **Owner** GitHub Organizace jmenuje Adminy; Owner Prostředí je ten, komu Prostředí patří: osobní patří člověku, pracovní a týmové Organizaci.",
    "- **An Owner** of the GitHub Organization appoints the Admins; the Owner of an Environment is whoever it belongs to: a personal one to the person, a work or Team one to the Organization.",
  ),
  t(
    "- **Henry**, persona Organizace, dělá review a automatizace v Prostředí s automatizacemi, pokud ho Organizace má. Adminem není a vlastní práva nemá (rozhodnutí 0169).",
    "- **Henry**, the Organization's persona, does reviews and automations in the Environment with automations, where the Organization has one. It is not an Admin and has no rights of its own (decision 0169).",
  ),
  blank,
  t("### Jak poznáš roli uživatele", "### How you tell the user's role"),
  ...roleCheck,
  blank,
  t("## Prostředí", "## Environments"),
  t(
    "Lidé znají tři druhy: Osobní Prostředí patří jednomu člověku a jeho Buddymu, Pracovní Prostředí vlastní Organizace a přiřadí ho člověku, Týmové Prostředí sdílí celý Team a pracuje identitou Teamu (rozhodnutí 0207). Organizace k nim může mít Prostředí s automatizacemi (Henry) a na každém serveru Služby serveru, kam smějí jen Admini a kde běží AI pool (rozhodnutí 0209, zatím nenasazené). Nové Prostředí, jeho přidělení člověku, víc paměti nebo disku a jeho zrušení zařizuje Admin. Uživatel ani jeho agent na serveru nic nemění.",
    "People know three kinds: a Personal Environment belongs to one person and their Buddy, a Work Environment is owned by the Organization and assigned to a person, a Team Environment is shared by a whole Team and works with the Team's identity (decision 0207). Beside them an Organization may have an Environment with automations (Henry) and, on each server, Server services, which only Admins enter and where the AI pool runs (decision 0209, not yet deployed). A new Environment, its assignment to a person, more memory or disk and its removal are the Admin's. Neither the user nor their agent changes anything on the server.",
  ),
  blank,
  t(
    `Co člověk v Prostředí nastavuje sám, najde v Nastavení (ozubené kolo vedle názvu Prostředí): ${ucs.startTitle}, ${ucs.connectionsTitle}, ${ucs.toolsTitle}, ${ucs.integrationsTitle}, ${ucs.filesTitle} a ${ucs.recoveryTitle}. Když Prostředí nefunguje, začni v ${recoveryPath.cs} (rozhodnutí 0166); co se tam nespraví, patří Adminovi.`,
    `What a person sets up alone is in Settings (the gear beside the Environment's name): ${uen.startTitle}, ${uen.connectionsTitle}, ${uen.toolsTitle}, ${uen.integrationsTitle}, ${uen.filesTitle} and ${uen.recoveryTitle}. When the Environment does not work, start in ${recoveryPath.en} (decision 0166); what you cannot repair belongs to the Admin.`,
  ),
  blank,
  t("## Organizace, moduly a přístupy", "## Organizations, modules and access"),
  t(
    "Organizace je GitHub organizace s kořenovým repozitářem: jeho `AGENTS.md`, Knowledgebase, Mission Control a moduly ve `workspace/`. Kdo dosáhne na který modul, rozhoduje živý grant Teamu na GitHubu (rozhodnutí 0186); mění ho Admin, případně na žádost Stewarda. Nový modul postaví uživatel s tebou skillem `new-module`, změny jdou pull requestem a Publikací. Sdílet celé Pracovní Prostředí nebo jednotlivé aplikace smí člověk jen s aktivními členy téže Organizace, nikdy s někým zvenku (rozhodnutí 0192, cílový model). Kde to Lazurio ještě nenabízí, přístup k modulu nebo aplikaci zařizuje Admin. Personalspace se nesdílí nikdy.",
    "An Organization is a GitHub organization with a root repository: its `AGENTS.md`, Knowledgebase, Mission Control and the modules in `workspace/`. Who reaches which module is decided by the Team's live grant on GitHub (decision 0186); the Admin changes it, possibly at a Steward's request. The user builds a new module with you through the skill `new-module`, and changes go by pull request and Publication. A person may share their whole Work Environment or single applications only with active members of the same Organization, never with an outsider (decision 0192, target model). Where Lazurio does not offer it yet, the Admin arranges access to a module or application. Personalspace is never shared.",
  ),
  blank,
  t("## Integrace", "## Integrations"),
  t(
    `Integrace jsou aplikace připojené k tomuto Prostředí (pošta, kalendář, chat, CRM…). Vlastní účty připojuje uživatel sám na stránce ${integrationsPath.cs}; každé Prostředí drží svá přihlášení a na Týmovém Prostředí je používá celý Team. Integraci pro celou Organizaci (sdílená schránka, účet Organizace v Composiu, firemní MCP server) zařizuje Admin. Připojená aplikace není souhlas s Publikací. Podrobnosti jsou v \`manual/working-here.md\`, oddíl Integrace.`,
    `Integrations are the applications connected to this Environment (mail, calendar, chat, CRM…). The user connects their own accounts alone in ${integrationsPath.en}; each Environment holds its own sign-ins, and in a Team Environment the whole Team uses them. An Integration for the whole Organization (a shared mailbox, the Organization's Composio account, a company MCP server) is the Admin's. A connected application is not consent to Publication. Details are in \`manual/working-here.md\`, section Integrations.`,
  ),
  blank,
  t("## Publikace", "## Publication"),
  t(
    "Všechno je nejdřív koncept: pull request, koncept e-mailu, vyplněný formulář. Publikuje se až na slovo uživatele, třeba „publikuj“, a merge v chráněném repozitáři potřebuje review (`manual/working-here.md`). Admin za kolegu nepublikuje a jeho role není souhlas s Publikací v cizím Prostředí.",
    "Everything starts as a draft: a pull request, an e-mail draft, a filled-in form. It is published only on the user's word, such as “publish”, and a merge in a protected repository needs a review (`manual/working-here.md`). An Admin does not publish for a colleague, and the Admin role is no consent to Publication in someone else's Environment.",
  ),
  blank,
  t("## Zdroj AI", "## The AI source"),
  t(
    `Agenti v Prostředí potřebují AI: Codex a podle volby Claude Code. Osobní Prostředí má vždy vlastní přihlášení člověka. Pracovní Prostředí na serveru, kde Organizace provozuje AI pool, bere AI z jednoho ze dvou zdrojů: z **poolu**, kde agenti používají předplatné, které Organizace přihlásila jednou za všechny, nebo z **vlastního účtu** člověka, pracovního místa v ChatGPT Business Organizace nebo osobního účtu ChatGPT, k tomu případně Claude. Stav vidí člověk v ${aiPath.cs}: na poolu „${ucs.startAiOrganization}“, s vlastním účtem jeho přihlášení.`,
    `The agents in an Environment need AI: Codex and, by choice, Claude Code. A Personal Environment always has the person's own sign-in. A Work Environment on a server where the Organization runs an AI pool takes its AI from one of two sources: the **pool**, where agents use subscriptions the Organization signed in once for everyone, or the person's **own account**, a seat in the Organization's ChatGPT Business workspace or a personal ChatGPT account, with Claude if they want it. The person sees the state in ${aiPath.en}: on the pool “${uen.startAiOrganization}”, on an own account their sign-in.`,
  ),
  blank,
  t(
    `- **Přihlásit vlastní účet** v Prostředí, které není na poolu, zvládne člověk sám: ${aiPath.cs} → ${ucs.startAiSignInChatgpt} nebo ${ucs.startAiSignInClaude}.`,
    `- **Signing in an own account** in an Environment that is not on the pool, the person does alone: ${aiPath.en} → ${uen.startAiSignInChatgpt} or ${uen.startAiSignInClaude}.`,
  ),
  t(
    "- **Přejít z poolu na vlastní účet a zpět** smí jen Admin. Cílově to nastaví v Přehledu Organizace pro jednotlivá Prostředí a člověk o změnu požádá přímo v Začínáme (rozhodnutí 0229, zatím nenasazené). Dnes je to reviewovaný pull request do repozitáře nasazení Organizace (rozhodnutí 0205), který připraví agent Admina podle skillu Organizace. Na poolu se vlastním účtem nepřihlašuj a přechod neobcházej.",
    "- **Moving from the pool to an own account and back** only the Admin may do. As the target they set it per Environment in the Organization's Dashboard, and the person asks for it right in Getting started (decision 0229, not yet deployed). Today it is a reviewed pull request to the Organization's Deployment Repo (decision 0205), which the Admin's agent prepares by the Organization's skill. Do not sign in an own account on the pool and do not work around the change.",
  ),
  t(
    "- **Co přechod znamená:** ukončí rozběhnuté chaty v tom Prostředí a na chvíli i u všech ostatních na stejném poolu, protože se pool restartuje. Claude Code odchází z poolu spolu s Codexem. Pracovní účet ChatGPT Business funguje jen tehdy, když správce workspace povolí Codex mimo ChatGPT; po přechodu se člověk přihlásí v Začínáme.",
    "- **What the move means:** it ends the running chats in that Environment and briefly for everyone else on the same pool, because the pool restarts. Claude Code leaves the pool together with Codex. A ChatGPT Business work account works only where the workspace's administrator allows Codex outside ChatGPT; after the move the person signs in at Getting started.",
  ),
  blank,
  t("## Telefon a počítač", "## Phone and computer"),
  t(
    `- **Telefon s vlastním účtem ChatGPT** (Plus a vyšší, nebo Business, stejný účet jako Codex v Prostředí) spáruje člověk sám: ${phonePath.cs} → ${ucs.phonePair}, v aplikaci ChatGPT Codex → Přidat počítač a naskenovat QR kód (rozhodnutí 0215). Telefon nepotřebuje Tailscale ani heslo. Odebere ho v seznamu ${ucs.phoneDevices} tlačítkem ${ucs.phoneRemove}.`,
    `- **A phone with an own ChatGPT account** (Plus or higher, or Business, the same account as Codex in the Environment) the person pairs alone: ${phonePath.en} → ${uen.phonePair}, then in the ChatGPT app Codex → Add a computer and scan the QR code (decision 0215). The phone needs neither Tailscale nor a password. They remove it in the list ${uen.phoneDevices} with ${uen.phoneRemove}.`,
  ),
  t(
    `- **Na poolu** stránka hlásí „${ucs.phoneStateOrganizationAi}“: párování přes účet ChatGPT tam nejde. Cesty jsou dvě a obě vedou přes Admina: přechod na vlastní účet (výš), nebo dočasná cesta Organizace, pokud ji má ve svých skillech (třeba iPhone přes SSH s heslem). Na Týmovém Prostředí stránka hlásí „${ucs.phoneStateTeam}“`,
    `- **On the pool** the page says “${uen.phoneStateOrganizationAi}”: pairing through the ChatGPT account does not work there. There are two ways and both go through the Admin: moving to an own account (above), or the Organization's temporary path where its skills have one (an iPhone over SSH with a password, say). In a Team Environment the page says “${uen.phoneStateTeam}”`,
  ),
  t(
    `- **Počítač** s ChatGPT Desktopem připojí člověk v ${computerPath.cs} → ${ucs.computerConnect}: dostane prompt pro agenta na svém počítači. ${ucs.sshTitle} je pokročilá možnost.`,
    `- **A computer** with ChatGPT Desktop the person connects in ${computerPath.en} → ${uen.computerConnect}: they get a prompt for the agent on their computer. ${uen.sshTitle} is an advanced option.`,
  ),
  blank,
  t("## Zařízení a síť", "## Devices and the network"),
  t(
    "Organizace s tailnetem pouští do svých Prostředí jen schválená zařízení (rozhodnutí 0192). Zařízení zaregistruje člověk sám v aplikaci Tailscale svým Lazurio účtem; registrace ale přístup nedává. Konkrétní zařízení schvaluje Admin: cílově kliknutím v Přehledu Organizace, dnes často reviewovanou změnou v repozitáři nasazení. Ztracené zařízení ohlásí člověk Adminovi hned. Organizace ve veřejném DNS (rozhodnutí 0213) schválení zařízení nepotřebuje, vstupuje se Lazurio účtem. Postup registrace je v `manual/this-machine.md`, oddíl Přidání počítače do tailnetu.",
    "An Organization with a tailnet lets only approved devices into its Environments (decision 0192). The person registers the device alone in the Tailscale app with their Lazurio account; registration grants no access, though. The Admin approves the specific device: as the target with a click in the Organization's Dashboard, today often by a reviewed change in the Deployment Repo. The person reports a lost device to the Admin at once. An Organization in public DNS (decision 0213) needs no device approval; entry is with the Lazurio account. The registration steps are in `manual/this-machine.md`, section Adding a computer to a tailnet.",
  ),
  blank,
  t("## Aktualizace", "## Updates"),
  t(
    "Základ Prostředí a Lazurio aktualizuje provozovatel hostingu rolloutem a `lazurio update` srovná checkouty (rozhodnutí 0161). Nástroje uživatele (Codex, Claude Code, `gh` a další) aktualizuješ jen s jeho souhlasem (`manual/troubleshooting.md`). Když něco selže, opravuje se vpřed v Obnově (rozhodnutí 0166). Server, paměť, disk a síť jsou věc Admina.",
    "The hosting operator updates the Environment's baseline and Lazurio by rollout, and `lazurio update` aligns the checkouts (decision 0161). You update the user's tools (Codex, Claude Code, `gh` and others) only with their consent (`manual/troubleshooting.md`). When something fails, it is repaired forward in Recovery (decision 0166). Server, memory, disk and network are the Admin's.",
  ),
  blank,
  t("## Změny serverů a Prostředí", "## Changes to servers and Environments"),
  t(
    "Servery a Prostředí Organizace se mění jen pull requestem do jejího soukromého repozitáře nasazení (Deployment Repo, často `<org>/infra`; rozhodnutí 0205). CI spočítá Plán, review dělá někdo jiný než autor, merguje člověk s živým právem a apply spustí runner. Nikdo nemění server ručně. Běžní členové Organizace do toho repozitáře obvykle přístup nemají; jejich agent v něm nic nenavrhuje a změnu svěří Adminovi žádostí.",
    "An Organization's servers and Environments change only by a pull request to its private Deployment Repo (often `<org>/infra`; decision 0205). CI computes the Plan, someone other than the author reviews it, a person with live rights merges it and a runner applies it. Nobody changes a server by hand. Ordinary members of the Organization usually have no access to that repository; their agent proposes nothing in it and hands the change to the Admin by a request.",
  ),
  blank,
  t("## Kdo co dělá", "## Who does what"),
  t("| Co | Uživatel sám | Admin |", "| What | The user alone | The Admin |"),
  t("| --- | --- | --- |", "| --- | --- | --- |"),
  t(
    `| Přihlásit vlastní účet AI mimo pool | ${aiPath.cs} | — |`,
    `| Sign in an own AI account off the pool | ${aiPath.en} | — |`,
  ),
  t(
    "| Přejít mezi poolem a vlastním účtem | požádá | přepne |",
    "| Move between the pool and an own account | asks | switches |",
  ),
  t(
    `| Telefon s vlastním účtem | ${phonePath.cs} | — |`,
    `| Phone with an own account | ${phonePath.en} | — |`,
  ),
  t(
    "| Telefon v Prostředí na poolu | požádá | dočasná cesta Organizace |",
    "| Phone in an Environment on the pool | asks | the Organization's temporary path |",
  ),
  t(
    `| Počítač s ChatGPT Desktopem | ${computerPath.cs} | — |`,
    `| Computer with ChatGPT Desktop | ${computerPath.en} | — |`,
  ),
  t(
    "| Nové zařízení v tailnetu | registruje v Tailscale | schválí |",
    "| New device in the tailnet | registers in Tailscale | approves |",
  ),
  t(
    "| Ztracené zařízení | ohlásí hned | odebere |",
    "| Lost device | reports at once | removes |",
  ),
  t(
    `| Integrace vlastním účtem | ${integrationsPath.cs} | — |`,
    `| Integration with an own account | ${integrationsPath.en} | — |`,
  ),
  t(
    "| Integrace pro celou Organizaci | požádá | připojí |",
    "| Integration for the whole Organization | asks | connects |",
  ),
  t(
    "| Nový modul | s agentem (`new-module`) | — |",
    "| New module | with the agent (`new-module`) | — |",
  ),
  t(
    "| Přístup k modulu jiného Teamu | požádá | udělí grant |",
    "| Access to another Team's module | asks | grants it |",
  ),
  t(
    "| Nový kolega, nové Prostředí, víc paměti nebo disku | požádá | zařídí |",
    "| New colleague, new Environment, more memory or disk | asks | arranges it |",
  ),
  t(
    `| Prostředí nefunguje | ${recoveryPath.cs}, pak požádá | servisní vstup |`,
    `| The Environment does not work | ${recoveryPath.en}, then asks | service entry |`,
  ),
  t(
    "| Aktualizace nástroje | dá souhlas | — |",
    "| Tool update | gives consent | — |",
  ),
  t(
    "| Pravidlo pro celou Organizaci | navrhne issue nebo PR | review a merge podle práv |",
    "| A rule for the whole Organization | proposes an issue or PR | review and merge by rights |",
  ),
  blank,
  t("## Jak požádat Admina", "## How to ask the Admin"),
  t(
    "Jednou cestou: skill `admin-request`. Agent ověří, že věc opravdu patří Adminovi, sebere údaje, které Admin potřebuje, a zapíše jednu žádost jako issue do kořenového repozitáře Organizace se zmínkou Adminů. Hesla, tokeny ani kódy do ní nepatří. Uživateli dá odkaz a řekne, co bude dál. Když uživatel do kořenového repozitáře nemá přístup, připraví mu krátký text pro Admina a odeslání nechá na něm. Na veřejném Prostředí žádost nezakládej, jen vysvětli, jak to v Organizaci chodí. Cílově se žádosti podávají přímo v Lazuriu a dostanou se k Adminům Organizace (rozhodnutí 0230, zatím nenasazené); prvním případem je zdroj AI v Začínáme (rozhodnutí 0229).",
    "One way: the skill `admin-request`. The agent checks that the matter really is the Admin's, collects what the Admin needs and files one request as an issue in the Organization's root repository, mentioning the Admins. Passwords, tokens and codes do not belong in it. It gives the user the link and says what happens next. When the user has no access to the root repository, it prepares a short text for the Admin and leaves sending it to the user. In a public Environment file no request; just explain how it works in an Organization. As the target, requests are made right in Lazurio and reach the Organization's Admins (decision 0230, not yet deployed); the first case is the AI source in Getting started (decision 0229).",
  ),
];

export const organizationAdmin: readonly Text[] = [
  t(
    "Tato kapitola je pro agenta, jehož uživatel je Admin Organizace. Než podle ní cokoli uděláš, ověř roli. Když uživatel Admin není, řiď se `manual/mechanisms.md` a skillem `admin-request`. Obecný model je tady; konkrétní dočasné cesty, jména Adminů, správní stanoviště a aktuální práva drží `AGENTS.md` a skilly Organizace. Přečti je před první změnou a kde se s touto kapitolou rozcházejí, platí pro postup Organizace, pro principy tahle kapitola; rozpor zapiš jako issue do kořenového repozitáře Organizace.",
    "This chapter is for the agent whose user is the Organization Admin. Before you do anything by it, check the role. When the user is not the Admin, follow `manual/mechanisms.md` and the skill `admin-request`. The general model is here; the concrete temporary paths, the Admins' names, the administrative station and the current rights are in the Organization's `AGENTS.md` and skills. Read them before the first change; where they and this chapter disagree, the Organization's text holds for the procedure and this chapter for the principles; file the conflict as an issue in the Organization's root repository.",
  ),
  blank,
  ...roleCheck,
  blank,
  t("## Kde Admin pracuje", "## Where the Admin works"),
  t(
    "- **Správní stanoviště** je Pracovní Prostředí Admina (rozhodnutí 0202; nasazuje se postupně a `AGENTS.md` Organizace říká, jestli ho už má). Odtud vede servisní SSH do Pracovních a Týmových Prostředí členů téže Organizace, do Prostředí s automatizacemi a do Služeb serveru. Správu Conglomerate Hostu má jen Admin, který je zároveň živým Ownerem Organizace, jíž host patří, a jen ze schválených zařízení (rozhodnutí 0228). Z Osobního Prostředí Admina se jde přes stanoviště, nikdy přímo.",
    "- **The administrative station** is the Admin's Work Environment (decision 0202; it is being rolled out, and the Organization's `AGENTS.md` says whether it has one). From it, service SSH leads into the Work and Team Environments of members of the same Organization, the Environment with automations and the Server services. Only an Admin who is also a live Owner of the Organization that owns the Conglomerate Host administers that host, and only from approved devices (decision 0228). From the Admin's Personal Environment the way goes through the station, never directly.",
  ),
  t(
    "- **Servisní vstup v prohlížeči** do Launchpadu, Chatu a Automate kolegů je cíl rozhodnutí 0228, zatím nenasazený.",
    "- **Service entry in the browser** to colleagues' Launchpad, Chat and Automate is the target of decision 0228, not yet deployed.",
  ),
  t(
    "- **Repozitář nasazení** Organizace (Deployment Repo) mění servery a Prostředí, a kde to Organizace tak má, i zdroj AI a schválená zařízení (rozhodnutí 0205).",
    "- **The Organization's Deployment Repo** changes servers and Environments and, where the Organization does it that way, the AI source and approved devices (decision 0205).",
  ),
  t(
    "- **Přehled Organizace** (Dashboard) drží členství, role a granty (rozhodnutí 0186, 0192, 0194). Co tam už jde udělat klikem, dělá Admin tam, ne pull requestem.",
    "- **The Organization's Dashboard** holds membership, roles and grants (decisions 0186, 0192, 0194). What can already be done there with a click, the Admin does there, not by pull request.",
  ),
  blank,
  t(
    "## Servisní vstup do Prostředí kolegy",
    "## Service entry into a colleague's Environment",
  ),
  t(
    "V cizím Prostředí jsi host. Nečti Personalspace ani osobní soubory, neměň rozpracované koncepty a přihlášení kolegy bez důvodu a nic nepublikuj jeho jménem. Hlášku o změněném klíči hostu nepřijímej: znamená jiný stroj nebo změnu, kterou musí vysvětlit Admin. Privátní klíč stanoviště nikam nekopíruj. Cílem nikdy není Osobní Prostředí ani jiná Organizace. Po zásahu řekni Adminovi, co se stalo, aby to mohl kolegovi oznámit.",
    "In someone else's Environment you are a guest. Do not read Personalspace or personal files, do not change the colleague's drafts and sign-ins without a reason, and publish nothing in their name. Never accept a changed host key: it means another machine or a change the Admin must explain. Never copy the station's private key anywhere. The target is never a Personal Environment or another Organization. After the intervention tell the Admin what happened, so they can let the colleague know.",
  ),
  blank,
  t("## Žádosti kolegů", "## Colleagues' requests"),
  t(
    "Žádosti přicházejí jako issues v kořenovém repozitáři Organizace s názvem začínajícím „Žádost pro Admina:“, z Prostředí v angličtině „Request for the Admin:“ (skill `admin-request`):",
    "Requests arrive as issues in the Organization's root repository whose title starts with “Request for the Admin:”, from Environments in Czech “Žádost pro Admina:” (skill `admin-request`):",
  ),
  blank,
  t("```sh", "```sh"),
  t(
    'gh issue list -R <org>/<kořenový-repozitář> --state open --search \'in:title "Žádost pro Admina" OR in:title "Request for the Admin"\'',
    'gh issue list -R <org>/<root-repository> --state open --search \'in:title "Žádost pro Admina" OR in:title "Request for the Admin"\'',
  ),
  t("```", "```"),
  blank,
  t(
    "1. Ověř, že žadatel je aktivní člen Organizace a že žádost je jeho: autor issue, nebo u identity Teamu člověk jmenovaný v textu.",
    "1. Check that the requester is an active member of the Organization and that the request is theirs: the issue's author or, from a Team's identity, the person named in the text.",
  ),
  t(
    "2. Ověř údaje živě (Prostředí, zařízení, stav v Začínáme) a chybějící doptej v issue, ne v soukromé zprávě.",
    "2. Check the facts live (the Environment, the device, the state in Getting started) and ask for what is missing in the issue, not in a private message.",
  ),
  t(
    "3. Termín změny, která přeruší práci (zdroj AI, restart poolu), domluv s kolegou a lidi na stejném poolu upozorni předem.",
    "3. Agree the time of a change that interrupts work (AI source, pool restart) with the colleague and warn the people on the same pool in advance.",
  ),
  t(
    "4. Proveď změnu cestou níže a do issue piš průběh a výsledek. Zavři ho na slovo Admina; zamítnutí vysvětli věcně.",
    "4. Make the change by the path below and write its progress and result in the issue. Close it on the Admin's word; explain a refusal factually.",
  ),
  blank,
  t("## Postupy", "## Procedures"),
  t("### Zdroj AI jednoho Prostředí", "### The AI source of one Environment"),
  t(
    "Cíl je volba v Přehledu Organizace (rozhodnutí 0229, zatím nenasazené). Dokud tam není, je to reviewovaný pull request do repozitáře nasazení podle skillu Organizace: jedna změna na jednom místě, Plán z CI commitnutý beze změny, review od někoho jiného než autora na přesném headu, merge Admina a apply runnerem. Na serveru nic neměň ručně. Po přechodu na vlastní účet se kolega přihlásí v Začínáme; po návratu na pool Začínáme ukáže „Zajišťuje vaše Organizace.“ Výsledek ověř a zapiš do žádosti.",
    "The target is a choice in the Organization's Dashboard (decision 0229, not yet deployed). Until it is there, it is a reviewed pull request to the Deployment Repo by the Organization's skill: one change in one place, the CI Plan committed unchanged, a review by someone other than the author on the exact head, the Admin's merge and the apply by the runner. Change nothing on the server by hand. After a move to an own account the colleague signs in at Getting started; after a return to the pool Getting started says “Provided by your Organization.” Check the result and write it in the request.",
  ),
  blank,
  t("### Schválení a odebrání zařízení", "### Approving and removing a device"),
  t(
    "Zařízení registruje člověk sám. Admin schvaluje konkrétní uzel podle záznamu Headscale (číslo uzlu, machine key, vlastník), nikdy podle jména (rozhodnutí 0192). Kde Přehled Organizace schvalování nenabízí, jde to reviewovanou změnou v repozitáři nasazení podle skillu Organizace. Ztracené zařízení odeber přednostně. Schválení zařízení neotevírá Osobní Prostředí: tam rozhoduje vlastník Conglomerate Hostu.",
    "The person registers a device alone. The Admin approves a specific node by its Headscale record (node number, machine key, owner), never by its name (decision 0192). Where the Organization's Dashboard does not offer approval, it goes by a reviewed change in the Deployment Repo, by the Organization's skill. Remove a lost device first. Approving a device does not open a Personal Environment: there the Conglomerate Host's owner decides.",
  ),
  blank,
  t(
    "### Nový kolega a jeho Prostředí",
    "### A new colleague and their Environment",
  ),
  t(
    "Kolega potřebuje členství v Organizaci (GitHub a Lazurio účet), přidělené Pracovní Prostředí, přístup k modulům svého Teamu a podle sítě schválená zařízení. Nové Prostředí na serveru s poolem začíná na poolu. Hesla a přístupové údaje se kolegovi nikdy nepíšou do chatu, issue ani zprávy.",
    "A colleague needs membership of the Organization (GitHub and a Lazurio account), an assigned Work Environment, access to their Team's modules and, depending on the network, approved devices. A new Environment on a server with a pool starts on the pool. Passwords and credentials are never written to a colleague in a chat, an issue or a message.",
  ),
  blank,
  t(
    "### Přístupy k modulům a Integrace Organizace",
    "### Module access and the Organization's Integrations",
  ),
  t(
    "Grant Teamu k modulu měň v Přehledu Organizace, kde to jde, jinak na GitHubu právy Admina (rozhodnutí 0186). Přístup dostanou jen členové Organizace. Integraci pro celou Organizaci připojuje Admin sám svým přihlášením; agent ji nepřipojuje za něj.",
    "Change a Team's grant to a module in the Organization's Dashboard where possible, otherwise on GitHub with the Admin's rights (decision 0186). Access goes only to members of the Organization. The Admin connects an Integration for the whole Organization with their own sign-in; the agent never connects it for them.",
  ),
  blank,
  t("## Co Admin nedělá", "## What the Admin does not do"),
  t(
    "Nepublikuje za kolegu, nečte Personalspace, nepíše hesla do chatu, issue, pull requestu ani logu, neobchází review a branch rules, nemění servery ručně a nepřihlašuje vlastní účty v Prostředí kolegy. Role Admina je schopnost, ne souhlas s Publikací.",
    "Does not publish for a colleague, does not read Personalspace, writes no password into a chat, issue, pull request or log, does not bypass review and branch rules, does not change servers by hand and does not sign in their own accounts in a colleague's Environment. The Admin role is a capability, not consent to Publication.",
  ),
];
