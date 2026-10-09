import { createHash } from "node:crypto";
import { offlineWorkerScript } from "../shell/bundle" with { type: "macro" };
import type { Shell } from "../shell/contract";
import { shellMessages } from "../shell/messages";
import { renderOfflineGuide } from "../shell/offline-page";
import {
  OFFLINE_PAGE_PATH,
  OFFLINE_WORKER_PATH,
  offlineWorkerPrelude,
} from "../shell/offline-policy";

// The offline guide (decision F41): the page an Environment's address shows
// when Tailscale is off or another tailnet is active, and the service worker
// that keeps it, under `/.lazurio/` on every shell origin (the gateway
// forwards the namespace from the forks' origins). Only an Environment that
// is a node of a tailnet keeps the guide; a workstation has no tailnet. The
// worker's address answers everywhere all the same: where the Environment
// keeps no guide (no tailnet in its handover, an unreadable handover, a
// workstation), with a retiring worker, so a worker installed while the
// Environment had a tailnet removes itself at the next update check.

export const offlineGuidePath = OFFLINE_PAGE_PATH;
export const offlineWorkerPath = OFFLINE_WORKER_PATH;

/** The worker's code, built into this executable; its prelude is per answer. */
export const offlineWorkerSource: string = offlineWorkerScript();

const common = {
  // Always revalidated: the browser compares the worker's bytes on every
  // update check, and a stale copy must never stand in for a new one.
  "Cache-Control": "no-cache",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

export const offlineGuideHeaders = {
  ...common,
  "Content-Type": "text/html; charset=utf-8",
};

export const offlineWorkerHeaders = {
  ...common,
  "Content-Type": "text/javascript; charset=utf-8",
  // The worker lives under `/.lazurio/` but answers navigations of the whole
  // origin. Every answer carries this: an update fetched without it fails, and
  // the browser would keep the old worker.
  "Service-Worker-Allowed": "/",
};

/** The documentation's guide to connecting through Tailscale (DEV-6651 M5). */
export const offlineDocsUrl = (locale: "cs" | "en"): string =>
  `https://documentation.lazurio.ai/${locale}/guide/tailscale/`;

/** The current Environment of a document, where it keeps the guide: a node
 * of a tailnet, never a workstation. */
function guidedEnvironment(shell: Shell, headscaleServerUrl: string | null) {
  if (headscaleServerUrl === null) return null;
  const environment = shell.environments.find(
    (entry) => entry.id === shell.current,
  );
  return environment === undefined || environment.kind === "workstation"
    ? null
    : environment;
}

/** Whether this Environment keeps the guide: the shell document says so
 * (`offlineGuide`), and only then do the elements register the worker. */
export function keepsOfflineGuide(
  shell: Shell,
  headscaleServerUrl: string | null,
): boolean {
  return guidedEnvironment(shell, headscaleServerUrl) !== null;
}

/** The document as `/.lazurio/shell.json` and the page's boot document
 * (F36's addendum of 2026-10-08) carry it: with `offlineGuide` where this
 * Environment keeps the guide. */
export function withOfflineGuide(
  shell: Shell,
  headscaleServerUrl: string | null,
): Shell {
  return keepsOfflineGuide(shell, headscaleServerUrl)
    ? { ...shell, offlineGuide: true }
    : shell;
}

/**
 * The guide page of this Environment, or null where it has none: a
 * workstation, or an Environment whose handover names no tailnet. The name is
 * the one the rail shows from the Environment's own document; a name the
 * person's Dashboard account gives is not known here.
 */
export function offlineGuidePage(
  shell: Shell,
  headscaleServerUrl: string | null,
): string | null {
  const environment = guidedEnvironment(shell, headscaleServerUrl);
  if (environment === null || headscaleServerUrl === null) return null;
  const copy = shellMessages(shell.locale);
  const owner =
    environment.kind === "personal" ? undefined : environment.organizations[0];
  const organization =
    owner === undefined
      ? null
      : (shell.organizations.find((entry) => entry.slug === owner)?.name ??
        owner);
  return renderOfflineGuide({
    locale: shell.locale,
    environment: environment.label ?? copy.names[environment.kind],
    organization,
    tailnet: new URL(headscaleServerUrl).hostname,
    docs: offlineDocsUrl(shell.locale),
    // The rail's logo and the way back: the Dashboard, as the shell's rail
    // leads there (Admin, 2026-10-09).
    dashboard: shell.dashboard,
  });
}

/** The digest a retiring worker names: it keeps no page. */
const noPage = "0".repeat(64);

/**
 * The worker as this origin serves it: the prelude with the Platform version
 * and the digest of the page it keeps, then its code. A change of either
 * changes the bytes, so the browser installs the new worker on its next
 * update check. Without a page (the Environment keeps no guide) it is the
 * retiring worker, which removes its caches and itself.
 */
export function offlineWorker(page: string | null, version: string): string {
  const config =
    page === null
      ? { version, page: noPage, retired: true }
      : {
          version,
          page: createHash("sha256").update(page).digest("hex"),
          retired: false,
        };
  return offlineWorkerPrelude(config) + offlineWorkerSource;
}
