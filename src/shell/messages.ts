import { type ShellEnvironmentKind, shellEnvironmentKinds } from "./contract";
import { type KindLocale, kindLabel, kindName, kindShort } from "./kind-name";

// The words of the shell elements, in the two languages of the Launchpad, in
// its tone (decision F16 naming: Environment, never Machine or VM). The
// elements live in other apps too (the forks), so they carry their own words
// rather than the Launchpad's catalogue. A label of the rail is the item's
// name alone (F36's addendum of 2026-10-16): no line about how many
// Environments a space has, which one was last, or what a click does. The
// kinds are three, and your own computer has none (decision F28's addendum of
// 2026-10-18, kind-name.ts); a text about the Environment the page is in
// names its kind through the tokens of `inKind` ({tomto}, {this}).

export type ShellCopy = Readonly<{
  rail: string;
  dashboard: string;
  jump: string;
  personal: string;
  addOrganization: string;
  account: string;
  /** The two entries of the account's menu where the document names a
   * sign-out (F36's addendum of 2026-10-16). */
  accountSettings: string;
  signOut: string;
  /** The name of an Environment without its own name, by kind: an
   * automated one is Pracovní, your own computer Váš počítač. */
  names: Readonly<Record<ShellEnvironmentKind, string>>;
  /** The kind on an Environment's second line, left out where the name
   * already says it (root decision 0170 addendum 2026-10-15; the brand
   * voice, "Druh Prostředí stačí"): Osobní, Pracovní or Týmové, and on your
   * own computer, which has no kind, Váš počítač. */
  kinds: Readonly<Record<ShellEnvironmentKind, string>>;
  /** A work Environment assigned to someone other than the viewer. */
  assignedTo: string;
  /** An Environment known not to run. */
  offline: string;
  pick: string;
  /** The gear beside the picker, by the kind it opens the Settings of
   * ("Nastavení Týmového Prostředí", the prototype's `SettingsGear`). */
  settings: Readonly<Record<ShellEnvironmentKind, string>>;
  /** The gear on an Organization's Dashboard (F36's addendum of
   * 2026-10-05). */
  organizationSettings: string;
  switcher: string;
  searchIn: string;
  searchAll: string;
  organizationDashboard: string;
  here: string;
  noEnvironment: string;
  nothing: string;
  widen: string;
  choose: string;
  go: string;
  close: string;
  /** The switch's name, with a token of `inKind`. */
  switchLabel: string;
  chat: string;
  apps: string;
  automate: string;
  /** A missing app's title, with a token of `inKind`. */
  chatMissing: string;
  automateMissing: string;
  /** The quiet prompt under the switch while the Environment lacks a basic
   * (root decision 0201 point 2): "{done}" of "{total}" done. */
  setupPrompt: string;
  /** The quiet notice of the column head on a public Environment (root
   * decision 0204 point 4, decision F55): one or two sentences, with a token
   * of `inKind`. */
  publicNotice: string;
  /** The rail on a host's page with nobody signed in (F36's addendum of
   * 2026-10-06): its accessible name, and the key's name and label. */
  signedOutRail: string;
  signIn: string;
  /** The guide's card (decision F56): the step on, the last step, the way
   * out, the answer while Začínáme wants attention, the invitation at the
   * end of an explanation about Buddy for a person without one, and the
   * neutral guide's name for assistive technology. */
  guideNext: string;
  guideDone: string;
  guideClose: string;
  guideBusy: string;
  guideInvite: string;
  guideName: string;
}>;

/** One word per kind of `lazurio.shell.v1`. */
function byKind(
  word: (kind: ShellEnvironmentKind) => string,
): Readonly<Record<ShellEnvironmentKind, string>> {
  return Object.freeze(
    Object.fromEntries(shellEnvironmentKinds.map((kind) => [kind, word(kind)])),
  ) as Readonly<Record<ShellEnvironmentKind, string>>;
}

