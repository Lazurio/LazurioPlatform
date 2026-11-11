import type { Text } from "./render";

const t = (cs: string, en: string): Text => ({ cs, en });
const blank = t("", "");

// Production applications and sharing from a person's Environment are separate
// delivery paths. These instructions describe the production path; availability
// must be checked against the Organization's deployed lane, never inferred from
// the presence of this manual.
export const productionRequestRule: Text = t(
  "- Chce-li uživatel aplikaci pro kolegy i bez Prostředí, ověř živě roli: Admin Organizace postupuje podle `manual/admin.md`; bez této role nic nenasazuj ani nepublikuj, připrav jednu žádost skillem `admin-request` v kořenovém repozitáři Organizace a jednou větou řekni, kdo a kde ji schválí.",
  "- When the user wants an app for colleagues including people without an Environment, check the role live: the Organization Admin follows `manual/admin.md`; without that role deploy and publish nothing, prepare one `admin-request` in the Organization's root repository and say in one sentence who approves it and where.",
);

// Shared by new-module and module-standard: one production-readiness checklist
// for a new or an existing module, in addition to the ordinary Module Standard.
export const productionRequirements: readonly Text[] = [
  blank,
  t(
    "### Produkční aplikace Organizace",
    "### Production applications of an Organization",
  ),
  t(
    "Má-li aplikace sloužit lidem bez Prostředí, připrav ji jako produkční aplikaci Organizace. Její dostupnost ověř v repozitáři nasazení a v důkazech rolloutu; samotný manuál ani běh v Pracovním Prostředí nejsou důkaz nasazení. Dokud Organizace tuto cestu nemá, popiš blokaci a připrav žádost, neslibuj hotovou adresu.",
    "When the app is to serve people without an Environment, prepare it as an Organization's production application. Check its availability in the Deployment Repo and rollout evidence; neither this manual nor running in a Work Environment proves deployment. Until the Organization has this path, describe the blocker and prepare the request, never promise a working address.",
  ),
  t(
    "- **Vydání a běh.** Vydání označ tagem a zaznamenej přesný commit, zelenou CI a sestavení. Nasazuje se sestavená vydaná verze, nikdy vývojový server ani pohyblivá větev. Host a port ber jen z `LAZURIO_RUNTIME_LISTENER_<ID>_HOST` a `_PORT`, veřejnou adresu z `_EXTERNAL_ORIGIN`. Health musí vracet přímo 200 a server běžet jako jeden proces.",
    "- **Release and runtime.** Tag the release and record its exact commit, green CI and build. Deploy the built release, never a development server or a moving branch. Take host and port only from `LAZURIO_RUNTIME_LISTENER_<ID>_HOST` and `_PORT`, the public origin from `_EXTERNAL_ORIGIN`. Health must return 200 directly and the server run as one process.",
  ),
  t(
    "- **Role v aplikaci.** Identitu a roli čti jen přes `appAccess` z `@lazurio/module-kit` a ověřuj je na serveru u každého požadavku. `entry: unknown`, chybějící role a nepřihlášený vstup nedávají žádné právo. Co smí Uživatel aplikace a Admin aplikace, určuje modul; vlastní přihlášení ani důvěru v klientské hlavičky nestav (rozhodnutí 0231, 0234). Role aplikace nedává zdrojový kód ani vstup do Prostředí.",
    "- **Application roles.** Read identity and role only through `appAccess` of `@lazurio/module-kit` and enforce them on the server on every request. `entry: unknown`, a missing role and unauthenticated entry grant no right. The module defines what an Application User and Application Admin may do; build no sign-in or trust in client headers of your own (decisions 0231, 0234). An application role grants neither source code nor entry to an Environment.",
  ),
  t(
    "- **Jediný zapisovatel dat.** Produkční aplikace je jediným zapisovatelem svých dat; u repository-db je její hostitel jediným synchronizačním místem pro `<modul>-data`. Vývojová Prostředí používají náhledová data. Před přepnutím zaznamenej dosavadního a nového zapisovatele, souhlas a postup přechodu. Dokud dosavadní zapisovatel běží, produkční ověření je jen pro čtení (`data.writer: false` v manifestu nasazení a zápisy odmítá i aplikace); nesmí vzniknout druhý zapisovatel.",
    "- **One data writer.** The production app is the only writer of its data; for repository-db its host is the sole sync host of `<module>-data`. Development Environments use preview data. Before switching, record the current and new writer, consent and the cutover steps. While the current writer remains active, production verification is read-only (`data.writer: false` in the deployment manifest and the app rejects writes too); never create a second writer.",
  ),
  t(
    "- **Tajemství a MCP.** Deklaruj jen názvy potřebných tajných hodnot a jejich účel; hodnoty dodá trezor Organizace řízenou cestou Machines, nikdy Git, issue ani log. Volitelné `/mcp` používá Streamable HTTP a Bearer access token Lazurio Auth získaný přes Lazurio login, s audience hostitele a rolí pro konkrétní aplikaci. Brána ověřuje token i roli; nepřihlášené volání vrátí 401 s odkazem na metadata chráněného prostředku. Ověř i odmítnutí neplatného tokenu, nesprávné audience a chybějící role; veřejný nebo pevný sdílený token není přístupová cesta.",
    "- **Secrets and MCP.** Declare only the names and purposes of required secrets; the Organization's vault supplies values through Machines custody, never Git, an issue or a log. Optional `/mcp` uses Streamable HTTP and a Lazurio Auth Bearer access token obtained through Lazurio sign-in, with the host's audience and a role for the specific application. The gateway validates the token and role; unauthenticated calls return 401 with a link to protected-resource metadata. Check rejection of invalid tokens, wrong audiences and missing roles too; public access or a fixed shared token is no access path.",
  ),
  t(
    "Zveřejnění, novou nasazovanou verzi a změnu zapisovatele schvaluje Admin Organizace podle `manual/admin.md`. Bez této role připrav jednu žádost skillem `admin-request`; vydání modulu Správcem modulu samo neschvaluje jeho nasazení.",
    "The Organization Admin approves publication, each newly deployed version and a writer change by `manual/admin.md`. Without that role prepare one request with `admin-request`; a Module Maintainer's module release alone does not approve deployment.",
  ),
];

