import type { ShellEnvironment } from "./contract";

// The frame of decision 0248's addendum of 2026-11-15 and 0180's: a page of
// another person's Environment has a red frame, a page of a shared one (a
// Team Environment, Henry, the services Environment of a server) a blue
// one, and the person's own Environment has none. On the web the overlay
// with Buddy draws it, in Lazurio App the app draws it natively around the
// page; both decide with this one function.
//
// Whose the Environment is comes from the document it answers behind its
// gateway (`lazurio.shell.v1`, never the page), the viewer from the Lazurio
// account. Where either is not known, the frame is drawn: a frame too many
// costs a glance, a frame too few hides that someone else's Environment is
// open. Pure: no DOM and no I/O.

export type EnvFrame =
  | Readonly<{
      tone: "person";
      /** The person whose Environment it is; null when the document does
       * not say. */
      login: string | null;
      /** Their name as their profile gives it, when known. */
      name: string | null;
      kind: "work" | "personal";
    }>
  | Readonly<{
      tone: "shared";
      /** A Team Environment, Henry (an Automated Environment, 0169), the
       * services Environment of a server (0209), or a work Environment
       * assigned to nobody. */
      shared: "team" | "henry" | "services" | "work";
      /** Its name as the elements show it, when it has one. */
      name: string | null;
    }>;

const same = (a: string, b: string): boolean =>
  a.toLowerCase() === b.toLowerCase();

const isViewer = (
  login: string | null | undefined,
  viewer: string | null,
): boolean =>
  typeof login === "string" && viewer !== null && same(login, viewer);

/** The frame of a page of `environment` for `viewer` (the Lazurio account's
 * login, null when not known); null for none. */
export function envFrame(
  environment: ShellEnvironment | undefined,
  viewer: string | null,
): EnvFrame | null {
  if (environment === undefined || environment.kind === "workstation")
    return null;
  const name = environment.name ?? environment.label;
  switch (environment.kind) {
    case "team":
      return { tone: "shared", shared: "team", name };
    case "automated":
      return { tone: "shared", shared: "henry", name };
    case "personal":
      if (isViewer(environment.owner, viewer)) return null;
      return {
        tone: "person",
        login: environment.owner ?? null,
        name: null,
        kind: "personal",
      };
    case "work":
      if (environment.services === true) {
        return { tone: "shared", shared: "services", name };
      }
      if (environment.assignee === null) {
        return { tone: "shared", shared: "work", name };
      }
      if (isViewer(environment.assignee, viewer)) return null;
      return {
        tone: "person",
        login: environment.assignee,
        name: environment.assigneeName ?? null,
        kind: "work",
      };
  }
}
