import { UpdateFailure } from "./errors";
import { type ReleaseOrigin, versionOfTag } from "./identity";

/** Requests to the release origin (docs/update.md "Check"). `latest` is asked
 * exactly once, only to learn the tag its redirect names; everything else is
 * requested by exact tag. What arrives is authenticated by the attestation, so
 * a redirect decides only where bytes come from — but never over plain HTTP,
 * except back to a loopback fixture origin that is itself plain HTTP.
 */
export type Fetcher = (
  url: string,
  init: { redirect: "manual"; signal: AbortSignal },
) => Promise<Response>;

export const latestUrl = (origin: ReleaseOrigin, file: string) =>
  `${origin.baseUrl}/releases/latest/download/${file}`;
export const tagUrl = (origin: ReleaseOrigin, tag: string, file: string) =>
  `${origin.baseUrl}/releases/download/${tag}/${file}`;

export const requestTimeoutMs = 30_000;
const maxRedirects = 5;

const unavailable = (resource: string, reason: string, httpStatus?: number) =>
  new UpdateFailure("network-unavailable", {
    resource,
    reason,
    ...(httpStatus === undefined ? {} : { httpStatus }),
  });

async function request(
  fetcher: Fetcher,
  url: string,
  resource: string,
  signal: AbortSignal,
): Promise<Response> {
  try {
    return await fetcher(url, { redirect: "manual", signal });
  } catch {
    throw unavailable(resource, signal.aborted ? "timeout" : "connection");
  }
}

function redirectTarget(
  origin: ReleaseOrigin,
  from: string,
  response: Response,
  resource: string,
): string {
  const location = response.headers.get("location");
  if (!location || !URL.canParse(location, from))
    throw unavailable(resource, "redirect");
  const target = new URL(location, from);
  if (
    target.protocol !== "https:" &&
    target.origin !== new URL(origin.baseUrl).origin
  )
    throw unavailable(resource, "redirect");
  return target.href;
}

const isRedirect = (status: number) =>
  [301, 302, 303, 307, 308].includes(status);

/** The tag `latest` points at right now. */
export async function resolveLatestTag(
  origin: ReleaseOrigin,
  fetcher: Fetcher,
  file: string,
): Promise<string> {
  const url = latestUrl(origin, file);
  const response = await request(
    fetcher,
    url,
    "latest",
    AbortSignal.timeout(requestTimeoutMs),
  );
  await response.body?.cancel().catch(() => undefined);
  // No release at all is an answer of the origin, not weather.
  if (response.status === 404)
    throw new UpdateFailure("release-invalid", {
      resource: "latest",
      reason: "not-found",
    });
  if (!isRedirect(response.status))
    throw unavailable("latest", "http", response.status);
  const target = redirectTarget(origin, url, response, "latest");
  const prefix = `${origin.baseUrl}/releases/download/`;
  const [tag, name, ...rest] = target.startsWith(prefix)
    ? target.slice(prefix.length).split("/")
    : [];
  if (!versionOfTag(tag) || name !== file || rest.length > 0)
    throw new UpdateFailure("release-invalid", {
      resource: "latest",
      reason: "redirect",
    });
  return tag as string;
}

/** Open one exact-tag asset, following the origin's redirects to its storage. */
export async function openAsset(
  origin: ReleaseOrigin,
  fetcher: Fetcher,
  url: string,
  resource: string,
  signal: AbortSignal,
): Promise<Response> {
  let current = url;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const response = await request(fetcher, current, resource, signal);
    if (isRedirect(response.status)) {
      await response.body?.cancel().catch(() => undefined);
      current = redirectTarget(origin, current, response, resource);
      continue;
    }
    if (response.status === 200 && response.body) return response;
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 404)
      throw new UpdateFailure("release-invalid", {
        resource,
        reason: "not-found",
      });
    throw unavailable(resource, "http", response.status);
  }
  throw unavailable(resource, "redirect");
}

/** A small asset (manifest, bundle), bounded while it is read. */
export async function fetchAsset(
  origin: ReleaseOrigin,
  fetcher: Fetcher,
  url: string,
  resource: string,
  maxBytes: number,
): Promise<Uint8Array> {
  const signal = AbortSignal.timeout(requestTimeoutMs);
  const response = await openAsset(origin, fetcher, url, resource, signal);
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for await (const chunk of response.body as ReadableStream<Uint8Array>) {
      length += chunk.byteLength;
      if (length > maxBytes)
        throw new UpdateFailure("release-invalid", {
          resource,
          reason: "size",
        });
      chunks.push(chunk);
    }
  } catch (error) {
    if (error instanceof UpdateFailure) throw error;
    throw unavailable(resource, signal.aborted ? "timeout" : "connection");
  }
  return Buffer.concat(chunks);
}
