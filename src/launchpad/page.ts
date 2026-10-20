import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HTMLBundle } from "bun";
import { shellScript } from "../shell/bundle" with { type: "macro" };
import { shellFontPaths } from "../shell/font-files";
import { newTabPagePath } from "../shell/new-tab-protocol";
import { stoneFilePaths } from "../shell/stone-files";
import { guideVideoRoutes } from "./guide-video-files";
import { notModified } from "./http-conditions";
import index from "./index.html";
import newTabPage from "./new-tab.html";
import { pagePaths } from "./routes";

/** `/.lazurio/shell.js` (decision F36), built into this executable. */
export const shellSource: string = shellScript();

/** The script's ETag: the forks load it on every page load and revalidate
 * it (`no-cache`), so an unchanged script answers 304 without its body (F36's
 * addendum of 2026-10-08). */
export const shellEtag = `"${createHash("sha256").update(shellSource).digest("hex").slice(0, 32)}"`;

const assetHeaders = {
  "Cache-Control": "no-cache",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

// The Lazurio shell's static assets (decision F36): the script with the
// elements, the brand fonts and the module stones, on every origin of the Environment the
// Launchpad answers. Like the page's own assets they carry nothing of the
// Folder and no credential: locally they are served without the token, as
// the page is; hosted only after the gateway's admission, through the same
// inner listener as the page.
export const shellRoutes = {
  "/.lazurio/shell.js": (request: Request) =>
    notModified(request, shellEtag)
      ? new Response(null, {
          status: 304,
          headers: { ...assetHeaders, ETag: shellEtag },
        })
      : new Response(shellSource, {
          headers: {
            ...assetHeaders,
            ETag: shellEtag,
            "Content-Type": "text/javascript; charset=utf-8",
          },
        }),
  "/.lazurio/fonts/:file": (
    request: Request & { params: { file: string } },
  ) => {
    const file = request.params.file;
    if (!Object.hasOwn(shellFontPaths, file))
      return new Response("not-found", { status: 404 });
    return new Response(
      Bun.file(shellFontPaths[file as keyof typeof shellFontPaths]),
      {
        headers: {
          ...assetHeaders,
          "Cache-Control": "public, max-age=604800, immutable",
          "Content-Type": "font/woff2",
        },
      },
    );
  },
  "/.lazurio/stones/:file": (
    request: Request & { params: { file: string } },
  ) => {
    const file = request.params.file;
    if (!Object.hasOwn(stoneFilePaths, file))
      return new Response("not-found", { status: 404 });
    return new Response(Bun.file(stoneFilePaths[file] as string), {
      headers: {
        ...assetHeaders,
        "Cache-Control": "public, max-age=604800, immutable",
        "Content-Type": "image/png",
      },
    });
  },
};

/** `Cache-Control` of the bundled pages' content-hashed files (#532): a
 * name that carries a hash of the file's content changes with the content,
 * so a browser keeps such a file a year without asking again. */
export const bundledFileCaching = "public, max-age=31536000, immutable";

/** Whether a bundled file's name proves a hash of its content, as Bun 1.4.2
 * names a page's output in the compiled executable: `chunk-<hash>.<ext>`
 * for the script and style chunks and `<name>-<hash>.<ext>` for a file the
 * page imports (`symbol-color-j5ttq22m.svg`), the hash eight characters of
 * lowercase Crockford base32 (digits and letters without i, l, o and u),
 * the file directly beside its page. Checked against a compiled candidate
 * on 2026-10-20; the compiled test fails should a listed file stop matching.
 * Anything else, a nested path or a name without that hash, is not one. */
export function contentHashedName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]*-[0-9a-hjkmnp-tv-z]{8}\.[a-z0-9]+$/.test(
    name,
  );
}

/** The paths under which the inner listener serves the bundled pages'
 * content-hashed files (`contentHashedName`): the script and style chunks and
 * the images (`/chunk-….js`), never a page and never a file whose name does
 * not prove its content. Bun lists them for a build made ahead of time, which
 * is what the compiled executable is; it serves them without any
 * `Cache-Control`. Run from source it lists none, and its runtime bundle
 * sends `bundledFileCaching` itself. */