export const productionMechanisms: readonly Text[] = [
  blank,
  t(
    "## Produkční aplikace Organizace",
    "## Production applications of an Organization",
  ),
  t(
    "Produkční aplikace je vydaná a sestavená aplikace modulu provozovaná Organizací na jejím serveru pro lidi, kteří potřebují jen aplikaci. Vstupují svým Lazurio účtem a rolí Uživatel aplikace nebo Admin aplikace: nepotřebují Prostředí, tailnet, GitHub ani zdrojový kód. Musí mít aktivní členství v téže Organizaci. Adresa má tvar `<modul>.<org>.lazurio.app`, kde `org` je runtime slug Organizace (GitHub login malými písmeny); skutečný odkaz ber z nasazení a ověř ho, nikdy ho neskládej jen podle tohoto tvaru.",
    "A production application is a released, built module app that its Organization runs on its own server for people who need only the app. They enter with their Lazurio account and an Application User or Application Admin role: they need no Environment, tailnet, GitHub or source code. They must hold active membership of the same Organization. The address has the form `<module>.<org>.lazurio.app`, where `org` is the Organization's runtime slug (lower-case GitHub login); take the actual link from the deployment and verify it, never construct it from the pattern alone.",
  ),
  t(
    "Běží na Hostiteli aplikací, který není Prostředí a jehož interní jméno lidé nevidí. Služby serveru drží veřejný vstup a podpůrné služby, hostitel pouze vydané aplikace. Každá aplikace má v manifestu nasazení právě jeden server, obvykle tam, kde leží její hlavní data; přesun je další reviewovaný pull request. Nic neběží souběžně jako druhý zapisovatel.",
    "It runs on an Application host, which is not an Environment and whose internal name people do not see. Server services hold the public entry and supporting services; the host runs only released apps. Each app has exactly one server in its deployment manifest, usually where its primary data lives; a move is another reviewed pull request. Nothing runs concurrently as a second writer.",
  ),
  t(
    "Každé zveřejnění i každou nasazovanou verzi schvaluje Admin Organizace mergem reviewovaného pull requestu do repozitáře nasazení Organizace. Ten uvádí repozitář modulu, tag vydání a přesný commit; vlastní rollout provede pipeline přes Plán, Permit a ověření výsledku. Operátor Lazuria není schvalovatel žádostí Organizace. Uživatel bez role Admina Organizace popíše účel, vydání a komu dát jakou roli a předá jednu žádost do kořenového repozitáře skillem `admin-request`; sám nic nenasazuje. Agent Admina Organizace postupuje podle `manual/admin.md`.",
    "The Organization Admin approves each publication and each deployed version by merging a reviewed pull request into the Organization's Deployment Repo. It names the module repository, release tag and exact commit; the pipeline performs the rollout through a Plan, Permit and verification. A Lazurio operator does not approve an Organization's requests. A user without the Organization Admin role describes the purpose, release and who needs which role and hands over one request in the root repository with `admin-request`; they deploy nothing themselves. The Organization Admin's agent follows `manual/admin.md`.",
  ),
  t(
    "Role v aplikaci jsou jiné než role modulu (rozhodnutí 0231, 0232, 0234). Modul vynucuje oprávnění na serveru přes `appAccess`; aktivní členství a role dovolují jen konkrétní aplikaci. Produkční aplikace je jediný zapisovatel dat, její tajné hodnoty jsou v trezoru Organizace. Nabízí-li `/mcp`, používá stejné Lazurio přihlášení přes OAuth a Bearer access token s rolí aplikace; agent mimo tailnet nedostává shell ani přístup do Prostředí.",
    "Application roles differ from Module roles (decisions 0231, 0232, 0234). The module enforces permissions on the server through `appAccess`; active membership and the role admit only the specific app. The production app is the sole data writer and its secrets are in the Organization's vault. When it offers `/mcp`, it uses the same Lazurio sign-in through OAuth and a Bearer access token with the application role; an agent outside the tailnet gets no shell or Environment access.",
  ),
  t(
    "Toto je produkční cesta B. Sdílení aplikace z něčího Pracovního Prostředí je samostatná cesta A, která přijde později; vývojový náhled ani sdílení Prostředí nejsou zveřejněním produkční aplikace. Nezaměňuj rozhodnutý návrh s nasazenou službou: nejdřív zkontroluj aktuální pipeline Organizace, bránu a její důkazy. Člověk se pak sám přihlásí k ověřené adrese; nasazení, role a změny hostitele zařizuje Admin Organizace.",
    "This is production path B. Sharing an app from someone's Work Environment is the separate path A, which follows later; a development preview or sharing an Environment does not publish a production app. Never confuse the decided design with a deployed service: first check the Organization's current pipeline, gateway and evidence. The person then signs in at the verified address themselves; the Organization Admin arranges deployment, roles and host changes.",
  ),
];

