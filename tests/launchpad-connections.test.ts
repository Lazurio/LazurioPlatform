import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlSocketError } from "../src/connections/control-socket";
import type { ConnectionsHost } from "../src/connections/pairing";
import { initializeFolder } from "../src/folder/initialize-folder";
import { executionOs } from "../src/folder/platform";
import { startLaunchpad } from "../src/launchpad/server";
import type { AiProbe } from "../src/tools/ai-probe";
import { runTool } from "../src/tools/status";

// Settings → Connections over HTTP (decision F71): the routes sit behind the
// admission of every `/api/*` route (locally the token, and same origin for
// a write), answer `no-store`, and a Codex without a daemon is a state, not
// an error. The host is a fake; no Codex is asked.

const posix = process.platform !== "win32";

test.skipIf(!posix)(
  "the Connections routes are admitted like every route",
  async () => {
    const parent = await realpath(
      await mkdtemp(join(tmpdir(), "launchpad-connections-")),
    );
    const folder = join(parent, "Lazurio");
    await initializeFolder(folder, {
      os: executionOs(process.platform),
      access: "local",
      purpose: "human",
      locale: "en",
      detail: "concise",
      coordination: "direct",
    });
    let connects = 0;
    const host: ConnectionsHost = {
      kind: async () => "personal",
      ai: async () => ({
        state: "connected",
        providers: [
          { provider: "codex", state: "signed-in", method: "chatgpt" },
        ],
      }),
      connect: async () => {
        connects += 1;
        throw new ControlSocketError("no-socket");
      },
      restartable: async () => false,
      restart: async () => ({ state: "not-managed" }),
      trust: async () => undefined,
    };
    const ai = {
      state: host.ai,
      forget: () => undefined,
    } as unknown as AiProbe;
    const app = await startLaunchpad(
      folder,
      undefined,
      undefined,
      undefined,
      {},
      {
        path: "/usr/bin:/bin",
        home: parent,
        xdg: {},
        platform: process.platform,
        run: runTool,
      },
      {},
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      ai,
      host,
    );
    try {
      const url = new URL(app.url);
      const token = url.hash.slice(1);
      const at = (path: string) => new URL(path, url.origin);
      expect((await fetch(at("/api/connections"))).status).toBe(403);
      expect(connects).toBe(0);
      const read = await fetch(at("/api/connections"), {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(read.status).toBe(200);
      expect(read.headers.get("cache-control")).toBe("no-store");
      expect(await read.json()).toEqual({
        kind: "connections",
        state: "no-remote-control",
        reason: "no-daemon",
        devices: [],
        restart: false,
      });
      // A write from another origin is refused before the core.
      const before = connects;
      const foreign = await fetch(at("/api/connections/pair"), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Origin: "https://example.invalid",
        },
        body: "{}",
      });
      expect(foreign.status).toBe(403);
      expect(connects).toBe(before);
      const pair = await fetch(at("/api/connections/pair"), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Origin: url.origin,
        },
        body: "{}",
      });
      expect(pair.status).toBe(409);
      expect(await pair.json()).toMatchObject({
        kind: "blocked",
        reason: "no-remote-control",
      });
    } finally {
      await app.close();
      await rm(parent, { recursive: true, force: true });
    }
  },
);
