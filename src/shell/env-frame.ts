import type { ShellEnvironment, ShellIdentity } from "./contract";

// The frame of decision 0248's addendum of 2026-11-15 and 0180's: a page of
// another person's Environment has a red frame, a page of a shared one (a
// Team Environment, Henry, the services Environment of a server) a blue
// one, and the person's own Environment has none. On the web the overlay
// with Buddy draws it, in Lazurio App the app draws it natively around the
// page; both decide with this one function.
//
// Whose the Environment is comes from the document it answers behind its
// gateway (`lazurio.shell.v1`, never the page), the viewer from the Lazurio
// account. Both sides are compared only by an identity that survives a
// rename, the Lazurio Auth subject or the immutable GitHub id, never by a
// login or a username: a GitHub login can change, and it can equal another
// person's frozen Lazurio username. Where either side is not known, the
// frame is drawn: a frame too many costs a glance, a frame too few hides
// that someone else's Environment is open. Pure: no DOM and no I/O.

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

/** True only when both identities surely name the same person: both carry
 * a Lazurio Auth subject and it is the same, or neither carries a subject
 * and both carry the same GitHub id. A subject on only one side is a
 * Lazurio account the other side does not name, and a GitHub id alone does
 * not prove it is that account (an account may relink GitHub), so it is not
 * known to be one person and the page stays framed. */
export function sameIdentity(
  a: ShellIdentity | undefined,
  b: ShellIdentity | null,
): boolean {
  if (a === undefined || b === null) return false;
  if (a.subject !== undefined || b.subject !== undefined)
    return a.subject !== undefined && a.subject === b.subject;
  return a.githubId !== undefined && a.githubId === b.githubId;
}

/** The frame of a page of `environment` for `viewer` (the identity of the
 * Lazurio account signed in, `ShellAccount.identity`; null when not known);
 * null for none. */
export function envFrame(
  environment: ShellEnvironment | undefined,
  viewer: ShellIdentity | null,
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
      if (sameIdentity(environment.ownerIdentity, viewer)) return null;
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
      if (sameIdentity(environment.ownerIdentity, viewer)) return null;
      return {
        tone: "person",
        login: environment.assignee,
        name: environment.assigneeName ?? null,
        kind: "work",
      };
  }
}
