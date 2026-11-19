import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { writeDurableFile } from "../update/durable-file";
import { systemctl, unitMarker } from "../update/service-control";
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
import { brainRefreshService, brainRefreshTimer, brainUnit } from "./pin";
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
// ~/.gbrain, then `gbrain embeddings enable` and, where the brain's vector
// column has another width (a brain created without embeddings has 1024),
// `gbrain migrate embeddings --no-embed` to the model's 768, which keeps
// every page and fact. The server then starts with the model, must answer
// with the same page count, and computes the embeddings itself in the
// background (its embed-backfill), the model at a lower priority. If any
// step fails, the copy comes back without the model and the step is not
// tried again for this pin (`held`).

export type MeaningFetch = (
  url: string,
  init?: RequestInit,
) => Promise<Response>;

export type MeaningHost = MoveHost & Readonly<{ fetch: MeaningFetch }>;

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
    `ExecStart=${server} -m ${model} --embeddings --pooling mean -c 2048 -b 2048 -ub 2048 --host 127.0.0.1 --port ${meaningPort}`,
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

/** Whether the model server answers on loopback. */
export async function meaningAnswers(host: MoveHost): Promise<boolean> {
  const answer = await host.http("GET", `${meaningUrl}/health`);
  return answer !== null && answer.status === 200;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForModel(host: MoveHost): Promise<boolean> {
  for (let i = 0; i < (host.tries ?? 60); i++) {
    if (await meaningAnswers(host)) return true;
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
 * facts (`--no-embed`: the server computes the vectors afterwards). */
async function switchOn(
  host: MeaningHost,
  command: string,
): Promise<string | null> {
  const env: Record<string, string> = {
    HOME: host.paths.home,
    GBRAIN_HOME: host.paths.home,
    PATH: host.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    LLAMA_SERVER_BASE_URL: `${meaningUrl}/v1`,
    GBRAIN_EMBED_CONCURRENCY: String(meaningConcurrency),
  };
  const gbrain = async (args: readonly string[]) => {
    const result = await host
      .run([command, ...args], 900_000, env)
      .catch(() => "timeout" as const);
    return result === "timeout"
      ? { ok: false, out: null }
      : { ok: result.exitCode === 0, out: printed(result.stdout) };
  };
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
  if (direct.ok) return null;
  const column = columnWidth(direct.out);
  if (column === null) return "enable";
  if (!(await enable(column)).ok) return "enable";
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
  return migrated.ok ? null : "migrate";
}

/** The model server, and the brain switched on once. */
export async function convergeMeaning(
  host: MeaningHost,
): Promise<MeaningResult> {
  const installed = await installMeaning(host);
  if (typeof installed === "string") return `waits:${installed}`;
  const paths = meaningPaths(host.paths.home);
  try {
    await mkdir(host.paths.units, { recursive: true });
    await writeDurableFile(
      host.paths.units,
      meaningUnit,
      Buffer.from(renderMeaningUnit(installed.server, paths.model)),
    );
  } catch {
    return "waits:unit";
  }
  if (
    !(await service(host, "daemon-reload")) ||
    !(await service(host, "enable", "--now", meaningUnit)) ||
    !(await waitForModel(host))
  )
    return "waits:model";
  const state = await readBrainState(host.paths);
  if (state.meaning?.provider === meaningPin.provider) return "on";
  const attempt = state.meaningAttempt;
  if (attempt?.provider === meaningPin.provider && attempt.result !== "started")
    return attempt.result === "restored"
      ? "held"
      : `stopped:${attempt.reason ?? "unknown"}`;
  if (!(await host.idle())) return "waits-idle";
  const release = state.release;
  if (release === undefined) return "waits:release-unknown";
  const before = await pages(host);
  if (before === null) return "waits:page-count";
  const now = (host.now ?? (() => new Date()))();
  const backup = join(host.paths.home, `.gbrain.bak-meaning-${stampOf(now)}`);
  const record = async (
    result: "started" | "restored" | "stopped",
    reason?: string,
  ) => {
    const current = await readBrainState(host.paths);
    await writeBrainState(host.paths, {
      ...current,
      meaningAttempt: Object.freeze({
        provider: meaningPin.provider,
        result,
        at: now.toISOString(),
        backup: `.gbrain.bak-meaning-${stampOf(now)}`,
        ...(reason === undefined ? {} : { reason }),
      }),
    });
  };
  if (!(await stoppedForSure(host))) {
    await service(host, "start", brainUnit);
    await service(host, "start", brainRefreshTimer);
    return "waits:not-stopped";
  }
  try {
    await cp(host.paths.brain, backup, {
      recursive: true,
      verbatimSymlinks: true,
      preserveTimestamps: true,
      errorOnExist: true,
      force: false,
    });
    await chmod(backup, 0o700);
  } catch {
    await rm(backup, { recursive: true, force: true }).catch(() => undefined);
    await service(host, "start", brainUnit);
    await service(host, "start", brainRefreshTimer);
    return "waits:copy";
  }
  await record("started");
  const fallBack = async (reason: string): Promise<MeaningResult> => {
    // The brain before, without the model: never under a running server.
    if (!(await stoppedForSure(host))) {
      await record("stopped", "not-stopped");
      await keepDown(host);
      return "stopped:not-stopped";
    }
    const failed = join(
      host.paths.home,
      `.gbrain.failed-meaning-${stampOf(now)}`,
    );
    try {
      await rename(host.paths.brain, failed);
      await cp(backup, host.paths.brain, {
        recursive: true,
        verbatimSymlinks: true,
        preserveTimestamps: true,
      });
      await chmod(host.paths.brain, 0o700);
      await writeBrainUnits(host.paths.units, release.command, false);
    } catch {
      await record("stopped", "copy-not-restored");
      await keepDown(host);
      return "stopped:copy-not-restored";
    }
    const back =
      (await service(host, "daemon-reload")) &&
      (await service(host, "start", brainUnit)) &&
      (await answers(host)) === release.version;
    if (!back) {
      await record("stopped", "no-answer");
      await keepDown(host);
      return "stopped:no-answer";
    }
    await service(host, "start", brainRefreshTimer);
    await record("restored", reason);
    return `restored:${reason}`;
  };
  const refused = await switchOn(host, release.command);
  if (refused !== null) return fallBack(refused);
  try {
    await writeBrainUnits(host.paths.units, release.command, true);
  } catch {
    return fallBack("units");
  }
  if (
    !(await service(host, "daemon-reload")) ||
    !(await service(host, "start", brainUnit))
  )
    return fallBack("start");
  if ((await answers(host)) !== release.version) return fallBack("no-answer");
  if ((await pages(host)) !== before) return fallBack("page-count");
  const { meaningAttempt: _done, ...current } = await readBrainState(
    host.paths,
  );
  await writeBrainState(host.paths, {
    ...current,
    meaning: Object.freeze({
      provider: meaningPin.provider,
      dimensions: meaningPin.dimensions,
      at: now.toISOString(),
    }),
  });
  await service(host, "start", brainRefreshTimer);
  // The vault's refresh asks the server, which queues its embed-backfill.
  await service(host, "start", "--no-block", brainRefreshService);
  return "on";
}
