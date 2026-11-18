import { chmod, cp, lstat, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ToolRunner } from "../tools/status";
import type { ProcessRunner } from "../update/self-check";
import { systemctl } from "../update/service-control";
import { type BrainHttp, healthVersion, keyWorks, mcpTool } from "./admin";
import { installPinnedRelease } from "./install";
import {
  type BrainState,
  type MoveRecord,
  readBrainState,
  writeBrainState,
} from "./keys";
import {
  type BrainPaths,
  brainPin,
  brainRefreshTimer,
  brainUnit,
  releaseCommand,
} from "./pin";
import { writeBrainUnits } from "./units";

// The brain from the release it runs to the pin, with a copy and a way back:
// the move of HumanAndMachine-ai/Machines#1337 (`GbrainMove`), on Lazurio's
// own units. gbrain's migrations only go forward, so a pin reaches the brain
// only through this move, never through a start: the units name the release
// the brain ran until the copy is taken.
//   1. Only while Buddy is idle, with the pinned release installed beside the
//      one running and the page count read.
//   2. The refresh timer and the server stop, and systemd must confirm it:
//      a brain is never copied or moved under a running server.
//   3. A copy of ~/.gbrain; the record `moving` is on disk before the units
//      name the pin, so a run that dies is finished by the next one.
//   4. The pin starts and must answer with its version, the same page count
//      and working keys; then the timer starts again (`done`).
//   5. Otherwise the way back: the attempt is kept aside, the copy comes
//      back, the previous release starts (`held`, not tried again for this
//      pin). Where even that fails, the server stays stopped and disabled,
//      so not a reboot starts it, and a person decides (`stopped:…`).

export type MoveHost = Readonly<{
  paths: BrainPaths;
  run: ToolRunner;
  service: ProcessRunner;
  http: BrainHttp;
  base: string;
  bun: string;
  env: Readonly<Record<string, string | undefined>>;
  idle: () => Promise<boolean>;
  now?: () => Date;
  tries?: number;
  waitMs?: number;
}>;

export type MoveResult =
  | "moved"
  | "held"
  | "waits-idle"
  | `waits:${string}`
  | `stopped:${string}`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const present = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  );

const service = (host: MoveHost, ...args: string[]) =>
  systemctl({ run: host.service, env: host.env }, ...args);

async function inactive(host: MoveHost, unit: string): Promise<boolean> {
  const answer = await host
    .service(["systemctl", "--user", "is-active", unit], 60_000)
    .catch(() => "timeout" as const);
  // Only a successful read of a stopped state counts as stopped.
  return (
    answer !== "timeout" &&
    ["inactive", "failed", "unknown"].includes(answer.stdout.trim())
  );
}

/** The timer and the server stopped, as systemd confirms it. */
async function stoppedForSure(host: MoveHost): Promise<boolean> {
  for (const unit of [brainRefreshTimer, brainUnit])
    await service(host, "stop", unit);
  for (const unit of [brainRefreshTimer, brainUnit])
    if (!(await inactive(host, unit))) return false;
  return true;
}

/** Disabled and stopped, as systemd confirms it: not even a reboot starts
 * the server (the timer's service requires it and would start it too). */
export async function keepDown(host: MoveHost): Promise<boolean> {
  for (const unit of [brainRefreshTimer, brainUnit])
    await service(host, "disable", "--now", unit);
  for (const unit of [brainRefreshTimer, brainUnit]) {
    const enabled = await host
      .service(["systemctl", "--user", "is-enabled", unit], 60_000)
      .catch(() => "timeout" as const);
    if (
      enabled === "timeout" ||
      !["disabled", "masked", "not-found"].includes(enabled.stdout.trim())
    )
      return false;
    if (!(await inactive(host, unit))) return false;
  }
  return true;
}

async function answers(host: MoveHost): Promise<string | null> {
  for (let i = 0; i < (host.tries ?? 450); i++) {
    const version = await healthVersion(host.http, host.base);
    if (version !== null) return version;
    await sleep(host.waitMs ?? 2000);
  }
  return null;
}

async function handedOver(path: string): Promise<string | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as {
      token?: unknown;
    };
    return typeof value.token === "string" ? value.token : undefined;
  } catch {
    return undefined;
  }
}

