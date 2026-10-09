import { isSettingKey, isSettingsVersion } from "./contract";

// How this Environment's Organization settings were delivered and applied
// last (decision F45), for the details of Settings → Tools: where they come
// from, the version applied, when, when the source last answered, and why
// the last question brought no new version. Not secret, never authority:
// the Folder's recorded settings are what applies.

export const settingsSources = ["dashboard", "repository"] as const;
export type SettingsSource = (typeof settingsSources)[number];

export const statusErrors = [
  /** The Organization's settings break the contract at the current version. */
  "settings_invalid",
  /** The relay or the Dashboard gave no usable answer. */
  "dashboard_unreachable",
  /** The relay has no token, or the Dashboard refused this Environment. */
  "identity_unavailable",
  /** The Organization's repository in this Folder could not be read. */
  "repository_unavailable",
  /** The record of the last applied version could not be read. */
  "state_unreadable",
] as const;
export type StatusError = (typeof statusErrors)[number];

export type OrganizationSettingsStatus = Readonly<{
  source: SettingsSource;
  /** The version applied last: a commit, `none`, or null when nothing was
   * applied yet. */
  version: string | null;
  /** When it was applied (RFC 3339). */
  appliedAt: string | null;
  /** When the source last answered (200, 304 or 409). */
  checkedAt: string | null;
  error: StatusError | null;
  /** The keys of settings that did not apply (failed or unsupported). */
  unapplied: readonly string[];
}>;

const time = (value: unknown) =>
  value === null ||
  (typeof value === "string" &&
    value.length <= 40 &&
    Number.isFinite(Date.parse(value)));

/** The status in its exact form, or null; for the page, which takes nothing
 * it does not understand. */
export function parseSettingsStatus(
  input: unknown,
): OrganizationSettingsStatus | null {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    return null;
  const value = input as Record<string, unknown>;
  const keys = Object.keys(value).sort().join(",");
  if (keys !== "appliedAt,checkedAt,error,source,unapplied,version")
    return null;
  if (
    !(settingsSources as readonly unknown[]).includes(value.source) ||
    (value.version !== null && !isSettingsVersion(value.version)) ||
    !time(value.appliedAt) ||
    !time(value.checkedAt) ||
    (value.error !== null &&
      !(statusErrors as readonly unknown[]).includes(value.error)) ||
    !Array.isArray(value.unapplied) ||
    value.unapplied.length > 64 ||
    !value.unapplied.every(isSettingKey)
  )
    return null;
  return Object.freeze({
    source: value.source as SettingsSource,
    version: value.version as string | null,
    appliedAt: value.appliedAt as string | null,
    checkedAt: value.checkedAt as string | null,
    error: value.error as StatusError | null,
    unapplied: Object.freeze([...(value.unapplied as string[])]),
  });
}