export const productionAdmin: readonly Text[] = [
  blank,
  t(
    "### Produkční aplikace Organizace",
    "### Production applications of an Organization",
  ),
  t(
    "Jako agent Admina Organizace tuto žádost vyřiď sám v jeho živých právech a publikačním mandátu. Neeskaluj operátorovi Lazuria schválení aplikace, její verze nebo rolí, které patří Adminovi Organizace. Skutečné chybějící oprávnění či vadu mechanismu popiš přesnému vlastníkovi; neřeš ji ručním zásahem na hostiteli a neoznačuj žádost za vyřízenou.",
    "As the Organization Admin's agent, handle this request yourself within their live rights and Publication mandate. Do not escalate to a Lazurio operator approval of an app, its version or roles that belong to the Organization Admin. Report a genuinely missing right or a mechanism defect to its exact owner; do not solve it by editing the host by hand or call the request complete.",
  ),
  t(
    "1. **Ověř roli a žádost.** Použij živé ověření role výše, načti pravidla Organizace a repozitáře nasazení a ověř členství žadatele i příjemců rolí v Lazurio Auth. Zkontroluj, že kořenový repozitář přijímá Issues (`gh api repos/<org>/<kořenový-repozitář> --jq .has_issues`). Má-li je vypnuté, doporuč Adminovi Organizace jejich zapnutí v Settings → General → Features → Issues; s jeho mandátem a živým právem správy je zapni a zpětně ověř. Žádost nepřesouvej do infra repozitáře ani ji nepřiřazuj operátorovi Lazuria.",
    "1. **Check the role and request.** Use the live role check above, load the Organization's and Deployment Repo's rules and verify the requester and role recipients' membership in Lazurio Auth. Check that the root repository accepts Issues (`gh api repos/<org>/<root-repository> --jq .has_issues`). If disabled, recommend that the Organization Admin enable them in Settings → General → Features → Issues; with their mandate and live administration right enable them and read back the setting. Never move the request to an infra repository or assign it to a Lazurio operator.",
  ),
  t(
    "2. **Zkontroluj připravenost.** Žádost musí uvádět modul a repozitář, tag vydání a přesný commit, zelenou CI na tomto commitu, úspěšné sestavení a health, serverové `appAccess` a chování obou rolí, příjemce rolí podle jejich neměnného Lazurio subject (ne odhad z GitHub loginu), jediného zapisovatele a plán případného přepnutí, názvy potřebných tajemství a jejich dostupnost z trezoru. U MCP ověř token, audience a roli pro danou aplikaci a odmítnutí bez nich. Hodnoty tajemství ani tokeny do žádosti nekopíruj.",
    "2. **Check readiness.** The request must name the module and repository, release tag and exact commit, green CI on that commit, a successful build and health, server-side `appAccess` and both roles' behavior, role recipients by their immutable Lazurio subject (never guessed from a GitHub login), the sole writer and any cutover plan, the required secret names and their availability from the vault. For MCP check the token, audience and role for that app and rejection without them. Copy no secret values or tokens into the request.",
  ),
  t(
    "3. **Připrav a schval nasazení.** Ve vlastním worktree repozitáře nasazení připrav pull request do deklarace `applications` příslušného Hostitele aplikací: `module`, `slug`, `tag`, přesný `commit` a `data.repository`, `data.branch`, `data.writer` podle kontraktu pipeline. Jeden modul má právě jednoho hostitele. Přilož odkaz na původní žádost; pro každou novou verzi vznikne nový reviewovaný návrh. Vyžádej nezávislé review na přesném headu, zelenou CI a Plán a dodrž branch rules. Merge Admina Organizace je schválením vydané verze; apply čeká i na Permit a další požadované schválení pipeline. Spouští ho runner, nikdy ruční instalace.",
    "3. **Prepare and approve deployment.** In your own Deployment Repo worktree prepare a pull request to the chosen Application host's `applications` declaration: `module`, `slug`, `tag`, exact `commit` and `data.repository`, `data.branch`, `data.writer` by the pipeline contract. One module has exactly one host. Link the original request; every new version gets a new reviewed proposal. Obtain independent exact-head review, green CI and the Plan and follow branch rules. The Organization Admin's merge approves the released version; apply also waits for the Permit and any further pipeline approval. A runner performs it, never a manual installation.",
  ),
  t(
    "4. **Přiděl nebo odeber roli v aplikaci.** Řiď se oddílem Role produkční aplikace níže. Admin aplikace není Admin Organizace a role aplikace nedává roli modulu ani celé Prostředí. Přidání, odebrání a přepnutí zapisovatele jsou přesné operace v mandátu Admina Organizace, nikoli vedlejší účinek nasazení.",
    "4. **Assign or remove an application role.** Follow the section Production application roles below. An Application Admin is not an Organization Admin and an application role grants neither a Module role nor the whole Environment. Adding, removing and switching the writer are exact operations within the Organization Admin's mandate, never a deployment side effect.",
  ),
  t(
    "5. **Ověř jako Uživatel aplikace.** Z nezávislé relace přes veřejnou bránu ověř Lazurio login, povolené čtení a změny podle role, odmítnutí cizí aplikace a vstupu do Prostředí, odmítnutí bez role a po odebrání role. Pokud je nasazení jen pro čtení, zkus i odmítnutí zápisu. U MCP ověř přihlášené volání i 401 bez tokenu a odmítnutí nesprávné audience a role. Zkontroluj health a readback vydání, commitu i jediného zapisovatele.",
    "5. **Verify as an Application User.** From an independent session through the public gateway check Lazurio sign-in, allowed reads and changes by role, denial of another app and Environment entry, denial without a role and after its removal. For a read-only deployment, check write rejection too. For MCP check an authenticated call as well as 401 without a token and rejection of a wrong audience or role. Check health and the readback of the release, commit and sole writer.",
  ),
  t(
    "6. **Zapiš výsledek do původní žádosti.** Uveď odkaz na pull request nasazení, schválený head a vydání, skutečnou adresu z readbacku, udělené nebo odebrané role a komu, zapisovatele, stav health a provedená ověření. Nezaměňuj připraveno, schváleno, nasazeno a ověřeno. Co blokuje dokončení, pojmenuj a žádost nech otevřenou; uzavři ji jen na pokyn Admina Organizace.",
    "6. **Record the result in the original request.** Give the Deployment Repo pull request, approved head and release, actual address from readback, roles assigned or removed and for whom, writer, health and checks performed. Distinguish prepared, approved, deployed and verified. Name anything that blocks completion and leave the request open; close it only on the Organization Admin's instruction.",
  ),
];

