import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  archiveWaits,
  type BrainServerSessions,
  type BrainSetupLabels,
  brainAnswers,
  brainSetupAtStart,
  convergeBrainServer,
  lostRunsInARow,
  runBrainSetup,
} from "../src/brain/at-start";
import { brainPaths } from "../src/brain/pin";
import type { CustomServerInput } from "../src/integrations/custom-server";
import type { ToolRunner } from "../src/tools/status";

// The brain at the Launchpad's start (plan LZD-0033 R11a, step 4): setup in
// a child process read by its closed labels only, and Executor's custom
// server Brain with the Executor key, against a stand-in of the form's
// sessions. Fictional tokens.

describe("setup at the Launchpad's start and once more when Machines mark the handover", () => {
  /** A setup that answers in turn, and a mark that appears after `after`
   * checks. No real time passes: the sleep is counted. */
  const world = (answers: readonly (BrainSetupLabels | null)[], after = 1) => {
    const state = { runs: 0, checks: 0, sleeps: 0 };
    const reported: BrainSetupLabels[] = [];
    const close = new AbortController();
    const input = {
      run: async () => answers[state.runs++] ?? null,
      handover: async () => ++state.checks >= after,
      signal: close.signal,
      report: (labels: BrainSetupLabels) => reported.push(labels),
      waitMs: 60_000,
      waits: 5,
      sleep: async () => {
        state.sleeps++;
      },
    };
    return { state, reported, input, close };
  };

  test("search by meaning with windows left: setup runs again after the pause while this start lasts, Executor handed the brain after every run", async () => {
    const filling = { server: "running", meaning: "waits:filling" };
    const { state, reported, input, close } = world([
      filling,
      filling,
      { server: "running", meaning: "on" },
    ]);
    const settled: (BrainSetupLabels | null)[] = [];
    const pauses: number[] = [];
    const run = {
      ...input,
      settled: async (labels: BrainSetupLabels | null) => {
        settled.push(labels);
      },
      fillMs: 300_000,
      sleep: async (ms: number) => {
        pauses.push(ms);
      },
    };
    expect(await brainSetupAtStart(run)).toEqual({
      server: "running",
      meaning: "on",
    });
    expect(state.runs).toBe(3);
    // Each run's answer goes to Executor's Brain at once, the first window's
    // too: agents reach the brain while the windows go on.
    expect(settled).toEqual([
      filling,
      filling,
      { server: "running", meaning: "on" },
    ]);
    expect(pauses).toEqual([300_000, 300_000]);
    expect(reported).toEqual([filling, filling]);
    // A start that closes during the pause starts no other run.
    const stopping = world([filling, filling]);
    const stopped = {
      ...stopping.input,
      sleep: async () => {
        stopping.close.abort();
      },
    };
    expect(await brainSetupAtStart(stopped)).toEqual(filling);
    expect(stopping.state.runs).toBe(1);
    close.abort();
  });

  test("another setup holding the lock while windows are left: the next run comes as well", async () => {
    const filling = { server: "running", meaning: "waits:filling" };
    const { state, input } = world([
      filling,
      { server: "busy" },
      { server: "running", meaning: "on" },
    ]);
    expect(await brainSetupAtStart(input)).toEqual({
      server: "running",
      meaning: "on",
    });
    expect(state.runs).toBe(3);
    // A busy first answer, with no meaning waiting before it, is the answer.
    const lone = world([{ server: "busy" }, filling]);
    expect(await brainSetupAtStart(lone.input)).toEqual({ server: "busy" });
    expect(lone.state.runs).toBe(1);
  });

  test("a run without an answer (it died, maybe in a stop it recorded) is run again after the pause, a few times in a row at most", async () => {
    const filling = { server: "running", meaning: "waits:filling" };
    // A window's run dies; the next one recovers what it left and goes on.
    const recovers = world([
      filling,
      null,
      filling,
      { server: "running", meaning: "on" },
    ]);
    const pauses: number[] = [];
    expect(
      await brainSetupAtStart({
        ...recovers.input,
        fillMs: 300_000,
        sleep: async (ms: number) => {
          pauses.push(ms);
        },
      }),
    ).toEqual({ server: "running", meaning: "on" });
    expect(recovers.state.runs).toBe(4);
    expect(pauses).toEqual([300_000, 300_000, 300_000]);
    // The first run of the start too.
    const first = world([null, { server: "running", meaning: "on" }]);
    expect(await brainSetupAtStart(first.input)).toEqual({
      server: "running",
      meaning: "on",
    });
    expect(first.state.runs).toBe(2);
    // Runs that keep dying end after `lostRunsInARow` more, until the next start.
    const dying = world(Array(20).fill(null));
    expect(await brainSetupAtStart(dying.input)).toBeNull();
    expect(dying.state.runs).toBe(1 + lostRunsInARow);
  });

  test("the runs one start makes for windows are bounded", async () => {
    const filling = { server: "running", meaning: "waits:filling" };
    const { state, input } = world(Array(20).fill(filling));
    expect(await brainSetupAtStart({ ...input, fills: 4 })).toEqual(filling);
    expect(state.runs).toBe(5);
  });

  test("an answer other than waits-machines is the answer: nothing waits", async () => {
    const { state, input } = world([{ server: "waits-takeover" }]);
    expect(await brainSetupAtStart(input)).toEqual({
      server: "waits-takeover",
    });
    expect(state).toMatchObject({ runs: 1, checks: 0, sleeps: 0 });
  });

  test("waits-machines: once the mark appears, setup runs once more and its answer counts", async () => {
    const { state, reported, input } = world(
      [{ server: "waits-machines" }, { server: "waits-takeover" }],
      3,
    );
    expect(await brainSetupAtStart(input)).toEqual({
      server: "waits-takeover",
    });
    expect(state).toMatchObject({ runs: 2, checks: 3, sleeps: 3 });
    // The first answer is still reported while it waits.
    expect(reported).toEqual([{ server: "waits-machines" }]);
  });

  test("a mark that never appears ends after the last check; a Launchpad that stops ends at once", async () => {
    const never = world([{ server: "waits-machines" }], 99);
    expect(await brainSetupAtStart(never.input)).toEqual({
      server: "waits-machines",
    });
    expect(never.state).toMatchObject({ runs: 1, checks: 5 });
    const stopping = world([{ server: "waits-machines" }], 99);
    stopping.input.sleep = async () => {
      stopping.close.abort();
    };
    expect(await brainSetupAtStart(stopping.input)).toEqual({
      server: "waits-machines",
    });
    expect(stopping.state).toMatchObject({ runs: 1, checks: 0 });
  });

  test("a Launchpad that closes while a check of the mark is under way starts no other setup, even when the mark is there", async () => {
    const { state, input, close } = world(
      [{ server: "waits-machines" }, { server: "waits-takeover" }],
      1,
    );
    let answer: (marked: boolean) => void = () => undefined;
    input.handover = () =>
      new Promise<boolean>((resolve) => {
        state.checks++;
        answer = resolve;
      });
    const result = brainSetupAtStart(input);
    // The check is under way; the Launchpad closes, then the mark is seen.
    await new Promise((resolve) => setTimeout(resolve, 0));
    close.abort();
    answer(true);
    expect(await result).toEqual({ server: "waits-machines" });
    expect(state).toMatchObject({ runs: 1, checks: 1 });
  });

  test("closing ends the pending sleep at once, with the real timer", async () => {
    const { state, input, close } = world([{ server: "waits-machines" }], 99);
    const { sleep: _counted, ...real } = input;
    const started = Date.now();
    const result = brainSetupAtStart({ ...real, waitMs: 3_600_000 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    close.abort();
    expect(await result).toEqual({ server: "waits-machines" });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(state).toMatchObject({ runs: 1, checks: 0 });
  });

  test("a Launchpad already closing runs no setup at all", async () => {
    const { state, input, close } = world([{ server: "waits-takeover" }]);
    close.abort();
    expect(await brainSetupAtStart(input)).toBeNull();
    expect(state.runs).toBe(0);
  });

  test("a mark that cannot be read counts as not there yet", async () => {
    const { state, input } = world([{ server: "waits-machines" }], 99);
    input.handover = async () => {
      state.checks++;
      throw new Error("EACCES");
    };
    expect(await brainSetupAtStart(input)).toEqual({
      server: "waits-machines",
    });
    expect(state).toMatchObject({ runs: 1, checks: 5 });
  });
});

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

  test("the archive's outcome is read, and one not off yet keeps the Launchpad running setup again", async () => {
    for (const [archive, waits] of [
      ["off", false],
      ["waits-idle", true],
      ["failed:refused", true],
    ] as const) {
      // Setup exits 1 for a failed switch; its labels are still read.
      const run: ToolRunner = async () => ({
        exitCode: archive.startsWith("failed:") ? 1 : 0,
        stdout: JSON.stringify({ server: "running", archive, meaning: "on" }),
        stderr: "",
      });
      const labels = await runBrainSetup({ executable: "x", run, env: {} });
      expect(labels).toEqual({ server: "running", archive, meaning: "on" });
      expect(archiveWaits(labels)).toBe(waits);
    }
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

// #1214: an update restarts the Launchpad and then refreshes the Folder. A
// setup at the start that cannot read the Folder's state meanwhile waits for
// it and runs again after the pause, instead of giving up until the next
// start; the memory then moves to its pin.
describe("a Folder that cannot be read right now is waited for", () => {
  test("waits-folder, then the move: setup runs again after the pause", async () => {
    let runs = 0;
    const pauses: number[] = [];
    const answers: BrainSetupLabels[] = [
      { server: "waits-folder" },
      { server: "moved", move: "moved", meaning: "on" },
    ];
    expect(
      await brainSetupAtStart({
        run: async () => answers[runs++] ?? null,
        handover: async () => true,
        signal: new AbortController().signal,
        fillMs: 300_000,
        sleep: async (ms: number) => {
          pauses.push(ms);
        },
      }),
    ).toEqual({ server: "moved", move: "moved", meaning: "on" });
    expect(runs).toBe(2);
    expect(pauses).toEqual([300_000]);
  });

  test("unsupported stays final: setup is not run again", async () => {
    let runs = 0;
    expect(
      await brainSetupAtStart({
        run: async () => {
          runs++;
          return { server: "unsupported" };
        },
        handover: async () => true,
        signal: new AbortController().signal,
        sleep: async () => {},
      }),
    ).toEqual({ server: "unsupported" });
    expect(runs).toBe(1);
  });
});
