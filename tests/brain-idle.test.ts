import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buddyGen4Turn } from "../src/brain/buddy-turn";
import { buddyIdle } from "../src/brain/host";
import type { ActiveWork } from "../src/buddy/gateway-refresh";
import { buddyT3Unit } from "../src/buddy/t3-runtime";
import type { ToolRunner } from "../src/tools/status";
import type { ProcessRunner } from "../src/update/self-check";

// Whether Buddy is idle, so the brain's server may stop for a moment (a move,
// a vault's rebuild, search by meaning switched on). Fail closed: only a
// confirmed answer is idle. Fictional homes; no gateway or user manager.

async function home(
  options: Readonly<{ hermes?: boolean; t3?: boolean }> = {},
) {
  const root = await mkdtemp(join(tmpdir(), "brain-idle-"));
  if (options.hermes) await mkdir(join(root, ".hermes"), { recursive: true });
  if (options.t3) {
    await mkdir(join(root, ".config", "systemd", "user"), { recursive: true });
    await writeFile(
      join(root, ".config", "systemd", "user", buddyT3Unit),
      "[Service]\n",
    );
  }
  return root;
}

const systemd =
  (state: string | "timeout"): ProcessRunner =>
  async () => {
    if (state === "timeout") throw new Error("timeout");
    return {
      exitCode: state === "active" ? 0 : 3,
      stdout: `${state}\n`,
      stderr: "",
    };
  };
const work = (answer: ActiveWork) => async () => answer;
/** A binding that names no Buddy GEN4: the behaviour before #1103. */
const noGeneration = {
  env: { XDG_RUNTIME_DIR: "/run/user/1000" },
  generation: undefined,
  gen4Turn: async (): Promise<ActiveWork> => {
    throw new Error("T3 Code is asked only for Buddy GEN4");
  },
};

describe("is Buddy idle", () => {
  test("no Buddy at all: idle", async () => {
    expect(
      await buddyIdle({
        ...noGeneration,
        home: await home(),
        service: systemd("active"),
        activeWork: work("unknown"),
      }),
    ).toBe(true);
  });

  test("Buddy of Hermes: only his gateway's idle counts", async () => {
    const at = await home({ hermes: true });
    for (const [answer, idle] of [
      ["idle", true],
      ["busy", false],
      ["unknown", false],
    ] as const)
      expect(
        await buddyIdle({
          ...noGeneration,
          home: at,
          service: systemd("inactive"),
          activeWork: work(answer),
        }),
      ).toBe(idle);
  });

  test("Buddy GEN4 in T3 Code: busy while T3 Code runs or systemd does not answer, idle only when it is stopped", async () => {
    const at = await home({ t3: true });
    for (const [state, idle] of [
      ["active", false],
      ["activating", false],
      ["timeout", false],
      ["inactive", true],
      ["failed", true],
    ] as const)
      expect(
        await buddyIdle({
          ...noGeneration,
          home: at,
          service: systemd(state),
          activeWork: work("idle"),
        }),
      ).toBe(idle);
  });

  test("a home that cannot be read is never taken for no Buddy", async () => {
    if (process.getuid?.() === 0) return;
    const at = await home();
    await mkdir(join(at, ".config"));
    await chmod(join(at, ".config"), 0o000);
    const hidden = await home();
    await chmod(hidden, 0o000);
    try {
      for (const where of [at, hidden])
        expect(
          await buddyIdle({
            ...noGeneration,
            home: where,
            service: systemd("inactive"),
            activeWork: work("idle"),
          }),
        ).toBe(false);
    } finally {
      await chmod(join(at, ".config"), 0o755);
      await chmod(hidden, 0o755);
    }
  });

  test("Buddy GEN4: only his turn counts, not Hermes or the unit the conversion leaves running", async () => {
    // The converted Environment keeps `.hermes` and `lazurio-t3-buddy.service`.
    const at = await home({ hermes: true, t3: true });
    for (const [turn, idle] of [
      ["idle", true],
      ["busy", false],
      ["unknown", false],
    ] as const)
      expect(
        await buddyIdle({
          home: at,
          service: systemd("active"),
          activeWork: work("busy"),
          env: {},
          generation: 4,
          gen4Turn: work(turn),
        }),
      ).toBe(idle);
  });

  test("a binding that could not be read is busy", async () => {
    expect(
      await buddyIdle({
        home: await home(),
        service: systemd("inactive"),
        activeWork: work("idle"),
        env: {},
        generation: "unreadable",
        gen4Turn: work("idle"),
      }),
    ).toBe(false);
  });
});

