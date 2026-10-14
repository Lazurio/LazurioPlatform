import { createHash } from "node:crypto";
import type { PresetName } from "../folder/presets";
import { organizationGoverns } from "../organization-settings/governance";
import type {
  Microsoft365Setting,
  OrganizationSettingsValues,
} from "../organizations/organization-settings";

export {
  microsoft365Card,
  microsoft365CardId,
  microsoft365ReplacedApps,
} from "./microsoft365-card";

// The Organization's Microsoft 365 company app (DEV-6626 task 685, decision
// F42 addendum (c) of 2026-10-14, root decision 0162 point 5), as simple as
// the Organization Admin decided it: one card "Microsoft 365", one Microsoft
// sign-in per account, several accounts side by side, "Odpojit" the only
// disconnect. In the Environment's Executor it is ONE OpenAPI integration
// (`m365`) built from Microsoft Graph's curated specs of the apps the
// Organization turns on, signed in with the app the Organization registered
// in its own tenant: a public client, no secret, PKCE only. What this
// release pins is here and nowhere else: the specs by commit and SHA-256,
// the delegated scopes of each part, the integration and its client.

/** The specs come from Executor's curated catalog (integrations.sh), whose
 * source is this public repository, pinned by commit; the Launchpad checks
 * the SHA-256 of every file it downloads. */
export const microsoft365SpecSource = Object.freeze({
  repository: "UsefulSoftwareCo/integrations",
  commit: "9b7117ce36e9b0a8ec86a51bd40fb380d861fe06",
});

const specUrl = (file: string) =>
  `https://raw.githubusercontent.com/${microsoft365SpecSource.repository}/${microsoft365SpecSource.commit}/public/specs/microsoft-graph/${file}`;

/** The scopes of the sign-in itself: the ID token (whose email names the
 * account), the refresh token and the person's own profile. */
export const microsoft365SignInScopes = Object.freeze([
  "openid",
  "profile",
  "email",
  "offline_access",
  "User.Read",
]);

/** One pinned Graph spec and the delegated scopes its operations need,
 * least privilege (design 4.7). */
export type Microsoft365Part = Readonly<{
  key: string;
  url: string;
  sha256: string;
  scopes: readonly string[];
}>;

const part = (
  key: string,
  file: string,
  sha256: string,
  scopes: readonly string[],
): Microsoft365Part =>
  Object.freeze({
    key,
    url: specUrl(file),
    sha256,
    scopes: Object.freeze([...scopes]),
  });

/** The four parts. Mail is read and drafted (`Mail.ReadWrite`), never sent:
 * `Mail.Send` and `MailboxSettings.ReadWrite`, which the curated mail spec
 * declares, are not asked for. */
export const microsoft365Parts = Object.freeze({
  mail: part(
    "mail",
    "mail.json",
    "fe66b9a7ea6572077a996bc959a8617b7599369ae54f2b02f926490c4edee62a",
    ["Mail.ReadWrite"],
  ),
  calendar: part(
    "calendar",
    "calendar.json",
    "7d665dbb02ce07b8a2fd1e13880f2538e807e078a613fecb80e975357b8cea31",
    ["Calendars.ReadWrite"],
  ),
  files: part(
    "files",
    "files.json",
    "0e9364c576e5ae336fd14b82b23401dc1ecde2daf53ac6ded2574069707e504a",
    ["Files.ReadWrite.All"],
  ),
  sites: part(
    "sites",
    "sites.json",
    "3f0400cd5bdee8f826d28d3d310309382f611d3af6a5dd4961be39563e116394",
    ["Sites.Read.All"],
  ),
});

/** Which parts each app of the setting brings: Outlook its mail and
 * calendar, OneDrive the files, SharePoint its sites and the files (whose
 * drive-item operations walk a library's folders). */
export const microsoft365AppParts: Readonly<
  Record<string, readonly Microsoft365Part[]>
