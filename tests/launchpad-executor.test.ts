import { expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ExecutorHost,
  type ExecutorStatus,
  executorSetup,
  executorStatus,
} from "../src/executor/flow";
import { executorWrapper } from "../src/executor/install";
import { initializeFolder } from "../src/folder/initialize-folder";
import { executionOs } from "../src/folder/platform";
import { createExecutorPanel } from "../src/launchpad/executor-panel";
import { createExecutorRoutes } from "../src/launchpad/executor-routes";
import {
  executorAction,
  parseExecutorStatus,
} from "../src/launchpad/executor-view";
import { messages } from "../src/launchpad/messages";
import { startLaunchpad } from "../src/launchpad/server";
import { runTool } from "../src/tools/status";
import {
  type ExecutorWorld,
  executorWorld,
  writeExecutable,
} from "./fixtures/fake-executor";

// Settings → Tools → executor over HTTP (decision F44): two routes behind the
// admission of every route, `{}` only (or a setup's `{job}`), a setup
// answered within a second while it runs and joined by the next request, and
// the curated routes of F19 refusing Executor. Since the addendum of
// 2026-10-11 (#298) the Launchpad of a supervised base of the hosted operator
// also starts that one setup itself after it starts, and the row follows a
// setup it did not start.

const posix = process.platform !== "win32";
type Json = Record<string, unknown>;

/** Polls until `read` answers something, for at most `ms`. */
async function until<T>(
  read: () => Promise<T | null | undefined | false>,
  ms = 20_000,
): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("Timed out waiting");
    await Bun.sleep(25);
  }
}

async function session(
  world: ExecutorWorld,
  options: Readonly<{
    host?: ExecutorHost;
    /** Present: the Launchpad of an install base, asked at its start
     * whether it sets Executor up (`executorAtStart`). */
    executorAtStart?: () => Promise<boolean>;
  }> = {},
) {
  const parent = await realpath(
    await mkdtemp(join(tmpdir(), "launchpad-executor-")),
  );
  const folder = join(parent, "Lazurio");
  await initializeFolder(folder, {
    os: executionOs(process.platform),
    access: "local",
    purpose: "human",
    locale: "cs",
    detail: "concise",
    coordination: "direct",
  });
  // The health socket of the base: a short path, within a socket's limit.
  const base = join(world.parent, "b");
  await mkdir(join(base, "update"), { recursive: true });
  const app = await startLaunchpad(
    folder,
    undefined,
    undefined,
    options.executorAtStart === undefined
      ? undefined
      : {
          base,
          version: "1.0.0",
          executorAtStart: options.executorAtStart,
        },
    {},
    {
      path: "/usr/bin:/bin",
      home: world.home,
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
    options.host ?? world.host,
  );
  const url = new URL(app.url);
  const call = (route: string, body: unknown, headers: Json = {}) =>
    fetch(new URL(route, url), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: url.origin,
        Authorization: `Bearer ${url.hash.slice(1)}`,
        ...(headers as Record<string, string>),
      },
      body: JSON.stringify(body),
    });
  const json = async (route: string, body: unknown = {}) => {
    const response = await call(route, body);
    return { status: response.status, body: (await response.json()) as Json };
  };
  return {
    call,
    json,
    async close() {
      await app.close();
      await rm(parent, { recursive: true, force: true });
    },
  };
}

