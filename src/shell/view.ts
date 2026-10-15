import {
  type AccountVisit,
  currentEnvironment,
  isEnvironmentId,
  type Shell,
  type ShellEnvironment,
  type ShellOrganization,
  type ShellSignedOut,
} from "./contract";
import { fillShell, type ShellCopy, shellMessages } from "./messages";

// Pure presentation of the shell document (decision F36, addendum of
// 2026-10-04): the rail of spaces (your personal space, then one avatar per
// Organization), the Environment picker at the head of the left column with
// its list, and the switch Chat · Apps · Automate. The elements in
// elements.ts only draw it. Every Environment is named one way everywhere:
// by its own name or its kind, with a line saying who it is for, never by
// the machine's technical name. The list under the picker and the jump to
// any Environment (⌘⇧E) are one line per Environment (F36's addendum of
// 2026-10-06, `switcherList`, and the keys of both, `switcherKey`).
//
// A page that is no Environment's (F36's addendum of 2026-10-05, a host such
// as the Dashboard; `current: null`) is the personal Dashboard or an
// Organization's Dashboard, as the host's `space` attribute names it
// (`pageOf`). There the rail marks that Organization as the space you are in
// or, on the personal Dashboard, the logo; the column head names the Organization with
// the gear of its Settings and no switch, and draws nothing on the personal
// Dashboard. An Environment's page is drawn exactly as before. With nobody
// signed in (F36's addendum of 2026-10-06, `lazurio.shell-signed-out.v1`) the
// rail is only the logo and the sign-in key (`signedOutRail`).
//
// One Environment is named by one identity wherever the shell or an app
// shows it (F39's addendum of 2026-10-12, `environmentIdentity`): the column
// head's picker, `<lazurio-environment>` in an app, and the bar of the
// Environment browser's view, which takes it from the app around it or from
// its own server. Its glyph, name and who line are the picker's.

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

/** The quieter line beside an Environment's name, the same rule as the
 * Dashboard's (root decision 0170 addendum 2026-10-15; the brand voice,
 * "Druh Prostředí stačí"): the account's line exactly as the Dashboard words
 * it where it gives one (empty: nothing to add); otherwise its kind, left out
 * where the name already says it, "assigned to @login" for a work
 * Environment of someone other than `viewer`, and "offline" when it is known
 * not to run. Never "only yours" or "shared by the Team"; empty when there is
 * nothing to add, so a default name such as "Pracovní" stands alone. */
export const environmentWho = (
  environment: ShellEnvironment,
  copy: ShellCopy,
  viewer: string | null = null,
): string => {
  if (environment.who !== undefined) return environment.who;
  const kind = copy.kinds[environment.kind];
  const assignee = environment.assignee;
  return [
    saysKind(environmentName(environment, copy), kind) ? null : kind,
    environment.kind === "work" &&
    assignee !== null &&
    assignee.toLowerCase() !== viewer?.toLowerCase()
      ? fillShell(copy.assignedTo, { login: `@${assignee}` })
      : null,
    environment.offline === true ? copy.offline : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");
};

/** Whether a name already says a kind: the kind's words as whole words of
 * the name, in any case ("Pracovní 2" says Pracovní, "Team Sales" says
 * Team). */
function saysKind(name: string, kind: string): boolean {
  const words = (text: string) =>
    text
      .toLocaleLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean);
  const named = words(name);
  const said = words(kind);
  return named.some((_, at) =>
    said.every((word, offset) => named[at + offset] === word),
  );
}

const sameSlug = (left: string, right: string) =>
  left.toLowerCase() === right.toLowerCase();

/** The Organization of a slug the document lists. */
export const organizationOf = (
  shell: Shell,
  slug: string,
): ShellOrganization | undefined =>
  shell.organizations.find((entry) => sameSlug(entry.slug, slug));

/** The space an Environment stands in by itself: the personal one for a
 * personal Environment, a workstation and one without an Organization,
 * otherwise its first Organization's, the one that owns it (the producer
 * lists the owner first). */
