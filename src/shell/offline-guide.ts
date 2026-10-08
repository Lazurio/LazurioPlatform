import type { Shell } from "./contract";
import { OFFLINE_WORKER_PATH } from "./offline-policy";

// The offline guide's registration (decision F41): the shell asks the
// browser to keep the guide's service worker on the page of an Environment
// that keeps the guide, once per page load, and to check it for an update at
// the same time. The browser installs a changed worker on that check (its
// bytes carry its code, version and the guide page's digest), so a worker can
// never freeze: every load of Apps, Chat or Automate compares it with what the
// Environment serves now. Where the Environment keeps no guide (any more), the
// shell registers nothing and only checks a worker registered before: the
// worker's address then serves a retiring worker, which removes itself and
// its caches, and no later load registers one again. The worker itself, and
// why it is safe to activate at once, is in `offline-worker.ts` and
// `offline-policy.ts`.

type Registration = {
  update(): Promise<unknown>;
  readonly active?: { readonly scriptURL: string } | null;
  readonly waiting?: { readonly scriptURL: string } | null;
  readonly installing?: { readonly scriptURL: string } | null;
};

/** The browser's service workers, as the registration uses them. */
export type ServiceWorkers = {
  register(
    url: string,
    options: { scope: string; updateViaCache: "none" },
  ): Promise<Registration>;
  getRegistration(scope: string): Promise<Registration | undefined>;
};

/** Whether a registration is the guide's worker, by the address its script
 * was installed from; another worker of the origin is never touched. */
function isGuideWorker(registration: Registration): boolean {
  const script =
    registration.active ?? registration.waiting ?? registration.installing;
  if (!script) return false;
  try {
    return new URL(script.scriptURL).pathname === OFFLINE_WORKER_PATH;
  } catch {
    return false;
  }
}

/** A registration that acts once, with the first person's document of the
 * page; later documents of the same page do nothing. A page that belongs to
 * no Environment (the Dashboard's) never acts. Failures stay silent: without
 * the worker the page is today's page. */
export function createGuideRegistration(workers: ServiceWorkers | null) {
  let asked = false;
  return (shell: Shell): void => {
    if (asked || workers === null || shell.current === null) return;
    asked = true;
    const registration: Promise<Registration | undefined> = shell.offlineGuide
      ? workers.register(OFFLINE_WORKER_PATH, {
          scope: "/",
          updateViaCache: "none",
        })
      : workers
          .getRegistration("/")
          .then((found) => (found && isGuideWorker(found) ? found : undefined));
    void registration.then((found) => found?.update()).catch(() => undefined);
  };
}

function browserWorkers(): ServiceWorkers | null {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator))
    return null;
  const container = navigator.serviceWorker;
  return {
    register: (url, options) => container.register(url, options),
    getRegistration: (scope) => container.getRegistration(scope),
  };
}

/** This page's registration, used by the shell's state. */
export const registerGuide = createGuideRegistration(browserWorkers());
