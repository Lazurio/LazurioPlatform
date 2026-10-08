import type { Shell } from "./contract";
import { vendorText } from "./vendor-text" with { type: "macro" };

// The browser tab's icon on a page that shows the shell (F36's addendum of
// 2026-10-08): Apps, Chat and Automate of an Environment carry the icon of
// the Organization the Environment belongs to, so a person with several tabs
// sees at once whose Environment each is. A personal Environment, a
// workstation and an Organization without an avatar carry Lazurio's symbol.
// A page that belongs to no Environment (the Dashboard's) keeps its own icon.
// The shell sets it from the person's document, the same in all three apps,
// and replaces the app's own icon links so the browser shows this one.

/** Lazurio's symbol, inline: no request, the same on every origin. */
export const LAZURIO_TAB_ICON = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
  vendorText("symbol-color.svg"),
)}`;

/** The icon of a person's document: the current Environment's Organization
 * by its avatar, else Lazurio's symbol; null on a page that belongs to no
 * Environment. */
export function tabIconFor(shell: Shell): string | null {
  if (shell.current === null) return null;
  const environment = shell.environments.find(
    (entry) => entry.id === shell.current,
  );
  if (environment === undefined) return null;
  const owner =
    environment.kind === "personal" || environment.kind === "workstation"
      ? undefined
      : environment.organizations[0];
  const avatar =
    owner === undefined
      ? null
      : (shell.organizations.find((entry) => entry.slug === owner)?.avatar ??
        null);
  return avatar ?? LAZURIO_TAB_ICON;
}

/** The part of a document the tab icon touches. */
export type IconDocument = {
  querySelectorAll(selector: string): Iterable<{ id: string; remove(): void }>;
  getElementById(id: string): { href: string } | null;
  createElement(tag: "link"): { id: string; rel: string; href: string };
  readonly head: { append(node: unknown): void };
};

const ICON_ID = "lazurio-tab-icon";

/** Sets the tab icon from each person's document; nothing changes while the
 * icon stays the same. Without a document (a test, a worker) it does
 * nothing. */
export function createTabIcon(doc: IconDocument | null) {
  let shown: string | null = null;
  return (shell: Shell): void => {
    if (doc === null) return;
    const href = tabIconFor(shell);
    if (href === null || href === shown) return;
    shown = href;
    for (const link of doc.querySelectorAll('link[rel~="icon"]'))
      if (link.id !== ICON_ID) link.remove();
    const existing = doc.getElementById(ICON_ID);
    if (existing !== null) {
      existing.href = href;
      return;
    }
    const link = doc.createElement("link");
    link.id = ICON_ID;
    link.rel = "icon";
    link.href = href;
    doc.head.append(link);
  };
}

/** This page's tab icon, used by the shell's state. */
export const applyTabIcon = createTabIcon(
  typeof document === "undefined"
    ? null
    : (document as unknown as IconDocument),
);
