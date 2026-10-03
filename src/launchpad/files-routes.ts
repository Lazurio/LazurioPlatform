import {
  type DocumentEntry,
  type Documents,
  type DocumentsHost,
  documentTree,
  isRefused,
  listDocuments,
  openDocuments,
  type Refused,
  readDocument,
  resolveDocument,
  uploadDocument,
} from "../files/documents";
import {
  archiveName,
  contentDisposition,
  contentType,
  parseRelativePath,
  parseUrlPath,
  segmentRefusal,
} from "../files/rules";
import { type ZipInput, zipArchive } from "../files/zip";

// The Files routes of the Launchpad (decision F34): the Operator's Documents
// folder through the browser. Every route sits behind the Launchpad's own
// admission (the gateway session on a Remote Environment, the session token
// locally); nothing here admits anything.
//
// - `GET|HEAD /files/<path>` behind a gateway: a regular file is its
//   download; anything else is the page (served by the caller).
// - `GET /api/files/list?path=<dir>`: the folder's visible entries.
// - `GET|HEAD /api/files/download?path=<file>`: the download, also locally.
// - `GET /api/files/zip?path=<dir>`: the folder as a streamed ZIP.
// - `POST /api/files/upload?path=<dir>&name=<name>`: the raw body as a new
//   file, never over an existing one.

/** The Launchpad accepts request bodies up to this size (1 TiB): uploads
 * stream to disk, and every JSON route reads at most 16 KiB of its body
 * (json-body.ts). Bun's own default is 128 MiB. */
export const maxRequestBytes = 2 ** 40;

/** A transfer may pause this long (a slow link, a full window) before the
 * connection is dropped; Bun's default is 10 seconds. */
const transferIdleSeconds = 120;

const statuses: Readonly<Record<string, number>> = {
  "query-invalid": 400,
  "path-invalid": 400,
  "upload-incomplete": 400,
  "path-hidden": 404,
  "outside-documents": 404,
  "not-found": 404,
  "not-regular": 404,
  "not-directory": 409,
  "not-file": 409,
  "name-unavailable": 409,
  "length-required": 411,
  "documents-unavailable": 503,
  "disk-full": 507,
};

/** What the routes need of the server: the idle timeout of one request. */
export type RequestTimeout = Readonly<{
  timeout: (request: Request, seconds: number) => void;
}>;

/** An async generator as a response body: Bun pulls it as the client
 * reads, and returns it when the client goes away, which closes the file it
 * reads. Bun sends it chunked: it drops a declared Content-Length for every
 * streamed body. The DOM's BodyInit, which this project's types use, does
 * not list the generators Bun takes. */
const generatorBody = (source: AsyncGenerator<Uint8Array>): BodyInit =>
  source as unknown as BodyInit;

export type ByteRange =
  | Readonly<{ kind: "full" }>
  | Readonly<{ kind: "range"; start: number; end: number }>
  | Readonly<{ kind: "unsatisfiable" }>;

/** The one byte range of a request (RFC 9110 14.2), inclusive. A missing,
 * malformed or multiple range, another unit, or an `If-Range` that names
 * another version of the file is the whole file; a start past its end is
 * unsatisfiable. */
