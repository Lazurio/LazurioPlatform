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
import { brainSetupAtStart, setupTimeoutMs } from "../src/brain/at-start";
import { readBrainState, writeBrainState } from "../src/brain/keys";
import {
  convergeMeaning,
  downloadVerified,
  type MeaningHost,
  meaningBatchLimitMs,
  meaningEmbedLimitMs,
  meaningInstallEvery,
  meaningMaxStalled,
  meaningMaxWindows,
  meaningPreviewLimitMs,
  meaningStepLimitMs,
  meaningWindowMs,
  recoverAttempt,
  windowLabel,
  windowSince,
} from "../src/brain/meaning";
import {
  meaningPaths,
  meaningPin,
  meaningUnit,
  retriesFilling,
} from "../src/brain/meaning-pin";
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
        /** Pages stored without chunks it chunked. */
        healed?: number;
        /** What gbrain's preview after it says is left to embed
         * (`would_embed`; 0 where not given). */
        left?: number;
      }>
    >;
    /** Buddy works from this question on (1 is the first). */
    busyFrom?: number;
    /** The window (1 is the first) that loses a page as stored. */
    losesPageIn?: number;
    /** The start of the server (1 is the first) that systemd reports as
     * failed though the server runs: an ambiguous start. */
    startFailsAt?: number;
    /** The starts of the server (1 is the first) that fail for real: the
     * server stays down and never answers. */
    deadStarts?: readonly number[];
    /** Buddy works for the first questions, up to this one. */
    busyUntil?: number;
    /** What each window of the facts' vectors answers, in turn (the last
     * repeats); where not given, one window computes every fact. */
    facts?: ReadonlyArray<
      Readonly<{
        exit: number;
        embedded?: number;
        remaining?: number;
        /** Facts over the model's input limit, skipped (not in `remaining`). */
        refused?: number;
      }>
    >;
  }> = {},
) {
  let starts = 0;
  let factsRun = 0;
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
  });
  // `stored`: the pages as stored; `served`: what the running server
  // counts, where pages written while it runs count too.
  const world = {
    server: true,
    timer: true,
    model: false,
    stored: 46,
    served: 46,
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
      if (name === brainUnit && (verb === "stop" || verb === "disable"))
        world.server = false;
      if (name === brainUnit && verb === "start") {
        atStart.push((await readBrainState(paths)).meaningAttempt);
        starts += 1;
        if (options.deadStarts?.includes(starts)) return done(1);
        world.server = true;
        // The server runs, and may take writes, though systemd says no.
        if (starts === options.startFailsAt) return done(1);
      }
      if (name.endsWith(".timer") && verb === "stop") world.timer = false;
      if (name.endsWith(".timer") && verb === "start") world.timer = true;
    }
    return done(0);
  };
  const envs: Readonly<Record<string, string>>[] = [];
  const previews: { env: Readonly<Record<string, string>>; timeout: number }[] =
    [];
  const run: ToolRunner = async (argv, _timeout, env) => {
    calls.push([...argv]);
    // The facts' windows: their own answers, apart from the pages' windows.
    if (argv[1] === "embed" && argv.includes("--facts")) {
      const answers = options.facts ?? [{ exit: 0, embedded: 1, remaining: 0 }];
      const answer =
        answers[Math.min(factsRun, answers.length - 1)] ?? answers[0];
      factsRun += 1;
      return {
        exitCode: answer?.exit ?? 0,
        stdout: JSON.stringify({
          embedded: answer?.embedded ?? 0,
          remaining: answer?.remaining ?? 0,
          refused_oversized: answer?.refused ?? 0,
        }),
        stderr: "",
      };
    }
    // The windows' environments; the preview after a window has its own.
    if (argv[1] === "embed" && !argv.includes("--dry-run")) envs.push(env);
    if (argv[1] === "embed" && argv.includes("--dry-run"))
      previews.push({ env, timeout: _timeout });
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
    // gbrain's preview after a window that exited 0: what is left.
    if (argv[1] === "embed" && argv.includes("--dry-run")) {
      const windows = options.windows ?? [{ exit: 0, embedded: 46 }];
      const last =
        windows[Math.min(windowsRun - 1, windows.length - 1)] ?? windows[0];
      return {
        ...ok,
        stdout: JSON.stringify({ dryRun: true, would_embed: last?.left ?? 0 }),
      };
    }
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
          ...(answer?.healed === undefined
            ? {}
            : { chunkless_pages_healed: answer.healed }),
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
    now: () => new Date("2026-11-19T00:10:00Z"),
    tries: 2,
    waitMs: 1,
    fetch: async () => new Response("never asked", { status: 500 }),
  };
  return { host, paths, calls, world, command, envs, previews, atStart };
}

