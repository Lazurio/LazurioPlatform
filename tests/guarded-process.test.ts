import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startGuardedProcess } from "../src/modules/guarded-process";
import { probeListenerHealth } from "../src/modules/health";
import { processGuardCommand } from "../src/modules/process-guard";
import { parseProcessLaunch } from "../src/modules/process-launch";

const supported = ["darwin", "linux"].includes(process.platform);
const posixTest = test.skipIf(!supported);
test("process launch snapshots reject executable accessors and ambiguous inputs", () => {
  let invoked = false;
  expect(() =>
    parseProcessLaunch({
      executable: process.execPath,
      args: [],
      cwd: "/",
      env: {
        get TEST() {
          invoked = true;
          return "value";
        },
      },
    }),
  ).toThrow();
  expect(invoked).toBe(false);
  expect(() =>
    parseProcessLaunch({ executable: "bun", args: [], cwd: "/", env: {} }),
  ).toThrow();
  expect(() =>
    parseProcessLaunch({
      executable: process.execPath,
      args: ["\0"],
      cwd: "/",
      env: {},
    }),
  ).toThrow();
  const env = { TEST: "before" };
  const parsed = parseProcessLaunch({
    executable: process.execPath,
    args: [],
    cwd: "/",
    env,
  });
  env.TEST = "after";
  expect(parsed.env.TEST).toBe("before");
  expect(Object.isFrozen(parsed.env)).toBe(true);
});
let root = "";
let binary = "";
beforeAll(async () => {
  if (!supported) return;
  root = await realpath(await mkdtemp(join(tmpdir(), "process-guard-")));
  binary = join(root, "platform");
  const build = Bun.spawn(
    [
      process.execPath,
      "build",
      resolve("src/cli.ts"),
      "--compile",
      "--no-compile-autoload-dotenv",
      "--no-compile-autoload-bunfig",
      "--outfile",
      binary,
    ],
    { stdout: "ignore", stderr: "pipe" },
  );
  const [error, code] = await Promise.all([
    new Response(build.stderr).text(),
    build.exited,
  ]);
  expect(code, error).toBe(0);
});
afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

async function readReady(path: string) {
  const deadline = performance.now() + 2000;
  while (performance.now() < deadline) {
    try {
      return JSON.parse(await readFile(path, "utf8")) as {
        pid: number;
        port: number;
      };
    } catch {
      await Bun.sleep(10);
    }
  }
  throw new Error("Fixture start timed out");
}
const config = (cwd: string, mode: string) => ({
  executable: process.execPath,
  args: [
    "--no-env-file",
    resolve("tests/fixtures/process-tree.ts"),
    join(cwd, "ready.json"),
    mode,
  ],
  cwd,
  env: {},
});
const listener = (port: number) => ({
  host: "127.0.0.1",
  port,
  protocol: "http",
  health: { kind: "http", path: "/" },
});
const health = (port: number) => probeListenerHealth(listener(port));

posixTest(
  "guard retains group ownership after launcher exit and stops surviving descendants",
  async () => {
    for (const mode of ["normal", "ignore", "exit-before", "exit-grace"]) {
      const cwd = join(root, mode);
      await mkdir(cwd, { mode: 0o700 });
      const handle = await startGuardedProcess(config(cwd, mode), binary);
      try {
        expect((await handle.started).kind).toBe("started");
        const endpoint = await readReady(join(cwd, "ready.json"));
        expect((await health(endpoint.port)).kind).toBe("responding");
        if (mode === "exit-before") {
          const deadline = performance.now() + 1000;
          while (
            handle.inspect().appExitCode === null &&
            performance.now() < deadline
          )
            await Bun.sleep(10);
          expect(handle.inspect()).toMatchObject({
            appExitCode: 9,
            guardExitCode: null,
          });
        }
        expect(
          (await handle.observeListener(listener(endpoint.port))).kind,
        ).toBe(
          mode === "exit-before" ? "lifecycle-inactive" : "observed-healthy",
        );
        if (mode === "normal") {
          expect(
            (
              await handle.observeListener({
                ...listener(endpoint.port),
                health: { kind: "http", path: "/a/..//health" },
              })
            ).kind,
          ).toBe("observed-healthy");
          expect(
            await handle.observeListener({
              ...listener(endpoint.port),
              health: { kind: "http", path: "/failure" },
            }),
          ).toEqual({
            kind: "health-failed",
            health: { kind: "http-error", status: 503 },
          });
          await expect(
            handle.observeListener({
              ...listener(endpoint.port),
              host: "example.com",
            }),
          ).rejects.toThrow();
          await expect(
            handle.observeListener(listener(endpoint.port), 0),
          ).rejects.toThrow();
        }
        const first = handle.stop(50);
        expect(handle.stop(50)).toBe(first);
        expect(await first).toEqual({ kind: "group-stopped" });
        expect(await handle.observeListener(listener(endpoint.port))).toEqual({
          kind: "lifecycle-inactive",
        });
        expect((await health(endpoint.port)).kind).toBe("unavailable");
        expect(await handle.stop(50)).toEqual({ kind: "group-stopped" });
      } finally {
        await handle.stop(50);
      }
    }
  },
  15_000,
);