export function selectRange(
  range: string | null,
  ifRange: string | null,
  size: number,
  validators: Readonly<{ etag: string; lastModified: string }>,
): ByteRange {
  if (range === null) return { kind: "full" };
  if (
    ifRange !== null &&
    ifRange.trim() !== validators.etag &&
    ifRange.trim() !== validators.lastModified
  )
    return { kind: "full" };
  const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (match === null) return { kind: "full" };
  const [first = "", last = ""] = [match[1], match[2]];
  if (first === "" && last === "") return { kind: "full" };
  if (size === 0) return { kind: "unsatisfiable" };
  if (first === "") {
    const suffix = Number(last);
    return suffix === 0
      ? { kind: "unsatisfiable" }
      : { kind: "range", start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(first);
  if (last !== "" && Number(last) < start) return { kind: "full" };
  if (start >= size) return { kind: "unsatisfiable" };
  return {
    kind: "range",
    start,
    end: last === "" ? size - 1 : Math.min(Number(last), size - 1),
  };
}

// The exact query of a route: only the named keys, each at most once.
function query(
  url: URL,
  allowed: readonly string[],
): Readonly<Record<string, string>> | null {
  const values: Record<string, string> = {};
  for (const [key, value] of url.searchParams) {
    if (!allowed.includes(key) || Object.hasOwn(values, key)) return null;
    values[key] = value;
  }
  return values;
}

export function createFilesRoutes(
  options: Readonly<{
    host: DocumentsHost;
    /** The Launchpad's headers of every answer. */
    headers: Readonly<Record<string, string>>;
  }>,
) {
  const { host, headers } = options;
  // Uploads under way: the Launchpad's close waits for each to remove its
  // temporary file before the process ends.
  const uploads = new Set<Promise<unknown>>();
  const json = (body: unknown, status = 200) =>
    Response.json(body, { status, headers });
  const refusal = (reason: string) =>
    json({ error: reason }, statuses[reason] ?? 500);

  async function locate(
    segments: readonly string[],
    create: boolean,
  ): Promise<
    Readonly<{ documents: Documents; entry: DocumentEntry }> | Refused
  > {
    const documents = await openDocuments(host, { create });
    if (isRefused(documents)) return documents;
    const entry = await resolveDocument(documents, segments);
    if (isRefused(entry)) return entry;
    return { documents, entry };
  }

  function download(
    request: Request,
    server: RequestTimeout,
    entry: Extract<DocumentEntry, { kind: "file" }>,
  ): Response {
    const name = entry.segments.at(-1) ?? "download";
    const etag = `"${entry.size.toString(16)}-${entry.modified.getTime().toString(16)}"`;
    const lastModified = entry.modified.toUTCString();
    const common = {
      ...headers,
      "Content-Type": contentType(name),
      "Content-Disposition": contentDisposition(name),
      // Never rendered here, whatever it is.
      "Content-Security-Policy": "sandbox",
      "Accept-Ranges": "bytes",
      ETag: etag,
      "Last-Modified": lastModified,
    };
    const range = selectRange(
      request.headers.get("range"),
      request.headers.get("if-range"),
      entry.size,
      { etag, lastModified },
    );
    if (range.kind === "unsatisfiable")
      return new Response(null, {
        status: 416,
        headers: { ...common, "Content-Range": `bytes */${entry.size}` },
      });
    const partial = range.kind === "range";
    const [start, end] = partial
      ? [range.start, range.end + 1]
      : [0, entry.size];
    const status = partial ? 206 : 200;
    const sized = {
      ...common,
      ...(partial
        ? { "Content-Range": `bytes ${start}-${end - 1}/${entry.size}` }
        : {}),
    };
    if (request.method === "HEAD")
      return new Response(null, {
        status,
        headers: { ...sized, "Content-Length": String(end - start) },
      });
    server.timeout(request, transferIdleSeconds);
    // A file body goes out by sendfile with its Content-Length. Bun handles
    // a Range request against a full file body itself and ignores If-Range,
    // so the whole file asked with a Range (an If-Range of another version,
    // several ranges) streams instead, without a length, rather than as a
    // part that would splice two versions on a resumed download.
    if (partial)
      return new Response(Bun.file(entry.real).slice(start, end), {
        status,
        headers: sized,
      });
    if (request.headers.get("range") === null)
      return new Response(Bun.file(entry.real), { status, headers: sized });
    return new Response(
      generatorBody(readDocument(entry.real, 0, entry.size)),
      { status, headers: sized },
    );
  }

  function archive(
    request: Request,
    server: RequestTimeout,
    documents: Documents,
    entry: Extract<DocumentEntry, { kind: "directory" }>,
  ): Response {
    const name = archiveName(entry.segments);
    async function* inputs(): AsyncGenerator<ZipInput> {
      for await (const item of documentTree(documents, entry)) {
        const path = [name, ...item.path].join("/");
        yield item.kind === "directory"
          ? { kind: "directory", name: path, modified: item.modified }
          : {
              kind: "file",
              name: path,
              modified: item.modified,
              size: item.size,
              content: () => readDocument(item.real, 0, item.size),
            };
      }
    }
    server.timeout(request, transferIdleSeconds);
    return new Response(generatorBody(zipArchive(inputs())), {
      headers: {
        ...headers,
        "Content-Type": "application/zip",
        "Content-Disposition": contentDisposition(`${name}.zip`),
      },
    });
  }

  async function upload(
    request: Request,
    server: RequestTimeout,
    url: URL,
  ): Promise<Response> {
    const values = query(url, ["path", "name"]);
    if (values === null || values.name === undefined)
      return refusal("query-invalid");
    const parsed = parseRelativePath(values.path ?? "", host.platform);
    if ("refusal" in parsed) return refusal(parsed.refusal);
    // The name is checked before a byte is read.
    const name = values.name.normalize("NFC");
    const nameRefusal = segmentRefusal(name, host.platform);
    if (nameRefusal !== null) return refusal(nameRefusal);
    // The declared length is what proves the file arrived whole.
    const declared = request.headers.get("content-length");
    if (declared === null || !/^\d{1,16}$/.test(declared))
      return refusal("length-required");
    const length = Number(declared);
    const found = await locate(parsed.segments, true);
    if (isRefused(found)) return refusal(found.refusal);
    if (found.entry.kind !== "directory") return refusal("not-directory");
    server.timeout(request, transferIdleSeconds);
    const work = uploadDocument(
      host,
      found.documents,
      found.entry,
      name,
      request.body,
      length,
    );
    uploads.add(work);
    let result: Awaited<typeof work>;
    try {
      result = await work;
    } finally {
      uploads.delete(work);
    }
    if (isRefused(result)) return refusal(result.refusal);
    return json(
      {
        name: result.name,
        path: [...parsed.segments, result.name].join("/"),
        size: result.size,
      },
      201,
    );
  }

  return Object.freeze({
    /** `GET|HEAD /files/<path>` behind a gateway: the download of a regular
     * file, or the status the page is served with: 200 for a folder (and for
     * the Documents folder itself, which the page's listing creates), 404
     * for anything that is not served. */
    async page(
      request: Request,
      server: RequestTimeout,
      url: URL,
    ): Promise<Response | Readonly<{ status: 200 | 404 }>> {
      const parsed = parseUrlPath(
        url.pathname.slice("/files".length),
        host.platform,
      );
      if ("refusal" in parsed) return { status: 404 };
      if (parsed.segments.length === 0) return { status: 200 };
      const found = await locate(parsed.segments, false);
      if (isRefused(found)) return { status: 404 };
      return found.entry.kind === "file"
        ? download(request, server, found.entry)
        : { status: 200 };
    },
    /** A route under `/api/files/`; 404 for any other name. */
    async api(
      request: Request,
      server: RequestTimeout,
      url: URL,
    ): Promise<Response> {
      const route = url.pathname.slice("/api/files/".length);
      if (route === "upload") {
        if (request.method !== "POST")
          return json({ error: "method-not-allowed" }, 405);
        return upload(request, server, url);
      }
      if (!["list", "download", "zip"].includes(route))
        return json({ error: "not-found" }, 404);
      if (
        request.method !== "GET" &&
        !(request.method === "HEAD" && route === "download")
      )
        return json({ error: "method-not-allowed" }, 405);
      const values = query(url, ["path"]);
      if (values === null) return refusal("query-invalid");
      const parsed = parseRelativePath(values.path ?? "", host.platform);
      if ("refusal" in parsed) return refusal(parsed.refusal);
      // Listing creates the Documents folder when it is missing; nothing
      // else does.
      const found = await locate(parsed.segments, route === "list");
      if (isRefused(found)) return refusal(found.refusal);
      const { documents, entry } = found;
      if (route === "download")
        return entry.kind === "file"
          ? download(request, server, entry)
          : refusal("not-file");
      if (entry.kind !== "directory") return refusal("not-directory");
      if (route === "zip") return archive(request, server, documents, entry);
      return json({
        path: parsed.segments.join("/"),
        entries: await listDocuments(documents, entry),
      });
    },
    /** Waits until every upload under way has finished or cleaned up. */
    async close() {
      await Promise.allSettled([...uploads]);
    },
  });
}
