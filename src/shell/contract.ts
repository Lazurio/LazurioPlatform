// The data contract of the Lazurio shell (decision F36 and its addendum of
// 2026-10-04): `lazurio.shell.v1`, the document the Launchpad serves at
// `/.lazurio/shell.json` on the Environment's origin and the elements of
// `/.lazurio/shell.js` draw. It names the Environment the page is served
// from, the other Environments the person may enter, their Organizations
// with their Dashboards, and the addresses of the apps. Today the Launchpad
// knows one Environment, its own; the Dashboard fills the others later
// through the Lazurio account, in this same shape, so the elements do not
// change. Pure: no DOM and no I/O, shared by the producer, the page and the
// elements.
//
// Additive only (F36's addendum of 2026-10-05): a host page that is no
// Environment's (the Dashboard) produces `lazurio.shell.v1` and
// `lazurio.account.v1` itself while it pins one release's library, so a
// release never removes, renames or narrows a member of either document.
// It may add members and accept what it refused before; a change that
// would break a v1 document is that document's v2 (`lazurio.shell.v2`,
// `lazurio.account.v2`), decided and announced first. This ends "changed in
// place" of the Organization-rail addendum. A host page with nobody signed in
// has a third document of its own, `lazurio.shell-signed-out.v1` (below,
// F36's addendum of 2026-10-06), under the same rule.

export const shellSchema = "lazurio.shell.v1";

/** What kind of place an Environment is (decision 0165, 0169): the Operator's
 * personal Remote Environment, an Organization's work, Team or Automated
 * Environment, or the workstation the person sits at. */
export const shellEnvironmentKinds = [
  "personal",
  "work",
  "team",
  "automated",
  "workstation",
] as const;
export type ShellEnvironmentKind = (typeof shellEnvironmentKinds)[number];

/** The apps of one Environment, each its own origin (the switch Chat · Apps ·
 * Automate): Apps is the Launchpad, always present; Chat is T3 Code and
 * Automate is MausBot, null where the Environment has none. Apps may be the
 * path `/` when it is the document's own origin (a workstation, whose loopback
 * port changes with every start). */
export type ShellApps = Readonly<{
  apps: string;
  chat: string | null;
  automate: string | null;
}>;

export type ShellEnvironment = Readonly<{
  /** Its identity, unique across Organizations (`isEnvironmentId`): a hosted
   * Environment's base host (`environmentIdOf`), a workstation's local id.
   * `current` names one of them. */
  id: string;
  /** Its own name when it has one: a Team Environment's Team, an Automated
   * Environment's persona, a workstation's computer. Null: the elements name
   * it by its kind (Pracovní, Osobní, Tento počítač). Never a hosted
   * machine's technical name. */
  label: string | null;
  kind: ShellEnvironmentKind;
  /** The slugs of `organizations` it holds, in order; empty for a personal
   * one. A workstation may hold several. */
  organizations: readonly string[];
  /** The GitHub login of the one person a work Environment is assigned to,
   * for its "who" line; null otherwise. */
  assignee: string | null;
  apps: ShellApps;
  /** The Dashboard's display name, when the account names it (F37's
   * addendum of 2026-10-04): the purpose name, with an order number for a
   * second Environment of the same Team, or an Admin's rename. Absent: the
   * elements name it by `label` or its kind. */
  name?: string;
  /** The line saying whom it serves, as the Dashboard words it; absent: the
   * elements word it from the kind and `assignee`. */
  who?: string;
  /** True when the account knows it is off. */
  offline?: boolean;
}>;

export type ShellOrganization = Readonly<{
  /** The Organization slug, as the catalog names it. */
  slug: string;
  name: string;
  /** An https URL of the GitHub Organization's avatar; null shows its
   * initials. */
  avatar: string | null;
  /** The Organization's page in the Dashboard (the head of the picker): an
   * https URL, or in `lazurio.shell.v1` a path on the page's own origin (a
   * host that is the Dashboard); always https in `lazurio.account.v1`, which
   * crosses origins. */
  dashboard: string;
}>;

