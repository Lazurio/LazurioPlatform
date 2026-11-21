import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { writeDurableFile } from "../update/durable-file";
import { systemctl, unitMarker } from "../update/service-control";
import { healthVersion } from "./admin";
import { readBrainState, writeBrainState } from "./keys";
import {
  meaningConcurrency,
  meaningPaths,
  meaningPin,
  meaningPort,
  meaningUnit,
  meaningUrl,
} from "./meaning-pin";
import {
  answers,
  keepDown,
  type MoveHost,
  pages,
  stoppedForSure,
} from "./move";
import { nightAt, nightLeastMinutes, nightOf } from "./night";
import { brainRefreshTimer, brainUnit } from "./pin";
import { writeBrainUnits } from "./units";

// Search by meaning in the person's memory (plan LZD-0033 R11a, decided on
// 2026-11-18): a local embedding model that Lazurio installs and watches like
// GBrain. Its server (llama.cpp's `llama-server`, the pinned model) runs as
// Lazurio's user unit on loopback at a lower priority; gbrain asks it through
// `LLAMA_SERVER_BASE_URL`. Without it gbrain falls back to keyword search,
// and `lazurio brain status` and doctor say so.
//
// Switching a brain on is a step of its own, done once and like a move:
// only while Buddy is idle, the model answering first (gbrain probes it
// before any change), the server stopped as systemd confirms, a copy of
// ~/.gbrain, then `gbrain embeddings enable` and, only where the brain's
// vector column has another width than the model's (a brain created without
// embeddings has 1024, the model's width too) or already holds another
// model's vectors (gbrain refuses to enable over them), `gbrain migrate
// embeddings --no-embed` to it, which keeps every page and fact. The vectors
// are then computed with the server stopped, as on PGLite there is no other
// way: a running server holds the brain's lock and refuses both a CLI embed
// and an embed-backfill job (`pglite_busy`, verified on fictional data on
// 2026-11-19), and it computes nothing of the backlog by itself. Since the
// amendment of 2026-11-20 to decision F44 point 10, they are computed in
// windows (`gbrain embed --stale` with its time budget), one per setup run,
// the server running with the model between them; the Launchpad runs setup
// again while windows are left (`./at-start.ts`). Since the amendment of
// 2026-11-21 the windows run in the person's night window (`./night.ts`), up
// to an hour each; by day only a small backlog gets one short window, and
// anything larger waits for the night (`waits:night`). Every window, and every
// way back, is committed before the server starts, so no copy ever comes
// back over a write. The first window that fails brings the copy before
// back without the model and is not tried again for this pin (`held`); a
// later one brings its own copy back with the model, and windows in a row
// without progress stop the filling with the vectors kept.

export type MeaningFetch = (
  url: string,
  init?: RequestInit,
) => Promise<Response>;

export type MeaningHost = MoveHost &
  Readonly<{
    fetch: MeaningFetch;
    /** Copies the brain with the server stopped (default `cp`): a seam for
     * a copy that takes long. */
    copyBrain?: (from: string, to: string) => Promise<void>;
  }>;

const clockOf = (host: MoveHost) => (host.now ?? (() => new Date()))();

/** When the next stop must be over, the server answering again (epoch
 * milliseconds), or null where it waits for the night. Read just before the
 * server stops, and bounding the whole stop: the copy, the steps, the
 * embedding and the start after it (`embedPlan`).
 * - In the person's night window: up to `meaningNightStopMs`, never past the
 *   window's end, and no stop where less than `meaningNightLeastMs` is left.
 * - A small backlog, at any other time: one short window, the whole stop
 *   within `meaningDayStopMs` (the day's exception holds at any hour, also
 *   at a night window's end).
 * - Else nothing stops. */
type Deadline = Readonly<{ at: number; short: boolean }>;

async function stopDeadline(
  host: MoveHost,
  small: boolean,
): Promise<Deadline | null> {
  const night = nightOf((await readBrainState(host.paths)).night);
  const now = clockOf(host);
  const at = nightAt(now, night);
  if (at.inside && at.endsInMs >= meaningNightLeastMs)
    return {
      at: now.getTime() + Math.min(at.endsInMs, meaningNightStopMs),
      short: false,
    };
  return small ? { at: now.getTime() + meaningDayStopMs, short: true } : null;
}

/** A window that found too little of its stop left to compute anything (the
 * steps before it took the time): its copy comes back and the next run tries
 * again, as if it had not started; it is no failure of the model. */
const noTime = "no-time";

/** How one window's embedding fits the time its stop has left: the
 * process's hard limit leaves `meaningRestartReserveMs` for the count, the
 * units and the server's start (or a copy brought back); within it, a batch
 * begun at the budget's end (`meaningBatchLimitMs`) and gbrain's own start
 * and last write (`meaningEmbedGraceMs`). A short window's budget stays
 * `meaningWindowMs` at most. Null where not even a minute of budget is
 * left. */
export type EmbedPlan = Readonly<{ budgetMs: number; limitMs: number }>;

export function embedPlan(
  leftMs: number,
  most: number = meaningNightStopMs,
  reserveMs: number = meaningRestartReserveMs,
): EmbedPlan | null {
  const limitMs = leftMs - reserveMs;
  const budgetMs = Math.min(
    most,
    limitMs - meaningBatchLimitMs - meaningEmbedGraceMs,
  );
  if (budgetMs < 60_000) return null;
  return Object.freeze({ budgetMs, limitMs });
}

