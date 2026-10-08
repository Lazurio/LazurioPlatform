import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contract } from "./fixtures/contract";
import {
  captureConsole,
  claudeServers,
  connectionsWorld,
  filesContaining,
  worldLaunchpad,
} from "./fixtures/fake-connections";
import { runChild } from "./fixtures/run-child";

// The Environment's MCP servers (decision F42, proposed,
// docs/connected-apps.md section 7): one list in the Folder, managed on the
// page, rendered into every consumer — Codex's `~/.codex/config.toml`, Claude
// Code's user scope through its own CLI, and MausBot through those two — with
// the values of headers and variables in local custody only. RED BY DESIGN
// until its slice lands (section 15); the fixture tests prove the fakes.

const posix = test.skipIf(process.platform === "win32");

// The operator's own Codex configuration, with a server they added by hand.
const codexConfig =
  'model = "example-model"\n\n[mcp_servers.own]\ncommand = "own-server"\n';
// MausBot's own registry, which Lazurio never writes.
const mausbotConfig = '{\n  "mcpServers": {}\n}\n';
const headerValue = "Bearer mcp-header-canary-0000";
const envValue = "mcp-env-canary-0000";
const invoicing = {
  name: "invoicing-mcp",
  kind: "url",
  url: "https://mcp.example.com/mcp",
  secret: { kind: "header", name: "Authorization", value: headerValue },
};
const notes = {
  name: "ledger-notes",
  kind: "command",
  command: "npx",
  args: ["-y", "@example/notes-mcp"],
  secret: { kind: "env", name: "LEDGER_TOKEN", value: envValue },
};

async function launchpad() {
  const parent = await realpath(
    await mkdtemp(join(tmpdir(), "connections-mcp-")),
  );
  const world = await connectionsWorld(parent, {
    claudeServers: { mine: { type: "stdio", command: "mine" } },
    codexConfig,
  });
  await mkdir(join(world.home, ".openmausbot"), { mode: 0o700 });
  await writeFile(
    join(world.home, ".openmausbot", "config.json"),
    mausbotConfig,
    {
      mode: 0o600,
    },
  );
  // The Folder lies beside the home, so what the home holds is custody.
  const launchpad = await worldLaunchpad(parent, world, "en");
  return {
    ...world,
    ...launchpad,
    /** The Folder revision the next change names. */
    revision: async () =>
      (
        (await (await launchpad.post("/api/profile", {})).json()) as {
          revision: number;
        }
      ).revision,
    codex: async () => {
      const text = await readFile(
        join(world.home, ".codex", "config.toml"),
        "utf8",
      );
      return {
        text,
        parsed: Bun.TOML.parse(text) as {
          model?: string;
          mcp_servers?: Record<string, Record<string, unknown>>;
        },
      };
    },
    async close() {
      await launchpad.close();
      await rm(parent, { recursive: true, force: true });
    },
  };
}

type Launchpad = Awaited<ReturnType<typeof launchpad>>;

/** Adds a server at the current revision; the answer as text. */
async function add(lp: Launchpad, server: unknown) {
  const response = await lp.post("/api/connections/mcp/add", {
    expectedRevision: await lp.revision(),
    server,
  });
  return { status: response.status, text: await response.text() };
}