test.skipIf(!posix)(
  "the Executor routes read the status, run one setup answered while it runs, and refuse every other input",
  async () => {
    const world = await executorWorld();
    const s = await session(world);
    try {
      const before = await s.json("/api/tools/executor/status");
      expect(before.status).toBe(200);
      expect(before.body).toMatchObject({
        kind: "executor-status",
        state: "not-installed",
        installed: null,
      });
      // What the page accepts is exactly what the server sends.
      expect(parseExecutorStatus(before.body)).toEqual(before.body as never);
      // A setup: answered, then asked again with its job until it ends.
      let answer = await s.json("/api/tools/executor/setup");
      const phases: string[] = [];
      while (answer.status === 202) {
        expect(answer.body.kind).toBe("executor-setting-up");
        phases.push(String(answer.body.phase));
        answer = await s.json("/api/tools/executor/setup", {
          job: answer.body.job,
        });
      }
      expect(answer.status).toBe(200);
      expect(answer.body).toMatchObject({
        kind: "executor-status",
        state: "running",
        installed: "1.6.10",
      });
      for (const phase of phases)
        expect(["install", "service", "agents"]).toContain(phase);
      expect((await s.json("/api/tools/executor/status")).body).toMatchObject({
        state: "running",
      });
      // Nothing but `{}` or a job handle, and only POST with JSON.
      for (const body of [
        { tool: "executor" },
        { job: "not-a-job" },
        { home: "/tmp" },
      ]) {
        const refused = await s.call("/api/tools/executor/setup", body);
        expect(refused.status).toBe(400);
      }
      expect(
        (await s.call("/api/tools/executor/status", { job: "0".repeat(32) }))
          .status,
      ).toBe(400);
      expect(
        await s.json("/api/tools/executor/setup", { job: "f".repeat(32) }),
      ).toEqual({
        status: 404,
        body: { kind: "blocked", reason: "job-unknown", tool: "executor" },
      });
      expect(
        (
          await s.call(
            "/api/tools/executor/status",
            {},
            { Origin: "https://untrusted.example" },
          )
        ).status,
      ).toBe(403);
      // The curated install and sign-in of F19 are not Executor's.
      for (const route of ["/api/tools/install", "/api/tools/login/start"])
        expect(await s.json(route, { tool: "executor" })).toEqual({
          status: 409,
          body: { kind: "blocked", reason: "setup-executor", tool: "executor" },
        });
    } finally {
      await s.close();
      await world.close();
    }
  },
  60_000,
);

test("a setup is answered within the bound while it runs, never runs twice at once, and a closed page cancels nothing", async () => {
  const world = await executorWorld();
  try {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = 0;
    // The registry holds the first download until the test releases it.
    const host: ExecutorHost = {
      ...world.host,
      fetch: async (url) => {
        started++;
        await gate;
        return world.registry.fetch(url);
      },
    };
    const routes = createExecutorRoutes({
      host: () => host,
      answerWithinMs: 50,
    });
    const first = await routes.handle("/api/tools/executor/setup");
    expect(first.status).toBe(202);
    const job = (first.body as { job: string }).job;
    expect(job).toMatch(/^[0-9a-f]{32}$/);
    // A second request joins the one that runs.
    const second = await routes.handle("/api/tools/executor/setup");
    expect(second.status).toBe(202);
    expect((second.body as { job: string }).job).toBe(job);
    expect(await routes.handle("/api/tools/executor/setup", job)).toMatchObject(
      {
        status: 202,
        body: { kind: "executor-setting-up", job, phase: "install" },
      },
    );
    release();
    await routes.settled();
    expect(started).toBe(2);
    expect(await routes.handle("/api/tools/executor/setup", job)).toMatchObject(
      {
        status: 200,
        body: { kind: "executor-status", state: "running" },
      },
    );
    // Ended: the next request starts a new one, with a new handle.
    const next = await routes.handle("/api/tools/executor/setup");
    if (next.status === 202) {
      const again = (next.body as { job: string }).job;
      expect(again).not.toBe(job);
      await routes.settled();
      expect(
        await routes.handle("/api/tools/executor/setup", again),
      ).toMatchObject({ status: 200, body: { state: "running" } });
    } else
      expect(next).toMatchObject({ status: 200, body: { state: "running" } });
  } finally {
    await world.close();
  }
}, 30_000);

const runningStatus: ExecutorStatus = {
  kind: "executor-status",
  state: "running",
  version: "1.6.10",
  installed: "1.6.10",
  address: "127.0.0.1:4789",
  entry: "lazurio",
  service: "running",
  settings: "current",
  answering: true,
  linger: "yes",
  agents: { codex: "registered", claude: "registered" },
};

