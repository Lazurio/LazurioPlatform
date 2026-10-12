// The Environment browser's contract, its pure part (decision F50): the one
// definition of the rules shared by the programs that meet in the
// Environment browser. The view's hub and its service, the view page, the
// Launchpad, the `lazurio browser` CLI and the shell take them from here, and
// the forks (T3 Code, Lazurio MausBot) take this module from the attested
// shell artifact.
//
// Pure: no I/O, no DOM and no runtime built-ins but the standard `URL`, so it
// runs in a page, in Node and in Bun. `node.ts` is the part that needs the
// file system, processes and sockets. Within v1 the contract only grows (F50
// point 3): a release may add members, values and cases and accept what it
// refused before; it never removes, renames or narrows anything. The module's
// directory holds nothing from outside it (F50 point 6).

// ---- Remote tabs (C1) --------------------------------------------------------

const targetIdPattern = /^[0-9A-Fa-f]{32}$/;

/** A remote tab's id (F39 point 1): a DevTools target id, 32 hexadecimal
 * digits. Chrome and the Platform write it in upper case; a reader takes it
 * in either case and keeps its upper-case form (`targetIdOf`). */
export function isTargetId(value: unknown): value is string {
  return typeof value === "string" && targetIdPattern.test(value);
}

/** A remote tab's id in upper case, as Chrome writes it; null for anything
 * that is no target id. */
export function targetIdOf(value: unknown): string | null {
  return isTargetId(value) ? value.toUpperCase() : null;
}

// ---- Strips and sessions (C2) ------------------------------------------------

const stripPattern = /^[A-Za-z0-9_-]{1,64}$/;

/** A strip's name (F47 point 4), which is also its holder file's name
 * without `.json` and an agent-browser session's name: `[A-Za-z0-9_-]`, at
 * most 64 characters. It is Lazurio's deliberate subset of the names
 * agent-browser accepts, which may be longer and hold other characters (F50
 * point 2): the hub counts no binding of a session outside it. */
export function isStrip(value: unknown): value is string {
  return typeof value === "string" && stripPattern.test(value);
}

/** The Launchpad's one strip (F47 point 4). */
export const launchpadStrip = "launchpad";

/** The prefix of every other app's strips and sessions (F50 point 2): a T3
 * Code thread's `t3-<thread>`, a Codex thread's `codex-<CODEX_THREAD_ID>`, a
 * Claude Code session's `claude-<CLAUDE_CODE_SESSION_ID>`, and `bot-`,
 * reserved for Lazurio MausBot's bots. The overview and the strips name an
 * app by them, and an app writes and removes only the holder files of its
 * own prefix; the Launchpad only `launchpad.json`. */
export const stripPrefixes = Object.freeze({
  t3code: "t3-",
  codex: "codex-",
  claude: "claude-",
  mausbot: "bot-",
});

/** An app that names strips or agent-browser sessions. */
export type StripApp = "launchpad" | keyof typeof stripPrefixes;

const prefixedApps = Object.keys(stripPrefixes) as readonly Exclude<
  StripApp,
  "launchpad"
>[];

/** The app a strip's or a session's name belongs to; null for a name of no
 * app (a session named by hand) and for anything that is no strip's name. */
export function stripAppOf(name: unknown): StripApp | null {
  if (!isStrip(name)) return null;
  if (name === launchpadStrip) return "launchpad";
  return (
    prefixedApps.find((app) => name.startsWith(stripPrefixes[app])) ?? null
  );
}

/** The agent-browser session of the calling thread: the name given on
 * purpose, used as given or refused; otherwise the one its harness gives it,
 * every character outside the alphabet a `-` and cut at 64. T3 Code sets
 * `AGENT_BROWSER_SESSION` per thread; Codex exports `CODEX_THREAD_ID` and
 * Claude Code `CLAUDE_CODE_SESSION_ID` to the commands of a thread. Null
 * when there is none. */
