// The Platform's static server of a built app (decision F58, root decision
// 0195 point 19). It is written out by the Platform beside its build cache
// and run by the operator's Bun as the app's one process, through the app's
// runner and on its declared listener, like any module app: so it imports
// nothing but Node's and Bun's own modules.
//
// The Platform only writes it out and runs it, never imports it: Bun gives a
// file of a compiled product one loader, and the Platform embeds this one's
// text. So the Platform asks it too whether a build can be served
// (`--check`), and the same resolution decides both.
//
// It serves one immutable build directory: GET and HEAD only, nothing it
// cannot prove lies inside that directory, no directory listings. HTML is
// revalidated on every load (`no-cache`); the files a framework names by
// their content (`/_astro/`, Vite's `/assets/`) are kept a year. A file that
// is missing from this build but was in the previous one (an asset of a page
// opened before the swap) is served from the previous build.
//
// Which build it serves is the record of what the app serves, `served.json`
// beside its builds: read at its start and again, before a request, whenever
// the file changed (a new file: the Platform replaces it whole by a rename).
// So a swap onto a new build is the Platform writing that record; this
// process and its listener stay, and no connection is refused (decision F58
// point 6).
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, sep } from "node:path";

export type StaticFallback = "404" | "spa";

export type StaticResolution = Readonly<
  | { kind: "file"; path: string; status: 200 | 404 }
  | { kind: "redirect"; location: string }
  | { kind: "missing" }
  | { kind: "refused" }
>;

/** Content-named files of the frameworks of static apps: Astro writes every
 * bundled file under `/_astro/` with its hash in the name, Vite under
 * `/assets/` (its default `build.assetsDir`). */
const immutablePrefixes = ["/_astro/", "/assets/"];

/** The path segments of a request path, decoded; null when one of them could
 * name something outside the root or is not text. */
function segmentsOf(pathname: string): string[] | null {
  if (!pathname.startsWith("/")) return null;
  const segments: string[] = [];
  for (const raw of pathname.slice(1).split("/")) {
    let segment: string;
    try {
      segment = decodeURIComponent(raw);
    } catch {
      return null;
    }
    if (
      segment === "." ||
      segment === ".." ||
      segment.includes("/") ||
      segment.includes("\\") ||
      segment.includes("\0")
    )
      return null;
    segments.push(segment);
  }
  return segments;
}

/** A regular file inside the root whose real path is `base` (no link leads
 * out of it), or null. */
async function fileInside(base: string, path: string): Promise<string | null> {
  try {
    const entry = await lstat(path);
    if (!entry.isFile()) return null;
    const real = await realpath(path);
    return real.startsWith(`${base}${sep}`) ? real : null;
  } catch {
    return null;
  }
}

/** Which file of `root` answers `pathname`: the exact file, then
 * `<path>.html`, then `<path>/index.html` (for a path without its slash, a
 * redirect to it, as static hosts do); a path ending in `/` is its
 * `index.html`. Without one: the fallback. `spa` answers every path whose
 * last segment has no extension with the root's `index.html`; `404` answers
 * with the root's `404.html` and status 404 when the build has one. */
export async function resolveStaticRequest(
  root: string,
  pathname: string,
  fallback: StaticFallback,
): Promise<StaticResolution> {
  const segments = segmentsOf(pathname);
  if (segments === null) return { kind: "refused" };
  let base: string;
  try {
    base = await realpath(root);
  } catch {
    return { kind: "missing" };
  }
  const directoryRequest = pathname.endsWith("/");
  const named = join(root, ...segments);
  if (directoryRequest) {
    const index = await fileInside(base, join(named, "index.html"));
    if (index !== null) return { kind: "file", path: index, status: 200 };
  } else {
    const exact = await fileInside(base, named);
    if (exact !== null) return { kind: "file", path: exact, status: 200 };
    const html = await fileInside(base, `${named}.html`);
    if (html !== null) return { kind: "file", path: html, status: 200 };
    const index = await fileInside(base, join(named, "index.html"));
    if (index !== null) return { kind: "redirect", location: `${pathname}/` };
  }
  const last = segments.at(-1) ?? "";
  if (fallback === "spa" && !last.includes(".")) {
    const index = await fileInside(base, join(root, "index.html"));
    if (index !== null) return { kind: "file", path: index, status: 200 };
  }
  if (fallback === "404") {
    const missing = await fileInside(base, join(root, "404.html"));
    if (missing !== null) return { kind: "file", path: missing, status: 404 };
  }
  return { kind: "missing" };
}