export function environmentSpace(environment: ShellEnvironment): string {
  return environment.kind === "personal" || environment.kind === "workstation"
    ? personalSpace
    : (environment.organizations[0] ?? personalSpace);
}

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
 * `personal` or a listed Organization, otherwise the current Environment's
 * own (`environmentSpace`). Without one (`current: null`): the Dashboard of
 * the Organization `space` names; without it, with `personal` or with a slug
 * the document does not list, the personal Dashboard. */
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
        : environmentSpace(current);
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
 * `here` is the space you are in; none on the personal Dashboard. */
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
 * addendum of 2026-10-05); no space is marked then. */
export function railHome(
  shell: Shell,
  space: string | null,
): Readonly<{ href: string; current: boolean }> {
  return Object.freeze({
    href: shell.dashboard,
    current: pageOf(shell, space).kind === "dashboard",
  });
}

/** An item of the rail while nobody is signed in. */
export type SignedOutRailItem = Readonly<{
  /** `home`: the Lazurio logo at the top; `sign-in`: the key at the foot,
   * where a person's account stands. */
  kind: "home" | "sign-in";
  href: string;
  /** Its accessible name and the first line of its label. */
  label: string;
  /** The label's second line; empty for none. */
  sub: string;
}>;

export type SignedOutRail = Readonly<{
  /** The rail's accessible name. */
  label: string;
  items: readonly SignedOutRailItem[];
}>;

/** The rail on a host's page with nobody signed in (F36's addendum of
 * 2026-10-06; the Dashboard's wireframe, 2.8): the Lazurio logo and the key
 * "Přihlásit Lazurio účtem", both leading to where sign-in starts, in the
 * signed-in rail's order. Nothing else: no search and no ⌘⇧E, no spaces, no
 * "+" and no account, for there is no person. The logo keeps its name and
 * label (the Dashboard, which sign-in leads to) and is not the page you are
 * on: it leads to sign-in, not to this page. */
export function signedOutRail(
  signedOut: ShellSignedOut,
  copy: ShellCopy,
): SignedOutRail {
  const item = (entry: SignedOutRailItem) => Object.freeze(entry);
  return Object.freeze({
    label: copy.signedOutRail,
    items: Object.freeze([
      item({
        kind: "home",
        href: signedOut.signIn,
        label: copy.dashboard,
        sub: copy.dashboardSub,
      }),
      item({
        kind: "sign-in",
        href: signedOut.signIn,
        label: copy.signIn,
        sub: "",
      }),
    ]),
  });
}

/** The mark the picker draws beside a name: the Organization's avatar (its
 * initials where it has none or the picture does not load, and its name for
 * the words), your initials, or the kind's icon. Display data only, so it
 * may cross to a framed view as it is (F39's addendum of 2026-10-12). */
export type EnvironmentGlyph =
  | Readonly<{
      kind: "avatar";
      /** The Organization's name. */
      organization: string;
      avatar: string | null;
      initials: string;
    }>
  | Readonly<{ kind: "initials"; text: string }>
  | Readonly<{ kind: "icon"; icon: "laptop" | "user" | "users" | "bot" }>;

/** An Organization's mark: its avatar, its initials and its name. */
export const organizationGlyph = (
  organization: ShellOrganization,
): EnvironmentGlyph =>
  Object.freeze({
    kind: "avatar",
    organization: organization.name,
    avatar: organization.avatar,
    initials: initialsOf(organization.name),
  });

const kindIcons = {
  personal: "user",
  work: "user",
  team: "users",
  automated: "bot",
  workstation: "laptop",
} as const;

/** What the picker shows of an Environment in a space: your initials for a
 * personal one, the space's Organization's mark where the space is one, the
 * kind's icon otherwise. */
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
    ? organizationGlyph(organization)
    : { kind: "icon", icon: kindIcons[environment.kind] };
}

/** What a head draws of what it names: its glyph, its name and, quieter
 * under or beside it, who it is for (`drawIdentity`). */
export type IdentityLook = Readonly<{
  glyph: EnvironmentGlyph;
  name: string;
  who: string;
}>;

/** How the shell names one Environment wherever it shows it (F39's addendum
 * of 2026-10-12): the column head's picker, `<lazurio-environment>`, and the
 * bar and title of the Environment browser's view. */
export type EnvironmentIdentity = IdentityLook &
  Readonly<{
    /** The Environment's id (`isEnvironmentId`). */
    id: string;
  }>;

