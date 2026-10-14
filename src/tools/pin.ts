import type { ToolOverview } from "./overview";

// The build Lazurio pins for a tool (composio, decision F42 addendum (3)),
// and where its update can work. One rule for Settings → Tools, whose row
// offers "Aktualizovat", and for Apps → Integrace, whose notice offers the
// same update (decision F42, addendum (b) of 2026-10-14). Pure, so the
// Launchpad's pages and its server share it.

/** An installed tool that is not the build Lazurio pins for it; a version
 * that could not be read is not it either. */
export function notPinned(
  tool: Pick<ToolOverview, "installed" | "pinned" | "version">,
): boolean {
  return (
    tool.installed && tool.pinned !== undefined && tool.version !== tool.pinned
  );
}

/** Whether the update to the pinned build can work here: a `launchpad` tool
 * this Environment offers and the Organization does not refuse, installed in
 * the standard path (an installation elsewhere is never shadowed by a second
 * one), and not that build. */
export function pinnedUpdateOffered(
  tool: Pick<
    ToolOverview,
    | "setup"
    | "offered"
    | "organization"
    | "standardPath"
    | "installed"
    | "pinned"
    | "version"
  >,
): boolean {
  return (
    tool.setup === "launchpad" &&
    tool.offered &&
    tool.organization?.allowed !== false &&
    tool.standardPath !== false &&
    notPinned(tool)
  );
}
