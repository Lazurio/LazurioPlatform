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
// failure is silent (no gateway relay yet, a workstation, an expired
// session). Kept apart from the rail's merge of the account's Environments,
// which reads the account; this only writes the one fact.

export const lastPath = "/.lazurio/account/last";

export type LastVisit = Readonly<{
  /** The current Environment, as `lazurio.shell.v1` names it (`current`). */
  environment: string;
  app: ShellApp;
  /** The Organization slug of the space you are in; null in the personal
   * space. */
  organization: string | null;
}>;

/** What a page of `app` in `space` reports, from the shell document. */
export function lastVisit(
  shell: Shell,
  app: ShellApp,
  space: string,
): LastVisit {
  return {
    environment: currentEnvironment(shell).id,
    app,
    organization:
      space === personalSpace
        ? null
        : (organizationOf(shell, space)?.slug ?? null),
  };
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
 * app; later calls do nothing (one report per full page load: a page's
 * script runs once per load). */
export function createLastReport(transport: Send = send) {
  let reported = false;
  return (shell: Shell, app: ShellApp | null, space: string): void => {
    if (reported || app === null) return;
    reported = true;
    try {
      void transport(JSON.stringify(lastVisit(shell, app, space))).catch(
        () => undefined,
      );
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