function identityOf(
  shell: Shell,
  environment: ShellEnvironment,
  copy: ShellCopy,
  space: string,
): EnvironmentIdentity {
  return Object.freeze({
    id: environment.id,
    name: environmentName(environment, copy),
    who: environmentWho(environment, copy, shell.operator.login),
    glyph: environmentGlyph(shell, environment, space),
  });
}

/** The identity of the Environment `id` in a document, the person's account
 * merged in where the page has it (so a Dashboard name and who line show):
 * `environmentName`, `environmentWho` and `environmentGlyph` in the space
 * the Environment stands in by itself (`environmentSpace`), or in `space`
 * where the page knows better (a workstation opened for one Organization).
 * The only rule that names an Environment; never by the machine's technical
 * name or an address. Null for an id the document does not list. */
export function environmentIdentity(
  shell: Shell,
  id: string,
  copy: ShellCopy,
  space?: string,
): EnvironmentIdentity | null {
  const environment = shell.environments.find((entry) => entry.id === id);
  return environment === undefined
    ? null
    : identityOf(
        shell,
        environment,
        copy,
        space ?? environmentSpace(environment),
      );
}

/** How the app around a framed view of the Environment browser answers the
 * view's question (F39's addendum of 2026-10-12): its Environment in its own
 * space. A view belongs to a hosted Environment, which holds one Organization
 * (or is personal), so each page of its apps stands in that same space and
 * every column head of them names it alike. A workstation has no view: its
 * id, `local`, is never answered, so a view whose address reads as `local`
 * (a person's own Environment with that slug) is never named as this
 * computer (Pablo's review of #339). Null too for an Environment the
 * document does not know. */
export function viewIdentity(
  shell: Shell,
  environment: string,
  copy: ShellCopy,
): EnvironmentIdentity | null {
  const found = shell.environments.find((entry) => entry.id === environment);
  return found === undefined || found.kind === "workstation"
    ? null
    : environmentIdentity(shell, environment, copy);
}

/** The identity `<lazurio-environment>` draws for its attributes: of the
 * Environment `environment` names (an Environment id, in any case), else of
 * the page's own (`current`), in the language `lang` names, else the
 * document's. For the page's own Environment, `space` is the page's space as
 * the host names it to the column head, read by the same rule (`pageOf`), so
 * that the element and the column head of one page name it alike also on a
 * workstation opened for one Organization (Pablo's review of #339). Another
 * Environment, and the page's own without `space`, stands in its own space
 * (`environmentSpace`). Null for a value that is no id, an Environment the
 * document does not know, and a page that is no Environment's without the
 * attribute. */
export function elementIdentity(
  shell: Shell,
  environment: string | null,
  lang: string | null,
  space: string | null = null,
): EnvironmentIdentity | null {
  const named = environment?.trim().toLowerCase() ?? "";
  const id = named === "" ? shell.current : named;
  if (id === null || !isEnvironmentId(id)) return null;
  const page =
    id === shell.current && space !== null ? pageOf(shell, space) : null;
  return environmentIdentity(
    shell,
    id,
    shellMessages(lang === "cs" || lang === "en" ? lang : shell.locale),
    page?.kind === "environment" ? page.space : undefined,
  );
}

/** An identity in words, where nothing draws its mark (a tab's title, a
 * tooltip): the Organization whose avatar the mark is (unless the name is
 * already its), the name and who it is for. */
export function identityText(identity: IdentityLook): string {
  const organization =
    identity.glyph.kind === "avatar" &&
    identity.glyph.organization !== identity.name
      ? identity.glyph.organization
      : null;
  return [organization, identity.name, identity.who]
    .filter((part): part is string => part !== null && part !== "")
    .join(" · ");
}

/** A page's title with the identity of its Environment after it (`<page> —
 * <identity in words>`): a browser's tab strip shows only a title's start,
 * so the page's own words go first and its tabs stay apart (Matěj's smoke
 * test in Codex Desktop, 2026-10-12). Either part alone where the other is
 * missing. */
export function titleWithIdentity(
  title: string,
  identity: IdentityLook | null,
): string {
  return [title, identity === null ? "" : identityText(identity)]
    .filter((part) => part !== "")
    .join(" — ");
}