> = Object.freeze({
  outlook: [microsoft365Parts.mail, microsoft365Parts.calendar],
  one_drive: [microsoft365Parts.files],
  share_point: [microsoft365Parts.sites, microsoft365Parts.files],
});

/** The parts of the apps the setting turns on, each once, in a fixed
 * order, so the same apps always make the same document. */
export function microsoft365PartsOf(
  apps: readonly string[],
): readonly Microsoft365Part[] {
  const wanted = new Set(
    apps.flatMap((app) =>
      (Object.hasOwn(microsoft365AppParts, app)
        ? (microsoft365AppParts[app] ?? [])
        : []
      ).map((item) => item.key),
    ),
  );
  return Object.values(microsoft365Parts).filter((item) =>
    wanted.has(item.key),
  );
}

/** The scopes one sign-in asks for: the sign-in's and the union of the
 * parts', in order and once. */
export function microsoft365Scopes(
  parts: readonly Microsoft365Part[],
): readonly string[] {
  return Object.freeze([
    ...new Set([
      ...microsoft365SignInScopes,
      ...parts.flatMap((p) => p.scopes),
    ]),
  ]);
}

/** The identity of the document these parts make: the merge's version and
 * the pinned bytes of every part. Kept in the integration's description, so
 * applying again builds nothing while it matches. */
export function microsoft365SpecId(parts: readonly Microsoft365Part[]): string {
  return createHash("sha256")
    .update(
      JSON.stringify(["lazurio.m365.spec.v1", parts.map((p) => p.sha256)]),
    )
    .digest("hex")
    .slice(0, 16);
}

/** The one Executor integration, its OAuth client (owned by the
 * Environment) and the auth template every sign-in uses. */
export { microsoft365Slug } from "./microsoft365-card";
export const microsoft365Client = "microsoft365";
export const microsoft365Template = "microsoft365";

/** The authorization and token endpoints of the Organization's tenant: a
 * single-tenant app is reached through its tenant, never `common`. */
export function microsoft365Endpoints(tenantId: string): Readonly<{
  authorizationUrl: string;
  tokenUrl: string;
}> {
  const tenant = encodeURIComponent(tenantId.toLowerCase());
  return Object.freeze({
    authorizationUrl: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`,
    tokenUrl: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
  });
}

/** The auth template of the integration in the tenant: one sign-in asks for
 * every enabled part's scopes. */
export function microsoft365AuthTemplate(
  parts: readonly Microsoft365Part[],
  tenantId: string,
) {
  return Object.freeze({
    slug: microsoft365Template,
    kind: "oauth2" as const,
    label: "Microsoft 365",
    ...microsoft365Endpoints(tenantId),
    resource: null,
    scopes: microsoft365Scopes(parts),
  });
}

/** The company app on this Environment: any Environment of an Organization
 * that set it up (a personal Environment and the person's own computer have
 * none, root decision 0194 point 5). */
export type Microsoft365Here = Readonly<{
  setting: Microsoft365Setting;
  parts: readonly Microsoft365Part[];
}>;

export function microsoft365Here(
  preset: PresetName,
  settings: OrganizationSettingsValues,
): Microsoft365Here | null {
  if (!organizationGoverns(preset)) return null;
  const setting = settings.integrations?.microsoft365;
  if (setting === undefined) return null;
  return Object.freeze({ setting, parts: microsoft365PartsOf(setting.apps) });
}

/** Whether Microsoft returns a sign-in to this Launchpad's own callback:
 * only where the Organization registered it (the setting's `callbacks`, the
 * projection of the redirect addresses registered at Microsoft); otherwise
 * Entra shows an error page and never returns, so the sign-in goes to
 * Executor's callback on localhost in the Environment browser. */
export function microsoft365Registered(
  setting: Microsoft365Setting,
  callback: string | null,
): boolean {
  return callback !== null && setting.callbacks.includes(callback);
}
