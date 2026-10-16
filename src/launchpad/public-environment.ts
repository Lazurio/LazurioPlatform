import { defaultSettingsSection, type PageRoute } from "./routes";

// A public Environment (root decision 0204 points 3, 4 and 6, decision F55):
// a work VM of the public reference Organization whose gateway admits any
// Lazurio account, without membership or a grant. Machines says so in the
// handover's `entry.audience` (Machines #560); the platform decides it,
// never the Organization's own settings. Its visitors share the Environment,
// so no one signs in to anything here: the Launchpad runs a demo onboarding
// instead of Začínáme's sign-ins, the shell's column head says the
// Environment is public and shared, and there is no Integrace and no
// Nastavení → Trezor. Nothing here grants or refuses entry: the gateway's
// admission does. Pure and free of Node, so the page and the server share it.

/** Who may enter, by the wire schema's rule: only `public`. Absent is every
 * other Environment. */
export type EntryAudience = "public";
export const isEntryAudience = (value: unknown): value is EntryAudience =>
  value === "public";

/** Whether a recorded entry (the binding's, or its public parts the page
 * reads) is a public Environment's. No entry (a workstation) is not. */
export function isPublicEnvironment(
  entry: Readonly<{ audience?: EntryAudience }> | null | undefined,
): boolean {
  return entry?.audience === "public";
}

/** What a public Environment does not have (0204 point 4: no vault and no
 * Integrace for its visitors): every route of Integrace and of Nastavení →
 * Trezor, an agent's secret request included. The server answers them as
 * absent and the page shows `publicRoute` in their place. */
export function withheldInPublic(route: PageRoute): boolean {
  return (
    route.view === "integrations" ||
    (route.view === "settings" && route.section === "vault")
  );
}

/** The route a public Environment shows for `route`: Integrace's place is the
 * Apps home, Trezor's the default Settings section; every other route is
 * itself. */
export function publicRoute(route: PageRoute): PageRoute {
  if (route.view === "integrations") return { view: "home" };
  if (route.view === "settings" && route.section === "vault")
    return { view: "settings", section: defaultSettingsSection };
  return route;
}
