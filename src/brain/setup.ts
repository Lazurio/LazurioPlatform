import { mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { acquireFileLock, type FileLock } from "../platform/flock";
import type { ToolRunner } from "../tools/status";
import type { ProcessRunner } from "../update/self-check";
import { systemctl } from "../update/service-control";
import { type BrainHttp, healthVersion } from "./admin";
import { ensureAdminToken, installPinnedRelease } from "./install";
import {
  type BrainKeyKind,
  convergeBrainKeys,
  type KeyOutcome,
  readBrainState,
  writeBrainState,
} from "./keys";
import {
  convergeMeaning,
  type MeaningFetch,
  type MeaningResult,
} from "./meaning";
import { type MoveResult, moveKeepsDown, moveToPin } from "./move";
import { brainPin, brainUnit, brainUrl, releaseCommand } from "./pin";
import { type BrainHost, type BrainStatus, brainStatus } from "./status";
import { type TakeoverResult, takeOverInterim } from "./takeover";
import { writeBrainUnits } from "./units";
import { convergeVault, type VaultResult } from "./vault";

// `lazurio brain setup`: brings the person's brain to Lazurio's care. What
// this step does, by what is there (`brainStatus`):
//   not-installed  install the pinned release, create the brain (PGLite, no
//                  embeddings), its owner credential, Lazurio's units; start
//   not-running    start Lazurio's unit
//   running        nothing to start
//   outdated       the move to the pin with its copy and way back
//                  (`./move.ts`), only while Buddy is idle
//   adoptable      the interim installer's brain: reported until its owner
//                  switches the takeover on (`lazurio brain take-over`), then
//                  taken over in place (`./takeover.ts`) and moved to the pin
//   machines       Machines' brain on a free Environment: theirs, reported
//   foreign        a unit nobody of these wrote: left alone
// and then, wherever Lazurio's server answers, the three keys and the
// vault's connection (`./vault.ts`; a brain made anew on the vault gets its
// keys again). It prints
// closed labels only; no token, handover or path of the person's.

export type SetupHost = BrainHost &
  Readonly<{
    run: ToolRunner;
    service: ProcessRunner;
    http: BrainHttp;
    bun: string;
    env: Readonly<Record<string, string | undefined>>;
    /** What the vault's connection needs: the Folder, the person's gh and
     * whether Buddy is idle. Without it the vault is left as it is. */
    vault?: Readonly<{
      folder: string;
      gh: string | undefined;
    }>;
    /** Whether Buddy is idle, so the server may stop for a moment (a
     * vault's rebuild, a move). Without it, it never stops. */
    idle?: () => Promise<boolean>;
    /** Where the model of search by meaning is downloaded from. Without it
     * the brain stays on keyword search. */
    fetch?: MeaningFetch;
    now?: () => Date;
    /** The server's base URL (tests point it at a stand-in). */
    base?: string;
    /** How long to wait for the server to answer, in tries of `waitMs`. */
    tries?: number;
    waitMs?: number;
  }>;

export type SetupResult = Readonly<{
  /** What setup did with the server. */
  server:
    | "unsupported"
    | "installed"
    | "started"
    | "running"
    | "moved"
    | "held"
    | "stopped"
    | "waits-move"
    | "waits-takeover"
    | "takeover-refused"
    | "busy"
    | "waits-machines"
    | "machines"
    | "foreign"
    | "failed";
  /** Where it stopped, when `failed`. */
  step?:
    | "install"
    | "init"
    | "credential"
    | "units"
    | "reload"
    | "enable"
    | "start"
    | "answer";
  keys?: Readonly<Record<BrainKeyKind, KeyOutcome>>;
  takeover?: TakeoverResult;
  move?: MoveResult;
  /** The vault's connection, wherever Lazurio's server answers. */
  vault?: VaultResult;
  /** Search by meaning, where the brain runs the pin. */
  meaning?: MeaningResult;
  status: BrainStatus;
}>;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function answers(host: SetupHost): Promise<boolean> {
  for (let i = 0; i < (host.tries ?? 60); i++) {
    if ((await healthVersion(host.http, host.base ?? brainUrl)) !== null)
      return true;
    await sleep(host.waitMs ?? 1000);
  }
  return false;
}

const failed = (
  step: NonNullable<SetupResult["step"]>,
  status: BrainStatus,
): SetupResult => Object.freeze({ server: "failed", step, status });

const idleOf = (host: SetupHost) => host.idle ?? (async () => false);

const moveHost = (host: SetupHost) => ({
  paths: host.paths,
  run: host.run,
  service: host.service,
  http: host.http,
  base: host.base ?? brainUrl,
  bun: host.bun,
  env: host.env,
  idle: idleOf(host),
  ...(host.now === undefined ? {} : { now: host.now }),
  ...(host.tries === undefined ? {} : { tries: host.tries }),
  ...(host.waitMs === undefined ? {} : { waitMs: host.waitMs }),
});

/** The move to the pin and what follows it. */
async function move(
  host: SetupHost,
  running: string,
  takeover?: TakeoverResult,
): Promise<SetupResult> {
  const moved = await moveToPin(moveHost(host), running);
  const extra = { move: moved, ...(takeover ? { takeover } : {}) };
  if (moved.startsWith("stopped:"))
    return Object.freeze({
      server: "stopped",
      ...extra,
      status: await brainStatus(host),
    });
  return finish(
    host,
    moved === "moved" ? "moved" : moved === "held" ? "held" : "waits-move",
    extra,
  );
}

/** One run at a time: the Launchpad's start, `lazurio brain setup` and
 * `take-over` may meet, and two runs would mint, revoke, move or take over
 * against each other. A kernel lock beside Lazurio's state, released when its
 * holder ends or dies; a run that finds it held changes nothing (`busy`). */
export async function brainSetup(host: SetupHost): Promise<SetupResult> {
  if ((await host.context()).kind === "unsupported")
    return Object.freeze({
      server: "unsupported",
      status: await brainStatus(host),
    });
  let lock: FileLock;
  try {
    await mkdir(dirname(host.paths.state), { recursive: true, mode: 0o700 });
    lock = await acquireFileLock(
      join(dirname(host.paths.state), "setup.lock"),
      {
        timeoutMs: 0,
      },
    );
  } catch {
    return Object.freeze({ server: "busy", status: await brainStatus(host) });
  }
  try {
    return await setupOnce(host);
  } finally {
    await lock.release();
  }
}

async function setupOnce(host: SetupHost): Promise<SetupResult> {
  const status = await brainStatus(host);
  // One manager of the Launchpad's key in any order of deployment: until
  // Machines mark that they hand the brain over on this host (C1), they may
  // still mint it here, so Lazurio installs, takes over and mints nothing.
  if (status.state !== "unsupported" && !status.handover)
    return Object.freeze({ server: "waits-machines", status });
  if (status.state !== "unsupported") {
    const state = await readBrainState(host.paths);
    // A move that stopped stays stopped until a person decides; one a run
    // left half way is finished before anything else starts.
    if (state.move?.result === "moving") return move(host, "");
    if (moveKeepsDown(state)) return move(host, status.running ?? "");
  }
  const command = { run: host.service, env: host.env };
  const { paths } = host;
  switch (status.state) {
    case "unsupported":
      return Object.freeze({ server: "unsupported", status });
    case "machines":
      return Object.freeze({ server: "machines", status });
    case "foreign":
      return Object.freeze({ server: "foreign", status });
    case "adoptable": {
      const takeover = await takeOverInterim({
        paths,
        service: host.service,
        http: host.http,
        base: host.base ?? brainUrl,
        env: host.env,
        ...(host.now === undefined ? {} : { now: host.now }),
      });
      if (takeover !== "taken-over")
        return Object.freeze({
          server:
            takeover === "waits-consent"
              ? "waits-takeover"
              : "takeover-refused",
          takeover,
          status,
        });
      const after = await brainStatus(host);
      if (after.state === "outdated" && after.running !== null)
        return move(host, after.running, takeover);
      return finish(host, "running", { takeover });
    }
    case "outdated":
      return move(host, status.running as string);
    case "running":
      break;
    case "not-running":
      if (
        !(await systemctl(command, "start", brainUnit)) ||
        !(await answers(host))
      )
        return failed("start", status);
      break;
    case "not-installed": {
      if (
        (await installPinnedRelease({
          paths,
          run: host.run,
          bun: host.bun,
          path: host.env.PATH,
        })) === "failed"
      )
        return failed("install", status);
      const release = releaseCommand(paths, brainPin.commit);
      const hasBrain = await stat(join(paths.brain, "config.json")).then(
        () => true,
        () => false,
      );
      if (!hasBrain) {
        const init = await host
          .run(
            [
              release,
              "init",
              "--pglite",
              "--no-embedding",
              "--non-interactive",
            ],
            300_000,
            {
              HOME: paths.home,
              GBRAIN_HOME: paths.home,
              PATH: host.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
            },
          )
          .catch(() => "timeout" as const);
        if (init === "timeout" || init.exitCode !== 0)
          return failed("init", status);
      }
      try {
        await ensureAdminToken(paths);
      } catch {
        return failed("credential", status);
      }
      try {
        await writeBrainUnits(paths.units, release);
      } catch {
        return failed("units", status);
      }
      if (!(await systemctl(command, "daemon-reload")))
        return failed("reload", status);
      if (!(await systemctl(command, "enable", brainUnit)))
        return failed("enable", status);
      if (
        !(await systemctl(command, "start", brainUnit)) ||
        !(await answers(host))
      )
        return failed("start", status);
      const state = await readBrainState(paths);
      await writeBrainState(paths, {
        ...state,
        release: {
          commit: brainPin.commit,
          version: brainPin.version,
          command: release,
          source: "lazurio",
        },
      });
      return finish(host, "installed");
    }
  }
  return finish(host, status.state === "not-running" ? "started" : "running");
}

/** Lazurio's server answers: the keys, the vault, and the keys again where
 * the vault's connection made the brain anew (it has no key then). */
async function finish(
  host: SetupHost,
  server: "installed" | "started" | "running" | "moved" | "held" | "waits-move",
  extra: Readonly<{ takeover?: TakeoverResult; move?: MoveResult }> = {},
): Promise<SetupResult> {
  const { paths } = host;
  const base = host.base ?? brainUrl;
  let keys = await convergeBrainKeys({ paths, http: host.http, base });
  let vault: VaultResult | undefined;
  if (host.vault !== undefined) {
    const state = await readBrainState(paths);
    vault = await convergeVault({
      paths,
      folder: host.vault.folder,
      command: state.release?.command ?? releaseCommand(paths, brainPin.commit),
      gh: host.vault.gh,
      run: host.run,
      service: host.service,
      http: host.http,
      base,
      env: host.env,
      idle: idleOf(host),
      ...(host.tries === undefined ? {} : { tries: host.tries }),
      ...(host.waitMs === undefined ? {} : { waitMs: host.waitMs }),
    });
    if (vault === "rebuilt" || vault.startsWith("stop:rebuild-"))
      keys = await convergeBrainKeys({ paths, http: host.http, base });
  }
  // Search by meaning only on the pin: a brain held on an earlier release
  // moves first.
  const meaning =
    host.fetch !== undefined && server !== "held" && server !== "waits-move"
      ? await convergeMeaning({ ...moveHost(host), fetch: host.fetch })
      : undefined;
  return Object.freeze({
    server,
    ...extra,
    keys: keys.outcomes,
    ...(vault === undefined ? {} : { vault }),
    ...(meaning === undefined ? {} : { meaning }),
    status: await brainStatus(host),
  });
}
