import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import { shellFontPaths } from "../../shell/font-files";
import {
  type Checked,
  checkClarifyAnswer,
  checkEmptyBody,
  checkErrorBody,
  checkEventsQuery,
  checkHistoryPage,
  checkHistoryQuery,
  checkMessageAccepted,
  checkMessageRequest,
  isMimeType,
  isRuntimeId,
  type RuntimeErrorCode,
  runtimeErrors,
  runtimeLimits,
} from "../contract/runtime";
import type { BuddyFrameConfig } from "./config";
import { personaFileOf, readAdapterSecret, readBuddyName } from "./files";
import { frameAncestors } from "./hosts";
import framePage from "./page/index.html";
import signedInPage from "./page/signed-in.html";
import avatarFile from "./vendor/mattycus-idle.png" with { type: "file" };

// Buddy's frame on the Osobní Prostředí (buddy-web-v1 CONTRACT section 4): a
// loopback listener behind the gateway's route `buddy.<slug>`, served by the
// Launchpad's process. Only the owner passes that gateway, so a request that
// reaches it is the owner's; the frame still keeps every rule a page of the
// person's own needs:
//   - the page and `/signed-in` from the bundle, with a CSP of this origin
//     only and `frame-ancestors` exactly the host that asks (hosts.ts);
//   - `/api/v1/*` to the Hermes `lazurio_web` adapter on loopback with the
//     bearer secret from its 0600 file, which no response ever carries, every
//     body and answer checked against `lazurio.buddy-runtime.v1`;
//   - a write only same-origin by Fetch Metadata and the exact Origin; an
//     API read only same-origin, never embedded by another page;
//   - the event stream passed through and closed within 110 s, so every
//     reconnect passes the gateway again;
//   - Buddy's name from his persona and his avatar.

/** The frame's own errors, beside the adapter's. */
export const frameErrors = Object.freeze({
  "host-mismatch": 421,
  "origin-mismatch": 403,
  "adapter-unreachable": 502,
  "adapter-refused": 502,
  "adapter-defective": 502,
  "secret-unavailable": 503,
} as const);
export type FrameErrorCode = keyof typeof frameErrors;

/** Trusted composition, never HTTP input. */
export type BuddyFrameSeams = Readonly<{
  /** Buddy's persona; by default `~/.config/lazurio/buddy/persona.json`. */
  personaFile?: string;
  /** The account that must own the secret file; by default this process's. */
  uid?: number;
  /** How the adapter is asked; by default `fetch`. */
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  /** The longest a browser's event stream stays open; by default 110 s. */
  streamMs?: number;
}>;

const pageCsp = (ancestors: string) =>
  [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' blob: data:",
    "font-src 'self'",
    "connect-src 'self'",
    "media-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-src 'none'",
    `frame-ancestors ${ancestors}`,
  ].join("; ");

const apiHeaders = Object.freeze({
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Cross-Origin-Resource-Policy": "same-origin",
});

function problem(code: RuntimeErrorCode | FrameErrorCode): Response {
  const status =
    code in frameErrors
      ? frameErrors[code as FrameErrorCode]
      : runtimeErrors[code as RuntimeErrorCode];
  return Response.json({ error: { code } }, { status, headers: apiHeaders });
}

const answer = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: apiHeaders });

/** At most `max` bytes of a body, or null when there are more. */
async function readBounded(
  body: ReadableStream<Uint8Array> | null,
  max: number,
): Promise<Uint8Array | null> {
  if (body === null) return new Uint8Array();
  const reader = body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    parts.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}

async function readJson(
  body: ReadableStream<Uint8Array> | null,
  max: number,
): Promise<{ ok: true; value: unknown } | { ok: false; tooLarge: boolean }> {
  const bytes = await readBounded(body, max);
  if (bytes === null) return { ok: false, tooLarge: true };
  try {
    return {
      ok: true,
      value: JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      ),
    };
  } catch {
    return { ok: false, tooLarge: false };
  }
}

/** The bundle's two pages on a private unix socket, as the Launchpad's own
 * page is served (src/launchpad/page.ts): asked only by this process. */
async function framePages() {
  const directory = await mkdtemp(join(tmpdir(), "lazurio-buddy-"));
  const socket = join(directory, "page.sock");
  const server = Bun.serve({
    unix: socket,
    development: false,
    routes: { "/": framePage, "/signed-in": signedInPage },
    fetch: () => new Response("not-found", { status: 404 }),
  });
  return {
    get: (path: string, accept: string | null) =>
      fetch(`http://buddy.invalid${path}`, {
        unix: socket,
        headers: { accept: accept ?? "*/*" },
      }),
    async stop() {
      await server.stop(true);
      await rm(directory, { recursive: true, force: true });
    },
  };
}

