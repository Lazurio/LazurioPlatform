import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Fetcher } from "tuf-js";
// Pinned-client compatibility: Updater recognizes this exact class for root 404.
import { DownloadHTTPError } from "tuf-js/dist/error";

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

  async downloadFile<T>(
    value: string,
    maxLength: number,
    handler: (file: string) => Promise<T>,
  ): Promise<T> {
    if (!Number.isSafeInteger(maxLength) || maxLength < 0)
      throw new Error("Invalid download length limit");
    let url = this.parse(value);
    // Abort also on length failure/handler failure: no abandoned response stream.
    const request = new AbortController();
    const signal = AbortSignal.any([this.signal, request.signal]);
    let directory: string | undefined;
    try {
      for (let redirects = 0; ; redirects++) {
        if (!this.origins.has(url.origin))
          throw new Error("Distribution origin refused");
        if (signal.aborted) throw new Error("Distribution transfer cancelled");
        let response: Response;
        try {
          response = await fetch(url, {
            redirect: "manual",
            credentials: "omit",
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
        directory = await mkdtemp(join(tmpdir(), "lazurio-transfer-"));
        const path = join(directory, "payload");
        const file = await open(path, "wx", 0o600);
        try {
          let length = 0;
          try {
            for await (const chunk of response.body) {
              length += chunk.byteLength;
              if (length > maxLength)
                throw new Error("Distribution length limit exceeded");
              // writeFile handles short writes; this handle advances sequentially.
              await file.writeFile(chunk);
            }
          } catch {
            throw new Error(
              "Distribution body refused, interrupted or too large",
            );
          }
          if (signal.aborted)
            throw new Error("Distribution transfer cancelled");
          await file.sync();
        } finally {
          await file.close();
        }
        return await handler(path);
      }
    } finally {
      request.abort();
      if (directory) await rm(directory, { recursive: true });
    }
  }

  downloadBytes(url: string, maxLength: number): Promise<Buffer> {
    return this.downloadFile(url, maxLength, (path) => readFile(path));
  }
}