const unit = (paths: ReturnType<typeof brainPaths>, name: string) =>
  readFile(join(paths.units, name), "utf8");

describe("switching search by meaning on", () => {
  test("the model runs at a lower priority; the switch stops the server once, after a copy, and every vector is computed with it running", async () => {
    const { host: base, paths, calls, world } = await stand();
    // Whether the server ran at each embedding.
    const running: boolean[] = [];
    const host = {
      ...base,
      run: async (
        argv: readonly string[],
        timeout: number,
        env: Readonly<Record<string, string>>,
      ) => {
        if (argv[1] === "embed") running.push(world.server);
        return base.run(argv, timeout, env);
      },
    } as typeof base;
    expect(await convergeMeaning(host)).toBe("on");
    // The pages' window, gbrain's preview that nothing is left, then the
    // facts' window, all with the server running.
    expect(running).toEqual([true, true, true]);
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
    // with the server stopped, then every vector computed after the server
    // started again (gbrain hands the drain to it, `writer_embed_stale`).
    expect(model).toContain("-m ");
    expect(model).toContain("--pooling cls -c 4096");
    const gbrain = calls.filter(
      (c) => c[1] === "embeddings" || c[1] === "migrate" || c[1] === "embed",
    );
    expect(gbrain.map((c) => c.slice(1, 4))).toEqual([
      ["embeddings", "enable", "--embedding-model"],
      ["embed", "--stale", "--json"],
      // Exit 0 is not taken for "nothing left": gbrain's preview says so.
      ["embed", "--stale", "--dry-run"],
      // The facts follow, at no cost, for the source default.
      ["embed", "--stale", "--facts"],
    ]);
    // No repair stop for the facts: the switch recorded the database plane.
    expect((await readBrainState(paths)).meaningFacts).toMatchObject({
      windows: 1,
      remaining: 0,
    });
    expect((await readBrainState(paths)).meaningFacts?.plane).toBeDefined();
    expect((await readBrainState(paths)).meaningFacts?.done).toBeDefined();
    const embedded = calls.findIndex((c) => c[1] === "embed");
    const restarted =
      calls.length -
      1 -
      [...calls]
        .reverse()
        .findIndex((c) => c[2] === "start" && c[3] === brainUnit);
    expect(restarted).toBeLessThan(embedded);
    // One stop only, for the switch.
    expect(
      calls.filter((c) => c[2] === "stop" && c[3] === brainUnit),
    ).toHaveLength(1);
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
    // The switch and the pages' window (the facts' window follows apart).
    const gbrain = calls.filter(
      (c) =>
        (c[1] === "embeddings" || c[1] === "migrate" || c[1] === "embed") &&
        !c.includes("--facts") &&
        !c.includes("--dry-run"),
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
        .filter(
          (c) =>
            ["embeddings", "migrate", "embed"].includes(c[1] as string) &&
            !c.includes("--facts") &&
            !c.includes("--dry-run"),
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
        .filter(
          (c) =>
            ["embeddings", "migrate", "embed"].includes(c[1] as string) &&
            !c.includes("--facts") &&
            !c.includes("--dry-run"),
        )
        .map((c) => c.slice(1, 4).join(" ")),
    ).toEqual([
      "embeddings enable --embedding-model",
      "migrate embeddings --to",
      "embed --stale --json",
    ]);
  });

  test("an embedding that reaches its limit keeps what it computed and the server running; two in a row stop the filling", async () => {
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
    expect(await convergeMeaning(slow)).toBe("waits:embed-limit");
    expect(limit).toBe(meaningEmbedLimitMs);
    // Nothing comes back: the vectors it wrote stay, the server runs with the
    // model.
    expect(await readFile(join(paths.brain, "config.json"), "utf8")).toBe(
      '{"brain":"half"}',
    );
    expect(world.server).toBe(true);
    expect(await unit(paths, brainUnit)).toContain("LLAMA_SERVER_BASE_URL");
    expect(await convergeMeaning(slow)).toBe("held:embed-limit");
    expect(await convergeMeaning(slow)).toBe("held");
    // Setup as the Launchpad's child outlasts the one window a run takes, at
    // its process limit, and a migration, the counts and the start around it.
    expect(setupTimeoutMs).toBeGreaterThan(
      meaningEmbedLimitMs + 6 * meaningStepLimitMs,
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
    // An embedding that fails after the switch: the switch stays (the
    // server runs with the model, search by words as before), and two in a
    // row stop the filling for this pin.
    const { host, paths, world } = await stand({ embedFails: true });
    expect(await convergeMeaning(host)).toBe("waits:embed");
    expect(await unit(paths, brainUnit)).toContain("LLAMA_SERVER_BASE_URL");
    expect(world.server).toBe(true);
    expect(await convergeMeaning(host)).toBe("held:embed");
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

describe("the vectors in short windows, computed by the running server", () => {
  const stops = (calls: string[][]) =>
    calls.filter((c) => c[2] === "stop" && c[3] === brainUnit).length;

  test("exit 0 with pages left (gbrain's heal of chunkless pages stopped at its budget) is not done: the windows go on until gbrain's preview says nothing is left", async () => {
    const { host, paths, calls } = await stand({
      windows: [
        // The heal ran out of budget before any vector: no reason, exit 0.
        { exit: 0, embedded: 0, healed: 183, left: 1000 },
        { exit: 0, embedded: 40, healed: 0, left: 0 },
      ],
    });
    expect(await convergeMeaning(host)).toBe("waits:filling");
    const filling = (await readBrainState(paths)).meaningAttempt;
    expect(filling).toMatchObject({
      result: "filling",
      windows: 1,
      stalled: 0,
      remaining: 1000,
    });
    expect((await readBrainState(paths)).meaning).toBeUndefined();
    expect(await convergeMeaning(host)).toBe("on");
    expect((await readBrainState(paths)).meaning?.provider).toBe(
      "llama-server:bge-m3",
    );
    // Each window that exited 0 was checked by gbrain's preview.
    expect(
      calls.filter((c) => c[1] === "embed" && c.includes("--dry-run")),
    ).toHaveLength(2);
  });

  test("the preview cannot stop at its own budget: it gets a longer one than the limit it is ended at, and one that ends at that limit or answers no count is not done", async () => {
    // gbrain's dry run, like the run, stops between steps at its budget and
    // reports no budget stop (Lazurio/gbrain#3): a zero from a preview that
    // ran out of budget would be a zero without looking.
    const answered = await stand({ windows: [{ exit: 0, embedded: 46 }] });
    expect(await convergeMeaning(answered.host)).toBe("on");
    expect(answered.previews).toHaveLength(1);
    const [preview] = answered.previews;
    expect(preview?.timeout).toBe(meaningPreviewLimitMs);
    expect(Number(preview?.env.GBRAIN_EMBED_TIME_BUDGET_MS)).toBeGreaterThan(
      meaningPreviewLimitMs,
    );
    // A preview Lazurio ended at its limit, or that answered no count: the
    // window is not the last, and the filling goes on.
    for (const preview of ["timeout", "no-count"] as const) {
      const s = await stand({ windows: [{ exit: 0, embedded: 46 }] });
      const base = s.host.run;
      const host = {
        ...s.host,
        run: async (
          argv: readonly string[],
          timeout: number,
          env: Readonly<Record<string, string>>,
        ) => {
          if (argv[1] === "embed" && argv.includes("--dry-run")) {
            if (preview === "timeout") throw new Error("ended at its limit");
            return { exitCode: 0, stdout: '{"dryRun":true}', stderr: "" };
          }
          return base(argv, timeout, env);
        },
      } as typeof s.host;
      expect(await convergeMeaning(host)).toBe("waits:filling");
      expect((await readBrainState(s.paths)).meaning).toBeUndefined();
    }
  });

  test("a window gbrain stops at its budget leaves the rest to the next runs, one window each; no window stops the server", async () => {
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
    // Three windows, the server stopped once only: for the switch, before
    // the first.
    expect(
      calls.filter(
        (c) =>
          c[1] === "embed" &&
          !c.includes("--facts") &&
          !c.includes("--dry-run"),
      ),
    ).toHaveLength(3);
    expect(stops(calls)).toBe(1);
    // Each window is bounded by gbrain's budget, and a batch to the local
    // model has longer than gbrain's 60 s.
    // gbrain installs a page every few chunks, so a budget that stops it in
    // the middle of a page keeps what it computed (#1298).
    for (const env of envs) {
      expect(env.GBRAIN_EMBED_TIME_BUDGET_MS).toBe(String(meaningWindowMs));
      expect(env.GBRAIN_AI_EMBED_TIMEOUT_MS).toBe(String(meaningBatchLimitMs));
      expect(env.GBRAIN_EMBED_STALE_INSTALL_EVERY).toBe(
        String(meaningInstallEvery),
      );
    }
    expect(meaningEmbedLimitMs).toBeGreaterThan(
      meaningWindowMs + meaningBatchLimitMs,
    );
    // After the first window the server runs with the model.
    expect(await unit(paths, brainUnit)).toContain(
      "Environment=LLAMA_SERVER_BASE_URL=http://127.0.0.1:3132/v1",
    );
    expect(world.server && world.timer).toBe(true);
    const state = await readBrainState(paths);
    expect(state.meaning?.provider).toBe("llama-server:bge-m3");
    expect(state.meaningAttempt).toBeUndefined();
    // The copy before the switch stays; no window makes one.
    expect(
      await readFile(
        join(paths.home, ".gbrain.bak-meaning-20261119T001000Z", "config.json"),
        "utf8",
      ),
    ).toBe('{"brain":"before"}');
    expect(
      (await readdir(paths.home)).filter((n) => n.startsWith(".gbrain.")),
    ).toEqual([".gbrain.bak-meaning-20261119T001000Z"]);
  });

  test("while Buddy works between windows the server keeps running with the model; the next idle run goes on", async () => {
    const { host, paths, calls, world } = await stand({
      windows: [
        { exit: 11, embedded: 10, remaining: 30, reason: "time_budget" },
        { exit: 0, embedded: 30 },
      ],
      // The questions before the switch and before the first window are the
      // first two; Buddy works at the next one, before the second window.
      busyFrom: 3,
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
    // Buddy idle again: the next run computes the rest, still no stop.
    const idle = { ...host, idle: async () => true };
    expect(await convergeMeaning(idle)).toBe("on");
    expect(stops(calls)).toBe(1);
  });

  test("a window that fails keeps every vector and the server running; windows in a row without progress stop the filling", async () => {
    const { host, paths, world } = await stand({
      windows: [
        { exit: 11, embedded: 10, remaining: 30, reason: "time_budget" },
        { exit: 1, embedded: 0, failures: 3 },
      ],
    });
    expect(await convergeMeaning(host)).toBe("waits:filling");
    expect(await convergeMeaning(host)).toBe("waits:embed-failures");
    // Nothing comes back: the brain is as the server keeps it (what the
    // failed window wrote stays), and the server runs with the model.
    expect(
      JSON.parse(await readFile(join(paths.brain, "config.json"), "utf8")),
    ).toEqual({ brain: "vectors", windows: 2 });
    expect(world.server && world.timer).toBe(true);
    expect(await unit(paths, brainUnit)).toContain("LLAMA_SERVER_BASE_URL");
    expect((await readBrainState(paths)).meaningAttempt).toMatchObject({
      result: "filling",
      stalled: 1,
    });
    // The next failure in a row stops it for this pin.
    expect(meaningMaxStalled).toBe(2);
    expect(await convergeMeaning(host)).toBe("held:embed-failures");
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

  test("the switch is committed before the server starts: a run that died at the start leaves nothing a next run would bring back over writes", async () => {
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
    // The one start, after the switch: the attempt already reads `filling`
    // with no window in progress, so no copy ever comes back.
    expect(atStart).toHaveLength(1);
    expect(atStart[0]).toMatchObject({ result: "filling" });
    expect((atStart[0] as { phase?: string }).phase).toBeUndefined();
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
    expect(await convergeMeaning(host)).toBe("held:embed-windows");
    expect(await convergeMeaning(host)).toBe("held");
    expect(world.server).toBe(true);
    expect(await unit(paths, brainUnit)).toContain("LLAMA_SERVER_BASE_URL");
  });

  // #1298: four windows of 3 minutes on 4 cores, each stopped at its budget
  // in the middle of a page, installed nothing; the filling gave up with
  // 385 chunks left and read as `restored`, though nothing came back.
  test("windows that reach their budget and install nothing give up as held:embed-budget, each window's report kept, nothing brought back", async () => {
    const budgetOnly = {
      exit: 11,
      embedded: 0,
      remaining: 385,
      reason: "time_budget",
    };
    const { host, paths, world } = await stand({
      windows: [budgetOnly],
    });
    const start = await readBrainState(paths);
    expect(await convergeMeaning(host)).toBe("waits:filling");
    const firstState = await readBrainState(paths);
    const first = firstState.meaningAttempt;
    // What setup prints for the window this run ran, and for none.
    expect(windowSince(start, firstState)).toBe(
      "exit 11, stop time_budget, embedded 0, remaining 385",
    );
    expect(windowSince(firstState, firstState)).toBeUndefined();
    expect(first).toMatchObject({
      result: "filling",
      windows: 1,
      stalled: 1,
      lastWindow: {
        exit: 11,
        stop: "time_budget",
        embedded: 0,
        remaining: 385,
      },
    });
    expect(await convergeMeaning(host)).toBe("held:embed-budget");
    const heldState = await readBrainState(paths);
    const held = heldState.meaningAttempt;
    expect(held).toMatchObject({
      result: "restored",
      reason: "embed-budget",
      windows: 2,
      stalled: 2,
      heldOn: brainPin.version,
      lastWindow: { exit: 11, stop: "time_budget", embedded: 0 },
    });
    // The second window, though the clock may read the same.
    expect(windowSince(firstState, heldState)).toBe(
      "exit 11, stop time_budget, embedded 0, remaining 385",
    );
    expect(windowLabel({ exit: null, embedded: 0 })).toBe(
      "exit limit, embedded 0",
    );
    expect(await convergeMeaning(host)).toBe("held");
    expect(windowSince(heldState, await readBrainState(paths))).toBeUndefined();
    // The brain as the server keeps it: no copy came back, the server runs.
    expect(
      JSON.parse(await readFile(join(paths.brain, "config.json"), "utf8")),
    ).toEqual({ brain: "vectors", windows: 2 });
    expect(world.server).toBe(true);
  });

  test("a filling given up on another gbrain release is tried again once on this one, from where it stopped and without a copy", async () => {
    const { host, paths, world, calls } = await stand({
      windows: [
        { exit: 11, embedded: 0, remaining: 385, reason: "time_budget" },
        { exit: 11, embedded: 0, remaining: 385, reason: "time_budget" },
        { exit: 0, embedded: 385, left: 0 },
      ],
    });
    expect(await convergeMeaning(host)).toBe("waits:filling");
    expect(await convergeMeaning(host)).toBe("held:embed-budget");
    expect(await convergeMeaning(host)).toBe("held");
    const stopsBefore = stops(calls);
    // As an attempt of an earlier Lazurio records it: no heldOn, given up on
    // the release before this pin.
    const state = await readBrainState(paths);
    const { heldOn: _on, ...earlier } = state.meaningAttempt as NonNullable<
      typeof state.meaningAttempt
    >;
    await writeBrainState(paths, { ...state, meaningAttempt: earlier });
    expect(retriesFilling(earlier, brainPin.version)).toBe(true);
    const before = await readBrainState(paths);
    expect(await convergeMeaning(host)).toBe("on");
    expect(stops(calls)).toBe(stopsBefore);
    expect(world.server).toBe(true);
    const on = await readBrainState(paths);
    expect(on.meaning?.provider).toBe(meaningPin.provider);
    // The window that finished it is kept with the switch, so setup prints
    // it once; a later run, with nothing computed, prints none.
    expect(on.meaningAttempt).toBeUndefined();
    expect(windowSince(before, on)).toBe("exit 0, embedded 385, remaining 0");
    expect(windowSince(on, on)).toBeUndefined();
  });

  test("a filling is tried again only once per release, and a brain brought back from its copy stays held", () => {
    const filling = {
      provider: meaningPin.provider,
      result: "restored" as const,
      at: "2026-11-28T12:47:14.000Z",
      reason: "embed-budget",
      windows: 4,
      stalled: 2,
    };
    expect(retriesFilling(filling, "0.60.733.0-lazurio.4")).toBe(true);
    expect(
      retriesFilling(
        { ...filling, heldOn: "0.60.733.0-lazurio.4" },
        "0.60.733.0-lazurio.4",
      ),
    ).toBe(false);
    const { windows: _w, stalled: _s, ...copiedBack } = filling;
    expect(
      retriesFilling(
        { ...copiedBack, reason: "enable" },
        "0.60.733.0-lazurio.4",
      ),
    ).toBe(false);
    expect(retriesFilling({ ...filling, provider: "other:model" }, "x")).toBe(
      false,
    );
    expect(retriesFilling(filling, undefined)).toBe(false);
  });

  test("a start systemd reports as failed after the switch, though the server runs: the brain is kept, never a copy back", async () => {
    const { host, paths, world } = await stand({
      windows: [
        { exit: 11, embedded: 10, remaining: 30, reason: "time_budget" },
        { exit: 0, embedded: 30 },
      ],
      startFailsAt: 1,
    });
    expect(await convergeMeaning(host)).toBe("waits:start");
    expect((await readBrainState(paths)).meaningAttempt).toMatchObject({
      result: "filling",
      reason: "start",
    });
    expect(world.server).toBe(true);
    // The server took a write; the next runs compute over it.
    await writeFile(
      join(paths.brain, "config.json"),
      JSON.stringify({ brain: "written" }),
    );
    expect(await convergeMeaning(host)).toBe("waits:filling");
    expect(await convergeMeaning(host)).toBe("on");
    expect(
      JSON.parse(await readFile(join(paths.brain, "config.json"), "utf8")),
    ).toEqual({ brain: "vectors", windows: 2 });
  });

  test("failures now and then over many windows leave no failed brain and no copy", async () => {
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
    expect(
      (await readdir(paths.home)).filter(
        (name) =>
          name.startsWith(".gbrain.failed-meaning") ||
          name === ".gbrain.bak-meaning-window",
      ),
    ).toEqual([]);
  });
});

describe("the facts' vectors, after the pages'", () => {
  const stops = (calls: string[][]) =>
    calls.filter((c) => c[2] === "stop" && c[3] === brainUnit).length;
  /** A brain switched on by an earlier pin: on for the pages, its database
   * plane never recorded, no facts computed. */
  const onBefore = async (options: Parameters<typeof stand>[0] = {}) => {
    const s = await stand(options);
    await writeBrainState(s.paths, {
      ...(await readBrainState(s.paths)),
      meaning: {
        provider: "llama-server:bge-m3",
        dimensions: 1024,
        at: "2026-11-20T00:00:00.000Z",
      },
    });
    return s;
  };

  test("a brain switched on before gets its database plane in one short stop, then its facts with the server running", async () => {
    const { host, paths, calls, world } = await onBefore();
    expect(await convergeMeaning(host)).toBe("on");
    // One stop, for `embeddings enable` with the model it already has.
    expect(stops(calls)).toBe(1);
    const enable = calls.findIndex((c) => c[1] === "embeddings");
    const facts = calls.findIndex(
      (c) => c[1] === "embed" && c.includes("--facts"),
    );
    const started = calls.findIndex(
      (c, i) => i > enable && c[2] === "start" && c[3] === brainUnit,
    );
    expect(enable).toBeGreaterThan(-1);
    expect(started).toBeGreaterThan(enable);
    expect(facts).toBeGreaterThan(started);
    expect(calls[facts]).toEqual(
      expect.arrayContaining(["--source", "default", "--max-cost-usd", "0"]),
    );
    expect(world.server).toBe(true);
    const done = (await readBrainState(paths)).meaningFacts;
    expect(done?.plane).toBeDefined();
    expect(done?.done).toBeDefined();
    // Done once: a later run stops nothing and computes nothing.
    calls.length = 0;
    expect(await convergeMeaning(host)).toBe("on");
    expect(calls.some((c) => c[1] === "embed" || c[2] === "stop")).toBe(false);
  });

  test("while Buddy works nothing stops; the facts wait for the next idle run", async () => {
    const { host, calls } = await onBefore({ idle: false });
    expect(await convergeMeaning(host)).toBe("waits:facts");
    expect(stops(calls)).toBe(0);
    expect(calls.some((c) => c[1] === "embed")).toBe(false);
  });

  test("facts left go on in later windows; two in a row without progress give them up, the pages kept on", async () => {
    const left = await onBefore({
      facts: [
        { exit: 0, embedded: 5, remaining: 7 },
        { exit: 0, embedded: 7, remaining: 0 },
      ],
    });
    expect(await convergeMeaning(left.host)).toBe("waits:facts");
    expect(await convergeMeaning(left.host)).toBe("on");
    expect((await readBrainState(left.paths)).meaningFacts).toMatchObject({
      windows: 2,
      remaining: 0,
    });
    // One stop only, for the plane: the windows do not stop the server.
    expect(stops(left.calls)).toBe(1);
    const stuck = await onBefore({
      facts: [{ exit: 1, embedded: 0, remaining: 4 }],
    });
    expect(await convergeMeaning(stuck.host)).toBe("waits:facts");
    expect(await convergeMeaning(stuck.host)).toBe("on");
    const given = (await readBrainState(stuck.paths)).meaningFacts;
    expect(given?.reason).toBe("facts");
    expect(given?.done).toBeUndefined();
    expect((await readBrainState(stuck.paths)).meaning?.provider).toBe(
      "llama-server:bge-m3",
    );
  });

  test("facts over the model's input limit end the facts incomplete, never done, though `remaining` is 0", async () => {
    const { host, paths } = await onBefore({
      facts: [{ exit: 0, embedded: 3, remaining: 0, refused: 2 }],
    });
    expect(await convergeMeaning(host)).toBe("on");
    const facts = (await readBrainState(paths)).meaningFacts;
    expect(facts).toMatchObject({
      remaining: 0,
      refused: 2,
      reason: "facts-oversized",
    });
    expect(facts?.done).toBeUndefined();
  });

  test("facts given up on an earlier release are tried once more on this pin: the plane in one short stop, then the facts", async () => {
    // Bob's brain after rc.3: the pages on, the facts given up because that
    // release's `embeddings enable` refused (`facts-plane`), no release on record.
    const { host, paths, calls } = await onBefore();
    await writeBrainState(paths, {
      ...(await readBrainState(paths)),
      meaningFacts: { stalled: 2, reason: "facts-plane" },
    });
    expect(await convergeMeaning(host)).toBe("on");
    const facts = (await readBrainState(paths)).meaningFacts;
    expect(facts?.done).toBeDefined();
    expect(facts?.plane).toBeDefined();
    expect(facts?.reason).toBeUndefined();
    expect(facts?.stalled).toBe(0);
    expect(calls.filter((c) => c[1] === "embeddings")).toHaveLength(1);
    expect(
      calls.filter((c) => c[2] === "stop" && c[3] === brainUnit),
    ).toHaveLength(1);
  });

  test("facts given up on this very release are not tried again: no stop, no window", async () => {
    const { host, paths, calls } = await onBefore();
    await writeBrainState(paths, {
      ...(await readBrainState(paths)),
      meaningFacts: {
        stalled: 2,
        reason: "facts-plane",
        release: brainPin.version,
      },
    });
    expect(await convergeMeaning(host)).toBe("on");
    expect(calls.some((c) => c[1] === "embeddings" || c[1] === "embed")).toBe(
      false,
    );
    expect(calls.some((c) => c[2] === "stop" && c[3] === brainUnit)).toBe(
      false,
    );
    expect((await readBrainState(paths)).meaningFacts?.reason).toBe(
      "facts-plane",
    );
  });

  test("a give-up records its release, so the same release does not try again but the next does", async () => {
    const { host, paths } = await onBefore({
      facts: [{ exit: 1, embedded: 0, remaining: 4 }],
    });
    expect(await convergeMeaning(host)).toBe("waits:facts");
    expect(await convergeMeaning(host)).toBe("on");
    expect((await readBrainState(paths)).meaningFacts).toMatchObject({
      reason: "facts",
      release: brainPin.version,
    });
  });

  test("a run that dies in the facts' stop leaves it recorded; the next run starts the server before anything else", async () => {
    const s = await onBefore();
    // What a run that died during `embeddings enable` leaves: the state and
    // the server as they are at that moment.
    let atEnable: Awaited<ReturnType<typeof readBrainState>> | undefined;
    let serverAtEnable: boolean | undefined;
    const watching = {
      ...s.host,
      run: async (
        argv: readonly string[],
        timeout: number,
        env: Readonly<Record<string, string>>,
      ) => {
        if (argv[1] === "embeddings" && atEnable === undefined) {
          atEnable = await readBrainState(s.paths);
          serverAtEnable = s.world.server;
        }
        return s.host.run(argv, timeout, env);
      },
    } as typeof s.host;
    expect(await convergeMeaning(watching)).toBe("on");
    // The stop was on record before it happened, the server down meanwhile.
    expect(serverAtEnable).toBe(false);
    expect(atEnable?.meaningFacts?.stopping).toBeDefined();
    // The run dies there: that state, the server down.
    if (atEnable === undefined) throw new Error("no enable");
    await writeBrainState(s.paths, atEnable);
    s.world.server = false;
    s.world.timer = false;
    // Setup's next run recovers first: the server comes back, the record goes.
    expect(await recoverAttempt(s.host)).toBe("waits:facts-interrupted");
    expect(s.world.server).toBe(true);
    expect(s.world.timer).toBe(true);
    expect(
      (await readBrainState(s.paths)).meaningFacts?.stopping,
    ).toBeUndefined();
    // The next idle run goes on: the plane, then the facts.
    expect(await convergeMeaning(s.host)).toBe("on");
    expect((await readBrainState(s.paths)).meaningFacts?.done).toBeDefined();
  });

  test("a server that does not come back after the facts' stop is never reported as done, even where enabling fails", async () => {
    for (const otherVectors of [false, true]) {
      // The start after the stop and the next two recoveries' starts fail
      // for real; the fourth start works.
      const s = await onBefore({ deadStarts: [1, 2, 3], otherVectors });
      expect(await convergeMeaning(s.host)).toBe("waits:start");
      expect(s.world.server).toBe(false);
      const facts = (await readBrainState(s.paths)).meaningFacts;
      expect(facts?.done).toBeUndefined();
      expect(facts?.reason).toBeUndefined();
      // The stop stays on record while the server does not answer, through
      // every recovery that fails to start it: each a wait to repeat.
      expect(facts?.stopping).toBeDefined();
      for (let i = 0; i < 2; i++) {
        expect(await recoverAttempt(s.host)).toBe("waits:facts-start");
        expect(
          (await readBrainState(s.paths)).meaningFacts?.stopping,
        ).toBeDefined();
      }
      // Once a start works, the record goes and the facts go on.
      expect(await recoverAttempt(s.host)).toBe("waits:facts-interrupted");
      expect(s.world.server).toBe(true);
      expect(
        (await readBrainState(s.paths)).meaningFacts?.stopping,
      ).toBeUndefined();
    }
  });

  test("a stop that does not go through clears its record only once the server answers", async () => {
    const s = await onBefore({ deadStarts: [1] });
    // systemd reports the stop as failed, though it half happened: the
    // server is down, and its first start fails too.
    const stubborn = {
      ...s.host,
      service: async (...args: Parameters<typeof s.host.service>) => {
        const [argv] = args;
        if (argv.includes("stop") && argv.includes(brainUnit)) {
          s.world.server = false;
          return { exitCode: 1, stdout: "", stderr: "" };
        }
        return s.host.service(...args);
      },
    } as typeof s.host;
    expect(await convergeMeaning(stubborn)).toBe("waits:start");
    expect(s.world.server).toBe(false);
    expect(
      (await readBrainState(s.paths)).meaningFacts?.stopping,
    ).toBeDefined();
    // The next run's recovery starts it; then the record goes.
    expect(await recoverAttempt(s.host)).toBe("waits:facts-interrupted");
    expect(s.world.server).toBe(true);
    expect(
      (await readBrainState(s.paths)).meaningFacts?.stopping,
    ).toBeUndefined();
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
      meaning: "held:embed-failures",
    });
    // The first window, then two that failed; then nothing more.
    expect(start.runs()).toBe(3);
  });
});
