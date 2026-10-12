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
      : `codex-${env.CODEX_THREAD_ID}`,
    env.CLAUDE_CODE_SESSION_ID === undefined
      ? undefined
      : `claude-${env.CLAUDE_CODE_SESSION_ID}`,
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

/** The hold one holder file records, or null when the file is not one: its
 * name is `<strip>.json` and its `strip` that strip, and only target ids
 * count, in upper case and once each, at most 500. The label is trimmed and
 * cut at 200 characters; a file of more than 64 Ki characters is none. */
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

/** The text of a holder file that also keeps each tab's record time,
 * `recordedAt`, by its id: the hub ignores it, and only the app that writes
 * the file reads it back (`parseHolderRecords`), so its reconciliation
 * survives a restart. A tab without a time has no entry. */
export function holderFileText(
  strip: string,
  label: string,
  tabs: readonly RecordedTab[],
): string {
  const recordedAt: Record<string, BootTime> = {};
  for (const tab of tabs)
    if (tab.recordedAt !== null)
      recordedAt[tab.id] = { boot: tab.recordedAt.boot, at: tab.recordedAt.at };
  return `${JSON.stringify({
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

/** One snapshot of the browser's page targets: `takenAt` is the boot-clock
 * time the hub began it, before it asked the browser. */
export type LiveTabs = Readonly<{ tabs: readonly string[]; takenAt: BootTime }>;

/** The list a reader finds, its ids in upper case, or null when the file is
 * not one: every id a target id and the time a boot-clock time. */
export function parseLiveTabs(text: string): LiveTabs | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
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