export function threadSession(
  named: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
): string | null {
  const candidates = [
    named,
    env.AGENT_BROWSER_SESSION,
    env.CODEX_THREAD_ID === undefined
      ? undefined
      : `${stripPrefixes.codex}${env.CODEX_THREAD_ID}`,
    env.CLAUDE_CODE_SESSION_ID === undefined
      ? undefined
      : `${stripPrefixes.claude}${env.CLAUDE_CODE_SESSION_ID}`,
  ];
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === "") continue;
    // A name given on purpose is used as given or refused.
    if (candidate === named) return isStrip(named) ? named : null;
    const sanitized = candidate.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 64);
    if (isStrip(sanitized)) return sanitized;
  }
  return null;
}

// ---- Environments and the addresses of their views (C3) ---------------------

// The identity of an Environment (F37's addendum of 2026-10-04): its base
// host in lowercase DNS form. Every hosted Environment has its own addresses
// (root decision 0146): `<app>.<machine>.<org>.lazurio.io` for an
// Organization's Environment, `<app>.<personal-dns-slug>.lazurio.io` for a
// personal Remote Environment. What stands between the app label and
// `lazurio.io` is unique by DNS, so it tells two Organizations' `vm-01`
// apart, where the bare machine name repeats. The Dashboard derives the same
// value from the registry's Apps address. A workstation, which has no such
// address, keeps its local id (one label, `local`). `src/shell/contract.ts`
// passes both functions on to the shell's documents.
const hostedDomain = ".lazurio.io";
const dnsLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

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

/** The label the gateway routes an Environment browser's view under
 * (decisions F38 and F39): `https://browser.<base>.lazurio.io`. */
const viewLabel = "browser";
const viewPathPattern = /^\/t\/([0-9A-F]{32})$/;
/** Far longer than any view address, whose base has at most two labels. */
const maxViewLength = 512;

/** The view of one remote tab, `<origin>/t/<id>`, or of a new one,
 * `<origin>/` (F39 point 1), `origin` being the view's and the id written as
 * given: Chrome's, in upper case. Neither carries a token: the gateway's
 * session is the only admission (F39 point 8). */
export function browserViewUrl(
  origin: string,
  targetId: string | null,
): string {
  return targetId === null ? `${origin}/` : `${origin}/t/${targetId}`;
}

/** The remote tab a path of the view shows: `/t/<id>`, the id in upper case
 * as the view serves it; null for any other path. */
export function viewPathTab(path: string): string | null {
  return viewPathPattern.exec(path)?.[1] ?? null;
}

/** A view address as `viewAddressOf` reads it. */
export type ViewAddress = Readonly<{
  /** The address, as written. */
  view: string;
  /** The view's origin, `https://browser.<base>.lazurio.io`. */
  origin: string;
  /** The Environment whose view it is, `<base>` (`environmentIdOf`). */
  environment: string;
  /** The remote tab it shows; null for the bare origin, which opens a new
   * one. */
  tab: string | null;
}>;

/** The view address `value` is (F50 point 2), exactly as written:
 * `https://browser.<base>.lazurio.io/t/<id>`, one remote tab, or the bare
 * origin, with or without its `/`, which opens a new one. `<base>` is an id
 * `environmentIdOf` gives, the host is in lower case and the id in upper
 * case, as Chrome writes it; no port, no credentials, no query or fragment
 * (not even an empty one) and no slash after the id. A link is a tab only in
 * this form, on every Lazurio surface alike. Null for anything else. */
export function viewAddressOf(value: unknown): ViewAddress | null {
  if (typeof value !== "string" || value.length > maxViewLength) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const environment = environmentIdOf(url.origin);
  if (
    environment === null ||
    url.hostname !== `${viewLabel}.${environment}${hostedDomain}` ||
    url.username !== "" ||
    url.password !== ""
  )
    return null;
  const origin = url.origin;
  if (value === origin || value === `${origin}/`)
    return Object.freeze({ view: value, origin, environment, tab: null });
  const tab =
    value === `${origin}${url.pathname}` ? viewPathTab(url.pathname) : null;
  return tab === null
    ? null
    : Object.freeze({ view: value, origin, environment, tab });
}

