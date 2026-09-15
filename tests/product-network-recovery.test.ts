import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPilotFixture } from "../scripts/tuf-fixture";

test.skipIf(!["darwin", "linux"].includes(process.platform))(
  "compiled CLI completes a fresh interrupted prefix only with explicit network options",
  async () => {
    const home = await realpath(
      await mkdtemp(join(tmpdir(), "product-recover-")),
    );
    const env = {
      HOME: home,
      XDG_DATA_HOME: join(home, "data"),
      PATH: "/usr/bin:/bin",
    };
    const binary = join(home, "lazurio-test-cli");
    const fixture = createPilotFixture({
      artifact: Buffer.from("not an executable; recovery must not fetch it"),
      identity: Buffer.from("{}"),
      executionTarget: `${process.platform}-${process.arch}`,
    });
    fixture.publish(7);
    let blocked = true;
    let requests = 0;
    let artifacts = 0;
    const proxy = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        requests++;
        const path = new URL(request.url).pathname;
        if (path.includes("/artifacts/")) artifacts++;
        if (blocked && path === "/metadata/snapshot.json")
          return new Response("interrupted fixture", { status: 404 });
        return fetch(new URL(path, fixture.origin));
      },
    });
    const invoke = async (args: string[]) => {
      const child = Bun.spawn([binary, "product", ...args], {
        cwd: home,
        env,
        stdout: "pipe",
        stderr: "pipe",
        timeout: 10_000,
      });
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { code, stdout, stderr };
    };
    try {
      const build = Bun.spawn(
        [
          process.execPath,
          "build",
          "src/cli.ts",
          "--compile",
          "--no-compile-autoload-dotenv",
          "--no-compile-autoload-bunfig",
          "--outfile",
          binary,
        ],
        {
          cwd: join(import.meta.dir, ".."),
          env,
          stdout: "pipe",
          stderr: "pipe",
          timeout: 15_000,
        },
      );
      const [buildCode, buildOutput, buildErrors] = await Promise.all([
        build.exited,
        new Response(build.stdout).text(),
        new Response(build.stderr).text(),
      ]);
      if (buildCode !== 0)
        throw new Error(`Fixture build failed: ${buildOutput} ${buildErrors}`);
      const rootPath = join(home, "bootstrap.json");
      await writeFile(rootPath, fixture.rootBytes, { flag: "wx", mode: 0o600 });
      const trustArgs = ["--bootstrap-root", rootPath];
      const networkArgs = [
        "--metadata-url",
        `${proxy.url}metadata/`,
        "--target-url",
        `${proxy.url}targets/`,
        "--loopback-fixture",
      ];
      expect(
        (await invoke(["install", ...trustArgs, ...networkArgs])).code,
      ).not.toBe(0);
      const before = requests;
      const offline = await invoke(["recover", ...trustArgs]);
      expect(offline.code).not.toBe(0);
      expect(offline.stderr).toContain("Product operation failed");
      expect(requests).toBe(before);
      blocked = false;
      const online = await invoke(["recover", ...trustArgs, ...networkArgs]);
      expect(online.code).toBe(0);
      expect(JSON.parse(online.stdout)).toMatchObject({
        kind: "product-recovered",
        attempts: [{ published: true, candidate: null }],
      });
      expect(artifacts).toBe(0);
      const status = await invoke(["status"]);
      expect(status.code).toBe(0);
      expect(JSON.parse(status.stdout)).toMatchObject({
        kind: "product-status",
        published: { channel: { sequence: 7 } },
        active: null,
      });
    } finally {
      await proxy.stop(true);
      await fixture.stop();
      await rm(home, { recursive: true });
    }
  },
  30_000,
);
