import type { Server, ServerWebSocket } from "bun";
import type { EnvironmentIdentity } from "../../shell/view";
import { isStrip, targetIdOf } from "../contract/pure";
import { viewScript } from "./bundle" with { type: "macro" };
import { browserSocketUrl, type CdpConnection, connectCdp } from "./cdp";
import {
  BrowserHub,
  type HubSeams,
  navigableAddress,
  type Viewer,
} from "./hub";
import { viewPage } from "./page";
import { parseClientMessage } from "./protocol";

/** The people's view service (decision F39): `lazurio browser serve` behind
 * the gateway's `browser.` route. It serves the view page, opens remote tabs
 * and carries one WebSocket per person's tab. The gateway's session is the
 * only admission (F39 point 8): this service checks that every request names
 * its own host and that every socket and every change comes from its own
 * origin, and it listens on loopback only. On loopback alone it also answers
 * the Launchpad's requests about the Environment's tabs (decision F47 point
 * 6), which no browser may make. */

export type ViewServiceOptions = Readonly<{
  /** The view's public origin, `https://browser.<…>`, from the handover. */
  origin: string;
  /** The loopback port the gateway forwards to. */
  port: number;
  hub: HubSeams;
  log: (line: string) => void;
  /** How the shell names this Environment (F39's addendum of 2026-10-12),
   * read for each page (`readViewIdentity`); absent: the page names none
   * until the app around it does. */
  identity?: (() => Promise<EnvironmentIdentity | null>) | undefined;
}>;

type SocketData = { targetId: string; viewer: Viewer | null };

const script = viewScript();
const maxUploadBytes = 256 * 1024 * 1024;

/** How long a page waits for its Environment's identity: the Launchpad's
 * page waits as long for its boot document. */
export const identityWithinMs = 500;

/** The identity for each page (F39's addendum of 2026-10-12): read anew,
 * never awaited longer than `withinMs`. A read that fails or takes longer
 * gives the last identity read (none before the first), and one that ends
 * late is kept for the next page. A read that positively finds none (no
 * hosted Folder) is none. */
export function pageIdentitySource(
  read: () => Promise<EnvironmentIdentity | null>,
  withinMs = identityWithinMs,
): () => Promise<EnvironmentIdentity | null> {
  let last: EnvironmentIdentity | null = null;
  return async () => {
    let late: ReturnType<typeof setTimeout> | undefined;
    const fresh = read().then(
      (identity) => {
        last = identity;
        return identity;
      },
      () => last,
    );
    try {
      return await Promise.race([
        fresh,
        new Promise<EnvironmentIdentity | null>((resolve) => {
          late = setTimeout(() => resolve(last), withinMs);
        }),
      ]);
    } finally {
      clearTimeout(late);
    }
  };
}

/** `frame-ancestors` for the view: the Environment's own origins, the
 * siblings of the view's host (`https://*.<vm>.<org>.lazurio.io`), and the
 * T3 Code or Launchpad of another Environment that asks for the page, named by
 * the request's `Referer` (root decision 0191, addendum of 2026-10-09). No
 * other page frames it: the gateway's sign-in still decides who sees it, and
 * this keeps the views out of other Organizations' apps. A host with fewer
 * than three labels (a test on localhost) is framed by itself only. */
export function frameAncestors(
  origin: string,
  referer?: string | null,
): string {
  const host = new URL(origin).hostname;
  const labels = host.split(".");
  if (labels.length < 3) return "'self'";
  const siblings = labels.slice(1).join(".");
  const shell = appShellOrigin(referer);
  return shell === null || new URL(shell).hostname.endsWith(`.${siblings}`)
    ? `'self' https://*.${siblings}`
    : `'self' https://*.${siblings} ${shell}`;
}

/** The apps that frame views of the Environment browser in their right panel:
 * T3 Code and the Launchpad of an Environment on lazurio.io. */
const APP_SHELL =
  /^https:\/\/(?:t3code|launchpad)\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+lazurio\.io$/;

/** The origin of `referer` when it is such an app, else null. */
export function appShellOrigin(
  referer: string | null | undefined,
): string | null {
  if (!referer) return null;
  let url: URL;
  try {
    url = new URL(referer);
  } catch {
    return null;
  }
  return APP_SHELL.test(url.origin) ? url.origin : null;
}