/** What a stop keeps after its embedding, from how long its copy took: the
 * copy brought back takes about as long, then the server's start; never
 * less than `meaningRestartReserveMs`. */
export const reserveAfter = (copyMs: number) =>
  Math.max(meaningRestartReserveMs, copyMs + startReserveMs);

/** The plan of a window whose stop ends at `deadline`, from the time left
 * when its embedding starts and what the stop keeps after it: a short stop
 * keeps the short window's budget. */
const planOf = (host: MoveHost, deadline: Deadline, reserveMs: number) =>
  embedPlan(
    deadline.at - clockOf(host).getTime(),
    deadline.short ? meaningWindowMs : meaningNightStopMs,
    reserveMs,
  );

/** The brain copied with the server stopped (a seam for a copy that takes
 * long), and how long the copy took on the stop's clock. */
async function copyTimed(
  host: MoveHost & Pick<MeaningHost, "copyBrain">,
  from: string,
  to: string,
): Promise<number> {
  const started = clockOf(host).getTime();
  const copy =
    host.copyBrain ??
    ((a: string, b: string) =>
      cp(a, b, {
        recursive: true,
        verbatimSymlinks: true,
        preserveTimestamps: true,
        errorOnExist: true,
        force: false,
      }));
  await copy(from, to);
  return clockOf(host).getTime() - started;
}

/** Whether the server answers its pinned version, asked until `deadline`
 * at most (and at most `tries` times): where a stop's committed window
 * waits for it. A server not answering by then was started all the same;
 * the next run starts one that does not answer (`afterCommit`). */
async function answersBy(
  host: MoveHost,
  deadline: number,
): Promise<string | null> {
  for (let i = 0; i < (host.tries ?? 450); i++) {
    const version = await healthVersion(host.http, host.base);
    if (version !== null) return version;
    if (clockOf(host).getTime() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, host.waitMs ?? 2000));
  }
  return null;
}

/** The limit of a step inside a stop: its own, and never into the time the
 * stop keeps after it (`keepMs`): before the embedding the start after it,
 * after the embedding the server's start and answer. */
const stepIn = (host: MoveHost, deadline: Deadline, keepMs: number) =>
  Math.max(
    1_000,
    Math.min(
      meaningStepLimitMs,
      deadline.at - clockOf(host).getTime() - keepMs,
    ),
  );
/** What a stop keeps after its last count: the server's start and answer. */
const startReserveMs = 2 * 60_000;

export type MeaningResult =
  | "on"
  | "held"
  | "waits-idle"
  | `waits:${string}`
  | `restored:${string}`
  | `stopped:${string}`;

const downloadLimitBytes = 1024 * 1024 * 1024;
const downloadTimeoutMs = 30 * 60_000;

const present = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  );

const service = (host: MoveHost, ...args: string[]) =>
  systemctl({ run: host.service, env: host.env }, ...args);

/** One file over https to `file`, hashed while it streams; anything but the
 * pinned digest leaves nothing behind. */
