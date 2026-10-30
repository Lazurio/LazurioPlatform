// Whether this Environment may connect apps through Composio (root decision
// 0162, addendum of 2026-10-09, point 4): on a work, Team or Automated
// Environment its Organization decides in the Organization settings (root
// decision 0194), on a personal Environment the person. The Integrace page,
// the path rule and the Folder read this seam only; nothing else decides it.
//
// The Organization's setting reaches the Environment through the Launchpad
// (decision F45, `src/organization-settings/`), which records it in the
// Folder; `composioPolicyOf` (`../organization-settings/governance`) reads
// the recorded one. Where the Organization says nothing, the Environment
// decides, and Composio is allowed as it has been since decision F18
// (Organizations that use Composio keep it, nobody signs in again).

export type ComposioPolicy = Readonly<{
  allowed: boolean;
  /** Who decided: the Organization's settings, or this Environment. */
  source: "organization" | "environment";
}>;

/** What decides when nothing else does: the Environment, allowed. */
export const environmentComposioPolicy: ComposioPolicy = Object.freeze({
  allowed: true,
  source: "environment",
});

/** A policy given by a test instead of the Folder's recorded settings. */
export type ComposioPolicySource = () => Promise<ComposioPolicy>;

// Whether agents may use the apps, plugins and connectors of the person's
// ChatGPT account in Codex ("Aplikace z ChatGPT", decision F42's addendum of
// 2026-10-27): on an Organization's Environment its Organization decides
// (`integrations.chatgpt_apps.allowed`), on a personal Environment and the
// person's own computer the person (the Folder's `chatgptAppsAllowed`). Off
// unless someone allowed it: unlike Composio, an Organization that says
// nothing does not allow them. The Folder's text, the Integrace page,
// `lazurio integrations chatgpt-apps`, doctor and the Codex configuration
// read this seam only (`chatgptAppsPolicyOf`).

export type ChatgptAppsPolicy = Readonly<{
  allowed: boolean;
  /** Who decides here: the Organization's settings, or the person. */
  source: "organization" | "person";
  /** Whether that decision was made (`false`: nobody allowed them, the
   * default, off). */
  set: boolean;
}>;
