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
  /** An add creates the server and then fails to connect it; the process
   * dies at a save before it reaches Executor, or right after it saved; a
   * save changes the configuration and then fails. */
  const fail = {
    connect: false,
    dieAtSave: false,
    dieAfterSave: false,
    partialSave: false,
    /** Executor does not answer a server's settings for a moment. */
    settings: false,
  };
  const sessions: BrainServerSessions = {
    async addCustom(server) {
      calls.push("add");
      if ([...servers.values()].some((s) => s.name === server.name))
        return { kind: "blocked", reason: "name-taken" };
      // Executor creates the server, its headers included, before its
      // connection.
      servers.set("brain", server);
      if (fail.connect) return { kind: "blocked", reason: "connect-failed" };
      return { kind: "connected", app: "brain" };
    },
    async customIdsNamed(name) {
      return [...servers.entries()]
        .filter(([, s]) => s.name === name)
        .map(([id]) => id);
    },
    async customSettings(id) {
      const server = servers.get(id);
      if (fail.settings || server === undefined || server.type !== "http")
        return { kind: "blocked" };
      return {
        kind: "custom-server",
        id,
        type: "http",
        name: server.name,
        url: server.url,
        // Executor keeps the auth method an add declared, connected or not,
        // and shows a header's name, never its value.
        bearer: true,
        headers: server.headers.map((header) => header.name),
      };
    },
    async updateCustom(id, server) {
      calls.push("update");
      if (fail.dieAtSave) throw new Error("killed");
      // The configuration (the attempt's header gone) is saved first.
      servers.set(id, { ...server, bearer: null } as CustomServerInput);
      if (fail.partialSave) return { kind: "blocked" };
      if (fail.dieAfterSave) throw new Error("killed");
      servers.set(id, server);
      return { kind: "saved" };
    },
  };
  return { paths, handOver, servers, calls, sessions, fail };
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
    // Added with the attempt's mark, then saved without it.
    expect(calls).toEqual(["add", "update"]);
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
    expect(calls).toEqual(["add", "update", "update"]);
  });

  test("an add that created the server but did not connect it is completed by the next run", async () => {
    const { paths, handOver, servers, calls, sessions, fail } = await stand();
    await handOver("e".repeat(32));
    fail.connect = true;
    expect(await convergeBrainServer(paths, sessions)).toBe("failed");
    fail.connect = false;
    expect(await convergeBrainServer(paths, sessions)).toBe("added");
    expect(servers.get("brain")).toMatchObject({
      bearer: { value: "e".repeat(32) },
      headers: [],
    });
    expect(calls).toEqual(["add", "update"]);
    expect(await convergeBrainServer(paths, sessions)).toBe("kept");
  });

  test("a run that died after its add: the next run completes the server it added, not a second one", async () => {
    const { paths, handOver, servers, calls, sessions, fail } = await stand();
    await handOver("e".repeat(32));
    fail.dieAtSave = true;
    await expect(convergeBrainServer(paths, sessions)).rejects.toThrow(
      "killed",
    );
    fail.dieAtSave = false;
    // Its id was recorded before the save: saved again, the same server.
    expect(await convergeBrainServer(paths, sessions)).toBe("updated");
    expect([...servers.keys()]).toEqual(["brain"]);
    expect(servers.get("brain")).toMatchObject({
      bearer: { value: "e".repeat(32) },
      headers: [],
    });
    expect(calls).toEqual(["add", "update", "update"]);
    expect(await convergeBrainServer(paths, sessions)).toBe("kept");
  });

  for (const boundary of ["dieAfterSave", "partialSave"] as const)
    for (const path of ["add", "recovery"] as const)
      test(`a save that ${boundary === "dieAfterSave" ? "died right after it saved" : "changed the configuration and then failed"}, on the ${path}: the next run saves its own server again`, async () => {
        const { paths, handOver, servers, sessions, fail } = await stand();
        await handOver("e".repeat(32));
        if (path === "recovery") {
          // The add created the server, marked, without connecting it.
          fail.connect = true;
          expect(await convergeBrainServer(paths, sessions)).toBe("failed");
          fail.connect = false;
        }
        fail[boundary] = true;
        await convergeBrainServer(paths, sessions).catch(() => "killed");
        fail[boundary] = false;
        // The mark is gone with the save; the recorded id still says whose.
        expect(servers.get("brain")).toMatchObject({ headers: [] });
        expect(await convergeBrainServer(paths, sessions)).toBe("updated");
        expect([...servers.keys()]).toEqual(["brain"]);
        expect(servers.get("brain")).toMatchObject({
          bearer: { value: "e".repeat(32) },
        });
        expect(await convergeBrainServer(paths, sessions)).toBe("kept");
        // A key rotated later is still saved into it.
        await handOver("f".repeat(32));
        expect(await convergeBrainServer(paths, sessions)).toBe("updated");
        expect(bearerOf(servers.get("brain"))).toBe("f".repeat(32));
      });

  test("a partial save, then settings Executor does not answer for a moment: the record stays, and the next run saves its own server", async () => {
    const { paths, handOver, servers, sessions, fail } = await stand();
    await handOver("e".repeat(32));
    fail.partialSave = true;
    expect(await convergeBrainServer(paths, sessions)).toBe("failed");
    fail.partialSave = false;
    fail.settings = true;
    // Listed by its name, its settings unread: neither someone's nor gone.
    expect(await convergeBrainServer(paths, sessions)).toBe("failed");
    expect(
      JSON.parse(
        await readFile(join(dirname(paths.state), "executor.json"), "utf8"),
      ),
    ).toEqual({ slug: "brain" });
    fail.settings = false;
    expect(await convergeBrainServer(paths, sessions)).toBe("updated");
    expect(bearerOf(servers.get("brain"))).toBe("e".repeat(32));
    expect(await convergeBrainServer(paths, sessions)).toBe("kept");
  });

  test("an add that did not connect, then settings Executor does not answer for a moment: the pending record stays, and the next run completes its server", async () => {
    const { paths, handOver, servers, sessions, fail } = await stand();
    await handOver("e".repeat(32));
    fail.connect = true;
    expect(await convergeBrainServer(paths, sessions)).toBe("failed");
    fail.connect = false;
    fail.settings = true;
    expect(await convergeBrainServer(paths, sessions)).toBe("failed");
    fail.settings = false;
    expect(await convergeBrainServer(paths, sessions)).toBe("added");
    expect(servers.get("brain")).toMatchObject({
      bearer: { value: "e".repeat(32) },
      headers: [],
    });
  });

  test("a recorded server that is gone is added again", async () => {
    const { paths, handOver, servers, sessions } = await stand();
    await handOver("e".repeat(32));
    expect(await convergeBrainServer(paths, sessions)).toBe("added");
    servers.clear();
    expect(await convergeBrainServer(paths, sessions)).toBe("added");
    expect(bearerOf(servers.get("brain"))).toBe("e".repeat(32));
  });

  const theirs: CustomServerInput = {
    type: "http",
    name: "Brain",
    url: "http://127.0.0.1:3131/mcp",
    bearer: { value: "s".repeat(32) },
    headers: [],
  };

  test("a server of that name that was there before is never completed, even one that looks like Lazurio's", async () => {
    const { paths, handOver, servers, calls, sessions } = await stand();
    servers.set("someone", theirs);
    await handOver("e".repeat(32));
    expect(await convergeBrainServer(paths, sessions)).toBe("name-taken");
    expect(await convergeBrainServer(paths, sessions)).toBe("name-taken");
    expect(servers.get("someone")).toEqual(theirs);
    expect(calls).toEqual([]);
  });

  test("a run that died after its pending record, before its add, never completes a look-alike server found later", async () => {
    // There before, or created by someone in the meantime: either way it
    // carries no mark of this attempt.
    const { paths, handOver, servers, calls, sessions } = await stand();
    await mkdir(dirname(paths.state), { recursive: true });
    await writeFile(
      join(dirname(paths.state), "executor.json"),
      `${JSON.stringify({ pending: "0123456789abcdef01234567" })}\n`,
    );
    servers.set("someone", theirs);
    await handOver("e".repeat(32));
    expect(await convergeBrainServer(paths, sessions)).toBe("name-taken");
    expect(servers.get("someone")).toEqual(theirs);
    expect(calls).toEqual([]);
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
