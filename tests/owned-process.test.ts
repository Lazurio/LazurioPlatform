import { expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { probeListenerHealth } from "../src/modules/health";
import {
  compareListenerGroup,
  observeListenerBindings,
} from "../src/modules/listener-ownership";
import { startOwnedProcess } from "../src/modules/owned-process";

const posixTest = test.skipIf(!["darwin", "linux"].includes(process.platform));
async function ready(path: string) {
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
  throw new Error("Fixture readiness timeout");
}

async function fixture(
  mode: string,
  run: (
    handle: Awaited<ReturnType<typeof startOwnedProcess>>,
    endpoint: { pid: number; port: number },
  ) => Promise<void>,
) {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "owned-process-")),
  );
  let handle: Awaited<ReturnType<typeof startOwnedProcess>> | undefined;
  let endpoint: { pid: number; port: number } | undefined;
  try {
    const path = join(directory, "ready.json");
    handle = await startOwnedProcess({
      executable: process.execPath,
      args: [
        "--no-env-file",
        fileURLToPath(new URL("fixtures/process-tree.ts", import.meta.url)),
        path,
        mode,
      ],
      cwd: directory,
      env: {},
    });
    endpoint = await ready(path);
    await run(handle, endpoint);
  } finally {
    if (handle) await handle.stop(30);
    // Only the intentionally orphaned fixture child. Product code must not
    // reconstruct this kind of authority from a saved PID.
    if (mode.startsWith("exit-") && endpoint) {
      try {
        process.kill(endpoint.pid, "SIGKILL");
      } catch (error) {
        expect((error as NodeJS.ErrnoException).code).toBe("ESRCH");
      }
    }
    await rm(directory, { recursive: true, force: true });
  }
}

posixTest(
  "owned process stops its cooperative launcher and descendant, with concurrent stop coalescing",
  async () => {
    await fixture("normal", async (handle, endpoint) => {
      const target = {
        host: "127.0.0.1",
        port: endpoint.port,
        protocol: "http",
        health: { kind: "http", path: "/" },
      };
      expect(endpoint.pid).not.toBe(handle.pid);
      expect(handle.inspect().groupPresent).toBe(true);
      expect((await probeListenerHealth(target)).kind).toBe("responding");
      if (process.platform === "darwin")
        expect(
          compareListenerGroup(
            await observeListenerBindings(endpoint.port),
            "127.0.0.1",
            endpoint.port,
            handle.group,
          ),
        ).toBe("matches-process-group");
      const first = handle.stop(500);
      expect(handle.stop(500)).toBe(first);
      expect(await first).toMatchObject({
        kind: "group-stopped",
        forced: false,
      });

      expect(handle.inspect()).toMatchObject({
        groupPresent: false,
        launcherExited: true,
      });
      expect((await probeListenerHealth(target)).kind).toBe("unavailable");
      expect((await handle.stop()).kind).toBe("group-stopped");
    });
  },
);

posixTest(
  "launcher exit retires future signaling, including during stop grace",
  async () => {
    for (const mode of ["exit-before", "exit-grace"])
      await fixture(mode, async (handle, endpoint) => {
        if (mode === "exit-before") {
          const deadline = performance.now() + 1000;
          while (
            !handle.inspect().launcherExited &&
            performance.now() < deadline
          )
            await Bun.sleep(10);
          expect(handle.inspect().launcherExited).toBe(true);
        }
        expect(await handle.stop(50)).toEqual({
          kind: "incomplete",
          reason: "launcher-exited",
        });
        expect(await handle.stop(50)).toEqual({
          kind: "incomplete",
          reason: "launcher-exited",
        });
        const state = (await (
          await fetch(`http://127.0.0.1:${endpoint.port}/`, {
            signal: AbortSignal.timeout(1000),
          })
        ).json()) as { terms: number };
        expect(state.terms).toBe(mode === "exit-before" ? 0 : 1);
      });
  },
);

posixTest(
  "owned process escalates only its own non-cooperative group",
  async () => {
    await fixture("normal", async (unrelated, otherEndpoint) => {
      await fixture("ignore", async (handle) => {
        expect(await handle.stop(30)).toMatchObject({
          kind: "group-stopped",
          forced: true,
        });
        expect(unrelated.inspect().groupPresent).toBe(true);
        expect(
          (
            await probeListenerHealth({
              host: "127.0.0.1",
              port: otherEndpoint.port,
              protocol: "http",
              health: { kind: "http", path: "/" },
            })
          ).kind,
        ).toBe("responding");
      });
    });
  },
);

posixTest(
  "owned process requires explicit executable and data-only environment before spawn",
  async () => {
    let invoked = false;
    await expect(
      startOwnedProcess({
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
    ).rejects.toThrow();
    expect(invoked).toBe(false);
    await expect(
      startOwnedProcess({ executable: "bun", args: [], cwd: "/", env: {} }),
    ).rejects.toThrow("Explicit executable");
    await expect(
      startOwnedProcess({
        executable: process.execPath,
        args: ["\0"],
        cwd: "/",
        env: {},
      }),
    ).rejects.toThrow();
  },
);