export function pageHeaders(
  origin: string,
  referer?: string | null,
): Record<string, string> {
  const url = new URL(origin);
  const socket = `${url.protocol === "https:" ? "wss" : "ws"}://${url.host}`;
  return {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": [
      "default-src 'none'",
      "script-src 'self'",
      "style-src 'unsafe-inline'",
      "img-src 'self' https: data: blob:",
      `connect-src 'self' ${socket}`,
      "base-uri 'none'",
      "form-action 'none'",
      `frame-ancestors ${frameAncestors(origin, referer)}`,
    ].join("; "),
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });

const livePath = /^\/t\/([0-9A-Fa-f]{32})\/live$/;
const filesPath = /^\/t\/([0-9A-Fa-f]{32})\/files$/;
const viewPath = /^\/t\/([0-9A-Fa-f]{32})$/;
const tabsPath = /^\/\.lazurio\/tabs(?:\/([^/]+)\/(close|restore))?$/;
const maxTabsBodyBytes = 8 * 1024;

export type RequestDecision =
  | Readonly<{ kind: "health" }>
  | Readonly<{ kind: "page" }>
  | Readonly<{ kind: "script" }>
  | Readonly<{ kind: "create" }>
  | Readonly<{ kind: "files"; targetId: string }>
  | Readonly<{ kind: "live"; targetId: string }>
  | Readonly<{ kind: "tabs" }>
  | Readonly<{ kind: "open" }>
  | Readonly<{ kind: "close"; targetId: string }>
  | Readonly<{ kind: "restore"; targetId: string }>
  | Readonly<{ kind: "refused"; status: number; error: string }>;

/** What a request is, after the Host and Origin checks (F39 point 8).
 * Pure, so the checks are tested without a socket. */
export function classifyRequest(
  request: Readonly<{
    method: string;
    url: string;
    host: string | null;
    origin: string | null;
    upgrade: boolean;
    /** `Sec-Fetch-Site`: a browser sends it with every request. */
    fetchSite?: string | null;
  }>,
  viewOrigin: string,
  port: number,
): RequestDecision {
  const own = new URL(viewOrigin);
  const path = new URL(request.url, "http://view.invalid").pathname;
  const loopback =
    request.host === `127.0.0.1:${port}` ||
    request.host === `localhost:${port}`;
  if (path === "/.lazurio/health" && request.method === "GET")
    return request.host === own.host || loopback
      ? { kind: "health" }
      : { kind: "refused", status: 421, error: "wrong-host" };
  const tabs = tabsPath.exec(path);
  // A tab is named by its id in either case (decision F50, C1); any other
  // segment is no path of these requests.
  const named = tabs?.[1];
  const targetId = named === undefined ? undefined : targetIdOf(named);
  if (tabs !== null && targetId !== null) {
    // The Launchpad's requests (F47 point 6): through the gateway, which
    // sends the view's own host, they do not exist. Pages in the
    // Environment's own browser reach the loopback too, and a browser always
    // names where its request comes from.
    if (!loopback) return { kind: "refused", status: 404, error: "not-found" };
    if (request.origin !== null || (request.fetchSite ?? null) !== null)
      return { kind: "refused", status: 403, error: "browser-request" };
    if (targetId === undefined) {
      if (request.method === "GET") return { kind: "tabs" };
      if (request.method === "POST") return { kind: "open" };
      return { kind: "refused", status: 405, error: "method-not-allowed" };
    }
    if (request.method !== "POST")
      return { kind: "refused", status: 405, error: "method-not-allowed" };
    return tabs[2] === "close"
      ? { kind: "close", targetId }
      : { kind: "restore", targetId };
  }
  if (request.host !== own.host)
    return { kind: "refused", status: 421, error: "wrong-host" };
  const sameOrigin = request.origin === own.origin;
  const live = livePath.exec(path);
  if (live !== null) {
    if (request.method !== "GET" || !request.upgrade)
      return { kind: "refused", status: 426, error: "upgrade-required" };
    if (!sameOrigin)
      return { kind: "refused", status: 403, error: "wrong-origin" };
    return { kind: "live", targetId: (live[1] as string).toUpperCase() };
  }
  if (path === "/api/tabs") {
    if (request.method !== "POST")
      return { kind: "refused", status: 405, error: "method-not-allowed" };
    if (!sameOrigin)
      return { kind: "refused", status: 403, error: "wrong-origin" };
    return { kind: "create" };
  }
  const files = filesPath.exec(path);
  if (files !== null) {
    if (request.method !== "POST")
      return { kind: "refused", status: 405, error: "method-not-allowed" };
    if (!sameOrigin)
      return { kind: "refused", status: 403, error: "wrong-origin" };
    return { kind: "files", targetId: (files[1] as string).toUpperCase() };
  }
  if (request.method !== "GET" && request.method !== "HEAD")
    return { kind: "refused", status: 405, error: "method-not-allowed" };
  if (path === "/" || viewPath.test(path)) return { kind: "page" };
  if (path === "/assets/view.js") return { kind: "script" };
  return { kind: "refused", status: 404, error: "not-found" };
}

