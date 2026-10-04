import {
  currentEnvironment,
  type Shell,
  type ShellEnvironment,
  type ShellOrganization,
} from "./contract";
import { fillShell, type ShellCopy } from "./messages";

// Pure presentation of the shell document (decision F36, addendum of
// 2026-10-04): the rail of spaces (your personal space, then one avatar per
// Organization), the Environment picker at the head of the left column with
// its list, and the switch Chat · Apps · Automate. The elements in
// elements.ts only draw it. Every Environment is named one way everywhere:
// by its own name or its kind, with a line saying who it is for, never by
// the machine's technical name.

/** A space of the rail: your personal space or one Organization. */
export const personalSpace = "personal";

/** The app a link of the shell leads into. */
export const shellApps = ["chat", "apps", "automate"] as const;
export type ShellApp = (typeof shellApps)[number];

/** Up to two letters of a name: the first letters of its first two words,
 * else its first two letters. */
export function initialsOf(name: string): string {
  const words = name
    .split(/[\s_.-]+/)
    .filter((word) => /[\p{L}\p{N}]/u.test(word));
  const letters =
    words.length >= 2
      ? [words[0]?.[0], words[1]?.[0]]
      : [...(words[0] ?? name)].slice(0, 2);
  return letters
    .filter((letter): letter is string => letter !== undefined)
    .join("")
    .toLocaleUpperCase();
}

/** The name an Environment is shown under: its own, else its kind's. */
export const environmentName = (
  environment: ShellEnvironment,
  copy: ShellCopy,
): string => environment.label ?? copy.names[environment.kind];

/** Who an Environment is for: a work Environment's person, otherwise its
 * kind's word. */
export const environmentWho = (
  environment: ShellEnvironment,
  copy: ShellCopy,
): string =>
  environment.kind === "work" && environment.assignee !== null
    ? `@${environment.assignee}`
    : copy.who[environment.kind];

const sameSlug = (left: string, right: string) =>
  left.toLowerCase() === right.toLowerCase();

/** The Organization of a slug the document lists. */
export const organizationOf = (
  shell: Shell,
  slug: string,
): ShellOrganization | undefined =>
  shell.organizations.find((entry) => sameSlug(entry.slug, slug));

/** The space you are in: the one the host names (`space`, a workstation
 * opened for one Organization), otherwise the current Environment's: a
 * personal one or a workstation is personal, any other its first
 * Organization's. */
export function hereOf(shell: Shell, space: string | null): string {
  if (
    space !== null &&
    (space === personalSpace || organizationOf(shell, space) !== undefined)
  )
    return space === personalSpace
      ? space
      : (organizationOf(shell, space)?.slug ?? space);
  const current = currentEnvironment(shell);
  return current.kind === "personal" ||
    current.kind === "workstation" ||
    current.organizations.length === 0
    ? personalSpace
    : (current.organizations[0] ?? personalSpace);
}

/** The Environments of a space, in document order: your personal ones and
 * workstations for the personal space, and for an Organization those that
 * hold it (a workstation holding it among them). */
export function spaceEnvironments(
  shell: Shell,
  space: string,
): readonly ShellEnvironment[] {
  if (space === personalSpace)
    return shell.environments.filter(
      (entry) =>
        entry.kind === "personal" ||
        entry.kind === "workstation" ||
        entry.organizations.length === 0,
    );
  const own = shell.environments.filter(
    (entry) =>
      entry.kind !== "workstation" &&
      entry.organizations.some((slug) => sameSlug(slug, space)),
  );
  const workstations = shell.environments.filter(
    (entry) =>
      entry.kind === "workstation" &&
      entry.organizations.some((slug) => sameSlug(slug, space)),
  );
  return [...own, ...workstations];
}

/** Where a link to an Environment leads, in a space and an app: the app's
 * origin, Apps where the Environment has not that app; a workstation holding
 * several Organizations opens Apps for the space's (`o/<slug>`, the
 * Launchpad's route of one Organization). */
export function environmentHref(
  environment: ShellEnvironment,
  space: string,
  app: ShellApp,
): string {
  const base =
    app === "chat"
      ? environment.apps.chat
      : app === "automate"
        ? environment.apps.automate
        : null;
  if (base !== null) return base;
  const apps = environment.apps.apps;
  if (space === personalSpace || environment.organizations.length < 2)
    return apps;
  const root = apps.endsWith("/") ? apps : `${apps}/`;
  return `${root}o/${encodeURIComponent(space)}`;
}

const pluralKey = (count: number) =>
  count === 1
    ? "environmentsOne"
    : count >= 2 && count <= 4
      ? "environmentsFew"
      : "environmentsMany";

export type RailSpace = Readonly<{
  space: string;
  /** The label's first line. */
  title: string;
  /** Its second line: how many Environments, and the last one. */
  sub: string;
  href: string;
  active: boolean;
  /** The Organization's avatar or initials; the personal space's initials. */
  avatar: string | null;
  initials: string | null;
}>;

/** The rail: your personal space, then every Organization of the document
 * in its order. A click leads to the space's last Environment (`last`, by
 * space, what this browser remembers), else its first, in the same app;
 * a space without one leads to its Dashboard. */
