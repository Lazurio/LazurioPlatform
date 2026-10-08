import {
  cacheName,
  failedNavigation,
  OFFLINE_CACHE_PREFIX,
  OFFLINE_CONTACT_PATH,
  OFFLINE_PAGE_PATH,
  OFFLINE_VERSION_MESSAGE,
  type OfflineContact,
  type OfflineWorkerConfig,
  parseContact,
  shouldRefresh,
  staleCaches,
} from "./offline-policy";

// The service worker at `/.lazurio/offline-sw.js` (DEV-6651): bundled into one
// classic script without imports at run time, after the prelude the Launchpad
// writes (`offlineWorkerPrelude`). It answers a navigation only when the
// network fails, with the guide page it keeps; every other request never
// reaches it. The policy and its tests are in `offline-policy.ts`.

declare const LAZURIO_OFFLINE: OfflineWorkerConfig;

type Extendable = Event & { waitUntil(promise: Promise<unknown>): void };
type Fetching = Extendable & {
  readonly request: Request;
  readonly preloadResponse: Promise<Response | undefined>;
  respondWith(response: Promise<Response>): void;
};
type Messaging = Extendable & {
  readonly data: unknown;
  readonly source: { postMessage(message: unknown): void } | null;
};
type WorkerScope = {
  addEventListener(
    type: "install" | "activate",
    listener: (event: Extendable) => void,
  ): void;
  addEventListener(type: "fetch", listener: (event: Fetching) => void): void;
  addEventListener(type: "message", listener: (event: Messaging) => void): void;
  skipWaiting(): Promise<void>;
  readonly clients: { claim(): Promise<void> };
  readonly registration: {
    unregister(): Promise<boolean>;
    readonly navigationPreload?: { enable(): Promise<void> };
  };
};

const worker = self as unknown as WorkerScope;
const config = LAZURIO_OFFLINE;
const current = cacheName(config.page);

async function readContact(cache: Cache): Promise<OfflineContact | null> {
  const kept = await cache.match(OFFLINE_CONTACT_PATH);
  return kept ? parseContact(await kept.text()) : null;
}

function writeContact(cache: Cache, contact: OfflineContact): Promise<void> {
  return cache.put(
    OFFLINE_CONTACT_PATH,
    new Response(JSON.stringify(contact), {
      headers: { "Content-Type": "application/json" },
    }),
  );
}

/** The guide page as this origin serves it now; never a redirect to the sign-in. */
async function fetchPage(): Promise<Response | null> {
  const response = await fetch(OFFLINE_PAGE_PATH, {
    cache: "no-store",
    credentials: "same-origin",
    redirect: "error",
  });
  return response.ok ? response : null;
}

/** Removes every cache of the worker and the worker itself. */
async function retire(): Promise<void> {
  for (const key of await caches.keys()) {
    if (key.startsWith(OFFLINE_CACHE_PREFIX)) await caches.delete(key);
  }
  await worker.registration.unregister();
}

/** A navigation reached the network: remember it, and refresh the page now and then. */
async function remember(): Promise<void> {
  const cache = await caches.open(current);
  const contact = await readContact(cache);
  const now = Date.now();
  let refreshedAt = contact?.refreshedAt ?? 0;
  if (shouldRefresh(contact, now)) {
    const page = await fetchPage().catch(() => null);
    if (page) {
      await cache.put(OFFLINE_PAGE_PATH, page);
      refreshedAt = now;
    }
  }
  await writeContact(cache, { at: now, refreshedAt });
}

async function navigate(event: Fetching): Promise<Response> {
  let response: Response;
  try {
    response = (await event.preloadResponse) ?? (await fetch(event.request));
  } catch {
    const cache = await caches.open(current);
    if (failedNavigation(await readContact(cache), Date.now()) === "retire") {
      event.waitUntil(retire());
      return Response.error();
    }
    return (await cache.match(OFFLINE_PAGE_PATH)) ?? Response.error();
  }
  event.waitUntil(remember().catch(() => undefined));
  return response;
}

worker.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      if (!config.retired) {
        const page = await fetchPage();
        if (!page) throw new Error("The guide page is not available");
        const cache = await caches.open(current);
        await cache.put(OFFLINE_PAGE_PATH, page);
        await writeContact(cache, { at: Date.now(), refreshedAt: Date.now() });
      }
      await worker.skipWaiting();
    })(),
  );
});

worker.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      if (config.retired) {
        await retire();
        return;
      }
      for (const key of staleCaches(await caches.keys(), current))
        await caches.delete(key);
      await worker.registration.navigationPreload
        ?.enable()
        .catch(() => undefined);
      await worker.clients.claim();
    })(),
  );
});

if (!config.retired) {
  worker.addEventListener("fetch", (event) => {
    if (event.request.mode !== "navigate") return;
    event.respondWith(navigate(event));
  });
}

worker.addEventListener("message", (event) => {
  const data = event.data as { type?: unknown } | null;
  if (data?.type !== OFFLINE_VERSION_MESSAGE) return;
  event.source?.postMessage({
    type: OFFLINE_VERSION_MESSAGE,
    version: config.version,
    page: config.page,
    retired: config.retired,
  });
});