/** The page count the probe key reads over MCP; null when it does not. */
async function pages(host: MoveHost): Promise<number | null> {
  const token = await handedOver(host.paths.probeKey);
  if (token === undefined) return null;
  const identity = await mcpTool(
    host.http,
    host.base,
    token,
    "get_brain_identity",
  );
  return identity !== null && Number.isInteger(identity.page_count)
    ? (identity.page_count as number)
    : null;
}

/** Why the pin is not accepted, or null: it answers with its version, the
 * page count before and every key handed over. */
async function refusal(host: MoveHost, before: number): Promise<string | null> {
  const version = await answers(host);
  if (version === null) return "no-answer";
  if (version !== brainPin.version) return "other-version";
  if ((await pages(host)) !== before) return "page-count";
  for (const path of [
    host.paths.launchpadKey,
    host.paths.executorKey,
    host.paths.probeKey,
  ]) {
    const token = await handedOver(path);
    if (token !== undefined && !(await keyWorks(host.http, host.base, token)))
      return "key";
  }
  return null;
}

const stampOf = (now: Date) =>
  now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");

class Move {
  record: MoveRecord;
  constructor(
    readonly host: MoveHost,
    readonly state: BrainState,
    record: MoveRecord,
  ) {
    this.record = record;
  }

  now() {
    return (this.host.now ?? (() => new Date()))();
  }

  async persist(change: Partial<MoveRecord>) {
    this.record = Object.freeze({ ...this.record, ...change }) as MoveRecord;
    const current = await readBrainState(this.host.paths);
    await writeBrainState(this.host.paths, { ...current, move: this.record });
  }

  get backup() {
    return join(this.host.paths.home, this.record.backup as string);
  }

  async stayStopped(reason: string): Promise<MoveResult> {
    const result = `stopped:${reason}` as const;
    await this.persist({ result });
    // The next run asserts this again where it fails now.
    await keepDown(this.host);
    return result;
  }

  async finish(): Promise<MoveResult> {
    await service(this.host, "start", brainRefreshTimer);
    const current = await readBrainState(this.host.paths);
    await writeBrainState(this.host.paths, {
      ...current,
      move: Object.freeze({ ...this.record, result: "done" as const }),
      release: Object.freeze({
        commit: brainPin.commit,
        version: brainPin.version,
        command: releaseCommand(this.host.paths, brainPin.commit),
        source: "lazurio" as const,
      }),
    });
    return "moved";
  }

  /** The previous release, on the copy where the attempt touched the
   * brain; else the server stays stopped. */
  async fallBack(reason: string, restore: boolean): Promise<MoveResult> {
    const { host } = this;
    const previous = this.record.previous;
    await this.persist({ reason });
    if (!(await stoppedForSure(host))) {
      // Never move a database a server may still hold.
      await this.persist({ brainIntact: !restore });
      return this.stayStopped("not-stopped");
    }
    if (restore) {
      // On disk, and nothing left to start at boot, before the brain is
      // touched: whatever happens next, nothing starts the pin on the copy.
      await this.persist({ result: "stopped:restoring", brainIntact: false });
      if (!(await keepDown(host))) return this.stayStopped("not-disabled");
      const at = this.record.backup?.replace(/^\.gbrain\.bak-move-/, "") ?? "";
      const failed = join(host.paths.home, `.gbrain.failed-move-${at}`);
      const restoring = join(host.paths.home, `.gbrain.restoring-move-${at}`);
      try {
        await rename(host.paths.brain, failed);
        await this.persist({ failedAttempt: `.gbrain.failed-move-${at}` });
        await cp(this.backup, restoring, {
          recursive: true,
          verbatimSymlinks: true,
          preserveTimestamps: true,
        });
        await chmod(restoring, 0o700);
        await rename(restoring, host.paths.brain);
      } catch {
        // The copy and the attempt stay as they are for a person.
        await rm(restoring, { recursive: true, force: true }).catch(
          () => undefined,
        );
        return this.stayStopped("copy-not-restored");
      }
      await this.persist({ brainIntact: true });
    }
    if (previous === undefined || !(await present(previous.command)))
      // Without the previous release the pin would migrate the copy again.
      return this.stayStopped("previous-missing");
    try {
      await writeBrainUnits(host.paths.units, previous.command);
    } catch {
      return this.stayStopped("units");
    }
    const back =
      (await service(host, "daemon-reload")) &&
      (await service(host, "enable", brainUnit)) &&
      (await service(host, "start", brainUnit)) &&
      (await answers(host)) === previous.version;
    if (!back) {
      await service(host, "stop", brainUnit);
      return this.stayStopped("previous-no-answer");
    }
    await service(host, "enable", "--now", brainRefreshTimer);
    await this.persist({ result: "held" });
    return "held";
  }

