import { join } from "node:path";
import { readOwnFile } from "../ssh-access/environments";
import type { ToolRunner } from "../tools/status";
import { chatT3Home } from "./settings";

// The running Chat T3 Code's own API for the links (root decision 0157,
// amended 2026-11-17): its RPC over `/ws` on this Machine's loopback, the
// one T3 Code's own clients use (`packages/contracts/src/rpc.ts`, Effect
// RPC with JSON messages). Through it the link is made (`peerLinks.link`),
// listed and forgotten, and the beta switch is set (`server.updateSettings`),
// so T3 Code stays the one writer of its settings (decision F51) and the
// pairing code travels only inside this process and over loopback, never on
// a command line.
//
// The session is T3 Code's own, issued for one look and revoked after it, as
// `t3 lazurio model` does for its call: `t3 auth session issue` with exactly
// the scopes the look needs and a life of two minutes prints the bearer token
// on its standard output, which only this process reads; it goes into the
// `Authorization` header of the WebSocket upgrade and nowhere else. Without a
// running server nothing is changed: the server is what the links need.

/** The scopes of one look: list and change links, write one setting. */
export const linkScopes = [
  "access:read",
  "access:write",
  "settings:write",
] as const;
/** T3 Code's orchestration protocol the RPC speaks (`/ws?orchestrationProtocol=`). */
export const orchestrationProtocol = 2;

const sessionTtl = "2m";
const requestTimeoutMs = 90_000;
const idToken = /^[A-Za-z0-9-]{1,64}$/;

export type RpcAnswer =
  | Readonly<{ ok: true; value: unknown }>
  | Readonly<{ ok: false; error: string }>;

export type T3Rpc = Readonly<{
  request(tag: string, payload: unknown): Promise<RpcAnswer>;
  close(): Promise<void>;
}>;

/** Opens the RPC for one look, or answers why not. */
export type OpenT3Rpc = () => Promise<T3Rpc | "server-down" | "refused">;

/** The origin of a T3 Code server on this Machine's loopback, as its runtime
 * state names it; anything else is not asked. */
export function loopbackOrigin(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
      url.pathname === "/" &&
      url.search === "" &&
      url.username === "" &&
      url.password === ""
      ? url.origin
      : undefined;
  } catch {
    return undefined;
  }
}

/** The loopback origin the user's running Chat T3 Code recorded in its
 * runtime state (`~/.t3/userdata/server-runtime.json`). */
export async function chatT3Origin(
  home: string,
  uid: number | undefined,
): Promise<string | undefined> {
  const observed = await readOwnFile(
    join(home, chatT3Home, "userdata", "server-runtime.json"),
    uid,
  ).catch(() => undefined);
  if (observed?.kind !== "file") return undefined;
  try {
    return loopbackOrigin(
      (JSON.parse(observed.bytes.toString("utf8")) as { origin?: unknown })
        .origin,
    );
  } catch {
    return undefined;
  }
}

/** `t3 auth session issue --json`: the session's id and its token. */
export function parseIssuedSession(
  stdout: string,
): Readonly<{ sessionId: string; token: string }> | undefined {
  const lines = stdout.split("\n");
  const start = lines.findIndex((line) => line.trimStart().startsWith("{"));
  if (start === -1) return undefined;
  try {
    const value = JSON.parse(lines.slice(start).join("\n")) as Record<
      string,
      unknown
    >;
    return typeof value.sessionId === "string" &&
      idToken.test(value.sessionId) &&
      typeof value.token === "string" &&
      /^[A-Za-z0-9._~+/=-]{16,4096}$/.test(value.token)
      ? { sessionId: value.sessionId, token: value.token }
      : undefined;
  } catch {
    return undefined;
  }
}

type Socket = Readonly<{
  send(data: string): void;
  close(): void;
  onMessage(listener: (data: string) => void): void;
  onClose(listener: () => void): void;
  opened: Promise<boolean>;
}>;

export type ConnectSocket = (
  url: string,
  headers: Readonly<Record<string, string>>,
) => Socket;

/** A WebSocket with request headers (Bun's client accepts them). */
export const bunSocket: ConnectSocket = (url, headers) => {
  const socket = new WebSocket(url, { headers } as unknown as string[]);
  const messages: ((data: string) => void)[] = [];
  // What arrives before anyone listens (a server's first ping) is kept and
  // handed to the first listener, never dropped.
  const early: string[] = [];
  const closes: (() => void)[] = [];
  const opened = new Promise<boolean>((resolve) => {
    socket.addEventListener("open", () => resolve(true));
    socket.addEventListener("error", () => resolve(false));
    socket.addEventListener("close", () => resolve(false));
  });
  socket.addEventListener("message", (event) => {
    const data =
      typeof event.data === "string"
        ? event.data
        : Buffer.from(event.data as ArrayBuffer).toString("utf8");
    if (messages.length === 0) early.push(data);
    for (const listener of messages) listener(data);
  });
  socket.addEventListener("close", () => {
    for (const listener of closes) listener();
  });
  return {
    send: (data) => socket.send(data),
    close: () => socket.close(),
    onMessage: (listener) => {
      messages.push(listener);
      for (const data of early.splice(0)) listener(data);
    },
    onClose: (listener) => closes.push(listener),
    opened,
  };
};

