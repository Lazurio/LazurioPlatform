import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chatT3Label } from "../src/t3-links/live";
import {
  linkScopes,
  loopbackOrigin,
  openChatT3Rpc,
  parseIssuedSession,
} from "../src/t3-links/rpc";
import type { ToolRunner } from "../src/tools/status";

// The running Chat's RPC as `src/t3-links/rpc.ts` speaks it: a session T3
// Code issues for one look (`t3 auth session issue --json`), a WebSocket on
// loopback (`/ws?orchestrationProtocol=2`) with the token in its upgrade
// header, Effect RPC's JSON messages (`Request`, `Exit`, `Ping`/`Pong`) and
// the session revoked after the look. The server here is a real WebSocket
// server on loopback that answers as T3 Code's does; the token is synthetic.

const directories: string[] = [];
const servers: { stop: (force?: boolean) => void }[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

const token = "tok_0123456789abcdefghijklmnop";
const sessionId = "5c077b61-0000-4000-8000-000000000001";

async function homeWith(origin: string | null) {
  const home = await mkdtemp(join(tmpdir(), "lazurio-t3-rpc-"));
  directories.push(home);
  await mkdir(join(home, ".t3", "userdata"), { recursive: true });
  if (origin !== null)
    await writeFile(
      join(home, ".t3", "userdata", "server-runtime.json"),
      JSON.stringify({ version: 1, pid: 1, port: 1, origin, startedAt: "x" }),
    );
  return home;
}

function t3Cli(commands: (readonly string[])[]): ToolRunner {
  return async (command) => {
    commands.push(command);
    if (command[3] === "issue")
      return {
        exitCode: 0,
        stdout: `log line\n${JSON.stringify({ sessionId, token, scopes: linkScopes }, null, 2)}\n`,
        stderr: "",
      };
    if (command[3] === "revoke")
      return { exitCode: 0, stdout: "Revoked.\n", stderr: "" };
    return { exitCode: 1, stdout: "", stderr: "" };
  };
}

test("one look's RPC: a session of its own, the token only in the upgrade header, revoked after", async () => {
  const seen: { url: string; authorization: string | null }[] = [];
  const received: unknown[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request, current) {
      seen.push({
        url: request.url,
        authorization: request.headers.get("authorization"),
      });
      return current.upgrade(request)
        ? undefined
        : new Response("no", { status: 400 });
    },
    websocket: {
      open(socket) {
        socket.send(JSON.stringify({ _tag: "Ping" }));
      },
      message(socket, data) {
        const message = JSON.parse(String(data));
        received.push(message);
        if (message._tag !== "Request") return;
        socket.send(
          JSON.stringify(
            message.tag === "peerLinks.link"
              ? {
                  _tag: "Exit",
                  requestId: message.id,
                  exit: {
                    _tag: "Failure",
                    cause: [
                      {
                        _tag: "Fail",
                        error: {
                          _tag: "PeerLinkError",
                          reason: "pairing_rejected",
                          message: `rejected ${message.payload.pairingCode}`,
                        },
                      },
                    ],
                  },
                }
              : [
                  {
                    _tag: "Exit",
                    requestId: message.id,
                    exit: { _tag: "Success", value: { links: [] } },
                  },
                ],
          ),
        );
      },
    },
  });
  servers.push(server);
  const home = await homeWith(`http://127.0.0.1:${server.port}`);
  const commands: (readonly string[])[] = [];
  const open = openChatT3Rpc({
    home,
    uid: process.getuid?.(),
    t3: "/opt/t3",
    run: t3Cli(commands),
    env: { HOME: home },
  });
  const rpc = await open();
  if (typeof rpc === "string") throw new Error(rpc);
  expect(await rpc.request("peerLinks.list", {})).toEqual({
    ok: true,
    value: { links: [] },
  });
  // A failure says what T3 Code refused, never what was sent.
  const failed = await rpc.request("peerLinks.link", {
    url: "https://t3code.a.b.lazurio.io",
    pairingCode: "code-secret-42",
    access: "full-access",
  });
  expect(failed).toEqual({
    ok: false,
    error: "PeerLinkError:pairing_rejected",
  });
  expect(JSON.stringify(failed)).not.toContain("code-secret-42");
  await rpc.close();

  expect(seen).toEqual([
    {
      url: `http://127.0.0.1:${server.port}/ws?orchestrationProtocol=2`,
      authorization: `Bearer ${token}`,
    },
  ]);
  // The server's ping is answered, in whatever order it arrived.
  expect(received).toContainEqual({ _tag: "Pong" });
  expect(
    received.filter(
      (message) => (message as { _tag: string })._tag === "Request",
    ),
  ).toEqual([
    {
      _tag: "Request",
      id: "0",
      tag: "peerLinks.list",
      payload: {},
      headers: [],
    },
    {
      _tag: "Request",
      id: "1",
      tag: "peerLinks.link",
      payload: {
        url: "https://t3code.a.b.lazurio.io",
        pairingCode: "code-secret-42",
        access: "full-access",
      },
      headers: [],
    },
  ]);
  // Issued with exactly the look's scopes and a short life; revoked after.
  expect(commands).toEqual([
    [
      "/opt/t3",
      "auth",
      "session",
      "issue",
      "--base-dir",
      join(home, ".t3"),
      "--scope",
      "access:read",
      "--scope",
      "access:write",
      "--scope",
      "settings:write",
      "--ttl",
      "2m",
      "--label",
      "Lazurio links",
      "--json",
    ],
    [
      "/opt/t3",
      "auth",
      "session",
      "revoke",
      "--base-dir",
      join(home, ".t3"),
      sessionId,
    ],
  ]);
  for (const command of commands) {
    expect(command.join(" ")).not.toContain(token);
    expect(command.join(" ")).not.toContain("code-secret-42");
  }
});

