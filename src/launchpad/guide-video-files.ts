import { createHash } from "node:crypto";
import { guideVideoPath } from "./guide-video";
import { notModified, selectRange } from "./http-conditions";
import vaultBitwardenCs from "./videos/vault-bitwarden-cs.mp4" with {
  type: "file",
};
import vaultBitwardenCsPoster from "./videos/vault-bitwarden-cs.webp" with {
  type: "file",
};
import vaultBitwardenEn from "./videos/vault-bitwarden-en.mp4" with {
  type: "file",
};
import vaultBitwardenEnPoster from "./videos/vault-bitwarden-en.webp" with {
  type: "file",
};

// The server's side of the guide videos (guide-video.ts): each file embedded
// in the compiled executable like the shell's fonts, by its file name, and
// `GET|HEAD /videos/<file>` beside the page's routes: locally without the
// token, as the page is; hosted only after the gateway's admission
// (server.ts answers it there itself, so that the request's byte range
// reaches it). Safari and iOS play a video only from a server that answers
// byte ranges: one range is `206 Partial Content`, a range past the end
// `416`, anything else the whole file. A release may carry a new cut under
// the same name, so the browser keeps its copy only as long as the ETag (the
// content's digest) says it is current.

export const guideVideoFilePaths: Readonly<Record<string, string>> = {
  "vault-bitwarden-cs.mp4": vaultBitwardenCs,
  "vault-bitwarden-cs.webp": vaultBitwardenCsPoster,
  "vault-bitwarden-en.mp4": vaultBitwardenEn,
  "vault-bitwarden-en.webp": vaultBitwardenEnPoster,
};

const contentTypes: Readonly<Record<string, string>> = {
  mp4: "video/mp4",
  webp: "image/webp",
};

const assetHeaders = {
  "Cache-Control": "no-cache",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

/** Whether `path` is a guide video's address (`/videos/<file>`). */
export const isGuideVideoPath = (path: string): boolean =>
  path.startsWith(guideVideoPath);

// Each file's ETag, its content's digest, read once.
const etags = new Map<string, Promise<string>>();
const etagOf = (path: string): Promise<string> => {
  let etag = etags.get(path);
  if (etag === undefined) {
    etag = Bun.file(path)
      .arrayBuffer()
      .then(
        (bytes) =>
          `"${createHash("sha256").update(new Uint8Array(bytes)).digest("hex").slice(0, 32)}"`,
      );
    etags.set(path, etag);
  }
  return etag;
};

/** The answer to `GET|HEAD /videos/<file>`. */
export async function guideVideoAnswer(
  request: Request,
  file: string,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD")
    return new Response("method-not-allowed", {
      status: 405,
      headers: { ...assetHeaders, Allow: "GET, HEAD" },
    });
  if (!Object.hasOwn(guideVideoFilePaths, file))
    return new Response("not-found", { status: 404, headers: assetHeaders });
  const path = guideVideoFilePaths[file] as string;
  const blob = Bun.file(path);
  const size = blob.size;
  const etag = await etagOf(path);
  const common = {
    ...assetHeaders,
    "Content-Type":
      contentTypes[file.slice(file.lastIndexOf(".") + 1)] ??
      "application/octet-stream",
    "Accept-Ranges": "bytes",
    ETag: etag,
  };
  if (notModified(request, etag))
    return new Response(null, { status: 304, headers: common });
  const range = selectRange(
    request.headers.get("range"),
    request.headers.get("if-range"),
    size,
    // No date: an If-Range names this version by its ETag alone.
    { etag, lastModified: etag },
  );
  if (range.kind === "unsatisfiable")
    return new Response(null, {
      status: 416,
      headers: { ...common, "Content-Range": `bytes */${size}` },
    });
  const [start, end] =
    range.kind === "range" ? [range.start, range.end + 1] : [0, size];
  const status = range.kind === "range" ? 206 : 200;
  const headers = {
    ...common,
    "Content-Length": String(end - start),
    ...(range.kind === "range"
      ? { "Content-Range": `bytes ${start}-${end - 1}/${size}` }
      : {}),
  };
  if (request.method === "HEAD") return new Response(null, { status, headers });
  if (range.kind === "range")
    return new Response(blob.slice(start, end), { status, headers });
  // The whole file. Bun would answer a Range against a file body itself,
  // ignoring If-Range; asked with one (another version, several ranges),
  // the bytes go out as they are.
  return new Response(
    request.headers.has("range") ? await blob.bytes() : blob,
    { status, headers },
  );
}

/** The route beside the page's (page.ts `pageRoutes`), at `guideVideoPath`. */
export const guideVideoRoutes = {
  "/videos/:file": (request: Request & { params: { file: string } }) =>
    guideVideoAnswer(request, request.params.file),
};