export async function downloadVerified(
  fetcher: MeaningFetch,
  url: string,
  sha256: string,
  file: string,
): Promise<boolean> {
  if (!url.startsWith("https://")) return false;
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const partial = `${file}.part-${randomBytes(4).toString("hex")}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), downloadTimeoutMs);
  const hash = createHash("sha256");
  const handle = await open(partial, "wx", 0o600);
  let complete = false;
  try {
    const response = await fetcher(url, {
      signal: controller.signal,
      headers: { "User-Agent": "lazurio-brain-meaning" },
    });
    if (
      !response.ok ||
      (response.url !== "" && !response.url.startsWith("https://"))
    )
      return false;
    const reader = response.body?.getReader();
    if (reader === undefined) return false;
    let length = 0;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > downloadLimitBytes) {
        await reader.cancel().catch(() => undefined);
        return false;
      }
      hash.update(chunk.value);
      await handle.write(chunk.value);
    }
    await handle.sync();
    if (hash.digest("hex") !== sha256) return false;
    complete = true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    await handle.close();
    if (complete) await rename(partial, file);
    else await rm(partial, { force: true });
  }
  return true;
}

async function findFile(root: string, name: string): Promise<string | null> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isFile() && entry.name === name) return path;
    if (entry.isDirectory()) {
      const found = await findFile(path, name);
      if (found !== null) return found;
    }
  }
  return null;
}

/** The pinned server and model, each verified before it is used. A file or
 * directory is in its final place only once its digest matched, so its
 * presence is the proof. Returns the server's command, or why not. */
export async function installMeaning(
  host: MeaningHost,
): Promise<Readonly<{ server: string }> | `failed:${string}`> {
  const paths = meaningPaths(host.paths.home);
  if (!(await present(paths.model))) {
    const ok = await downloadVerified(
      host.fetch,
      meaningPin.model.url,
      meaningPin.model.sha256,
      paths.model,
    );
    if (!ok) return "failed:model";
  }
  if (!(await present(paths.server))) {
    const tarball = `${paths.server}.tar.gz`;
    const unpacking = `${paths.server}.unpacking-${randomBytes(4).toString("hex")}`;
    try {
      if (
        !(await downloadVerified(
          host.fetch,
          meaningPin.server.url,
          meaningPin.server.sha256,
          tarball,
        ))
      )
        return "failed:server";
      await mkdir(unpacking, { recursive: true, mode: 0o700 });
      const unpacked = await host
        .run(["tar", "-xzf", tarball, "-C", unpacking], 600_000, {
          PATH: host.env.PATH ?? "/usr/bin:/bin",
        })
        .catch(() => "timeout" as const);
      if (unpacked === "timeout" || unpacked.exitCode !== 0)
        return "failed:unpack";
      if ((await findFile(unpacking, "llama-server")) === null)
        return "failed:unpack";
      await rename(unpacking, paths.server);
    } finally {
      await rm(unpacking, { recursive: true, force: true });
      await rm(tarball, { force: true });
    }
  }
  const server = await findFile(paths.server, "llama-server");
  return server === null ? "failed:server" : Object.freeze({ server });
}

/** Lazurio's unit of the model server: loopback only, at a lower priority
 * than the person's work (the first embedding takes the processor for a
 * while), restarted when it fails. */
export function renderMeaningUnit(server: string, model: string): string {
  return [
    unitMarker,
    "[Unit]",
    `Description=Lazurio Brain: search by meaning (local embedding model, loopback 127.0.0.1:${meaningPort})`,
    "StartLimitIntervalSec=300",
    "StartLimitBurst=10",
    "",
    "[Service]",
    "Type=simple",
    `Environment=LD_LIBRARY_PATH=${dirname(server)}`,
    `ExecStart=${server} -m ${model} --alias ${meaningAlias} --embeddings --pooling ${meaningPin.pooling} -c ${meaningPin.context} -b ${meaningPin.context} -ub ${meaningPin.context} --host 127.0.0.1 --port ${meaningPort}`,
    "Nice=10",
    "CPUWeight=20",
    "IOSchedulingClass=idle",
    "Restart=on-failure",
    "RestartSec=10",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

/** The name the model server answers to: gbrain's model of the provider. */
const meaningAlias = meaningPin.provider.replace(/^llama-server:/, "");

/** Whether the model server answers on loopback. */
export async function meaningAnswers(host: MoveHost): Promise<boolean> {
  const answer = await host.http("GET", `${meaningUrl}/health`);
  return answer !== null && answer.status === 200;
}

/** Whether what answers on the model's port is Lazurio's model server: it
 * names the pinned model file (in the person's home, named by its digest)
 * and its alias. Any other process there never gets the brain's text. */
export async function modelIsOurs(host: MoveHost): Promise<boolean> {
  const answer = await host.http("GET", `${meaningUrl}/props`);
  if (answer === null || answer.status !== 200) return false;
  try {
    const props = JSON.parse(answer.body) as {
      model_path?: unknown;
      model_alias?: unknown;
    };
    return (
      props.model_path === meaningPaths(host.paths.home).model &&
      props.model_alias === meaningAlias
    );
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForModel(host: MoveHost): Promise<boolean> {
  for (let i = 0; i < (host.tries ?? 60); i++) {
    if (await modelIsOurs(host)) return true;
    await sleep(host.waitMs ?? 1000);
  }
  return false;
}

const stampOf = (now: Date) =>
  now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");

/** The JSON a `gbrain … --json` command printed, after any banner. */
function printed(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  try {
    const value = JSON.parse(text.slice(start)) as unknown;
    return typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** gbrain's error code of a refusal. */
function codeOf(refusal: Record<string, unknown> | null): string | null {
  const code =
    refusal?.code ??
    (refusal?.error as Record<string, unknown> | undefined)?.code ??
    refusal?.error;
  return typeof code === "string" ? code : null;
}

/** The width gbrain says the brain's column has, from its refusal. */
function columnWidth(refusal: Record<string, unknown> | null): string | null {
  const fix = (refusal?.fix ??
    (refusal?.error as Record<string, unknown> | undefined)?.fix) as
    | { argv?: unknown }
    | undefined;
  const argv = Array.isArray(fix?.argv) ? (fix.argv as unknown[]) : [];
  const at = argv.indexOf("--embedding-dimensions");
  const width = at >= 0 ? argv[at + 1] : undefined;
  return typeof width === "string" && /^[1-9][0-9]{1,4}$/.test(width)
    ? width
    : null;
}

/** gbrain's own steps, with the server stopped: enable the model and, where
 * the column has another width, move it to the model's, keeping pages and
 * facts, then compute every vector while the server is stopped (the only
 * way on PGLite). */
/** How long one window of the embedding keeps the server stopped: gbrain's
 * own budget (`GBRAIN_EMBED_TIME_BUDGET_MS`), after which it stops between
 * batches, keeps what it computed and says how many chunks are left. Then
 * the server runs again, with the model, until the next window. */
export const meaningWindowMs = 3 * 60_000;
/** How long one batch to the local model may take. gbrain's default (60 s)
 * is for a provider across a network; a batch of 32 texts on a fully loaded
 * Environment of 4 vCPU needs longer, and an abandoned batch is computed
 * again (verified 2026-11-20: 192 batches abandoned, the step failed). */
export const meaningBatchLimitMs = 10 * 60_000;
/** gbrain's own start before its first batch and its last write after the
 * budget's batch, within a window's process limit. */
export const meaningEmbedGraceMs = 2 * 60_000;
/** What a stop keeps after its embedding: the count of the pages, the units,
 * the server's start and its answer, or a copy brought back and the same
 * start (a copy of a brain of 344 MB took under 0.2 s, measured
 * 2026-11-20). */
export const meaningRestartReserveMs = 3 * 60_000;
/** The whole stop for a small backlog by day: the bound Matěj accepted for
 * the short windows (#1134, about 18 minutes on a heavily loaded
 * Environment), the stop, the copy, the embedding and the start included.
 * Its embedding keeps the short window's budget (`meaningWindowMs`). */
export const meaningDayStopMs = 18 * 60_000;
/** The process limit of a short window's embedding, at the start of a day
 * stop (its other steps take seconds). */
export const meaningEmbedLimitMs = meaningDayStopMs - meaningRestartReserveMs;
/** The longest stop in the night window (Matěj: an hour at a stretch is
 * fine), the whole stop; a window that ends sooner bounds it, and a night
 * window with less than `meaningNightLeastMs` left starts no stop: a stop
 * needs a minute of budget, a batch, gbrain's start and the server's, with
 * room for the copy and the steps before. */
export const meaningNightStopMs = 60 * 60_000;
export const meaningNightLeastMs = nightLeastMinutes * 60_000;
/** A backlog small enough for one short window by day: a brain of at most
 * this many pages before the first window, or this many chunks left after
 * one (gbrain's count; at about 1.4 s a chunk on 4 vCPU, a short window). */
export const meaningSmallPages = 25;
export const meaningSmallChunks = 100;
/** How long the server runs between two windows, so Buddy and the agents
 * reach the memory: longer than a window, so the memory answers most of
 * the time even where the filling takes many windows (on a fully loaded
 * Environment the model, at a lower priority, computes few vectors in one:
 * 11 of 188 chunks in 4 minutes, measured 2026-11-20 on 4 cores). */
export const meaningPauseMs = 5 * 60_000;
/** One window per setup run: the Launchpad runs setup again after
 * `meaningPauseMs` while windows are left (`./at-start.ts`), so a run stays
 * short and agents reach the brain (Executor's Brain) after the first.
 * After this many windows, or this many in a row without progress, the
 * filling stops for a person, the vectors computed so far kept. */
export const meaningMaxWindows = 400;
export const meaningMaxStalled = 2;
/** How long any other of gbrain's steps here may take. */
export const meaningStepLimitMs = 15 * 60_000;

/** gbrain's exit code where an embedding stopped at its budget with chunks
 * left (`BUDGET_STOP_EXIT_CODE`, src/core/exit-codes.ts of the pin). */
const budgetStopExit = 11;

const gbrainEnv = (
  host: MeaningHost,
  budgetMs: number,
): Record<string, string> => ({
  HOME: host.paths.home,
  GBRAIN_HOME: host.paths.home,
  PATH: host.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
  LLAMA_SERVER_BASE_URL: `${meaningUrl}/v1`,
  GBRAIN_EMBED_CONCURRENCY: String(meaningConcurrency),
  GBRAIN_AI_EMBED_TIMEOUT_MS: String(meaningBatchLimitMs),
  GBRAIN_EMBED_TIME_BUDGET_MS: String(budgetMs),
});

/** gbrain's CLI: an embedding at its plan's limit and budget, any other step
 * at `limitMs` (its own, or what a stop leaves it, `stepIn`). */
const gbrainOf =
  (
    host: MeaningHost,
    command: string,
    plan: EmbedPlan | number = meaningStepLimitMs,
  ) =>
  async (args: readonly string[]) => {
    const limit = typeof plan === "number" ? plan : plan.limitMs;
    const budget = typeof plan === "number" ? meaningWindowMs : plan.budgetMs;
    const result = await host
      .run([command, ...args], limit, gbrainEnv(host, budget))
      .catch(() => "timeout" as const);
    return result === "timeout"
      ? { ok: false, exit: null, out: null }
      : {
          ok: result.exitCode === 0,
          exit: result.exitCode,
          out: printed(result.stdout),
        };
  };

/** One window of the embedding, with the server stopped: `done` where no
 * chunk is left, `partial` where gbrain stopped at its budget or computed
 * some and failed some (it keeps every vector it wrote; the next window goes
 * on), `failed` where it computed nothing. Closed labels and counts only. */
export type EmbedWindow =
  | Readonly<{ result: "done"; embedded: number }>
  | Readonly<{ result: "partial"; embedded: number; remaining?: number }>
  | Readonly<{ result: "failed"; reason: string }>;

export async function embedWindow(
  host: MeaningHost,
  command: string,
  plan: EmbedPlan,
): Promise<EmbedWindow> {
  const ran = await gbrainOf(
    host,
    command,
    plan,
  )(["embed", "--stale", "--json"]);
  if (ran.exit === null) return { result: "failed", reason: "embed-limit" };
  const count = (key: string) => {
    const value = ran.out?.[key];
    return typeof value === "number" && Number.isInteger(value) && value >= 0
      ? value
      : undefined;
  };
  const embedded = count("embedded") ?? 0;
  const remaining = count("remaining_stale");
  const failures = count("failures") ?? 0;
  if (ran.ok && failures === 0) return { result: "done", embedded };
  if (ran.exit === budgetStopExit || embedded > 0)
    return {
      result: "partial",
      embedded,
      ...(remaining === undefined ? {} : { remaining }),
    };
  const reason = ran.out?.reason;
  return {
    result: "failed",
    reason:
      reason === "stall_timeout"
        ? "embed-stalled"
        : failures > 0
          ? "embed-failures"
          : "embed",
  };
}

/** The brain's page count as gbrain's CLI reads it, only while the server
 * is stopped (it then holds no lock): the same count before and after a
 * window says the window touched no page. Read there, never over the
 * server, so a page written while the server runs never reads as a loss.
 * Null where it cannot be read. */
async function storedPages(
  host: MeaningHost,
  command: string,
  limitMs: number = meaningStepLimitMs,
): Promise<number | null> {
  const ran = await gbrainOf(host, command, limitMs)(["stats", "--json"]);
  const count = ran.ok ? ran.out?.page_count : undefined;
  return typeof count === "number" && Number.isInteger(count) && count >= 0
    ? count
    : null;
}

/** gbrain's own steps before the vectors, with the server stopped: enable
 * the model and, where the column has another width, move it to the
 * model's, keeping pages and facts. Null where it went through, else the
 * step that refused. */
export async function switchOn(
  host: MeaningHost,
  command: string,
  limitMs: () => number = () => meaningStepLimitMs,
): Promise<string | null> {
  const gbrain = (args: readonly string[]) =>
    gbrainOf(host, command, limitMs())(args);
  const model = meaningPin.provider;
  const width = String(meaningPin.dimensions);
  const enable = (dims: string) =>
    gbrain([
      "embeddings",
      "enable",
      "--embedding-model",
      model,
      "--embedding-dimensions",
      dims,
      "--json",
    ]);
  const direct = await enable(width);
  if (!direct.ok) {
    // gbrain says why (its error code, verified with the pinned release on
    // fictional data on 2026-11-19):
    // - `embedding_width_mismatch`: an empty column of another width; the
    //   model is enabled at that width first (from the refusal's fix, else
    //   from `migrate embeddings --status`), then moved to the model's;
    // - `embedding_model_mismatch`: vectors of another model are there, and
    //   enabling cannot change their identity; the migration moves them.
    // Anything else is not tried.
    const code = codeOf(direct.out);
    if (code === "embedding_width_mismatch") {
      let column = columnWidth(direct.out);
      if (column === null) {
        const status = await gbrain([
          "migrate",
          "embeddings",
          "--status",
          "--json",
        ]);
        const dims = Number(status.out?.column_dims);
        column = Number.isInteger(dims) && dims > 0 ? String(dims) : null;
      }
      if (column === null || column === width) return "enable";
      const atColumn = await enable(column);
      if (!atColumn.ok && codeOf(atColumn.out) !== "embedding_model_mismatch")
        return "enable";
    } else if (code !== "embedding_model_mismatch") return "enable";
    const migrated = await gbrain([
      "migrate",
      "embeddings",
      "--to",
      model,
      "--dim",
      width,
      "--yes",
      "--max-cost-usd",
      "0",
      "--no-embed",
      "--json",
    ]);
    if (!migrated.ok) return "migrate";
  }
  return null;
}

const digestOf = (text: string) =>
  createHash("sha256").update(text).digest("hex");

type Release = NonNullable<
  Awaited<ReturnType<typeof readBrainState>>["release"]
>;

/** Writes the attempt's journal: its stage, when it began and its copy. */
type Attempt = NonNullable<
  Awaited<ReturnType<typeof readBrainState>>["meaningAttempt"]
>;

const recorder =
  (host: MoveHost, now: Date) =>
  async (
    result: Attempt["result"],
    reason?: string,
    extra: Partial<
      Pick<
        Attempt,
        "phase" | "windowBackup" | "remaining" | "windows" | "stalled"
      >
    > = {},
  ) => {
    const current = await readBrainState(host.paths);
    const before = current.meaningAttempt;
    // What the filling counted so far stays with the attempt.
    const kept = {
      ...(before?.windows === undefined ? {} : { windows: before.windows }),
      ...(before?.stalled === undefined ? {} : { stalled: before.stalled }),
      ...(before?.remaining === undefined
        ? {}
        : { remaining: before.remaining }),
    };
    await writeBrainState(host.paths, {
      ...current,
      meaningAttempt: Object.freeze({
        provider: meaningPin.provider,
        result,
        at: now.toISOString(),
        backup: `.gbrain.bak-meaning-${stampOf(now)}`,
        ...(reason === undefined ? {} : { reason }),
        ...kept,
        ...extra,
      }),
    });
  };

async function clearAttempt(host: MoveHost): Promise<void> {
  const { meaningAttempt: _gone, ...current } = await readBrainState(
    host.paths,
  );
  await writeBrainState(host.paths, current);
}

/** The brain before, without the model, from the attempt's copy: never
 * under a running server; the server back on its release, confirmed. With
 * `filling`, the brain before a window instead: it already has the model
 * and part of its vectors, so the server comes back with the model and the
 * filling goes on (`filling` records how), or stops after windows in a row
 * that failed. */
async function restoreCopy(
  host: MoveHost,
  release: Release,
  backup: string,
  now: Date,
  reason: string,
  filling?: Readonly<{
    next: () => Promise<MeaningResult>;
    /** The window's own name for the brain it puts aside. */
    failedName: string;
  }>,
): Promise<MeaningResult> {
  const record = recorder(host, now);
  // The way back comes within the stop: the reserve the stop kept after its
  // embedding is sized by its own copy (`reserveAfter`). The server's
  // answer after this start is waited for as before: the server is started
  // by then, and a slow answer cut short would keep it down for a person.
  if (!(await stoppedForSure(host))) {
    await record("stopped", "not-stopped");
    await keepDown(host);
    return "stopped:not-stopped";
  }
  const failed = join(
    host.paths.home,
    filling?.failedName ?? `.gbrain.failed-meaning-${stampOf(now)}`,
  );
  try {
    if (!(await present(backup))) throw new Error("no copy");
    // A window's failed brain is kept once: the previous one goes, so
    // failures over many windows never fill the disk (`./room.ts`).
    if (filling !== undefined)
      await rm(failed, { recursive: true, force: true });
    if (await present(host.paths.brain)) await rename(host.paths.brain, failed);
    await copyTimed(host, backup, host.paths.brain);
    await chmod(host.paths.brain, 0o700);
    await writeBrainUnits(host.paths, release.command, filling !== undefined);
  } catch {
    await record("stopped", "copy-not-restored");
    await keepDown(host);
    return "stopped:copy-not-restored";
  }
  // The way back is committed before the server starts: from its start on
  // it may take writes, so no later run recovers this attempt by bringing
  // the copy back once more over them (a start systemd reports as failed
  // may have started it too).
  let result: MeaningResult;
  if (filling !== undefined) result = await filling.next();
  else {
    await record("restored", reason);
    result = `restored:${reason}`;
  }
  const back =
    (await service(host, "daemon-reload")) &&
    (await service(host, "start", brainUnit)) &&
    (await answers(host)) === release.version;
  if (!back) {
    // Kept down for a person, the brain as it is: never copied over.
    await record("stopped", "no-answer");
    await keepDown(host);
    return "stopped:no-answer";
  }
  await service(host, "start", brainRefreshTimer);
  return result;
}

/** An attempt a run left half way. `stopping`: the brain was not touched
 * (gbrain's steps begin only after `started`), so a partial copy goes, the
 * server comes back, and the next idle run tries again. `started`: gbrain
 * may have changed the brain, so its copy comes back as after a failed
 * step. Null where there is nothing to recover. Needs neither the model
 * nor a server that answers: setup calls it before it starts the brain (a
 * brain gbrain left half migrated may not start). */
export async function recoverAttempt(
  host: MoveHost,
): Promise<MeaningResult | null> {
  const state = await readBrainState(host.paths);
  const attempt = state.meaningAttempt;
  if (
    attempt?.provider !== meaningPin.provider ||
    (attempt.result !== "stopping" && attempt.result !== "started")
  )
    return null;
  const at = new Date(attempt.at);
  if (attempt.phase === "filling") {
    // A window a run left: its own copy, the brain with the model before it.
    const window =
      attempt.windowBackup === undefined
        ? undefined
        : join(host.paths.home, attempt.windowBackup);
    const record = recorder(host, at);
    if (attempt.result === "stopping") {
      if (window !== undefined)
        await rm(window, { recursive: true, force: true }).catch(
          () => undefined,
        );
      await service(host, "start", brainUnit);
      await service(host, "start", brainRefreshTimer);
      await record("filling");
      return "waits:interrupted";
    }
    if (state.release === undefined || window === undefined) {
      await record("stopped", "interrupted-unknown");
      await keepDown(host);
      return "stopped:interrupted-unknown";
    }
    return restoreCopy(host, state.release, window, at, "interrupted", {
      failedName: failedWindowName,
      next: async () => {
        await record("filling", "interrupted");
        return "waits:interrupted";
      },
    });
  }
  const backup =
    attempt.backup === undefined
      ? undefined
      : join(host.paths.home, attempt.backup);
  if (attempt.result === "stopping") {
    if (backup !== undefined)
      await rm(backup, { recursive: true, force: true }).catch(() => undefined);
    await service(host, "start", brainUnit);
    await service(host, "start", brainRefreshTimer);
    await clearAttempt(host);
    return "waits:interrupted";
  }
  if (state.release === undefined || backup === undefined) {
    await recorder(host, at)("stopped", "interrupted-unknown");
    await keepDown(host);
    return "stopped:interrupted-unknown";
  }
  return restoreCopy(host, state.release, backup, at, "interrupted");
}

/** The model server, and the brain switched on once. */
export async function convergeMeaning(
  host: MeaningHost,
): Promise<MeaningResult> {
  const installed = await installMeaning(host);
  if (typeof installed === "string") return `waits:${installed}`;
  const paths = meaningPaths(host.paths.home);
  const text = renderMeaningUnit(installed.server, paths.model);
  // A unit of that name is Lazurio's only if it is what Lazurio writes now
  // or wrote last (its digest); anything else, or one that cannot be read,
  // is left alone.
  let existing: string | undefined;
  try {
    existing = await readFile(join(host.paths.units, meaningUnit), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      return "waits:unit-unreadable";
  }
  if (
    existing !== undefined &&
    existing !== text &&
    digestOf(existing) !== (await readBrainState(host.paths)).meaningUnit
  )
    return "waits:unit-foreign";
  // Something else on the model's port is never asked.
  if ((await meaningAnswers(host)) && !(await modelIsOurs(host))) {
    const ours = await systemctl(
      { run: host.service, env: host.env },
      "is-active",
      "--quiet",
      meaningUnit,
    );
    if (!ours) return "waits:port-taken";
  }
  try {
    await mkdir(host.paths.units, { recursive: true });
    if (existing !== text)
      await writeDurableFile(host.paths.units, meaningUnit, Buffer.from(text));
    const state = await readBrainState(host.paths);
    if (state.meaningUnit !== digestOf(text))
      await writeBrainState(host.paths, {
        ...state,
        meaningUnit: digestOf(text),
      });
  } catch {
    return "waits:unit";
  }
  if (
    !(await service(host, "daemon-reload")) ||
    !(await service(host, "enable", "--now", meaningUnit))
  )
    return "waits:model";
  if (existing !== undefined && existing !== text)
    await service(host, "restart", meaningUnit);
  if (!(await waitForModel(host)))
    return (await meaningAnswers(host)) ? "waits:port-taken" : "waits:model";
  const recovered = await recoverAttempt(host);
  if (recovered !== null) return recovered;
  const state = await readBrainState(host.paths);
  if (state.meaning?.provider === meaningPin.provider) return "on";
  const attempt = state.meaningAttempt;
  if (
    attempt?.provider === meaningPin.provider &&
    (attempt.result === "stopped" ||
      (attempt.result === "restored" && attempt.reason !== noTime))
  )
    return attempt.result === "restored"
      ? "held"
      : `stopped:${attempt.reason ?? "unknown"}`;
  if (attempt?.provider === meaningPin.provider && attempt.result === "filling")
    return fill(host, state.release, attempt);
  // A small brain (a new Environment's) is switched on at once; a larger one
  // waits for the person's night window.
  const served = await pages(host);
  const small = served !== null && served <= meaningSmallPages;
  if ((await stopDeadline(host, small)) === null) return "waits:night";
  if (!(await host.idle())) return "waits-idle";
  const release = state.release;
  if (release === undefined) return "waits:release-unknown";
  // The whole stop from here on ends by its deadline, read just before it.
  const deadline = await stopDeadline(host, small);
  if (deadline === null) return "waits:night";
  const now = clockOf(host);
  const backup = join(host.paths.home, `.gbrain.bak-meaning-${stampOf(now)}`);
  const record = recorder(host, now);
  // The intent before the server stops: a run that dies from here on is
  // recovered by the next one (`recoverAttempt`).
  await record("stopping");
  if (!(await stoppedForSure(host))) {
    await service(host, "start", brainUnit);
    await service(host, "start", brainRefreshTimer);
    await clearAttempt(host);
    return "waits:not-stopped";
  }
  let copyMs: number;
  try {
    copyMs = await copyTimed(host, host.paths.brain, backup);
    await chmod(backup, 0o700);
  } catch {
    await rm(backup, { recursive: true, force: true }).catch(() => undefined);
    await service(host, "start", brainUnit);
    await service(host, "start", brainRefreshTimer);
    await clearAttempt(host);
    return "waits:copy";
  }
  // What the stop keeps after its embedding: the copy brought back takes
  // about as long as this one did, then the start.
  const reserve = reserveAfter(copyMs);
  // A stop and a copy that took the time a window needs: nothing of the
  // brain changed yet, so the server comes back as it was, and the next
  // run tries again.
  if (planOf(host, deadline, reserve) === null) {
    await rm(backup, { recursive: true, force: true }).catch(() => undefined);
    await service(host, "start", brainUnit);
    await service(host, "start", brainRefreshTimer);
    await clearAttempt(host);
    return `waits:${noTime}`;
  }
  await record("started");
  const fallBack = async (reason: string) => {
    const back = await restoreCopy(host, release, backup, now, reason);
    // A window with no time left is tried again by the next run.
    return back === `restored:${noTime}` ? (`waits:${noTime}` as const) : back;
  };
  // The pages as stored, read with the server stopped.
  const before = () => stepIn(host, deadline, reserve);
  const stored = await storedPages(host, release.command, before());
  if (stored === null) return fallBack("page-count");
  const refused = await switchOn(host, release.command, before);
  if (refused !== null) return fallBack(refused);
  // The first window: until it is committed, the copy before is the way
  // back, and the server is stopped, so no page is written meanwhile.
  const plan = planOf(host, deadline, reserve);
  if (plan === null) return fallBack(noTime);
  const window = await embedWindow(host, release.command, plan);
  if (window.result === "failed") return fallBack(window.reason);
  if (
    (await storedPages(
      host,
      release.command,
      stepIn(host, deadline, startReserveMs),
    )) !== stored
  )
    return fallBack("page-count");
  try {
    await writeBrainUnits(host.paths, release.command, true);
  } catch {
    return fallBack("units");
  }
  // Committed before the server starts: from here on the server may take
  // writes, so no copy ever comes back over the brain, not even where the
  // start or its answer fails (a start that reports failure may have
  // started it, and a server that does not answer health may have taken an
  // MCP write). The next run goes on from `filling`.
  await record("filling", undefined, {
    windows: 1,
    stalled: window.result === "done" || window.embedded > 0 ? 0 : 1,
    ...(window.result === "partial" && window.remaining !== undefined
      ? { remaining: window.remaining }
      : {}),
  });
  const started =
    (await service(host, "daemon-reload")) &&
    (await service(host, "start", brainUnit));
  if (!started) return afterCommit(host, record, "start");
  if ((await answersBy(host, deadline.at)) !== release.version)
    return afterCommit(host, record, "no-answer");
  if (window.result === "done") return switchedOn(host, now);
  // Vectors are left: the server runs with the model and what is computed
  // (search by meaning over it, every new page embedded as it comes); the
  // next run, which the Launchpad starts after a pause, computes the rest.
  await service(host, "start", brainRefreshTimer);
  return "waits:filling";
}

/** A committed window whose server did not start or answer: the brain is
 * kept as it is (the server may have taken writes), the units name the
 * model, and the next run starts it (setup starts a brain that does not
 * answer) and goes on. */
async function afterCommit(
  host: MoveHost,
  record: ReturnType<typeof recorder>,
  reason: string,
): Promise<MeaningResult> {
  await service(host, "start", brainRefreshTimer);
  await record("filling", reason);
  return `waits:${reason}`;
}

/** Search by meaning on: every vector computed. */
async function switchedOn(host: MoveHost, at: Date): Promise<MeaningResult> {
  const { meaningAttempt: _done, ...current } = await readBrainState(
    host.paths,
  );
  await writeBrainState(host.paths, {
    ...current,
    meaning: Object.freeze({
      provider: meaningPin.provider,
      dimensions: meaningPin.dimensions,
      at: at.toISOString(),
    }),
  });
  await service(host, "start", brainRefreshTimer);
  return "on";
}

/** The copy before each window (one, replaced by the next window). */
const windowName = ".gbrain.bak-meaning-window";
/** The brain of the last window that failed, kept for a person (one,
 * replaced by the next failure). */
export const failedWindowName = ".gbrain.failed-meaning-window";

/** One window of the vectors still missing, only while Buddy is idle: the
 * server stopped for at most a window (`meaningWindowMs`) after a copy,
 * then running again with the model. A window that fails brings its copy
 * back and the server with the model; after windows in a row without
 * progress, or too many in all, the filling stops (`restored`: not tried
 * again for this pin) with the vectors computed so far kept. `waits:filling`
 * where vectors are left or Buddy works: the Launchpad runs setup again
 * after a pause (`./at-start.ts`). */
async function fill(
  host: MeaningHost,
  release: Release | undefined,
  attempt: Attempt,
): Promise<MeaningResult> {
  if (release === undefined) return "waits:release-unknown";
  const at = new Date(attempt.at);
  const record = recorder(host, at);
  const window = join(host.paths.home, windowName);
  if ((attempt.windows ?? 0) >= meaningMaxWindows) {
    await record("restored", "embed-windows");
    return "restored:embed-windows";
  }
  // What is left waits for the night, unless one short window computes it.
  const small =
    attempt.remaining !== undefined && attempt.remaining <= meaningSmallChunks;
  if ((await stopDeadline(host, small)) === null) return "waits:night";
  if (!(await host.idle())) return "waits:filling";
  // The whole stop from here on ends by its deadline, read just before it.
  const deadline = await stopDeadline(host, small);
  if (deadline === null) return "waits:night";
  // A copy a run left after its window was committed is not the way back.
  await rm(window, { recursive: true, force: true }).catch(() => undefined);
  const inWindow = { phase: "filling" as const, windowBackup: windowName };
  await record("stopping", undefined, inWindow);
  if (!(await stoppedForSure(host))) {
    await service(host, "start", brainUnit);
    await service(host, "start", brainRefreshTimer);
    await record("filling", "not-stopped");
    return "waits:not-stopped";
  }
  let copyMs: number;
  try {
    copyMs = await copyTimed(host, host.paths.brain, window);
    await chmod(window, 0o700);
  } catch {
    await rm(window, { recursive: true, force: true }).catch(() => undefined);
    await service(host, "start", brainUnit);
    await service(host, "start", brainRefreshTimer);
    await record("filling", "copy");
    return "waits:copy";
  }
  const reserve = reserveAfter(copyMs);
  // A stop and a copy that took the time a window needs: the brain did not
  // change, so the server comes back as it was, and the next run goes on.
  if (planOf(host, deadline, reserve) === null) {
    await rm(window, { recursive: true, force: true }).catch(() => undefined);
    await service(host, "start", brainUnit);
    await service(host, "start", brainRefreshTimer);
    await record("filling", noTime);
    return `waits:${noTime}`;
  }
  await record("started", undefined, inWindow);
  // The pages as stored, with the server stopped (and so no writes).
  const before = await storedPages(
    host,
    release.command,
    stepIn(host, deadline, reserve),
  );
  const plan = before === null ? null : planOf(host, deadline, reserve);
  const result: EmbedWindow =
    before === null
      ? { result: "failed", reason: "page-count" }
      : plan === null
        ? { result: "failed", reason: noTime }
        : await embedWindow(host, release.command, plan);
  const counted = (await readBrainState(host.paths)).meaningAttempt;
  // A window with no time left did not run: it counts neither as a window
  // nor as one without progress.
  const ran = !(result.result === "failed" && result.reason === noTime);
  const windows = (counted?.windows ?? 0) + (ran ? 1 : 0);
  const progressed =
    result.result === "done" ||
    (result.result === "partial" && result.embedded > 0);
  const stalled = progressed ? 0 : (counted?.stalled ?? 0) + (ran ? 1 : 0);
  const back = (reason: string) =>
    restoreCopy(host, release, window, at, reason, {
      failedName: failedWindowName,
      next: async () => {
        if (stalled >= meaningMaxStalled) {
          await record("restored", reason, { windows, stalled });
          return `restored:${reason}`;
        }
        await record("filling", reason, { windows, stalled });
        return `waits:${reason}`;
      },
    });
  if (result.result === "failed") return back(result.reason);
  if (
    (await storedPages(
      host,
      release.command,
      stepIn(host, deadline, startReserveMs),
    )) !== before
  )
    return back("page-count");
  // Committed before the server starts: a run that dies from here on
  // never brings the window's copy back over pages written since; only a
  // server that does not answer (and so took no write) still falls back.
  await record("filling", undefined, {
    windows,
    stalled,
    ...(result.result === "partial" && result.remaining !== undefined
      ? { remaining: result.remaining }
      : {}),
  });
  if (!(await service(host, "start", brainUnit)))
    return afterCommit(host, record, "start");
  if ((await answersBy(host, deadline.at)) !== release.version)
    return afterCommit(host, record, "no-answer");
  await rm(window, { recursive: true, force: true }).catch(() => undefined);
  if (result.result === "done") return switchedOn(host, at);
  await service(host, "start", brainRefreshTimer);
  if (stalled >= meaningMaxStalled) {
    await record("restored", "embed-stalled", { windows, stalled });
    return "restored:embed-stalled";
  }
  return "waits:filling";
}