const textHeaders = {
  "Content-Type": "text/plain; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
};

export type StaticServerOptions = Readonly<{
  hostname: string;
  port: number;
  root: string;
  previous?: string | undefined;
  fallback: StaticFallback;
}>;

/** One request of the server: exported for its tests. */
export async function answerStatic(
  request: Request,
  options: Omit<StaticServerOptions, "hostname" | "port">,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD")
    return new Response("Method not allowed\n", {
      status: 405,
      headers: { ...textHeaders, Allow: "GET, HEAD" },
    });
  const url = new URL(request.url);
  let resolved = await resolveStaticRequest(
    options.root,
    url.pathname,
    options.fallback,
  );
  // An asset of a page loaded before the swap: the previous build's file,
  // never its pages or its fallback.
  const asset =
    /\.[A-Za-z0-9]+$/.test(url.pathname) && !/\.html?$/.test(url.pathname);
  if (
    options.previous !== undefined &&
    asset &&
    (resolved.kind === "missing" ||
      (resolved.kind === "file" && resolved.status === 404))
  ) {
    const earlier = await resolveStaticRequest(
      options.previous,
      url.pathname,
      "404",
    );
    if (earlier.kind === "file" && earlier.status === 200) resolved = earlier;
  }
  if (resolved.kind === "refused")
    return new Response("Bad request\n", { status: 400, headers: textHeaders });
  if (resolved.kind === "missing")
    return new Response("Not found\n", { status: 404, headers: textHeaders });
  if (resolved.kind === "redirect")
    return new Response(null, {
      status: 308,
      headers: { Location: `${resolved.location}${url.search}` },
    });
  const file = Bun.file(resolved.path);
  const info = await stat(resolved.path);
  const tag = `"${info.size.toString(16)}-${Math.trunc(info.mtimeMs).toString(16)}"`;
  const html = resolved.path.endsWith(".html");
  const headers: Record<string, string> = {
    "Content-Type": file.type,
    "X-Content-Type-Options": "nosniff",
    ETag: tag,
    "Last-Modified": info.mtime.toUTCString(),
    "Cache-Control":
      !html &&
      resolved.status === 200 &&
      immutablePrefixes.some((prefix) => url.pathname.startsWith(prefix))
        ? "public, max-age=31536000, immutable"
        : "no-cache",
  };
  if (resolved.status === 200 && request.headers.get("If-None-Match") === tag)
    return new Response(null, { status: 304, headers });
  if (request.method === "HEAD")
    return new Response(null, {
      status: resolved.status,
      headers: { ...headers, "Content-Length": String(info.size) },
    });
  return new Response(file, { status: resolved.status, headers });
}

/** The build directories a `served.json` names: its `key` (and its
 * `previous` key) beside it. */
type Roots = Readonly<{ root: string; previous?: string }>;
const keyPattern = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/** The roots of the record at `file`, read again only when the file is
 * another one (its inode, size or time changed). A record that names no
 * build (the app is about to be stopped for its development version) or
 * cannot be read keeps the last roots; without any, it throws. */