// What an RPC failure says, without anything it carried: its tag and, for
// T3 Code's own errors, their reason. Never a payload.
function failureOf(exit: Record<string, unknown>): string {
  const cause = exit.cause;
  const first = Array.isArray(cause) ? cause[0] : cause;
  if (first !== null && typeof first === "object") {
    const error = (first as Record<string, unknown>).error;
    if (error !== null && typeof error === "object") {
      const { _tag, reason } = error as Record<string, unknown>;
      return [_tag, reason]
        .filter((part): part is string => typeof part === "string")
        .join(":")
        .slice(0, 80);
    }
    const tag = (first as Record<string, unknown>)._tag;
    if (typeof tag === "string") return tag.slice(0, 40);
  }
  return "failure";
}

/** The RPC of the user's running Chat T3 Code for one look. */
export function openChatT3Rpc(
  input: Readonly<{
    home: string;
    uid: number | undefined;
    t3: string;
    run: ToolRunner;
    env: Readonly<Record<string, string>>;
    connect?: ConnectSocket;
    origin?: () => Promise<string | undefined>;
  }>,
): OpenT3Rpc {
  return async () => {
    const origin = await (
      input.origin ?? (() => chatT3Origin(input.home, input.uid))
    )();
    if (origin === undefined) return "server-down";
    const base = join(input.home, chatT3Home);
    const issued = await input
      .run(
        [
          input.t3,
          "auth",
          "session",
          "issue",
          "--base-dir",
          base,
          ...linkScopes.flatMap((scope) => ["--scope", scope]),
          "--ttl",
          sessionTtl,
          "--label",
          "Lazurio links",
          "--json",
        ],
        30_000,
        input.env,
      )
      .catch(() => "timeout" as const);
    const session =
      issued === "timeout" || issued.exitCode !== 0
        ? undefined
        : parseIssuedSession(issued.stdout);
    if (session === undefined) return "refused";
    const revoke = async () => {
      await input
        .run(
          [
            input.t3,
            "auth",
            "session",
            "revoke",
            "--base-dir",
            base,
            session.sessionId,
          ],
          30_000,
          input.env,
        )
        .catch(() => undefined);
    };
    const url = `${origin.replace(/^http/, "ws")}/ws?orchestrationProtocol=${orchestrationProtocol}`;
    const socket = (input.connect ?? bunSocket)(url, {
      authorization: `Bearer ${session.token}`,
    });
    if (!(await socket.opened)) {
      socket.close();
      await revoke();
      return "server-down";
    }
    let next = 0;
    let closed = false;
    const waiting = new Map<string, (answer: RpcAnswer) => void>();
    const settleAll = (error: string) => {
      for (const resolve of waiting.values()) resolve({ ok: false, error });
      waiting.clear();
    };
    socket.onClose(() => {
      closed = true;
      settleAll("closed");
    });
    socket.onMessage((data) => {
      let messages: unknown;
      try {
        messages = JSON.parse(data);
      } catch {
        return;
      }
      for (const message of Array.isArray(messages) ? messages : [messages]) {
        if (message === null || typeof message !== "object") continue;
        const value = message as Record<string, unknown>;
        if (value._tag === "Ping") {
          socket.send(JSON.stringify({ _tag: "Pong" }));
          continue;
        }
        const requestId =
          value.requestId === undefined ? undefined : String(value.requestId);
        if (requestId === undefined) continue;
        const resolve = waiting.get(requestId);
        if (resolve === undefined) continue;
        if (value._tag === "Exit") {
          waiting.delete(requestId);
          const exit = (value.exit ?? {}) as Record<string, unknown>;
          resolve(
            exit._tag === "Success"
              ? { ok: true, value: exit.value }
              : { ok: false, error: failureOf(exit) },
          );
        } else if (value._tag === "Defect") {
          waiting.delete(requestId);
          resolve({ ok: false, error: "defect" });
        }
      }
    });
    return {
      request(tag, payload) {
        if (closed) return Promise.resolve({ ok: false, error: "closed" });
        const id = String(next++);
        return new Promise<RpcAnswer>((resolve) => {
          const timer = setTimeout(() => {
            waiting.delete(id);
            resolve({ ok: false, error: "timeout" });
          }, requestTimeoutMs);
          waiting.set(id, (answer) => {
            clearTimeout(timer);
            resolve(answer);
          });
          socket.send(
            JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] }),
          );
        });
      },
      async close() {
        settleAll("closed");
        socket.close();
        await revoke();
      },
    };
  };
}