export type ShellOperator = Readonly<{
  /** Up to three letters for the personal space; null shows a person icon. */
  initials: string | null;
  /** The GitHub login, when the Environment knows whose it is. */
  login: string | null;
  /** An https URL of the person's GitHub photo, for the account; null shows
   * the initials. */
  avatar: string | null;
}>;

/** The content a setup line is about: an Organization by its name and
 * GitHub login, or the person's Personalspace (with their GitHub login when
 * it is known). */
export type ShellSetupItem = Readonly<
  | { kind: "organization"; name: string; login: string }
  | { kind: "personalspace"; login: string | null }
>;

/** What the current Environment still lacks before it is usable (root
 * decision 0188, the first run): GitHub's sign-in of its person and its
 * content, the Organization or the Personalspace, as its Launchpad reads
 * them. The column head says it in Chat and Automate. Only an Environment
 * that signs in to GitHub as its person has it; the document leaves it out
 * elsewhere and whenever the Launchpad cannot tell. */
export type ShellSetup = Readonly<{
  github: "connected" | "missing";
  /** Absent: not known (no content routes here, or they could not be
   * read). `failed`: the last preparation stopped. */
  content?: "ready" | "missing" | "failed";
  /** With `content` missing: the first content not here; with `failed`:
   * the one that stopped. */
  item?: ShellSetupItem;
}>;

export type Shell = Readonly<{
  schema: typeof shellSchema;
  /** The language of the person's profile; the elements speak it. */
  locale: "cs" | "en";
  /** The id of the Environment this document is served from; null on a
   * page that belongs to no Environment (F36's addendum of 2026-10-05: a
   * host's page such as the Dashboard's). Only a host produces null; a
   * Launchpad always names its own Environment. */
  current: string | null;
  /** What the current Environment still lacks (additive in v1); absent
   * when there is nothing to say or nothing known, and always absent on a
   * page that belongs to no Environment. */
  setup?: ShellSetup;
  /** True where the current Environment keeps the offline guide on its
   * origins (decision F41, additive in v1): a node of a tailnet, never a
   * workstation. The elements register the guide's worker only with it;
   * without it they only check a worker registered before, which the
   * worker's address then retires. Absent otherwise, and always absent on a
   * page that belongs to no Environment. */
  offlineGuide?: true;
  operator: ShellOperator;
  environments: readonly ShellEnvironment[];
  organizations: readonly ShellOrganization[];
  /** The personal Dashboard (the logo at the top of the rail). The three
   * Dashboard addresses are https URLs, or paths on the page's own origin
   * (a host that is the Dashboard). */
  dashboard: string;
  /** The account settings in the Dashboard (the account at the bottom). */
  account: string;
  /** Where an Organization is added (the "+" under the Organizations); null
   * hides it. */
  addOrganization: string | null;
}>;

type Data = Readonly<Record<string, unknown>>;
const isRecord = (value: unknown): value is Data =>
  !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, max = 200): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= max &&
  ![...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  });

/** An absolute https URL without credentials or fragment. */
export function isShellUrl(value: unknown): value is string {
  if (!text(value, 512)) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.hash &&
      url.href === value
    );
  } catch {
    return false;
  }
}

/** An address of `lazurio.shell.v1`, which is always the page's own document
 * (its host provides it, or the elements read it on the page's own origin):
 * an https URL, or a path on that origin (`/…`, never `//…`, no fragment).
 * Apps takes it (a workstation's Launchpad, whose port changes with every
 * start), and since F36's addendum of 2026-10-05 so do the Dashboard's
 * addresses (`dashboard`, `account`, `addOrganization`, an Organization's
 * `dashboard`), so that a host that is the Dashboard names its own pages.
 * The signed-out document's `signIn`, also the page's own, follows the same
 * rule (F36's addendum of 2026-10-06). */
const isPageUrl = (value: unknown): value is string =>
  isShellUrl(value) ||
  (text(value, 512) &&
    /^\/(?!\/)[^\s\\]*$/.test(value) &&
    !value.includes("#"));

