import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brainHttp } from "../src/brain/admin";
import { readBrainState } from "../src/brain/keys";
import {
  brainPaths,
  brainPin,
  brainUnit,
  releaseCommand,
} from "../src/brain/pin";
import { brainSetup, type SetupHost } from "../src/brain/setup";
import type { ToolRunner } from "../src/tools/status";
import type { ProcessRunner } from "../src/update/self-check";
import { unitMarker } from "../src/update/service-control";

// `lazurio brain setup` on a Personal Environment (plan LZD-0033 R11a),
// against stand-ins: Bun and `gbrain init` write what they would, systemctl
// is recorded, and a loopback server plays gbrain once its unit is started.
// Fictional tokens; no user manager, network or real brain is touched.

const brain = {
  up: false,
  version: brainPin.version,
  admin: "",
  keys: [] as { id: string; name: string; token: string; status: string }[],
};
let server: ReturnType<typeof Bun.serve>;
let base: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      if (!brain.up) return new Response("", { status: 503 });
      const url = new URL(request.url);
      const body =
        request.method === "POST" ? await request.json().catch(() => ({})) : {};
      if (url.pathname === "/health")
        return Response.json({ status: "ok", version: brain.version });
      if (url.pathname === "/mcp") {
        const token = (request.headers.get("authorization") ?? "").replace(
          "Bearer ",
          "",
        );
        return new Response("{}", {
          status: brain.keys.some(
            (k) => k.token === token && k.status === "active",
          )
            ? 200
            : 401,
        });
      }
      if (url.pathname === "/admin/login")
        return body.token === brain.admin
          ? new Response("{}", { headers: { "set-cookie": "admin=1; Path=/" } })
          : new Response("{}", { status: 401 });
      if (url.pathname === "/admin/api/api-keys" && request.method === "GET")
        return Response.json(brain.keys);
      if (url.pathname === "/admin/api/api-keys") {
        const key = {
          id: `id-${brain.keys.length + 1}`,
          name: body.name,
          token: `tok-${brain.keys.length + 1}-${"x".repeat(32)}`,
          status: "active",
        };
        brain.keys.push(key);
        return Response.json({ id: key.id, token: key.token });
      }
      if (url.pathname === "/admin/api/api-keys/revoke")
        return Response.json({});
      return new Response("{}", { status: 404 });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});
afterAll(() => server.stop(true));

