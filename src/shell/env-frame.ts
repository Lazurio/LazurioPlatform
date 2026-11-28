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

/** True only when the viewer is surely the person the Environment records
 * as its owner, judged by what the Environment records:
 * - a Lazurio Auth subject: the viewer's subject is the same, whatever the
 *   GitHub ids say;
 * - only the immutable GitHub id (a personal Environment its GitHub
 *   principal owns, a work one assigned by GitHub id): the viewer's GitHub id
 *   is the same. The viewer's is the GitHub id their Lazurio account is
 *   linked to, and the Environment's entry already trusts that GitHub
 *   identity; an account that relinked GitHub elsewhere sees a frame, never
 *   the reverse.
 * Matěj, 2026-11-27: no frame on the person's own Work or Personal
 * Environment, whichever way it records them. */
export function sameIdentity(
  owner: ShellIdentity | undefined,
  viewer: ShellIdentity | null,
): boolean {
  if (owner === undefined || viewer === null) return false;
  if (owner.subject !== undefined) return owner.subject === viewer.subject;
  return owner.githubId !== undefined && owner.githubId === viewer.githubId;
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
      // Who views is not known yet (the account is read after the page's
      // document) or not at all: no frame of the place, so nobody sees their
      // own Environment framed as another's, not even while it loads (Matěj,
      // 2026-11-28). Red appears once the account shows it is not theirs.
      if (viewer === null) return null;
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
      if (viewer === null) return null;
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
/** The version a page's `<lazurio-buddy version>` names: a Module's app in
 * STAGING or DEV, or "production" for a page that is no Environment's (an
 * Application on an application host), which is never framed. Whoever
 * delivers the element names it: the Environment's gateway, the module kit,
 * the application host's gateway. */
export type PageVersion = AppVersion | "production";

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
  version: PageVersion | null,
  locale: KindLocale,
  /** The page is an Environment's, but its document could not be read: whose
   * it is is not known, so it is framed red without a label (review of
   * #1244). False on a page that is no Environment's, such as a production
   * Application, which is never framed. */
  environmentUnknown = false,
): VersionFrame | null {
  // A production Application is no Environment's page: never framed, even
  // without a document (its host serves none).
  if (version === "production") return null;
  // A DEV page runs on the loopback of the Environment whose worktree it is,
  // reached only through that Environment's own browser; no gateway serves
  // it, so it never has a document and never reads the account. It is
  // framed as the version it is, blue and dashed, not as another person's
  // place (Matěj, 2026-11-27: the frame of DEV and STAGING warns that it is
  // not PROD). STAGING and a page without a version keep the red frame.
  if (environment === undefined && environmentUnknown)
    return {
      tone: version === "dev" ? "blue" : "red",
      dashed: version === "dev",
      version: version === null ? null : version === "dev" ? "DEV" : "STAGING",
      environment: null,
    };
  const frame = envFrame(environment, viewer);
  if (version === null && frame === null) return null;
  return {
    tone: frame?.tone === "person" ? "red" : "blue",
    dashed: version === "dev",
    version: version === null ? null : version === "dev" ? "DEV" : "STAGING",
    environment: frame === null ? null : envFrameLabel(frame, locale),
  };
}

/** The frame a page draws: none on Buddy's own page (`isBuddysOwnPage`),
 * which is the person's own Buddy in his window, whatever its document or
 * its account read says (Matěj, 2026-11-28); otherwise `versionFrame`. */
export function pageFrame(
  buddysOwnPage: boolean,
  ...frame: Parameters<typeof versionFrame>
): VersionFrame | null {
  return buddysOwnPage ? null : versionFrame(...frame);
}

/** The `version` attribute of `<lazurio-buddy>`: "staging", "dev" or
 * "production"; anything else, or none, names no version. */
export function appVersionOf(value: string | null): PageVersion | null {
  return value === "staging" || value === "dev" || value === "production"
    ? value
    : null;
}