  async move(): Promise<MoveResult> {
    const { host } = this;
    if (!(await stoppedForSure(host))) {
      // The server keeps running where it was: nothing moved, try later.
      await service(host, "start", brainUnit);
      await service(host, "start", brainRefreshTimer);
      await this.persist({ result: "waits:not-stopped" });
      return "waits:not-stopped";
    }
    try {
      await cp(host.paths.brain, this.backup, {
        recursive: true,
        verbatimSymlinks: true,
        preserveTimestamps: true,
        errorOnExist: true,
        force: false,
      });
      await chmod(this.backup, 0o700);
    } catch {
      // No copy, no move: the brain was not touched.
      await rm(this.backup, { recursive: true, force: true }).catch(
        () => undefined,
      );
      return this.fallBack("copy", false);
    }
    // From here on this pin's attempt, on disk before the units move.
    await this.persist({ result: "moving", brainIntact: true });
    try {
      await writeBrainUnits(
        host.paths.units,
        releaseCommand(host.paths, brainPin.commit),
      );
    } catch {
      return this.fallBack("units", true);
    }
    if (
      !(await service(host, "daemon-reload")) ||
      !(await service(host, "enable", brainUnit)) ||
      !(await service(host, "start", brainUnit))
    )
      return this.fallBack("start", true);
    const reason = await refusal(host, this.record.pages as number);
    return reason === null ? this.finish() : this.fallBack(reason, true);
  }

  /** A run died after the units moved to the pin: the pin is accepted only
   * once it answers as the move requires; else the copy comes back. */
  async resume(): Promise<MoveResult> {
    const { host } = this;
    await service(host, "stop", brainRefreshTimer);
    const copy =
      this.record.backup !== undefined && (await present(this.backup));
    if (this.record.to !== brainPin.commit || !copy)
      return this.fallBack("interrupted", copy);
    if (
      !(await service(host, "enable", brainUnit)) ||
      !(await service(host, "start", brainUnit))
    )
      return this.fallBack("interrupted-start", true);
    const reason = await refusal(host, this.record.pages as number);
    return reason === null
      ? this.finish()
      : this.fallBack(`interrupted-${reason}`, true);
  }
}

/** Whether a stopped move keeps the server down: always, for this pin and
 * any later one, until a person decides. Its units may name a release that
 * would migrate the copy, so neither a start nor a newer pin touches it. */
export function moveKeepsDown(state: BrainState): boolean {
  return state.move?.result.startsWith("stopped:") === true;
}

/** Moves Lazurio's running brain from `running` (not the pin) to the pin. */
export async function moveToPin(
  host: MoveHost,
  running: string,
): Promise<MoveResult> {
  const state = await readBrainState(host.paths);
  const last = state.move;
  if (last?.result === "moving") return new Move(host, state, last).resume();
  if (moveKeepsDown(state)) {
    await keepDown(host);
    return last?.result as `stopped:${string}`;
  }
  if (last?.to === brainPin.commit && last.result === "held") return "held";
  if (!(await host.idle())) return "waits-idle";
  const release = state.release;
  if (release === undefined || release.version !== running)
    return "waits:release-unknown";
  // The pin beside the release that runs, before anything stops.
  if (
    (await installPinnedRelease({
      paths: host.paths,
      run: host.run,
      bun: host.bun,
      path: host.env.PATH,
    })) === "failed"
  )
    return "waits:install";
  const before = await pages(host);
  if (before === null) return "waits:page-count";
  const now = (host.now ?? (() => new Date()))();
  let stamp = stampOf(now);
  for (let n = 1; ; n++) {
    const taken = await Promise.all(
      ["bak", "failed"].map((kind) =>
        present(join(host.paths.home, `.gbrain.${kind}-move-${stamp}`)),
      ),
    );
    if (!taken.includes(true)) break;
    stamp = `${stampOf(now)}.${n}`;
  }
  const record: MoveRecord = Object.freeze({
    to: brainPin.commit,
    from: running,
    at: now.toISOString(),
    result: "waits:starting",
    pages: before,
    backup: `.gbrain.bak-move-${stamp}`,
    previous: Object.freeze({
      command: release.command,
      version: release.version,
      commit: release.commit,
    }),
  });
  const move = new Move(host, state, record);
  await move.persist({});
  return move.move();
}
