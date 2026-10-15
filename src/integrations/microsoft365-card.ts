import type { CatalogApp } from "./catalog-schema";

// The card of the Organization's Microsoft 365 company app (decision F42
// addendum (c) of 2026-10-14), apart from the rest of the company app so the
// Launchpad's page can take it without anything of the server.

/** The company app's one Executor integration. */
export const microsoft365Slug = "m365";

/** The one card of the company app (decision F42 addendum (c) of
 * 2026-10-14): where the Organization set the company app up, it stands for
 * Outlook, OneDrive and SharePoint, whose own cards it replaces. Its words
 * name all three, so a search for any of them finds it. */
export const microsoft365CardId = "microsoft_365";
export const microsoft365ReplacedApps = Object.freeze([
  "outlook",
  "one_drive",
  "share_point",
]);
export const microsoft365Card: CatalogApp = Object.freeze({
  id: microsoft365CardId,
  name: Object.freeze({ cs: "Microsoft 365", en: "Microsoft 365" }),
  description: Object.freeze({
    cs: "Outlook (pošta a kalendář), OneDrive a SharePoint přes firemní aplikaci.",
    en: "Outlook (mail and calendar), OneDrive and SharePoint through the company app.",
  }),
  category: "mail",
  direct: Object.freeze({
    integration: microsoft365Slug,
    kind: "openapi" as const,
    auth: "company-app:microsoft" as const,
    verified: "2026-10-14",
  }),
  verified: "2026-10-14",
});
