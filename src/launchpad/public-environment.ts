import {
  defaultSettingsSection,
  type PageRoute,
  type SettingsSection,
} from "./routes";

// A public Environment (root decision 0204 points 3, 4 and 6, decision F55):
// a work VM of the public reference Organization whose gateway admits any
// Lazurio account, without membership or a grant. Machines says so in the
// handover's `entry.audience` (Machines #560); the platform decides it,
// never the Organization's own settings. Its visitors share the Environment,
// so no one signs in to anything here: the Launchpad runs a demo onboarding
// instead of Začínáme's sign-ins, the shell's column head says the
// Environment is public and shared, and there is no Integrace, no Nastavení →
// Trezor and no Nastavení → Nástroje, whose rows sign in gh, Codex, Claude,
// Composio, Bitwarden and the other tools. Nothing here grants or refuses
// entry: the gateway's admission does. Pure and free of Node, so the page and
// the server share it.

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

/** The Settings sections a public Environment does not have: Trezor (0204
 * point 4: no vault for its visitors) and Nástroje, every row of which
 * offers a sign-in, an installation or a setup a visitor must not start. */
const withheldSections: readonly SettingsSection[] = ["tools", "vault"];

/** What a public Environment does not have (0204 point 4: no sign-in, no
 * vault and no Integrace for its visitors): every route of Integrace, of
 * Nastavení → Trezor (an agent's secret request included) and of Nastavení
 * → Nástroje. The server answers them as absent and the page shows
 * `publicRoute` in their place. */
export function withheldInPublic(route: PageRoute): boolean {
  return (
    route.view === "integrations" ||
    (route.view === "settings" && withheldSections.includes(route.section))
  );
}

/** The API of Nastavení → Nástroje (`/api/tools/…`): the tools' state, their
 * sign-ins and sign-outs (gh, Codex, Claude, Composio, wacli, neon), the
 * vault's Bitwarden and Executor's setup, installations and updates. A
 * public Environment answers all of it as absent. */
export const isToolsApiPath = (path: string): boolean =>
  path === "/api/tools" || path.startsWith("/api/tools/");

/** The route a public Environment shows for `route`: Integrace's place is the
 * Apps home, Trezor's and Nástroje's the default Settings section; every
 * other route is itself. */
export function publicRoute(route: PageRoute): PageRoute {
  if (route.view === "integrations") return { view: "home" };
  if (route.view === "settings" && withheldSections.includes(route.section))
    return { view: "settings", section: defaultSettingsSection };
  return route;
}
