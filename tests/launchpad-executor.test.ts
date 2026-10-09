import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecutorHost } from "../src/executor/flow";
import { initializeFolder } from "../src/folder/initialize-folder";
import { executionOs } from "../src/folder/platform";
import { createExecutorRoutes } from "../src/launchpad/executor-routes";
import { parseExecutorStatus } from "../src/launchpad/executor-view";
import { startLaunchpad } from "../src/launchpad/server";
import { runTool } from "../src/tools/status";
import { type ExecutorWorld, executorWorld } from "./fixtures/fake-executor";

// Settings → Tools → executor over HTTP (decision F44): two routes behind the
// admission of every route, `{}` only (or a setup's `{job}`), a setup
// answered within a second while it runs and joined by the next request, and
// the curated routes of F19 refusing Executor.

const posix = process.platform !== "win32";
type Json = Record<string, unknown>;

async function session(world: ExecutorWorld) {
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
  const app = await startLaunchpad(
    folder,
    undefined,
    undefined,
    undefined,
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
    world.host,
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