// The identity of an Environment entry (F37's addendum of 2026-10-04): its
// base host in lowercase DNS form. Every hosted Environment has its own
// addresses (root decision 0146): `<app>.<machine>.<org>.lazurio.io` for an
// Organization's Environment, `<app>.<personal-dns-slug>.lazurio.io` for a
// personal Remote Environment. What stands between the app label and
// `lazurio.io` is unique by DNS, so it tells two Organizations' `vm-01`
// apart, where the bare machine name repeats. The Dashboard derives the same
// value from the registry's Apps address. A workstation, which has no such
// address, keeps its local id (one label, `local`).
const hostedDomain = ".lazurio.io";
const dnsLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** A workstation's id: it has no hosted address to take one from. */
export const workstationId = "local";

/** An Environment id: one lowercase DNS label (a personal Remote
 * Environment's slug, a workstation's `local`) or two (`<machine>.<org>`). */
export function isEnvironmentId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const labels = value.split(".");
  return (
    labels.length >= 1 &&
    labels.length <= 2 &&
    labels.every((label) => dnsLabel.test(label))
  );
}

/** The id of a hosted Environment from an app origin of its own
 * (`https://<app>.<base>.lazurio.io`, with or without the trailing slash of
 * an Apps address): `<base>` in lowercase, one label for a personal Remote
 * Environment, two for an Organization's. Null for anything else: another
 * scheme, a port, credentials, a path, a query or a fragment, another
 * domain, or a base of another depth. The one place the id is derived. */
export function environmentIdOf(origin: string): string | null {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return null;
  }
  const written = origin.toLowerCase();
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    (written !== url.origin && written !== `${url.origin}/`)
  )
    return null;
  const host = url.hostname;
  if (!host.endsWith(hostedDomain)) return null;
  const labels = host.slice(0, -hostedDomain.length).split(".");
  // The app's label, then the base of one or two labels.
  if (labels.length < 2 || labels.length > 3) return null;
  if (!labels.every((label) => dnsLabel.test(label))) return null;
  const id = labels.slice(1).join(".");
  return isEnvironmentId(id) ? id : null;
}

/** Whether an entry's id is the one its Apps address gives it: an https
 * Apps address is the Environment's own, so the id is its base host
 * (`environmentIdOf`); one from which no base host derives (another
 * domain, another depth) belongs only to a workstation (`local`). Apps on
 * the document's own origin (a path) keeps any id in the DNS form. */
function identityMatches(id: string, apps: ShellApps): boolean {
  if (!isShellUrl(apps.apps)) return true;
  const hosted = environmentIdOf(apps.apps);
  return hosted === null ? id === workstationId : id === hosted;
}

/** An Organization's slug as its canonical manifest admits it (any
 * nonblank text without surrounding space), bounded here at 128 and without
 * control characters. The elements only compare slugs and encode them into
 * URLs, so no character set narrower than the manifest's is needed. */
export const isShellSlug = (value: unknown): value is string =>
  text(value, 128) && value.trim() === value;
const initials = /^[\p{Lu}\p{N}]{1,3}$/u;
const login = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const isLogin = (value: unknown): value is string =>
  typeof value === "string" && login.test(value);

function apps(value: unknown): ShellApps | null {
  if (!isRecord(value)) return null;
  const nullable = (entry: unknown) => entry === null || isShellUrl(entry);
  if (
    !isPageUrl(value.apps) ||
    !nullable(value.chat) ||
    !nullable(value.automate)
  )
    return null;
  return Object.freeze({
    apps: value.apps,
    chat: value.chat as string | null,
    automate: value.automate as string | null,
  });
}

