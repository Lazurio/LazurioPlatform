// Which pages may frame Buddy's chat, and where its sign-in starts (buddy-web-v1
// CONTRACT sections 2 and 4). Buddy's frame is served on
// `https://buddy.<slug>.<domain>` (`<domain>` is `lazurio.io`); the shell of
// the person's Environments embeds it on their Launchpad, Chat (T3 Code) and
// Automate (MausBot): `https://(launchpad|t3code|mausbot).<base>.<domain>`,
// `<base>` the Environment's id, one label for the Osobní Prostředí itself
// (its slug) and two (`<machine>.<org>`) for a work or team Environment.
// Nothing else frames it: not a Module's app on the same domain, which runs an
// Organization's own code, not another domain, and never a bare wildcard.
// The server and the page read the same rules from here. Pure.

/** The apps whose pages carry the shell that embeds Buddy. */
export const buddyHostApps = Object.freeze(["launchpad", "t3code", "mausbot"]);

const label = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

type Parsed = Readonly<{ scheme: string; port: string; labels: string[] }>;

function parseOrigin(value: string | null | undefined): Parsed | null {
  if (typeof value !== "string" || value === "") return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username !== "" ||
    url.password !== ""
  )
    return null;
  const labels = url.hostname.split(".");
  if (!labels.every((part) => label.test(part))) return null;
  return { scheme: url.protocol, port: url.port, labels };
}

/** The frame's own origin as a configuration names it: `<app>.<slug>.<domain>`
 * with a domain of at least two labels, exactly an origin. In production
 * https without a port; a local preview may use http and a port. */
export function isFrameOrigin(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = parseOrigin(value);
  if (parsed === null || parsed.labels.length < 4) return false;
  try {
    return new URL(value).origin === value;
  } catch {
    return false;
  }
}

/** The Environment id of the page origin `candidate` when it may host the
 * frame served on `frameOrigin`: its scheme and port are the frame's, its
 * first label one of `buddyHostApps`, then a base, then the frame's own
 * domain. A base of one label is an Osobní Prostředí: only the frame's own
 * (its slug); one of two labels is a work or team Environment. Null for
 * anything else. */
export function hostEnvironmentOf(
  frameOrigin: string,
  candidate: string | null | undefined,
): string | null {
  const frame = parseOrigin(frameOrigin);
  const host = parseOrigin(candidate);
  if (frame === null || host === null || frame.labels.length < 4) return null;
  if (host.scheme !== frame.scheme || host.port !== frame.port) return null;
  const domain = frame.labels.slice(2);
  const prefix = host.labels.length - domain.length;
  if (prefix < 2 || prefix > 3) return null;
  if (host.labels.slice(prefix).join(".") !== domain.join(".")) return null;
  const app = host.labels[0] as string;
  if (!buddyHostApps.includes(app)) return null;
  const base = host.labels.slice(1, prefix);
  if (base.length === 1 && base[0] !== frame.labels[1]) return null;
  return base.join(".");
}

/** The origin of the page that asks for the frame, by its `Referer`, when it
 * may host it (`hostEnvironmentOf`); else null. The shell's iframe sends the
 * host's origin as its referrer (`referrerpolicy`). */
export function hostOriginOf(
  frameOrigin: string,
  referer: string | null | undefined,
): string | null {
  if (typeof referer !== "string") return null;
  let origin: string;
  try {
    origin = new URL(referer).origin;
  } catch {
    return null;
  }
  return hostEnvironmentOf(frameOrigin, origin) === null ? null : origin;
}

/** The host a page names itself: exactly an origin that may host the
 * frame, or null. */
function namedHost(
  frameOrigin: string,
  named: string | null | undefined,
): string | null {
  if (typeof named !== "string") return null;
  try {
    if (new URL(named).origin !== named) return null;
  } catch {
    return null;
  }
  return hostEnvironmentOf(frameOrigin, named) === null ? null : named;
}

/** `frame-ancestors` of one of the frame's pages: exactly the origin of the
 * host that asks for it, or `'none'`. The host is the request's `Referer`;
 * when the frame reloads itself (after the popup sign-in), its own document
 * sends none, so it names its host in `?host=` instead. Either way a browser
 * enforces the directive on the real ancestors: naming a host lets in that
 * host and no page that only names it. */
export function frameAncestors(
  frameOrigin: string,
  referer: string | null | undefined,
  named?: string | null,
): string {
  return (
    hostOriginOf(frameOrigin, referer) ??
    namedHost(frameOrigin, named) ??
    "'none'"
  );
}

/** The host's origin as the frame reads it at load: the first ancestor
 * origin where the browser lists them (Chromium, Safari), which is the real
 * parent; else the referrer's origin, else the host the frame named when it
 * reloaded itself (`?host=`). Null when the frame is not framed or none of
 * them may host it. A name the parent does not hold harms nothing: the
 * browser refuses the frame to any other parent, delivers the frame's
 * messages only to that origin and the frame takes messages only from it. */
export function hostOriginAtLoad(
  frameOrigin: string,
  framed: boolean,
  ancestorOrigins: readonly string[] | null,
  referrer: string,
  named: string | null,
): string | null {
  if (!framed) return null;
  if (ancestorOrigins !== null && ancestorOrigins.length > 0)
    return namedHost(frameOrigin, ancestorOrigins[0]);
  return (
    hostOriginOf(frameOrigin, referrer === "" ? null : referrer) ??
    namedHost(frameOrigin, named)
  );
}

/** Where the popup sign-in starts: the gateway's sign-in on the Osobní
 * Prostředí's bare domain, back to the frame's `/signed-in` (a first sign-in
 * inside a frame fails, the issuer refuses to be framed). */
export function signInUrl(frameOrigin: string): string {
  const url = new URL(frameOrigin);
  const bare = url.hostname.split(".").slice(1).join(".");
  const start = new URL(
    `${url.protocol}//${bare}${url.port === "" ? "" : `:${url.port}`}/oauth2/start`,
  );
  start.searchParams.set("rd", `${frameOrigin}/signed-in`);
  return start.href;
}
