const en = {
  title: "Lazurio — Profile",
  notice: "Development fixture only. No software installation or migration.",
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
  title: "Lazurio — Profil",
  notice:
    "Pouze vývojová testovací složka. Nejde o instalaci softwaru ani migraci.",
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
