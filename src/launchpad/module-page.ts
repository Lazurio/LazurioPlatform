// A Module app's page in STAGING, delivered by the Launchpad with Lazurio's
// element (plan LZD-0039 `task-2026-11-25-101`, part A, reviewed in
// mission-control-data#424; 0248's addendum of 2026-11-15, 0249's of
// 2026-11-22). The Environment's gateway sends only a top-level navigation
// (`GET` or `HEAD`, `Sec-Fetch-Dest: document`, no upgrade) of a person it
// admitted with the whole Environment here, as
// `/api/internal/hosted/module-page/<module id><the page's path and query>` (`modulePagePrefix`), with the
// Launchpad's Host and the request's whole Cookie; everything else of the
// app (its files, API, WebSockets, events) goes to the app as before. The
// Launchpad admits the request as every other (its session cookie), then:
// - takes the app's loopback address from the catalog and the app's
//   declaration (`entrypoint`), and its public origin from the address the
//   Launchpad composes for it (`runtime.url`), never from the request;
// - asks the app for the page as the gateway would: the app's own Host, the
//   app's own cookies without the session's, and who came as the gateway
//   states it, from the Launchpad's own admission (the subject and the
//   Lazurio username, entry `environment`); nothing the client sent in
//   those headers reaches the app;
// - delivers the answer with `<lazurio-buddy version="staging">` by the
//   deliverer's contract (delivered-element.ts); any other answer as it
//   came.

import { deliverElement } from "./delivered-element";
import { isModuleId } from "./hosted-entry";
import type { AdmittedPerson } from "./hosted-trust";

/** The path prefix the gateway sends a STAGING page to. */
/** The internal path the gateway sends a STAGING page to (review of #1254):
 * under `/api/internal/hosted/`, which the gateway refuses to every browser
 * on every origin (Machines INTERNAL_DENY) and the Launchpad admits only
 * same-origin, as the gateway's own `ensure`. A browser on the Launchpad's
 * origin therefore never gets a Module's page there, so a Module's scripts
 * never run as the Launchpad's. */
export const modulePagePrefix = "/api/internal/hosted/module-page/";

/** The module id and the page's path with its query, from the request's
 * path and query; null for anything else. The id is encoded as one path
 * segment (`encodeURIComponent`), the page's path follows it. */
export function modulePageTarget(
  url: URL,
): Readonly<{ id: string; path: string }> | null {
  if (!url.pathname.startsWith(modulePagePrefix)) return null;
  const rest = url.pathname.slice(modulePagePrefix.length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return null;
  let id: string;
  try {
    id = decodeURIComponent(rest.slice(0, slash));
  } catch {
    return null;
  }
  if (!isModuleId(id)) return null;
  const path = rest.slice(slash);
  if (!path.startsWith("/") || path.startsWith("//")) return null;
  return Object.freeze({ id, path: `${path}${url.search}` });
}

/** The Cookie header without the session cookie `name` and its chunks
 * (`<name>_<n>`), as the gateway sends cookies to an app; null when none
 * is left. */
export function appCookies(header: string | null, name: string): string | null {
  if (header === null) return null;
  const kept = header
    .split(";")
    .map((part) => part.trim())
    .filter((part) => {
      if (part === "") return false;
      const key = part.slice(0, Math.max(0, part.indexOf("="))).trim();
      if (key === name) return false;
      return !(
        key.startsWith(`${name}_`) &&
        /^[0-9]+$/.test(key.slice(name.length + 1))
      );
    });
  return kept.length === 0 ? null : kept.join("; ");
}

// What the gateway states to an app, and the headers of the hop: never
// passed on from the request, only set here.
const dropped = new Set([
  "host",
  "cookie",
  "authorization",
  "dpop",
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "accept-encoding",
  "content-length",
  "forwarded",
  // The app's validators belong to its own bytes, not to the delivered page
  // (review of #1254): a browser that cached the page before the delivery
  // would otherwise get 304 and keep it without the element.
  "if-none-match",
  "if-modified-since",
  "if-match",
  "if-unmodified-since",
  "if-range",
  // The gateway's same-origin proof of the internal path is the
  // Launchpad's, never the app's.
  "origin",
  "sec-fetch-site",
]);
const droppedPrefixes = [
  "x-forwarded-",
  "x-auth-request-",
  "x-lazurio-",
  "sec-websocket-",
];

/** The headers the app gets for its page: the browser's own, the app's
 * Host and cookies, and who came, as the gateway states it. */
export function appRequestHeaders(
  request: Headers,
  origin: string,
  cookieName: string,
  person: AdmittedPerson,
): Headers {
  const headers = new Headers();
  for (const [name, value] of request) {
    const lower = name.toLowerCase();
    if (
      dropped.has(lower) ||
      droppedPrefixes.some((prefix) => lower.startsWith(prefix))
    )
      continue;
    headers.append(name, value);
  }
  const host = new URL(origin).host;
  headers.set("host", host);
  headers.set("x-forwarded-host", host);
  headers.set("x-forwarded-proto", "https");
  // Only a page's bytes as they are: the delivery rewrites the page, and
  // any other answer passes as it came.
  headers.set("accept-encoding", "identity");
  const cookies = appCookies(request.get("cookie"), cookieName);
  if (cookies !== null) headers.set("cookie", cookies);
  if (person.subject !== null)
    headers.set("x-auth-request-user", person.subject);
  if (person.username !== null)
    headers.set("x-auth-request-preferred-username", person.username);
  headers.set("x-lazurio-entry", "environment");
  return headers;
}

/** The app's page for `target`, fetched from its loopback `entry` as the
 * gateway would ask for it and delivered with the element; a redirect, an
 * error or any other answer as the app gave it. 502 when the app does not
 * answer. */
export async function deliverModulePage(
  input: Readonly<{
    request: Request;
    target: Readonly<{ id: string; path: string }>;
    origin: string;
    entry: Readonly<{ host: string; port: number }>;
    cookieName: string;
    person: AdmittedPerson;
    fetcher?: (url: string, init: RequestInit) => Promise<Response>;
  }>,
): Promise<Response> {
  const fetcher = input.fetcher ?? fetch;
  // The app's loopback listener from the catalog, set on a fixed base:
  // nothing of the request names a host here (docs/hosted-entry.md, "Where
  // every origin comes from").
  const url = new URL(input.target.path, "http://loopback.invalid");
  url.hostname = input.entry.host.includes(":")
    ? `[${input.entry.host}]`
    : input.entry.host;
  url.port = String(input.entry.port);
  let answer: Response;
  try {
    answer = await fetcher(url.href, {
      method: input.request.method,
      headers: appRequestHeaders(
        input.request.headers,
        input.origin,
        input.cookieName,
        input.person,
      ),
      redirect: "manual",
    });
  } catch {
    return new Response(
      "Aplikace neodpověděla. / The application did not answer.",
      {
        status: 502,
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store",
        },
      },
    );
  }
  return deliverElement(answer, "staging", input.origin);
}
