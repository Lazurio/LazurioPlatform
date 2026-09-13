import { request as httpRequest } from "node:http";
import { stateFields } from "../folder/state";

// Explicit existing session transport, not discovery, a token store or another
// lifecycle owner. CLI input arrives on stdin, never in argv or shell history.
export async function requestApplication(input: unknown) {
  const value = stateFields(input, ["sessionUrl", "operation", "selection"]);
  if (
    typeof value.sessionUrl !== "string" ||
    typeof value.operation !== "string" ||
    !["prepare", "start", "status", "open", "stop"].includes(value.operation)
  )
    throw new Error("Explicit application request required");
  const url = new URL(value.sessionUrl);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    !/^#[a-f0-9]{64}$/.test(url.hash)
  )
    throw new Error("Local Launchpad session required");
  const selection = stateFields(value.selection, [
    "company",
    "module",
    "package",
  ]);
  if (Object.values(selection).some((entry) => typeof entry !== "string"))
    throw new Error("Application selection required");
  const body = JSON.stringify(selection);
  if (Buffer.byteLength(body) > 16 * 1024) throw new Error("Request too large");
  const chunks: Uint8Array[] = [];
  // Direct loopback connection: no ambient HTTP proxy or redirect can receive
  // the private session token. Do not use a process-global configured agent.
  const status = await new Promise<number>((resolve, reject) => {
    const request = httpRequest(
      `${url.origin}/api/apps/${value.operation}`,
      {
        method: "POST",
        agent: false,
        // Preparation may use the core's ten-minute budget plus cleanup.
        // A transport deadline is not cancellation or evidence of rollback.
        signal: AbortSignal.timeout(
          value.operation === "prepare" ? 660_000 : 30_000,
        ),
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          Origin: url.origin,
          Authorization: `Bearer ${url.hash.slice(1)}`,
        },
      },
      (response) => {
        void (async () => {
          try {
            const code = response.statusCode ?? 0;
            if (code >= 300 && code < 400) throw new Error("Redirect refused");
            let size = 0;
            for await (const chunk of response) {
              size += chunk.length;
              if (size > 65_536)
                throw new Error("Application response too large");
              chunks.push(chunk);
            }
            resolve(code);
          } catch (error) {
            reject(error);
          } finally {
            response.destroy();
          }
        })();
      },
    );
    request.on("error", reject);
    request.end(body);
  });
  const result: unknown = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
  );
  if (!result || typeof result !== "object" || Array.isArray(result))
    throw new Error("Invalid application response");
  return {
    httpOk: status >= 200 && status < 300,
    result: result as Record<string, unknown>,
  };
}

export async function readApplicationRequest(
  stream: ReadableStream<Uint8Array>,
) {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    void reader.cancel().catch(() => {});
  }, 5000);
  try {
    for (;;) {
      const chunk = await reader.read();
      if (expired) throw new Error("Request input timed out");
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 16 * 1024) throw new Error("Application input too large");
      chunks.push(chunk.value);
    }
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
    ) as unknown;
  } finally {
    clearTimeout(timer);
    await reader.cancel();
    reader.releaseLock();
  }
}