posix(
  "fixture: the fake MCP server completes a handshake and lists two tools",
  async () => {
    const parent = await realpath(
      await mkdtemp(join(tmpdir(), "mcp-fixture-")),
    );
    try {
      const { mcpServer } = await connectionsWorld(parent);
      const child = Bun.spawn([mcpServer], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "ignore",
      });
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } })}\n${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`,
      );
      await child.stdin.end();
      const lines = (await new Response(child.stdout).text())
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(lines.map((line) => line.id)).toEqual([1, 2]);
      expect(lines[0].result.serverInfo.name).toBe("fake-mcp-server");
      expect(lines[1].result.tools).toHaveLength(2);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  },
  30_000,
);

posix(
  "fixture: the fake claude keeps user-scope servers and refuses a taken name",
  async () => {
    const parent = await realpath(
      await mkdtemp(join(tmpdir(), "mcp-fixture-")),
    );
    try {
      const { home, path } = await connectionsWorld(parent, {
        claudeServers: { mine: { type: "stdio", command: "mine" } },
      });
      const claude = (...args: string[]) =>
        runChild([join(path, "claude"), ...args], {
          env: { PATH: path, HOME: home },
        });
      const json = JSON.stringify({
        type: "http",
        url: "https://mcp.example.com/mcp",
      });
      expect(
        (await claude("mcp", "add-json", "--scope", "user", "x", json))
          .exitCode,
      ).toBe(0);
      expect(
        (await claude("mcp", "add-json", "--scope", "user", "mine", json))
          .exitCode,
      ).toBe(1);
      expect((await claude("mcp", "get", "x")).exitCode).toBe(0);
      expect(
        (await claude("mcp", "remove", "--scope", "user", "x")).exitCode,
      ).toBe(0);
      expect(Object.keys(await claudeServers(home))).toEqual(["mine"]);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  },
  30_000,
);

contract(
  "an MCP server added on the page reaches Codex and Claude Code, and MausBot through them; the Folder names it",
  async () => {
    const lp = await launchpad();
    try {
      for (const server of [invoicing, notes])
        expect((await add(lp, server)).status).toBe(200);
      // Codex: its documented [mcp_servers.<name>] tables; every other byte
      // of the operator's file kept; the file stays private.
      const codex = await lp.codex();
      expect(codex.text).toContain(codexConfig);
      expect(codex.parsed.model).toBe("example-model");
      expect(codex.parsed.mcp_servers?.own).toEqual({ command: "own-server" });
      expect(codex.parsed.mcp_servers?.["invoicing-mcp"]).toMatchObject({
        url: invoicing.url,
        http_headers: { Authorization: headerValue },
      });
      expect(codex.parsed.mcp_servers?.["ledger-notes"]).toMatchObject({
        command: "npx",
        args: notes.args,
        env: { LEDGER_TOKEN: envValue },
      });
      expect(
        (await stat(join(lp.home, ".codex", "config.toml"))).mode & 0o777,
      ).toBe(0o600);
      // Claude Code: its user scope, written by its own CLI.
      const claude = await claudeServers(lp.home);
      expect(claude.mine).toEqual({ type: "stdio", command: "mine" });
      expect(claude["invoicing-mcp"]).toMatchObject({
        type: "http",
        url: invoicing.url,
        headers: { Authorization: headerValue },
      });
      expect(claude["ledger-notes"]).toMatchObject({
        type: "stdio",
        command: "npx",
        args: notes.args,
        env: { LEDGER_TOKEN: envValue },
      });
      // MausBot's bots read those two; its own registry is not written.
      expect(
        await readFile(join(lp.home, ".openmausbot", "config.json"), "utf8"),
      ).toBe(mausbotConfig);
      // The Folder tells its agents which servers the Environment has.
      for (const file of ["AGENTS.md", "manual/this-machine.md"]) {
        const text = await readFile(join(lp.folder, file), "utf8");
        expect(text).toContain("invoicing-mcp");
        expect(text).toContain("ledger-notes");
      }
      // A name a consumer already uses for a server of its own is refused
      // before anything is written.
      const conflict = await add(lp, {
        name: "own",
        kind: "command",
        command: "own-server",
      });
      expect(conflict.status).toBe(409);
      expect(JSON.parse(conflict.text)).toMatchObject({
        kind: "blocked",
        reason: "consumer-conflict",
      });
      expect((await lp.codex()).parsed.mcp_servers?.own).toEqual({
        command: "own-server",
      });
    } finally {
      await lp.close();
    }
  },
  30_000,
);

contract(
  "the value of a header or variable never reaches the Folder, an answer or a log; it stays in 0600 custody",
  async () => {
    const logged = captureConsole();
    const lp = await launchpad();
    try {
      const answers: string[] = [];
      for (const server of [invoicing, notes]) {
        const added = await add(lp, server);
        answers.push(added.text);
        expect(added.status).toBe(200);
      }
      const listed = await lp.get("/api/connections/mcp");
      expect(listed.status).toBe(200);
      const text = await listed.text();
      answers.push(text);
      const body = JSON.parse(text) as {
        servers: { name: string; secret?: unknown }[];
      };
      expect(
        body.servers.map((server) => [server.name, server.secret]),
      ).toEqual([
        ["invoicing-mcp", { kind: "header", name: "Authorization" }],
        ["ledger-notes", { kind: "env", name: "LEDGER_TOKEN" }],
      ]);
      const preferences = JSON.parse(
        await readFile(join(lp.folder, ".lazurio", "preferences.json"), "utf8"),
      ) as { mcpServers?: { name: string }[] };
      expect(preferences.mcpServers?.map((server) => server.name)).toEqual([
        "invoicing-mcp",
        "ledger-notes",
      ]);
      for (const value of [headerValue, envValue]) {
        for (const answer of answers) expect(answer).not.toContain(value);
        expect(logged.text()).not.toContain(value);
        expect(await filesContaining(lp.folder, value)).toEqual([]);
        const held = await filesContaining(lp.home, value);
        expect(held.length).toBeGreaterThan(0);
        for (const file of held)
          expect([file.path, file.mode]).toEqual([file.path, 0o600]);
      }
    } finally {
      logged.restore();
      await lp.close();
    }
  },
  30_000,
);

contract(
  "removing a server needs a confirm and takes it out of every consumer and of custody",
  async () => {
    const lp = await launchpad();
    try {
      expect((await add(lp, invoicing)).status).toBe(200);
      const unconfirmed = await lp.post("/api/connections/mcp/remove", {
        expectedRevision: await lp.revision(),
        name: "invoicing-mcp",
      });
      expect(unconfirmed.status).toBe(400);
      expect(await unconfirmed.json()).toMatchObject({
        error: "confirm-required",
      });
      const removed = await lp.post("/api/connections/mcp/remove", {
        expectedRevision: await lp.revision(),
        name: "invoicing-mcp",
        confirm: true,
      });
      expect(removed.status).toBe(200);
      const codex = await lp.codex();
      expect(codex.text).toContain(codexConfig);
      expect(codex.parsed.mcp_servers?.["invoicing-mcp"]).toBeUndefined();
      expect(codex.parsed.mcp_servers?.own).toEqual({ command: "own-server" });
      const claude = await claudeServers(lp.home);
      expect(Object.keys(claude)).toEqual(["mine"]);
      // Only the fake Claude's own record of the earlier call still holds it.
      expect(
        (await filesContaining(lp.home, headerValue)).map((file) => file.path),
      ).toEqual([join(lp.home, ".fake-claude", "calls.jsonl")]);
      expect(
        await readFile(join(lp.folder, "AGENTS.md"), "utf8"),
      ).not.toContain("invoicing-mcp");
    } finally {
      await lp.close();
    }
  },
  30_000,
);

contract(
  "a server's state line comes from a real MCP handshake: its tools when it starts, a failure when it does not",
  async () => {
    const lp = await launchpad();
    try {
      for (const server of [
        { name: "echo", kind: "command", command: lp.mcpServer, args: [] },
        {
          name: "broken",
          kind: "command",
          command: join(lp.home, "no-such-server"),
        },
      ])
        expect((await add(lp, server)).status).toBe(200);
      type Listed = {
        servers: { name: string; state: string; tools?: number }[];
      };
      let listed: Listed = { servers: [] };
      for (let attempt = 0; attempt < 60; attempt++) {
        listed = (await (
          await lp.get("/api/connections/mcp")
        ).json()) as Listed;
        if (
          listed.servers?.length === 2 &&
          listed.servers.every((server) =>
            ["ok", "failed"].includes(server.state),
          )
        )
          break;
        await Bun.sleep(250);
      }
      expect(
        listed.servers.find((server) => server.name === "echo"),
      ).toMatchObject({
        state: "ok",
        tools: 2,
      });
      expect(
        listed.servers.find((server) => server.name === "broken"),
      ).toMatchObject({
        state: "failed",
      });
    } finally {
      await lp.close();
    }
  },
  30_000,
);