describe("Buddy GEN4's turn, as his T3 Code says it", () => {
  const thread = "mcp:00000000-0000-4000-8000-000000000001";
  /** The record a T3 Code server writes of itself
   * (`~/.t3/userdata/server-runtime.json`), fictional values; a string is
   * written as it is, null leaves the file out. */
  type Runtime = Record<string, unknown> | string | null;
  const server = (serverVersion: string, pid = 4242): Runtime => ({
    version: 1,
    pid,
    port: 3773,
    origin: "http://127.0.0.1:3773",
    startedAt: "2026-11-20T20:00:00.000Z",
    serviceManaged: true,
    serverVersion,
  });
  /** A stand-in of `t3`: `signal` and `events` as T3 Code 0.1.10-lazurio.3
   * prints them (fictional ids), or what an earlier one prints; the server's
   * record before the question (0.1.10-lazurio.3 where not given) and, where
   * `restarted` gives one, the record a server started meanwhile wrote. */
  const t3 = (
    options: Readonly<{
      signal?: string;
      events?: string;
      timeout?: "signal" | "events";
      runtime?: Runtime;
      restarted?: Runtime;
    }>,
  ) => {
    const calls: string[][] = [];
    const stand = { calls, home: "", run: undefined as unknown as ToolRunner };
    const write = async (runtime: Runtime) => {
      const file = join(stand.home, ".t3", "userdata", "server-runtime.json");
      await mkdir(join(stand.home, ".t3", "userdata"), { recursive: true });
      if (runtime === null) return;
      await writeFile(
        file,
        typeof runtime === "string" ? runtime : JSON.stringify(runtime),
      );
    };
    stand.run = async (argv) => {
      calls.push([...argv]);
      const verb = argv[1] === "lazurio" ? "signal" : "events";
      if (verb === "signal" && options.restarted !== undefined)
        await write(options.restarted);
      if (options.timeout === verb) return "timeout";
      return {
        exitCode: 0,
        stdout: (verb === "signal" ? options.signal : options.events) ?? "",
        stderr: "",
      };
    };
    return Object.assign(stand, {
      prepare: async () => {
        stand.home = await mkdtemp(join(tmpdir(), "brain-turn-"));
        await write(
          options.runtime === undefined
            ? server("0.1.10-lazurio.3")
            : options.runtime,
        );
      },
    });
  };
  const signalOf = `${JSON.stringify({ state: "answered", threadId: thread, since: null })}\n`;
  const eventsWith = (status: string) =>
    `${JSON.stringify({ kind: "thread", sequence: 7, threadId: thread, status })}\n${JSON.stringify({ kind: "synced", sequence: 7 })}\n`;
  /** Process 4242 and 4243 run; any other does not. */
  const alive = (pid: number) => pid === 4242 || pid === 4243;
  const ask = async (stand: ReturnType<typeof t3>) => {
    await stand.prepare();
    return buddyGen4Turn({
      run: stand.run,
      t3: "/fake/t3",
      home: stand.home,
      env: {},
      alive,
    });
  };

  test("a turn under way is busy; idle and every ended state are idle; a state of neither is unknown", async () => {
    for (const status of [
      "preparing",
      "queued",
      "starting",
      "running",
      "waiting",
    ])
      expect(
        await ask(t3({ signal: signalOf, events: eventsWith(status) })),
      ).toBe("busy");
    for (const status of [
      "idle",
      "completed",
      "interrupted",
      "failed",
      "cancelled",
      "rolled_back",
    ])
      expect(
        await ask(t3({ signal: signalOf, events: eventsWith(status) })),
      ).toBe("idle");
    expect(
      await ask(t3({ signal: signalOf, events: eventsWith("paused") })),
    ).toBe("unknown");
  });

  test("it asks his T3 Code in ~/.t3 for his thread, then for that thread only", async () => {
    const stand = t3({ signal: signalOf, events: eventsWith("idle") });
    await ask(stand);
    const base = join(stand.home, ".t3");
    expect(stand.calls).toEqual([
      ["/fake/t3", "lazurio", "buddy", "signal", "--json", "--base-dir", base],
      ["/fake/t3", "events", "--thread", thread, "--base-dir", base],
    ]);
  });

  const noThread = `${JSON.stringify({ error: { code: "no_thread", message: "x" } })}\n`;

  test("no_thread is idle where the server that answered tells it from a failed read (0.1.10-lazurio.4 on)", async () => {
    for (const version of [
      "0.1.10-lazurio.4",
      "0.1.10-lazurio.12",
      "0.1.11-lazurio.1",
      "0.2.0-lazurio.1",
      "1.0.0-lazurio.1",
    ]) {
      const stand = t3({ signal: noThread, runtime: server(version) });
      expect(await ask(stand)).toBe("idle");
      // The signal only: no events, and never the CLI's version.
      expect(stand.calls).toHaveLength(1);
    }
    // Through buddyIdle, as setup asks it: idle, so the move may run.
    const stand = t3({
      signal: noThread,
      runtime: server("0.1.10-lazurio.4"),
    });
    expect(
      await buddyIdle({
        home: "/home/bob",
        service: systemd("inactive"),
        activeWork: work("idle"),
        env: {},
        generation: 4,
        gen4Turn: () => ask(stand),
      }),
    ).toBe(true);
  });

  test("a failed read (unavailable) is unknown on every T3 Code", async () => {
    const stand = t3({
      signal: `${JSON.stringify({ error: { code: "unavailable", message: "x" } })}\n`,
      runtime: server("0.1.10-lazurio.4"),
    });
    expect(await ask(stand)).toBe("unknown");
  });

  test("a newer CLI before an older running server: its no_thread, a failed read there, is unknown", async () => {
    // An update pointed the CLI at 0.1.10-lazurio.4, and the 0.1.10-lazurio.3
    // service runs on until it is restarted: it answers a failed read of
    // Buddy's thread with `no_thread`. Only the server's own record counts.
    const stand = t3({
      signal: noThread,
      runtime: server("0.1.10-lazurio.3"),
    });
    expect(await ask(stand)).toBe("unknown");
    expect(stand.calls.some((call) => call.includes("--version"))).toBe(false);
  });

  test("no_thread is unknown where the answering server is not known for sure", async () => {
    const recorded = server("0.1.10-lazurio.4") as Record<string, unknown>;
    for (const options of [
      // Earlier releases and builds not known to carry the fix.
      { runtime: server("0.1.9-lazurio.12") },
      { runtime: server("0.1.10-preview.20261120.1") },
      { runtime: server("0.1.11") },
      // No record, one that is not JSON, of another shape or without a
      // version (a server before it recorded one), or of a process that does
      // not run.
      { runtime: null },
      { runtime: "not json" },
      { runtime: { ...recorded, version: 2 } },
      { runtime: { ...recorded, pid: "4242" } },
      { runtime: { ...recorded, serverVersion: undefined } },
      { runtime: server("0.1.10-lazurio.4", 9999) },
      // A server restarted during the question: the answer may be the
      // earlier one's, whichever version follows.
      {
        runtime: server("0.1.10-lazurio.3"),
        restarted: server("0.1.10-lazurio.4", 4243),
      },
      {
        runtime: server("0.1.10-lazurio.4"),
        restarted: server("0.1.10-lazurio.4", 4243),
      },
      {
        runtime: server("0.1.10-lazurio.4"),
        restarted: { ...recorded, startedAt: "2026-11-20T20:05:00.000Z" },
      },
      // Gone during the question.
      { runtime: server("0.1.10-lazurio.4"), restarted: "" },
    ])
      expect(await ask(t3({ signal: noThread, ...options }))).toBe("unknown");
  });

  test("no_thread is unknown on T3 Code 0.1.10-lazurio.3: it answers it also when finding or reading his thread failed", async () => {
    // T3 Code 0.1.10-lazurio.3 maps a failed search or read to `no-thread`
    // (`readBuddySignal`), which the CLI prints as `no_thread`: whether his
    // thread is absent or could not be read, the brain waits.
    const stand = t3({ signal: noThread });
    expect(await ask(stand)).toBe("unknown");
    expect(stand.calls).toHaveLength(1);
    // Through buddyIdle, as setup asks it: busy, so nothing stops.
    expect(
      await buddyIdle({
        home: "/home/bob",
        service: systemd("inactive"),
        activeWork: work("idle"),
        env: {},
        generation: 4,
        gen4Turn: () => ask(stand),
      }),
    ).toBe(false);
  });

  test("a malformed answer is unknown and never throws", async () => {
    for (const signal of [
      '{"error":null}\n',
      '{"error":"no_thread"}\n',
      "null\n",
      "[]\n",
      '{"threadId":42}\n',
      '{"threadId":""}\n',
      `${signalOf}${signalOf}`,
      "",
    ])
      expect(await ask(t3({ signal, events: eventsWith("idle") }))).toBe(
        "unknown",
      );
    for (const events of [
      `${JSON.stringify({ kind: "thread", threadId: thread, status: null })}\n${JSON.stringify({ kind: "synced" })}\n`,
      `${JSON.stringify({ kind: "thread", threadId: "another", status: "idle" })}\n${JSON.stringify({ kind: "synced" })}\n`,
      "not json\n",
    ])
      expect(await ask(t3({ signal: signalOf, events }))).toBe("unknown");
  });

  test("anything else is unknown: another refusal, an earlier T3 Code's help, no thread line, no synced line, no answer", async () => {
    const cases = [
      t3({
        signal: `${JSON.stringify({ error: { code: "not_buddy", message: "x" } })}\n`,
      }),
      // T3 Code before 0.1.10-lazurio.3 prints its help for `signal`, exit 0.
      t3({ signal: "DESCRIPTION\n  Buddy's T3 Code.\n" }),
      t3({
        signal: signalOf,
        events: `${JSON.stringify({ kind: "synced", sequence: 7 })}\n`,
      }),
      t3({
        signal: signalOf,
        events: `${JSON.stringify({ kind: "thread", threadId: thread, status: "idle" })}\n`,
      }),
      t3({ timeout: "signal" }),
      t3({ signal: signalOf, timeout: "events" }),
    ];
    for (const stand of cases) expect(await ask(stand)).toBe("unknown");
  });
});
