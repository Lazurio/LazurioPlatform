/** A minimal Chrome DevTools client for the prototype: one browser-level
 * socket, commands with ids, flattened sessions. The product's own client is
 * `src/browser/people/cdp.ts`; the prototype keeps its own so that it runs
 * from a worktree without touching the view's service. */

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

export type Cdp = {
  send<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ): Promise<T>;
  close(): void;
};

export async function browserWebSocketUrl(port: number): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${port}/json/version`);
  if (!response.ok) throw new Error(`DevTools on ${port}: ${response.status}`);
  const body = (await response.json()) as { webSocketDebuggerUrl?: unknown };
  if (typeof body.webSocketDebuggerUrl !== "string")
    throw new Error(`DevTools on ${port}: no browser socket`);
  return body.webSocketDebuggerUrl;
}

export async function connectCdp(port: number): Promise<Cdp> {
  const socket = new WebSocket(await browserWebSocketUrl(port));
  const pending = new Map<number, Pending>();
  let next = 1;
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener(
      "error",
      () => reject(new Error(`DevTools on ${port}: socket error`)),
      { once: true },
    );
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as {
      id?: number;
      result?: unknown;
      error?: { message?: string };
    };
    if (message.id === undefined) return;
    const waiting = pending.get(message.id);
    if (waiting === undefined) return;
    pending.delete(message.id);
    if (message.error !== undefined)
      waiting.reject(new Error(message.error.message ?? "CDP error"));
    else waiting.resolve(message.result);
  });
  socket.addEventListener("close", () => {
    for (const waiting of pending.values())
      waiting.reject(new Error("DevTools socket closed"));
    pending.clear();
  });
  return {
    send<T>(
      method: string,
      params: Record<string, unknown> = {},
      sessionId?: string,
    ): Promise<T> {
      const id = next++;
      const message: Record<string, unknown> = { id, method, params };
      if (sessionId !== undefined) message.sessionId = sessionId;
      return new Promise<T>((resolve, reject) => {
        pending.set(id, {
          resolve: (value) => resolve(value as T),
          reject,
        });
        socket.send(JSON.stringify(message));
      });
    },
    close() {
      socket.close();
    },
  };
}

export type WindowBounds = {
  left: number;
  top: number;
  width: number;
  height: number;
  windowState: string;
};

/** The browser window that holds a target, as Chrome reports it: Chrome's
 * own window id and bounds. Chrome's window id is not the X11 window id. */
export async function windowForTarget(
  cdp: Cdp,
  targetId: string,
): Promise<{ windowId: number; bounds: WindowBounds }> {
  return cdp.send("Browser.getWindowForTarget", { targetId });
}
