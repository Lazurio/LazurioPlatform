const en = {
  appDiscover: "Read declared applications",
  appDiscovered: "Observed application",
  appDiscoveryNotice:
    "Local declarations only, not access or readiness. Conflicts and unavailable modules are shown below.",
  appDiscoveryUnavailable:
    "Application discovery is unavailable. Configure a permitted canonical Organization in the CLI; no legacy fallback is used.",
  appPrepare: "Prepare dependencies",
  appCleanPrepare: "Reinstall dependencies (remove node_modules)",
  appPrepared:
    "Module preparation completed. Start the app and verify its function separately.",
  appPreparationUnavailable:
    "Module preparation is not configured in this development session.",
  appPreparationPreflightFailed:
    "Preparation checks failed before any application was stopped. Check the module declarations, lockfile and required toolchain.",
  appPreparationCleanupRequired:
    "Previous process cleanup could not be confirmed. Further preparation and starts are blocked; resolve cleanup through the existing lifecycle owner before retrying.",
  appOtherAppManaged:
    "Another application is managed by this session. Explicitly stop it before preparing dependencies; preparation will not stop it for you.",
  appDeclarationChanged:
    "The application declaration or its location changed. Refresh the selection and verify the intended module before retrying.",
  appsTitle: "Application",
  appsNotice:
    "Explicit development selection. The server must authorize the declared application.",
  appSelection: "Declared application",
  appCompany: "Organization",
  appModule: "Module",
  appPackage: "Package",
  appStart: "Start",
  appStatus: "Status",
  appOpen: "Get application link",
  appStop: "Stop",
  appVisit: "Open application on this machine",
  appBusy: "Operation in progress…",
  appStarted:
    "Process started. Check readiness before opening the application.",
  appHealthy:
    "Declared health checks passed. Verify the application's function after opening it.",
  appStopped: "Owned application processes stopped.",
  appNotManaged: "No application process is managed for this selection.",
  appNotReady:
    "The application is not ready, or its process ownership could not be confirmed.",
  appDenied: "Access denied for this application operation.",
  appUnavailable:
    "Application bindings are not configured in this development session.",
  appFailure:
    "Operation did not complete. Inspect the result; no automatic repair was performed.",
  appResultUnknown:
    "The operation result could not be confirmed. It may still be running; a lost response does not cancel it. Check the existing lifecycle owner before retrying a change.",
  appLinkReady:
    "Local application link available. Opening it does not prove functional acceptance.",
  appRemoteLink:
    "This address belongs to the execution machine. Remote browser access needs a qualified route.",
  title: "Lazurio — Profile",
  notice: "Development fixture only. No Lazurio installation or migration.",
  legend: "Machine profile",
  access: "Access",
  local: "Local",
  remote: "Remote",
  purpose: "Purpose",
  human: "Human",
  buddy: "Buddy",
  ai_colleague: "AI colleague",
  locale: "Language",
  detail: "Detail",
  concise: "Concise",
  technical: "Technical",
  coordination: "Coordination",
  direct: "Direct",
  coordinator: "Coordinator",
  preview: "Preview",
  reload: "Reload profile",
  apply: "Apply previewed change",
  revision: "Revision",
  previewComplete: "Preview complete. No changes applied.",
  refused: "Operation refused; reload state or use CLI recovery.",
  reloadFailed: "Cannot reload profile; CLI recovery may be required.",
  loadFailed:
    "Cannot read profile. Open the session link from CLI; pending state may require CLI recovery.",
} as const;
export type MessageKey = keyof typeof en;
const cs: Record<MessageKey, string> = {
  appDiscover: "Načíst deklarované aplikace",
  appDiscovered: "Nalezená aplikace",
  appDiscoveryNotice:
    "Pouze lokální deklarace, ne oprávnění ani připravenost. Konflikty a nedostupné moduly jsou uvedeny níže.",
  appDiscoveryUnavailable:
    "Aplikace nelze načíst. V CLI vyberte povolenou kanonickou organizaci; starý formát se jako náhrada nepoužívá.",
  appPrepare: "Připravit závislosti",
  appCleanPrepare: "Přeinstalovat závislosti (odstranit node_modules)",
  appPrepared:
    "Příprava modulu byla dokončena. Aplikaci zvlášť spusťte a ověřte její funkci.",
  appPreparationUnavailable:
    "Příprava modulu není v této vývojové relaci nakonfigurovaná.",
  appPreparationPreflightFailed:
    "Vstupní kontroly přípravy selhaly před zastavením aplikace. Ověřte deklarace modulu, lockfile a požadované nástroje.",
  appPreparationCleanupRequired:
    "Nelze potvrdit úklid předchozích procesů. Další příprava a spouštění jsou zablokované; před opakováním vyřešte úklid přes stávajícího správce procesů.",
  appOtherAppManaged:
    "Tato relace spravuje jinou aplikaci. Před přípravou závislostí ji výslovně zastavte; příprava ji sama nezastaví.",
  appDeclarationChanged:
    "Změnila se deklarace aplikace nebo její umístění. Obnovte výběr a před opakováním ověřte zamýšlený modul.",
  appsTitle: "Aplikace",
  appsNotice:
    "Výslovný vývojový výběr. Server musí povolit práci s deklarovanou aplikací.",
  appSelection: "Deklarovaná aplikace",
  appCompany: "Organizace",
  appModule: "Modul",
  appPackage: "Package",
  appStart: "Spustit",
  appStatus: "Stav",
  appOpen: "Získat odkaz aplikace",
  appStop: "Zastavit",
  appVisit: "Otevřít aplikaci na této mašině",
  appBusy: "Operace probíhá…",
  appStarted:
    "Proces je spuštěný. Před otevřením ověřte připravenost aplikace.",
  appHealthy:
    "Deklarované zdravotní kontroly prošly. Po otevření ověřte funkci aplikace.",
  appStopped: "Vlastněné procesy aplikace byly zastaveny.",
  appNotManaged: "Pro tento výběr není spravován proces aplikace.",
  appNotReady:
    "Aplikace není připravená nebo nebylo možné ověřit vlastnictví procesu.",
  appDenied: "Pro tuto operaci s aplikací nemáte přístup.",
  appUnavailable:
    "V této vývojové relaci nejsou nakonfigurované vazby aplikací.",
  appFailure:
    "Operace nebyla dokončena. Zkontrolujte výsledek; automatická oprava neproběhla.",
  appResultUnknown:
    "Výsledek operace nelze potvrdit. Operace může stále běžet; ztráta odpovědi ji neruší. Před opakováním změny ověřte stav u stávajícího správce procesů.",
  appLinkReady:
    "Lokální odkaz aplikace je připravený. Otevření samo neprokazuje její funkčnost.",
  appRemoteLink:
    "Tato adresa patří execution mašině. Vzdálené otevření vyžaduje ověřenou přístupovou cestu.",
  title: "Lazurio — Profil",
  notice:
    "Pouze vývojová testovací složka. Nejde o instalaci Lazuria ani migraci.",
  legend: "Profil mašiny",
  access: "Přístup",
  local: "Lokální",
  remote: "Vzdálený",
  purpose: "Účel",
  human: "Člověk",
  buddy: "Buddy",
  ai_colleague: "AI kolega",
  locale: "Jazyk",
  detail: "Podrobnost",
  concise: "Stručně",
  technical: "Technicky",
  coordination: "Koordinace",
  direct: "Přímá práce",
  coordinator: "Koordinátor",
  preview: "Náhled",
  reload: "Načíst aktuální profil",
  apply: "Použít zobrazenou změnu",
  revision: "Revize",
  previewComplete: "Náhled je připravený. Žádné změny nebyly použity.",
  refused:
    "Operace byla odmítnuta. Načtěte aktuální stav nebo použijte obnovu přes CLI.",
  reloadFailed: "Profil nelze znovu načíst. Může být nutná obnova přes CLI.",
  loadFailed:
    "Profil nelze načíst. Otevřete odkaz relace z CLI; rozpracovaný stav může vyžadovat obnovu přes CLI.",
};
export function messages(
  locale: unknown,
): Readonly<Record<MessageKey, string>> {
  return locale === "cs" ? cs : en;
}