function environment(value: unknown): ShellEnvironment | null {
  if (!isRecord(value)) return null;
  const { id, label, kind, organizations, assignee, name, who, offline } =
    value;
  const own = apps(value.apps);
  if (
    !isEnvironmentId(id) ||
    !(label === null || text(label, 128)) ||
    !(shellEnvironmentKinds as readonly unknown[]).includes(kind) ||
    !Array.isArray(organizations) ||
    !organizations.every((entry) => typeof entry === "string") ||
    !(assignee === null || isLogin(assignee)) ||
    own === null ||
    !identityMatches(id, own) ||
    // The optional members of F37's addendum: absent, or their exact shape
    // (`who` may also be null: the Dashboard's facts do not say).
    !(name === undefined || text(name, 128)) ||
    !(who === undefined || who === null || text(who, 128)) ||
    !(offline === undefined || typeof offline === "boolean")
  )
    return null;
  return Object.freeze({
    id,
    label: label as string | null,
    kind: kind as ShellEnvironmentKind,
    organizations: Object.freeze([...(organizations as string[])]),
    assignee: assignee as string | null,
    apps: own,
    ...(typeof name === "string" ? { name } : {}),
    ...(typeof who === "string" ? { who } : {}),
    ...(offline === true ? { offline } : {}),
  });
}

function organization(value: unknown): ShellOrganization | null {
  if (!isRecord(value)) return null;
  const { avatar, name, dashboard } = value;
  if (
    typeof value.slug !== "string" ||
    !isShellSlug(value.slug) ||
    !text(name, 128) ||
    !(avatar === null || isShellUrl(avatar)) ||
    // A path only in `lazurio.shell.v1`: `parseShellAccount` narrows it.
    !isPageUrl(dashboard)
  )
    return null;
  return Object.freeze({
    slug: value.slug,
    name,
    avatar: avatar as string | null,
    dashboard,
  });
}

type Entries = Readonly<{
  locale: "cs" | "en";
  operator: ShellOperator;
  environments: readonly ShellEnvironment[];
  organizations: readonly ShellOrganization[];
}>;

/** The entries both documents share (F37 point 1: one parser for
 * `lazurio.shell.v1` and `lazurio.account.v1`): `locale`, `operator`,
 * `environments` and `organizations`, each in its exact shape, Environment
 * ids unique and in the form of `isEnvironmentId` (a hosted entry's the base
 * host of its Apps address), Organization slugs unique (ignoring case) and
 * every Organization an Environment names listed. Null otherwise. */
function entries(input: Data): Entries | null {
  if (input.locale !== "cs" && input.locale !== "en") return null;
  const operator = input.operator;
  if (
    !isRecord(operator) ||
    !(
      operator.initials === null ||
      (typeof operator.initials === "string" &&
        initials.test(operator.initials))
    ) ||
    !(operator.login === null || isLogin(operator.login)) ||
    !(operator.avatar === null || isShellUrl(operator.avatar))
  )
    return null;
  if (!Array.isArray(input.environments) || !Array.isArray(input.organizations))
    return null;
  const environments = input.environments.map(environment);
  const organizations = input.organizations.map(organization);
  if (environments.some((entry) => entry === null)) return null;
  if (organizations.some((entry) => entry === null)) return null;
  const envs = environments as ShellEnvironment[];
  const orgs = organizations as ShellOrganization[];
  const slugs = new Set(orgs.map((entry) => entry.slug.toLowerCase()));
  if (slugs.size !== orgs.length) return null;
  if (new Set(envs.map((entry) => entry.id)).size !== envs.length) return null;
  if (
    envs.some((entry) =>
      entry.organizations.some((name) => !slugs.has(name.toLowerCase())),
    )
  )
    return null;
  return {
    locale: input.locale,
    operator: Object.freeze({
      initials: operator.initials as string | null,
      login: operator.login as string | null,
      avatar: operator.avatar as string | null,
    }),
    environments: Object.freeze(envs),
    organizations: Object.freeze(orgs),
  };
}

/** The `setup` member: absent or null is none (`undefined`); otherwise its
 * exact shape, or `false` for any other. */