export function servedRoots(file: string): () => Promise<Roots> {
  const directory = dirname(file);
  let seen: string | null = null;
  let roots: Roots | null = null;
  const read = async (): Promise<Roots> => {
    const entry = await stat(file);
    const mark = `${entry.ino}:${entry.size}:${entry.mtimeMs}`;
    if (mark !== seen) {
      // Seen only once read and parsed: a read that fails now (a transient
      // error, a permission) is tried again at the next request.
      const value = JSON.parse(await readFile(file, "utf8")) as Record<
        string,
        unknown
      >;
      seen = mark;
      if (
        value.mode === "built" &&
        typeof value.key === "string" &&
        keyPattern.test(value.key)
      )
        roots = Object.freeze({
          root: join(directory, value.key),
          ...(typeof value.previous === "string" &&
          keyPattern.test(value.previous) &&
          value.previous !== value.key
            ? { previous: join(directory, value.previous) }
            : {}),
        });
    }
    if (roots === null) throw new Error("No build to serve");
    return roots;
  };
  return async () => {
    try {
      return await read();
    } catch (error) {
      if (roots !== null) return roots;
      throw error;
    }
  };
}

export function serveStatic(
  options: Readonly<{
    hostname: string;
    port: number;
    fallback: StaticFallback;
    roots: () => Promise<Roots>;
  }>,
) {
  return Bun.serve({
    hostname: options.hostname,
    port: options.port,
    development: false,
    fetch: (request) =>
      options
        .roots()
        .then((roots) =>
          answerStatic(request, { ...roots, fallback: options.fallback }),
        )
        .catch(
          () =>
            new Response("Internal error\n", {
              status: 500,
              headers: textHeaders,
            }),
        ),
  });
}

/** The listener of a started app (Lazurio Module Standard 4.2): the
 * entrypoint's `LAZURIO_RUNTIME_LISTENER_<ID>_HOST` and `_PORT`. */
export function entrypointOf(
  env: Readonly<Record<string, string | undefined>>,
): { hostname: string; port: number } {
  const id = env.LAZURIO_RUNTIME_ENTRYPOINT_ID ?? "";
  const key = id.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  const hostname = env[`LAZURIO_RUNTIME_LISTENER_${key}_HOST`] ?? "";
  const port = Number(env[`LAZURIO_RUNTIME_LISTENER_${key}_PORT`]);
  if (!id || !hostname || !Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Start through the Lazurio lifecycle");
  return { hostname, port };
}

const usage =
  "Usage: --served <served.json> --fallback 404|spa | --root <dir> --fallback 404|spa --check <path>";

/** `--served <served.json> --fallback 404|spa`: serve; `--root <dir>
 * --fallback 404|spa --check <path>`: only whether that build answers the
 * path with a file (the Platform's check of a build before it is kept,
 * decision F58). */
export function argumentsOf(
  args: readonly string[],
):
  | Readonly<{ served: string; fallback: StaticFallback }>
  | Readonly<{ root: string; fallback: StaticFallback; check: string }> {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (
      !["--served", "--root", "--fallback", "--check"].includes(name ?? "") ||
      value === undefined ||
      !value.startsWith(name === "--fallback" ? "" : "/") ||
      values.has(name as string)
    )
      throw new Error(usage);
    values.set(name as string, value);
  }
  const fallback = values.get("--fallback");
  if (fallback !== "404" && fallback !== "spa") throw new Error(usage);
  const served = values.get("--served");
  const root = values.get("--root");
  const check = values.get("--check");
  if (served !== undefined && root === undefined && check === undefined)
    return { served, fallback };
  if (served === undefined && root !== undefined && check !== undefined)
    return { root, fallback, check };
  throw new Error(usage);
}

if (import.meta.main) {
  try {
    const options = argumentsOf(process.argv.slice(2));
    if ("check" in options) {
      const answer = await resolveStaticRequest(
        options.root,
        options.check,
        options.fallback,
      );
      process.exit(answer.kind === "file" && answer.status === 200 ? 0 : 1);
    }
    const roots = servedRoots(options.served);
    // A start names a build to serve, or there is nothing to start.
    await roots();
    const server = serveStatic({
      ...entrypointOf(process.env),
      fallback: options.fallback,
      roots,
    });
    // SIGTERM ends the app with exit 0 (Lazurio Module Standard 4.4).
    const end = () => {
      void server.stop(true).finally(() => process.exit(0));
    };
    process.on("SIGTERM", end);
    process.on("SIGINT", end);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
}