/** One line of the list: an Environment's glyph, its name and, quieter
 * beside it, who it is for; the current one is marked. */
export type SwitcherRow = Readonly<{
  id: string;
  name: string;
  who: string;
  href: string;
  current: boolean;
  /** A row's glyph: your initials for a personal Environment, otherwise its
   * kind's icon, never a tile (the space is the picker's own, a title or a
   * head above). */
  glyph: Exclude<EnvironmentGlyph, { kind: "avatar" }>;
}>;

export type SwitcherSection = Readonly<{
  space: string;
  /** The space's name above its rows where nothing else names it: your
   * personal Environments in the jump, every space once "Všechny
   * Organizace" widened the picker. Null under an Organization's head and
   * for the picker's own space. */
  title: string | null;
  /** An Organization's head above its Environments, leading to its
   * Dashboard: only in the jump to any Environment (⌘⇧E), never under the
   * picker, which picks Environments only. `current` on that Dashboard (a
   * page that is no Environment's). */
  head: Readonly<{
    organization: ShellOrganization;
    href: string;
    current: boolean;
  }> | null;
  rows: readonly SwitcherRow[];
  /** The line under an Organization without an Environment while nothing is
   * searched ("Tady nemáš žádný Environment."); null otherwise. */
  empty: string | null;
}>;

/** Where the list of Environments is: under the column head's picker
 * (`picker`, the space you are in until "Všechny Organizace" widens it) or
 * the jump to any Environment (`jump`, ⌘⇧E, every space). */
export type SwitcherKind = "picker" | "jump";

/** The list as the elements draw it (F36's addendum of 2026-10-06, the
 * wireframe's compact picker, design-system-lazurio `lz-menu-item--compact`). */
export type SwitcherList = Readonly<{
  /** The search field's placeholder; null where the list has no field: under
   * the picker while its space has seven Environments or fewer. */
  search: string | null;
  sections: readonly SwitcherSection[];
  /** "Nic takového tu není." where a list of every space or a search finds
   * nothing; null otherwise. */
  nothing: string | null;
  /** "Všechny Organizace", the only thing at the picker's foot until it
   * widens the list; null once widened and in the jump. */
  widen: string | null;
  /** The keys the jump's foot names (↑↓, Enter, Esc); none under the
   * picker, which works as any menu. */
  hints: readonly Readonly<{ key: string; word: string }>[];
  /** The entry the cursor is on when the list is drawn afresh (it opens,
   * widens or is searched), heads and rows counted in their order: under
   * the picker as it opens the current Environment, else the first;
   * widened, searched and in the jump the first. */
  start: number;
}>;

/** The most Environments the picker lists without a search field; a space
 * with more gets one (Anička 2026-10-04: a handful needs no search). */
const pickerWithoutSearch = 7;

/** The list of the picker (`picker`: the space you are in, `widened` every
 * space) and of the jump (`jump`: every space): your personal Environments,
 * then each Organization's, one line each, the current one marked, filtered
 * by `query` against the space, the name and who it is for. Only the jump
 * has an Organization's head, which leads to its Dashboard and stays while
 * it matches; under the picker an Organization's Dashboard is its name in
 * the page's head (the Launchpad's Apps). A space stays listed empty only
 * when it is the one asked for. On an Organization's Dashboard (no current
 * Environment, `here` that Organization) no Environment is current, and in
 * the jump its head is; on the personal Dashboard (`here` null) nothing is
 * current. */
