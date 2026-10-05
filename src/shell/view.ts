import {
  type AccountVisit,
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
//
// A page that is no Environment's (F36's addendum of 2026-10-05, a host such
// as the Dashboard; `current: null`) is the personal Dashboard or an
// Organization's Dashboard, as the host's `space` attribute names it
// (`pageOf`). There the rail rings that Organization or, on the personal
// Dashboard, marks the logo; the column head names the Organization with
// the gear of its Settings and no switch, and draws nothing on the personal
// Dashboard. An Environment's page is drawn exactly as before.

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

/** The name an Environment is shown under: the Dashboard's display name
 * where the account gives one (F37's addendum), else its own, else its
 * kind's. */
export const environmentName = (
  environment: ShellEnvironment,
  copy: ShellCopy,
): string =>
  environment.name ?? environment.label ?? copy.names[environment.kind];

/** Who an Environment is for: the account's line where it gives one, else a
 * work Environment's person, otherwise its kind's word. */
export const environmentWho = (
  environment: ShellEnvironment,
  copy: ShellCopy,
): string =>
  environment.who ??
  (environment.kind === "work" && environment.assignee !== null
    ? `@${environment.assignee}`
    : copy.who[environment.kind]);

const sameSlug = (left: string, right: string) =>
  left.toLowerCase() === right.toLowerCase();

/** The Organization of a slug the document lists. */
export const organizationOf = (
  shell: Shell,
  slug: string,
): ShellOrganization | undefined =>
  shell.organizations.find((entry) => sameSlug(entry.slug, slug));

/** Where a page is (F36's addendum of 2026-10-05): in an Environment, in
 * the space you are in there; or, on a page that is no Environment's, on an
 * Organization's Dashboard or on the personal Dashboard. */
export type ShellPage =
  | Readonly<{
      kind: "environment";
      environment: ShellEnvironment;
      /** The space you are in (`hereOf`). */
      space: string;
    }>
  | Readonly<{ kind: "organization"; organization: ShellOrganization }>
  | Readonly<{ kind: "dashboard" }>;

/** Where the page is. With a current Environment: the space the host names
 * (`space`, a workstation opened for one Organization) when it is
 * `personal` or a listed Organization, otherwise the current Environment's:
 * a personal one or a workstation is personal, any other its first
 * Organization's. Without one (`current: null`): the Dashboard of the
 * Organization `space` names; without it, with `personal` or with a slug the
 * document does not list, the personal Dashboard. */
export function pageOf(shell: Shell, space: string | null): ShellPage {
  const named =
    space === null || space === personalSpace
      ? undefined
      : organizationOf(shell, space);
  const current = currentEnvironment(shell);
  if (current === null)
    return named === undefined
      ? { kind: "dashboard" }
      : { kind: "organization", organization: named };
  const here =
    space === personalSpace
      ? personalSpace
      : named !== undefined
        ? named.slug
        : current.kind === "personal" ||
            current.kind === "workstation" ||
            current.organizations.length === 0
          ? personalSpace
          : (current.organizations[0] ?? personalSpace);
  return { kind: "environment", environment: current, space: here };
}

/** The space you are in, in the document's spelling: on an Environment's
 * page as `pageOf` says, on an Organization's Dashboard that Organization,
 * and none (null) on the personal Dashboard. */
export function hereOf(shell: Shell, space: string | null): string | null {
  const page = pageOf(shell, space);
  return page.kind === "environment"
    ? page.space
    : page.kind === "organization"
      ? page.organization.slug
      : null;
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
 * space: the account's or what this browser remembers), else its first;
 * a space without one leads to its Dashboard. On an Environment's page it
 * stays in the rail's app (`app`). On a page that is no Environment's
 * (`app` null, F36's addendum of 2026-10-05) there is no app to stay in: the
 * last Environment opens in the app its visit recorded, any other in Apps.
 * `here` is the space ringed; none on the personal Dashboard. */
export function railSpaces(
  shell: Shell,
  copy: ShellCopy,
  options: Readonly<{
    here: string | null;
    app: ShellApp | null;
    last: (space: string) => string | AccountVisit | null;
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
    const visit =
      typeof remembered === "string"
        ? { environment: remembered, app: null }
        : remembered;
    const last = environments.find((entry) => entry.id === visit?.environment);
    const target = last ?? environments[0];
    const app =
      options.app ?? (last === undefined ? null : visit?.app) ?? "apps";
    return Object.freeze({
      space: id,
      title,
      // A space without an Environment (an Organization the account lists
      // from the person's memberships) says so and leads to its Dashboard.
      sub:
        target === undefined
          ? copy.spaceEmpty
          : [
              fillShell(copy[pluralKey(environments.length)], {
                count: environments.length,
              }),
              last === undefined
                ? null
                : fillShell(copy.last, { name: environmentName(last, copy) }),
            ]
              .filter((part) => part !== null)
              .join(" · "),
      href: target === undefined ? dashboard : environmentHref(target, id, app),
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

/** The logo at the top of the rail: the personal Dashboard, marked as the
 * page you are on (`aria-current="page"`) when you are on it (F36's
 * addendum of 2026-10-05); no space is ringed then. */
export function railHome(
  shell: Shell,
  space: string | null,
): Readonly<{ href: string; current: boolean }> {
  return Object.freeze({
    href: shell.dashboard,
    current: pageOf(shell, space).kind === "dashboard",
  });
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
  /** An Organization's head above its Environments: its Dashboard,
   * `current` on that Dashboard (a page that is no Environment's). */
  head: Readonly<{
    organization: ShellOrganization;
    href: string;
    current: boolean;
  }> | null;
  rows: readonly SwitcherRow[];
}>;

/** The list of the picker (one space, `all` false) and of ⌘⇧E (every space,
 * `all` true): your personal Environments, then each Organization with its
 * head and its Environments, the current one marked, filtered by `query`
 * against the space, the name and who it is for. A space keeps its head
 * while it matches and stays listed empty only when it is the one asked
 * for. On an Organization's Dashboard (no current Environment, `here` that
 * Organization) its head is the current row and no Environment is; on the
 * personal Dashboard (`here` null) nothing is current. */
export function switcherSections(
  shell: Shell,
  copy: ShellCopy,
  options: Readonly<{
    here: string | null;
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
    : [options.here ?? personalSpace];
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
        ? {
            organization,
            href: organization.dashboard,
            current: shell.current === null && options.here === space,
          }
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
 * being the app the switch sits in (none inside Settings); none on a page
 * that is no Environment's. */
export function switchTabs(
  shell: Shell,
  copy: ShellCopy,
  active: ShellApp | null,
): readonly SwitchTab[] {
  const environment = currentEnvironment(shell);
  if (environment === null) return [];
  const { apps } = environment;
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

/** A link of the column head's setup line. */
export type SetupLink = Readonly<{ label: string; href: string }>;

export type ColumnSetupLine = Readonly<{
  tone: "info" | "failed";
  icon: "key" | "download" | "warning";
  text: string;
  links: readonly SetupLink[];
}>;

/** An address of the Launchpad of the current Environment (its Apps), with
 * the fragment that starts an action on arrival. */
function launchpadHref(
  apps: string,
  path: string,
  start: "sign-in-gh" | "install-content",
): string {
  const fragment = `#lazurio-start=${start}`;
  if (!apps.startsWith("https:")) return `/${path}${fragment}`;
  return `${new URL(path, apps).href}${fragment}`;
}

/** The line the column head shows in Chat and Automate until the current
 * Environment is usable (root decision 0188; the wireframe's `SetupBanner`
 * in the column, prototypes-lazurio 45c92830): without GitHub agents do not
 * work; with it, its Organization or Personalspace is not here yet, or its
 * preparation stopped. Each button leads to the Launchpad's Settings, which
 * starts the action on arrival; "Vyřešit v Chatu" opens Chat with the
 * prepared prompt by its id (and the login the fork needs, Lazurio/t3code
 * #36), never its text. Apps and Settings say it themselves, so nothing
 * there, nor on a page that is no Environment's. */
export function columnSetupLine(
  shell: Shell,
  copy: ShellCopy,
  active: ShellApp | null,
): ColumnSetupLine | null {
  const setup = shell.setup;
  if (setup === undefined || (active !== "chat" && active !== "automate"))
    return null;
  const environment = currentEnvironment(shell);
  if (environment === null) return null;
  const { apps } = environment;
  if (setup.github === "missing")
    return {
      tone: "info",
      icon: "key",
      text: copy.setupGithub,
      links: [
        {
          label: copy.setupGithubAction,
          href: launchpadHref(apps.apps, "settings/tools", "sign-in-gh"),
        },
      ],
    };
  const install = launchpadHref(
    apps.apps,
    "settings/machine",
    "install-content",
  );
  const item = setup.item;
  if (setup.content === "failed") {
    const login = item?.login ?? null;
    const resolve =
      apps.chat === null || login === null
        ? []
        : [
            {
              label: copy.setupResolve,
              href: `${new URL(apps.chat).origin}/#lazurio-prompt=prepare-content&lazurio-org=${encodeURIComponent(login)}`,
            },
          ];
    return {
      tone: "failed",
      icon: "warning",
      text: copy.setupFailed,
      links: [...resolve, { label: copy.setupRetry, href: install }],
    };
  }
  if (setup.content !== "missing" || item === undefined) return null;
  return item.kind === "personalspace"
    ? {
        tone: "info",
        icon: "download",
        text: copy.setupPersonalMissing,
        links: [{ label: copy.setupPrepare, href: install }],
      }
    : {
        tone: "info",
        icon: "download",
        text: fillShell(copy.setupOrganizationMissing, { name: item.name }),
        links: [{ label: copy.setupDownload, href: install }],
      };
}

/** The Settings of an Environment, the gear's address beside its picker:
 * `/settings` of its Launchpad (Apps), a path when Apps is this origin's. */
export function environmentSettingsHref(environment: ShellEnvironment): string {
  const apps = environment.apps.apps;
  return apps.startsWith("/") ? "/settings" : new URL("settings", apps).href;
}

/** The Organization Settings, the gear's address on an Organization's
 * Dashboard: `<its Dashboard page>/settings`, the base "Přístup k modulu"
 * builds on (`moduleAccessUrl` in the Launchpad's `apps-view.ts`). A page on
 * this origin (a path) stays a path. */
export function organizationSettingsHref(dashboard: string): string {
  const url = new URL(dashboard, "https://page.invalid");
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/settings`;
  return dashboard.startsWith("/") ? `${url.pathname}${url.search}` : url.href;
}

/** The head of an app's left column as `<lazurio-column-head>` draws it:
 * the picker and what it names, the gear beside it (the Settings of exactly
 * that), the switch Chat · Apps · Automate and the setup line. */
export type ColumnHead = Readonly<{
  /** The space the picker's list shows. */
  here: string;
  picker: Readonly<{
    glyph: EnvironmentGlyph;
    title: string;
    /** The line under the title. */
    who: string;
  }>;
  gear: Readonly<{
    href: string;
    label: string;
    /** Inside those Settings (`active="settings"`): `aria-current`. */
    current: boolean;
  }>;
  /** The switch; null on an Organization's Dashboard, which has none. */
  tabs: readonly SwitchTab[] | null;
  setup: ColumnSetupLine | null;
}>;

/** What the column head shows, from the host's attributes (`space`,
 * `active`, `settings`). On an Environment's page: the Environment picker
 * (its glyph, name and who it is for), the gear of the Environment's
 * Settings (`settings`, else its Launchpad's `/settings`), the switch and
 * the setup line, as before. On an Organization's Dashboard (F36's addendum
 * of 2026-10-05, a page that is no Environment's with the Organization in
 * `space`): the picker names the Organization (its avatar, its name,
 * "Organization Dashboard"), the gear opens the Organization Settings
 * (`settings`, else `<its Dashboard page>/settings`), and there is no switch
 * and no setup line. On the personal Dashboard: nothing (null). `active`
 * `settings` marks the gear in either. */
export function columnHead(
  shell: Shell,
  copy: ShellCopy,
  options: Readonly<{
    space: string | null;
    active: string | null;
    settings: string | null;
  }>,
): ColumnHead | null {
  const page = pageOf(shell, options.space);
  if (page.kind === "dashboard") return null;
  // An empty attribute is none, as the gear always read it.
  const own =
    options.settings === null || options.settings === ""
      ? null
      : options.settings;
  const inSettings = options.active === "settings";
  if (page.kind === "organization") {
    const { organization } = page;
    return {
      here: organization.slug,
      picker: {
        glyph: { kind: "avatar", organization },
        title: organization.name,
        who: copy.organizationDashboard,
      },
      gear: {
        href: own ?? organizationSettingsHref(organization.dashboard),
        label: copy.organizationSettings,
        current: inSettings,
      },
      tabs: null,
      setup: null,
    };
  }
  const { environment, space } = page;
  const app = (shellApps as readonly (string | null)[]).includes(options.active)
    ? (options.active as ShellApp)
    : null;
  return {
    here: space,
    picker: {
      glyph: environmentGlyph(shell, environment, space),
      title: environmentName(environment, copy),
      who: environmentWho(environment, copy),
    },
    gear: {
      href: own ?? environmentSettingsHref(environment),
      label: copy.settings,
      current: inSettings,
    },
    tabs: switchTabs(shell, copy, app),
    setup: columnSetupLine(shell, copy, app),
  };
}
