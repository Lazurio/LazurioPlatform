import type { ShellEnvironment, ShellIdentity } from "./contract";
import { type KindLocale, kindLabel } from "./kind-name";

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

// The version's frame (decision 0249's addendum of 2026-11-22, decided
// 2026-11-23): a Module's app in an Environment has a blue frame with a
// label naming its version, solid with "STAGING" for the build from `main`,
// dashed with "DEV" for a worktree on loopback. A shared Environment's
// frame stays blue and its label says it is shared, so the label tells them
// apart, not the colour; another person's Environment stays red with its
// label. A production Application (PROD) is no Environment and has neither.
// The same look as the approved prototype (LazurioDevelopment
// prototypes-lazurio#149): one label at the top, the version first, then
// whose Environment it is.

/** The version of a Module's app a page is: null on a page that is no
 * Module's app (the Launchpad, Chat), which takes 0248's frame alone. */
export type AppVersion = "staging" | "dev";

export type VersionFrame = Readonly<{
  /** Red on another person's Environment, blue on every other framed page. */
  tone: "blue" | "red";
  /** DEV: one agent's change in progress, not on `main` yet. */
  dashed: boolean;
  /** "STAGING" or "DEV"; null on a page that is no Module's app. */
  version: "STAGING" | "DEV" | null;
  /** Whose Environment it is, as 0248's label says it; null on the
   * person's own. */
  environment: string | null;
}>;

/** 0248's label of a framed Environment: whose it is, or that it is shared. */
export function envFrameLabel(frame: EnvFrame, locale: KindLocale): string {
  const join = (...parts: (string | null)[]) =>
    parts.filter((part): part is string => !!part).join(" · ");
  if (frame.tone === "person")
    return join(frame.name ?? frame.login, kindLabel(frame.kind, locale));
  switch (frame.shared) {
    case "team":
      return join(kindLabel("team", locale), frame.name);
    case "henry":
      return join("Henry", frame.name);
    case "services":
      return join(
        locale === "en" ? "Server services" : "Služby serveru",
        frame.name,
      );
    case "work":
      return join(frame.name, kindLabel("work", locale));
  }
}

/** The frame of a page of `environment` for `viewer`, as a Module's app in
 * `version` or, with null, as any other page of it; null for none (the
 * person's own Environment outside a Module's app). */
export function versionFrame(
  environment: ShellEnvironment | undefined,
  viewer: ShellIdentity | null,
  version: AppVersion | null,
  locale: KindLocale,
): VersionFrame | null {
  const frame = envFrame(environment, viewer);
  if (version === null && frame === null) return null;
  return {
    tone: frame?.tone === "person" ? "red" : "blue",
    dashed: version === "dev",
    version: version === null ? null : version === "dev" ? "DEV" : "STAGING",
    environment: frame === null ? null : envFrameLabel(frame, locale),
  };
}

/** The `version` attribute of `<lazurio-frame>`: "staging" or "dev";
 * anything else is no Module's app. */
export function appVersionOf(value: string | null): AppVersion | null {
  return value === "staging" || value === "dev" ? value : null;
}