export function parseShellSetup(
  value: unknown,
): ShellSetup | undefined | false {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) return false;
  const { github, content, item } = value;
  if (
    (github !== "connected" && github !== "missing") ||
    !(
      content === undefined ||
      content === "ready" ||
      content === "missing" ||
      content === "failed"
    )
  )
    return false;
  let read: ShellSetupItem | undefined;
  if (item !== undefined) {
    if (!isRecord(item)) return false;
    if (
      item.kind === "organization" &&
      text(item.name, 128) &&
      isLogin(item.login)
    )
      read = Object.freeze({
        kind: "organization",
        name: item.name,
        login: item.login,
      });
    else if (
      item.kind === "personalspace" &&
      (item.login === null || isLogin(item.login))
    )
      read = Object.freeze({
        kind: "personalspace",
        login: item.login as string | null,
      });
    else return false;
  }
  return Object.freeze({
    github,
    ...(content === undefined ? {} : { content }),
    ...(read === undefined ? {} : { item: read }),
  });
}

/** The shell document, when the input is a valid `lazurio.shell.v1`; null
 * otherwise. Members this version does not know are ignored (a later producer
 * may add some); every known member must have its exact shape, Environment
 * ids are in the DNS form of `isEnvironmentId` and a hosted entry's is the
 * base host of its Apps address, ids and slugs are unique,
 * `current` names an Environment or is null (explicitly: a page that
 * belongs to no Environment, with any Environments or none; absent is
 * refused), and every Organization an Environment names is listed. The
 * Dashboard's addresses are https URLs or paths on the page's own origin.
 * The optional `setup` (root decision 0188) is absent, null or in its exact
 * shape beside a current Environment, which it describes, and absent (not
 * even null) on a page that belongs to no Environment. So is the optional
 * `offlineGuide` (decision F41): absent, false or true beside a current
 * Environment, kept only when true. */
export function parseShell(input: unknown): Shell | null {
  if (!isRecord(input) || input.schema !== shellSchema) return null;
  if (!isPageUrl(input.dashboard) || !isPageUrl(input.account)) return null;
  if (!(input.addOrganization === null || isPageUrl(input.addOrganization)))
    return null;
  const shared = entries(input);
  if (shared === null) return null;
  const current = input.current;
  if (
    current !== null &&
    !shared.environments.some((entry) => entry.id === current)
  )
    return null;
  const setup = parseShellSetup(input.setup);
  // `setup` describes the current Environment, so a page that belongs to no
  // Environment carries none at all: absent, not even null.
  if (setup === false || (current === null && input.setup !== undefined))
    return null;
  const offlineGuide = input.offlineGuide;
  if (
    !(offlineGuide === undefined || typeof offlineGuide === "boolean") ||
    (current === null && offlineGuide !== undefined)
  )
    return null;
  return Object.freeze({
    schema: shellSchema,
    locale: shared.locale,
    current: current as string | null,
    ...(setup === undefined ? {} : { setup }),
    ...(offlineGuide === true ? { offlineGuide } : {}),
    operator: shared.operator,
    environments: shared.environments,
    organizations: shared.organizations,
    dashboard: input.dashboard,
    account: input.account,
    addOrganization: input.addOrganization as string | null,
  });
}

// A host page with nobody signed in (F36's addendum of 2026-10-06):
// `lazurio.shell-signed-out.v1`, a document of its own beside
// `lazurio.shell.v1`. The Dashboard serves its page to anyone; signed out it
// has no person, and `operator`, which every signed-in consumer reads, stays
// required. This document says only what the rail draws then: the language
// and where sign-in starts. An Environment never needs it, because its
// gateway signs the person in before any page is served: the Launchpad never
// produces it, and the elements' own read of `/.lazurio/shell.json` takes
// only `lazurio.shell.v1`. Additive only, as the other two documents: a
// change that would break it is its v2.

export const shellSignedOutSchema = "lazurio.shell-signed-out.v1";

export type ShellSignedOut = Readonly<{
  schema: typeof shellSignedOutSchema;
  /** The language of the page; the elements speak it. */
  locale: "cs" | "en";
  /** Where sign-in starts; the logo and the key lead there. An https URL,
   * or a path on the page's own origin (`/…`, never `//…`, no fragment), as
   * the Dashboard's addresses of `lazurio.shell.v1`. */
  signIn: string;
}>;