export function switcherList(
  shell: Shell,
  copy: ShellCopy,
  options: Readonly<{
    kind: SwitcherKind;
    here: string | null;
    /** Under the picker: "Všechny Organizace" widened it to every space. */
    widened: boolean;
    app: ShellApp;
    query: string;
  }>,
): SwitcherList {
  const jump = options.kind === "jump";
  const all = jump || options.widened;
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
      who: environmentWho(environment, copy, shell.operator.login),
      href: environmentHref(environment, space, options.app),
      current: environment.id === shell.current && options.here === space,
      glyph,
    });
  };
  const nameOf = (space: string) =>
    (space === personalSpace ? undefined : organizationOf(shell, space))
      ?.name ?? copy.personal;
  const own = options.here ?? personalSpace;
  const spaces = all
    ? [personalSpace, ...shell.organizations.map((entry) => entry.slug)]
    : [own];
  const sections = spaces.flatMap((space): SwitcherSection[] => {
    const organization =
      space === personalSpace ? undefined : organizationOf(shell, space);
    const name = nameOf(space);
    const rows = spaceEnvironments(shell, space)
      .map((environment) => row(environment, space))
      .filter((entry) => matches(name, entry.name, entry.who));
    const head =
      jump &&
      organization !== undefined &&
      matches(organization.name, copy.organizationDashboard)
        ? Object.freeze({
            organization,
            href: organization.dashboard,
            current: shell.current === null && options.here === space,
          })
        : null;
    if (rows.length === 0 && head === null && (all || words !== "")) return [];
    return [
      Object.freeze({
        space,
        title: head === null && all ? name : null,
        head,
        rows: Object.freeze(rows),
        empty:
          organization !== undefined && rows.length === 0 && words === ""
            ? copy.noEnvironment
            : null,
      }),
    ];
  });
  const entries = sections.flatMap((section) => [
    ...(section.head === null ? [] : [section.head.current]),
    ...section.rows.map((entry) => entry.current),
  ]);
  const searchable =
    all || spaceEnvironments(shell, own).length > pickerWithoutSearch;
  return Object.freeze({
    search: !searchable
      ? null
      : all
        ? copy.searchAll
        : fillShell(copy.searchIn, { name: nameOf(own) }),
    sections: Object.freeze(sections),
    nothing:
      entries.length === 0 && (all || words !== "") ? copy.nothing : null,
    widen: jump || options.widened ? null : copy.widen,
    hints: Object.freeze(
      jump
        ? [
            { key: "↑↓", word: copy.choose },
            { key: "Enter", word: copy.go },
            { key: "Esc", word: copy.close },
          ]
        : [],
    ),
    start: all || words !== "" ? 0 : Math.max(0, entries.indexOf(true)),
  });
}

/** What a key does in the list of Environments: ↓ and ↑ move the cursor
 * through its entries and wrap; Home and End take the first and the last,
 * except in the search field, whose caret they move; Enter opens the entry
 * under the cursor; Escape closes the list. `focus` is where the key was
 * pressed: the search field, an entry of the list (the picker without a
 * field moves the focus itself), or another control (the button "Všechny
 * Organizace"), which keeps every key but Escape. Null: the key is not the
 * list's. */
export function switcherKey(
  key: string,
  at: Readonly<{
    cursor: number;
    count: number;
    focus: "field" | "entry" | "other";
  }>,
):
  | Readonly<{ kind: "move"; cursor: number }>
  | Readonly<{ kind: "open" }>
  | Readonly<{ kind: "close" }>
  | null {
  if (key === "Escape") return { kind: "close" };
  if (at.focus === "other" || at.count === 0) return null;
  const last = at.count - 1;
  const cursor = Math.min(Math.max(at.cursor, 0), last);
  switch (key) {
    case "ArrowDown":
      return { kind: "move", cursor: cursor === last ? 0 : cursor + 1 };
    case "ArrowUp":
      return { kind: "move", cursor: cursor === 0 ? last : cursor - 1 };
    case "Home":
      return at.focus === "entry" ? { kind: "move", cursor: 0 } : null;
    case "End":
      return at.focus === "entry" ? { kind: "move", cursor: last } : null;
    case "Enter":
      return { kind: "open" };
    default:
      return null;
  }
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
  /** What the picker names: on an Environment's page the Environment's
   * identity (`environmentIdentity`); on an Organization's Dashboard the
   * Organization's mark and name over "Organization Dashboard". */
  picker: EnvironmentIdentity | IdentityLook;
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
 * (its identity in the space you are in), the gear of the Environment's
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
        glyph: organizationGlyph(organization),
        name: organization.name,
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
    picker: identityOf(shell, environment, copy, space),
    gear: {
      href: own ?? environmentSettingsHref(environment),
      label: copy.settings,
      current: inSettings,
    },
    tabs: switchTabs(shell, copy, app),
    setup: columnSetupLine(shell, copy, app),
  };
}
