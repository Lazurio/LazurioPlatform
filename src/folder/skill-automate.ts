import type { Text } from "./render";

// `automate` (decision F14, proposed addendum of 2026-11-20): what an agent
// does when the person wants something to happen on a schedule or when
// another app calls. The work belongs to a bot of Lazurio MausBot with a
// routine or a webhook, which people see and stop in Automate (root decision
// 0169; "What Lazurio already has" in manual/lazurio.md), never to the
// scheduler of the agent's own harness or to cron. A recurring task bound to
// a T3 Code chat is the one exception: the person wants the result in that
// chat (the ownership split of #182). An Organization's standing work belongs
// to its Henry. A trial run starts the real task with all its effects, so it
// waits for the person's consent to run now; the safe preview is a separate
// one-off run told to prepare only. A webhook's secret exists once, at
// creation or rotation: it goes to a file only this account reads, then into
// the Environment's vault, and reaches the calling app only through its
// Integration or a field filled in the Environment browser, never as a file,
// a message or a download (people are not yet members of the Environment's
// vault). The receiver listens on loopback today (#1135), so only callers in
// the Environment reach a webhook until Lazurio exposes it.

const t = (cs: string, en: string): Text => ({ cs, en });
const blank = t("", "");

export const automateDescription = t(
  "Použij, kdykoli uživatel chce, aby se něco dělo pravidelně, podle plánu nebo když se stane něco v jiné aplikaci (každé ráno shrnutí, každý pátek report, reakce na novou objednávku nebo událost). Automatizaci založíš jako bota s rutinou nebo webhookem v Lazurio MausBotu (v Lazuriu Automate), nikdy plánovačem svého harnessu (automatizace Codexu, CronCreate, /loop) ani cronem. Zkušební běh jen se souhlasem se spuštěním teď, tajný údaj webhooku nikdy do chatu.",
  "Use whenever the user wants something to happen regularly, on a schedule or when something happens in another app (a summary every morning, a report every Friday, a reaction to a new order or event). You set the automation up as a bot with a routine or a webhook in Lazurio MausBot (Automate in Lazurio), never with your harness's scheduler (Codex automations, CronCreate, /loop) or cron. A trial run only with consent to run now; a webhook's secret never in the chat.",
);