/** The signed-out document, when the input is a valid
 * `lazurio.shell-signed-out.v1`; null otherwise. Members this version does not
 * know are ignored (a later producer may add some); `locale` and `signIn` must
 * have their exact shape. A host without a sign-in has none to provide. */
export function parseShellSignedOut(input: unknown): ShellSignedOut | null {
  if (!isRecord(input) || input.schema !== shellSignedOutSchema) return null;
  if (input.locale !== "cs" && input.locale !== "en") return null;
  if (!isPageUrl(input.signIn)) return null;
  return Object.freeze({
    schema: shellSignedOutSchema,
    locale: input.locale,
    signIn: input.signIn,
  });
}

// The person's Lazurio account (F37 and its addendum of 2026-10-04):
// `lazurio.account.v1`, which the Dashboard answers at
// `GET /api/environment/v1/account/environments` and the Environment's
// gateway relays on its own origins as `/.lazurio/account/environments`.
// The same entries as `lazurio.shell.v1`, without `current` and without the
// Dashboard's addresses, for the person signed in at the browser: their
// spaces (Organizations from live memberships, so one without an
// Environment keeps its avatar), the Environments they may open, and the
// account-only members below.

export const accountSchema = "lazurio.account.v1";

/** The apps a visit names (`last`, `lastBySpace`). */
const visitApps = ["chat", "apps", "automate"] as const;
type VisitApp = (typeof visitApps)[number];
const isVisitApp = (value: unknown): value is VisitApp =>
  (visitApps as readonly unknown[]).includes(value);

/** Where the person was last: an Environment of `environments`, the app,
 * and the Organization slug of the space (null in the personal one). */
export type AccountLast = Readonly<{
  environment: string;
  app: VisitApp;
  organization: string | null;
}>;

/** The last visit of one space (`lastBySpace`): the Environment and the
 * app the person was in there. */
export type AccountVisit = Readonly<{ environment: string; app: VisitApp }>;

export type AccountFavourite = Readonly<{
  kind: "module" | "repository";
  /** A module id, or a production repository's name. */
  id: string;
}>;

export type ShellAccount = Readonly<{
  schema: typeof accountSchema;
  /** The language `name` and `who` are worded in. */
  locale: "cs" | "en";
  /** The person signed in at the browser. */
  operator: ShellOperator;
  /** The Environments they may open, with absolute https Apps addresses. */
  environments: readonly ShellEnvironment[];
  /** Their spaces: every Organization they are a member of. */
  organizations: readonly ShellOrganization[];
  /** The last Environment overall; null when none is known. */
  last: AccountLast | null;
  /** The last Environment per space: `personal` and Organization slugs. */
  lastBySpace: Readonly<Record<string, AccountVisit>>;
  /** Favourites by Organization slug, only for the requesting
   * Environment's Organization(s). */
  favourites: Readonly<Record<string, readonly AccountFavourite[]>>;
  preferences: Readonly<{ openApps: "tab" | "same" }>;
}>;

const accountPersonalSpace = "personal";

/** The account document, when the input is a valid `lazurio.account.v1`;
 * null otherwise, as a whole. The shared entries are read by the shell's own
 * parser (`entries`), with one narrowing: the account crosses origins (the
 * Dashboard answers it to every Environment), so an Environment's Apps
 * address and an Organization's Dashboard page are absolute https URLs,
 * never paths. The account-only members may be absent (`last` none,
 * `lastBySpace` and `favourites` empty, `openApps` `tab`); present, they
 * have their exact shape and name only listed Environments and
 * Organizations. Members this version does not know are ignored. */