export function bundledFilePaths(
  bundles: readonly HTMLBundle[],
): ReadonlySet<string> {
  const paths = new Set<string>();
  for (const bundle of bundles) {
    const separator = Math.max(
      bundle.index.lastIndexOf("/"),
      bundle.index.lastIndexOf("\\"),
    );
    const root = bundle.index.slice(0, separator + 1);
    for (const file of bundle.files ?? []) {
      if (file.loader === "html" || !file.path.startsWith(root)) continue;
      const name = file.path.slice(root.length);
      if (contentHashedName(name)) paths.add(`/${name}`);
    }
  }
  return paths;
}

const bundledFiles = bundledFilePaths([index, newTabPage]);

/** The `Cache-Control` the gateway's path gives an asset the inner listener
 * answered (`path` with or without its query; F36's addendum of 2026-10-08,
 * #532): a year for one of the bundle's content-hashed files, whatever the
 * inner listener said; otherwise the inner listener's own; otherwise
 * `no-store`. */
export function assetCaching(
  path: string,
  inner: string | null,
  hashed: ReadonlySet<string> = bundledFiles,
): string {
  if (hashed.has(path.split("?", 1)[0] as string)) return bundledFileCaching;
  return inner ?? "no-store";
}

// The page itself under each of its routes (`/`, `/settings/tools`, …): the
// same bundled document, which picks the section from the path. No other
// path serves it, and none of them carries or needs the credential. It needs
// nothing of the Folder, so Recovery mode serves it too. Beside it Nová
// karta's own page (decision F47 point 1), `/new-tab`, which the shell
// element `<lazurio-new-tab>` frames in every app's right panel.
export const pageRoutes = {
  ...Object.fromEntries(pagePaths.map((path) => [path, index])),
  [newTabPagePath]: newTabPage,
  ...shellRoutes,
  ...guideVideoRoutes,
};

// A private unix socket under a fresh private temporary directory: no ambient
// HTTP proxy of the process environment (HTTP_PROXY, ALL_PROXY) can stand in
// for it, and nothing else on the Machine can reach it by port.
async function pageSocket(prefix: string, version?: string) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  const socket = join(directory, "page.sock");
  const server = Bun.serve({
    unix: socket,
    development: false,
    routes: pageRoutes,
    fetch: (request) =>
      version !== undefined &&
      new URL(request.url).pathname === "/health" &&
      request.method === "GET"
        ? Response.json({ version })
        : new Response("not-found", { status: 404 }),
  });
  return {
    get: (path: string, init: RequestInit = {}) =>
      fetch(`http://launchpad.invalid${path}`, { ...init, unix: socket }),
    async stop() {
      await server.stop(true);
      await rm(directory, { recursive: true, force: true });
    },
  };
}

/** The page of this executable on a private unix socket, asked by
 * `operation` and closed again: how a start and a candidate's probe learn
 * that the bundle serves, without a port and without writing anything but the
 * socket in a private temporary directory. */
export async function privatePage<T>(
  operation: (get: (path: string) => Promise<Response>) => Promise<T>,
  version?: string,
): Promise<T> {
  const page = await pageSocket("lazurio-page-", version);
  try {
    return await operation((path) => page.get(path));
  } finally {
    await page.stop();
  }
}

/** The inner listener of a Launchpad whose page is served only after an
 * admission: the caller proxies a GET to it once the request is admitted, so
 * nothing answers an unadmitted browser — not even the shell. */
export async function serveShell() {
  const page = await pageSocket("lazurio-shell-");
  return {
    /** The page or an asset for `path` (with its query), as the browser
     * asked for it. */
    get: (path: string, accept: string | null) =>
      page.get(path, { headers: { accept: accept ?? "*/*" } }),
    stop: page.stop,
  };
}

/** A local request with the Launchpad's credential: a browser sends no Origin
 * header with a same-origin GET; the bearer token of the terminal link is the
 * credential, and the Host must be this listener's own (no DNS rebinding). */
export function admitLocal(
  request: Request,
  origin: string,
  token: string,
): boolean {
  const url = new URL(request.url);
  const sameOrigin =
    request.headers.get("origin") === origin ||
    (request.method === "GET" && !request.headers.has("origin"));
  return (
    url.origin === origin &&
    request.headers.get("host") === new URL(origin).host &&
    sameOrigin &&
    request.headers.get("authorization") === `Bearer ${token}`
  );
}