const en: ShellCopy = {
  rail: "Organizations",
  dashboard: "Dashboard",
  jump: "Go to an Environment",
  personal: "Personal",
  addOrganization: "Add an Organization",
  account: "Lazurio account",
  accountSettings: "Account settings",
  signOut: "Sign out",
  names: byKind((kind) => kindShort(kind, "en")),
  kinds: byKind((kind) => kindShort(kind, "en")),
  assignedTo: "assigned to {login}",
  offline: "offline",
  pick: "{name}, switch Environment",
  settings: byKind((kind) =>
    kind === "workstation"
      ? "Settings of your computer"
      : `${kindLabel(kind, "en")} Settings`,
  ),
  organizationSettings: "Organization Settings",
  switcher: "Go to an Environment",
  searchIn: "Search in {name}…",
  searchAll: "Environment or Organization…",
  organizationDashboard: "Organization Dashboard",
  here: "you are here",
  noEnvironment: "You have no Environment here.",
  nothing: "Nothing like that here.",
  widen: "All Organizations",
  choose: "choose",
  go: "go",
  close: "close",
  switchLabel: "Apps of {this}",
  chat: "Chat",
  apps: "Apps",
  automate: "Automate",
  chatMissing: "Chat does not run {in this}",
  automateMissing: "Automate does not run {in this}",
  setupPrompt: "Finish setting up ({done} of {total})",
  publicNotice:
    "{This} is public and shared and is wiped every night. Do not enter personal data or sign in to your own accounts.",
  signedOutRail: "Lazurio",
  signIn: "Sign in with your Lazurio account",
  guideNext: "Next",
  guideDone: "Got it",
  guideClose: "Close",
  guideBusy: "Finish Getting started first",
  guideInvite: "Get your Buddy",
  guideName: "Lazurio guide",
};

const cs: ShellCopy = {
  rail: "Organizace",
  dashboard: "Přehled",
  jump: "Přejít na Prostředí",
  personal: "Osobní",
  addOrganization: "Přidat organizaci",
  account: "Lazurio účet",
  accountSettings: "Nastavení účtu",
  signOut: "Odhlásit",
  names: byKind((kind) => kindShort(kind, "cs")),
  kinds: byKind((kind) => kindShort(kind, "cs")),
  assignedTo: "přiřazeno {login}",
  offline: "offline",
  pick: "{name}, přepnout Prostředí",
  settings: byKind((kind) => `Nastavení ${kindName(kind, { case: "gen" })}`),
  organizationSettings: "Nastavení Organizace",
  switcher: "Přejít na Prostředí",
  searchIn: "Hledat v {name}…",
  searchAll: "Prostředí nebo Organizace…",
  organizationDashboard: "Přehled Organizace",
  here: "tady jste",
  noEnvironment: "Tady nemáte žádné Prostředí.",
  nothing: "Nic takového tu není.",
  widen: "Všechny Organizace",
  choose: "vybrat",
  go: "přejít",
  close: "zavřít",
  switchLabel: "Aplikace {tohoto}",
  chat: "Chat",
  apps: "Apps",
  automate: "Automate",
  chatMissing: "Chat {v tomto} neběží",
  automateMissing: "Automate {v tomto} neběží",
  setupPrompt: "Dokončit nastavení ({done} ze {total})",
  publicNotice:
    "{Toto} je veřejné a sdílené a každou noc se smaže. Nezadávejte sem osobní údaje a nepřihlašujte se ke svým účtům.",
  signedOutRail: "Lazurio",
  signIn: "Přihlásit Lazurio účtem",
  guideNext: "Další",
  guideDone: "Rozumím",
  guideClose: "Ukončit",
  guideBusy: "Nejdřív dokončete Začínáme",
  guideInvite: "Založte si Buddyho",
  guideName: "Průvodce Lazuriem",
};

export const shellMessages = (locale: KindLocale): ShellCopy =>
  locale === "cs" ? cs : en;

/** `{name}` style placeholders filled with plain text. */
export const fillShell = (
  template: string,
  values: Readonly<Record<string, string | number>>,
): string =>
  template.replace(/\{(\w+)\}/g, (whole, key: string) =>
    Object.hasOwn(values, key) ? String(values[key]) : whole,
  );
