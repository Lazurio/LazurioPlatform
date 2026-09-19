import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Fetcher } from "tuf-js";
// Pinned-client compatibility: Updater recognizes this exact class for root 404.
import { DownloadHTTPError } from "tuf-js/dist/error";

/** A response longer than the caller's limit. Its own class so the update
 * core reports `response-too-large` instead of a network failure.
 */
export class TransferTooLargeError extends Error {
  constructor() {
    super("Distribution length limit exceeded");
  }
}

/** The URL, or a redirect it answered with, names an origin outside this
 * transport's list. Its own class because no retry can change the answer.
 * `origin` carries scheme, host and port only — never a path or a query.
 */
export class OriginRefusedError extends Error {
  constructor(readonly origin: string) {
    super("Distribution origin refused");
  }
}

export type RangeResponse = Readonly<{
  /** Offset of the first body byte: the requested one for `206`, `0` when the
   * server ignored the range and sent the whole object. */
  offset: number;
  body: AsyncIterable<Uint8Array>;
  /** Always call: releases the connection of an unfinished body. */
  close(): void;
}>;

/** One transport per explicit update operation, not per individual request. */
export class DistributionTransport implements Fetcher {
  private readonly origins: ReadonlySet<string>;
  private readonly signal: AbortSignal;

  constructor(
    origins: readonly string[],
    timeoutMs: number,
    signal: AbortSignal,
    private readonly loopbackFixture = false,
  ) {
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      origins.length === 0
    )
      throw new Error("Invalid distribution transport policy");
    this.origins = new Set(
      origins.map((origin) => {
        const url = this.parse(origin);
        if (url.origin !== origin)
          throw new Error("Canonical distribution origin required");
        return origin;
      }),
    );
    this.signal = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
  }

  private parse(value: string): URL {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error("Invalid distribution URL");
    }
    if (
      url.username ||
      url.password ||
      url.hash ||
      (url.protocol !== "https:" &&
        !(
          this.loopbackFixture &&
          url.protocol === "http:" &&
          url.hostname === "127.0.0.1"
        ))
    )
      throw new Error("Distribution URL policy refused");
    return url;
  }

  /** One GET under the origin, scheme and redirect policy of this transport. */
  private async request(
    value: string,
    headers: Record<string, string>,
    signal: AbortSignal,
  ): Promise<Response> {
    let url = this.parse(value);
    for (let redirects = 0; ; redirects++) {
      if (!this.origins.has(url.origin))
        throw new OriginRefusedError(url.origin);
      if (signal.aborted) throw new Error("Distribution transfer cancelled");
      let response: Response;
      try {
        response = await fetch(url, {
          redirect: "manual",
          credentials: "omit",
          headers,
          signal,
        });
      } catch {
        throw new Error("Distribution network transfer failed or cancelled");
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get("location");
        if (!location || redirects >= 5)
          throw new Error("Distribution redirect refused");
        // URL parsing errors never expose temporary credential-bearing URLs.
        try {
          url = this.parse(new URL(location, url).href);
        } catch {
          throw new Error("Distribution redirect refused");
        }
        continue;
      }
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new DownloadHTTPError(
          "Distribution HTTP failure",
          response.status,
        );
      }
      return response;
    }
  }

  /** Open the object from `offset` for a resumable download. The caller owns
   * length and digest verification; this only applies the transport policy.
   */
  async openRange(
    value: string,
    offset: number,
    signal: AbortSignal,
  ): Promise<RangeResponse> {
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw new Error("Invalid range offset");
    const request = new AbortController();
    const response = await this.request(
      value,
      // Never a transformed body: offsets are offsets of the signed bytes.
      {
        "accept-encoding": "identity",
        ...(offset > 0 ? { range: `bytes=${offset}-` } : {}),
      },
      AbortSignal.any([this.signal, signal, request.signal]),
    );
    let start = 0;
    if (response.status === 206) {
      const range = /^bytes (\d+)-\d+\/(?:\d+|\*)$/.exec(
        response.headers.get("content-range") ?? "",
      );
      start = range ? Number(range[1]) : Number.NaN;
      if (start !== offset) {
        request.abort();
        throw new Error("Distribution range response refused");
      }
    }
    return Object.freeze({
      offset: start,
      body: response.body as unknown as AsyncIterable<Uint8Array>,
      close: () => request.abort(),
    });
  }

  async downloadFile<T>(
    value: string,
    maxLength: number,
    handler: (file: string) => Promise<T>,
  ): Promise<T> {
    if (!Number.isSafeInteger(maxLength) || maxLength < 0)
      throw new Error("Invalid download length limit");
    // Abort also on length failure/handler failure: no abandoned response stream.
    const request = new AbortController();
    const signal = AbortSignal.any([this.signal, request.signal]);
    let directory: string | undefined;
    try {
      const response = await this.request(value, {}, signal);
      const body = response.body as NonNullable<typeof response.body>;
      directory = await mkdtemp(join(tmpdir(), "lazurio-transfer-"));
      const path = join(directory, "payload");
      const file = await open(path, "wx", 0o600);
      try {
        let length = 0;
        try {
          for await (const chunk of body) {
            length += chunk.byteLength;
            if (length > maxLength) throw new TransferTooLargeError();
            // writeFile handles short writes; this handle advances sequentially.
            await file.writeFile(chunk);
          }
        } catch (error) {
          if (error instanceof TransferTooLargeError) throw error;
          throw new Error("Distribution body refused or interrupted");
        }
        if (signal.aborted) throw new Error("Distribution transfer cancelled");
        await file.sync();
      } finally {
        await file.close();
      }
      return await handler(path);
    } finally {
      request.abort();
      if (directory) await rm(directory, { recursive: true });
    }
  }

  downloadBytes(url: string, maxLength: number): Promise<Buffer> {
    return this.downloadFile(url, maxLength, (path) => readFile(path));
  }
}