export const automate: readonly Text[] = [
  t(
    "Automatizace v Lazuriu je bot, který práci dělá sám: rutina ho spouští podle plánu, webhook na zavolání jiné aplikace. Uživatel všechny automatizace najde na jednom místě, v Automate, kde je vidí, zastaví a zapne, a běží v Prostředí, ne v klientovi, kterým se na něj zrovna dívá. Plánovač harnessu vidí jen jeden klient a cron nenajde nikdo, proto je pro automatizaci nepoužívej (decision 0169, oddíl Co už Lazurio má v `manual/lazurio.md`).",
    "An automation in Lazurio is a bot that does the work by itself: a routine starts it on a schedule, a webhook when another app calls. The user finds every automation in one place, Automate, where they see, pause and resume it, and it runs in the Environment, not in the client they happen to look through. A harness's scheduler is seen by one client only and nobody finds a cron job, so never use them for an automation (decision 0169, What Lazurio already has in `manual/lazurio.md`).",
  ),
  blank,
  t("## Kam automatizace patří", "## Where an automation belongs"),
  t(
    "- **Bot v Automate** je výchozí cesta na Remote Environmentu.",
    "- **A bot in Automate** is the default on a Remote Environment.",
  ),
  t(
    "- **Opakovaný úkol v T3 chatu** jen tehdy, když uživatel výslovně chce, aby se výsledek pravidelně objevil v tomto chatu a mluvilo se o něm tady (třeba týdenní report k debatě). Použij `schedule_task` navázaný na vlákno; časy počítá v pásmu služby, tak pásmo ověř a řekni (#182).",
    "- **A recurring task in a T3 chat** only when the user explicitly wants the result to appear in this chat regularly and be discussed here (a weekly report to talk over, say). Use `schedule_task` bound to the thread; it counts times in the service's zone, so check the zone and say it (#182).",
  ),
  t(
    "- **Stálá práce pro celou Organizaci** (ne pro jednoho člověka) patří do Prostředí Henry Organizace (decision 0169). V Pracovním Prostředí ji nezakládej: řekni to a postupuj podle `AGENTS.md` Organizace. V samotném Prostředí Henry zakládáš rutiny normálně.",
    "- **Standing work for the whole Organization** (not for one person) belongs to the Organization's Henry Environment (decision 0169). Do not set it up in a personal work Environment: say so and follow the Organization's `AGENTS.md`. In the Henry Environment itself you set up routines as usual.",
  ),
  t(
    "- **Na vlastním počítači uživatele** Lazurio MausBot neběží. Řekni: „Automatizace v Lazuriu běží v Prostředí na serveru, kde je uvidíte v Automate. Tady na vašem počítači ji založit nejde.“",
    "- **On the user's own computer** Lazurio MausBot does not run. Say: “Automations in Lazurio run in an Environment on a server, where you see them in Automate. They cannot be set up here on your computer.”",
  ),
  t(
    "- **Nikdy:** automatizace Codexu, CronCreate, /loop, cron, systemd timer ani vlastní smyčka. Má-li uživatel automatizaci v Codexu, nabídni ji převést na bota.",
    "- **Never:** Codex automations, CronCreate, /loop, cron, a systemd timer or a loop of your own. When the user has an automation in Codex, offer to move it to a bot.",
  ),
  blank,
  t("## Postup", "## Steps"),
  t(
    "CLI Lazurio MausBotu je `node ~/.local/share/lazurio/mausbot/current/cli.js … --port 4102` (dál `omb`); každý příkaz umí `--json` a `create`, `update`, `delete` i `run` umí `--dry-run`, které jen vypíše požadavek. Celý popis je `docs/headless-cli.md` ve veřejném `Lazurio/OpenMausBot`. Začni `omb doctor`.",
    "The CLI of Lazurio MausBot is `node ~/.local/share/lazurio/mausbot/current/cli.js … --port 4102` (`omb` below); every command takes `--json`, and `create`, `update`, `delete` and `run` take `--dry-run`, which only prints the request. The full description is `docs/headless-cli.md` in the public `Lazurio/OpenMausBot`. Start with `omb doctor`.",
  ),
  t(
    "1. **Účel.** Zjisti, co se má stát, kdy nebo na jaký podnět, v jakém časovém pásmu (z kontextu, jinak se zeptej), kam má jít výsledek a co bot smí udělat sám. Ptej se nástrojem na otázky, na všechno najednou a na techniku ne. Rutina běží bez dozoru: co odesílá, mění pro ostatní nebo platí, je Publikace a bot ji smí udělat jen tehdy, když ji uživatel pro tuto automatizaci výslovně dovolil předem; jinak připraví koncept a dá vědět.",
    "1. **Purpose.** Find out what should happen, when or on which trigger, in which time zone (from context, else ask), where the result goes and what the bot may do by itself. Ask with the question tool, everything at once, and never about technique. A routine runs unattended: whatever sends, changes things for others or pays is Publication, and the bot may do it only when the user explicitly allowed it in advance for this automation; otherwise it prepares a draft and lets them know.",
  ),
  t(
    "2. **Bot.** `omb bot list` ukáže boty Prostředí. Vyber toho, jehož účel sedí, nebo založ nového (`omb bot create NAME` s instrukcemi o jeho účelu a hranicích z kroku 1).",
    "2. **Bot.** `omb bot list` shows the Environment's bots. Pick the one whose purpose fits, or create one (`omb bot create NAME` with instructions about its purpose and the limits from step 1).",
  ),
  t(
    '3. **Rutina.** Běh nevidí žádnou konverzaci, proto zadání (`--prompt-file`) drží celý úkol i jeho hranice. Rozvrh je `--cron "…" --tz <pásmo>`, `--daily HH:MM [--weekdays …]`, `--every 30m` nebo jednorázové `--at`. Nejdřív `omb routine create … --dry-run`, pak bez něj. Když zadání dělá nevratnou akci, založ rutinu s `--paused` a zapni ji (`omb routine update NAME --resume`) až po kontrole náhledu. Pak `omb routine show NAME`: další běh musí sedět s dohodou a žádný běh tam ještě nesmí být.',
    '3. **Routine.** A run sees no conversation, so its prompt (`--prompt-file`) holds the whole task and its limits. The schedule is `--cron "…" --tz <zone>`, `--daily HH:MM [--weekdays …]`, `--every 30m` or a one-off `--at`. First `omb routine create … --dry-run`, then without it. When the task does something irreversible, create the routine with `--paused` and resume it (`omb routine update NAME --resume`) only after the preview is checked. Then `omb routine show NAME`: the next run must match what you agreed and no run may be there yet.',
  ),
  t(
    "4. **Zkušební běh.** `omb routine run` spouští skutečné zadání se všemi jeho účinky, i páteční odeslání. Sám ho nespouštěj. Řekni, co přesně běh teď udělá, a zeptej se nástrojem na otázky: „Mám automatizaci spustit hned teď na zkoušku? Udělá to: <co>.“ Jen na souhlas spusť `omb routine run NAME`. Jinak, nebo když zadání něco odesílá, zapisuje či platí, nabídni bezpečný náhled: jednorázovou práci bota `omb run BOT --message-file <soubor>` se stejným zadáním a pokynem „jen připrav a popiš výsledek, nic neodesílej, nezapisuj ani neplať“, v samostatné konverzaci mimo rutinu. Náhled stojí na pokynu botovi, ne na zámku; řekni to uživateli.",
    "4. **Trial run.** `omb routine run` starts the real task with all its effects, Friday's sending included. Never start it on your own. Say exactly what the run will do now and ask with the question tool: “Shall I run the automation right now as a trial? It will: <what>.” Only on consent run `omb routine run NAME`. Otherwise, or when the task sends, writes or pays, offer a safe preview: a one-off job of the bot, `omb run BOT --message-file <file>`, with the same task and the instruction “only prepare and describe the result, send, write and pay nothing”, in a separate conversation outside the routine. The preview rests on an instruction to the bot, not on a lock; tell the user.",
  ),
  t(
    "5. **Webhook.** Než ho založíš, rozhodni, kudy se tajný údaj dostane do volající aplikace, protože existuje jen při založení a rotaci a server drží jen jeho hash:",
    "5. **Webhook.** Before you create it, decide how the secret reaches the calling app, because it exists only at creation and rotation and the server keeps only its hash:",
  ),
  t(
    "   - **Dosah.** `omb webhook list --json` ukáže `ingress.baseUrl`. Je-li to adresa na loopbacku (`127.0.0.1`), webhook zavolá jen proces v tomto Prostředí (modul, skript), aplikace zvenku ne (#1135). Pro aplikaci zvenku pak nabídni rutinu, která ji podle plánu zkontroluje přes její Integraci.",
    "   - **Reach.** `omb webhook list --json` shows `ingress.baseUrl`. When it is a loopback address (`127.0.0.1`), only a process in this Environment (a module, a script) can call the webhook, an app outside cannot (#1135). For an outside app, offer a routine that checks it on a schedule through its Integration.",
  ),
  t(
    "   - **(a) Integrace:** je-li volající aplikace připojená Integrace, webhook v ní nastavíš sám, ale až na souhlas uživatele se zápisem do ní, a hodnotu předáš rourou, bez vypsání.",
    "   - **(a) Integration:** when the calling app is a connected Integration, you set the webhook up in it yourself, but only with the user's consent to write to it, and pass the value through a pipe, never printed.",
  ),
  t(
    '   - **(b) Prohlížeč Environmentu:** uživatel se k volající aplikaci přihlásí v pohledu na okno tvého vlákna (na přihlášení se zastav) a ty pole vyplníš ze standardního vstupu, takže hodnota není v argumentech ani ve výstupu: `bw get password <id> | jq -Rs \'[["fill","<selektor>",.]]\' | agent-browser --cdp 9222 --session <sezení> batch`.',
    '   - **(b) Environment browser:** the user signs in to the calling app in the view of your thread\'s window (stop at the sign-in) and you fill the field from standard input, so the value is in neither the arguments nor the output: `bw get password <id> | jq -Rs \'[["fill","<selector>",.]]\' | agent-browser --cdp 9222 --session <session> batch`.',
  ),
  t(
    "   - **Jinak webhook nezakládej.** Hodnota nesmí z Prostředí odejít jako soubor, zpráva ani stažení: kopie by zůstala nechráněná v počítači uživatele a do Trezoru Prostředí uživatelé zatím přidaní nejsou. Řekni, že bezpečně ji převezme jen ze sdíleného trezoru pro účel, který založí Admin Organizace a přizve do něj účet tohoto Environmentu (oddíl Tajné údaje v `manual/working-here.md`), a nabídni o něj požádat.",
    "   - **Otherwise create no webhook.** The value must not leave the Environment as a file, a message or a download: a copy would stay unprotected on the user's computer, and people are not yet members of the Environment's vault. Say that they can take it over safely only from a shared vault for the purpose, which the Organization Admin creates and invites this Environment's account to (Secrets in `manual/working-here.md`), and offer to ask for it.",
  ),
  t(
    '   Pak `omb webhook create NAME --bot BOT --prompt-file <soubor> [--event-types …] --secret-file <nový soubor>` v adresáři jen pro tento účet mimo repozitáře a `/tmp`, nikdy `--show-secret`. Hodnotu hned ulož do Trezoru Prostředí jako heslo položky přihlášení (`eval "$(lazurio vault env)"`, z odpovědi `bw create item` ber jen `id`) a soubor smaž, ještě než ji předáš. Když předání nedoběhne (uživatel se nepřihlásí, vyplnění selže, souhlas nepřijde), webhook smaž (`omb webhook delete NAME`), ať nezůstane zapnutý bez předané hodnoty; ztracenou hodnotu nahradí `omb webhook rotate` stejnou cestou.',
    '   Then `omb webhook create NAME --bot BOT --prompt-file <file> [--event-types …] --secret-file <new file>` in a directory only this account reads, outside repositories and `/tmp`, never `--show-secret`. Store the value in the Environment\'s vault right away as the password of a login item (`eval "$(lazurio vault env)"`, take only the `id` from the answer of `bw create item`) and delete the file before you hand the value over. When the handover does not finish (the user does not sign in, the filling fails, no consent comes), delete the webhook (`omb webhook delete NAME`), so it does not stay on without a handed-over value; a lost value is replaced by `omb webhook rotate` the same way.',
  ),
  t(
    "6. **Ověření webhooku.** Volání bez tajného údaje musí vrátit 401. Autorizaci ověříš bez spuštění práce: volání se správnou hodnotou a událostí mimo `--event-types` vrátí 202 s `\"ignored\": true` a `deliveryCount` se nezmění. Hlavičku čti ze souboru, ne z argumentu: `curl -H @<(printf 'Authorization: Bearer %s' \"$(bw get password <id>)\") -H 'X-GitHub-Event: lazurio_check' -X POST <adresa>`. Bez `--event-types` spustí každé autorizované volání práci, a proto patří pod krok 4.",
    "6. **Checking a webhook.** A call without the secret must return 401. Check the authorization without starting the work: a call with the right value and an event outside `--event-types` returns 202 with `\"ignored\": true` and `deliveryCount` does not change. Read the header from a file, not an argument: `curl -H @<(printf 'Authorization: Bearer %s' \"$(bw get password <id>)\") -H 'X-GitHub-Event: lazurio_check' -X POST <address>`. Without `--event-types` every authorized call starts the work, so it falls under step 4.",
  ),
  t(
    "7. **Předání.** Řekni uživateli vlastními slovy, co automatizace dělá, kdy poběží příště, co smí sama a že ji najde v Lazuriu v Automate, kde ji zastaví. U webhooku dej jen adresu a jméno položky Trezoru Prostředí, nikdy hodnotu.",
    "7. **Handover.** Tell the user in plain words what the automation does, when it runs next, what it may do by itself, and that they find it in Automate in Lazurio, where they can pause it. For a webhook give only the address and the name of the vault item, never the value.",
  ),
  blank,
  t("## Ověření", "## Verification"),
  t(
    "- `omb routine list` nebo `omb webhook list` automatizaci ukazuje se správným rozvrhem, botem a stavem; běh navíc proběhl jen na souhlas uživatele.",
    "- `omb routine list` or `omb webhook list` shows the automation with the right schedule, bot and state; an extra run happened only on the user's consent.",
  ),
  t(
    "- Žádný jiný plánovač nevznikl: `crontab -l` je beze změny a plánovač harnessu nic nového nemá.",
    "- No other scheduler appeared: `crontab -l` is unchanged and the harness's scheduler holds nothing new.",
  ),
  t(
    "- Tajný údaj webhooku je jen v Trezoru Prostředí (a ve volající aplikaci), soubor z `--secret-file` neexistuje a hodnotu nenajdeš v chatu, výstupech, logu, historii shellu, `~/Documents` ani v pull requestu.",
    "- The webhook's secret is only in the Environment's vault (and the calling app), the `--secret-file` file is gone, and the value is in neither the chat, outputs, log, shell history, `~/Documents` nor any pull request.",
  ),
];
