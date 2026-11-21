import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrainHttp } from "../src/brain/admin";
import {
  brainSetupAtStart,
  nightRecheckMs,
  setupTimeoutMs,
} from "../src/brain/at-start";
import { readBrainState, writeBrainState } from "../src/brain/keys";
import {
  convergeMeaning,
  downloadVerified,
  embedPlan,
  type MeaningHost,
  meaningBatchLimitMs,
  meaningDayStopMs,
  meaningEmbedGraceMs,
  meaningEmbedLimitMs,
  meaningMaxStalled,
  meaningMaxWindows,
  meaningNightLeastMs,
  meaningNightStopMs,
  meaningRestartReserveMs,
  meaningSmallChunks,
  meaningStepLimitMs,
  meaningWindowMs,
} from "../src/brain/meaning";
import { meaningPaths, meaningUnit } from "../src/brain/meaning-pin";
import { nightStartsIn } from "../src/brain/night";
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
    /** What each window of `gbrain embed --stale` answers, in turn (the
     * last one repeats): its exit code and the counts of its JSON. Where
     * not given, one window computes every vector. */
    windows?: ReadonlyArray<
      Readonly<{
        exit: number;
        embedded?: number;
        failures?: number;
        remaining?: number;
        reason?: string;
      }>
    >;
    /** Buddy works from this question on (1 is the first). */
    busyFrom?: number;
    /** The window (1 is the first) that loses a page as stored. */
    losesPageIn?: number;
    /** The start of the server (1 is the first) that systemd reports as
     * failed though the server runs: an ambiguous start. */
    startFailsAt?: number;
    /** Buddy works for the first questions, up to this one. */
    busyUntil?: number;
    /** The night window the person chose. */
    night?: Readonly<{ start: string; end: string; timeZone: string }>;
    /** The pages the running server counts at the start (46 by default). */
    served?: number;
    /** How long each of gbrain's steps takes on the stand's clock (none by
     * default: the clock stands at 00:10 UTC). */
    stepMs?: number;
    /** How long stopping the server takes, and a copy of the brain. */
    stopMs?: number;
    copyMs?: number;
    /** After a start, the server answers health only this long later; each
     * question to it passes a minute. */
    bootMs?: number;
  }> = {},
) {
  let clock = Date.parse("2026-11-19T00:10:00Z");
  let startedAt = clock;
  const step = { ms: options.stepMs ?? 0 };
  /** Each copy of the brain: when it began and its limit. */
  const copies: Array<Readonly<{ at: number; limit: number }>> = [];
  /** When the server was started, on the stand's clock. */
  const startTimes: number[] = [];
  /** Each gbrain step's limit, and when it started, on the stand's clock. */
  const limits: Array<Readonly<{ step: string; at: number; limit: number }>> =
    [];
  let starts = 0;
  /** The attempt as recorded at each start of the server: what a run that
   * died right then would leave for the next. */
  const atStart: unknown[] = [];
  let windowsRun = 0;
  let idleAsked = 0;
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
    // The stand's clock (00:10 UTC) inside the night window unless a test
    // gives another, so its windows run; the day is tested on its own.
    night: options.night ?? { start: "00:00", end: "23:00", timeZone: "UTC" },
  });
  // `stored`: the pages as stored; `served`: what the running server
  // counts, where pages written while it runs count too.
  const world = {
    server: true,
    timer: true,
    model: false,
    stored: options.served ?? 46,
    served: options.served ?? 46,
  };
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
      if (name === brainUnit && (verb === "stop" || verb === "disable")) {
        if (world.server) clock += options.stopMs ?? 0;
        world.server = false;
      }
      if (name === brainUnit && verb === "start") {
        startedAt = clock;
        startTimes.push(clock);
        atStart.push((await readBrainState(paths)).meaningAttempt);
        world.server = true;
        starts += 1;
        // The server runs, and may take writes, though systemd says no.
        if (starts === options.startFailsAt) return done(1);
      }
      if (name.endsWith(".timer") && verb === "stop") world.timer = false;
      if (name.endsWith(".timer") && verb === "start") world.timer = true;
    }
    return done(0);
  };
  const envs: Readonly<Record<string, string>>[] = [];
  const run: ToolRunner = async (argv, timeout, env) => {
    calls.push([...argv]);
    limits.push({ step: argv[1] ?? "", at: clock, limit: timeout });
    clock += step.ms;
    if (argv[1] === "embed") envs.push(env);
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
    // The pages as stored: gbrain's CLI reads them only while the server is
    // stopped (it holds the lock otherwise).
    if (argv[1] === "stats")
      return world.server
        ? { ...ok, exitCode: 1, stdout: '{"code":"pglite_busy"}' }
        : { ...ok, stdout: JSON.stringify({ page_count: world.stored }) };
    if (argv[1] === "embed") {
      if (options.embedFails) {
        await writeFile(
          join(paths.brain, "config.json"),
          '{"brain":"vectors"}',
        );
        return { ...ok, exitCode: 1 };
      }
      const windows = options.windows ?? [{ exit: 0, embedded: 46 }];
      const answer =
        windows[Math.min(windowsRun, windows.length - 1)] ?? windows[0];
      windowsRun += 1;
      if (options.losesPageIn === windowsRun) world.stored -= 1;
      // Each window keeps the vectors it computed.
      await writeFile(
        join(paths.brain, "config.json"),
        JSON.stringify({ brain: "vectors", windows: windowsRun }),
      );
      return {
        exitCode: answer?.exit ?? 0,
        stdout: JSON.stringify({
          embedded: answer?.embedded ?? 0,
          failures: answer?.failures ?? 0,
          ...(answer?.remaining === undefined
            ? {}
            : { remaining_stale: answer.remaining }),
          ...(answer?.reason === undefined ? {} : { reason: answer.reason }),
        }),
        stderr: "",
      };
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
    if (pathname === "/health" && options.bootMs !== undefined) {
      const booting = clock < startedAt + options.bootMs;
      clock += 60_000;
      if (booting) return null;
    }
    if (pathname === "/health")
      return {
        status: 200,
        body: JSON.stringify({ status: "ok", version: brainPin.version }),
      };
    if (pathname === "/mcp" && method === "POST")
      return {
        status: 200,
        body: JSON.stringify({
          result: {
            content: [{ text: JSON.stringify({ page_count: world.served }) }],
          },
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
    idle: async () => {
      idleAsked += 1;
      if (options.busyFrom !== undefined && idleAsked >= options.busyFrom)
        return false;
      if (options.busyUntil !== undefined && idleAsked <= options.busyUntil)
        return false;
      return options.idle ?? true;
    },
    now: () => new Date(clock),
    // The copy takes `copyMs` on the stand's clock (none by default); one
    // longer than its limit is ended there, half made.
    copyBrain: async (from: string, to: string, limitMs: number) => {
      copies.push({ at: clock, limit: limitMs });
      const takes = options.copyMs ?? 0;
      if (takes > limitMs) {
        clock += limitMs;
        await mkdir(to, { recursive: true });
        await writeFile(join(to, "partial"), "x");
        return false;
      }
      clock += takes;
      await cp(from, to, { recursive: true, errorOnExist: true });
      return true;
    },
    tries: options.bootMs === undefined ? 2 : 1000,
    waitMs: 1,
    fetch: async () => new Response("never asked", { status: 500 }),
  };
  const time = {
    now: () => clock,
    advance: (ms: number) => {
      clock += ms;
    },
  };
  return {
    host,
    paths,
    calls,
    world,
    command,
    envs,
    atStart,
    limits,
    step,
    time,
    copies,
    startTimes,
  };
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
      "embed --stale --json",
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
      "embed --stale --json",
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
    expect(await convergeMeaning(slow)).toBe("restored:embed-limit");
    // In the night window: the hour's stop less what it keeps for the start.
    expect(limit).toBe(meaningNightStopMs - meaningRestartReserveMs);
    expect(await readFile(join(paths.brain, "config.json"), "utf8")).toBe(
      '{"brain":"before"}',
    );
    expect(world.server).toBe(true);
    // Setup as the Launchpad's child outlasts the one window a run takes, at
    // its process limit, and a migration, the counts and the start around it.
    expect(setupTimeoutMs).toBeGreaterThan(
      meaningNightStopMs + 6 * meaningStepLimitMs,
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

describe("the vectors in short windows, the server running with the model between them", () => {
  const stops = (calls: string[][]) =>
    calls.filter((c) => c[2] === "stop" && c[3] === brainUnit).length;

  test("a window gbrain stops at its budget leaves the rest to the next runs, one window each; each keeps the server stopped for one budget only", async () => {
    const { host, paths, calls, world, envs } = await stand({
      windows: [
        { exit: 11, embedded: 10, remaining: 30, reason: "time_budget" },
        { exit: 11, embedded: 20, remaining: 10, reason: "time_budget" },
        { exit: 0, embedded: 10 },
      ],
    });
    // One window per run, so a run stays short and the Launchpad hands the
    // brain to Executor after the first; it runs setup again after a pause.
    expect(await convergeMeaning(host)).toBe("waits:filling");
    expect(world.server && world.timer).toBe(true);
    expect(await convergeMeaning(host)).toBe("waits:filling");
    expect(await convergeMeaning(host)).toBe("on");
    // Three windows, each its own stop of the server.
    expect(calls.filter((c) => c[1] === "embed")).toHaveLength(3);
    expect(stops(calls)).toBe(3);
    // Each window is bounded by gbrain's budget, and a batch to the local
    // model has longer than gbrain's 60 s.
    for (const env of envs) {
      // In the night window, an hour's stop (the window ends far later):
      // its budget leaves a batch, gbrain's start and the server's.
      expect(env.GBRAIN_EMBED_TIME_BUDGET_MS).toBe(
        String(
          meaningNightStopMs -
            meaningRestartReserveMs -
            meaningBatchLimitMs -
            meaningEmbedGraceMs,
        ),
      );
      expect(env.GBRAIN_AI_EMBED_TIMEOUT_MS).toBe(String(meaningBatchLimitMs));
    }
    // A short window by day: its 3 minutes, a batch and the rest within the
    // day's bound of the whole stop.
    expect(embedPlan(meaningDayStopMs, meaningWindowMs)).toEqual({
      budgetMs: meaningWindowMs,
      limitMs: meaningEmbedLimitMs,
    });
    expect(meaningEmbedLimitMs + meaningRestartReserveMs).toBeLessThanOrEqual(
      meaningDayStopMs,
    );
    // After the first window the server runs with the model.
    expect(await unit(paths, brainUnit)).toContain(
      "Environment=LLAMA_SERVER_BASE_URL=http://127.0.0.1:3132/v1",
    );
    expect(world.server && world.timer).toBe(true);
    const state = await readBrainState(paths);
    expect(state.meaning?.provider).toBe("llama-server:bge-m3");
    expect(state.meaningAttempt).toBeUndefined();
    // The copy before the first window stays; each window's own goes.
    expect(
      await readFile(
        join(paths.home, ".gbrain.bak-meaning-20261119T001000Z", "config.json"),
        "utf8",
      ),
    ).toBe('{"brain":"before"}');
    await expect(
      readFile(join(paths.home, ".gbrain.bak-meaning-window", "config.json")),
    ).rejects.toThrow();
  });

  test("while Buddy works between windows the server keeps running with the model; the next idle run goes on", async () => {
    const { host, paths, calls, world } = await stand({
      windows: [
        { exit: 11, embedded: 10, remaining: 30, reason: "time_budget" },
        { exit: 0, embedded: 30 },
      ],
      // The question before the first window is the first; Buddy works at
      // the next one, before the second window.
      busyFrom: 2,
    });
    expect(await convergeMeaning(host)).toBe("waits:filling");
    // Buddy works: the next run does not stop the server.
    expect(await convergeMeaning(host)).toBe("waits:filling");
    expect(world.server && world.timer).toBe(true);
    expect(stops(calls)).toBe(1);
    expect((await readBrainState(paths)).meaningAttempt).toMatchObject({
      result: "filling",
      windows: 1,
      stalled: 0,
      remaining: 30,
    });
    expect(await unit(paths, brainUnit)).toContain("LLAMA_SERVER_BASE_URL");
    // Buddy idle again: the next run computes the rest.
    const idle = { ...host, idle: async () => true };
    expect(await convergeMeaning(idle)).toBe("on");
    expect(stops(calls)).toBe(2);
  });

  test("a window that fails brings its own copy back, with the model; windows in a row without progress stop the filling, the vectors kept", async () => {
    const { host, paths, world } = await stand({
      windows: [
        { exit: 11, embedded: 10, remaining: 30, reason: "time_budget" },
        { exit: 1, embedded: 0, failures: 3 },
      ],
    });
    expect(await convergeMeaning(host)).toBe("waits:filling");
    expect(await convergeMeaning(host)).toBe("waits:embed-failures");
    // The brain of the first window is back (its vectors kept), and the
    // server runs with the model.
    expect(
      JSON.parse(await readFile(join(paths.brain, "config.json"), "utf8")),
    ).toEqual({ brain: "vectors", windows: 1 });
    expect(world.server && world.timer).toBe(true);
    expect(await unit(paths, brainUnit)).toContain("LLAMA_SERVER_BASE_URL");
    expect((await readBrainState(paths)).meaningAttempt).toMatchObject({
      result: "filling",
      stalled: 1,
    });
    // The next failure in a row stops it for this pin.
    expect(meaningMaxStalled).toBe(2);
    expect(await convergeMeaning(host)).toBe("restored:embed-failures");
    expect(await convergeMeaning(host)).toBe("held");
    expect(await unit(paths, brainUnit)).toContain("LLAMA_SERVER_BASE_URL");
    expect(world.server).toBe(true);
  });

  test("a run that died in a window: its copy comes back with the model, and the filling goes on", async () => {
    const { host, paths, world } = await stand({
      windows: [
        { exit: 11, embedded: 10, remaining: 30, reason: "time_budget" },
      ],
      busyFrom: 2,
    });
    expect(await convergeMeaning(host)).toBe("waits:filling");
    // What a run leaves when it dies inside a window: the window's copy,
    // the server stopped and gbrain's half-written vectors.
    const window = join(paths.home, ".gbrain.bak-meaning-window");
    await mkdir(window, { recursive: true });
    await writeFile(join(window, "config.json"), '{"brain":"window"}');
    const state = await readBrainState(paths);
    await writeBrainState(paths, {
      ...state,
      meaningAttempt: {
        ...(state.meaningAttempt as NonNullable<typeof state.meaningAttempt>),
        result: "started",
        phase: "filling",
        windowBackup: ".gbrain.bak-meaning-window",
      },
    });
    await writeFile(join(paths.brain, "config.json"), '{"brain":"torn"}');
    world.server = false;
    expect(await convergeMeaning(host)).toBe("waits:interrupted");
    expect(await readFile(join(paths.brain, "config.json"), "utf8")).toBe(
      '{"brain":"window"}',
    );
    expect(world.server).toBe(true);
    expect(await unit(paths, brainUnit)).toContain("LLAMA_SERVER_BASE_URL");
    expect((await readBrainState(paths)).meaningAttempt?.result).toBe(
      "filling",
    );
  });

  test("a page written while the server runs between windows is never taken for a loss", async () => {
    const { host, paths, world } = await stand({
      windows: [
        { exit: 11, embedded: 10, remaining: 30, reason: "time_budget" },
        { exit: 0, embedded: 30 },
      ],
    });
    expect(await convergeMeaning(host)).toBe("waits:filling");
    // Agents write pages while the server runs; the counts compared are the
    // stored ones, read with the server stopped, before and after a window.
    world.served = 48;
    world.stored = 48;
    expect(await convergeMeaning(host)).toBe("on");
    expect(
      JSON.parse(await readFile(join(paths.brain, "config.json"), "utf8")),
    ).toEqual({ brain: "vectors", windows: 2 });
  });

  test("a window that loses a page as stored brings its copy back, with the model", async () => {
    const { host, paths, world } = await stand({
      windows: [
        { exit: 11, embedded: 10, remaining: 30, reason: "time_budget" },
        { exit: 11, embedded: 10, remaining: 20, reason: "time_budget" },
      ],
      losesPageIn: 2,
    });
    expect(await convergeMeaning(host)).toBe("waits:filling");
    expect(await convergeMeaning(host)).toBe("waits:page-count");
    expect(
      JSON.parse(await readFile(join(paths.brain, "config.json"), "utf8")),
    ).toEqual({ brain: "vectors", windows: 1 });
    expect(world.server).toBe(true);
    expect(await unit(paths, brainUnit)).toContain("LLAMA_SERVER_BASE_URL");
  });

  test("a run that died after its window was committed: no copy comes back over pages written since; the next run goes on", async () => {
    const { host, paths, world } = await stand({
      windows: [
        { exit: 11, embedded: 10, remaining: 30, reason: "time_budget" },
        { exit: 0, embedded: 30 },
      ],
    });
    expect(await convergeMeaning(host)).toBe("waits:filling");
    // What a run leaves when it dies after the commit: the attempt back at
    // `filling`, its window's copy still there, the server taking writes.
    const window = join(paths.home, ".gbrain.bak-meaning-window");
    await mkdir(window, { recursive: true });
    await writeFile(join(window, "config.json"), '{"brain":"window"}');
    await writeFile(join(paths.brain, "config.json"), '{"brain":"written"}');
    expect(await convergeMeaning(host)).toBe("on");
    // The window's old copy went; what was written stayed under the vectors.
    expect(
      JSON.parse(await readFile(join(paths.brain, "config.json"), "utf8")),
    ).toEqual({ brain: "vectors", windows: 2 });
    await expect(readFile(join(window, "config.json"))).rejects.toThrow();
    expect(world.server).toBe(true);
  });

  test("each window is committed before the server starts: a run that died at the start leaves nothing a next run would bring back over writes", async () => {
    const { host, paths, atStart } = await stand({
      windows: [
        { exit: 11, embedded: 10, remaining: 30, reason: "time_budget" },
        { exit: 11, embedded: 10, remaining: 20, reason: "time_budget" },
        { exit: 0, embedded: 20 },
      ],
    });
    expect(await convergeMeaning(host)).toBe("waits:filling");
    expect(await convergeMeaning(host)).toBe("waits:filling");
    expect(await convergeMeaning(host)).toBe("on");
    // At every start after a window, the attempt already reads `filling`
    // with no window in progress (no phase, no copy to bring back), so a run
    // that died there is not recovered by a copy over pages written since.
    expect(atStart).toHaveLength(3);
    for (const attempt of atStart)
      expect(attempt).toMatchObject({ result: "filling" });
    for (const attempt of atStart)
      expect((attempt as { phase?: string }).phase).toBeUndefined();
    // And such a run's next is an ordinary window over what is there.
    const state = await readBrainState(paths);
    expect(state.meaning?.provider).toBe("llama-server:bge-m3");
  });

  test("after too many windows in all the filling stops for a person, the vectors kept", async () => {
    const { host, paths, world } = await stand({
      windows: [
        { exit: 11, embedded: 10, remaining: 30, reason: "time_budget" },
      ],
    });
    expect(await convergeMeaning(host)).toBe("waits:filling");
    const state = await readBrainState(paths);
    await writeBrainState(paths, {
      ...state,
      meaningAttempt: {
        ...(state.meaningAttempt as NonNullable<typeof state.meaningAttempt>),
        windows: meaningMaxWindows,
      },
    });
    expect(await convergeMeaning(host)).toBe("restored:embed-windows");
    expect(await convergeMeaning(host)).toBe("held");
    expect(world.server).toBe(true);
    expect(await unit(paths, brainUnit)).toContain("LLAMA_SERVER_BASE_URL");
  });

  test("a start systemd reports as failed after a committed window, though the server runs: the brain is kept, never a copy back", async () => {
    const { host, paths, world } = await stand({
      windows: [
        { exit: 11, embedded: 10, remaining: 30, reason: "time_budget" },
        { exit: 11, embedded: 10, remaining: 20, reason: "time_budget" },
        { exit: 0, embedded: 20 },
      ],
      // The first window's start, then the second's is ambiguous.
      startFailsAt: 2,
    });
    expect(await convergeMeaning(host)).toBe("waits:filling");
    expect(await convergeMeaning(host)).toBe("waits:start");
    // The second window's brain stays, not the copy before it.
    expect(
      JSON.parse(await readFile(join(paths.brain, "config.json"), "utf8")),
    ).toEqual({ brain: "vectors", windows: 2 });
    expect((await readBrainState(paths)).meaningAttempt).toMatchObject({
      result: "filling",
      reason: "start",
    });
    expect(world.server).toBe(true);
    // The server took a write; the next run goes on over it.
    await writeFile(
      join(paths.brain, "config.json"),
      JSON.stringify({ brain: "written" }),
    );
    expect(await convergeMeaning(host)).toBe("on");
    expect(
      JSON.parse(await readFile(join(paths.brain, "config.json"), "utf8")),
    ).toEqual({ brain: "vectors", windows: 3 });
  });

  test("a way back is committed before the server starts: a run that died then is not rolled back again over a write", async () => {
    // A window that fails: its copy comes back, and at the server's start
    // the attempt already reads `filling` with no window in progress.
    const window = await stand({
      windows: [
        { exit: 11, embedded: 10, remaining: 30, reason: "time_budget" },
        { exit: 1, embedded: 0, failures: 3 },
        { exit: 0, embedded: 30 },
      ],
    });
    expect(await convergeMeaning(window.host)).toBe("waits:filling");
    expect(await convergeMeaning(window.host)).toBe("waits:embed-failures");
    const last = window.atStart.at(-1) as { result?: string; phase?: string };
    expect(last.result).toBe("filling");
    expect(last.phase).toBeUndefined();
    // Had the run died there, the server would have taken a write; the next
    // run computes over it, never a copy back.
    await writeFile(
      join(window.paths.brain, "config.json"),
      JSON.stringify({ brain: "written" }),
    );
    expect(await convergeMeaning(window.host)).toBe("on");
    expect(
      JSON.parse(
        await readFile(join(window.paths.brain, "config.json"), "utf8"),
      ),
    ).toEqual({ brain: "vectors", windows: 3 });
    // The first window's way back (the copy before, without the model) too:
    // `restored` at the server's start, so a later run never restores again.
    const first = await stand({ embedFails: true });
    expect(await convergeMeaning(first.host)).toBe("restored:embed");
    expect(first.atStart.at(-1)).toMatchObject({ result: "restored" });
  });

  test("failures now and then over many windows keep one failed brain only", async () => {
    const { host, paths } = await stand({
      windows: [
        { exit: 11, embedded: 10, remaining: 60, reason: "time_budget" },
        { exit: 1, embedded: 0, failures: 2 },
        { exit: 11, embedded: 10, remaining: 50, reason: "time_budget" },
        { exit: 1, embedded: 0, failures: 2 },
        { exit: 11, embedded: 10, remaining: 40, reason: "time_budget" },
        { exit: 1, embedded: 0, failures: 2 },
        { exit: 0, embedded: 40 },
      ],
    });
    const results: string[] = [];
    for (let i = 0; i < 7; i++) results.push(await convergeMeaning(host));
    expect(results.at(-1)).toBe("on");
    // Each failure came after a window that progressed: never two in a row.
    expect(results.filter((r) => r === "waits:embed-failures")).toHaveLength(3);
    const failed = (await readdir(paths.home)).filter((name) =>
      name.startsWith(".gbrain.failed-meaning"),
    );
    expect(failed).toEqual([".gbrain.failed-meaning-window"]);
  });
});

describe("the Launchpad goes on by itself while search by meaning waits", () => {
  /** The Launchpad's start against the stand: each run a setup's meaning,
   * the pause counted, not waited. */
  const atStart = (host: Parameters<typeof convergeMeaning>[0]) => {
    const pauses: number[] = [];
    let runs = 0;
    return {
      pauses,
      runs: () => runs,
      start: () =>
        brainSetupAtStart({
          run: async () => {
            runs += 1;
            return { server: "running", meaning: await convergeMeaning(host) };
          },
          handover: async () => true,
          signal: new AbortController().signal,
          sleep: async (ms) => {
            pauses.push(ms);
          },
        }),
    };
  };

  test("Buddy busy before the first window: the next runs try again and switch it on", async () => {
    const { host } = await stand({ busyUntil: 2 });
    const start = atStart(host);
    expect(await start.start()).toEqual({ server: "running", meaning: "on" });
    expect(start.runs()).toBe(3);
  });

  test("windows that fail are tried again until two in a row stop the filling", async () => {
    const { host } = await stand({
      windows: [
        { exit: 11, embedded: 10, remaining: 30, reason: "time_budget" },
        { exit: 1, embedded: 0, failures: 3 },
      ],
    });
    const start = atStart(host);
    expect(await start.start()).toEqual({
      server: "running",
      meaning: "restored:embed-failures",
    });
    // The first window, then two that failed; then nothing more.
    expect(start.runs()).toBe(3);
  });
});

describe("by day the memory is not stopped for search by meaning, except a small backlog", () => {
  /** A night window the stand's clock (00:10 UTC) is outside of. */
  const night = { start: "02:00", end: "05:00", timeZone: "UTC" };
  const stops = (calls: string[][]) =>
    calls.filter((c) => c[2] === "stop" && c[3] === brainUnit).length;

  test("a brain larger than a small backlog waits for the night: nothing stops, nothing is copied", async () => {
    const { host, paths, calls, world } = await stand({ night });
    expect(await convergeMeaning(host)).toBe("waits:night");
    expect(stops(calls)).toBe(0);
    expect(calls.some((c) => c[1] === "embed" || c[1] === "embeddings")).toBe(
      false,
    );
    expect(world.server).toBe(true);
    expect((await readBrainState(paths)).meaningAttempt).toBeUndefined();
  });

  test("a small brain (a new Environment's) is switched on at once, in one short window", async () => {
    const { host, calls, envs } = await stand({ night, served: 3 });
    expect(await convergeMeaning(host)).toBe("on");
    expect(stops(calls)).toBe(1);
    expect(envs[0]?.GBRAIN_EMBED_TIME_BUDGET_MS).toBe(String(meaningWindowMs));
  });

  test("what is left after the night: a small rest is computed by day, a larger one waits for the next night", async () => {
    // The first window in the night: a large rest left.
    const large = await stand({
      windows: [
        { exit: 11, embedded: 10, remaining: 300, reason: "time_budget" },
        { exit: 0, embedded: 300 },
      ],
    });
    expect(await convergeMeaning(large.host)).toBe("waits:filling");
    // Then the day comes.
    await writeBrainState(large.paths, {
      ...(await readBrainState(large.paths)),
      night,
    });
    expect(await convergeMeaning(large.host)).toBe("waits:night");
    expect(stops(large.calls)).toBe(1);
    // A rest one short window computes, by day.
    const small = await stand({
      windows: [
        {
          exit: 11,
          embedded: 10,
          remaining: meaningSmallChunks,
          reason: "time_budget",
        },
        { exit: 0, embedded: meaningSmallChunks },
      ],
    });
    expect(await convergeMeaning(small.host)).toBe("waits:filling");
    await writeBrainState(small.paths, {
      ...(await readBrainState(small.paths)),
      night,
    });
    expect(await convergeMeaning(small.host)).toBe("on");
    expect(small.envs.at(-1)?.GBRAIN_EMBED_TIME_BUDGET_MS).toBe(
      String(meaningWindowMs),
    );
  });

  /** The Launchpad's wait for the night over the stand: the window's start
   * comes `startsIn` after the first run, unless `moved` brings it forward
   * after that many sleeps; the run at the start finds the night. */
  const waitForNight = async (startsIn: number, moved?: number) => {
    const { host } = await stand({ night });
    const pauses: number[] = [];
    let left = startsIn;
    let runs = 0;
    const labels = await brainSetupAtStart({
      run: async () => {
        runs += 1;
        if (runs === 2)
          await writeBrainState(host.paths, {
            ...(await readBrainState(host.paths)),
            night: { start: "00:00", end: "23:00", timeZone: "UTC" },
          });
        return { server: "running", meaning: await convergeMeaning(host) };
      },
      handover: async () => true,
      signal: new AbortController().signal,
      nightInMs: async () => Math.max(0, left),
      sleep: async (ms) => {
        pauses.push(ms);
        left -= ms;
        // The person moves the window to start now (`lazurio brain night`).
        if (pauses.length === moved) left = 0;
      },
    });
    return { labels, pauses, runs };
  };

  test("the Launchpad waits for the night window, not every pause, and computes then", async () => {
    const { labels, pauses, runs } = await waitForNight(110 * 60_000);
    expect(labels).toEqual({ server: "running", meaning: "on" });
    // Until the window's start, read again every `nightRecheckMs`; one run
    // after the first, at the start, switched it on.
    expect(pauses).toEqual([...Array(11).fill(nightRecheckMs)]);
    expect(runs).toBe(2);
  });

  test("a window the person moves while the Launchpad waits counts at the next reading, not the next night", async () => {
    const { labels, pauses, runs } = await waitForNight(20 * 3_600_000, 1);
    expect(labels).toEqual({ server: "running", meaning: "on" });
    expect(pauses).toEqual([nightRecheckMs]);
    expect(runs).toBe(2);
  });
});

describe("a stop is bounded as a whole: its steps, its embedding and the start after it", () => {
  const minute = 60_000;
  /** The stand's clock at the start. */
  const t0 = Date.parse("2026-11-19T00:10:00Z");
  const budgetOf = (env: Readonly<Record<string, string>> | undefined) =>
    Number(env?.GBRAIN_EMBED_TIME_BUDGET_MS);

  test("a night stop ends by the window's end, the time its steps took counted", async () => {
    // The window ends 50 minutes after the clock; each step takes 2 minutes.
    const { host, limits, envs } = await stand({
      night: { start: "00:00", end: "01:00", timeZone: "UTC" },
      stepMs: 2 * minute,
    });
    expect(await convergeMeaning(host)).toBe("on");
    const end = t0 + 50 * minute;
    const embed = limits.find((l) => l.step === "embed");
    // The count and the switch took 4 minutes: the embedding's limit leaves
    // the start after it before the window's end, and its budget a batch
    // and gbrain's own start within that limit.
    expect(embed?.at).toBe(t0 + 4 * minute);
    expect(
      (embed?.at ?? 0) + (embed?.limit ?? 0) + meaningRestartReserveMs,
    ).toBe(end);
    expect(budgetOf(envs[0])).toBe(
      (embed?.limit ?? 0) - meaningBatchLimitMs - meaningEmbedGraceMs,
    );
    // No step of the stop may run past the window's end.
    for (const l of limits) expect(l.at + l.limit).toBeLessThanOrEqual(end);
  });

  test("near the window's end a large backlog waits; a small one gets the day's bound for the whole stop, not three fresh minutes", async () => {
    // 15 minutes of the window left: less than a night stop needs.
    const night = { start: "23:45", end: "00:25", timeZone: "UTC" };
    expect(15 * minute).toBeLessThan(meaningNightLeastMs);
    const large = await stand({ night });
    expect(await convergeMeaning(large.host)).toBe("waits:night");
    expect(large.limits.some((l) => l.step === "embed")).toBe(false);
    // A small brain: the day's exception, its whole stop within the day's
    // bound, and the minutes its steps took come off its budget.
    const small = await stand({ night, served: 3, stepMs: minute });
    expect(await convergeMeaning(small.host)).toBe("on");
    const embed = small.limits.find((l) => l.step === "embed");
    expect(
      (embed?.at ?? 0) + (embed?.limit ?? 0) + meaningRestartReserveMs,
    ).toBe(t0 + meaningDayStopMs);
    expect(budgetOf(small.envs[0])).toBe(minute);
    for (const l of small.limits)
      expect(l.at + l.limit).toBeLessThanOrEqual(t0 + meaningDayStopMs);
  });

  test("a first window its steps left no time for brings its copy back and is tried again: no failure of the model", async () => {
    // 20 minutes left; the count and the switch take 10 of them.
    const night = { start: "23:50", end: "00:30", timeZone: "UTC" };
    const { host, paths, limits } = await stand({ night, stepMs: 5 * minute });
    expect(await convergeMeaning(host)).toBe("waits:no-time");
    expect(limits.some((l) => l.step === "embed")).toBe(false);
    expect(await readFile(join(paths.brain, "config.json"), "utf8")).toBe(
      '{"brain":"before"}',
    );
    // Not held for the pin: the next run decides again (here the window has
    // too little left, so it waits for the night).
    expect(await convergeMeaning(host)).toBe("waits:night");
  });

  test("a later window its steps left no time for counts neither as a window nor as one without progress", async () => {
    const { host, paths, limits, step } = await stand({
      windows: [
        { exit: 11, embedded: 10, remaining: 300, reason: "time_budget" },
        { exit: 0, embedded: 300 },
      ],
    });
    expect(await convergeMeaning(host)).toBe("waits:filling");
    // 20 minutes of the window left, and the count takes 5 more than a
    // window then has for its embedding.
    await writeBrainState(paths, {
      ...(await readBrainState(paths)),
      night: { start: "23:50", end: "00:30", timeZone: "UTC" },
    });
    step.ms = 9 * minute;
    expect(await convergeMeaning(host)).toBe("waits:no-time");
    expect(limits.filter((l) => l.step === "embed")).toHaveLength(1);
    const attempt = (await readBrainState(paths)).meaningAttempt;
    expect(attempt?.result).toBe("filling");
    expect(attempt?.windows).toBe(1);
    expect(attempt?.stalled).toBe(0);
  });

  test("a slow stop leaves no time for a window: the server comes back as it was, and no copy stays", async () => {
    // An hour's stop, and stopping the server takes 50 minutes of it.
    const { host, paths, world, limits } = await stand({ stopMs: 50 * minute });
    expect(await convergeMeaning(host)).toBe("waits:no-time");
    expect(
      limits.some((l) => l.step === "embed" || l.step === "embeddings"),
    ).toBe(false);
    expect(world.server).toBe(true);
    expect(
      (await readdir(paths.home)).filter((n) =>
        n.startsWith(".gbrain.bak-meaning-"),
      ),
    ).toEqual([]);
    expect((await readBrainState(paths)).meaningAttempt).toBeUndefined();
  });

  test("a slow copy comes off the embedding's time; the way back needs none, it is a rename", async () => {
    const { host, limits } = await stand({ copyMs: 5 * minute });
    expect(await convergeMeaning(host)).toBe("on");
    const embed = limits.find((l) => l.step === "embed");
    expect(embed?.at).toBe(t0 + 5 * minute);
    expect(
      (embed?.at ?? 0) + (embed?.limit ?? 0) + meaningRestartReserveMs,
    ).toBe(t0 + meaningNightStopMs);
  });

  for (const [what, copyMs] of [
    ["longer than the whole stop (61 minutes)", 61 * minute],
    ["that never finishes", Number.POSITIVE_INFINITY],
  ] as const) {
    test(`a copy ${what} is ended in time: the server is back before the stop's end, the brain as it was`, async () => {
      const { host, paths, world, copies, startTimes, limits } = await stand({
        copyMs,
      });
      expect(await convergeMeaning(host)).toBe("waits:no-time");
      // The copy's limit leaves a window's least and the start; it was ended
      // there, its half copy removed, nothing of gbrain run.
      expect(copies).toHaveLength(1);
      expect((copies[0]?.at ?? 0) + (copies[0]?.limit ?? 0)).toBe(
        t0 +
          meaningNightStopMs -
          meaningRestartReserveMs -
          meaningBatchLimitMs -
          meaningEmbedGraceMs -
          minute,
      );
      expect(
        (await readdir(paths.home)).filter((n) =>
          n.startsWith(".gbrain.bak-meaning-"),
        ),
      ).toEqual([]);
      expect(limits).toEqual([]);
      expect(world.server).toBe(true);
      expect(startTimes.at(-1) ?? 0).toBeLessThanOrEqual(
        t0 + meaningNightStopMs,
      );
      expect(await readFile(join(paths.brain, "config.json"), "utf8")).toBe(
        '{"brain":"before"}',
      );
    });
  }

  test("a window that fails at its limit comes back by a rename and starts before the stop's end", async () => {
    // The copy takes 5 minutes; the embedding runs to its very limit.
    const { host, paths, copies, startTimes, time } = await stand({
      copyMs: 5 * minute,
    });
    const run = host.run;
    const slow = {
      ...host,
      run: async (
        argv: readonly string[],
        timeout: number,
        env: Readonly<Record<string, string>>,
      ) => {
        if (argv[1] !== "embed") return run(argv, timeout, env);
        await writeFile(join(paths.brain, "config.json"), '{"brain":"half"}');
        time.advance(timeout);
        return "timeout" as const;
      },
    } as typeof host;
    expect(await convergeMeaning(slow)).toBe("restored:embed-limit");
    // One copy only: the way back renamed it into place.
    expect(copies).toHaveLength(1);
    expect(await readFile(join(paths.brain, "config.json"), "utf8")).toBe(
      '{"brain":"before"}',
    );
    expect(startTimes.at(-1) ?? 0).toBeLessThanOrEqual(t0 + meaningNightStopMs);
  });

  test("a server slow to answer after a committed window: the wait ends with the stop, the server is not kept down, the next run goes on", async () => {
    const { host, world, time, paths } = await stand({
      bootMs: 3 * 3_600_000,
    });
    expect(await convergeMeaning(host)).toBe("waits:no-answer");
    // Asked once a minute up to the stop's end, an hour after it began.
    expect(time.now()).toBeLessThanOrEqual(t0 + meaningNightStopMs + minute);
    expect(world.server).toBe(true);
    expect((await readBrainState(paths)).meaningAttempt?.result).toBe(
      "filling",
    );
  });

  test("the Launchpad tries a window that had no time left again, in the same start", async () => {
    // The count and the switch take the whole hour of the first stop.
    const { host, step } = await stand({ stepMs: 30 * minute });
    const seen: string[] = [];
    const labels = await brainSetupAtStart({
      run: async () => {
        const meaning = await convergeMeaning(host);
        seen.push(meaning);
        return { server: "running", meaning };
      },
      handover: async () => true,
      signal: new AbortController().signal,
      sleep: async () => {
        step.ms = 0;
      },
    });
    expect(seen).toEqual(["waits:no-time", "on"]);
    expect(labels).toEqual({ server: "running", meaning: "on" });
  });

  test("a window of the shortest length a person may choose runs its stop at its start", async () => {
    const night = { start: "00:20", end: "00:50", timeZone: "UTC" };
    const { host, time } = await stand({ night });
    const seen: string[] = [];
    const labels = await brainSetupAtStart({
      run: async () => {
        const meaning = await convergeMeaning(host);
        seen.push(meaning);
        return { server: "running", meaning };
      },
      handover: async () => true,
      signal: new AbortController().signal,
      nightInMs: async () =>
        nightStartsIn(new Date(time.now()), night, meaningNightLeastMs),
      sleep: async (ms) => {
        time.advance(ms);
      },
    });
    expect(seen).toEqual(["waits:night", "on"]);
    expect(labels).toEqual({ server: "running", meaning: "on" });
    // It waited until the window's start, 10 minutes after the clock.
    expect(time.now()).toBe(t0 + 10 * minute);
  });
});