export function railSpaces(
  shell: Shell,
  copy: ShellCopy,
  options: Readonly<{
    here: string;
    app: ShellApp;
    last: (space: string) => string | null;
  }>,
): readonly RailSpace[] {
  const space = (
    id: string,
    title: string,
    dashboard: string,
    marks: Readonly<{ avatar: string | null; initials: string | null }>,
  ): RailSpace => {
    const environments = spaceEnvironments(shell, id);
    const remembered = options.last(id);
    const last = environments.find((entry) => entry.id === remembered);
    const target = last ?? environments[0];
    return Object.freeze({
      space: id,
      title,
      sub: [
        fillShell(copy[pluralKey(environments.length)], {
          count: environments.length,
        }),
        last === undefined
          ? null
          : fillShell(copy.last, { name: environmentName(last, copy) }),
      ]
        .filter((part) => part !== null)
        .join(" · "),
      href:
        target === undefined
          ? dashboard
          : environmentHref(target, id, options.app),
      active: options.here === id,
      ...marks,
    });
  };
  return [
    space(personalSpace, copy.personal, shell.dashboard, {
      avatar: null,
      initials: shell.operator.initials,
    }),
    ...shell.organizations.map((organization) =>
      space(organization.slug, organization.name, organization.dashboard, {
        avatar: organization.avatar,
        initials: initialsOf(organization.name),
      }),
    ),
  ];
}

/** What the picker shows of an Environment: its glyph, its name and who it
 * is for. The glyph is the Organization's avatar where it belongs to one,
 * your initials for a personal one, and the kind's icon otherwise. */
export type EnvironmentGlyph =
  | Readonly<{ kind: "avatar"; organization: ShellOrganization }>
  | Readonly<{ kind: "initials"; text: string }>
  | Readonly<{ kind: "icon"; icon: "laptop" | "user" | "users" | "bot" }>;

const kindIcons = {
  personal: "user",
  work: "user",
  team: "users",
  automated: "bot",
  workstation: "laptop",
} as const;

export function environmentGlyph(
  shell: Shell,
  environment: ShellEnvironment,
  space: string,
): EnvironmentGlyph {
  if (environment.kind === "personal" && shell.operator.initials !== null)
    return { kind: "initials", text: shell.operator.initials };
  const organization =
    space === personalSpace ? undefined : organizationOf(shell, space);
  return organization !== undefined
    ? { kind: "avatar", organization }
    : { kind: "icon", icon: kindIcons[environment.kind] };
}

export type SwitcherRow = Readonly<{
  id: string;
  name: string;
  who: string;
  href: string;
  current: boolean;
  /** A row's glyph: your initials for a personal Environment, otherwise its
   * kind's icon (the Organization stands in the head above). */
  glyph: Exclude<EnvironmentGlyph, { kind: "avatar" }>;
}>;

export type SwitcherSection = Readonly<{
  space: string;
  title: string;
  /** An Organization's head above its Environments: its Dashboard. */
  head: Readonly<{
    organization: ShellOrganization;
    href: string;
  }> | null;
  rows: readonly SwitcherRow[];
}>;

/** The list of the picker (one space, `all` false) and of ⌘⇧E (every space,
 * `all` true): your personal Environments, then each Organization with its
 * head and its Environments, the current one marked, filtered by `query`
 * against the space, the name and who it is for. A space keeps its head
 * while it matches and stays listed empty only when it is the one asked
 * for. */
export function switcherSections(
  shell: Shell,
  copy: ShellCopy,
  options: Readonly<{
    here: string;
    all: boolean;
    app: ShellApp;
    query: string;
  }>,
): readonly SwitcherSection[] {
  const words = options.query.trim().toLocaleLowerCase();
  const matches = (...parts: string[]) =>
    words === "" || parts.join(" ").toLocaleLowerCase().includes(words);
  const row = (environment: ShellEnvironment, space: string): SwitcherRow => {
    const glyph: SwitcherRow["glyph"] =
      environment.kind === "personal" && shell.operator.initials !== null
        ? { kind: "initials", text: shell.operator.initials }
        : { kind: "icon", icon: kindIcons[environment.kind] };
    return Object.freeze({
      id: environment.id,
      name: environmentName(environment, copy),
      who: environmentWho(environment, copy),
      href: environmentHref(environment, space, options.app),
      current: environment.id === shell.current && options.here === space,
      glyph,
    });
  };
  const spaces = options.all
    ? [personalSpace, ...shell.organizations.map((entry) => entry.slug)]
    : [options.here];
  return spaces.flatMap((space): SwitcherSection[] => {
    const organization =
      space === personalSpace ? undefined : organizationOf(shell, space);
    const title = organization?.name ?? copy.personal;
    const rows = spaceEnvironments(shell, space)
      .map((environment) => row(environment, space))
      .filter((entry) => matches(title, entry.name, entry.who));
    const head =
      organization !== undefined &&
      matches(organization.name, copy.organizationDashboard)
        ? { organization, href: organization.dashboard }
        : null;
    if (rows.length === 0 && head === null && (options.all || words !== ""))
      return [];
    return [Object.freeze({ space, title, head, rows: Object.freeze(rows) })];
  });
}

export type SwitchTab = Readonly<{
  app: ShellApp;
  label: string;
  /** Null where the Environment has no such app: the tab is shown
   * disabled with `missing` as its title. */
  href: string | null;
  missing: string | null;
  active: boolean;
}>;

/** The switch Chat · Apps · Automate of the current Environment, `active`
 * being the app the switch sits in (none inside Settings). */
export function switchTabs(
  shell: Shell,
  copy: ShellCopy,
  active: ShellApp | null,
): readonly SwitchTab[] {
  const { apps } = currentEnvironment(shell);
  const href: Readonly<Record<ShellApp, string | null>> = {
    chat: apps.chat,
    apps: apps.apps,
    automate: apps.automate,
  };
  const missing: Readonly<Record<ShellApp, string | null>> = {
    chat: copy.chatMissing,
    apps: null,
    automate: copy.automateMissing,
  };
  return shellApps.map((app) =>
    Object.freeze({
      app,
      label: copy[app],
      href: href[app],
      missing: href[app] === null ? missing[app] : null,
      active: app === active,
    }),
  );
}
