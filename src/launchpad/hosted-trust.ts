import { createHash } from "node:crypto";
import {
  isAuthCheckUrl,
  isEntryCookieName,
  isEntryPort,
  isHttpsOrigin,
} from "./hosted-entry";

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
  /** The one session cookie the gateway sets; exactly this name (or its
   * oauth2-proxy chunks `<name>_0…_n`) is forwarded. */
  authCookieName: string;
  /** The loopback port the gateway proxies to. */
  listenPort: number;
}>;

const maxCookieHeaderBytes = 16 * 1024;

/** The Launchpad part of the handover's `entry.launchpad`, by the rules of
 * the vendored schema (Machines 0.12.93) and kept exactly as written. */
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
  if (!isHttpsOrigin(value.externalOrigin))
    throw new Error("Invalid hosted entry origin");
  if (!isAuthCheckUrl(value.authCheckUrl))
    throw new Error("Invalid hosted entry auth endpoint");
  if (!isEntryCookieName(value.authCookieName))
    throw new Error("Invalid hosted entry cookie name");
  if (!isEntryPort(value.listenPort))
    throw new Error("Invalid hosted entry port");
  return Object.freeze({
    externalOrigin: value.externalOrigin,
    authCheckUrl: value.authCheckUrl,
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

/** The session cookie of the name in a bounded header, whole or in chunks:
 * its value, or why not.
 *
 * oauth2-proxy splits a session larger than one cookie into `<name>_0`,
 * `<name>_1`, … and reassembles it as `loadCookie` does
 * (oauth2-proxy `pkg/sessions/cookie/session_store.go`, v7.15.4): the cookie
 * of the exact name wins when present; otherwise the chunks `_0`, `_1`, … are
 * read in index order up to the first missing one and their values
 * concatenated. So the whole cookie, when present, is selected exactly as
 * before and any chunks beside it are ignored and not forwarded. Otherwise the
 * session is present when `_0` is; its chunks must be exactly `_0…_n`, each
 * once and non-empty — a gap or a repeated index, which oauth2-proxy would
 * silently cut or pick from, is refused. The chunks are returned as sent, for
 * the auth endpoint's oauth2-proxy to reassemble itself.
 */
export function selectCookie(
  header: string | null,
  name: string,
):
  | Readonly<{ value: string; chunks?: readonly string[] }>
  | Readonly<{ reason: "cookie-missing" | "cookie-invalid" }> {
  if (header === null || header === "") return { reason: "cookie-missing" };
  if (Buffer.byteLength(header, "utf8") > maxCookieHeaderBytes)
    return { reason: "cookie-invalid" };
  const values: string[] = [];
  const chunks = new Map<number, string>();
  let repeated = false;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key === name) values.push(value);
    else if (key.startsWith(`${name}_`)) {
      // Only the names oauth2-proxy reads (`%s_%d`): a canonical index.
      const suffix = key.slice(name.length + 1);
      if (!/^(?:0|[1-9][0-9]*)$/.test(suffix)) continue;
      const index = Number(suffix);
      if (chunks.has(index)) repeated = true;
      chunks.set(index, value);
    }
  }
  if (values.length > 0) {
    if (values.length > 1 || values[0] === "")
      return { reason: "cookie-invalid" };
    return { value: values[0] as string };
  }
  if (!chunks.has(0)) return { reason: "cookie-missing" };
  const ordered: string[] = [];
  for (let index = 0; index < chunks.size; index++) {
    const chunk = chunks.get(index);
    if (chunk === undefined || chunk === "")
      return { reason: "cookie-invalid" };
    ordered.push(chunk);
  }
  if (repeated) return { reason: "cookie-invalid" };
  return { value: ordered.join(""), chunks: ordered };
}

/** What the admission needs of `fetch`: the configured URL and an init. */
export type AuthFetcher = (url: string, init: RequestInit) => Promise<Response>;

export type HostedTrustOptions = Readonly<{
  fetcher?: AuthFetcher;
  now?: () => number;
  /** Positive answers are remembered this long (upstream decision 0157). */
  cacheMs?: number;
  timeoutMs?: number;
}>;

/** The admission of docs/hosted-entry.md: `Host` is the configured origin's
 * host; a state-changing request (any method but GET and HEAD, and every
 * request under `/api/internal/`) is same-origin from the configured origin;
 * exactly the named cookie (or its chunks, see `selectCookie`), forwarded
 * alone, makes the configured auth endpoint answer 2xx within the timeout.
 * Nothing else is evidence — not a forwarded identity header, not another
 * cookie, not the request's own URL.
 */
export function createHostedTrust(
  entry: HostedEntry,
  options: HostedTrustOptions = {},
) {
  const fetcher: AuthFetcher = options.fetcher ?? fetch;
  const now = options.now ?? Date.now;
  const cacheMs = options.cacheMs ?? 120_000;
  const timeoutMs = options.timeoutMs ?? 3_000;
  const host = new URL(entry.externalOrigin).host;
  const admitted = new Map<string, number>();

  async function revalidate(
    cookie: Readonly<{ value: string; chunks?: readonly string[] }>,
  ): Promise<Admission> {
    // Keyed by the reassembled value: the session the auth endpoint decodes.
    const key = createHash("sha256").update(cookie.value).digest("hex");
    const until = admitted.get(key);
    if (until !== undefined && until > now()) return { ok: true };
    let response: Response;
    try {
      response = await fetcher(entry.authCheckUrl, {
        method: "GET",
        // The session exactly as selected: the whole cookie, or its chunks
        // in index order and never re-joined, since the gateway's
        // oauth2-proxy reassembles them itself.
        headers: {
          cookie:
            cookie.chunks === undefined
              ? `${entry.authCookieName}=${cookie.value}`
              : cookie.chunks
                  .map(
                    (chunk, index) =>
                      `${entry.authCookieName}_${index}=${chunk}`,
                  )
                  .join("; "),
        },
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
      // One Host rule for every route, the gateway's `ensure` included: after
      // the switch the gateway keeps the browser's Host on the Launchpad
      // route and sends the Launchpad's own Host on its `ensure` subrequest
      // (launchpad-parity F22 point 3, B5 variant B). A loopback Host, which
      // the resident required, is not this entry and is refused.
      if (request.headers.get("host") !== host)
        return { ok: false, reason: "host-mismatch" };
      // The internal namespace (`/api/internal/*`, the gateway's `ensure`) is
      // a lifecycle mutation even on GET: it may start an app, so it always
      // needs the same-origin rule, as in the resident
      // (`R:launchpad/src/request-trust-lib.mjs:72-83`).
      if (
        (request.method !== "GET" && request.method !== "HEAD") ||
        new URL(request.url).pathname.startsWith("/api/internal/")
      ) {
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
      return revalidate(cookie);
    },
  });
}
