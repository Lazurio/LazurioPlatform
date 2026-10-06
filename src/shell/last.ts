import { currentEnvironment, type Shell } from "./contract";
import { organizationOf, personalSpace, type ShellApp } from "./view";

// The last Environment used (root decision 0185 S8): once per full page load
// of Apps, Chat or Automate the shell tells the person's Lazurio account which
// Environment, app and Organization they are in, so that signing in, the
// Dashboard opened without an address and a click on a space in the rail
// return there. `PUT /.lazurio/account/last` on the page's own origin, which
// the Environment's gateway relays to the Dashboard with the person's own
// token; the shell sends no token and reads no answer. Fire and forget: it
// never blocks drawing, it outlives a navigation (`keepalive`), and any
// failure is silent. It is sent only after the page's account read on the
// same origin answered with an account (`state.ts`): where the read found
// none (no gateway relay yet, a workstation, an expired session) the write
// could only fail, and the browser would show a `405`. Kept apart from the
// rail's merge of the account's Environments, which reads the account; this
// only writes the one fact. A page that is no Environment's (F36's addendum
// of 2026-10-05, the Dashboard) reports nothing, and a host that provides
// the account itself is never reported to (the elements skip the report,
// `state.ts`).

export const lastPath = "/.lazurio/account/last";

export type LastVisit = Readonly<{
  /** The current Environment, as `lazurio.shell.v1` names it (`current`). */
  environment: string;
  app: ShellApp;
  /** The Organization slug of the space you are in; null in the personal
   * space. */
  organization: string | null;
}>;

/** What a page of `app` in `space` reports, from the shell document; null
 * on a page that is no Environment's, which reports nothing. */
export function lastVisit(
  shell: Shell,
  app: ShellApp,
  space: string | null,
): LastVisit | null {
  const environment = currentEnvironment(shell);
  if (environment === null) return null;
  return {
    environment: environment.id,
    app,
    organization:
      space === null || space === personalSpace
        ? null
        : (organizationOf(shell, space)?.slug ?? null),
  };
}

/** What this browser keeps of a page for the rail (`lazurio.shell.last`:
 * the last Environment of the space you are in, on this origin): the space
 * and the current Environment; nothing from a page that is no
 * Environment's. */
export function keptVisit(
  shell: Shell,
  space: string | null,
): Readonly<{ space: string; environment: string }> | null {
  if (shell.current === null || space === null) return null;
  return { space, environment: shell.current };
}

type Send = (body: string) => Promise<unknown>;

const send: Send = (body) =>
  fetch(lastPath, {
    method: "PUT",
    credentials: "same-origin",
    cache: "no-store",
    keepalive: true,
    redirect: "error",
    headers: { "Content-Type": "application/json" },
    body,
  });

/** A reporter that sends once, the first time it is asked with a known
 * app on an Environment's page; later calls do nothing (one report per full
 * page load: a page's script runs once per load), and a page that is no
 * Environment's never sends. */
export function createLastReport(transport: Send = send) {
  let reported = false;
  return (shell: Shell, app: ShellApp | null, space: string | null): void => {
    if (reported || app === null) return;
    try {
      const visit = lastVisit(shell, app, space);
      if (visit === null) return;
      reported = true;
      void transport(JSON.stringify(visit)).catch(() => undefined);
    } catch {
      // Silent: the report is never worth an error on the page.
    }
  };
}

/** This page's reporter, used by the elements. */
export const reportLast = createLastReport();

/** The app an element's attribute names (`app` on the rail, `active` on
 * the column head), or null for anything else (`settings`, none). */
export const appOf = (value: string | null): ShellApp | null =>
  value === "chat" || value === "apps" || value === "automate" ? value : null;
