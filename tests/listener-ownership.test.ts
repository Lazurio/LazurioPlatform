import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { probeListenerHealth } from "../src/modules/health";
import {
  compareListenerGroup,
  observeListenerBindings,
  parseListenerBindings,
} from "../src/modules/listener-ownership";

test("binding evidence retains per-process groups and exact socket addresses", () => {
  const bindings = parseListenerBindings(
    "p21\ng20\nu501\nf4\nn127.0.0.1:4100\np31\ng30\nu502\nf7\nn[::1]:4100\n",
    4100,
  );
  expect(bindings).toHaveLength(2);
  expect(bindings[1]).toEqual({
    pid: 31,
    group: 30,
    uid: 502,
    fd: 7,
    host: "::1",
    port: 4100,
  });
  expect(Object.isFrozen(bindings[0])).toBe(true);
  expect(
    compareListenerGroup({ kind: "observed", bindings }, "localhost", 4100, 20),
  ).toBe("foreign-group");
  expect(
    compareListenerGroup(
      { kind: "observed", bindings: bindings.slice(0, 1) },
      "127.0.0.1",
      4100,
      20,
    ),
  ).toBe("matches-process-group");
});

test("incomplete or unexpected lsof output cannot produce ownership evidence", () => {
  for (const output of [
    "n127.0.0.1:4100\n",
    "p21\ng20\nf4\nn127.0.0.1:4100\n",
    "p21\ng20\nu501\nf4\n",
    "p21\ng20\nu501\nf4\nn127.0.0.1:4101\n",
    "p21\ng20\nu501\nf4\nnexample.com:4100\n",
    "p21\ng20\nu501\nf4\nn127.0.0.1:4100\np31\ng30\nu501\n",
    "p21\ng20\nu501\nf4\nn127.0.0.1:4100->127.0.0.1:5100\n",
  ])
    expect(() => parseListenerBindings(output, 4100)).toThrow();
  expect(
    compareListenerGroup({ kind: "unavailable" }, "localhost", 4100, 20),
  ).toBe("unavailable");
  expect(
    compareListenerGroup(
      { kind: "observed", bindings: [] },
      "localhost",
      4100,
      20,
    ),
  ).toBe("not-observed");
});

test("wildcard binding is not equivalent to declared loopback even for matching group", () => {
  const bindings = parseListenerBindings("p21\ng20\nu501\nf4\nn*:4100\n", 4100);
  expect(
    compareListenerGroup({ kind: "observed", bindings }, "127.0.0.1", 4100, 20),
  ).toBe("binding-mismatch");
});

test.skipIf(process.platform !== "darwin")(
  "native listener observation distinguishes own fixture group from unrelated group",
  async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        fileURLToPath(new URL("fixtures/health-app.ts", import.meta.url)),
      ],
      {
        cwd: "/",
        env: {},
        detached: true,
        stdout: "pipe",
        stderr: "ignore",
      },
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const reader = child.stdout.getReader();
      const chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Fixture start timeout")),
            3000,
          );
        }),
      ]);
      clearTimeout(timer);
      reader.releaseLock();
      const port = Number(new TextDecoder().decode(chunk.value).trim());
      const observed = await observeListenerBindings(port);
      expect(observed.kind).toBe("observed");
      if (observed.kind !== "observed")
        throw new Error("Native lsof evidence unavailable");
      expect(
        observed.bindings.some(
          (item) => item.pid === child.pid && item.group === child.pid,
        ),
      ).toBe(true);
      expect(compareListenerGroup(observed, "127.0.0.1", port, child.pid)).toBe(
        "matches-process-group",
      );
      expect(
        compareListenerGroup(observed, "127.0.0.1", port, child.pid + 1),
      ).toBe("foreign-group");
      // Refusing foreign ownership does not kill or alter the observed process.
      expect(
        await probeListenerHealth({
          host: "127.0.0.1",
          port,
          protocol: "http",
          health: { kind: "http", path: "/" },
        }),
      ).toEqual({ kind: "responding", status: 200 });
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
    }
  },
  10_000,
);
