import { type MessageKey, messages } from "../launchpad/messages";
import { folderCzechLabels } from "./held-labels";
import {
  productionAdmin,
  productionApplicationRoles,
  productionMechanisms,
} from "./production-applications";
import type { Text } from "./render";

// Two chapters of the agent manual (decision F14) for the agents of people in
// an Organization's Environments, who asked them how Lazurio's mechanisms work
// and got guesses (2026-11-05): `mechanisms.md` explains to every agent what
// each mechanism is, what the person does alone and where, and what only the
// Organization Admin does; `admin.md` holds the Organization Admin's procedures. Both are
// the same on every Machine of one locale, like `lazurio.md`. The Organization
// keeps only its own facts (who its Organization Admins are, its temporary paths) in its
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
// for the role, the Platform's own role check reads an active Organization
// Owner (the GitHub Organization's owner role) as the Organization Admin (`src/content/role.ts`); the text says so
// and names the target.
export const roleCheck: readonly Text[] = [
  t(
    "Roli ověř živě pro nasazenou autoritu Organizace, nikdy podle jména, persony ani souboru v repozitáři. Následující příkazy ověřují jen dosavadní autoritu `owner`: aktivního Vlastníka Organizace na GitHubu. Neověřují jmenovaného Admina Organizace při autoritě `admin`. `<org>` je GitHub organizace kořenového repozitáře Organizace (`git -C organizations/<složka> remote get-url origin`):",
    "Check the role live for the Organization's deployed authority, never by a name, persona or repository file. The commands below verify only the current `owner` authority: an active GitHub Organization Owner. They do not verify an appointed Organization Admin under `admin` authority. `<org>` is the GitHub organization of the Organization's root repository (`git -C organizations/<folder> remote get-url origin`):",
  ),
  blank,
  t(
    "**Autorita `admin`: zatím blokovaná cesta.** Rozhoduje účinná role jednajícího Lazurio účtu, nikoli členství na GitHubu. Tento manuál zatím nemá podporovaný konkrétní postup jejího živého ověření a přihlášení bez GitHubu dosud neexistuje. Neprováděj touto cestou správu Organizace, dokud není doložené nasazené přihlášení a podporované živé ověření účinné role pro konkrétní Lazurio subject. Nepředpokládej ji z deklarace, starého tokenu ani výpisu Vlastníků GitHubu a nevymýšlej náhradní API nebo přihlášení. Uveď blokaci, ne tvrzení, že je člověk Člen Organizace bez práv.",
    "**Authority `admin`: currently blocked.** The acting Lazurio account's effective role decides, not GitHub membership. This manual does not yet have a supported concrete live-verification procedure for that role, and sign-in without GitHub does not exist yet. Perform no Organization administration by this path until deployed sign-in and a supported live check of the effective role for the exact Lazurio subject are evidenced. Never infer it from a declaration, old token or GitHub Owners list, and invent no substitute API or sign-in. Report the blocker instead of claiming the person is an Organization Member without rights.",
  ),
  blank,
  t("```sh", "```sh"),
  t(
    "gh api user/memberships/orgs/<org> --jq '.role + \" \" + .state'   # owner: admin active = aktivní Vlastník Organizace; do nasazení role mu připadají jen správní úkony Admina Organizace",
    "gh api user/memberships/orgs/<org> --jq '.role + \" \" + .state'   # owner: admin active = an active Organization Owner; until the role is deployed only the Organization Admin's administrative acts fall to them",
  ),
  t(
    "gh api 'orgs/<org>/members?role=admin' --jq '.[].login'          # Vlastníci pro autoritu owner",
    "gh api 'orgs/<org>/members?role=admin' --jq '.[].login'          # Owners for owner authority",
  ),
  t("```", "```"),
  blank,
  t(
    "Admin Organizace je cílově role Lazuria: jmenuje ho Vlastník Organizace v repozitáři nasazení Organizace (Deployment Repo), jmenování potvrdí v Lazuriu a roli drží Lazurio Auth; Přehled Organizace ji ukazuje a Vlastník Organizace ji tam smí hned odebrat (rozhodnutí 0245, cílový model). Role Vlastníka Organizace roli Admina Organizace pro přístup nikdy nezastupuje, ani v přechodu. Do nasazení role v Lazurio Auth připadají aktivnímu Vlastníkovi Organizace (na GitHubu role Owner, odpověď `admin active`) jen správní úkony Admina Organizace: schvalování zařízení, zdroj AI, odpovědi na žádosti a role aplikací. Vstup do žádného Prostředí mu nedávají a správní stanoviště má jen ten, koho jako Admina Organizace jmenuje reviewovaná změna. Tak tuto cestu čte instalace Organizace a `lazurio organization role <Organizace>` ji vypíše jako `organization-admin`. Tento příkaz nenahrazuje živé ověření jmenovaného Admina Organizace pro autoritu `admin`. `member active` dokládá jen členství na GitHubu; selhání GitHubu nedokládá žádnou roli. Neověřený stav označ jako neznámý a neprováděj správu, která vyžaduje Admina Organizace. Na Týmovém Prostředí jedná identita Teamu, která Adminem Organizace není nikdy. Z dosavadního výpisu Vlastníků vynech boty a persony. `AGENTS.md` Organizace může Adminy Organizace a správní stanoviště jmenovat; je to vodítko, ne oprávnění.",
    "The Organization Admin is, as the target, a Lazurio role: an Organization Owner appoints the Admin in the Organization's Deployment Repo and confirms the appointment in Lazurio, and Lazurio Auth holds the role; the Organization's Dashboard shows it and lets the Owner remove it at once (decision 0245, target model). The Organization Owner role never stands in for the Organization Admin role for access, not even in the transition. Until the role in Lazurio Auth is deployed, only the Organization Admin's administrative acts fall to an active Organization Owner (GitHub Owner, `admin active`): the approval of devices, the AI source, the answers to requests and the roles of applications. They give that Owner entry to no Environment, and only a person whom a reviewed change names as the Organization Admin has an administrative station. Organization installation reads this path that way, and `lazurio organization role <Organization>` prints it as `organization-admin`. That command is no substitute for live verification of an appointed Organization Admin under `admin` authority. `member active` proves only GitHub membership; a GitHub failure proves no role. Mark unverified state unknown and perform no administration requiring the Organization Admin. In a Team Environment the Team identity acts and is never an Organization Admin. Leave bots and personas out of the current Owners list. The Organization's `AGENTS.md` may name its Organization Admins and administrative station; that is a pointer, not a right.",
  ),
];