export type ViewService = Readonly<{
  server: Server<SocketData>;
  hub: BrowserHub;
  stop: () => Promise<void>;
}>;

export function startViewService(options: ViewServiceOptions): ViewService {
  const hub = new BrowserHub(options.hub);
  const identity =
    options.identity === undefined
      ? async () => null
      : pageIdentitySource(options.identity);
  const server = Bun.serve<SocketData>({
    hostname: "127.0.0.1",
    port: options.port,
    maxRequestBodySize: maxUploadBytes,
    async fetch(request, server) {
      const decision = classifyRequest(
        {
          method: request.method,
          url: request.url,
          host: request.headers.get("host"),
          origin: request.headers.get("origin"),
          upgrade:
            request.headers.get("upgrade")?.toLowerCase() === "websocket",
          fetchSite: request.headers.get("sec-fetch-site"),
        },
        options.origin,
        server.port ?? options.port,
      );
      switch (decision.kind) {
        case "refused":
          return json({ error: decision.error }, decision.status);
        case "health":
          return json(
            {
              ok: hub.connected,
              browser: hub.connected ? "connected" : "unreachable",
            },
            hub.connected ? 200 : 503,
          );
        case "page":
          // Per request: the app that asks for the page may frame it, and
          // the page names its Environment as the shell does now.
          return new Response(viewPage(await identity()), {
            headers: pageHeaders(
              options.origin,
              request.headers.get("referer"),
            ),
          });
        case "script":
          return new Response(script, {
            headers: {
              "content-type": "text/javascript; charset=utf-8",
              "cache-control": "no-cache",
              "x-content-type-options": "nosniff",
            },
          });
        case "create": {
          let size: { width: number; height: number; dpr: number } | null =
            null;
          try {
            const body = (await request.json()) as Record<string, unknown>;
            if (
              [body.width, body.height, body.dpr].every(
                (n) => typeof n === "number" && Number.isFinite(n) && n > 0,
              )
            )
              size = {
                width: body.width as number,
                height: body.height as number,
                dpr: body.dpr as number,
              };
          } catch {}
          const id = await hub.createTab(size);
          return id === null
            ? json({ error: "browser-unreachable" }, 503)
            : json({ id, view: `/t/${id}` }, 201);
        }
        case "files": {
          const token = new URL(request.url).searchParams.get("token") ?? "";
          if (!/^[0-9a-f]{24}$/.test(token))
            return json({ error: "invalid-request" }, 400);
          let files: File[];
          try {
            const form = await request.formData();
            files = form
              .getAll("file")
              .filter((value): value is File => value instanceof File);
          } catch {
            return json({ error: "invalid-request" }, 400);
          }
          const done = await hub
            .upload(decision.targetId, token, files)
            .catch(() => false);
          return done
            ? new Response(null, { status: 204 })
            : json({ error: "not-accepted" }, 409);
        }
        case "tabs":
          if (!hub.ready) return json({ error: "browser-unreachable" }, 503);
          // `heap=1` adds each tab's JavaScript heap for the Launchpad's
          // overview (F47 point 7); without it the list is as it was.
          return json({
            tabs:
              new URL(request.url).searchParams.get("heap") === "1"
                ? await hub.listWithHeap()
                : hub.list(),
          });
        case "open": {
          const body = await smallJson(request);
          const url = body?.url;
          const strip = body?.strip ?? null;
          if (
            typeof url !== "string" ||
            navigableAddress(url) === null ||
            (strip !== null && !isStrip(strip))
          )
            return json({ error: "invalid-request" }, 400);
          const id = await hub.openTab(url, strip);
          return id === null
            ? json({ error: "browser-unreachable" }, 503)
            : json({ id, view: `${options.origin}/t/${id}` }, 201);
        }
        case "close": {
          // While the hub does not know the browser's targets it changes
          // nothing (F47's failure modes); a close accepted before goes on.
          if (!hub.ready) return json({ error: "browser-unreachable" }, 503);
          const endsAt = hub.closeForEveryone(decision.targetId);
          return endsAt === null
            ? json({ error: "not-found" }, 404)
            : json({ closing: new Date(endsAt).toISOString() }, 202);
        }
        case "restore":
          if (!hub.ready) return json({ error: "browser-unreachable" }, 503);
          if (!hub.hasTab(decision.targetId))
            return json({ error: "not-found" }, 404);
          return hub.restore(decision.targetId)
            ? json({ restored: true })
            : json({ error: "nothing-to-restore" }, 409);
        case "live": {
          // Upgraded even for a tab that is gone: the page can read a
          // message, not the status of a refused handshake (`open`).
          const upgraded = server.upgrade(request, {
            data: { targetId: decision.targetId, viewer: null },
          });
          return upgraded ? undefined : json({ error: "upgrade-failed" }, 400);
        }
      }
    },
    websocket: {
      perMessageDeflate: false,
      maxPayloadLength: 2 * 1024 * 1024,
      backpressureLimit: 64 * 1024 * 1024,
      closeOnBackpressureLimit: true,
      open(ws: ServerWebSocket<SocketData>) {
        const viewer: Viewer = {
          send: (message) => {
            ws.send(JSON.stringify(message));
          },
          sendFrame: (frame) => {
            ws.send(frame);
          },
          buffered: () => ws.getBufferedAmount(),
          close: () => ws.close(1000, "closed"),
          size: null,
          resize: true,
        };
        ws.data.viewer = viewer;
        if (hub.attach(ws.data.targetId, viewer)) return;
        // No such tab. Only a hub that knows every page may say it is gone;
        // while it reconnects to the browser the page tries again.
        ws.data.viewer = null;
        if (hub.ready) {
          viewer.send({ t: "closed" });
          ws.close(1000, "closed");
        } else {
          viewer.send({ t: "browser", state: "reconnecting" });
          ws.close(1013, "reconnecting");
        }
      },
      message(ws: ServerWebSocket<SocketData>, data) {
        const viewer = ws.data.viewer;
        if (viewer === null || typeof data !== "string") return;
        const message = parseClientMessage(data);
        if (message === null) return;
        void hub.handle(ws.data.targetId, viewer, message).catch((error) => {
          options.log(`message failed: ${String(error)}`);
        });
      },
      drain(ws: ServerWebSocket<SocketData>) {
        hub.drained(ws.data.targetId);
      },
      close(ws: ServerWebSocket<SocketData>) {
        const viewer = ws.data.viewer;
        if (viewer !== null) hub.detach(ws.data.targetId, viewer);
      },
    },
  });
  hub.start();
  options.log(
    `people's view of the Environment browser on 127.0.0.1:${server.port} for ${options.origin}`,
  );
  return Object.freeze({
    server,
    hub,
    stop: async () => {
      hub.stop();
      await server.stop(true);
    },
  });
}

/** A small JSON object body, or null. */
async function smallJson(
  request: Request,
): Promise<Record<string, unknown> | null> {
  try {
    const text = await request.text();
    if (text.length > maxTabsBodyBytes) return null;
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** The production connection: the browser target on the loopback DevTools
 * port, asked again on every reconnect (a restarted browser has a new id). */
export const loopbackBrowser =
  (cdpPort: number): (() => Promise<CdpConnection>) =>
  async () =>
    connectCdp(await browserSocketUrl(cdpPort));
