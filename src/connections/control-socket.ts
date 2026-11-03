import { lstat, readlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

// The control socket of the operator's Codex app-server daemon (decision
// F29), the one place Settings → Connections talks to Codex's remote control
// (decision F71). The daemon listens on
// `$CODEX_HOME/app-server-control/app-server-control.sock`, a link to a
// socket under `/tmp`, and speaks JSON-RPC in WebSocket frames. Its
// `remoteControl/*` methods are experimental: `initialize` declares
// `capabilities.experimentalApi`, and every answer is checked where it is
// used, since a Codex update can change them.
//
// An error never carries Codex's own message: a pairing method's message may
// repeat what it was given, and a code must never reach a log, the journal
// or an error (F71 point 6). Only the JSON-RPC error code survives.

/** Where the daemon's control socket is, under Codex's home. */
export const codexControlSocketPath = (codexHome: string) =>
  join(codexHome, "app-server-control", "app-server-control.sock");

/** Why a question to the daemon got no usable answer:
 * - `no-socket`: no control socket (no daemon, or Codex without one);
 * - `no-answer`: it could not be reached, closed or did not answer in time;
 * - `method-not-found`: this Codex does not have the method;
 * - `refused`: it answered the method with an error (`code` is JSON-RPC's). */
export type ControlSocketFailure =
  | "no-socket"
  | "no-answer"
  | "method-not-found"
  | "refused";

export class ControlSocketError extends Error {
  constructor(
    readonly reason: ControlSocketFailure,
    readonly code?: number,
  ) {
    super(`Codex control socket: ${reason}`);
    this.name = "ControlSocketError";
  }
}

/** One open conversation with the daemon. */
export type ControlRpc = Readonly<{
  call: (method: string, params?: unknown) => Promise<unknown>;
  close: () => void;
}>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** The socket a path names, following links (the daemon's path is a link
 * to a socket under `/tmp`) with `lstat` and `readlink` only. `realpath`
 * cannot be used: on macOS it fails on a socket with EOPNOTSUPP, so every
 * Connections page there read `no-daemon`. */
async function socketTarget(path: string): Promise<string> {
  let current = path;
  for (let hops = 0; hops <= 40; hops++) {
    const info = await lstat(current);
    if (info.isSocket()) return current;
    if (!info.isSymbolicLink()) throw new Error("not a socket");
    current = resolve(dirname(current), await readlink(current));
  }
  throw new Error("too many links");
}

/** Opens the socket and initializes the conversation; every question is
 * bounded by `timeoutMs`. */
export async function openControlSocket(
  path: string,
  options: Readonly<{ timeoutMs?: number; version?: string }> = {},
): Promise<ControlRpc> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  let target: string;
  try {
    target = await socketTarget(path);
  } catch {
    throw new ControlSocketError("no-socket");
  }
  const socket = new WebSocket(`ws+unix://${target}:/`);
  const waiting = new Map<
    number,
    Readonly<{
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }>
  >();
  let next = 1;
  let closed = false;
  const failAll = () => {
    closed = true;
    for (const [id, entry] of waiting) {
      clearTimeout(entry.timer);
      waiting.delete(id);
      entry.reject(new ControlSocketError("no-answer"));
    }
  };
  socket.addEventListener("message", (event) => {
    let message: unknown;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (!isRecord(message) || typeof message.id !== "number") return;
    const entry = waiting.get(message.id);
    if (entry === undefined) return;
    waiting.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error !== undefined) {
      const code = isRecord(message.error) ? message.error.code : undefined;
      entry.reject(
        new ControlSocketError(
          code === -32601 || code === -32600 ? "method-not-found" : "refused",
          typeof code === "number" ? code : undefined,
        ),
      );
    } else entry.resolve(message.result);
  });
  socket.addEventListener("close", failAll);
  socket.addEventListener("error", failAll);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new ControlSocketError("no-answer"));
      socket.close();
    }, timeoutMs);
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new ControlSocketError("no-answer"));
    });
  });
  const call = (method: string, params?: unknown) =>
    new Promise<unknown>((resolve, reject) => {
      if (closed) {
        reject(new ControlSocketError("no-answer"));
        return;
      }
      const id = next++;
      const timer = setTimeout(() => {
        if (waiting.delete(id)) reject(new ControlSocketError("no-answer"));
      }, timeoutMs);
      waiting.set(id, { resolve, reject, timer });
      socket.send(
        JSON.stringify(
          params === undefined ? { id, method } : { id, method, params },
        ),
      );
    });
  try {
    await call("initialize", {
      clientInfo: {
        name: "lazurio_launchpad",
        title: "Lazurio",
        version: options.version ?? "0",
      },
      capabilities: { experimentalApi: true },
    });
    socket.send(JSON.stringify({ method: "initialized" }));
  } catch (error) {
    socket.close();
    throw error instanceof ControlSocketError
      ? error
      : new ControlSocketError("no-answer");
  }
  return Object.freeze({
    call,
    close: () => {
      closed = true;
      socket.close();
    },
  });
}