/** Whether a host is where the gateway routes the views of Environment
 * browsers: `browser.` and a name in `lazurio.io`, an Environment's or not.
 * No Lazurio surface loads an address on such a host in the Environment
 * browser (F50 point 2): a view address opens as its tab, a new tab or
 * another Environment's, and any other address there is refused. The browser
 * itself stays unrestricted. */
export function isViewHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host.startsWith(`${viewLabel}.`) && host.endsWith(hostedDomain);
}

// ---- The boot clock (C4) -----------------------------------------------------

/** A time on the Environment's boot clock (F47 point 4): the boot's id and
 * the seconds since it. Unlike the wall clock it never steps back, and every
 * process of the Environment reads the same one, so it orders an app's record
 * against the hub's snapshot. */
export type BootTime = Readonly<{ boot: string; at: number }>;

const bootIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A boot-clock time as it is stored, or null when the value is not one. */
export function parseBootTime(value: unknown): BootTime | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  return typeof record.boot === "string" &&
    bootIdPattern.test(record.boot) &&
    typeof record.at === "number" &&
    Number.isFinite(record.at) &&
    record.at >= 0
    ? { boot: record.boot, at: record.at }
    : null;
}

// ---- Holder files (C5) -------------------------------------------------------

/** The `schema` of every holder file this module writes (F50 point 3). A
 * file without one is v1, written before the module; a file of another major
 * is one this module cannot read. */
export const holderSchema = "lazurio.browser-holder.v1";

// What the hub reads of a holder file at most (F47 point 4); every app keeps
// its own bound below it (F50 point 2).
const maxHolderCharacters = 64 * 1024;
const maxTabsPerHolder = 500;
const maxLabelLength = 200;

/** What one holder file holds. */
export type HolderReading = Readonly<{
  strip: string;
  label: string;
  tabs: readonly string[];
}>;

/** A stored tab of an app with the boot-clock time it recorded the tab, or
 * null for a tab without one, which counts as recorded long ago (F47 point
 * 4). */
export type RecordedTab = Readonly<{ id: string; recordedAt: BootTime | null }>;

/** The hold one holder file records, or null when the file is not one this
 * module can read: its name is `<strip>.json`, its `strip` that strip and
 * its `schema` absent or `holderSchema`, and only target ids count, in upper
 * case and once each, at most 500. The label is trimmed and cut at 200
 * characters; a file of more than 64 Ki characters is none. Members it does
 * not know are ignored, the writer's `contract` and `recordedAt` too. */
export function parseHolder(
  fileName: string,
  text: string,
): HolderReading | null {
  if (!fileName.endsWith(".json")) return null;
  const name = fileName.slice(0, -".json".length);
  if (!isStrip(name) || text.length > maxHolderCharacters) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record.schema !== undefined && record.schema !== holderSchema)
    return null;
  if (record.strip !== name || !Array.isArray(record.tabs)) return null;
  const label =
    typeof record.label === "string"
      ? record.label.trim().slice(0, maxLabelLength)
      : "";
  const tabs = [
    ...new Set(
      record.tabs.flatMap((id: unknown) => {
        const tab = targetIdOf(id);
        return tab === null ? [] : [tab];
      }),
    ),
  ].slice(0, maxTabsPerHolder);
  return { strip: name, label, tabs };
}

/** The text of a holder file (F47 point 4, F50 point 3): its `schema`, the
 * Platform release this module came from (`contract`, which doctor reads and
 * the hub ignores), the strip, its label, its tabs, and each tab's record
 * time, `recordedAt`, by its id. The hub ignores the times too: only the app
 * that writes the file reads them back (`parseHolderRecords`), so its
 * reconciliation survives a restart. A tab without a time has no entry. */