// The Launchpad's start (decision F44, addendum of 2026-10-11, #298): where
// Lazurio's setup moves Executor on, one setup, the same job Install starts,
// journaled as the start's; it ends running from each such state, the
// outdated one included (a real version switch).
test("the start sets Executor up once from each state Lazurio's setup moves on, as Install does, journaled as the start's", async () => {
  const dropIn = (world: ExecutorWorld) =>
    join(
      world.home,
      ".config/systemd/user/sh.executor.daemon.service.d/lazurio.conf",
    );
  const states: readonly (readonly [
    string,
    (world: ExecutorWorld) => Promise<void>,
  ])[] = [
    ["not-installed", async () => undefined],
    [
      "not-running",
      async (world) => {
        await executorSetup(world.host);
        await world.setActive("inactive");
      },
    ],
    [
      "incomplete",
      async (world) => {
        await executorSetup(world.host);
        await rm(dropIn(world));
      },
    ],
  ];
  for (const [state, prepare] of states) {
    const world = await executorWorld();
    try {
      await prepare(world);
      expect([state, (await executorStatus(world.host)).state]).toEqual([
        state,
        state,
      ]);
      world.journal.length = 0;
      const routes = createExecutorRoutes({ host: () => world.host });
      expect([state, await routes.atStart()]).toEqual([state, true]);
      await routes.settled();
      expect([state, world.journal]).toEqual([
        state,
        [{ operation: "setup", outcome: "running", trigger: "start" }],
      ]);
    } finally {
      await world.close();
    }
  }
  // Outdated: the pin of an older release runs in this home.
  const older = await executorWorld({ version: "1.6.9" });
  const world = await executorWorld({ home: older.home });
  try {
    expect((await executorSetup(older.host)).state).toBe("running");
    expect(await executorStatus(world.host)).toMatchObject({
      state: "outdated",
      installed: "1.6.9",
    });
    const routes = createExecutorRoutes({ host: () => world.host });
    expect(await routes.atStart()).toBe(true);
    await routes.settled();
    expect(world.journal).toEqual([
      { operation: "setup", outcome: "running", trigger: "start" },
    ]);
    expect(await executorStatus(world.host)).toMatchObject({
      state: "running",
      installed: "1.6.10",
    });
  } finally {
    await world.close();
    await older.close();
  }
}, 90_000);

test("the start sets up nothing that runs, conflicts, is not Lazurio's here or is a newer pin's", async () => {
  const cases: readonly (readonly [
    string,
    string,
    (world: ExecutorWorld) => Promise<ExecutorHost>,
  ])[] = [
    [
      "running",
      "running",
      async (world) => {
        await executorSetup(world.host);
        return world.host;
      },
    ],
    [
      "a foreign entry",
      "conflict",
      async (world) => {
        await mkdir(world.host.bin, { recursive: true });
        await writeExecutable(join(world.host.bin, "executor"), "#!/bin/sh\n");
        return world.host;
      },
    ],
    [
      "not the operator",
      "unsupported",
      async (world) => ({
        ...world.host,
        context: async () => ({
          kind: "unsupported" as const,
          reason: "not-operator" as const,
        }),
      }),
    ],
    [
      // Not running, and a newer release's to look after.
      "a newer pin",
      "not-running",
      async (world) => {
        const newer = join(world.parent, "newer-executor");
        await writeExecutable(newer, "#!/bin/sh\necho executor v1.7.0\n");
        await mkdir(world.host.bin, { recursive: true });
        await writeExecutable(
          join(world.host.bin, "executor"),
          executorWrapper("1.7.0", newer),
        );
        return world.host;
      },
    ],
  ];
  for (const [name, state, prepare] of cases) {
    const world = await executorWorld();
    try {
      const host = await prepare(world);
      expect([name, (await executorStatus(host)).state]).toEqual([name, state]);
      world.journal.length = 0;
      world.registry.requests.length = 0;
      const npm = (await world.calls("npm.calls")).length;
      const routes = createExecutorRoutes({ host: () => host });
      expect([name, await routes.atStart()]).toEqual([name, false]);
      await routes.settled();
      expect([name, world.journal, world.registry.requests]).toEqual([
        name,
        [],
        [],
      ]);
      expect((await world.calls("npm.calls")).length).toBe(npm);
      // The row reads the state: no job runs.
      expect([
        name,
        (await routes.handle("/api/tools/executor/status")).status,
      ]).toEqual([name, 200]);
    } finally {
      await world.close();
    }
  }
}, 60_000);

