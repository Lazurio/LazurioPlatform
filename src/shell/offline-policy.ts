// The offline guide's worker policy (DEV-6651, LazurioPlatform#262): what the
// service worker at `/.lazurio/offline-sw.js` decides, kept free of worker
// globals so the same code is bundled into the worker and tested here.
//
// The worker answers only a navigation that cannot reach the network
// (Tailscale off, another tailnet active, the device not in the tailnet): it
// returns the guide page it keeps from the last visit. It must never freeze in
// a browser, so it is updatable by construction:
// - one address forever (`OFFLINE_WORKER_PATH`); retiring the feature serves a
//   worker that unregisters itself at the same address;
// - its bytes change with its code and with the guide page (`cacheName`
//   carries the page's digest), so every change reaches the browser on the
//   next update check, and old caches go at activation (`staleCaches`);
// - it removes itself when the Environment has not answered for 30 days
//   (`failedNavigation`), so an Environment that was renamed or removed, whose
//   origin can never serve an update again, does not keep a guide forever;
// - it removes itself when the origin answers that it keeps no guide
//   (`refreshOutcome`), even where nothing checks it for an update, such as a
//   Launchpad rolled back to a release from before the guide.

/** The worker's one address on every shell origin. Never renamed. */
export const OFFLINE_WORKER_PATH = "/.lazurio/offline-sw.js";
/** The guide page the worker keeps and shows. */
export const OFFLINE_PAGE_PATH = "/.lazurio/offline";
/** Where the worker records its last contact with the Environment, in its own cache. */
export const OFFLINE_CONTACT_PATH = "/.lazurio/offline-contact";
/** Every cache of the worker starts with this; nothing else of the origin does. */
export const OFFLINE_CACHE_PREFIX = "lazurio-offline-";
/** The message a page sends to learn which worker serves it (diagnostics). */
export const OFFLINE_VERSION_MESSAGE = "lazurio-offline-version";

/** No contact for this long: the worker removes itself instead of guiding. */
export const OFFLINE_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;
/** A successful navigation refreshes the kept guide page at most this often. */
export const OFFLINE_REFRESH_MS = 60 * 60 * 1000;

/** What the Launchpad bakes into the worker's bytes before its code. */
export type OfflineWorkerConfig = {
  /** The Platform version that serves the worker. */
  version: string;
  /** SHA-256 of the guide page this worker keeps, as served to this origin. */
  page: string;
  /** A retiring worker removes its caches and its registration, nothing else. */
  retired: boolean;
};

/** The worker's last contact with the Environment, kept in its own cache. */
export type OfflineContact = {
  /** Epoch milliseconds of the last navigation that reached the network. */
  at: number;
  /** Epoch milliseconds of the last refresh of the kept guide page. */
  refreshedAt: number;
};

export function cacheName(page: string): string {
  return `${OFFLINE_CACHE_PREFIX}${page}`;
}

/** The worker's caches that belong to an older version. */
export function staleCaches(
  keys: readonly string[],
  current: string,
): string[] {
  return keys.filter(
    (key) => key.startsWith(OFFLINE_CACHE_PREFIX) && key !== current,
  );
}

/**
 * A navigation failed. The worker shows its guide only while the Environment
 * answered within `OFFLINE_EXPIRY_MS`. Without a readable contact it does not
 * guess: it retires, and the browser shows its own error.
 */
export function failedNavigation(
  contact: OfflineContact | null,
  now: number,
): "guide" | "retire" {
  if (!contact) return "retire";
  return now - contact.at > OFFLINE_EXPIRY_MS ? "retire" : "guide";
}

export function shouldRefresh(
  contact: OfflineContact | null,
  now: number,
): boolean {
  return !contact || now - contact.refreshedAt >= OFFLINE_REFRESH_MS;
}

/**
 * The answer of a refresh of the kept page: its HTTP status, or null when no
 * answer came (no network, or a redirect to the sign-in). 404 says the origin
 * keeps no guide (any more): the worker retires at once rather than renew its
 * contact. A page replaces the kept one; anything else keeps it.
 */
export function refreshOutcome(
  status: number | null,
): "replace" | "keep" | "retire" {
  if (status === 404) return "retire";
  return status !== null && status >= 200 && status < 300 ? "replace" : "keep";
}

/** The contact as written to the cache; anything else reads as no contact. */
export function parseContact(text: string): OfflineContact | null {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null) return null;
    const { at, refreshedAt } = value as Record<string, unknown>;
    if (typeof at !== "number" || !Number.isFinite(at)) return null;
    if (typeof refreshedAt !== "number" || !Number.isFinite(refreshedAt))
      return null;
    return { at, refreshedAt };
  } catch {
    return null;
  }
}

/**
 * The first statement of the worker's bytes. The page digest and the version
 * are part of the bytes, so the browser's byte comparison sees every change.
 */
export function offlineWorkerPrelude(config: OfflineWorkerConfig): string {
  if (!/^[0-9a-f]{64}$/.test(config.page))
    throw new Error("The guide page digest must be SHA-256 hex");
  return `const LAZURIO_OFFLINE = ${JSON.stringify(config)};\n`;
}
