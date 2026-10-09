// Whether this Environment may connect apps through Composio (root decision
// 0162, addendum of 2026-10-09, point 4): on a work, Team or Automated
// Environment its Organization decides in the Organization settings (root
// decision 0194), on a personal Environment the person. The Integrace page,
// the path rule and the Folder read this seam only; nothing else decides it.
//
// The Organization's setting does not reach the Environment yet (plan
// DEV-6653): until it does, the Environment decides, and Composio is allowed
// as it has been since decision F18 (Organizations that use Composio keep it,
// nobody signs in again). The delivery of decision 0194 plugs the
// Organization's answer in here.

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

/** The seam a later delivery of the Organization's settings implements. */
export type ComposioPolicySource = () => Promise<ComposioPolicy>;

export const composioPolicy: ComposioPolicySource = async () =>
  environmentComposioPolicy;
