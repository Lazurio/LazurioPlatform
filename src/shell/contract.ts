// The data contract of the Lazurio shell (decision F36 and its addendum of
// 2026-10-04): `lazurio.shell.v1`, the document the Launchpad serves at
// `/.lazurio/shell.json` on the Environment's origin and the elements of
// `/.lazurio/shell.js` draw. It names the Environment the page is served
// from, the other Environments the person may enter, their Organizations
// with their Dashboards, and the addresses of the apps. Today the Launchpad
// knows one Environment, its own; the Dashboard fills the others later
// through the Lazurio account, in this same shape, so the elements do not
// change. Pure: no DOM and no I/O, shared by the producer, the page and the
// elements. The producer and the elements ship in one binary and no fork
// reads it yet, so the shape changes in place, without a compatibility layer.

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
  /** Stable within the document; `current` names one of them. */
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
}>;

export type ShellOrganization = Readonly<{
  /** The Organization slug, as the catalog names it. */
  slug: string;
  name: string;
  /** An https URL of the GitHub Organization's avatar; null shows its
   * initials. */
  avatar: string | null;
  /** The Organization's page in the Dashboard (the head of the picker). */
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

export type Shell = Readonly<{
  schema: typeof shellSchema;
  /** The language of the person's profile; the elements speak it. */
  locale: "cs" | "en";
  /** The id of the Environment this document is served from. */
  current: string;
  operator: ShellOperator;
  environments: readonly ShellEnvironment[];
  organizations: readonly ShellOrganization[];
  /** The personal Dashboard (the logo at the top of the rail). */
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

/** The Apps address: an https URL, or a path on the document's own origin
 * (`/…`, never `//…`). */
const isAppsUrl = (value: unknown): value is string =>
  isShellUrl(value) ||
  (text(value, 512) &&
    /^\/(?!\/)[^\s\\]*$/.test(value) &&
    !value.includes("#"));

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
    !isAppsUrl(value.apps) ||
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
  const { id, label, kind, organizations, assignee } = value;
  const own = apps(value.apps);
  if (
    !text(id, 128) ||
    !(label === null || text(label, 128)) ||
    !(shellEnvironmentKinds as readonly unknown[]).includes(kind) ||
    !Array.isArray(organizations) ||
    !organizations.every((entry) => typeof entry === "string") ||
    !(assignee === null || isLogin(assignee)) ||
    own === null
  )
    return null;
  return Object.freeze({
    id,
    label: label as string | null,
    kind: kind as ShellEnvironmentKind,
    organizations: Object.freeze([...(organizations as string[])]),
    assignee: assignee as string | null,
    apps: own,
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
    !isShellUrl(dashboard)
  )
    return null;
  return Object.freeze({
    slug: value.slug,
    name,
    avatar: avatar as string | null,
    dashboard,
  });
}

/** The shell document, when the input is a valid `lazurio.shell.v1`; null
 * otherwise. Members this version does not know are ignored (a later producer
 * may add some); every known member must have its exact shape, ids and slugs
 * are unique, `current` names an Environment and every Organization an
 * Environment names is listed. */
export function parseShell(input: unknown): Shell | null {
  if (!isRecord(input) || input.schema !== shellSchema) return null;
  if (input.locale !== "cs" && input.locale !== "en") return null;
  if (!isShellUrl(input.dashboard) || !isShellUrl(input.account)) return null;
  if (!(input.addOrganization === null || isShellUrl(input.addOrganization)))
    return null;
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
  if (!envs.some((entry) => entry.id === input.current)) return null;
  return Object.freeze({
    schema: shellSchema,
    locale: input.locale,
    current: input.current as string,
    operator: Object.freeze({
      initials: operator.initials as string | null,
      login: operator.login as string | null,
      avatar: operator.avatar as string | null,
    }),
    environments: Object.freeze(envs),
    organizations: Object.freeze(orgs),
    dashboard: input.dashboard,
    account: input.account,
    addOrganization: input.addOrganization as string | null,
  });
}

/** The Environment the document is served from. */
export function currentEnvironment(shell: Shell): ShellEnvironment {
  const found = shell.environments.find((entry) => entry.id === shell.current);
  // parseShell guarantees it; a producer's document is parsed before use.
  if (found === undefined) throw new Error("No current Environment");
  return found;
}