posixTest(
  "missing app executable fails without losing the guard cleanup handle",
  async () => {
    const handle = await startGuardedProcess(
      { executable: join(root, "absent"), args: [], cwd: root, env: {} },
      binary,
    );
    try {
      expect(await handle.started).toEqual({ kind: "failed" });
      expect(await handle.stop(50)).toEqual({ kind: "group-stopped" });
    } finally {
      await handle.stop(50);
    }
  },
);

posixTest(
  "guard refuses to run in a caller's existing process group",
  async () => {
    const child = Bun.spawn([binary, processGuardCommand], {
      cwd: root,
      env: {},
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    expect(await child.exited).toBe(1);
  },
);

posixTest(
  "closing the private control pipe cleans up an orphaned fixture group",
  async () => {
    const cwd = join(root, "pipe-close");
    await mkdir(cwd, { mode: 0o700 });
    const guard = Bun.spawn([binary, processGuardCommand], {
      cwd,
      env: {},
      detached: true,
      stdin: "pipe",
      stdout: "ignore",
      stderr: "ignore",
    });
    guard.stdin.write(`${JSON.stringify(config(cwd, "exit-before"))}\n`);
    await guard.stdin.flush();
    try {
      const endpoint = await readReady(join(cwd, "ready.json"));
      expect((await health(endpoint.port)).kind).toBe("responding");
      guard.stdin.end();
      await guard.exited;
      expect((await health(endpoint.port)).kind).toBe("unavailable");
    } finally {
      guard.stdin.end();
      await guard.exited;
    }
  },
);

posixTest(
  "stopping one guarded application preserves another live application",
  async () => {
    const firstDir = join(root, "independent-first");
    const secondDir = join(root, "independent-second");
    await mkdir(firstDir, { mode: 0o700 });
    await mkdir(secondDir, { mode: 0o700 });
    const first = await startGuardedProcess(config(firstDir, "ignore"), binary);
    const second = await startGuardedProcess(
      config(secondDir, "normal"),
      binary,
    );
    try {
      expect((await first.started).kind).toBe("started");
      expect((await second.started).kind).toBe("started");
      await readReady(join(firstDir, "ready.json"));
      const other = await readReady(join(secondDir, "ready.json"));
      expect(await first.observeListener(listener(other.port))).toEqual({
        kind: "ownership-unconfirmed",
        reason: "foreign-group",
      });
      expect(
        (
          await second.observeListener({
            ...listener(other.port),
            host: "localhost",
          })
        ).kind,
      ).toBe("observed-healthy");
      expect(await first.stop(30)).toEqual({ kind: "group-stopped" });
      expect((await health(other.port)).kind).toBe("responding");
      expect(second.inspect().guardExitCode).toBe(null);
    } finally {
      await first.stop(30);
      await second.stop(30);
    }
  },
);

posixTest(
  "stop during a health request cannot return a healthy owned listener",
  async () => {
    const cwd = join(root, "stop-observation");
    await mkdir(cwd, { mode: 0o700 });
    const handle = await startGuardedProcess(config(cwd, "slow"), binary);
    try {
      expect((await handle.started).kind).toBe("started");
      const endpoint = await readReady(join(cwd, "ready.json"));
      const observed = handle.observeListener(listener(endpoint.port));
      await readReady(join(cwd, "ready.json.request"));
      const stopped = handle.stop(30);
      expect(await observed).toEqual({ kind: "lifecycle-inactive" });
      expect(await stopped).toEqual({ kind: "group-stopped" });
    } finally {
      await handle.stop(30);
    }
  },
);
