import { createHash } from "node:crypto";

/** Hosted entry of a Machine (docs/hosted-entry.md, decision F16): the values
 * the Launchpad needs to serve behind the Organization's gateway, recorded in
 * the Folder next to the Machine binding, never derived from a request. The
 * gateway may stand on the Machine (a hosted VM) or on the Conglomerate Host
 * (a work laptop); the Launchpad cannot tell and must not care.
 */
export type HostedEntry = Readonly<{
  /** `https://launchpad.<machine>.<org>.lazurio.io`, no path. */
  externalOrigin: string;
  /** The gateway's auth endpoint answering 2xx for a valid session cookie. */
  authCheckUrl: string;
  /** The one session cookie the gateway sets; exactly this name is forwarded. */
  authCookieName: string;
  /** The loopback port the gateway proxies to. */
  listenPort: number;
}>;

const cookieNamePattern = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,256}$/;
const maxCookieHeaderBytes = 16 * 1024;

function httpsOrigin(value: unknown, what: string): string {
  if (typeof value !== "string")
    throw new Error(`Invalid hosted entry ${what}`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid hosted entry ${what}`);
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    value !== url.origin
  )
    throw new Error(`Invalid hosted entry ${what}`);
  return url.origin;
}

export function parseHostedEntry(input: unknown): HostedEntry {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    throw new Error("Invalid hosted entry");
  const value = input as Record<string, unknown>;
  const known = [
    "externalOrigin",
    "authCheckUrl",
    "authCookieName",
    "listenPort",
  ];
  for (const key of Object.keys(value))
    if (!known.includes(key)) throw new Error("Invalid hosted entry");
  const externalOrigin = httpsOrigin(value.externalOrigin, "origin");
  if (typeof value.authCheckUrl !== "string")
    throw new Error("Invalid hosted entry auth endpoint");
  let auth: URL;
  try {
    auth = new URL(value.authCheckUrl);
  } catch {
    throw new Error("Invalid hosted entry auth endpoint");
  }
  if (auth.protocol !== "https:" || auth.username || auth.password || auth.hash)
    throw new Error("Invalid hosted entry auth endpoint");
  if (
    typeof value.authCookieName !== "string" ||
    !cookieNamePattern.test(value.authCookieName)
  )
    throw new Error("Invalid hosted entry cookie name");
  if (
    typeof value.listenPort !== "number" ||
    !Number.isInteger(value.listenPort) ||
    value.listenPort < 1 ||
    value.listenPort > 65535
  )
    throw new Error("Invalid hosted entry port");
  return Object.freeze({
    externalOrigin,
    authCheckUrl: auth.href,
    authCookieName: value.authCookieName,
    listenPort: value.listenPort,
  });
}

export type Denial =
  | "host-mismatch"
  | "origin-mismatch"
  | "cookie-missing"
  | "cookie-invalid"
  | "auth-denied"
  | "auth-redirect"
  | "auth-unavailable";
export type Admission =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; reason: Denial }>;

/** Exactly one cookie of the name in a bounded header: its value, or why not. */
export function selectCookie(
  header: string | null,
  name: string,
):
  | Readonly<{ value: string }>
  | Readonly<{ reason: "cookie-missing" | "cookie-invalid" }> {
  if (header === null || header === "") return { reason: "cookie-missing" };
  if (Buffer.byteLength(header, "utf8") > maxCookieHeaderBytes)
    return { reason: "cookie-invalid" };
  const values: string[] = [];
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name)
      values.push(part.slice(separator + 1).trim());
  }
  if (values.length === 0) return { reason: "cookie-missing" };
  if (values.length > 1 || values[0] === "")
    return { reason: "cookie-invalid" };
  return { value: values[0] as string };
}

export type HostedTrustOptions = Readonly<{
  fetcher?: typeof fetch;
  now?: () => number;
  /** Positive answers are remembered this long (upstream decision 0157). */
  cacheMs?: number;
  timeoutMs?: number;
}>;

/** The admission of docs/hosted-entry.md: `Host` is the configured origin's
 * host; a state-changing request is same-origin from the configured origin;
 * exactly the named cookie, forwarded alone, makes the configured auth
 * endpoint answer 2xx within the timeout. Nothing else is evidence — not a
 * forwarded identity header, not another cookie, not the request's own URL.
 */
export function createHostedTrust(
  entry: HostedEntry,
  options: HostedTrustOptions = {},
) {
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? Date.now;
  const cacheMs = options.cacheMs ?? 120_000;
  const timeoutMs = options.timeoutMs ?? 3_000;
  const host = new URL(entry.externalOrigin).host;
  const admitted = new Map<string, number>();

  async function revalidate(cookie: string): Promise<Admission> {
    const key = createHash("sha256").update(cookie).digest("hex");
    const until = admitted.get(key);
    if (until !== undefined && until > now()) return { ok: true };
    let response: Response;
    try {
      response = await fetcher(entry.authCheckUrl, {
        method: "GET",
        headers: { cookie: `${entry.authCookieName}=${cookie}` },
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      return { ok: false, reason: "auth-unavailable" };
    }
    await response.body?.cancel().catch(() => undefined);
    if (response.status >= 300 && response.status < 400)
      return { ok: false, reason: "auth-redirect" };
    if (response.status < 200 || response.status >= 300)
      return { ok: false, reason: "auth-denied" };
    admitted.set(key, now() + cacheMs);
    // Bounded memory: forget expired entries when the map grows.
    if (admitted.size > 1024)
      for (const [k, t] of admitted) if (t <= now()) admitted.delete(k);
    return { ok: true };
  }

  return Object.freeze({
    entry,
    async admit(request: Request): Promise<Admission> {
      if (request.headers.get("host") !== host)
        return { ok: false, reason: "host-mismatch" };
      if (request.method !== "GET" && request.method !== "HEAD") {
        if (
          request.headers.get("sec-fetch-site") !== "same-origin" ||
          request.headers.get("origin") !== entry.externalOrigin
        )
          return { ok: false, reason: "origin-mismatch" };
      }
      const cookie = selectCookie(
        request.headers.get("cookie"),
        entry.authCookieName,
      );
      if ("reason" in cookie) return { ok: false, reason: cookie.reason };
      return revalidate(cookie.value);
    },
  });
}