test("never two setups at once: Install joins the start's, and the start joins nothing while Install's runs", async () => {
  {
    const world = await executorWorld();
    const held = world.hold();
    try {
      const routes = createExecutorRoutes({
        host: () => held.host,
        answerWithinMs: 50,
      });
      expect(await routes.atStart()).toBe(true);
      // The row's status is the running job, as Install's 202 says it.
      const status = await routes.handle("/api/tools/executor/status");
      expect(status).toMatchObject({
        status: 202,
        body: { kind: "executor-setting-up", phase: "install" },
      });
      const job = (status.body as { job: string }).job;
      expect(job).toMatch(/^[0-9a-f]{32}$/);
      expect(await routes.handle("/api/tools/executor/setup")).toEqual({
        status: 202,
        body: { kind: "executor-setting-up", job, phase: "install" },
      });
      held.release();
      await routes.settled();
      expect(
        await routes.handle("/api/tools/executor/setup", job),
      ).toMatchObject({ status: 200, body: { state: "running" } });
      expect(world.journal).toEqual([
        { operation: "setup", outcome: "running", trigger: "start" },
      ]);
    } finally {
      held.release();
      await world.close();
    }
  }
  {
    const world = await executorWorld();
    const held = world.hold();
    try {
      const routes = createExecutorRoutes({
        host: () => held.host,
        answerWithinMs: 50,
      });
      const first = await routes.handle("/api/tools/executor/setup");
      expect(first.status).toBe(202);
      const job = (first.body as { job: string }).job;
      expect(await routes.atStart()).toBe(false);
      expect(await routes.handle("/api/tools/executor/status")).toEqual({
        status: 202,
        body: { kind: "executor-setting-up", job, phase: "install" },
      });
      held.release();
      await routes.settled();
      // Install's, without the start's mark.
      expect(world.journal).toEqual([
        { operation: "setup", outcome: "running" },
      ]);
    } finally {
      held.release();
      await world.close();
    }
  }
}, 60_000);

test.skipIf(!posix)(
  "after its start, the Launchpad of a supervised base of the hosted operator sets Executor up once in the background: the start does not wait for it, the row's status shows its job, and the journal names the start",
  async () => {
    const world = await executorWorld();
    const held = world.hold();
    const lines: string[] = [];
    const log = spyOn(console, "log").mockImplementation(
      (...values: unknown[]) => {
        lines.push(values.map(String).join(" "));
      },
    );
    let asked = 0;
    // The Launchpad journals the setup itself: the host keeps no journal.
    const s = await session(world, {
      host: { ...held.host, journal: undefined },
      executorAtStart: async () => {
        asked++;
        return true;
      },
    });
    try {
      // The start is done while the setup waits for its download.
      const running = await until(async () => {
        const answer = await s.json("/api/tools/executor/status");
        return answer.status === 202 ? answer : null;
      });
      expect(running.body).toMatchObject({
        kind: "executor-setting-up",
        phase: "install",
      });
      expect(asked).toBe(1);
      expect(held.requested()).toBeGreaterThan(0);
      // Install joins it.
      expect(await s.json("/api/tools/executor/setup")).toEqual({
        status: 202,
        body: {
          kind: "executor-setting-up",
          job: running.body.job,
          phase: "install",
        },
      });
      held.release();
      let answer = running;
      while (answer.status === 202)
        answer = await s.json("/api/tools/executor/setup", {
          job: running.body.job,
        });
      expect(answer).toMatchObject({
        status: 200,
        body: { kind: "executor-status", state: "running" },
      });
      expect(
        lines
          .filter((line) => line.includes('"tools-executor"'))
          .map((line) => JSON.parse(line)),
      ).toEqual([
        {
          scope: "tools-executor",
          operation: "setup",
          outcome: "running",
          trigger: "start",
        },
      ]);
    } finally {
      log.mockRestore();
      held.release();
      await s.close();
      await world.close();
    }
  },
  60_000,
);

test.skipIf(!posix)(
  "a setup the start began and that stopped is not tried again; the row offers its action",
  async () => {
    const world = await executorWorld();
    world.registry.tamper(world.pin.platforms["linux-x64"].url);
    const s = await session(world, { executorAtStart: async () => true });
    try {
      await until(async () => world.journal.length > 0);
      expect(world.journal).toEqual([
        {
          operation: "setup",
          outcome: "not-installed",
          stage: "integrity",
          reason: "integrity-mismatch",
          trigger: "start",
        },
      ]);
      await Bun.sleep(300);
      expect(world.journal).toHaveLength(1);
      const status = await s.json("/api/tools/executor/status");
      expect(status).toMatchObject({
        status: 200,
        body: { kind: "executor-status", state: "not-installed" },
      });
      expect(
        executorAction(parseExecutorStatus(status.body), messages("en")),
      ).toEqual({ kind: "setup", label: messages("en").executorActionInstall });
    } finally {
      await s.close();
      await world.close();
    }
  },
  60_000,
);

