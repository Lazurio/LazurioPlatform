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
  jumpTitle: string;
  jumpEmpty: string;
  settings: string;
  settingsSub: string;
  account: string;
  accountSub: string;
  thisComputer: string;
  personal: string;
  organizationSub: string;
  more: string;
  moreNamed: string;
  less: string;
  lessNamed: string;
  current: string;
  kinds: Readonly<Record<ShellEnvironmentKind, string>>;
  switchLabel: string;
  chat: string;
  apps: string;
  automate: string;
  chatMissing: string;
  automateMissing: string;
  close: string;
}>;

const en: ShellCopy = {
  rail: "Environments and Organizations",
  dashboard: "Dashboard",
  dashboardSub: "Your overview across Organizations",
  jump: "Go to an Environment",
  jumpShortcut: "⌘⇧E",
  jumpTitle: "Go to an Environment",
  jumpEmpty: "No Environment matches.",
  settings: "Environment Settings",
  settingsSub: "Settings of this Environment",
  account: "Lazurio account",
  accountSub: "Account settings in the Dashboard",
  thisComputer: "This computer",
  personal: "Personal",
  organizationSub: "Organization",
  more: "+{count}",
  moreNamed: "Show {count} more Environments of {name}",
  less: "less",
  lessNamed: "Show fewer Environments of {name}",
  current: "you are here",
  kinds: {
    personal: "personal",
    work: "work",
    team: "Team",
    automated: "automated",
    workstation: "this computer",
  },
  switchLabel: "Apps of this Environment",
  chat: "Chat",
  apps: "Apps",
  automate: "Automate",
  chatMissing: "Chat does not run on this Environment",
  automateMissing: "MausBot does not run on this Environment",
  close: "Close",
};

const cs: ShellCopy = {
  rail: "Environmenty a Organizace",
  dashboard: "Dashboard",
  dashboardSub: "Tvůj přehled napříč Organizacemi",
  jump: "Přejít na Environment",
  jumpShortcut: "⌘⇧E",
  jumpTitle: "Přejít na Environment",
  jumpEmpty: "Žádný Environment neodpovídá.",
  settings: "Nastavení Environmentu",
  settingsSub: "Nastavení tohoto Environmentu",
  account: "Lazurio účet",
  accountSub: "Nastavení účtu v Dashboardu",
  thisComputer: "Tento počítač",
  personal: "Osobní",
  organizationSub: "Organizace",
  more: "+{count}",
  moreNamed: "Ukázat dalších {count} Environmentů v {name}",
  less: "méně",
  lessNamed: "Ukázat méně Environmentů v {name}",
  current: "tady jsi",
  kinds: {
    personal: "osobní",
    work: "pracovní",
    team: "týmový",
    automated: "automatizovaný",
    workstation: "tento počítač",
  },
  switchLabel: "Aplikace Environmentu",
  chat: "Chat",
  apps: "Apps",
  automate: "Automate",
  chatMissing: "Chat na tomto Environmentu neběží",
  automateMissing: "MausBot na tomto Environmentu neběží",
  close: "Zavřít",
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
