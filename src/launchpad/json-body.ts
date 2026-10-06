// The JSON body of a Launchpad API request, read to at most `limit` bytes.
// The server accepts large bodies for file uploads (files-routes.ts), so no
// JSON route may read an unbounded body into memory: a larger declared or
// streamed body is refused before it is buffered.

export const jsonBodyLimit = 16 * 1024;

export class BodyTooLarge extends Error {
  constructor() {
    super("Request body too large");
  }
}

/** The parsed body; `BodyTooLarge` past the limit, and the error of
 * `JSON.parse` (or of strict UTF-8 decoding) for anything that is not one
 * JSON text. */
export async function readJsonBody(
  request: Request,
  limit = jsonBodyLimit,
): Promise<unknown> {
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > limit) throw new BodyTooLarge();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (request.body !== null) {
    const reader = request.body.getReader();
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > limit) throw new BodyTooLarge();
        chunks.push(chunk.value);
      }
    } finally {
      // Stop reading (and buffering) at once when the limit is passed.
      if (size > limit) await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