export function parseShellAccount(input: unknown): ShellAccount | null {
  if (!isRecord(input) || input.schema !== accountSchema) return null;
  const shared = entries(input);
  if (shared === null) return null;
  if (
    shared.environments.some((entry) => !isShellUrl(entry.apps.apps)) ||
    shared.organizations.some((entry) => !isShellUrl(entry.dashboard))
  )
    return null;
  const ids = new Set(shared.environments.map((entry) => entry.id));
  const slugOf = new Map(
    shared.organizations.map((entry) => [entry.slug.toLowerCase(), entry.slug]),
  );
  const listedSlug = (value: unknown): value is string =>
    typeof value === "string" && slugOf.has(value.toLowerCase());

  let last: AccountLast | null = null;
  if (input.last !== undefined && input.last !== null) {
    const value = input.last;
    if (
      !isRecord(value) ||
      typeof value.environment !== "string" ||
      !ids.has(value.environment) ||
      !isVisitApp(value.app) ||
      !(value.organization === null || listedSlug(value.organization))
    )
      return null;
    last = Object.freeze({
      environment: value.environment,
      app: value.app,
      organization: value.organization as string | null,
    });
  }

  const lastBySpace: Record<string, AccountVisit> = {};
  if (input.lastBySpace !== undefined) {
    if (!isRecord(input.lastBySpace)) return null;
    for (const [space, value] of Object.entries(input.lastBySpace)) {
      if (
        !(space === accountPersonalSpace || listedSlug(space)) ||
        !isRecord(value) ||
        typeof value.environment !== "string" ||
        !ids.has(value.environment) ||
        !isVisitApp(value.app)
      )
        return null;
      lastBySpace[space] = Object.freeze({
        environment: value.environment,
        app: value.app,
      });
    }
  }

  const favourites: Record<string, readonly AccountFavourite[]> = {};
  if (input.favourites !== undefined) {
    if (!isRecord(input.favourites)) return null;
    for (const [slug, list] of Object.entries(input.favourites)) {
      if (!listedSlug(slug) || !Array.isArray(list)) return null;
      const read: AccountFavourite[] = [];
      for (const value of list) {
        if (
          !isRecord(value) ||
          (value.kind !== "module" && value.kind !== "repository") ||
          !text(value.id, 128)
        )
          return null;
        read.push(Object.freeze({ kind: value.kind, id: value.id }));
      }
      favourites[slug] = Object.freeze(read);
    }
  }

  let openApps: "tab" | "same" = "tab";
  if (input.preferences !== undefined) {
    const preferences = input.preferences;
    if (
      !isRecord(preferences) ||
      !(
        preferences.openApps === undefined ||
        preferences.openApps === "tab" ||
        preferences.openApps === "same"
      )
    )
      return null;
    if (preferences.openApps === "same") openApps = "same";
  }

  return Object.freeze({
    schema: accountSchema,
    locale: shared.locale,
    operator: shared.operator,
    environments: shared.environments,
    organizations: shared.organizations,
    last,
    lastBySpace: Object.freeze(lastBySpace),
    favourites: Object.freeze(favourites),
    preferences: Object.freeze({ openApps }),
  });
}

/** An Organization's slug as the Dashboard addresses it (its `org_slug`):
 * the manifest's slug lowercased, every run of other characters one `-`,
 * none at either end. The Dashboard derives it so from the same manifest
 * slug and matches `/orgs/<slug>` exactly, so a slug with capitals (`Acme-Co`)
 * is `acme-co` there. Null when nothing is left. The Dashboard disambiguates
 * two GitHub Organizations of one person that reduce to the same slug with a
 * suffix this Environment cannot know; that link then leads to the
 * Dashboard's own not-found page, never to another Organization's. The
 * account document names Organizations by this slug, so the shell's merge
 * compares an Environment's own slugs with the account's in this form. */
export function dashboardSlug(slug: string): string | null {
  const canonical = slug
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return canonical === "" ? null : canonical;
}

/** The Environment the document is served from; null on a page that
 * belongs to no Environment (`current: null`). */
export function currentEnvironment(shell: Shell): ShellEnvironment | null {
  if (shell.current === null) return null;
  const found = shell.environments.find((entry) => entry.id === shell.current);
  // parseShell guarantees it; a producer's document is parsed before use.
  if (found === undefined) throw new Error("No current Environment");
  return found;
}