export const productionGlossary: readonly Text[] = [
  t(
    "| Produkční aplikace | Vydaná a sestavená aplikace modulu, kterou Organizace provozuje na svém serveru pro členy s rolí v aplikaci a Lazurio účtem, i bez Prostředí. Zveřejnění a každou verzi schvaluje Admin Organizace. |",
    "| Production application | A released, built module app its Organization runs on its own server for members with an application role and Lazurio account, including people without an Environment. The Organization Admin approves publication and each version. |",
  ),
  t(
    "| Hostitel aplikací | Technický hostitel pouze vydaných produkčních aplikací na serveru Organizace. Není Prostředí, nemá přiděleného člověka ani agentní nástroje; jeho interní jméno uživatel nevidí a v adrese aplikace není. |",
    "| Application host | The technical host of released production applications only, on the Organization's server. Not an Environment; it has no assigned person or agent tools, and its internal name is invisible to the user and absent from app addresses. |",
  ),
  t(
    "| Služby serveru | Podpůrné služby serveru Organizace: veřejný vstup, certifikáty a AI pool; cílově i databáze Dolt. Nejsou Hostitel aplikací ani další druh Prostředí. Spravuje je Admin Organizace řízenou cestou nasazení. |",
    "| Server services | Supporting services of an Organization's server: public entry, certificates and AI pool; Dolt as the target too. Neither an Application host nor another kind of Environment. The Organization Admin manages them through controlled deployment. |",
  ),
];
