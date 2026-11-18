import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrainHttp } from "../src/brain/admin";
import { readBrainState, writeBrainState } from "../src/brain/keys";
import {
  convergeMeaning,
  downloadVerified,
  type MeaningHost,
} from "../src/brain/meaning";
import {
  meaningPaths,
  meaningPin,
  meaningUnit,
} from "../src/brain/meaning-pin";
import {
  brainPaths,
  brainPin,
  brainRefreshService,
  brainUnit,
  releaseCommand,
} from "../src/brain/pin";
import { writeBrainUnits } from "../src/brain/units";
import type { ToolRunner } from "../src/tools/status";
import type { ProcessRunner } from "../src/update/self-check";

// Search by meaning (plan LZD-0033 R11a, decided 2026-11-18): the pinned
// model verified by its digest, its unit at a lower priority, and the brain
// switched on once like a move, with a copy and a way back. Stand-ins only:
// fetch is a function, gbrain and systemctl are recorded, HTTP is a function;
// no network, no listening socket, no real model. Fictional data.

describe("the model's download", () => {
  test("only the pinned digest over https is kept; anything else leaves nothing", async () => {
    const root = await mkdtemp(join(tmpdir(), "brain-meaning-dl-"));
    const bytes = new TextEncoder().encode("a fictional model");
    const digest = createHash("sha256").update(bytes).digest("hex");
    const fetcher = async () => new Response(bytes);
    const file = join(root, "models", "m.gguf");
    expect(
      await downloadVerified(
        fetcher,
        "https://example.invalid/m",
        digest,
        file,
      ),
    ).toBe(true);
    expect(await readFile(file, "utf8")).toBe("a fictional model");
    const other = join(root, "models", "n.gguf");
    expect(
      await downloadVerified(
        fetcher,
        "https://example.invalid/m",
        "0".repeat(64),
        other,
      ),
    ).toBe(false);
    expect(
      await downloadVerified(
        fetcher,
        "http://example.invalid/m",
        digest,
        other,
      ),
    ).toBe(false);
    expect((await readdir(join(root, "models"))).sort()).toEqual(["m.gguf"]);
  });
});

async function stand(
  options: Readonly<{ migrateFails?: boolean; idle?: boolean }> = {},
) {
  const root = await mkdtemp(join(tmpdir(), "brain-meaning-"));
  const paths = brainPaths(join(root, "home"));
  const command = releaseCommand(paths, brainPin.commit);
  // The pinned release runs the brain; the model and its server are there
  // already (their presence is the proof a verified download leaves).
  const mp = meaningPaths(paths.home);
  await mkdir(join(mp.server, "build", "bin"), { recursive: true });
  await writeFile(
    join(mp.server, "build", "bin", "llama-server"),
    "#!/bin/sh\n",
    { mode: 0o755 },
  );
  await mkdir(join(mp.model, ".."), { recursive: true });
  await writeFile(mp.model, "fictional");
  await mkdir(join(paths.brain, "serve"), { recursive: true });
  await writeFile(join(paths.brain, "config.json"), '{"brain":"before"}');
  await writeFile(
    paths.probeKey,
    JSON.stringify({ url: "http://127.0.0.1:3131", token: "p".repeat(32) }),
  );
  await writeBrainUnits(paths.units, command, false);
  await writeBrainState(paths, {
    release: {
      commit: brainPin.commit,
      version: brainPin.version,
      command,
      source: "lazurio",
    },
  });
  const world = { server: true, timer: true, model: false };
  const calls: string[][] = [];
  const service: ProcessRunner = async (argv) => {
    calls.push([...argv]);
    const [, , verb, ...rest] = argv;
    const names = rest.filter((a) => !a.startsWith("-"));
    const done = (exitCode: number, stdout = "") => ({
      exitCode,
      stdout,
      stderr: "",
    });
    if (verb === "is-active") {
      const on = names[0] === brainUnit ? world.server : world.timer;
      return done(on ? 0 : 3, on ? "active\n" : "inactive\n");
    }
    if (verb === "is-enabled") return done(1, "disabled\n");
    for (const name of names) {
      if (name === meaningUnit && verb === "enable") world.model = true;
      if (name === brainUnit && (verb === "stop" || verb === "disable"))
        world.server = false;
      if (name === brainUnit && verb === "start") world.server = true;
      if (name.endsWith(".timer") && verb === "stop") world.timer = false;
      if (name.endsWith(".timer") && verb === "start") world.timer = true;
    }
    return done(0);
  };
  const run: ToolRunner = async (argv) => {
    calls.push([...argv]);
    const ok = { exitCode: 0, stdout: "", stderr: "" };
    if (argv[1] === "embeddings") {
      const dims = argv[argv.indexOf("--embedding-dimensions") + 1];
      if (dims === "768")
        return {
          exitCode: 1,
          stdout: JSON.stringify({
            error: { code: "embedding_width_mismatch" },
            fix: {
              argv: [
                "gbrain",
                "embeddings",
                "enable",
                "--embedding-dimensions",
                "1024",
              ],
            },
          }),
          stderr: "",
        };
      return ok;
    }
    if (argv[1] === "migrate") {
      // A failure may come after the brain changed: the copy must come back.
      await writeFile(join(paths.brain, "config.json"), '{"brain":"768d"}');
      if (options.migrateFails) return { ...ok, exitCode: 1 };
    }
    return ok;
  };
  const http: BrainHttp = async (method, url) => {
    const { pathname, port } = new URL(url);
    if (port === "3132")
      return world.model ? { status: 200, body: "{}" } : null;
    if (!world.server) return null;
    if (pathname === "/health")
      return {
        status: 200,
        body: JSON.stringify({ status: "ok", version: brainPin.version }),
      };
    if (pathname === "/mcp" && method === "POST")
      return {
        status: 200,
        body: JSON.stringify({
          result: { content: [{ text: JSON.stringify({ page_count: 46 }) }] },
        }),
      };
    return { status: 404, body: "{}" };
  };
  const host: MeaningHost = {
    paths,
    run,
    service,
    http,
    base: "http://127.0.0.1:3131",
    bun: "/fake/bun",
    env: { HOME: paths.home, PATH: "/usr/bin:/bin" },
    idle: async () => options.idle ?? true,
    now: () => new Date("2026-11-19T00:10:00Z"),
    tries: 2,
    waitMs: 1,
    fetch: async () => new Response("never asked", { status: 500 }),
  };
  return { host, paths, calls, world, command };
}

