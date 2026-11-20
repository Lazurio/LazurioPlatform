import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrainHttp } from "../src/brain/admin";
import { setupTimeoutMs } from "../src/brain/at-start";
import { readBrainState, writeBrainState } from "../src/brain/keys";
import {
  convergeMeaning,
  downloadVerified,
  type MeaningHost,
  meaningEmbedLimitMs,
  meaningStepLimitMs,
} from "../src/brain/meaning";
import { meaningPaths, meaningUnit } from "../src/brain/meaning-pin";
import {
  brainPaths,
  brainPin,
  brainUnit,
  releaseCommand,
} from "../src/brain/pin";
import { writeBrainUnits } from "../src/brain/units";
import type { ToolRunner } from "../src/tools/status";
import type { ProcessRunner } from "../src/update/self-check";
import { userManager, userRuntime } from "./fixtures/user-manager";

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
  options: Readonly<{
    /** The brain's vector column, as gbrain reads it (a brain created
     * without embeddings has 1024, bge-m3's width too). */
    column?: string;
    migrateFails?: boolean;
    embedFails?: boolean;
    idle?: boolean;
    /** Another process answers on the model's port. */
    portTaken?: boolean;
    /** gbrain refuses another width without saying the column's. */
    bareRefusal?: boolean;
    /** The brain holds vectors of another model. */
    otherVectors?: boolean;
  }> = {},
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
  await writeBrainUnits(paths, command, false);
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
      const column = options.column ?? "1024";
      // Vectors of another model: enabling cannot change their identity.
      if (options.otherVectors)
        return {
          exitCode: 1,
          stdout: JSON.stringify({ code: "embedding_model_mismatch" }),
          stderr: "",
        };
      if (dims !== column && options.bareRefusal)
        return {
          exitCode: 1,
          stdout: '{"code":"embedding_width_mismatch"}',
          stderr: "",
        };
      if (dims !== column)
        return {
          exitCode: 1,
          stdout: JSON.stringify({
            code: "embedding_width_mismatch",
            fix: {
              argv: [
                "gbrain",
                "embeddings",
                "enable",
                "--embedding-dimensions",
                column,
              ],
            },
          }),
          stderr: "",
        };
      return ok;
    }
    if (argv[1] === "migrate" && argv.includes("--status"))
      return {
        ...ok,
        stdout: `banner\n${JSON.stringify({ column_dims: Number(options.column ?? "1024") })}`,
      };
    if (argv[1] === "migrate") {
      // A failure may come after the brain changed: the copy must come back.
      await writeFile(join(paths.brain, "config.json"), '{"brain":"moved"}');
      if (options.migrateFails) return { ...ok, exitCode: 1 };
    }
    if (argv[1] === "embed") {
      await writeFile(join(paths.brain, "config.json"), '{"brain":"vectors"}');
      if (options.embedFails) return { ...ok, exitCode: 1 };
    }
    return ok;
  };
  const http: BrainHttp = async (method, url) => {
    const { pathname, port } = new URL(url);
    if (port === "3132") {
      // Another process on the model's port answers, but not as the model.
      if (options.portTaken)
        return pathname === "/props"
          ? {
              status: 200,
              body: JSON.stringify({ model_path: "/srv/other.gguf" }),
            }
          : { status: 200, body: "{}" };
      if (!world.model) return null;
      return pathname === "/props"
        ? {
            status: 200,
            body: JSON.stringify({
              model_path: mp.model,
              model_alias: "bge-m3",
            }),
          }
        : { status: 200, body: "{}" };
    }
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
    service: userManager(service),
    http,
    base: "http://127.0.0.1:3131",
    bun: "/fake/bun",
    env: { HOME: paths.home, PATH: "/usr/bin:/bin", ...userRuntime },
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
  test("the model runs at a lower priority; the brain gets every vector with the server stopped, after a copy", async () => {
    const { host, paths, calls } = await stand();
    expect(await convergeMeaning(host)).toBe("on");
    const model = await unit(paths, meaningUnit);
    expect(model).toContain("--host 127.0.0.1 --port 3132");
    expect(model).toContain("Nice=10");
    expect(model).toContain("IOSchedulingClass=idle");
    expect(await unit(paths, brainUnit)).toContain(
      "Environment=LLAMA_SERVER_BASE_URL=http://127.0.0.1:3132/v1",
    );
    // Two embedding requests at a time, not gbrain's 20 (they time out).
    expect(await unit(paths, brainUnit)).toContain(
      "Environment=GBRAIN_EMBED_CONCURRENCY=2",
    );
    // A brain created without embeddings has bge-m3's width (1024): enabled
    // at once, then every vector computed while the server is still stopped
    // (the only way on PGLite; the server computes none by itself).
    expect(model).toContain("-m ");
    expect(model).toContain("--pooling cls -c 4096");
    const gbrain = calls.filter(
      (c) => c[1] === "embeddings" || c[1] === "migrate" || c[1] === "embed",
    );
    expect(gbrain.map((c) => c.slice(1, 3))).toEqual([
      ["embeddings", "enable"],
      ["embed", "--stale"],
    ]);
    const embedded = calls.findIndex((c) => c[1] === "embed");
    const restarted =
      calls.length -
      1 -
      [...calls]
        .reverse()
        .findIndex((c) => c[2] === "start" && c[3] === brainUnit);
    expect(embedded).toBeLessThan(restarted);
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
    const state = await readBrainState(paths);
    expect(state.meaning).toMatchObject({
      provider: "llama-server:bge-m3",
      dimensions: 1024,
    });
    expect(state.meaningAttempt).toBeUndefined();
    // Once on, a later run only keeps the model running.
    calls.length = 0;
    expect(await convergeMeaning(host)).toBe("on");
    expect(calls.some((c) => c[1] === "embeddings" || c[2] === "stop")).toBe(
      false,
    );
  });

  test("a column of another width is enabled at it, moved to the model's with every page kept, then embedded", async () => {
    const { host, calls } = await stand({ column: "768" });
    expect(await convergeMeaning(host)).toBe("on");
    const gbrain = calls.filter(
      (c) => c[1] === "embeddings" || c[1] === "migrate" || c[1] === "embed",
    );
    expect(
      gbrain.map((c) =>
        c.slice(1, 3).concat(c.includes("--no-embed") ? ["--no-embed"] : []),
      ),
    ).toEqual([
      ["embeddings", "enable"],
      ["embeddings", "enable"],
      ["migrate", "embeddings", "--no-embed"],
      ["embed", "--stale"],
    ]);
  });

  test("a refusal that does not say the column's width is read from gbrain's status of the column", async () => {
    const { host, calls } = await stand({ column: "768", bareRefusal: true });
    expect(await convergeMeaning(host)).toBe("on");
    expect(
      calls
        .filter((c) =>
          ["embeddings", "migrate", "embed"].includes(c[1] as string),
        )
        .map((c) => c.slice(1, 4).join(" ")),
    ).toEqual([
      "embeddings enable --embedding-model",
      "migrate embeddings --status",
      "embeddings enable --embedding-model",
      "migrate embeddings --to",
      "embed --stale --catch-up",
    ]);
    const enables = calls.filter((c) => c[1] === "embeddings");
    expect(enables[1]?.[enables[1].indexOf("--embedding-dimensions") + 1]).toBe(
      "768",
    );
  });

  test("vectors of another model: enabling is refused, so the migration moves them to the model and every vector is computed again", async () => {
    const { host, calls } = await stand({ column: "768", otherVectors: true });
    expect(await convergeMeaning(host)).toBe("on");
    expect(
      calls
        .filter((c) =>
          ["embeddings", "migrate", "embed"].includes(c[1] as string),
        )
        .map((c) => c.slice(1, 4).join(" ")),
    ).toEqual([
      "embeddings enable --embedding-model",
      "migrate embeddings --to",
      "embed --stale --catch-up",
    ]);
  });

  test("an embedding that reaches its limit brings the copy back, and the Launchpad waits longer than that limit", async () => {
    const { host, paths, world } = await stand();
    const run = host.run;
    let limit = 0;
    const slow = {
      ...host,
      run: async (
        argv: readonly string[],
        timeout: number,
        env: Readonly<Record<string, string>>,
      ) => {
        if (argv[1] !== "embed") return run(argv, timeout, env);
        limit = timeout;
        // The embedding wrote some vectors before its limit ended it.
        await writeFile(join(paths.brain, "config.json"), '{"brain":"half"}');
        return "timeout" as const;
      },
    } as typeof host;
    expect(await convergeMeaning(slow)).toBe("restored:embed");
    expect(limit).toBe(meaningEmbedLimitMs);
    expect(await readFile(join(paths.brain, "config.json"), "utf8")).toBe(
      '{"brain":"before"}',
    );
    expect(world.server).toBe(true);
    // Setup as the Launchpad's child outlasts the embedding, the copy, a
    // migration and the start around it.
    expect(setupTimeoutMs).toBeGreaterThan(
      meaningEmbedLimitMs + 4 * meaningStepLimitMs,
    );
  });

  test("a refusal gbrain does not explain is not tried further", async () => {
    const { host, paths, calls } = await stand({ column: "768" });
    const run = host.run;
    const odd = {
      ...host,
      run: async (
        argv: readonly string[],
        timeout: number,
        env: Readonly<Record<string, string>>,
      ) =>
        argv[1] === "embeddings"
          ? { exitCode: 1, stdout: '{"code":"something_else"}', stderr: "" }
          : run(argv, timeout, env),
    } as typeof host;
    expect(await convergeMeaning(odd)).toBe("restored:enable");
    expect(calls.some((c) => c[1] === "migrate" && c.includes("--to"))).toBe(
      false,
    );
    expect(await readFile(join(paths.brain, "config.json"), "utf8")).toBe(
      '{"brain":"before"}',
    );
  });

  test("a failed step brings the brain before back without the model and is not tried again for this pin", async () => {
    const moved = await stand({ column: "768", migrateFails: true });
    expect(await convergeMeaning(moved.host)).toBe("restored:migrate");
    expect(await readFile(join(moved.paths.brain, "config.json"), "utf8")).toBe(
      '{"brain":"before"}',
    );
    const { host, paths, world } = await stand({ embedFails: true });
    expect(await convergeMeaning(host)).toBe("restored:embed");
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

  test("a model unit nobody of these wrote, or one unreadable, is left alone", async () => {
    const { host, paths, calls } = await stand();
    await writeFile(
      join(paths.units, meaningUnit),
      "[Service]\nExecStart=/opt/x\n",
    );
    expect(await convergeMeaning(host)).toBe("waits:unit-foreign");
    expect(await unit(paths, meaningUnit)).toBe(
      "[Service]\nExecStart=/opt/x\n",
    );
    expect(calls.some((c) => c[2] === "enable" || c[2] === "stop")).toBe(false);
    if (process.getuid?.() === 0) return;
    await chmod(join(paths.units, meaningUnit), 0o000);
    expect(await convergeMeaning(host)).toBe("waits:unit-unreadable");
    await chmod(join(paths.units, meaningUnit), 0o644);
  });

  test("Lazurio's own earlier model unit, known by its digest, is rewritten", async () => {
    const { host, paths } = await stand();
    const earlier = "# an earlier unit of Lazurio's\n";
    await writeFile(join(paths.units, meaningUnit), earlier);
    await writeBrainState(paths, {
      ...(await readBrainState(paths)),
      meaningUnit: createHash("sha256").update(earlier).digest("hex"),
    });
    expect(await convergeMeaning(host)).toBe("on");
    expect(await unit(paths, meaningUnit)).toContain("--alias bge-m3");
  });

  test("another process on the model's port never gets the brain's text: nothing stops", async () => {
    const { host, calls, world } = await stand({ portTaken: true });
    expect(await convergeMeaning(host)).toBe("waits:port-taken");
    expect(calls.some((c) => c[2] === "stop")).toBe(false);
    expect(calls.some((c) => c[1] === "embeddings" || c[1] === "embed")).toBe(
      false,
    );
    expect(world.server).toBe(true);
  });

  test("a run that died before the copy was whole: the brain untouched, the server back, tried again later", async () => {
    const { host, paths, world } = await stand();
    const backup = ".gbrain.bak-meaning-20261119T000000Z";
    await mkdir(join(paths.home, backup), { recursive: true });
    await writeFile(join(paths.home, backup, "partial"), "x");
    await writeBrainState(paths, {
      ...(await readBrainState(paths)),
      meaningAttempt: {
        provider: "llama-server:bge-m3",
        result: "stopping",
        at: "2026-11-19T00:00:00.000Z",
        backup,
      },
    });
    world.server = false;
    world.timer = false;
    expect(await convergeMeaning(host)).toBe("waits:interrupted");
    expect(await readdir(paths.home)).not.toContain(backup);
    expect(world.server && world.timer).toBe(true);
    expect((await readBrainState(paths)).meaningAttempt).toBeUndefined();
    expect(await readFile(join(paths.brain, "config.json"), "utf8")).toBe(
      '{"brain":"before"}',
    );
    // The next idle run switches it on.
    expect(await convergeMeaning(host)).toBe("on");
  });

  test("a run that died after gbrain began: the copy comes back without the model", async () => {
    const { host, paths, world } = await stand();
    const backup = ".gbrain.bak-meaning-20261119T000000Z";
    await mkdir(join(paths.home, backup), { recursive: true });
    await writeFile(
      join(paths.home, backup, "config.json"),
      '{"brain":"before"}',
    );
    await writeFile(join(paths.brain, "config.json"), '{"brain":"half-moved"}');
    await writeBrainState(paths, {
      ...(await readBrainState(paths)),
      meaningAttempt: {
        provider: "llama-server:bge-m3",
        result: "started",
        at: "2026-11-19T00:00:00.000Z",
        backup,
      },
    });
    world.server = false;
    world.timer = false;
    expect(await convergeMeaning(host)).toBe("restored:interrupted");
    expect(await readFile(join(paths.brain, "config.json"), "utf8")).toBe(
      '{"brain":"before"}',
    );
    expect(await unit(paths, brainUnit)).not.toContain("LLAMA_SERVER_BASE_URL");
    expect(world.server && world.timer).toBe(true);
    expect(await convergeMeaning(host)).toBe("held");
  });
});
