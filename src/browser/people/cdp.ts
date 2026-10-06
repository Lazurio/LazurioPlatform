/** One DevTools connection to the Environment browser for the people's view
 * (decision F39): a WebSocket to the browser target on loopback, with pages
 * reached through flattened sessions (`Target.attachToTarget` with
 * `flatten`), so one socket carries every tab the view shows. */

export type CdpEvent = Readonly<{
  method: string;
  params: Readonly<Record<string, unknown>>;
  sessionId?: string;
}>;

export type CdpConnection = Readonly<{
  send: (
    method: string,
    params?: Readonly<Record<string, unknown>>,
    sessionId?: string,
  ) => Promise<Record<string, unknown>>;
  /** Every event of the browser and of every attached session. */
  onEvent: (listener: (event: CdpEvent) => void) => void;
  /** Once, when the socket closes for any reason. */
  onClose: (listener: () => void) => void;
  close: () => void;
}>;

export class CdpError extends Error {
  constructor(
    readonly method: string,
    message: string,
  ) {
    super(`${method}: ${message}`);
  }
}

const callTimeoutMs = 15_000;

/** The browser target's socket, from `/json/version` on loopback. Only a
 * loopback `ws:` address on the same port is taken, so a changed answer can
 * never send the view's DevTools traffic anywhere else. */
export async function browserSocketUrl(
  port: number,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  const response = await fetcher(`http://127.0.0.1:${port}/json/version`, {
    redirect: "error",
    signal: AbortSignal.timeout(3_000),
  });
  if (!response.ok) throw new Error(`json/version answered ${response.status}`);
  const body = (await response.json()) as { webSocketDebuggerUrl?: unknown };
  const url = body.webSocketDebuggerUrl;
  if (typeof url !== "string") throw new Error("no webSocketDebuggerUrl");
  const parsed = new URL(url);
  if (
    parsed.protocol !== "ws:" ||
    parsed.hostname !== "127.0.0.1" ||
    parsed.port !== String(port) ||
    !parsed.pathname.startsWith("/devtools/browser/")
  )
    throw new Error("webSocketDebuggerUrl is not this loopback browser");
  return parsed.href;
}

/** Opens the socket and resolves when it is open. Calls fail when the
 * socket closes or after 15 s; nothing is retried here (the hub reconnects
 * the whole connection). */
export function connectCdp(url: string): Promise<CdpConnection> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    let nextId = 1;
    const pending = new Map<
      number,
      {
        method: string;
        resolve: (value: Record<string, unknown>) => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    >();
    const listeners: ((event: CdpEvent) => void)[] = [];
    const closers: (() => void)[] = [];
    let open = false;
    let closed = false;
    const finish = () => {
      if (closed) return;
      closed = true;
      for (const [id, call] of pending) {
        clearTimeout(call.timer);
        call.reject(new CdpError(call.method, "connection closed"));
        pending.delete(id);
      }
      for (const closer of closers.splice(0)) closer();
    };
    socket.addEventListener("open", () => {
      open = true;
      resolve(
        Object.freeze({
          send: (method, params = {}, sessionId) => {
            if (closed)
              return Promise.reject(new CdpError(method, "connection closed"));
            const id = nextId++;
            return new Promise<Record<string, unknown>>(
              (resolveCall, rejectCall) => {
                const timer = setTimeout(() => {
                  pending.delete(id);
                  rejectCall(new CdpError(method, "timed out"));
                }, callTimeoutMs);
                pending.set(id, {
                  method,
                  resolve: resolveCall,
                  reject: rejectCall,
                  timer,
                });
                socket.send(
                  JSON.stringify(
                    sessionId === undefined
                      ? { id, method, params }
                      : { id, method, params, sessionId },
                  ),
                );
              },
            );
          },
          onEvent: (listener) => {
            listeners.push(listener);
          },
          onClose: (listener) => {
            if (closed) listener();
            else closers.push(listener);
          },
          close: () => socket.close(),
        }),
      );
    });
    socket.addEventListener("message", (message) => {
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(String(message.data)) as Record<string, unknown>;
      } catch {
        return;
      }
      if (typeof data.id === "number") {
        const call = pending.get(data.id);
        if (call === undefined) return;
        pending.delete(data.id);
        clearTimeout(call.timer);
        const error = data.error as { message?: unknown } | undefined;
        if (error !== undefined)
          call.reject(new CdpError(call.method, String(error.message)));
        else call.resolve((data.result ?? {}) as Record<string, unknown>);
        return;
      }
      if (typeof data.method !== "string") return;
      const event: CdpEvent = {
        method: data.method,
        params: (data.params ?? {}) as Record<string, unknown>,
        ...(typeof data.sessionId === "string"
          ? { sessionId: data.sessionId }
          : {}),
      };
      for (const listener of listeners) {
        try {
          listener(event);
        } catch {}
      }
    });
    socket.addEventListener("close", () => {
      if (!open) reject(new Error("DevTools socket closed before it opened"));
      finish();
    });
    socket.addEventListener("error", () => {
      if (!open) reject(new Error("DevTools socket failed"));
    });
  });
}
