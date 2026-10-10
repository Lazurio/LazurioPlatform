import {
  deliveredSettings,
  type OrganizationSettingsValues,
} from "../organizations/organization-settings";

// Contract C2 of DEV-6653 (root decision 0194 points 3 and 4) as the
// Launchpad speaks it through the Environment's relay: the Dashboard's answer
// with the Organization's settings, and the Environment's report of what it
// applied. Exact shapes only: an answer of any other shape is never taken,
// and a report this module would not send is refused before it leaves.
// The Dashboard's side is `docs/organization-settings.md` in its repository.

export const environmentSettingsSchema = "lazurio.environment-settings.v1";
export const environmentSettingsReportSchema =
  "lazurio.environment-settings-report.v1";

/** Why an Environment stays on its last applied version, as C2 names it. */
export const reportErrors = [
  "settings_invalid",
  "dashboard_unreachable",
  "identity_unavailable",
] as const;
export type ReportError = (typeof reportErrors)[number];

/** How one setting turned out in this Environment. */
export const itemOutcomes = ["applied", "failed", "unsupported"] as const;
export type ItemOutcome = (typeof itemOutcomes)[number];

/** The answer is read only up to this size. */
export const settingsAnswerBytesMax = 64 * 1024;
/** The relay and the Dashboard take a report of at most this size. */
export const reportBytesMax = 4 * 1024;

/** A full commit id (40 or 64 lowercase hex), as GitHub names one. */
export const isCommitId = (value: unknown): value is string =>
  typeof value === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);

/** A version of C2: the commit of the Organization root's `main`, or `none`
 * for an Environment no Organization governs. */
export const isSettingsVersion = (value: unknown): value is string =>
  value === "none" || isCommitId(value);

const githubLogin = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const itemKey = /^[a-z][a-z0-9_]{0,63}(?:\.[a-z][a-z0-9_]{0,63}){0,7}$/;
const detailCode = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const platformVersion = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;
const rfc3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

/** A short code for an item's detail or a local reason. */
export const isDetailCode = (value: unknown): value is string =>
  typeof value === "string" && detailCode.test(value);

/** A setting's dotted key, as a report item names it. */
export const isSettingKey = (value: unknown): value is string =>
  typeof value === "string" && value.length <= 128 && itemKey.test(value);

/** What one answer of the Dashboard delivered to this Environment. */
export type DeliveredSettings = Readonly<{
  /** The Organization the Dashboard selected by the Environment's token;
   * null for an Environment no Organization governs. */
  organization: Readonly<{ githubOrgId: number; login: string }> | null;
  version: string;
  /** Exactly the known settings the answer carries. */
  values: OrganizationSettingsValues;
  /** The keys of settings this release does not know. */
  unsupported: readonly string[];
}>;

function plain(input: unknown): Readonly<Record<string, unknown>> | null {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    return null;
  const prototype = Object.getPrototypeOf(input);
  return prototype === Object.prototype || prototype === null
    ? (input as Readonly<Record<string, unknown>>)
    : null;
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && own.every((key) => keys.includes(key));
}

/** The 200 answer of `GET /organization/settings`, exactly as C2 gives it,
 * or null. */
export function parseSettingsAnswer(input: unknown): DeliveredSettings | null {
  const value = plain(input);
  if (
    value === null ||
    !exactKeys(value, ["schema_version", "organization", "version", "settings"])
  )
    return null;
  if (value.schema_version !== environmentSettingsSchema) return null;
  let organization: DeliveredSettings["organization"] = null;
  if (value.organization !== null) {
    const named = plain(value.organization);
    if (
      named === null ||
      !exactKeys(named, ["github_org_id", "login"]) ||
      typeof named.github_org_id !== "number" ||
      !Number.isSafeInteger(named.github_org_id) ||
      named.github_org_id < 1 ||
      typeof named.login !== "string" ||
      !githubLogin.test(named.login)
    )
      return null;
    organization = Object.freeze({
      githubOrgId: named.github_org_id,
      login: named.login,
    });
  }
  // An Organization's answer names a commit; without one there is no
  // version and nothing to govern.
  if (organization === null) {
    if (value.version !== "none") return null;
  } else if (!isCommitId(value.version)) return null;
  const settings = deliveredSettings(value.settings);
  if (settings === null) return null;
  if (
    organization === null &&
    (Object.keys(settings.values).length > 0 || settings.unsupported.length > 0)
  )
    return null;
  return Object.freeze({
    organization,
    version: value.version as string,
    values: settings.values,
    unsupported: settings.unsupported,
  });
}

/** The `error` code of a refusal (`{"error": "<code>", ...}`), or null. */
export function errorCode(input: unknown): string | null {
  const value = plain(input);
  return value !== null &&
    typeof value.error === "string" &&
    /^[a-z][a-z0-9_]{0,63}$/.test(value.error)
    ? value.error
    : null;
}

export type SettingsItem = Readonly<{
  /** The setting's dotted key, `integrations.composio.allowed`. */
  key: string;
  outcome: ItemOutcome;
  /** A short code this Environment chose; null when it has none. */
  detail: string | null;
}>;

/** What the Environment reports (C2 `POST …/settings/report`). */
export type SettingsReport = Readonly<{
  /** The applied version, `none`, or null when nothing was ever applied. */
  version: string | null;
  /** When it was applied (RFC 3339, UTC); null when never. */
  appliedAt: string | null;
  lastError: ReportError | null;
  items: readonly SettingsItem[];
  /** The Lazurio Platform release this Environment runs. */
  platformVersion: string;
}>;

function item(input: SettingsItem): SettingsItem {
  if (
    !isSettingKey(input.key) ||
    !(itemOutcomes as readonly string[]).includes(input.outcome) ||
    (input.detail !== null && !isDetailCode(input.detail))
  )
    throw new Error("Invalid settings report item");
  return { key: input.key, outcome: input.outcome, detail: input.detail };
}

/** The report's JSON body in C2's exact shape, at most 4 KiB: when the items
 * do not fit, the `unsupported` ones give way first, from the last. Throws on
 * anything C2 would refuse. */
export function reportBody(report: SettingsReport): string {
  if (report.version !== null && !isSettingsVersion(report.version))
    throw new Error("Invalid settings report version");
  if (
    report.appliedAt !== null &&
    (!rfc3339.test(report.appliedAt) ||
      !Number.isFinite(Date.parse(report.appliedAt)))
  )
    throw new Error("Invalid settings report time");
  if (
    report.lastError !== null &&
    !(reportErrors as readonly string[]).includes(report.lastError)
  )
    throw new Error("Invalid settings report error");
  if (!platformVersion.test(report.platformVersion))
    throw new Error("Invalid settings report platform version");
  const items = report.items.map(item);
  const keys = new Set(items.map((entry) => entry.key));
  if (keys.size !== items.length)
    throw new Error("Duplicate settings report item");
  const body = (kept: readonly SettingsItem[]) =>
    JSON.stringify({
      schema_version: environmentSettingsReportSchema,
      version: report.version,
      applied_at: report.appliedAt,
      last_error: report.lastError,
      items: kept,
      platform_version: report.platformVersion,
    });
  const applied = items.filter((entry) => entry.outcome !== "unsupported");
  const unsupported = items.filter((entry) => entry.outcome === "unsupported");
  for (let count = unsupported.length; count >= 0; count -= 1) {
    const text = body([...applied, ...unsupported.slice(0, count)]);
    if (Buffer.byteLength(text) <= reportBytesMax) return text;
  }
  throw new Error("Settings report too large");
}