type Pages = Awaited<ReturnType<typeof framePages>>;

/** The adapter's own error, passed on when the frame may show it; a refusal
 * of the frame itself (its secret, its Host, a route it never asks) is the
 * frame's fault, not the person's, and never reads as signed out. */
async function adapterError(upstream: Response): Promise<Response> {
  const body = await readJson(upstream.body, 64 * 1024);
  const checked = body.ok ? checkErrorBody(body.value) : null;
  if (
    checked === null ||
    !checked.ok ||
    runtimeErrors[checked.value.error.code] !== upstream.status
  )
    return problem("adapter-defective");
  const code = checked.value.error.code;
  return code === "unauthorized" ||
    code === "forbidden" ||
    code === "method-not-allowed"
    ? problem("adapter-refused")
    : problem(code);
}

const inlineImages = /^image\/(?:png|jpeg|gif|webp)$/;

export function createBuddyFrameHandler(
  config: BuddyFrameConfig,
  pages: Pages,
  seams: BuddyFrameSeams = {},
) {
  const host = new URL(config.origin).host;
  const personaFile = seams.personaFile ?? personaFileOf(homedir());
  const uid = seams.uid ?? process.getuid?.() ?? -1;
  const fetcher = seams.fetch ?? ((url, init) => fetch(url, init));
  const streamMs = seams.streamMs ?? runtimeLimits.streamSeconds * 1000;
  const adapterBase = `http://127.0.0.1:${config.adapterPort}`;

  /** A request to the adapter with its secret; a Response when it cannot
   * be made. */
  async function adapter(
    path: string,
    init: Readonly<{
      method: "GET" | "POST";
      body?: string;
      accept?: string;
      signal?: AbortSignal;
    }>,
  ): Promise<Response | { upstream: Response }> {
    const secret = await readAdapterSecret(config.secretFile, uid);
    if (secret === null) return problem("secret-unavailable");
    const headers: Record<string, string> = {
      authorization: `Bearer ${secret}`,
      accept: init.accept ?? "application/json",
    };
    if (init.body !== undefined) headers["content-type"] = "application/json";
    try {
      const upstream = await fetcher(`${adapterBase}${path}`, {
        method: init.method,
        headers,
        redirect: "manual",
        ...(init.body === undefined ? {} : { body: init.body }),
        ...(init.signal === undefined ? {} : { signal: init.signal }),
      });
      return { upstream };
    } catch {
      return problem("adapter-unreachable");
    }
  }

  /** A JSON exchange: the answer checked by `check` at the adapter's status
   * `expected`, or its error. */
  async function exchange(
    path: string,
    init: Readonly<{ method: "GET" | "POST"; body?: string }>,
    expected: number,
    check: (input: unknown) => Checked<unknown>,
    max: number,
  ): Promise<Response> {
    const asked = await adapter(path, init);
    if (asked instanceof Response) return asked;
    const { upstream } = asked;
    if (upstream.status >= 400) return adapterError(upstream);
    if (upstream.status !== expected) {
      await upstream.body?.cancel().catch(() => undefined);
      return problem("adapter-defective");
    }
    const body = await readJson(upstream.body, max);
    if (!body.ok) return problem("adapter-defective");
    const checked = check(body.value);
    return checked.ok
      ? answer(checked.value, expected)
      : problem("adapter-defective");
  }

  /** A request body, parsed and checked before anything reaches Buddy. */
  async function requestBody<T>(
    request: Request,
    max: number,
    check: (input: unknown) => Checked<T>,
  ): Promise<T | Response> {
    const body = await readJson(request.body, max);
    if (!body.ok)
      return problem(body.tooLarge ? "payload-too-large" : "bad-request");
    const checked = check(body.value);
    return checked.ok ? checked.value : problem("bad-request");
  }

  async function events(
    request: Request,
    url: URL,
    server: Server<undefined>,
  ): Promise<Response> {
    const query = checkEventsQuery(url.search.slice(1));
    if (!query.ok) return problem("bad-request");
    const lastEventId = request.headers.get("last-event-id");
    const after =
      query.value.after ??
      (lastEventId !== null && isRuntimeId(lastEventId) ? lastEventId : null);
    // The stream lives up to its bound, never on Bun's idle timer.
    server.timeout(request, 0);
    const stop = new AbortController();
    request.signal.addEventListener("abort", () => stop.abort(), {
      once: true,
    });
    // The bound runs from the request, so an adapter that never answers
    // holds nothing longer either.
    const deadline = setTimeout(() => stop.abort(), streamMs);
    const asked = await adapter(
      `/v1/events${after === null ? "" : `?after=${encodeURIComponent(after)}`}`,
      { method: "GET", accept: "text/event-stream", signal: stop.signal },
    );
    if (asked instanceof Response) {
      clearTimeout(deadline);
      return asked;
    }
    const { upstream } = asked;
    if (upstream.status >= 400) {
      clearTimeout(deadline);
      return adapterError(upstream);
    }
    const type = upstream.headers.get("content-type") ?? "";
    if (
      upstream.status !== 200 ||
      upstream.body === null ||
      !type.startsWith("text/event-stream")
    ) {
      clearTimeout(deadline);
      await upstream.body?.cancel().catch(() => undefined);
      return problem("adapter-defective");
    }
    const source = upstream.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await source.read();
          if (done) {
            clearTimeout(deadline);
            controller.close();
          } else controller.enqueue(value);
        } catch {
          // The bound, the browser leaving or the adapter ending: the stream
          // ends, and the browser reconnects after its last whole event.
          clearTimeout(deadline);
          try {
            controller.close();
          } catch {
            // Already closed.
          }
        }
      },
      cancel() {
        clearTimeout(deadline);
        stop.abort();
      },
    });
    return new Response(body, {
      status: 200,
      headers: {
        ...apiHeaders,
        "Content-Type": "text/event-stream; charset=utf-8",
        "X-Accel-Buffering": "no",
      },
    });
  }

  async function media(id: string): Promise<Response> {
    const asked = await adapter(`/v1/media/${encodeURIComponent(id)}`, {
      method: "GET",
      accept: "*/*",
    });
    if (asked instanceof Response) return asked;
    const { upstream } = asked;
    if (upstream.status >= 400) return adapterError(upstream);
    if (upstream.status !== 200) {
      await upstream.body?.cancel().catch(() => undefined);
      return problem("adapter-defective");
    }
    const given = (upstream.headers.get("content-type") ?? "")
      .split(";", 1)[0]
      ?.trim()
      .toLowerCase();
    const type = isMimeType(given) ? given : "application/octet-stream";
    // Only a picture shows in place; anything else, HTML above all, is a
    // download that runs nothing on this origin.
    return new Response(upstream.body, {
      status: 200,
      headers: {
        ...apiHeaders,
        "Cache-Control": "private, max-age=3600",
        "Content-Type": type,
        "Content-Disposition": inlineImages.test(type)
          ? "inline"
          : "attachment",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      },
    });
  }

  async function api(
    request: Request,
    url: URL,
    server: Server<undefined>,
  ): Promise<Response> {
    const write = request.method !== "GET" && request.method !== "HEAD";
    const site = request.headers.get("sec-fetch-site");
    // Reads only from this origin's own page (or no browser at all); writes
    // only from it, by Fetch Metadata and the exact Origin.
    if (
      write
        ? site !== "same-origin" ||
          request.headers.get("origin") !== config.origin
        : site !== null && site !== "same-origin"
    )
      return problem("origin-mismatch");
    const path = url.pathname;
    if (path === "/api/persona" && request.method === "GET")
      return answer({ name: await readBuddyName(personaFile) });
    if (path === "/api/v1/history" && request.method === "GET") {
      const query = checkHistoryQuery(url.search.slice(1));
      if (!query.ok) return problem("bad-request");
      return exchange(
        `/v1/history${url.search}`,
        { method: "GET" },
        200,
        checkHistoryPage,
        8 * 1024 * 1024,
      );
    }
    if (path === "/api/v1/events" && request.method === "GET")
      return events(request, url, server);
    if (path === "/api/v1/messages" && request.method === "POST") {
      const body = await requestBody(
        request,
        runtimeLimits.messageBodyBytes,
        checkMessageRequest,
      );
      if (body instanceof Response) return body;
      return exchange(
        "/v1/messages",
        { method: "POST", body: JSON.stringify(body) },
        202,
        checkMessageAccepted,
        64 * 1024,
      );
    }
    const clarify = /^\/api\/v1\/clarify\/([^/]+)$/.exec(path);
    if (clarify !== null && request.method === "POST") {
      const id = decodeURIComponent(clarify[1] as string);
      if (!isRuntimeId(id)) return problem("not-found");
      const body = await requestBody(
        request,
        runtimeLimits.smallBodyBytes,
        checkClarifyAnswer,
      );
      if (body instanceof Response) return body;
      return exchange(
        `/v1/clarify/${encodeURIComponent(id)}`,
        { method: "POST", body: JSON.stringify(body) },
        202,
        checkEmptyBody,
        64 * 1024,
      );
    }
    if (path === "/api/v1/stop" && request.method === "POST") {
      const body = await requestBody(
        request,
        runtimeLimits.smallBodyBytes,
        checkEmptyBody,
      );
      if (body instanceof Response) return body;
      return exchange(
        "/v1/stop",
        { method: "POST", body: "{}" },
        202,
        checkEmptyBody,
        64 * 1024,
      );
    }
    const file = /^\/api\/v1\/media\/([^/]+)$/.exec(path);
    if (file !== null && request.method === "GET") {
      const id = decodeURIComponent(file[1] as string);
      return isRuntimeId(id) ? media(id) : problem("not-found");
    }
    return problem("not-found");
  }

  async function page(request: Request, url: URL): Promise<Response> {
    const path = url.pathname;
    const inner = await pages.get(path, request.headers.get("accept"));
    const ancestors =
      path === "/"
        ? frameAncestors(
            config.origin,
            request.headers.get("referer"),
            url.searchParams.get("host"),
          )
        : "'none'";
    return new Response(request.method === "HEAD" ? null : inner.body, {
      status: inner.status,
      headers: {
        "Content-Type":
          inner.headers.get("content-type") ?? "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy": pageCsp(ancestors),
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
      },
    });
  }

  async function asset(request: Request, path: string): Promise<Response> {
    const inner = await pages.get(path, request.headers.get("accept"));
    if (!inner.ok) {
      await inner.body?.cancel().catch(() => undefined);
      return new Response("not-found", {
        status: 404,
        headers: { "X-Content-Type-Options": "nosniff" },
      });
    }
    const type =
      inner.headers.get("content-type") ?? "application/octet-stream";
    if (type.startsWith("text/html")) {
      // No path other than the two pages serves a document.
      await inner.body?.cancel().catch(() => undefined);
      return new Response("not-found", { status: 404 });
    }
    return new Response(request.method === "HEAD" ? null : inner.body, {
      headers: {
        "Content-Type": type,
        "Cache-Control": inner.headers.get("cache-control") ?? "no-cache",
        "X-Content-Type-Options": "nosniff",
        "Cross-Origin-Resource-Policy": "same-origin",
        ...(inner.headers.get("etag") === null
          ? {}
          : { ETag: inner.headers.get("etag") as string }),
      },
    });
  }

  return async function handle(
    request: Request,
    server: Server<undefined>,
  ): Promise<Response> {
    if (request.headers.get("host") !== host) return problem("host-mismatch");
    const url = new URL(request.url);
    const path = url.pathname;
    if (path.startsWith("/api/")) return api(request, url, server);
    if (request.method !== "GET" && request.method !== "HEAD")
      return new Response("method-not-allowed", { status: 405 });
    if (path === "/" || path === "/signed-in") return page(request, url);
    if (path === "/assets/avatar.webp")
      // Its stable address for the shell's launcher; its bytes the design
      // system's PNG (vendor/README.md), named by their true type.
      return new Response(
        request.method === "HEAD" ? null : Bun.file(avatarFile),
        {
          headers: {
            "Content-Type": "image/png",
            "Cache-Control": "public, max-age=86400",
            "X-Content-Type-Options": "nosniff",
            "Cross-Origin-Resource-Policy": "same-site",
          },
        },
      );
    const font = /^\/fonts\/([a-z0-9-]+\.woff2)$/.exec(path)?.[1];
    if (font !== undefined) {
      if (!Object.hasOwn(shellFontPaths, font))
        return new Response("not-found", { status: 404 });
      return new Response(
        request.method === "HEAD"
          ? null
          : Bun.file(shellFontPaths[font as keyof typeof shellFontPaths]),
        {
          headers: {
            "Content-Type": "font/woff2",
            "Cache-Control": "public, max-age=604800, immutable",
            "X-Content-Type-Options": "nosniff",
            "Cross-Origin-Resource-Policy": "same-origin",
          },
        },
      );
    }
    // The bundle's own files: scripts, styles, the icon.
    if (/^\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(path))
      return asset(request, path);
    return new Response("not-found", { status: 404 });
  };
}

export type BuddyFrame = Readonly<{
  port: number;
  stop: () => Promise<void>;
}>;

/** The frame's listener on `127.0.0.1:<listenPort>`. */
export async function startBuddyFrame(
  config: BuddyFrameConfig,
  seams: BuddyFrameSeams = {},
): Promise<BuddyFrame> {
  const pages = await framePages();
  const handle = createBuddyFrameHandler(config, pages, seams);
  let server: Server<undefined>;
  try {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: config.listenPort,
      development: false,
      // A message with its attachments, base64 in JSON, and a little more.
      maxRequestBodySize: runtimeLimits.messageBodyBytes + 64 * 1024,
      fetch: handle,
    });
  } catch (error) {
    await pages.stop();
    throw error;
  }
  return Object.freeze({
    port: server.port ?? config.listenPort,
    async stop() {
      await server.stop(true);
      await pages.stop();
    },
  });
}
