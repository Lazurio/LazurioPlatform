import type { Fetcher } from "tuf-js";
// Pinned-client compatibility: the Updater recognizes this class for root 404.
import { DownloadHTTPError } from "tuf-js/dist/error";
import { TransferTooLargeError } from "../distribution/transport";

export type TransferFailure = Readonly<{
  resource: string;
  httpStatus?: number;
  /** The response exceeded the limit the client asked for. */
  tooLarge?: true;
}>;

/** File name as kept in `trust/` (`timestamp.json`, `3.root.json`) and the
 * bytes exactly as received. */
export type DeliveredRole = Readonly<{ file: string; bytes: Buffer }>;

/** Observes one refresh from the outside; it never alters a response.
 *
 *  - It keeps the numbered roots the client received. The client overwrites
 *    its single `root.json` for every link of a rotation, but `trust/` retains
 *    the whole chain. The kept bytes are UNTRUSTED until promotion re-verifies
 *    them as a chain (`promoteVerified`).
 *  - It retains the RAW BYTES of the role delivered last without a later
 *    request having started. When a refresh fails, that is the role the client
 *    was judging: it may have authenticated it and thrown only on expiry
 *    (store.js:89-91, :133-136), keeping it in memory as its rollback floor and
 *    never writing it. Promotion re-verifies those bytes by itself
 *    (`promoteVerified`); they are UNTRUSTED here.
 *  - It remembers the last failed transfer, so a network failure is classified
 *    from the transport, not by parsing the client's wrapped error messages.
 *
 * Only the final path segment of a URL is ever recorded.
 */
export class TrustFetcher implements Fetcher {
  readonly roots = new Map<number, string>();
  private delivered: DeliveredRole | undefined;
  private failure: TransferFailure | undefined;

  constructor(
    private readonly inner: Fetcher,
    private readonly metadataBaseUrl: string,
  ) {}

  /** The role delivered last with no later request started, or undefined. */
  get lastDelivered(): DeliveredRole | undefined {
    return this.delivered;
  }

  get lastFailure(): TransferFailure | undefined {
    return this.failure;
  }

  private metadataFile(url: string): string | undefined {
    if (!url.startsWith(this.metadataBaseUrl)) return undefined;
    // Consistent snapshots prefix the version: `7.snapshot.json`.
    const name = url.slice(this.metadataBaseUrl.length);
    const role = /^(?:[1-9]\d*\.)?(timestamp|snapshot|targets)\.json$/.exec(
      name,
    );
    if (role) return `${role[1]}.json`;
    return /^[1-9]\d*\.root\.json$/.test(name) ? name : undefined;
  }

  private async observe<T>(
    url: string,
    transfer: () => Promise<T>,
    received: (value: T) => Buffer | undefined,
    transferred: () => boolean = () => false,
  ): Promise<T> {
    // A new request proves the previous role's phase returned normally.
    this.delivered = undefined;
    const file = this.metadataFile(url);
    let value: T;
    try {
      value = await transfer();
    } catch (error) {
      const status =
        error instanceof DownloadHTTPError ? error.statusCode : undefined;
      // The client probes for a newer root until 403/404; that is the normal
      // end of the root chain, not a failed transfer (updater.js:181-186).
      const probe =
        file?.endsWith(".root.json") === true &&
        status !== undefined &&
        [403, 404].includes(status);
      // A consumer that refused fully received bytes (length/hash mismatch of
      // a target) is a verification failure, not a transfer failure.
      if (!probe && !transferred())
        this.failure = Object.freeze({
          resource: new URL(url).pathname.split("/").at(-1) ?? "",
          ...(status === undefined ? {} : { httpStatus: status }),
          ...(error instanceof TransferTooLargeError
            ? { tooLarge: true as const }
            : {}),
        });
      throw error;
    }
    this.failure = undefined;
    const bytes = received(value);
    this.delivered =
      file !== undefined && bytes ? Object.freeze({ file, bytes }) : undefined;
    const root = /^([1-9]\d*)\.root\.json$/.exec(file ?? "");
    // Same decoding the client applies before it parses and persists
    // (updater.js:366, store.js:35).
    if (root && bytes) this.roots.set(Number(root[1]), bytes.toString("utf8"));
    return value;
  }

  downloadBytes(url: string, maxLength: number): Promise<Buffer> {
    return this.observe(
      url,
      () => this.inner.downloadBytes(url, maxLength),
      (bytes) => bytes,
    );
  }

  downloadFile<T>(
    url: string,
    maxLength: number,
    handler: (file: string) => Promise<T>,
  ): Promise<T> {
    let handed = false;
    return this.observe(
      url,
      () =>
        this.inner.downloadFile(url, maxLength, (file) => {
          handed = true;
          return handler(file);
        }),
      () => undefined,
      () => handed,
    );
  }
}
