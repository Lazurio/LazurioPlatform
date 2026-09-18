import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { createConnection } from "node:net";
import { object, text } from "./manifest";

type Observation = Readonly<{
  kind: "responding" | "http-error" | "unavailable" | "timeout";
  status?: number;
}>;

// Connectivity only. A responding endpoint does not establish process ownership,
// correct application identity, access rights or whole-application readiness.
export function parseHealthListener(input: unknown) {
  const listener = object(input, ["host", "port", "protocol", "health"]);
  const host = text(listener.host, /^(127\.0\.0\.1|::1|localhost)$/);
  const port = listener.port;
  if (
    !Number.isInteger(port) ||
    (port as number) < 1024 ||
    (port as number) > 65535
  )
    throw new Error("Declared unprivileged port required");
  const protocol = text(listener.protocol, /^(http|https|tcp)$/);
  const health = object(listener.health, ["kind"], ["path"]);
  let path = "/";
  if (health.kind === "http" && protocol !== "tcp") {
    path = text(health.path, /^\//);
    const url = new URL(path, "http://health.invalid");
    if (path.includes("\\") || url.origin !== "http://health.invalid")
      throw new Error("Same-origin health path required");
    // Retain the validated source spelling so parsing is idempotent. A safe
    // path such as /a/..//health normalizes to //health, which must not later
    // be reinterpreted as an origin. Only the request adapter normalizes it.
  } else if (health.kind !== "tcp" || Object.hasOwn(health, "path"))
    throw new Error("Invalid health declaration");
  return Object.freeze({
    host,
    port: port as number,
    protocol,
    health: Object.freeze(
      health.kind === "http"
        ? { kind: "http" as const, path }
        : { kind: "tcp" as const },
    ),
  });
}

export async function probeListenerHealth(
  input: unknown,
  timeoutMs = 1500,
): Promise<Observation> {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000)
    throw new Error("Bounded health timeout required");
  const { host, port, protocol, health } = parseHealthListener(input);
  const url = new URL(
    health.kind === "http" ? health.path : "/",
    "http://health.invalid",
  );
  const path = url.pathname + url.search;

  // Avoid DNS/hosts-file or proxy redirection. localhost means only the two
  // numeric loopback interfaces; try both with one shared deadline.
  const addresses = host === "localhost" ? ["127.0.0.1", "::1"] : [host];
  const deadline = performance.now() + timeoutMs;
  let last: Observation = Object.freeze({ kind: "unavailable" });
  for (const address of addresses) {
    const remaining = Math.ceil(deadline - performance.now());
    if (remaining <= 0) return Object.freeze({ kind: "timeout" });
    last = await new Promise<Observation>((resolve) => {
      let settled = false;
      let close: () => void = () => {};
      const timer = setTimeout(() => finish({ kind: "timeout" }), remaining);
      function finish(result: Observation) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        close();
        resolve(Object.freeze(result));
      }
      try {
        if (health.kind === "tcp") {
          const socket = createConnection({
            host: address,
            port: port as number,
          });
          close = () => {
            socket.destroy();
          };
          socket.once("connect", () => finish({ kind: "responding" }));
          socket.once("error", () => finish({ kind: "unavailable" }));
        } else {
          const request = protocol === "https" ? httpsRequest : httpRequest;
          const req = request(
            {
              hostname: address,
              port: port as number,
              method: "GET",
              path,
              agent: false,
              headers: { host: `${host === "::1" ? "[::1]" : host}:${port}` },
              ...(protocol === "https"
                ? {
                    servername: host === "localhost" ? host : undefined,
                    rejectUnauthorized: true,
                  }
                : {}),
            },
            (response) => {
              const status = response.statusCode ?? 0;
              // Neither follow Location nor buffer an untrusted/streaming body.
              response.destroy();
              finish({
                kind:
                  status >= 200 && status < 300 ? "responding" : "http-error",
                status,
              });
            },
          );
          close = () => {
            req.destroy();
          };
          req.once("error", () => finish({ kind: "unavailable" }));
          req.end();
        }
      } catch {
        finish({ kind: "unavailable" });
      }
    });
    if (last.kind !== "unavailable") return last;
  }
  return last;
}
