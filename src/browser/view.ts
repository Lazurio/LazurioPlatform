import { join } from "node:path";
import type { ProcessRunner } from "../update/self-check";
import { type BrowserEntry, browserCdpPort } from "./units";

/** The person's view of the Environment browser (decision F38): the
 * agent-browser dashboard on the gateway's `browser.` origin. The dashboard
 * keeps its own lock: an access token that a browser must present once in the
 * URL fragment, after which it is a host-only cookie of the view's origin. The
 * token never leaves the Environment otherwise: the Launchpad, behind the
 * same gateway admission, reads it from `agent-browser dashboard start`
 * (which only reprints it while the dashboard runs with the same settings)
 * and hands it over in the fragment of a redirect or a same-origin JSON
 * answer, the way it pairs T3 Code and Lazurio MausBot. */

/** An agent-browser session name as agent-browser accepts it
 * (`[A-Za-z0-9_-]`, `cli/src/validation.rs`), at most 64 characters, the
 * dashboard's limit. */
export const isBrowserSession = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value);

const isAccessToken = (value: string) => /^[0-9a-f]{64}$/.test(value);

/** The answer of `GET /.lazurio/browser.json`: where the view of one
 * session (or of all of them) is, or that this Environment has none. */
export type BrowserView =
  | Readonly<{ available: true; view: string; session: string | null }>
  | Readonly<{ available: false; reason: BrowserViewReason }>;

export const browserViewReasons = [
  /** The recorded entry has no `browser`: no view is routed here. */
  "not-declared",
  /** agent-browser is missing, refused the settings, or answered no token. */
  "view-unavailable",
] as const;
export type BrowserViewReason = (typeof browserViewReasons)[number];

export type BrowserViewSeams = Readonly<{
  run: ProcessRunner;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  env: Readonly<Record<string, string | undefined>>;
}>;

const commandTimeoutMs = 15_000;
const sessionsTimeoutMs = 3_000;

/** The dashboard's access token: `dashboard start` with exactly the unit's
 * settings answers the running dashboard's URL (and starts it, the same way
 * the unit would, when it is not running). */
async function accessToken(
  entry: BrowserEntry,
  seams: BrowserViewSeams,
): Promise<string | null> {
  const home = seams.env.HOME;
  if (home === undefined) return null;
  const environment: Record<string, string> = {
    HOME: home,
    PATH: [
      join(home, ".local", "bin"),
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
    ].join(":"),
    AGENT_BROWSER_CDP: String(browserCdpPort),
  };
  if (seams.env.XDG_RUNTIME_DIR !== undefined)
    environment.XDG_RUNTIME_DIR = seams.env.XDG_RUNTIME_DIR;
  const answer = await seams
    .run(
      [
        join(home, ".local", "bin", "agent-browser"),
        "dashboard",
        "start",
        "--port",
        String(entry.listenPort),
        "--allowed-origins",
        entry.origin,
        "--json",
      ],
      commandTimeoutMs,
      environment,
    )
    .catch(() => null);
  if (answer === null || answer === "timeout" || answer.exitCode !== 0)
    return null;
  try {
    const parsed = JSON.parse(answer.stdout) as {
      data?: { access_urls?: unknown };
    };
    const urls = parsed.data?.access_urls;
    if (!Array.isArray(urls)) return null;
    for (const url of urls) {
      if (typeof url !== "string") continue;
      const prefix = `${entry.origin}/#dashboard-access-token=`;
      if (!url.startsWith(prefix)) continue;
      const token = url.slice(prefix.length);
      if (isAccessToken(token)) return token;
    }
  } catch {}
  return null;
}

/** The stream port of one session, from the dashboard's own list on
 * loopback (where its rule needs no token, only an Origin of the same
 * loopback authority). Null when the session is not running yet. */
async function sessionPort(
  entry: BrowserEntry,
  session: string,
  seams: BrowserViewSeams,
): Promise<number | null> {
  const loopback = `http://127.0.0.1:${entry.listenPort}`;
  try {
    const response = await seams.fetch(`${loopback}/api/sessions`, {
      headers: { Origin: loopback },
      redirect: "error",
      signal: AbortSignal.timeout(sessionsTimeoutMs),
    });
    if (!response.ok) return null;
    const list: unknown = await response.json();
    if (!Array.isArray(list)) return null;
    for (const item of list) {
      if (typeof item !== "object" || item === null) continue;
      const { session: name, port } = item as Record<string, unknown>;
      if (
        name === session &&
        typeof port === "number" &&
        Number.isInteger(port) &&
        port >= 1 &&
        port <= 65535
      )
        return port;
    }
  } catch {}
  return null;
}

/** The view's URL: the dashboard, the session's window selected by its
 * stream port when it runs, and the access token in the fragment. The
 * `view=.html` parameter works around agent-browser serving `/?port=…` as
 * `application/octet-stream` (vercel-labs/agent-browser PR #2046): the
 * dashboard derives the type from the request target's ending; the
 * dashboard's page ignores the parameter. */
export function browserViewUrl(
  origin: string,
  token: string,
  port: number | null,
): string {
  const query = port === null ? "" : `?port=${port}&view=.html`;
  return `${origin}/${query}#dashboard-access-token=${token}`;
}

export async function resolveBrowserView(
  entry: BrowserEntry | undefined,
  session: string | null,
  seams: BrowserViewSeams,
): Promise<BrowserView> {
  if (entry === undefined)
    return Object.freeze({ available: false, reason: "not-declared" });
  const token = await accessToken(entry, seams);
  if (token === null)
    return Object.freeze({ available: false, reason: "view-unavailable" });
  const port =
    session === null ? null : await sessionPort(entry, session, seams);
  return Object.freeze({
    available: true,
    view: browserViewUrl(entry.origin, token, port),
    session,
  });
}

/** The recorded entry's browser members as the view takes them. */
export const browserEntryOf = (
  entry:
    | Readonly<{ browserOrigin?: string; browserListenPort?: number }>
    | null
    | undefined,
): BrowserEntry | undefined =>
  entry?.browserOrigin === undefined || entry.browserListenPort === undefined
    ? undefined
    : Object.freeze({
        origin: entry.browserOrigin,
        listenPort: entry.browserListenPort,
      });