const unit = (paths: ReturnType<typeof brainPaths>, name: string) =>
  readFile(join(paths.units, name), "utf8");

describe("switching search by meaning on", () => {
  test("the model runs at a lower priority, the brain moves to its width with a copy, and the server computes in the background", async () => {
    const { host, paths, calls } = await stand();
    expect(await convergeMeaning(host)).toBe("on");
    const model = await unit(paths, meaningUnit);
    expect(model).toContain("--host 127.0.0.1 --port 3132");
    expect(model).toContain("Nice=10");
    expect(model).toContain("IOSchedulingClass=idle");
    expect(await unit(paths, brainUnit)).toContain(
      "Environment=LLAMA_SERVER_BASE_URL=http://127.0.0.1:3132/v1",
    );
    // A brain created without embeddings has another width: enabled at it,
    // then moved to the model's, pages and facts kept, vectors computed later.
    const gbrain = calls.filter(
      (c) => c[1] === "embeddings" || c[1] === "migrate",
    );
    expect(
      gbrain.map((c) =>
        c.slice(1, 3).concat(c.includes("--no-embed") ? ["--no-embed"] : []),
      ),
    ).toEqual([
      ["embeddings", "enable"],
      ["embeddings", "enable"],
      ["migrate", "embeddings", "--no-embed"],
    ]);
    // Nothing changed before systemd confirmed the server stopped.
    const confirmed = calls.findIndex(
      (c) => c[2] === "is-active" && c[3] === brainUnit,
    );
    const first = calls.findIndex((c) => c[1] === "embeddings");
    expect(confirmed).toBeGreaterThan(-1);
    expect(confirmed).toBeLessThan(first);
    expect(
      await readFile(
        join(paths.home, ".gbrain.bak-meaning-20261119T001000Z", "config.json"),
        "utf8",
      ),
    ).toBe('{"brain":"before"}');
    expect(calls).toContainEqual([
      "systemctl",
      "--user",
      "start",
      "--no-block",
      brainRefreshService,
    ]);
    const state = await readBrainState(paths);
    expect(state.meaning).toMatchObject({
      provider: meaningPin.provider,
      dimensions: 768,
    });
    expect(state.meaningAttempt).toBeUndefined();
    // Once on, a later run only keeps the model running.
    calls.length = 0;
    expect(await convergeMeaning(host)).toBe("on");
    expect(calls.some((c) => c[1] === "embeddings" || c[2] === "stop")).toBe(
      false,
    );
  });

  test("a failed step brings the brain before back without the model and is not tried again for this pin", async () => {
    const { host, paths, world } = await stand({ migrateFails: true });
    expect(await convergeMeaning(host)).toBe("restored:migrate");
    expect(await readFile(join(paths.brain, "config.json"), "utf8")).toBe(
      '{"brain":"before"}',
    );
    expect(await unit(paths, brainUnit)).not.toContain("LLAMA_SERVER_BASE_URL");
    expect(world.server).toBe(true);
    expect(await convergeMeaning(host)).toBe("held");
  });

  test("while Buddy works, the model starts but the brain is not stopped", async () => {
    const { host, paths, calls, world } = await stand({ idle: false });
    expect(await convergeMeaning(host)).toBe("waits-idle");
    expect(world.model).toBe(true);
    expect(calls.some((c) => c[2] === "stop")).toBe(false);
    expect(await unit(paths, brainUnit)).not.toContain("LLAMA_SERVER_BASE_URL");
  });
});
