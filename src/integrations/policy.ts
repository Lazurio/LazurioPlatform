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