export const mechanisms: readonly Text[] = [
  t(
    "Lidé se agentů ptají, jak co v Lazuriu funguje, a chtějí po nich věci, které patří Adminovi Organizace. Tato kapitola říká u každého mechanismu, co to je, co člověk udělá sám a kde, a co za něj udělá Admin Organizace. Odpovídej podle ní, ne odhadem. Co smí jen Admin Organizace, za uživatele bez role Admina Organizace nedělej a nehledej cestu kolem: připrav žádost skillem `admin-request`. Postupy Admina Organizace jsou v `manual/admin.md`, nastavení tohoto Prostředí v `manual/this-machine.md`.",
    "People ask agents how things work in Lazurio and ask them for things that belong to the Organization Admin. For each mechanism this chapter says what it is, what the person does alone and where, and what the Organization Admin does for them. Answer from it, not from a guess. What only the Organization Admin may do, do not do for a user without the Organization Admin role and do not look for a way around it: prepare a request with the skill `admin-request`. The Organization Admin's procedures are in `manual/admin.md`, this Environment's setup in `manual/this-machine.md`.",
  ),
  blank,
  t(
    "Rozhodnutí se stavem „rozhodnuto, zatím nenasazeno“ nebo „navrženo“ popisuj jako cíl, ne jako funkci, kterou člověk najde. Stav najdeš v rejstříku rozhodnutí (`manual/lazurio.md`, oddíl Pravidla hry jsou veřejná). Co popisuje Organizace ve svém `AGENTS.md` nebo skillech jako dočasnou cestu, má před cílem přednost, dokud produkt cíl nedodá.",
    "Describe a decision whose status is “decided, not yet deployed” or “proposed” as a target, not as a feature the person will find. You find the status in the decision register (`manual/lazurio.md`, section The rules of the game are public). Where the Organization's `AGENTS.md` or skills describe a temporary path, it takes precedence over the target until the product delivers it.",
  ),
  blank,
  t("## Kdo je kdo", "## Who is who"),
  t(
    "- **Uživatel** je člověk, pro kterého pracuješ; v Pracovním Prostředí jeho Přidělený uživatel, ten, komu ho Organizace přiřadila (`manual/roles.md`). Role mají jména podle rozhodnutí 0234 a vždy pojmenují svou úroveň: Admin Organizace, Správce modulu, Admin aplikace, nikdy jen Admin.",
    "- **The user** is the person you work for; in a Work Environment its Assigned User, the one the Organization assigned it to (`manual/roles.md`). Roles have the names of decision 0234 and always name their level: Organization Admin, Module Maintainer, Application Admin, never just Admin.",
  ),
  t(
    "- **Admin Organizace** spravuje v hranicích, které určuje Vlastník Organizace, členy, Teamy, přístupy, zařízení, zdroj AI a Prostředí své Organizace. Má servisní vstup do jejích Pracovních a Týmových Prostředí, nikdy do Osobního Prostředí: cílově ho otevírá s důvodem a jen přes nahrávací vstupní bod, do nasazení jen ze správního stanoviště, které repozitář nasazení deklaruje jako pojmenovanou výjimku (rozhodnutí 0245 a 0247). Organizace má obvykle jednoho Admina Organizace, může mít víc.",
    "- **The Organization Admin** manages, within the boundaries the Organization Owner sets, the members, Teams, access, devices, AI source and Environments of their Organization. The Admin has service entry to its Work and Team Environments, never to a Personal Environment: as the target the Admin opens it with a reason and only through the recording entry point, and until that is deployed only from an administrative station that the Deployment Repo declares as a named exception (decisions 0245 and 0247). An Organization usually has one Organization Admin and may have more.",
  ),
  t(
    "- **Vlastník Organizace** vlastní GitHub Organizaci a jmenuje a odvolává Adminy Organizace; sám o sobě do žádného Prostředí nevstupuje (rozhodnutí 0245).",
    "- **The Organization Owner** owns the GitHub Organization and appoints and removes the Organization Admins; by that alone they enter no Environment (decision 0245).",
  ),
  t(
    "- **Člen Organizace** je každý další člověk v Organizaci. Co smí, plyne z jeho rolí na úrovni modulů (Čtenář modulu, Přispěvatel modulu, Správce modulu) a aplikací (Admin aplikace, Uživatel aplikace).",
    "- **An Organization Member** is every other person in the Organization. What they may do follows from their roles at the level of modules (Module Reader, Module Contributor, Module Maintainer) and applications (Application Admin, Application User).",
  ),
  t(
    "- Prostředí patří tomu, kdo ho vlastní: Osobní Prostředí člověku, Pracovní a Týmové Organizaci.",
    "- An Environment belongs to whoever owns it: a Personal Environment to the person, a Work or Team Environment to the Organization.",
  ),
  t(
    "- **Henry**, persona Organizace, dělá review a automatizace v Prostředí s automatizacemi, pokud ho Organizace má. Adminem Organizace není a vlastní práva nemá (rozhodnutí 0169).",
    "- **Henry**, the Organization's persona, does reviews and automations in the Environment with automations, where the Organization has one. It is not an Organization Admin and has no rights of its own (decision 0169).",
  ),
  blank,
  t("### Jak poznáš roli uživatele", "### How you tell the user's role"),
  ...roleCheck,
  blank,
  t("## Prostředí", "## Environments"),
  t(
    "Lidé znají tři druhy: Osobní Prostředí patří jednomu člověku a jeho Buddymu, Pracovní Prostředí vlastní Organizace a přiřadí ho člověku, Týmové Prostředí sdílí celý Team a pracuje identitou Teamu (rozhodnutí 0207). Organizace k nim může mít Prostředí s automatizacemi (Henry) a na každém serveru Služby serveru, kam smějí jen Admini Organizace a kde běží AI pool (rozhodnutí 0209, zatím nenasazené). Nové Prostředí, jeho přidělení člověku, víc paměti nebo disku a jeho zrušení zařizuje Admin Organizace. Uživatel ani jeho agent na serveru nic nemění.",
    "People know three kinds: a Personal Environment belongs to one person and their Buddy, a Work Environment is owned by the Organization and assigned to a person, a Team Environment is shared by a whole Team and works with the Team's identity (decision 0207). Beside them an Organization may have an Environment with automations (Henry) and, on each server, Server services, which only Organization Admins enter and where the AI pool runs (decision 0209, not yet deployed). A new Environment, its assignment to a person, more memory or disk and its removal are the Organization Admin's. Neither the user nor their agent changes anything on the server.",
  ),
  blank,
  t(
    `Co člověk v Prostředí nastavuje sám, najde v Nastavení (ozubené kolo vedle názvu Prostředí): ${ucs.startTitle}, ${ucs.connectionsTitle}, ${ucs.toolsTitle}, ${ucs.integrationsTitle}, ${ucs.filesTitle} a ${ucs.recoveryTitle}. Když Prostředí nefunguje, začni v ${recoveryPath.cs} (rozhodnutí 0166); co se tam nespraví, patří Adminovi Organizace.`,
    `What a person sets up alone is in Settings (the gear beside the Environment's name): ${uen.startTitle}, ${uen.connectionsTitle}, ${uen.toolsTitle}, ${uen.integrationsTitle}, ${uen.filesTitle} and ${uen.recoveryTitle}. When the Environment does not work, start in ${recoveryPath.en} (decision 0166); what you cannot repair belongs to the Organization Admin.`,
  ),
  blank,
  t("## Organizace, moduly a přístupy", "## Organizations, modules and access"),
  t(
    "Organizace je GitHub organizace s kořenovým repozitářem: jeho `AGENTS.md`, Knowledgebase, Mission Control a moduly ve `workspace/` (oddíl Moduly níže). Sdílet celé Pracovní Prostředí nebo jednotlivé aplikace smí člověk jen s lidmi s aktivním členstvím v téže Organizaci, nikdy s někým zvenku (rozhodnutí 0245, cílový model). Kde to Lazurio ještě nenabízí, roli modulu nebo aplikace zařizuje Admin Organizace. Personalspace se nesdílí nikdy.",
    "An Organization is a GitHub organization with a root repository: its `AGENTS.md`, Knowledgebase, Mission Control and the modules in `workspace/` (section Modules below). A person may share their whole Work Environment or single applications only with people who have an active membership of the same Organization, never with an outsider (decision 0245, target model). Where Lazurio does not offer it yet, the Organization Admin arranges a Module or application role. Personalspace is never shared.",
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
    `Nový modul staví agent s člověkem skillem \`new-module\`: rozhovor o účelu, plán k potvrzení a \`lazurio module create\`. Osobní modul si člověk založí sám. Modul Organizace zakládá Admin Organizace, protože mu vytvoří repozitář a určí, kdo ho dostane; Člen Organizace bez role Admina Organizace s tebou dokončí popis a ty z potvrzeného popisu připravíš žádost skillem \`admin-request\`. Dlaždici „${ucs.appsNewModule}“ má dnes ve Workspace Organizace jen Admin Organizace; cílově ji uvidí i Člen Organizace, ztlumenou se zámkem, a dovede ho k žádosti Adminovi Organizace (rozhodnutí 0179, zatím nenasazené). Týmové Prostředí moduly nezakládá a dlaždici nemá.`,
    `An agent builds a new module with the person through the skill \`new-module\`: the interview about its purpose, the plan to confirm and \`lazurio module create\`. A person creates a personal module alone. An Organization's module is created by the Organization Admin, who creates its repository and decides who gets it; an Organization Member without the Organization Admin role finishes the description with you and you turn the confirmed description into a request with the skill \`admin-request\`. In an Organization's Workspace only the Organization Admin has the tile “${uen.appsNewModule}” today; as the target an Organization Member sees it too, muted with a lock, and it leads them to the request to the Organization Admin (decision 0179, not yet deployed). A Team Environment creates no modules and has no such tile.`,
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
    `Kdo dosáhne na zdrojový kód modulu Organizace, rozhoduje role modulu: Čtenář modulu ho čte, Přispěvatel modulu ho staví a navrhuje změny a Správce modulu navíc merguje chráněnou \`main\` a vydává ho; kdo roli modulu nemá, k modulu přístup nemá. Dnes je to živý grant na GitHubu (rozhodnutí 0186, 0232: \`pull\`, \`push\`, \`maintain\`); cílově role drží Lazurio Auth a GitHub se z nich odvozuje (rozhodnutí 0231, zatím nenasazené). Teamy z \`lazurio module create --teams\` roli dostanou při založení, ostatním ji nastavuje Admin Organizace v Přehledu Organizace → Moduly → Přístup (nastavení Přístup k modulu, samo rolí není); Správce modulu o změnu žádá. Kdo smí do běžící aplikace modulu a jestli jako Admin aplikace, nebo Uživatel aplikace, určují role aplikace (\`manual/roles.md\`). Kdo přístup nikdy neměl, modul v ${ucs.appsTitle} nemá a agent ho nepřečte; jméno z manifestu Organizace vidět může. Když přístup k modulu skončí, Lazurio jeho kopii z Pracovního Prostředí s přiděleným člověkem smaže i s neuloženou prací a worktrees, po zastavení jeho aplikace (rozhodnutí 0232, F72). Stane se to až po dvou kontrolách za sebou, s odstupem aspoň půl hodiny: přihlášený je ten člověk, jeho token má plný rozsah \`repo\`, dál čte kořen a aspoň jeden soukromý repozitář Organizace a GitHub na repozitář modulu odpoví 404. Výpadek ani nejasná odpověď nic nesmaže a počítání začne znovu; token omezený na vybrané repozitáře nebo bez platné SSO autorizace nedokáže nic, takže s ním kopie zůstává. Jinde (počítač uživatele, Týmové Prostředí, Prostředí Henry, modul jiné Organizace) kopie zůstane, jen se přestane aktualizovat. Po odebrání řekne ${ucs.accessCheck}, co odešlo; modul Organizace zůstane deklarovaný a chybí jen v tomto Prostředí. Osobní modul patří jen do osobního prostoru a do Organizace nejde.`,
    `A Module role decides who reaches an Organization's module's source code: a Module Reader reads it, a Module Contributor builds it and proposes changes, and a Module Maintainer also merges its protected \`main\` and releases it; whoever has no Module role has no access to the module. Today it is the live grant on GitHub (decisions 0186, 0232: \`pull\`, \`push\`, \`maintain\`); as the target Lazurio Auth holds the roles and GitHub is derived from them (decision 0231, not yet deployed). The Teams of \`lazurio module create --teams\` get the role when it is created; the Organization Admin sets it for the rest in the Organization's Dashboard → Modules → Access (the setting Module access, which is no role itself), and a Module Maintainer asks for a change. Who may open a module's running application, and as an Application Admin or an Application User, the application roles decide (\`manual/roles.md\`). Whoever never had access does not have the module in ${uen.appsTitle} and the agent cannot read it; its name may still show in the Organization's manifest. When access to a module ends, Lazurio deletes its copy from a Work Environment with an assigned person, unsaved work and worktrees included, after stopping its app (decision 0232, F72). That happens only after two checks in a row at least half an hour apart: that person is signed in, their token has the full \`repo\` scope, they still read the Organization's root and at least one of its private repositories, and GitHub answers 404 for the module's repository. An outage or an unclear answer deletes nothing and the count starts over; a token limited to chosen repositories or without a valid single sign-on proves nothing, so with one the copy stays. Elsewhere (the user's computer, a Team Environment, a Henry Environment, another Organization's module) the copy stays and only stops updating. After a removal ${uen.accessCheck} says what left; the Organization's module stays declared and is only missing from this Environment. A personal module belongs only in the personal space and never goes into an Organization.`,
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
    `Integrace jsou aplikace připojené k tomuto Prostředí (pošta, kalendář, chat, CRM…). Vlastní účty připojuje uživatel sám na stránce ${integrationsPath.cs}; každé Prostředí drží svá přihlášení a na Týmovém Prostředí je používá celý Team. Integraci pro celou Organizaci (sdílená schránka, účet Organizace v Composiu, firemní MCP server) zařizuje Admin Organizace. Připojená aplikace není souhlas s Publikací. Podrobnosti jsou v \`manual/working-here.md\`, oddíl Integrace.`,
    `Integrations are the applications connected to this Environment (mail, calendar, chat, CRM…). The user connects their own accounts alone in ${integrationsPath.en}; each Environment holds its own sign-ins, and in a Team Environment the whole Team uses them. An Integration for the whole Organization (a shared mailbox, the Organization's Composio account, a company MCP server) is the Organization Admin's. A connected application is not consent to Publication. Details are in \`manual/working-here.md\`, section Integrations.`,
  ),
  blank,
  t("## Publikace", "## Publication"),
  t(
    "Všechno je nejdřív koncept: pull request, koncept e-mailu, vyplněný formulář. Publikuje se až na slovo uživatele, třeba „publikuj“, a merge v chráněném repozitáři potřebuje review (`manual/working-here.md`). Admin Organizace za kolegu nepublikuje a jeho role není souhlas s Publikací v cizím Prostředí.",
    "Everything starts as a draft: a pull request, an e-mail draft, a filled-in form. It is published only on the user's word, such as “publish”, and a merge in a protected repository needs a review (`manual/working-here.md`). An Organization Admin does not publish for a colleague, and the Organization Admin role is no consent to Publication in someone else's Environment.",
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
    "- **Přejít z poolu na vlastní účet a zpět** smí jen Admin Organizace. Cílově to nastaví v Přehledu Organizace pro jednotlivá Prostředí a člověk o změnu požádá přímo v Začínáme (rozhodnutí 0229, zatím nenasazené). Dnes je to reviewovaný pull request do repozitáře nasazení Organizace (rozhodnutí 0205), který připraví agent Admina Organizace podle skillu Organizace. Na poolu se vlastním účtem nepřihlašuj a přechod neobcházej.",
    "- **Moving from the pool to an own account and back** only the Organization Admin may do. As the target they set it per Environment in the Organization's Dashboard, and the person asks for it right in Getting started (decision 0229, not yet deployed). Today it is a reviewed pull request to the Organization's Deployment Repo (decision 0205), which the Organization Admin's agent prepares by the Organization's skill. Do not sign in an own account on the pool and do not work around the change.",
  ),
  t(
    "- **Co přechod znamená:** ukončí rozběhnuté chaty v tom Prostředí a na chvíli i u všech ostatních na stejném poolu, protože se pool restartuje. Claude Code odchází z poolu spolu s Codexem. Pracovní účet ChatGPT Business funguje jen tehdy, když admin pracovního prostoru v ChatGPT povolí Codex mimo ChatGPT; po přechodu se člověk přihlásí v Začínáme.",
    "- **What the move means:** it ends the running chats in that Environment and briefly for everyone else on the same pool, because the pool restarts. Claude Code leaves the pool together with Codex. A ChatGPT Business work account works only where the workspace's administrator allows Codex outside ChatGPT; after the move the person signs in at Getting started.",
  ),
  blank,
  t("## Telefon a počítač", "## Phone and computer"),
  t(
    `- **Telefon s vlastním účtem ChatGPT** (Plus a vyšší, nebo Business, stejný účet jako Codex v Prostředí) spáruje člověk sám tam, kde ho Lazurio nabízí: ${phonePath.cs} → ${ucs.phonePair}, v aplikaci ChatGPT Codex → Přidat počítač a naskenovat QR kód (rozhodnutí 0215). Párování jde jen tam, kde Lazurio v Prostředí rozpozná funkci vzdáleného ovládání; jinak ho stránka ukáže jako nedostupné. Telefon nepotřebuje Tailscale ani heslo. Odebere ho v seznamu ${ucs.phoneDevices} tlačítkem ${ucs.phoneRemove}.`,
    `- **A phone with an own ChatGPT account** (Plus or higher, or Business, the same account as Codex in the Environment) the person pairs alone where Lazurio offers it: ${phonePath.en} → ${uen.phonePair}, then in the ChatGPT app Codex → Add a computer and scan the QR code (decision 0215). Pairing works only where Lazurio detects the remote-control feature in the Environment; otherwise the page shows it as unavailable. The phone needs neither Tailscale nor a password. They remove it in the list ${uen.phoneDevices} with ${uen.phoneRemove}.`,
  ),
  t(
    `- **Na poolu** stránka hlásí „${ucs.phoneStateOrganizationAi}“: párování přes účet ChatGPT tam nejde. Cesty jsou dvě a obě vedou přes Admina Organizace: přechod na vlastní účet (výš), nebo dočasná cesta Organizace, pokud ji má ve svých skillech (třeba iPhone přes SSH s heslem). Na Týmovém Prostředí stránka hlásí „${ucs.phoneStateTeam}“`,
    `- **On the pool** the page says “${uen.phoneStateOrganizationAi}”: pairing through the ChatGPT account does not work there. There are two ways and both go through the Organization Admin: moving to an own account (above), or the Organization's temporary path where its skills have one (an iPhone over SSH with a password, say). In a Team Environment the page says “${uen.phoneStateTeam}”`,
  ),
  t(
    "- **V osobním tailnetu Lazuria** (Osobní Prostředí mimo Conglomerate, `manual/lazurio.md`) se telefon i počítač připojí aplikací Lazurio App s vestavěným tailnetem, telefon s iOS 17 a novějším nebo s Androidem, a do jejího vydání aplikací Tailscale a webovým rozhraním Prostředí. Kdo má starší telefon nebo chce jen telefon, spáruje ho přes vlastní účet ChatGPT jako výš. Plný zážitek je na počítači.",
    "- **In Lazurio's personal tailnet** (a Personal Environment outside a Conglomerate, `manual/lazurio.md`) a phone and a computer connect with Lazurio App and its built-in tailnet, a phone on iOS 17 or later or on Android, and until its release with the Tailscale app and the Environment's web interface. Whoever has an older phone or wants only a phone pairs it through their own ChatGPT account as above. The full experience is on a computer.",
  ),
  t(
    "- **Ve veřejném vstupu referenční Organizace** (rozhodnutí 0213, do jejího návratu do tailnetu) lidé nemají SSH a párování se ukazuje jako nedostupné; do Prostředí vstupují jen webem (Launchpad, chat, MausBot, Buddy). Jiná Organizace na veřejný vstup přejít nemůže.",
    "- **In the reference Organization's public entry** (decision 0213, until its return to its tailnet) people have no SSH and pairing shows as unavailable; they enter the Environment only on the web (Launchpad, chat, MausBot, Buddy). No other Organization can switch to a public entry.",
  ),
  t(
    `- **Počítač** s ChatGPT Desktopem připojí člověk v ${computerPath.cs} → ${ucs.computerConnect}: dostane prompt pro agenta na svém počítači. ${ucs.sshTitle} je pokročilá možnost.`,
    `- **A computer** with ChatGPT Desktop the person connects in ${computerPath.en} → ${uen.computerConnect}: they get a prompt for the agent on their computer. ${uen.sshTitle} is an advanced option.`,
  ),
  blank,
  t("## Zařízení a síť", "## Devices and the network"),
  t(
    "Cílově pouští Organizace s tailnetem do svých Prostředí jen zařízení, která schválil Admin Organizace (rozhodnutí 0245, cílový model). Přechod není dokončený a jak zařízení dnes získá přístup, se mezi tailnety liší: co platí v Organizaci, říká její `AGENTS.md`, jinak Admin Organizace. Neříkej uživateli, že je zařízení blokované nebo povolené, dokud to neověříš. Zařízení zaregistruje člověk sám v aplikaci Tailscale svým Lazurio účtem; registrace sama přístup nedává. Schválení je věc Admina Organizace: cílově kliknutím v Přehledu Organizace, dnes v některých Organizacích reviewovanou změnou v repozitáři nasazení. Ztracené zařízení ohlásí člověk Adminovi Organizace hned; cílově ho smí v Přehledu Organizace hned odebrat i sám a odebrání v Lazurio Auth má přednost (rozhodnutí 0245, cílový model). V osobním tailnetu Lazuria (Osobní Prostředí mimo Conglomerate) Admin Organizace není: zařízení si cílově schvaluje jeho uživatel sám a do té doby je schvaluje provozovatel Lazuria. Referenční Organizace ve veřejném vstupu (rozhodnutí 0213, do jejího návratu do tailnetu) zařízení neschvaluje: vstupuje se Lazurio účtem a jen webem. Postup registrace je v `manual/this-machine.md`, oddíl Přidání počítače do tailnetu.",
    "As the target, an Organization with a tailnet lets only devices an Organization Admin approved into its Environments (decision 0245, target model). The transition is not complete, and how a device gets access today differs between tailnets: the Organization's `AGENTS.md` says what holds there, otherwise the Organization Admin. Do not tell the user that a device is blocked or allowed until you have checked. The person registers the device alone in the Tailscale app with their Lazurio account; registration alone grants no access. Approval is the Organization Admin's: as the target with a click in the Organization's Dashboard, today in some Organizations by a reviewed change in the Deployment Repo. The person reports a lost device to the Organization Admin at once; as the target they may also remove their own device at once in the Organization's Dashboard, and a removal in Lazurio Auth prevails (decision 0245, target model). In Lazurio's personal tailnet (a Personal Environment outside a Conglomerate) there is no Organization Admin: as the target its user approves their own devices, and until then Lazurio's operator approves them. The reference Organization in its public entry (decision 0213, until its return to its tailnet) approves no devices: entry is with the Lazurio account and only on the web. The registration steps are in `manual/this-machine.md`, section Adding a computer to a tailnet.",
  ),
  blank,
  ...productionMechanisms,
  blank,
  t("## Aktualizace", "## Updates"),
  t(
    "Základ Prostředí a Lazurio aktualizuje provozovatel hostingu rolloutem a `lazurio update` srovná checkouty (rozhodnutí 0161). Vydání pro servery a Prostředí Organizace mají cílově přicházet jako aktualizace operačního systému: vlak vydání otevře pull request v repozitáři nasazení a Lazurio Machines ho nasadí na stálý souhlas Organizace; Vlastník Organizace smí souhlas vypnout a každé vydání pak potvrzuje tlačítkem „Aktualizovat“ v Přehledu Organizace (rozhodnutí 0238, zatím nenasazené). Do té doby platí dosavadní postup Organizace. Nástroje uživatele (Codex, Claude Code, `gh` a další) aktualizuješ jen s jeho souhlasem (`manual/troubleshooting.md`). Když něco selže, opravuje se vpřed v Obnově (rozhodnutí 0166). Server, paměť, disk a síť jsou věc Admina Organizace.",
    "The hosting operator updates the Environment's baseline and Lazurio by rollout, and `lazurio update` aligns the checkouts (decision 0161). Releases for an Organization's servers and Environments are, as the target, to arrive like the updates of an operating system: the release train opens the pull request in the Deployment Repo and Lazurio Machines deploys it on the Organization's standing consent; an Organization Owner may switch the consent off and then confirms each release with “Update” in the Organization's Dashboard (decision 0238, not yet deployed). Until then the Organization's present procedure holds. You update the user's tools (Codex, Claude Code, `gh` and others) only with their consent (`manual/troubleshooting.md`). When something fails, it is repaired forward in Recovery (decision 0166). Server, memory, disk and network are the Organization Admin's.",
  ),
  blank,
  t("## Změny serverů a Prostředí", "## Changes to servers and Environments"),
  t(
    "Servery a Prostředí Organizace se mění jen pull requestem do jejího soukromého repozitáře nasazení (Deployment Repo, často `<org>/infra`; rozhodnutí 0205). CI spočítá Plán, review dělá někdo jiný než autor a apply povolí až merge člověka s živým právem spolu s jeho samostatným schválením v GitHub Environment; teprve pak změnu provede runner. Nikdo nemění server ručně. Repozitář nasazení drží i hranice důvěry Organizace: kdo je člen, kdo je Admin Organizace, Zařízení Organizace a výjimky. Cílově ho vidí a mění jen Vlastníci Organizace a jmenované stroje (Lazurio Machines, Lazurio za žádosti z Přehledu Organizace, persona jako reviewer a vlak vydání) a Lazurio Machines změnu aplikuje jen s důkazem schválení: sloučeným pull requestem od člověka s právem, nebo žádostí potvrzenou v Lazuriu; pull request, který Organizaci jen posouvá na vydanou verzi, kryje její stálý souhlas a samotný commit na hlavní větvi nestačí (rozhodnutí 0245, cílový model). Admin Organizace své změny cílově dělá v Přehledu Organizace a pull request za něj otevře Lazurio; dokud to není nasazené, pracuje v repozitáři jako dosud, s přístupem, který má dnes (rozhodnutí 0093). Členové Organizace do toho repozitáře přístup nemají; jejich agent v něm nic nenavrhuje a změnu svěří Adminovi Organizace žádostí.",
    "An Organization's servers and Environments change only by a pull request to its private Deployment Repo (often `<org>/infra`; decision 0205). CI computes the Plan, someone other than the author reviews it, and only a merge by a person with live rights together with their separate approval in the GitHub Environment authorizes the apply; only then does a runner apply it. Nobody changes a server by hand. The Deployment Repo also holds the Organization's boundaries of trust: who is a member, who is an Organization Admin, the Devices of the Organization and the exceptions. As the target only the Organization Owners and named machines see and change it (Lazurio Machines, Lazurio for requests from the Organization's Dashboard, the persona as a reviewer and the release train), and Lazurio Machines applies a change only with proof that it was approved: its pull request merged by a person with the right to it, or a request confirmed in Lazurio; a pull request that only moves the Organization to a released version is covered by its standing consent, and a commit on the main branch alone is no such proof (decision 0245, target model). An Organization Admin makes their changes, as the target, in the Organization's Dashboard, and Lazurio opens the pull request for them; until that is deployed, the Admin works in the repository as before, with the access they hold today (decision 0093). Organization Members have no access to that repository; their agent proposes nothing in it and hands the change to the Organization Admin by a request.",
  ),
  blank,
  t("## Kdo co dělá", "## Who does what"),
  t(
    "| Co | Uživatel sám | Admin Organizace |",
    "| What | The user alone | The Organization Admin |",
  ),
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
    "| Ztracené zařízení | ohlásí hned; cílově ho odebere i sám (rozhodnutí 0245) | odebere |",
    "| Lost device | reports at once; as the target also removes it alone (decision 0245) | removes |",
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
    "| Role modulu (nastavení Přístup k modulu) | požádá | nastaví ji |",
    "| A Module role (the setting Module access) | asks | sets it |",
  ),
  t(
    "| Zveřejnit produkční aplikaci nebo nasadit novou verzi | připraví žádost | schválí: dnes mergem PR nasazení, cílově v Přehledu Organizace; pipeline nasadí |",
    "| Publish a production application or deploy a new version | prepares a request | approves: today by merging the deployment PR, as the target in the Organization's Dashboard; the pipeline deploys |",
  ),
  t(
    "| Přidat nebo odebrat roli v produkční aplikaci | oprávněný Správce modulu či Přispěvatel modulu podle společného postupu; ostatní požádají | ověří členství, změní roli a přečte výsledek |",
    "| Add or remove a production application's role | an authorized Module Maintainer or Module Contributor follows the shared procedure; others ask | checks membership, changes the role and reads back the result |",
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
  t("## Jak požádat Admina Organizace", "## How to ask the Organization Admin"),
  t(
    "Jednou cestou: skill `admin-request`. Agent ověří, že věc opravdu patří Adminovi Organizace, sebere údaje, které Admin Organizace potřebuje, a zapíše jednu žádost jako issue do kořenového repozitáře Organizace se zmínkou Adminů Organizace. Hesla, tokeny ani kódy do ní nepatří. Uživateli dá odkaz a řekne, co bude dál. Když uživatel do kořenového repozitáře nemá přístup, připraví mu krátký text pro Admina Organizace a odeslání nechá na něm. Na veřejném Prostředí žádost nezakládej, jen vysvětli, jak to v Organizaci chodí. Cílově se žádosti podávají přímo v Lazuriu a dostanou se k Adminům Organizace (rozhodnutí 0230, zatím nenasazené); prvním případem je zdroj AI v Začínáme (rozhodnutí 0229).",
    "One way: the skill `admin-request`. The agent checks that the matter really is the Organization Admin's, collects what the Organization Admin needs and files one request as an issue in the Organization's root repository, mentioning the Organization Admins. Passwords, tokens and codes do not belong in it. It gives the user the link and says what happens next. When the user has no access to the root repository, it prepares a short text for the Organization Admin and leaves sending it to the user. In a public Environment file no request; just explain how it works in an Organization. As the target, requests are made right in Lazurio and reach the Organization Admins (decision 0230, not yet deployed); the first case is the AI source in Getting started (decision 0229).",
  ),
];

