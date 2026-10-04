import type { ShellEnvironmentKind } from "./contract";

// The words of the shell elements, in the two languages of the Launchpad, in
// its tone (decision F16 naming: Environment, never Machine or VM). The
// elements live in other apps too (the forks), so they carry their own words
// rather than the Launchpad's catalogue.

export type ShellCopy = Readonly<{
  rail: string;
  dashboard: string;
  dashboardSub: string;
  jump: string;
  jumpShortcut: string;
  personal: string;
  addOrganization: string;
  account: string;
  accountSub: string;
  /** "{count} Environment(s)" by the Czech plural. */
  environmentsOne: string;
  environmentsFew: string;
  environmentsMany: string;
  last: string;
  /** The second line of a space without an Environment: its Dashboard. */
  spaceEmpty: string;
  /** The name of an Environment without its own name, by kind. */
  names: Readonly<Record<ShellEnvironmentKind, string>>;
  /** Who an Environment is for, by kind. */
  who: Readonly<Record<ShellEnvironmentKind, string>>;
  pick: string;
  settings: string;
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
  switchLabel: string;
  chat: string;
  apps: string;
  automate: string;
  chatMissing: string;
  automateMissing: string;
}>;

const en: ShellCopy = {
  rail: "Organizations",
  dashboard: "Dashboard",
  dashboardSub: "Your overview across Organizations",
  jump: "Go to an Environment",
  jumpShortcut: "⌘⇧E",
  personal: "Personal",
  addOrganization: "Add an Organization",
  account: "Lazurio account",
  accountSub: "Account settings in the Dashboard",
  environmentsOne: "{count} Environment",
  environmentsFew: "{count} Environments",
  environmentsMany: "{count} Environments",
  last: "last {name}",
  spaceEmpty: "No Environment yet · opens its Dashboard",
  names: {
    personal: "Personal",
    work: "Work",
    team: "Team",
    automated: "Automated",
    workstation: "This computer",
  },
  who: {
    personal: "only yours",
    work: "work",
    team: "shared by the Team",
    automated: "automation",
    workstation: "this computer",
  },
  pick: "{name}, switch Environment",
  settings: "Environment Settings",
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
  switchLabel: "Apps of this Environment",
  chat: "Chat",
  apps: "Apps",
  automate: "Automate",
  chatMissing: "Chat does not run on this Environment",
  automateMissing: "MausBot does not run on this Environment",
};

const cs: ShellCopy = {
  rail: "Organizace",
  dashboard: "Dashboard",
  dashboardSub: "tvůj přehled napříč Organizacemi",
  jump: "Přejít na Environment",
  jumpShortcut: "⌘⇧E",
  personal: "Osobní",
  addOrganization: "Přidat organizaci",
  account: "Lazurio účet",
  accountSub: "Nastavení účtu v Dashboardu",
  environmentsOne: "{count} Environment",
  environmentsFew: "{count} Environmenty",
  environmentsMany: "{count} Environmentů",
  last: "naposledy {name}",
  spaceEmpty: "Zatím žádný Environment · otevře Dashboard",
  names: {
    personal: "Osobní",
    work: "Pracovní",
    team: "Týmový",
    automated: "Automatizovaný",
    workstation: "Tento počítač",
  },
  who: {
    personal: "jen tvůj",
    work: "pracovní",
    team: "sdílený Teamem",
    automated: "automatizace",
    workstation: "tento počítač",
  },
  pick: "{name}, přepnout Environment",
  settings: "Nastavení Environmentu",
  switcher: "Přejít na Environment",
  searchIn: "Hledat v {name}…",
  searchAll: "Environment nebo Organizace…",
  organizationDashboard: "Dashboard Organizace",
  here: "tady jsi",
  noEnvironment: "Tady nemáš žádný Environment.",
  nothing: "Nic takového tu není.",
  widen: "Všechny Organizace",
  choose: "vybrat",
  go: "přejít",
  close: "zavřít",
  switchLabel: "Aplikace Environmentu",
  chat: "Chat",
  apps: "Apps",
  automate: "Automate",
  chatMissing: "Chat na tomto Environmentu neběží",
  automateMissing: "MausBot na tomto Environmentu neběží",
};

export const shellMessages = (locale: "cs" | "en"): ShellCopy =>
  locale === "cs" ? cs : en;

/** `{name}` style placeholders filled with plain text. */
export const fillShell = (
  template: string,
  values: Readonly<Record<string, string | number>>,
): string =>
  template.replace(/\{(\w+)\}/g, (whole, key: string) =>
    Object.hasOwn(values, key) ? String(values[key]) : whole,
  );