test("without a running server nothing is issued; a refused upgrade revokes the session", async () => {
  const commands: (readonly string[])[] = [];
  const none = await homeWith(null);
  const open = openChatT3Rpc({
    home: none,
    uid: process.getuid?.(),
    t3: "/opt/t3",
    run: t3Cli(commands),
    env: {},
  });
  expect(await open()).toBe("server-down");
  expect(commands).toHaveLength(0);

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => new Response("unauthorized", { status: 401 }),
  });
  servers.push(server);
  const refused = await homeWith(`http://127.0.0.1:${server.port}`);
  const second = openChatT3Rpc({
    home: refused,
    uid: process.getuid?.(),
    t3: "/opt/t3",
    run: t3Cli(commands),
    env: {},
  });
  expect(await second()).toBe("server-down");
  expect(commands.map((command) => command[3])).toEqual(["issue", "revoke"]);
});

test("only a loopback origin is asked, and only a session in T3 Code's shape is used", async () => {
  expect(loopbackOrigin("http://127.0.0.1:3773")).toBe("http://127.0.0.1:3773");
  expect(loopbackOrigin("https://t3code.example.lazurio.io")).toBeUndefined();
  expect(loopbackOrigin("http://user:pw@127.0.0.1:3773")).toBeUndefined();
  expect(loopbackOrigin("http://10.0.0.1:3773")).toBeUndefined();
  expect(
    parseIssuedSession(`{"sessionId":"${sessionId}","token":"short"}`),
  ).toBe(undefined);
  expect(
    parseIssuedSession(`{"sessionId":"a b","token":"${token}"}`),
  ).toBeUndefined();
  const home = await homeWith("http://127.0.0.1:3773");
  const asked: string[] = [];
  expect(
    await chatT3Label(home, process.getuid?.(), async (url) => {
      asked.push(url);
      return new Response(JSON.stringify({ label: " lazurio-bob " }));
    }),
  ).toBe("lazurio-bob");
  expect(asked).toEqual(["http://127.0.0.1:3773/.well-known/t3/environment"]);
  expect(await chatT3Label(await homeWith(null), process.getuid?.())).toBe(
    undefined,
  );
});