export const organizationAdmin: readonly Text[] = [
  t(
    "Tato kapitola drží postupy Admina Organizace; před správou Organizace ověř jeho roli. Jedinou společnou částí je oddíl Role produkční aplikace: při změně role aplikace v již nasazeném vlastním modulu ho může použít i Správce modulu nebo Přispěvatel modulu s ověřeným živým grantem a nasazeným ověřovatelem role modulu. Ten přejde přímo k tomuto oddílu a neprovádí ostatní postupy vyhrazené Adminovi Organizace. Kdo nesplňuje podmínky ani jedné cesty, připraví žádost skillem `admin-request` podle `manual/mechanisms.md`; neověřitelnou autoritu `admin` označ jako blokaci podle ověření role níže. Obecný model je tady; konkrétní dočasné cesty, jména Adminů Organizace, správní stanoviště a aktuální práva drží `AGENTS.md` a skilly Organizace. Přečti je před první změnou a kde se s touto kapitolou rozcházejí, platí pro postup Organizace, pro principy tahle kapitola; rozpor zapiš jako issue do kořenového repozitáře Organizace.",
    "This chapter holds the Organization Admin's procedures; verify their role before Organization administration. The sole shared part is Production application roles: for an application-role change in an already deployed app of their own module, a Module Maintainer or Module Contributor with a verified live grant and deployed Module role observer may use it too. They go directly to that section and perform none of the other procedures reserved for the Organization Admin. Whoever qualifies for neither path prepares an `admin-request` by `manual/mechanisms.md`; report unverifiable `admin` authority as a blocker by the role check below. The general model is here; the concrete temporary paths, the Organization Admins' names, the administrative station and the current rights are in the Organization's `AGENTS.md` and skills. Read them before the first change; where they and this chapter disagree, the Organization's text holds for the procedure and this chapter for the principles; file the conflict as an issue in the Organization's root repository.",
  ),
  blank,
  ...roleCheck,
  blank,
  t("## Kde Admin Organizace pracuje", "## Where the Organization Admin works"),
  t(
    "- **Správní stanoviště** je Pracovní Prostředí Admina Organizace, odkud vede servisní vstup přes SSH do Pracovních a Týmových Prostředí lidí téže Organizace, do Prostředí s automatizacemi a do Služeb serveru. Dokud není nasazený servisní vstup přes nahrávací vstupní bod, je každé stanoviště pojmenovaná výjimka deklarovaná jako hranice důvěry v repozitáři nasazení: říká kdo, za jakou roli a Organizaci, odkud, kam, proč a o které rozhodnutí Vlastníka Organizace se opírá. Z role Admina Organizace se žádný klíč ani cesta neodvozuje, sama role Vlastníka Organizace stanoviště nedává a nové vzniká jen novým rozhodnutím Vlastníka Organizace; výjimka skončí s rolí Admina Organizace a všechny najednou, až je servisní vstup nahradí (rozhodnutí 0247, cílový model). Jestli Organizace stanoviště má, říká její `AGENTS.md`. Conglomerate Host ani servery pod Prostředími ze stanoviště nespravuješ: spravuje je jen jejich držitel, tedy operátor Lazuria tam, kde servery provozuje Lazurio, a živý Vlastník Organizace tam, kde je Organizace provozuje sama, jen ze zařízení k tomu schválených a nikdy rolí Admina Organizace (rozhodnutí 0245). Z Osobního Prostředí Admina Organizace se jde přes stanoviště, nikdy přímo.",
    "- **The administrative station** is the Organization Admin's Work Environment, from which service entry over SSH leads into the Work and Team Environments of the people of the same Organization, the Environment with automations and the Server services. Until service entry through the recording entry point is deployed, every station is a named exception declared as a boundary of trust in the Deployment Repo: it names the person, the role and the Organization it stands for, where it starts, which Environments it reaches, the reason, and the decision of the Organization Owner it rests on. No key or route is derived from the Organization Admin role, the Organization Owner role alone gives no station, and a new one needs a new decision of an Organization Owner; an exception ends when the person's Organization Admin role ends, and all of them end together when service entry replaces them (decision 0247, target model). The Organization's `AGENTS.md` says whether it has a station. You do not administer the Conglomerate Host or the servers under the Environments from the station: only their holder does, Lazurio's operator where Lazurio runs the servers and the live Organization Owner where the Organization runs them itself, only from devices approved for it and never by the Organization Admin role (decision 0245). From the Organization Admin's Personal Environment the way goes through the station, never directly.",
  ),
  t(
    "- **Servisní vstup v prohlížeči** do Launchpadu, Chatu a Automate kolegů je cíl rozhodnutí 0247 a nasazený zatím není; i on povede přes nahrávací vstupní bod a ve výchozí úrovni jen ke čtení.",
    "- **Service entry in the browser** to colleagues' Launchpad, Chat and Automate is the target of decision 0247 and is not deployed yet; it too will pass the recording entry point, read only at the default level.",
  ),
  t(
    "- **Repozitář nasazení** Organizace (Deployment Repo) drží hranice důvěry Organizace a mění servery a Prostředí, a kde to Organizace tak má, i zdroj AI a schválená zařízení (rozhodnutí 0205, 0245). Cílově ho vidí a mění jen Vlastníci Organizace a jmenované stroje a Admin Organizace v něm nepracuje: zveřejnění a verze produkční aplikace, zdroj AI a změnu z vyřízené žádosti dělá v Přehledu Organizace, Lazurio za něj otevře pull request a Lazurio Machines ho ověří. Dokud to není nasazené, pracuje Admin Organizace v repozitáři jako dosud, s přístupem, který má dnes (rozhodnutí 0093).",
    "- **The Organization's Deployment Repo** holds the Organization's boundaries of trust and changes servers and Environments and, where the Organization does it that way, the AI source and approved devices (decisions 0205, 0245). As the target only the Organization Owners and named machines see and change it, and the Organization Admin does not work in it: the publication and versions of a production application, the AI source and the change an answered request starts are made in the Organization's Dashboard, Lazurio opens the pull request for the Admin and Lazurio Machines verifies it. Until that is deployed, the Organization Admin works in the repository as before, with the access they hold today (decision 0093).",
  ),
  t(
    "- **Přehled Organizace** (Dashboard) je místo, kde Admin Organizace uvnitř hranic nastavuje přidělení Prostředí, Teamy, role a granty; drží je Lazurio Auth a Přehled Organizace sám autoritou není (rozhodnutí 0186, 0194, 0245). Co tam už jde udělat klikem, dělá Admin Organizace tam, ne pull requestem. Odebrání člena, Admina Organizace, zařízení nebo grantu platí cílově v Lazurio Auth hned a má přednost, dokud ho repozitář nasazení nedorovná.",
    "- **The Organization's Dashboard** is where the Organization Admin sets Environment assignments, Teams, roles and grants within the boundaries; Lazurio Auth holds them, and the Dashboard itself is no authority (decisions 0186, 0194, 0245). What can already be done there with a click, the Organization Admin does there, not by pull request. As the target, removing a member, an Organization Admin, a device or a grant takes effect in Lazurio Auth at once and prevails until the Deployment Repo follows.",
  ),
  blank,
  t(
    "## Servisní vstup do Prostředí kolegy",
    "## Service entry into a colleague's Environment",
  ),
  t(
    "Servisní vstup je druh vstupu, ne role: vstup do Prostředí pro někoho jiného než jeho Přiděleného uživatele. Admin Organizace ho má rolí do Pracovních a Týmových Prostředí své Organizace, do Prostředí s automatizacemi a do Služeb serveru, kdokoli jiný jen s grantem pro jedno Prostředí (rozhodnutí 0247, 0234). Cílově není nikdy stálý: Admin Organizace ho otevírá výslovně, s důvodem a na omezenou dobu, vede jen přes nahrávací vstupní bod držitele hostu a vstup agenta potvrzuje Admin Organizace pokaždé. Má tři úrovně: pozorování bez roota a jen ke čtení, opravu z katalogu Lazuria a plný přístup s potvrzením Vlastníka Organizace. Nouzový vstup má jen držitel hostu, nikdy role Admina Organizace. Do nasazení vstupuješ jen ze správního stanoviště deklarovaného jako pojmenovaná výjimka, jeho dosavadním klíčem, a vstup se mimo běžný přihlašovací log brány nezaznamenává ani neoznamuje. V cizím Prostředí jsi host. Nečti Personalspace ani osobní soubory, neměň rozpracované koncepty a přihlášení kolegy bez důvodu a nic nepublikuj jeho jménem. Hlášku o změněném klíči hostu nepřijímej: znamená jiný stroj nebo změnu, kterou musí vysvětlit Admin Organizace. Privátní klíč stanoviště nikam nekopíruj. Cílem nikdy není Osobní Prostředí ani jiná Organizace. Po zásahu řekni Adminovi Organizace, co se stalo, aby to mohl kolegovi oznámit.",
    "Service entry is a kind of entry, not a role: entry to an Environment for someone other than its Assigned User. The Organization Admin has it by the role to the Work and Team Environments of their Organization, the Environment with automations and the Server services, anyone else only with a grant for one Environment (decisions 0247, 0234). As the target it is never standing: the Organization Admin opens it explicitly, with a reason and for a bounded time, it goes only through the recording entry point that the holder of the host runs, and the Organization Admin confirms an agent's entry each time. It has three levels: observing without root and read only, a repair from Lazurio's catalog, and full access with the Organization Owner's confirmation. A break-glass entry belongs to the holder of the host alone, never to the Organization Admin role. Until that is deployed, you enter only from an administrative station declared as a named exception, with the station's present key, and the entry is neither announced nor recorded beyond the gateway's ordinary sign-in log. In someone else's Environment you are a guest. Do not read Personalspace or personal files, do not change the colleague's drafts and sign-ins without a reason, and publish nothing in their name. Never accept a changed host key: it means another machine or a change the Organization Admin must explain. Never copy the station's private key anywhere. The target is never a Personal Environment or another Organization. After the intervention tell the Organization Admin what happened, so they can let the colleague know.",
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
    "1. Ověř, že žadatel má aktivní členství v Organizaci a že žádost je jeho: autor issue. Žádost od identity Teamu jmenuje člověka jen textem, a to ho neověřuje, protože identitu Teamu sdílí celý Team. Ber ji jako jeho, až ji potvrdí svým vlastním účtem (komentářem v issue); do té doby je neověřená a rozhoduje o ní Admin Organizace.",
    "1. Check that the requester has an active membership of the Organization and that the request is theirs: the issue's author. A request from a Team's identity names the person only in its text, which does not verify them, because the whole Team shares that identity. Treat it as theirs once they confirm it with their own account (a comment in the issue); until then it is unverified and the Organization Admin decides on it.",
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
    "4. Proveď změnu cestou níže a do issue piš průběh a výsledek. Zavři ho na slovo Admina Organizace; zamítnutí vysvětli věcně.",
    "4. Make the change by the path below and write its progress and result in the issue. Close it on the Organization Admin's word; explain a refusal factually.",
  ),
  blank,
  t("## Postupy", "## Procedures"),
  t("### Zdroj AI jednoho Prostředí", "### The AI source of one Environment"),
  t(
    "Cíl je volba v Přehledu Organizace (rozhodnutí 0229, zatím nenasazené). Dokud tam není, je to reviewovaný pull request do repozitáře nasazení podle skillu Organizace: jedna změna na jednom místě, Plán z CI commitnutý beze změny, review od někoho jiného než autora na přesném headu, merge Admina Organizace a jeho samostatné schválení v GitHub Environment, teprve potom apply runnerem. Na serveru nic neměň ručně. Po přechodu na vlastní účet se kolega přihlásí v Začínáme; po návratu na pool Začínáme ukáže „Zajišťuje vaše Organizace.“ Výsledek ověř a zapiš do žádosti.",
    "The target is a choice in the Organization's Dashboard (decision 0229, not yet deployed). Until it is there, it is a reviewed pull request to the Deployment Repo by the Organization's skill: one change in one place, the CI Plan committed unchanged, a review by someone other than the author on the exact head, the Organization Admin's merge and their separate approval in the GitHub Environment, and only then the apply by the runner. Change nothing on the server by hand. After a move to an own account the colleague signs in at Getting started; after a return to the pool Getting started says “Provided by your Organization.” Check the result and write it in the request.",
  ),
  blank,
  t("### Schválení a odebrání zařízení", "### Approving and removing a device"),
  t(
    "Zařízení registruje člověk sám. Kde Organizace zařízení schvaluje (cíl rozhodnutí 0245, přechod není dokončený), Admin Organizace schvaluje konkrétní uzel podle záznamu Headscale (číslo uzlu, machine key, vlastník), nikdy podle jména (rozhodnutí 0245). Kde Přehled Organizace schvalování nenabízí, jde to reviewovanou změnou v repozitáři nasazení podle skillu Organizace. Ztracené zařízení odeber přednostně. Schválení zařízení neotevírá Osobní Prostředí: to spravuje jeho člověk, pouští jen svého Ownera a Admin Organizace do něj nevstupuje (rozhodnutí 0245). Zařízení pro Osobní Prostředí v tailnetu Conglomerate dnes pouští reviewovaná změna u toho, komu Conglomerate Host patří.",
    "The person registers a device alone. Where the Organization approves devices (the target of decision 0245; the transition is not complete), the Organization Admin approves a specific node by its Headscale record (node number, machine key, owner), never by its name (decision 0245). Where the Organization's Dashboard does not offer approval, it goes by a reviewed change in the Deployment Repo, by the Organization's skill. Remove a lost device first. Approving a device does not open a Personal Environment: its person administers it, it admits only its Owner, and no Organization Admin enters it (decision 0245). Today a reviewed change by the Conglomerate Host's owner admits a device to a Personal Environment in a Conglomerate's tailnet.",
  ),
  blank,
  t(
    "### Nový kolega a jeho Prostředí",
    "### A new colleague and their Environment",
  ),
  t(
    "Potřebuje-li kolega jen produkční aplikaci, nezakládej mu kvůli ní Prostředí ani roli modulu. Stačí Lazurio účet, aktivní členství a role v aplikaci; aktuální dostupnost přihlášení bez GitHubu a správy rolí ověř podle oddílu Produkční aplikace Organizace. Následující postup je pro kolegu, který potřebuje i vlastní Pracovní Prostředí.",
    "When a colleague needs only the production app, create neither an Environment nor a Module role for that purpose. A Lazurio account, active membership and an application role suffice; verify current sign-in without GitHub and role-management availability by the Production applications of an Organization section. The following procedure is for a colleague who also needs their own Work Environment.",
  ),
  t(
    "Kolega potřebuje členství v Organizaci (GitHub a Lazurio účet), přidělené Pracovní Prostředí, role modulů svého Teamu a podle sítě schválená zařízení. Členství je hranice důvěry: cílově ho deklaruje repozitář nasazení Organizace, změnu schvaluje ve výchozím stavu Vlastník Organizace a Lazurio Auth ho drží; dokud to není nasazené, zrcadlí členství v Lazuriu živé členství v GitHub Organizaci (rozhodnutí 0245, cílový model). Nové Prostředí na serveru s poolem začíná na poolu. Hesla a přístupové údaje se kolegovi nikdy nepíšou do chatu, issue ani zprávy.",
    "A colleague needs membership of the Organization (GitHub and a Lazurio account), an assigned Work Environment, the Module roles of their Team and, depending on the network, approved devices. Membership is a boundary of trust: as the target the Organization's Deployment Repo declares it, an Organization Owner approves the change by default and Lazurio Auth holds it; until that is deployed, live membership of the GitHub Organization mirrors membership in Lazurio (decision 0245, target model). A new Environment on a server with a pool starts on the pool. Passwords and credentials are never written to a colleague in a chat, an issue or a message.",
  ),
  blank,
  t("### Nový modul na žádost", "### A new module on request"),
  t(
    `Žádost nese popis, který kolega potvrdil. Založ modul skillem \`new-module\`: rozhovor jen o tom, co popis neříká, Teamy podle žádosti a plán k potvrzení. Do žádosti napiš, kde modul je a kdy ho kolega uvidí: v ${ucs.appsTitle} svého Prostředí obvykle do hodiny po merge slotu (\`manual/mechanisms.md\`, oddíl Moduly).`,
    `The request carries the description the colleague confirmed. Create the module with the skill \`new-module\`: an interview only about what the description leaves out, the Teams as the request says and the plan to confirm. Write in the request where the module is and when the colleague will see it: in ${uen.appsTitle} of their Environment usually within an hour of the slot's merge (\`manual/mechanisms.md\`, section Modules).`,
  ),
  blank,
  t(
    "### Role modulů a Integrace Organizace",
    "### Module roles and the Organization's Integrations",
  ),
  t(
    "Roli modulu pro Team nebo jednoho člověka měň v Přehledu Organizace (Moduly → Přístup), kde to jde, jinak na GitHubu právy Admina Organizace (rozhodnutí 0186, 0232). Kde repozitář může mít branch rules, je Čtenář modulu `pull`, Přispěvatel modulu `push` a Správce modulu `maintain`; kde je mít nemůže, Přispěvatel modulu neexistuje a Správce modulu je `push`. Roli modulu dostanou jen lidé s členstvím v Organizaci. Integraci pro celou Organizaci připojuje Admin Organizace sám svým přihlášením; agent ji nepřipojuje za něj.",
    "Change a Module role for a Team or one person in the Organization's Dashboard (Modules → Access) where possible, otherwise on GitHub with the Organization Admin's rights (decisions 0186, 0232). Where the repository can have branch rules, the Module Reader is `pull`, the Module Contributor `push` and the Module Maintainer `maintain`; where it cannot, there is no Module Contributor and the Module Maintainer is `push`. Module roles go only to people with a membership of the Organization. The Organization Admin connects an Integration for the whole Organization with their own sign-in; the agent never connects it for them.",
  ),
  blank,
  ...productionAdmin,
  ...productionApplicationRoles,
  blank,
  t(
    "## Co Admin Organizace nedělá",
    "## What the Organization Admin does not do",
  ),
  t(
    "Nepublikuje za kolegu, nečte Personalspace, nevstupuje do Osobního Prostředí, nemá nouzový vstup, nespravuje Conglomerate Host ani servery pod Prostředími (ty patří jen jejich držiteli; rozhodnutí 0245 a 0247), nepíše hesla do chatu, issue, pull requestu ani logu, neobchází review a branch rules, nemění servery ručně a nepřihlašuje vlastní účty v Prostředí kolegy. Role Admina Organizace je schopnost, ne souhlas s Publikací.",
    "Does not publish for a colleague, does not read Personalspace, does not enter a Personal Environment, has no break-glass entry, does not administer the Conglomerate Host or the servers under the Environments (those are their holder's alone; decisions 0245 and 0247), writes no password into a chat, issue, pull request or log, does not bypass review and branch rules, does not change servers by hand and does not sign in their own accounts in a colleague's Environment. The Organization Admin role is a capability, not consent to Publication.",
  ),
];