async function host(
  options: Readonly<{
    installFails?: boolean;
    existingUnit?: string;
    noHandover?: boolean;
  }> = {},
) {
  const root = await mkdtemp(join(tmpdir(), "brain-setup-"));
  const paths = brainPaths(join(root, "home"));
  const globalUnits = join(root, "etc-systemd-user");
  await mkdir(globalUnits, { recursive: true });
  // Machines' mark of C1: they hand the brain over on this host.
  const handover = join(root, "brain-handover");
  if (!options.noHandover) await writeFile(handover, "");
  if (options.existingUnit !== undefined) {
    await mkdir(paths.units, { recursive: true });
    await writeFile(join(paths.units, brainUnit), options.existingUnit);
  }
  brain.up = false;
  brain.keys = [];
  const calls: string[][] = [];
  const run: ToolRunner = async (command, _timeout, env) => {
    calls.push([...command]);
    if (command[1] === "add") {
      if (options.installFails) return { exitCode: 1, stdout: "", stderr: "" };
      const dir = env.BUN_INSTALL as string;
      const pkg = join(dir, "install", "global", "node_modules", "gbrain");
      await mkdir(pkg, { recursive: true });
      await writeFile(
        join(pkg, "package.json"),
        JSON.stringify({ version: brainPin.version }),
      );
      await mkdir(join(dir, "bin"), { recursive: true });
      await writeFile(join(dir, "bin", "gbrain"), "#!/bin/sh\n", {
        mode: 0o755,
      });
    } else if (command[1] === "init") {
      await mkdir(paths.brain, { recursive: true });
      await writeFile(join(paths.brain, "config.json"), "{}");
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  const service: ProcessRunner = async (command) => {
    calls.push([...command]);
    if (command[2] === "start") {
      brain.admin = (await readFile(paths.adminToken, "utf8")).trim();
      brain.up = true;
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  const setupHost: SetupHost = {
    async context() {
      return { kind: "supported" };
    },
    paths,
    globalUnits,
    handover,
    async health() {
      if (!brain.up) return null;
      return brain.version;
    },
    run,
    service,
    http: brainHttp,
    bun: "/fake/bun",
    // No Personalspace declares a vault yet: the brain stays local.
    vault: {
      folder: join(paths.home, "Lazurio"),
      gh: undefined,
    },
    idle: async () => true,
    env: { HOME: paths.home, PATH: "/usr/bin:/bin" },
    base,
    tries: 3,
    waitMs: 1,
  };
  return { setupHost, paths, calls };
}

describe("brain setup", () => {
  test("a Personal Environment without a brain gets the pinned release, a brain, Lazurio's units and the keys", async () => {
    const { setupHost, paths, calls } = await host();
    const result = await brainSetup(setupHost);
    expect(result.server).toBe("installed");
    expect(result.keys).toEqual({
      launchpad: "minted",
      executor: "minted",
      probe: "minted",
    });
    expect(result.vault).toBe("local");
    expect(result.status).toMatchObject({ state: "running", owner: "lazurio" });
    // Bun installs the pinned commit into its own directory, no root.
    expect(calls.find((c) => c[1] === "add")).toEqual([
      "/fake/bun",
      "add",
      "--global",
      `github:${brainPin.repository}#${brainPin.commit}`,
    ]);
    // The brain is created by the pinned release, without embeddings.
    expect(calls.find((c) => c[1] === "init")).toEqual([
      releaseCommand(paths, brainPin.commit),
      "init",
      "--pglite",
      "--no-embedding",
      "--non-interactive",
    ]);
    // The owner credential: 0600, 64 hex characters, never in a unit.
    expect((await stat(paths.adminToken)).mode & 0o777).toBe(0o600);
    const unit = await readFile(join(paths.units, brainUnit), "utf8");
    expect(unit.startsWith(unitMarker)).toBe(true);
    expect(unit).toContain(
      `exec ${releaseCommand(paths, brainPin.commit)} serve --http --bind 127.0.0.1 --port 3131`,
    );
    expect(unit).not.toContain(brain.admin);
    expect(
      calls.filter((c) => c[0] === "systemctl").map((c) => c.slice(2)),
    ).toEqual([["daemon-reload"], ["enable", brainUnit], ["start", brainUnit]]);
    expect((await readBrainState(paths)).release).toEqual({
      commit: brainPin.commit,
      version: brainPin.version,
      command: releaseCommand(paths, brainPin.commit),
      source: "lazurio",
    });
  });

  test("a second run changes nothing and keeps every key", async () => {
    const { setupHost } = await host();
    await brainSetup(setupHost);
    const again = await brainSetup(setupHost);
    expect(again.server).toBe("running");
    expect(again.keys).toEqual({
      launchpad: "kept",
      executor: "kept",
      probe: "kept",
    });
  });

  test("until Machines mark the handover on this host, nothing is installed, taken over or minted", async () => {
    const { setupHost, calls, paths } = await host({ noHandover: true });
    const result = await brainSetup(setupHost);
    expect(result).toMatchObject({
      server: "waits-machines",
      status: { state: "not-installed", handover: false },
    });
    expect(calls).toEqual([]);
    expect(
      await stat(paths.units).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  });

  test("a failed install stops before anything is written or started", async () => {
    const { setupHost, paths, calls } = await host({ installFails: true });
    const result = await brainSetup(setupHost);
    expect(result).toMatchObject({ server: "failed", step: "install" });
    expect(calls.some((c) => c[0] === "systemctl")).toBe(false);
    expect(
      await stat(join(paths.units, brainUnit)).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  });

  test("the interim installer's brain waits for its owner's takeover; a foreign unit is left alone", async () => {
    const interim =
      "[Service]\nExecStart=/bin/bash -c 'exec %h/.bun/bin/gbrain serve --http --bind 127.0.0.1 --port 3131'\n";
    const a = await host({ existingUnit: interim });
    expect((await brainSetup(a.setupHost)).server).toBe("waits-takeover");
    expect(a.calls).toEqual([]);
    const b = await host({ existingUnit: "[Service]\nExecStart=/opt/other\n" });
    expect((await brainSetup(b.setupHost)).server).toBe("foreign");
    expect(b.calls).toEqual([]);
  });
});
