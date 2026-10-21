import type {
  EnvironmentKind,
  PageApp,
  PageContext,
} from "../../contract/runtime";
import type { Lang } from "./host";

// The frame's words, in Czech with formal address and in English, the same
// meaning in both (docs/agent-voice.md). Buddy's own messages are his; these
// are only the frame's.

const cs = {
  online: "online",
  writing: "píše…",
  waiting: "čeká na vás",
  unavailable: "nedostupný",
  fullscreen: "Celá obrazovka",
  reduce: "Zmenšit",
  close: "Zavřít",
  placeholder: "Napište Buddymu…",
  message: "Zpráva pro Buddyho",
  send: "Odeslat",
  stop: "Zastavit",
  attachImage: "Přiložit obrázek",
  attachFile: "Přiložit soubor",
  removeAttachment: "Odebrat přílohu",
  contextTitle: "Kontext rozhovoru",
  contextOff: "Bez kontextu",
  contextAdd: "Přidat kontext:",
  today: "Dnes",
  yesterday: "Včera",
  via: "přes",
  older: "Načíst starší zprávy",
  other: "Jiné…",
  skip: "Přeskočit",
  confirm: "Potvrdit",
  answerPlaceholder: "Vaše odpověď…",
  signInTitle: "Přihlaste se k Buddymu",
  signIn: "Přihlásit",
  signingIn: "Dokončete přihlášení v otevřeném okně.",
  offline: "Buddy je teď nedostupný.",
  retry: "Zkusit znovu",
  sendFailed: "Zprávu se nepodařilo odeslat.",
  emptyFile: "Soubor je prázdný.",
  tooLarge: "Soubor je větší než 5 MB.",
  tooMuch: "Přílohy mohou mít dohromady nejvýš 10 MB.",
  tooMany: "Najednou můžete přiložit nejvýš 4 soubory.",
  turnFailed: "Odpověď se nepodařilo dokončit.",
  turnUnavailable: "Buddy teď nemůže odpovědět.",
  signedIn: "Přihlášeno. Toto okno můžete zavřít.",
  personal: "Osobní Prostředí",
  work: "Pracovní Prostředí",
  team: "Týmové Prostředí",
  apps: "Apps",
  settings: "Nastavení",
  chat: "Chat",
  automate: "Automate",
};

const en: typeof cs = {
  online: "online",
  writing: "writing…",
  waiting: "waiting for you",
  unavailable: "unavailable",
  fullscreen: "Full screen",
  reduce: "Reduce",
  close: "Close",
  placeholder: "Write to Buddy…",
  message: "Message to Buddy",
  send: "Send",
  stop: "Stop",
  attachImage: "Attach an image",
  attachFile: "Attach a file",
  removeAttachment: "Remove the attachment",
  contextTitle: "Conversation context",
  contextOff: "Without context",
  contextAdd: "Add context:",
  today: "Today",
  yesterday: "Yesterday",
  via: "via",
  older: "Load older messages",
  other: "Other…",
  skip: "Skip",
  confirm: "Confirm",
  answerPlaceholder: "Your answer…",
  signInTitle: "Sign in to Buddy",
  signIn: "Sign in",
  signingIn: "Finish signing in in the window that opened.",
  offline: "Buddy is unavailable right now.",
  retry: "Try again",
  sendFailed: "The message could not be sent.",
  emptyFile: "The file is empty.",
  tooLarge: "The file is larger than 5 MB.",
  tooMuch: "Attachments can be at most 10 MB together.",
  tooMany: "You can attach at most 4 files at once.",
  turnFailed: "The answer could not be finished.",
  turnUnavailable: "Buddy cannot answer right now.",
  signedIn: "Signed in. You can close this window.",
  personal: "Personal Environment",
  work: "Work Environment",
  team: "Team Environment",
  apps: "Apps",
  settings: "Settings",
  chat: "Chat",
  automate: "Automate",
};

export type Copy = typeof cs;
export type CopyKey = keyof Copy;

export const copyOf = (lang: Lang): Copy => (lang === "cs" ? cs : en);

/** The language before the host says one: the browser's. */
export const browserLang = (languages: readonly string[]): Lang =>
  languages.some((language) => language.toLowerCase().startsWith("cs"))
    ? "cs"
    : "en";

const kindKey: Readonly<Record<EnvironmentKind, CopyKey>> = {
  personal: "personal",
  work: "work",
  team: "team",
};
const appKey: Readonly<Record<PageApp, CopyKey>> = {
  apps: "apps",
  settings: "settings",
  chat: "chat",
  automate: "automate",
};

/** What the context chip says: the kind of Environment with its name, the
 * Organization and the app, as one line („Pracovní Prostředí vm-01 · Acme ·
 * Apps“). The Osobní Prostředí is named by its kind alone. */
export function contextLine(context: PageContext, lang: Lang): string {
  const copy = copyOf(lang);
  const parts: string[] = [];
  const environment = context.environment;
  if (environment !== null) {
    const kind = copy[kindKey[environment.kind]];
    parts.push(
      environment.kind === "personal" || environment.name === kind
        ? kind
        : `${kind} ${environment.name}`,
    );
  }
  if (context.organization !== null) parts.push(context.organization.name);
  if (context.app !== null) parts.push(copy[appKey[context.app]]);
  return parts.join(" · ");
}

/** The channel a message came through, by its Hermes platform; null for the
 * web, whose messages need no mark here. */
export function channelName(via: string): string | null {
  if (via === "lazurio_web") return null;
  const known: Readonly<Record<string, string>> = {
    telegram: "Telegram",
    whatsapp: "WhatsApp",
    signal: "Signal",
    slack: "Slack",
    discord: "Discord",
    email: "e-mail",
    sms: "SMS",
  };
  return known[via] ?? via;
}
