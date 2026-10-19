import type { CdpConnection } from "./cdp";

/** The cookie sweep of the Environment browser (LazurioPlatform#504, F39's
 * addendum of 2026-10-18). A Lazurio session never lives in the Environment
 * browser: the Lazurio sign-in happens only in the person's own browser,
 * whose session, with their access to the Environment, lets them see and
 * drive this one. Anyone who views this browser could otherwise open the
 * person's other Environments or the Dashboard with it. The view removes
 * such cookies whenever it reaches the browser (its start, an upgrade, a
 * restarted browser):
 * - every cookie of `lazurio.ai` and its subdomains: the sign-in service and
 *   the Dashboard;
 * - the gateway's own cookies on `lazurio.io`: its session
 *   (`__Secure-lazurio-workspace`, with its chunks) and the public notice's
 *   acknowledgement (`__Host-lazurio-public-notice`); a module's own cookies
 *   on its `lazurio.io` name stay;
 * - in a public Environment (root decision 0204), whose visitors share the
 *   browser, also github.com's session cookies, so no visitor's GitHub
 *   session stays for the next one.
 * Elsewhere github.com's sign-in is the Environment's, as root decisions
 * 0191 and 0198 say, and stays; the view says whose it is
 * (`githubLoginOf`). Nothing here reads or logs a cookie's value but the
 * GitHub login of `dotcom_user`, which is a public name. */

/** A cookie as DevTools' `Storage.getCookies` reports it. */
export type BrowserCookie = Readonly<{
  name: string;
  value?: string;
  domain: string;
  path: string;
  secure?: boolean;
  partitionKey?: unknown;
}>;

/** What one sweep did: how many cookies it removed, how many of those it
 * should have removed are still there, and the GitHub login of the kept
 * github.com sign-in (null without one, and always in a public
 * Environment). */
export type CookieSweep = Readonly<{
  removed: number;
  remaining: number;
  github: string | null;
}>;

/** github.com's cookies that carry or name a person's session. */
export const githubSessionCookies: readonly string[] = Object.freeze([
  "user_session",
  "__Host-user_session_same_site",
  "logged_in",
  "dotcom_user",
]);

const within = (domain: string, site: string) => {
  const host = domain.replace(/^\./, "").toLowerCase();
  return host === site || host.endsWith(`.${site}`);
};

/** Whether the sweep removes this cookie. */
export function sweptCookie(
  cookie: Pick<BrowserCookie, "name" | "domain">,
  publicEnvironment: boolean,
): boolean {
  if (within(cookie.domain, "lazurio.ai")) return true;
  if (
    within(cookie.domain, "lazurio.io") &&
    (cookie.name.startsWith("__Secure-lazurio-workspace") ||
      cookie.name === "__Host-lazurio-public-notice")
  )
    return true;
  return (
    publicEnvironment &&
    within(cookie.domain, "github.com") &&
    githubSessionCookies.includes(cookie.name)
  );
}

const githubLogin = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

/** Whether a value is a GitHub login. */
export const isGithubLogin = (value: unknown): value is string =>
  typeof value === "string" && githubLogin.test(value);

/** The login github.com names its signed-in person by (`dotcom_user`, next
 * to `logged_in=yes`); null when the browser is not signed in to GitHub. */
export function githubLoginOf(
  cookies: readonly BrowserCookie[],
): string | null {
  const on = (name: string) =>
    cookies.find(
      (cookie) => cookie.name === name && within(cookie.domain, "github.com"),
    );
  const user = on("dotcom_user")?.value;
  return on("logged_in")?.value === "yes" && isGithubLogin(user) ? user : null;
}

/** How DevTools removes one cookie at the browser target: set again, already
 * expired, under the same name, path and partition, with its domain (a
 * domain cookie, `.<domain>`) or its host's URL (a host-only cookie, which
 * `__Host-` cookies always are). */
function expired(cookie: BrowserCookie): Record<string, unknown> {
  return {
    name: cookie.name,
    value: "",
    path: cookie.path,
    secure: cookie.secure === true,
    expires: 1,
    ...(cookie.domain.startsWith(".")
      ? { domain: cookie.domain }
      : { url: `https://${cookie.domain}${cookie.path}` }),
    ...(cookie.partitionKey === undefined
      ? {}
      : { partitionKey: cookie.partitionKey }),
  };
}

const cookiesOf = (answer: Record<string, unknown>): BrowserCookie[] =>
  (Array.isArray(answer.cookies) ? answer.cookies : []).filter(
    (cookie: unknown): cookie is BrowserCookie =>
      typeof cookie === "object" &&
      cookie !== null &&
      typeof (cookie as BrowserCookie).name === "string" &&
      typeof (cookie as BrowserCookie).domain === "string" &&
      typeof (cookie as BrowserCookie).path === "string",
  );

/** One sweep over the browser's cookies through its DevTools connection:
 * read them all, remove what `sweptCookie` names, read them again. */
export async function sweepCookies(
  cdp: Pick<CdpConnection, "send">,
  publicEnvironment: boolean,
): Promise<CookieSweep> {
  const before = cookiesOf(await cdp.send("Storage.getCookies", {}));
  const swept = before.filter((cookie) =>
    sweptCookie(cookie, publicEnvironment),
  );
  if (swept.length > 0)
    await cdp.send("Storage.setCookies", { cookies: swept.map(expired) });
  const after =
    swept.length === 0
      ? before
      : cookiesOf(await cdp.send("Storage.getCookies", {}));
  const remaining = after.filter((cookie) =>
    sweptCookie(cookie, publicEnvironment),
  ).length;
  return Object.freeze({
    removed: swept.length - remaining,
    remaining,
    github: publicEnvironment ? null : githubLoginOf(after),
  });
}
