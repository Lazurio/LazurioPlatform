import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import index from "./index.html";
import { pagePaths } from "./routes";

// The page itself under each of its routes (`/`, `/settings/tools`, …): the
// same bundled document, which picks the section from the path. No other
// path serves it, and none of them carries or needs the credential. It needs
// nothing of the Folder, so Recovery mode serves it too.
export const pageRoutes = Object.fromEntries(
  pagePaths.map((path) => [path, index]),
);

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
