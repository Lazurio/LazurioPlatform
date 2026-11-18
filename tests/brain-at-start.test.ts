import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type BrainServerSessions,
  brainAnswers,
  convergeBrainServer,
  runBrainSetup,
} from "../src/brain/at-start";
import { brainPaths } from "../src/brain/pin";
import type { CustomServerInput } from "../src/integrations/custom-server";
import type { ToolRunner } from "../src/tools/status";

// The brain at the Launchpad's start (plan LZD-0033 R11a, step 4): setup in
// a child process read by its closed labels only, and Executor's custom
// server Brain with the Executor key, against a stand-in of the form's
// sessions. Fictional tokens.

describe("lazurio brain setup as the Launchpad's child", () => {
  test("its closed labels are read, nothing else", async () => {
    const calls: string[][] = [];
    const run: ToolRunner = async (command) => {
      calls.push([...command]);
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          server: "moved",
          move: "moved",
          keys: { executor: "kept" },
          status: { state: "running" },
        }),
        stderr: "",
      };
    };
    const labels = await runBrainSetup({
      executable: "/opt/lazurio",
      run,
      env: { HOME: "/home/bob", UNSET: undefined },
    });
    expect(calls).toEqual([["/opt/lazurio", "brain", "setup", "--json"]]);
    expect(labels).toEqual({ server: "moved", move: "moved" });
    expect(brainAnswers(labels)).toBe(true);
  });

  test("no answer, no labels, and nothing for Executor", async () => {
    const timeout: ToolRunner = async () => "timeout";
    const noise: ToolRunner = async () => ({
      exitCode: 1,
      stdout: "Brain setup failed.",
      stderr: "",
    });
    for (const run of [timeout, noise]) {
      const labels = await runBrainSetup({ executable: "x", run, env: {} });
      expect(labels).toBeNull();
      expect(brainAnswers(labels)).toBe(false);
    }
    expect(brainAnswers({ server: "unsupported" })).toBe(false);
    expect(brainAnswers({ server: "stopped" })).toBe(false);
  });
});

async function stand() {
  const root = await mkdtemp(join(tmpdir(), "brain-at-start-"));
  const paths = brainPaths(join(root, "home"));
  await mkdir(dirname(paths.executorKey), { recursive: true });
  const handOver = (token: string) =>
    writeFile(
      paths.executorKey,
      JSON.stringify({ url: "http://127.0.0.1:3131", token }),
    );
  const servers = new Map<string, CustomServerInput>();
  const calls: string[] = [];
  const sessions: BrainServerSessions = {
    async addCustom(server) {
      calls.push("add");
      if ([...servers.values()].some((s) => s.name === server.name))
        return { kind: "blocked", reason: "name-taken" };
      servers.set("brain", server);
      return { kind: "connected", app: "brain" };
    },
    async customSettings(id) {
      const server = servers.get(id);
      if (server === undefined || server.type !== "http")
        return { kind: "blocked" };
      return {
        kind: "custom-server",
        id,
        type: "http",
        name: server.name,
        url: server.url,
        bearer: server.bearer !== null,
        headers: [],
      };
    },
    async updateCustom(id, server) {
      calls.push("update");
      servers.set(id, server);
      return { kind: "saved" };
    },
  };
  return { paths, handOver, servers, calls, sessions };
}

const urlOf = (server: CustomServerInput | undefined) =>
  server?.type === "http" ? server.url : undefined;
const bearerOf = (server: CustomServerInput | undefined) =>
  server?.type === "http" ? server.bearer?.value : undefined;

describe("Executor's server Brain", () => {
  test("added once with the Executor key, then kept", async () => {
    const { paths, handOver, servers, calls, sessions } = await stand();
    await handOver("e".repeat(32));
    expect(await convergeBrainServer(paths, sessions)).toBe("added");
    expect(servers.get("brain")).toEqual({
      type: "http",
      name: "Brain",
      url: "http://127.0.0.1:3131/mcp",
      bearer: { value: "e".repeat(32) },
      headers: [],
    });
    expect(await convergeBrainServer(paths, sessions)).toBe("kept");
    expect(calls).toEqual(["add"]);
    // Lazurio's record carries the server's id and a digest, never the key.
    const record = await readFile(
      join(dirname(paths.state), "executor.json"),
      "utf8",
    );
    expect(record).not.toContain("e".repeat(32));
  });

  test("a key setup minted anew is saved into the same server", async () => {
    const { paths, handOver, servers, calls, sessions } = await stand();
    await handOver("e".repeat(32));
    await convergeBrainServer(paths, sessions);
    await handOver("f".repeat(32));
    expect(await convergeBrainServer(paths, sessions)).toBe("updated");
    expect(bearerOf(servers.get("brain"))).toBe("f".repeat(32));
    expect(calls).toEqual(["add", "update"]);
  });

  test("a server named Brain Lazurio did not add is left alone; no key, no server", async () => {
    const { paths, handOver, servers, sessions } = await stand();
    expect(await convergeBrainServer(paths, sessions)).toBe("no-key");
    servers.set("someone", {
      type: "http",
      name: "Brain",
      url: "https://example.invalid/mcp",
      bearer: null,
      headers: [],
    });
    await handOver("e".repeat(32));
    expect(await convergeBrainServer(paths, sessions)).toBe("name-taken");
    expect(urlOf(servers.get("someone"))).toBe("https://example.invalid/mcp");
  });
});
