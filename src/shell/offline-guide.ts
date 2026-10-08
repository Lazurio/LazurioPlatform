import type { Shell } from "./contract";
import { OFFLINE_WORKER_PATH } from "./offline-policy";

// The offline guide's registration (decision F41): the shell asks the
// browser to keep the guide's service worker on the page of an Environment,
// once per page load, and to check it for an update at the same time. The
// browser installs a changed worker on that check (its bytes carry its code,
// version and the guide page's digest), so a worker can never freeze: every
// load of Apps, Chat or Automate compares it with what the Environment
// serves now. The worker itself, and why it is safe to activate at once, is
// in `offline-worker.ts` and `offline-policy.ts`.

type Registration = { update(): Promise<unknown> };
export type RegisterWorker = (
  url: string,
  options: { scope: string; updateViaCache: "none" },
) => Promise<Registration>;

/** Whether this document is an Environment's own page: it names its current
 * Environment, and that Environment is no workstation (a workstation runs on
 * the person's computer and has no tailnet; the Dashboard names none). */
export function guidesHere(shell: Shell): boolean {
  if (shell.current === null) return false;
  const environment = shell.environments.find(
    (entry) => entry.id === shell.current,
  );
  return environment !== undefined && environment.kind !== "workstation";
}

/** A registration that asks once, the first time it gets an Environment's
 * document; later documents of the same page do nothing. Failures stay
 * silent: without the worker the page is today's page. */
export function createGuideRegistration(register: RegisterWorker | null) {
  let asked = false;
  return (shell: Shell): void => {
    if (asked || register === null || !guidesHere(shell)) return;
    asked = true;
    void register(OFFLINE_WORKER_PATH, { scope: "/", updateViaCache: "none" })
      .then((registration) => registration.update())
      .catch(() => undefined);
  };
}

function browserRegister(): RegisterWorker | null {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator))
    return null;
  return (url, options) => navigator.serviceWorker.register(url, options);
}

/** This page's registration, used by the shell's state. */
export const registerGuide = createGuideRegistration(browserRegister());