export function holderFileText(
  strip: string,
  label: string,
  tabs: readonly RecordedTab[],
  contract: string,
): string {
  const recordedAt: Record<string, BootTime> = {};
  for (const tab of tabs)
    if (tab.recordedAt !== null)
      recordedAt[tab.id] = { boot: tab.recordedAt.boot, at: tab.recordedAt.at };
  return `${JSON.stringify({
    schema: holderSchema,
    contract,
    strip,
    label,
    tabs: tabs.map((tab) => tab.id),
    recordedAt,
  })}\n`;
}

/** A holder file with the record time of each of its tabs, or null when the
 * file is not a holder file (`parseHolder`'s rules). A tab whose time is
 * missing or not a boot-clock time has null. */
export function parseHolderRecords(
  fileName: string,
  text: string,
): Readonly<{
  strip: string;
  label: string;
  tabs: readonly RecordedTab[];
}> | null {
  const hold = parseHolder(fileName, text);
  if (hold === null) return null;
  const times = new Map<string, BootTime>();
  const stored = (JSON.parse(text) as Record<string, unknown>).recordedAt;
  if (typeof stored === "object" && stored !== null && !Array.isArray(stored))
    for (const [id, value] of Object.entries(stored)) {
      const tab = targetIdOf(id);
      const at = parseBootTime(value);
      if (tab !== null && at !== null) times.set(tab, at);
    }
  return {
    strip: hold.strip,
    label: hold.label,
    tabs: hold.tabs.map((id) => ({ id, recordedAt: times.get(id) ?? null })),
  };
}

// ---- The list of live tabs (C6) ----------------------------------------------

/** The `schema` of the hub's list of live tabs (F50 point 3); a list without
 * one is v1, and one of another major is no list. */
export const liveTabsSchema = "lazurio.browser-tabs.v1";

/** One snapshot of the browser's page targets: `takenAt` is the boot-clock
 * time the hub began it, before it asked the browser. */
export type LiveTabs = Readonly<{ tabs: readonly string[]; takenAt: BootTime }>;

/** The text of `tabs.json`, the hub's list that every app reconciles its
 * holds with (F47 point 4). */
export function liveTabsText(
  tabs: readonly string[],
  takenAt: BootTime,
): string {
  return `${JSON.stringify({ schema: liveTabsSchema, tabs, takenAt })}\n`;
}

/** The list a reader finds, its ids in upper case, or null when the file is
 * not one: every id a target id, the time a boot-clock time and the `schema`
 * absent or `liveTabsSchema`. Members it does not know are ignored. */
export function parseLiveTabs(text: string): LiveTabs | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record.schema !== undefined && record.schema !== liveTabsSchema)
    return null;
  const takenAt = parseBootTime(record.takenAt);
  if (!Array.isArray(record.tabs) || takenAt === null) return null;
  if (!record.tabs.every(isTargetId)) return null;
  return {
    tabs: record.tabs.map((id) => (id as string).toUpperCase()),
    takenAt,
  };
}

/** An app's reconciliation (F47 point 4): the ids it keeps from its stored
 * ones, `boot` being the current boot. A list of another boot is ignored.
 * An id the list lacks goes when the list was taken after the app recorded
 * it: a snapshot lists every target that exists when it begins, so such an
 * id had ended by then, while a tab recorded after the snapshot began stays.
 * A record from an earlier boot, or without a time, is older than every list
 * of this boot. Without a list, or without the boot clock, it keeps
 * everything. */
export function keptTabs(
  stored: readonly RecordedTab[],
  list: LiveTabs | null,
  boot: string | null,
): string[] {
  if (list === null || boot === null || list.takenAt.boot !== boot)
    return stored.map((tab) => tab.id);
  const live = new Set(list.tabs);
  return stored
    .filter(
      (tab) =>
        live.has(tab.id.toUpperCase()) ||
        (tab.recordedAt !== null &&
          tab.recordedAt.boot === boot &&
          tab.recordedAt.at >= list.takenAt.at),
    )
    .map((tab) => tab.id);
}
