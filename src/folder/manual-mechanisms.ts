import { type MessageKey, messages } from "../launchpad/messages";
import { folderCzechLabels } from "./held-labels";
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
// Every label of the Launchpad quoted here comes from its message catalog
// (but for the Czech labels held below), so
// a renamed button renames the manual too (and, through the pinned digest,
// forces a new template revision). Every decision cited is in
// `docs/decision-register.md`; a test checks both.

const t = (cs: string, en: string): Text => ({ cs, en });
const blank = t("", "");

const ucs = folderCzechLabels();
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
  "appsTitle",
  "appsNewModule",
  "appsMarketplace",
  "marketAppTemplates",
  "marketAdd",
  "filesTitle",
  "accessCheck",
]);

// The one explanation of a module (decision F14, addendum of 2026-11-05),
// shared with the skill `new-module`, so that a person hears the same words
// wherever an agent explains it. It is quoted as what the agent says, so in
// the person's address.
export const moduleSentence: Text = t(
  "Modul je jedna oblast vaší práce, třeba zakázky, web nebo receptury. Drží pohromadě postup, podle kterého agenti pracují, data, se kterými se pracuje, a aplikaci, ve které je vidíte a měníte.",
  "A module is one area of your work, such as orders, the website or recipes. It keeps together the process agents follow, the data the work is about, and the app in which you see and change it.",
);
export const moduleWebsiteExample: Text = t(
  "Příklad, který má každá firma, je web: postup říká, jak se píšou texty a jaké jsou barvy, data jsou stránky, texty a obrázky a aplikace je web sám a jeho náhled. Proto stačí agentovi poslat snímek obrazovky a napsat „oprav tuhle větu“: modul webu mu řekne, kde text leží a jak změnu publikovat.",
  "The example every company has is its website: the process says how the texts are written and which colours are used, the data is the pages, texts and images, and the app is the website itself with its preview. That is why it is enough to send the agent a screenshot and write “fix this sentence”: the website's module tells it where the text lies and how to publish the change.",
);

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
    "Organizace je GitHub organizace s kořenovým repozitářem: jeho `AGENTS.md`, Knowledgebase, Mission Control a moduly ve `workspace/` (oddíl Moduly níže). Sdílet celé Pracovní Prostředí nebo jednotlivé aplikace smí člověk jen s aktivními členy téže Organizace, nikdy s někým zvenku (rozhodnutí 0192, cílový model). Kde to Lazurio ještě nenabízí, přístup k modulu nebo aplikaci zařizuje Admin. Personalspace se nesdílí nikdy.",
    "An Organization is a GitHub organization with a root repository: its `AGENTS.md`, Knowledgebase, Mission Control and the modules in `workspace/` (section Modules below). A person may share their whole Work Environment or single applications only with active members of the same Organization, never with an outsider (decision 0192, target model). Where Lazurio does not offer it yet, the Admin arranges access to a module or application. Personalspace is never shared.",
  ),
  blank,
  t("## Moduly", "## Modules"),
  t(
    `Modul lidem vysvětluj jejich prací, ne repozitářem, a těmito slovy: „${moduleSentence.cs}“ Pod modulem je repozitář na GitHubu, takže změny v něm mají historii a jdou vrátit. U záznamů v databázi (\`app/v4\`) a u toho, co agent poslal ven (e-mail, zápis do cizí aplikace), to samo neplatí. Lidem stačí říct: „Nebojte se zkoušet: co je v historii modulu, jde vrátit.“`,
    `Explain a module to people by their work, not by a repository, and in these words: “${moduleSentence.en}” Under the module is a repository on GitHub, so changes in it have a history and can be undone. That alone does not hold for records in a database (\`app/v4\`) or for what an agent sent out (an e-mail, a write to another application). It is enough to tell people: “Do not be afraid to try things: what is in the module's history can be undone.”`,
  ),
  blank,
  t(
    "- **Postup** je pro agenty: jak se v oblasti pracuje, kroky, pravidla a návody. Je to `AGENTS.md` modulu a jeho skilly v `.agents/skills/`.",
    "- **The process** is for agents: how the work in the area is done, its steps, rules and how-tos. It is the module's `AGENTS.md` and its skills in `.agents/skills/`.",
  ),
  t(
    "- **Data** jsou pro lidi i agenty: záznamy a obsah oblasti, třeba zakázky, stránky webu nebo receptury.",
    "- **The data** is for people and agents: the records and content of the area, such as orders, the website's pages or recipes.",
  ),
  t(
    `- **Aplikace** je pro lidi: obrazovka, ve které data vidí a mění, třeba přehled, formulář, nástěnka nebo web. Otevírá se z ${ucs.appsTitle} v Lazuriu. Modul může začít i bez ní a aplikaci mu agent doplní později; takový modul není prázdná složka, drží postup a data.`,
    `- **The app** is for people: the screen where they see and change the data, such as an overview, a form, a board or a website. It opens from ${uen.appsTitle} in Lazurio. A module may start without one and an agent adds the app later; such a module is no empty folder, it holds the process and the data.`,
  ),
  blank,
  moduleWebsiteExample,
  blank,
  t("### Kde leží data", "### Where the data lives"),
  t(
    "Generace aplikace `app/v<N>` neříká kvalitu ani stáří, ale kde leží data. Čísla jsou pro agenty a IT; lidem řekni, kde data leží.",
    "The app's generation `app/v<N>` says neither quality nor age but where the data lives. The numbers are for agents and IT; tell people where the data lives.",
  ),
  blank,
  t(
    "| Generace | Kde leží data | Kdy |",
    "| Generation | Where the data lives | When |",
  ),
  t("| --- | --- | --- |", "| --- | --- | --- |"),
  t(
    "| `app/v1` | Obsah je součástí aplikace. | Modul bez vlastních záznamů, třeba Design System nebo Prezentace. |",
    "| `app/v1` | The content is part of the app. | A module without records of its own, such as a Design System or Presentations. |",
  ),
  t(
    "| `app/v2` | Obsah leží vedle aplikace ve stejném repozitáři, v `data/v2/`, s pevnou strukturou. | Hodně obsahu, který se mění občas a upravují ho agenti, třeba dokumentace. |",
    "| `app/v2` | The content lies beside the app in the same repository, in `data/v2/`, with a fixed structure. | Much content that changes now and then and that agents edit, such as documentation. |",
  ),
  t(
    "| `app/v3` | Záznamy leží ve vlastním datovém repozitáři `<slug>-data` (repository-db), připojeném jako `db/`. Změny dat jsou koncepty, které člověk Publikuje, a data mohou mít jiné přístupy než aplikace. | Záznamy se mění denně a je potřeba historie a schvalování. Výchozí volba pro nový modul s daty. |",
    "| `app/v3` | The records lie in a data repository of their own, `<slug>-data` (repository-db), mounted as `db/`. Data changes are drafts a person Publishes, and the data may have other access than the app. | Records change daily and history and approval are needed. The default for a new module with data. |",
  ),
  t(
    "| `app/v4` | Záznamy leží v databázi Dolt ve Službách serveru Organizace (rozhodnutí 0209, zatím nenasazené). Na GitHubu je aplikace, postup a schéma, řádky ne. | Mnoho lidí zapisuje současně, přístup se liší uvnitř dat, osobní údaje se musí dát smazat nebo zapisuje služba zvenku. |",
    "| `app/v4` | The records lie in a Dolt database in the Organization's Server services (decision 0209, not yet deployed). On GitHub are the app, the process and the schema, not the rows. | Many people write at once, access differs within the data, personal data must be deletable, or an outside service writes. |",
  ),
  blank,
  t(
    "Modul začíná co nejníž a výš jde řízeným přechodem, až to používání opravdu potřebuje: nová `app/v<N+1>` vedle staré, převod dat a přepnutí `default_app`. Organizace s více servery používá tentýž `app/v4` s jiným nastavením připojení. Neon ani jinou databázi mimo Organizaci nedoporučuj.",
    "A module starts as low as it can and moves up by a controlled transition once its use really needs it: a new `app/v<N+1>` beside the old one, the data moved and `default_app` switched. An Organization with several servers uses the same `app/v4` with another connection setting. Do not recommend Neon or any other database outside the Organization.",
  ),
  blank,
  t(
    "### Jak modul vzniká a mění se",
    "### How a module comes to be and changes",
  ),
  t(
    `Nový modul staví agent s člověkem skillem \`new-module\`: rozhovor o účelu, plán k potvrzení a \`lazurio module create\`. Osobní modul si člověk založí sám. Modul Organizace zakládá Admin, protože mu vytvoří repozitář a určí, kdo ho dostane; člen bez role Admina s tebou dokončí popis a ty z potvrzeného popisu připravíš žádost skillem \`admin-request\`. Dlaždici „${ucs.appsNewModule}“ má dnes ve Workspace Organizace jen Admin; cílově ji uvidí i člen, ztlumenou se zámkem, a dovede ho k žádosti Adminovi (rozhodnutí 0179, zatím nenasazené). Týmové Prostředí moduly nezakládá a dlaždici nemá.`,
    `An agent builds a new module with the person through the skill \`new-module\`: the interview about its purpose, the plan to confirm and \`lazurio module create\`. A person creates a personal module alone. An Organization's module is created by the Admin, who creates its repository and decides who gets it; a member without the Admin role finishes the description with you and you turn the confirmed description into a request with the skill \`admin-request\`. In an Organization's Workspace only the Admin has the tile “${uen.appsNewModule}” today; as the target a member sees it too, muted with a lock, and it leads them to the request to the Admin (decision 0179, not yet deployed). A Team Environment creates no modules and has no such tile.`,
  ),
  blank,
  t(
    `Hotový základ nabízí ${ucs.appsMarketplace}, v Lazuriu ${ucs.marketAppTemplates}: „${ucs.marketAdd}“ předá agentovi přesné zadání a převzetí jde podle \`docs/adoption.md\` šablony přesně z commitu vydání. Šablona se přidá jako soukromá kopie, takže je to vždy vlastní modul Organizace. Do osobního prostoru šablony zatím nejdou.`,
    `A ready base comes from the ${uen.appsMarketplace}, in Lazurio ${uen.marketAppTemplates}: “${uen.marketAdd}” hands the agent an exact brief, and the adoption follows the template's \`docs/adoption.md\` from exactly the release's commit. A template is added as a private copy, so it is always the Organization's own module. Templates do not go into a personal space yet.`,
  ),
  blank,
  t(
    "Změna jde jako každá práce: člověk ji zadá v Chatu, agent ji ukáže v pravém panelu a na „publikuj“ ji Publikuje. Na GitHub nikdo chodit nemusí.",
    "A change goes like any work: the person asks for it in Chat, the agent shows it in the right panel and Publishes it on “publish”. Nobody has to go to GitHub.",
  ),
  blank,
  t(
    "### Kdo modul dostane a jak se k němu dostane",
    "### Who gets a module and how it arrives",
  ),
  t(
    `Kdo dosáhne na zdrojový kód modulu Organizace (přístup k modulu), rozhoduje živý grant Teamu na GitHubu (rozhodnutí 0186); cílově ho drží Lazurio Auth a GitHub se z něj odvozuje (rozhodnutí 0231, zatím nenasazené). Teamy z \`lazurio module create --teams\` ho dostanou při založení, ostatní určuje Admin v Přehledu Organizace → Moduly → Přístup; maintainer modulu o změnu žádá. Kdo smí do běžící aplikace modulu a jestli jako admin aplikace, nebo uživatel aplikace, určují role aplikace (\`manual/roles.md\`). Kdo přístup nikdy neměl, modul v ${ucs.appsTitle} nemá a agent ho nepřečte; jméno z manifestu Organizace vidět může. Když přístup k modulu skončí, Lazurio jeho kopii z Pracovního Prostředí s přiděleným člověkem smaže i s neuloženou prací a worktrees, po zastavení jeho aplikace (rozhodnutí 0232, F72). Stane se to až po dvou kontrolách za sebou, s odstupem aspoň půl hodiny: přihlášený je ten člověk, jeho token má plný rozsah \`repo\`, dál čte kořen a aspoň jeden soukromý repozitář Organizace a GitHub na repozitář modulu odpoví 404. Výpadek ani nejasná odpověď nic nesmaže a počítání začne znovu; token omezený na vybrané repozitáře nebo bez platné SSO autorizace nedokáže nic, takže s ním kopie zůstává. Jinde (počítač uživatele, Týmové Prostředí, Prostředí Henry, modul jiné Organizace) kopie zůstane, jen se přestane aktualizovat. Po odebrání řekne ${ucs.accessCheck}, co odešlo; modul Organizace zůstane deklarovaný a chybí jen v tomto Prostředí. Osobní modul patří jen do osobního prostoru a do Organizace nejde.`,
    `The Team's live grant on GitHub decides who reaches an Organization's module's source code (module access, decision 0186); as the target Lazurio Auth holds it and GitHub is derived from it (decision 0231, not yet deployed). The Teams of \`lazurio module create --teams\` get it when it is created; the Admin decides the rest in the Organization's Dashboard → Modules → Access, and the module's maintainer asks for a change. Who may open a module's running application, and as an application admin or an application user, the application roles decide (\`manual/roles.md\`). Whoever never had access does not have the module in ${uen.appsTitle} and the agent cannot read it; its name may still show in the Organization's manifest. When access to a module ends, Lazurio deletes its copy from a Work Environment with an assigned person, unsaved work and worktrees included, after stopping its app (decision 0232, F72). That happens only after two checks in a row at least half an hour apart: that person is signed in, their token has the full \`repo\` scope, they still read the Organization's root and at least one of its private repositories, and GitHub answers 404 for the module's repository. An outage or an unclear answer deletes nothing and the count starts over; a token limited to chosen repositories or without a valid single sign-on proves nothing, so with one the copy stays. Elsewhere (the user's computer, a Team Environment, a Henry Environment, another Organization's module) the copy stays and only stops updating. After a removal ${uen.accessCheck} says what left; the Organization's module stays declared and is only missing from this Environment. A personal module belongs only in the personal space and never goes into an Organization.`,
  ),
  blank,
  t(
    `Kdo přístup dostane, tomu Lazurio modul doručí samo. Synchronizace obsahu běží při startu Launchpadu a pak každou hodinu, jako první část \`lazurio update\` a na vyžádání příkazem \`lazurio organization sync\` (rozhodnutí 0212). Modul nebo jeho datový repozitář, ke kterému identita tohoto Prostředí nově dosáhne, naklonuje, a modul se pak objeví v ${ucs.appsTitle}, obvykle do hodiny od udělení přístupu a merge jeho slotu; je to pokus, ne záruka. Nedoručí ho na Týmové Prostředí, jehož obsah připravuje hosting, nedoručí slot s přístupem \`restricted\` nebo \`private\` ani nic pod ním a nedoručí nic z Organizace, jejíž kořenový checkout synchronizace nechala zablokovaný (\`manual/troubleshooting.md\`).`,
    `Whoever gets access gets the module from Lazurio by itself. Content synchronization runs when the Launchpad starts and then every hour, as the first part of \`lazurio update\` and on request with \`lazurio organization sync\` (decision 0212). It clones a module or its data repository that this Environment's identity can newly read, and the module then appears in ${uen.appsTitle}, usually within an hour of the grant and the merge of its slot; that is an attempt, not a guarantee. It does not deliver to a Team Environment, whose content the hosting prepares, it does not deliver a slot with the access \`restricted\` or \`private\` or anything below one, and it delivers nothing of an Organization whose root checkout the synchronization left blocked (\`manual/troubleshooting.md\`).`,
  ),
  blank,
  t("### Modul, Soubory a Integrace", "### Modules, Files and Integrations"),
  t(
    `Modul je sdílená oblast práce: má historii a sdílí se podle přístupů. **${ucs.filesTitle}** (\`~/Documents/\`) jsou pracovní stůl agentů v jednom Prostředí: s dalšími Prostředími se nesdílí a nezálohují se, takže co má sdílet tým nebo přežít Prostředí, patří do modulu. **Integrace** je cizí aplikace, kterou agent používá zvenku a do jejího kódu nevidí. Vlastní modul se vyplatí, když Organizace chce vlastní postup a aplikaci; Integrace, když se cizí aplikace používá z velké části.`,
    `A module is a shared area of work: it has a history and is shared by access. **${uen.filesTitle}** (\`~/Documents/\`) are the agents' desk in one Environment: they are not shared with other Environments and are not backed up, so what a team should share or what must outlive the Environment belongs in a module. **An Integration** is someone else's app that the agent uses from outside, without seeing its code. A module of its own pays off when the Organization wants its own process and app; an Integration, when another app is used for most of the work.`,
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
    `- **Telefon s vlastním účtem ChatGPT** (Plus a vyšší, nebo Business, stejný účet jako Codex v Prostředí) spáruje člověk sám tam, kde ho Lazurio nabízí: ${phonePath.cs} → ${ucs.phonePair}, v aplikaci ChatGPT Codex → Přidat počítač a naskenovat QR kód (rozhodnutí 0215). Párování jde jen tam, kde Lazurio v Prostředí rozpozná funkci vzdáleného ovládání; jinak ho stránka ukáže jako nedostupné. Telefon nepotřebuje Tailscale ani heslo. Odebere ho v seznamu ${ucs.phoneDevices} tlačítkem ${ucs.phoneRemove}.`,
    `- **A phone with an own ChatGPT account** (Plus or higher, or Business, the same account as Codex in the Environment) the person pairs alone where Lazurio offers it: ${phonePath.en} → ${uen.phonePair}, then in the ChatGPT app Codex → Add a computer and scan the QR code (decision 0215). Pairing works only where Lazurio detects the remote-control feature in the Environment; otherwise the page shows it as unavailable. The phone needs neither Tailscale nor a password. They remove it in the list ${uen.phoneDevices} with ${uen.phoneRemove}.`,
  ),
  t(
    `- **Na poolu** stránka hlásí „${ucs.phoneStateOrganizationAi}“: párování přes účet ChatGPT tam nejde. Cesty jsou dvě a obě vedou přes Admina: přechod na vlastní účet (výš), nebo dočasná cesta Organizace, pokud ji má ve svých skillech (třeba iPhone přes SSH s heslem). Na Týmovém Prostředí stránka hlásí „${ucs.phoneStateTeam}“`,
    `- **On the pool** the page says “${uen.phoneStateOrganizationAi}”: pairing through the ChatGPT account does not work there. There are two ways and both go through the Admin: moving to an own account (above), or the Organization's temporary path where its skills have one (an iPhone over SSH with a password, say). In a Team Environment the page says “${uen.phoneStateTeam}”`,
  ),
  t(
    "- **Ve veřejném DNS** (rozhodnutí 0213) lidé nemají SSH a párování se ukazuje jako nedostupné; do Prostředí vstupují jen webem (Launchpad, chat, MausBot, Buddy). Telefon ani počítač se tam nepřipojí z žádného zdroje AI a nezmění to ani Admin.",
    "- **In public DNS** (decision 0213) people have no SSH and pairing shows as unavailable; they enter the Environment only on the web (Launchpad, chat, MausBot, Buddy). No phone or computer connects there from either AI source, and the Admin cannot change that.",
  ),
  t(
    `- **Počítač** s ChatGPT Desktopem připojí člověk v ${computerPath.cs} → ${ucs.computerConnect}: dostane prompt pro agenta na svém počítači. ${ucs.sshTitle} je pokročilá možnost.`,
    `- **A computer** with ChatGPT Desktop the person connects in ${computerPath.en} → ${uen.computerConnect}: they get a prompt for the agent on their computer. ${uen.sshTitle} is an advanced option.`,
  ),
  blank,
  t("## Zařízení a síť", "## Devices and the network"),
  t(
    "Cílově pouští Organizace s tailnetem do svých Prostředí jen zařízení, která schválil Admin (rozhodnutí 0192, cílový model). Přechod není dokončený a jak zařízení dnes získá přístup, se mezi tailnety liší: co platí v Organizaci, říká její `AGENTS.md`, jinak Admin. Neříkej uživateli, že je zařízení blokované nebo povolené, dokud to neověříš. Zařízení zaregistruje člověk sám v aplikaci Tailscale svým Lazurio účtem; registrace sama přístup nedává. Schválení je věc Admina: cílově kliknutím v Přehledu Organizace, dnes v některých Organizacích reviewovanou změnou v repozitáři nasazení. Ztracené zařízení ohlásí člověk Adminovi hned. Organizace ve veřejném DNS (rozhodnutí 0213) zařízení neschvaluje: vstupuje se Lazurio účtem a jen webem. Postup registrace je v `manual/this-machine.md`, oddíl Přidání počítače do tailnetu.",
    "As the target, an Organization with a tailnet lets only devices its Admin approved into its Environments (decision 0192, target model). The transition is not complete, and how a device gets access today differs between tailnets: the Organization's `AGENTS.md` says what holds there, otherwise the Admin. Do not tell the user that a device is blocked or allowed until you have checked. The person registers the device alone in the Tailscale app with their Lazurio account; registration alone grants no access. Approval is the Admin's: as the target with a click in the Organization's Dashboard, today in some Organizations by a reviewed change in the Deployment Repo. The person reports a lost device to the Admin at once. An Organization in public DNS (decision 0213) approves no devices: entry is with the Lazurio account and only on the web. The registration steps are in `manual/this-machine.md`, section Adding a computer to a tailnet.",
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
    "Servery a Prostředí Organizace se mění jen pull requestem do jejího soukromého repozitáře nasazení (Deployment Repo, často `<org>/infra`; rozhodnutí 0205). CI spočítá Plán, review dělá někdo jiný než autor a apply povolí až merge člověka s živým právem spolu s jeho samostatným schválením v GitHub Environment; teprve pak změnu provede runner. Nikdo nemění server ručně. Běžní členové Organizace do toho repozitáře obvykle přístup nemají; jejich agent v něm nic nenavrhuje a změnu svěří Adminovi žádostí.",
    "An Organization's servers and Environments change only by a pull request to its private Deployment Repo (often `<org>/infra`; decision 0205). CI computes the Plan, someone other than the author reviews it, and only a merge by a person with live rights together with their separate approval in the GitHub Environment authorizes the apply; only then does a runner apply it. Nobody changes a server by hand. Ordinary members of the Organization usually have no access to that repository; their agent proposes nothing in it and hands the change to the Admin by a request.",
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
    "| Osobní modul | s agentem (`new-module`) | — |",
    "| Personal module | with the agent (`new-module`) | — |",
  ),
  t(
    "| Nový modul Organizace | popíše s agentem a požádá | založí s agentem (`new-module`) |",
    "| New module of the Organization | describes it with the agent and asks | creates it with the agent (`new-module`) |",
  ),
  t(
    "| Přístup k modulu | požádá | udělí grant |",
    "| Access to a module | asks | grants it |",
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
    "1. Ověř, že žadatel je aktivní člen Organizace a že žádost je jeho: autor issue. Žádost od identity Teamu jmenuje člověka jen textem, a to ho neověřuje, protože identitu Teamu sdílí celý Team. Ber ji jako jeho, až ji potvrdí svým vlastním účtem (komentářem v issue); do té doby je neověřená a rozhoduje o ní Admin.",
    "1. Check that the requester is an active member of the Organization and that the request is theirs: the issue's author. A request from a Team's identity names the person only in its text, which does not verify them, because the whole Team shares that identity. Treat it as theirs once they confirm it with their own account (a comment in the issue); until then it is unverified and the Admin decides on it.",
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
    "Cíl je volba v Přehledu Organizace (rozhodnutí 0229, zatím nenasazené). Dokud tam není, je to reviewovaný pull request do repozitáře nasazení podle skillu Organizace: jedna změna na jednom místě, Plán z CI commitnutý beze změny, review od někoho jiného než autora na přesném headu, merge Admina a jeho samostatné schválení v GitHub Environment, teprve potom apply runnerem. Na serveru nic neměň ručně. Po přechodu na vlastní účet se kolega přihlásí v Začínáme; po návratu na pool Začínáme ukáže „Zajišťuje vaše Organizace.“ Výsledek ověř a zapiš do žádosti.",
    "The target is a choice in the Organization's Dashboard (decision 0229, not yet deployed). Until it is there, it is a reviewed pull request to the Deployment Repo by the Organization's skill: one change in one place, the CI Plan committed unchanged, a review by someone other than the author on the exact head, the Admin's merge and their separate approval in the GitHub Environment, and only then the apply by the runner. Change nothing on the server by hand. After a move to an own account the colleague signs in at Getting started; after a return to the pool Getting started says “Provided by your Organization.” Check the result and write it in the request.",
  ),
  blank,
  t("### Schválení a odebrání zařízení", "### Approving and removing a device"),
  t(
    "Zařízení registruje člověk sám. Kde Organizace zařízení schvaluje (cíl rozhodnutí 0192, přechod není dokončený), Admin schvaluje konkrétní uzel podle záznamu Headscale (číslo uzlu, machine key, vlastník), nikdy podle jména (rozhodnutí 0192). Kde Přehled Organizace schvalování nenabízí, jde to reviewovanou změnou v repozitáři nasazení podle skillu Organizace. Ztracené zařízení odeber přednostně. Schválení zařízení neotevírá Osobní Prostředí: tam rozhoduje vlastník Conglomerate Hostu.",
    "The person registers a device alone. Where the Organization approves devices (the target of decision 0192; the transition is not complete), the Admin approves a specific node by its Headscale record (node number, machine key, owner), never by its name (decision 0192). Where the Organization's Dashboard does not offer approval, it goes by a reviewed change in the Deployment Repo, by the Organization's skill. Remove a lost device first. Approving a device does not open a Personal Environment: there the Conglomerate Host's owner decides.",
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
  t("### Nový modul na žádost", "### A new module on request"),
  t(
    `Žádost nese popis, který kolega potvrdil. Založ modul skillem \`new-module\`: rozhovor jen o tom, co popis neříká, Teamy podle žádosti a plán k potvrzení. Do žádosti napiš, kde modul je a kdy ho kolega uvidí: v ${ucs.appsTitle} svého Prostředí obvykle do hodiny po merge slotu (\`manual/mechanisms.md\`, oddíl Moduly).`,
    `The request carries the description the colleague confirmed. Create the module with the skill \`new-module\`: an interview only about what the description leaves out, the Teams as the request says and the plan to confirm. Write in the request where the module is and when the colleague will see it: in ${uen.appsTitle} of their Environment usually within an hour of the slot's merge (\`manual/mechanisms.md\`, section Modules).`,
  ),
  blank,
  t(
    "### Přístupy k modulům a Integrace Organizace",
    "### Module access and the Organization's Integrations",
  ),
  t(
    "Grant Teamu k modulu měň v Přehledu Organizace (Moduly → Přístup), kde to jde, jinak na GitHubu právy Admina (rozhodnutí 0186). Přístup dostanou jen členové Organizace. Integraci pro celou Organizaci připojuje Admin sám svým přihlášením; agent ji nepřipojuje za něj.",
    "Change a Team's grant to a module in the Organization's Dashboard (Modules → Access) where possible, otherwise on GitHub with the Admin's rights (decision 0186). Access goes only to members of the Organization. The Admin connects an Integration for the whole Organization with their own sign-in; the agent never connects it for them.",
  ),
  blank,
  t("## Co Admin nedělá", "## What the Admin does not do"),
  t(
    "Nepublikuje za kolegu, nečte Personalspace, nepíše hesla do chatu, issue, pull requestu ani logu, neobchází review a branch rules, nemění servery ručně a nepřihlašuje vlastní účty v Prostředí kolegy. Role Admina je schopnost, ne souhlas s Publikací.",
    "Does not publish for a colleague, does not read Personalspace, writes no password into a chat, issue, pull request or log, does not bypass review and branch rules, does not change servers by hand and does not sign in their own accounts in a colleague's Environment. The Admin role is a capability, not consent to Publication.",
  ),
];