test.skipIf(!posix)(
  "a Launchpad that is not a supervised base of the hosted operator sets nothing up at its start, and Executor never fails or holds a start",
  async () => {
    const answers: readonly (readonly [string, () => Promise<boolean>])[] = [
      ["not supervised or not hosted", async () => false],
      [
        "unreadable",
        async () => {
          throw new Error("handover unreadable");
        },
      ],
    ];
    for (const [name, answer] of answers) {
      const world = await executorWorld();
      let asked = false;
      const s = await session(world, {
        executorAtStart: async () => {
          try {
            return await answer();
          } finally {
            asked = true;
          }
        },
      });
      try {
        await until(async () => asked);
        await Bun.sleep(100);
        expect([
          name,
          await s.json("/api/tools/executor/status"),
        ]).toMatchObject([
          name,
          { status: 200, body: { state: "not-installed" } },
        ]);
        expect([name, world.journal, world.registry.requests]).toEqual([
          name,
          [],
          [],
        ]);
      } finally {
        await s.close();
        await world.close();
      }
    }
    // An answer that never comes holds nothing.
    const world = await executorWorld();
    const s = await session(world, {
      executorAtStart: () => new Promise<boolean>(() => undefined),
    });
    try {
      expect(await s.json("/api/tools/executor/status")).toMatchObject({
        status: 200,
        body: { state: "not-installed" },
      });
    } finally {
      await s.close();
      await world.close();
    }
  },
  60_000,
);

// Review of #304 at c65f6480: a closing Launchpad starts no setup, neither
// the start's nor Install's, whatever it was waiting for when it began to
// close. The one place a setup job is created refuses it.
test("while the Launchpad closes, no setup starts: Install is refused as closing and the start starts nothing", async () => {
  const world = await executorWorld();
  try {
    const routes = createExecutorRoutes({
      host: () => world.host,
      closing: () => true,
    });
    expect(await routes.handle("/api/tools/executor/setup")).toEqual({
      status: 503,
      body: { kind: "blocked", reason: "closing", tool: "executor" },
    });
    expect(await routes.atStart()).toBe(false);
    await routes.settled();
    expect(world.registry.requests).toEqual([]);
    expect(world.journal).toEqual([]);
    expect(await world.calls("npm.calls")).toEqual([]);
    // The state is still read.
    expect(await routes.handle("/api/tools/executor/status")).toMatchObject({
      status: 200,
      body: { state: "not-installed" },
    });
  } finally {
    await world.close();
  }
}, 30_000);

test.skipIf(!posix)(
  "a Launchpad that closes while its start still reads Executor's state starts no setup once the read ends",
  async () => {
    const world = await executorWorld();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reads = 0;
    // The start's read waits in the host's context until the test lets it go.
    const s = await session(world, {
      host: {
        ...world.host,
        context: async () => {
          reads++;
          await held;
          return { kind: "supported" as const };
        },
      },
      executorAtStart: async () => true,
    });
    try {
      await until(async () => reads > 0);
      await s.close();
      release();
      // The read goes on to its last question (Codex's entry); a setup would
      // ask for its first tarball right after it.
      await until(async () => (await world.calls("codex.calls")).length > 0);
      await Bun.sleep(500);
      expect(world.registry.requests).toEqual([]);
      expect(await world.calls("npm.calls")).toEqual([]);
      expect(world.journal).toEqual([]);
    } finally {
      release();
      await world.close();
    }
  },
  30_000,
);

// The row (decision F44, addendum of 2026-10-11): a setup the page did not
// start, the Launchpad's own after its start or Install in another page, is
// followed as if Install had been clicked here.
test("the row follows a setup it did not start: a reading that finds one running asks with its job until it ends", async () => {
  const job = "a".repeat(32);
  const posts: (readonly [string, unknown])[] = [];
  let polls = 0;
  let settled = 0;
  const panel = createExecutorPanel({
    post: async (path, body) => {
      posts.push([path, body]);
      if (path === "/api/tools/executor/status")
        return {
          ok: true,
          value: { kind: "executor-setting-up", job, phase: "service" },
        };
      polls++;
      return {
        ok: true,
        value:
          polls === 1
            ? { kind: "executor-setting-up", job, phase: "agents" }
            : runningStatus,
      };
    },
    copy: () => messages("en"),
    changed: () => undefined,
    settled: () => {
      settled++;
    },
    prompt: () => undefined,
  });
  await panel.read();
  // The step it is at, and no action while it runs.
  const row = panel.row(messages("en"));
  expect(row.line).toEqual({
    text: messages("en").executorPhaseService,
    state: "unknown",
  });
  expect(row.controls).toEqual([]);
  await until(async () => settled === 1);
  expect(posts).toEqual([
    ["/api/tools/executor/status", {}],
    ["/api/tools/executor/setup", { job }],
    ["/api/tools/executor/setup", { job }],
  ]);
}, 20_000);
