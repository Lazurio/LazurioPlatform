import { expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { computerHelp } from "../src/computers/cli";
import type { ComputersHost } from "../src/computers/computers";
import {
  auditPath,
  computersDirectory,
  readRecord,
  recordPath,
  toolsPath,
} from "../src/computers/state";
import type { ExecutorEndpoint } from "../src/integrations/executor-client";
import {
  computerDetail,
  parseComputers,
} from "../src/launchpad/computers-panel";
import { createComputersRoutes } from "../src/launchpad/computers-routes";
import { messages } from "../src/launchpad/messages";
import { socketHomeParent } from "./fixtures/socket-home";

// People's computers for agents in the Launchpad (decision F75) on contract
// v3: the list of Settings → Connections reads the records the computers'
// first attaches created, and the removal deletes the record, its server in
// Executor and its tool list, while the history stays. Contract v1's
// pairing, the page and `POST /api/computers`, is gone. A temporary home and
// a fake Executor stand in for the account's.

const posix = process.platform !== "win32";

/** A fake Executor: every call is noted and every removal succeeds. */
async function fakeExecutor(home: string) {
  const dataDir = join(home, ".executor");
  await mkdir(join(dataDir, "server-control"), {
    recursive: true,
    mode: 0o700,
  });
  await writeFile(
    join(dataDir, "server-control", "auth.json"),
    JSON.stringify({ token: "t".repeat(32) }),
    { mode: 0o600 },
  );
  const calls: { method: string; path: string }[] = [];
  const endpoint: ExecutorEndpoint = {
    dataDir,
    port: 4789,
    uid: process.getuid?.() ?? 0,
    ownsListener: async () => true,
    transport: async (input) => {
      calls.push({ method: input.method, path: input.path });
      return {
        kind: "answer",
        status: 200,
        type: "application/json",
        text: JSON.stringify({ removed: true }),
      };
    },
  };
  return { endpoint, calls };
}

async function withRoutes(
  run: (
    routes: ReturnType<typeof createComputersRoutes>,
    home: string,
    calls: readonly { method: string; path: string }[],
  ) => Promise<void>,
) {
  const parent = await mkdtemp(join(socketHomeParent(), "lazurio-computers-"));
  const home = join(parent, "home");
  await mkdir(join(home, ".local", "bin"), { recursive: true, mode: 0o700 });
  const entry = join(home, ".local", "bin", "lazurio");
  await writeFile(entry, "#!/bin/sh\n");
  await chmod(entry, 0o700);
  const executor = await fakeExecutor(home);
  const host: ComputersHost = {
    platform: "linux",
    home,
    uid: process.getuid?.(),
    executorCommand: async () => entry,
    executor: executor.endpoint,
    allowed: async () => true,
    locale: async () => "cs",
    version: "test",
  };
  const routes = createComputersRoutes({
    host: () => host,
    headers: { "Cache-Control": "no-store" },
  });
  try {
    await run(routes, home, executor.calls);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

/** A record as a computer's first attach writes it. */
async function writeRecord(
  home: string,
  record: Readonly<{
    deviceId: string;
    name: string;
    os: string | null;
    executor: string | null;
  }>,
) {
  await mkdir(computersDirectory(home), { recursive: true, mode: 0o700 });
  await writeFile(recordPath(home, record.deviceId), JSON.stringify(record), {
    mode: 0o600,
  });
}

const api = new URL("https://launchpad.example/api/computers");
const removeUrl = new URL("https://launchpad.example/api/computers/remove");

test.skipIf(!posix)(
  "the list reads the records of the computers that attached, and their activity",
  () =>
    withRoutes(async (routes, home) => {
      const empty = await routes.handle(new Request(api), api);
      expect(await empty.json()).toEqual({
        kind: "computers",
        supported: true,
        computers: [],
      });
      await writeRecord(home, {
        deviceId: "alex-macbook",
        name: "MacBook Pro Matěje",
        os: "macos",
        executor: "po_macbook",
      });
      await writeRecord(home, {
        deviceId: "alex-windows",
        name: "alex-windows",
        os: null,
        executor: null,
      });
      // A tool list and the history are no records.
      await writeFile(toolsPath(home, "alex-macbook"), "[]", { mode: 0o600 });
      await writeFile(
        auditPath(home),
        `${JSON.stringify({ ts: "2026-11-17T10:00:00.000Z", device: "alex-macbook", event: "connected", version: "0.2.0", system: "macos" })}\n`,
        { mode: 0o600 },
      );
      const list = await routes.handle(new Request(api), api);
      expect(list.status).toBe(200);
      expect(await list.clone().json()).toEqual({
        kind: "computers",
        supported: true,
        computers: [
          {
            deviceId: "alex-macbook",
            name: "MacBook Pro Matěje",
            os: "macos",
            connected: false,
            lastActivity: "2026-11-17T10:00:00.000Z",
            agents: "executor",
            appVersion: "0.2.0",
            appSystem: "macos",
            updating: false,
          },
          {
            deviceId: "alex-windows",
            name: "alex-windows",
            os: null,
            connected: false,
            lastActivity: null,
            agents: "missing",
            appVersion: null,
            appSystem: null,
            updating: false,
          },
        ],
      });
      expect(
        parseComputers(await list.json())?.computers?.map((item) => [
          item.deviceId,
          item.name,
          item.os,
        ]),
      ).toEqual([
        ["alex-macbook", "MacBook Pro Matěje", "macos"],
        ["alex-windows", "alex-windows", null],
      ]);
    }),
);

test.skipIf(!posix)(
  "the removal takes the record, Executor's server and the tool list, keeps the history and says what follows",
  () =>
    withRoutes(async (routes, home, calls) => {
      await writeRecord(home, {
        deviceId: "alex-macbook",
        name: "MacBook Pro Alexe",
        os: "macos",
        executor: "po_macbook",
      });
      await writeFile(toolsPath(home, "alex-macbook"), "[]", { mode: 0o600 });
      const history = `${JSON.stringify({ ts: "2026-11-17T10:00:00.000Z", device: "alex-macbook", event: "connected" })}\n`;
      await writeFile(auditPath(home), history, { mode: 0o600 });
      const remove = (body: unknown) =>
        routes.handle(
          new Request(removeUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
          removeUrl,
        );
      const removed = await remove({ deviceId: "alex-macbook" });
      expect(removed.status).toBe(200);
      const answer = (await removed.json()) as Record<string, unknown>;
      expect(answer).toMatchObject({
        kind: "computer-removed",
        deviceId: "alex-macbook",
        agents: "removed",
      });
      // The answer says when the session ends and how the computer comes
      // back.
      expect(answer.note).toContain("broker's next check");
      expect(answer.note).toContain("attach again");
      expect(calls).toEqual([
        { method: "DELETE", path: "/api/mcp/servers/po_macbook" },
      ]);
      expect(await readRecord(home, "alex-macbook")).toBeNull();
      expect(
        await readFile(toolsPath(home, "alex-macbook")).then(
          () => true,
          () => false,
        ),
      ).toBe(false);
      expect(await readFile(auditPath(home), "utf8")).toBe(history);
      // Again: nothing to remove.
      const again = await remove({ deviceId: "alex-macbook" });
      expect(again.status).toBe(404);
      expect(await again.json()).toEqual({
        kind: "blocked",
        reason: "not-found",
      });
      expect((await remove({ deviceId: "A B" })).status).toBe(400);
      expect((await remove({ deviceId: "x", other: 1 })).status).toBe(400);
    }),
);

test.skipIf(!posix)("the pairing of contract v1 is gone", () =>
  withRoutes(async (routes, home) => {
    const posted = await routes.handle(
      new Request(api, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Alex MacBook",
          os: "macos",
          publicKey: "ssh-ed25519 AAAA",
        }),
      }),
      api,
    );
    expect(posted.status).toBe(404);
    expect(routes.handlesRetired("/connect/computer")).toBe(true);
    expect(routes.retired().status).toBe(404);
    expect(await readRecord(home, "alex-macbook")).toBeNull();
  }),
);

test("the CLI's help says what a removal means", () => {
  expect(computerHelp).toContain("broker's next check");
  expect(computerHelp).toContain("attach again");
  expect(computerHelp).not.toContain("paired");
});

test("the list's line says what the person needs", () => {
  const copy = messages("cs");
  expect(
    computerDetail(
      copy,
      {
        deviceId: "alex-macbook",
        name: "Alex MacBook",
        os: "macos",
        connected: true,
        lastActivity: "2026-11-12T10:05:00.000Z",
        agents: "executor",
        appVersion: "0.1.3",
        updating: false,
      },
      () => "12. 11. 2026 11:05",
    ),
  ).toBe("macOS · v0.1.3 · Připojený · Poslední činnost 12. 11. 2026 11:05");
  expect(
    computerDetail(
      copy,
      {
        deviceId: "alex-macbook",
        name: "Alex MacBook",
        os: "windows",
        connected: false,
        lastActivity: null,
        agents: "executor",
        appVersion: "v0.1.4",
        updating: true,
      },
      () => "",
    ),
  ).toBe(
    "Windows · v0.1.4 · Aktualizuje se, asi za minutu bude zpět · Zatím bez činnosti",
  );
  expect(
    parseComputers({ kind: "computers", supported: false, reason: "not-here" }),
  ).toEqual({
    computers: null,
  });
  expect(parseComputers({ kind: "other" })).toBeNull();
});
