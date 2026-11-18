import { stat } from "node:fs/promises";
import { join } from "node:path";
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
import { brainPin, brainUnit, brainUrl, releaseCommand } from "./pin";
import { type BrainHost, type BrainStatus, brainStatus } from "./status";
import { writeBrainUnits } from "./units";
import { convergeVault, type VaultResult } from "./vault";

// `lazurio brain setup`: brings the person's brain to Lazurio's care. What
// this step does, by what is there (`brainStatus`):
//   not-installed  install the pinned release, create the brain (PGLite, no
//                  embeddings), its owner credential, Lazurio's units; start
//   not-running    start Lazurio's unit
//   running        nothing to start
//   outdated       left for the move to the pin (a later step of R11a)
//   adoptable      the interim installer's brain: only reported until its
//                  owner switches the takeover on (a later step of R11a)
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
      idle: () => Promise<boolean>;
    }>;
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
    | "waits-move"
    | "waits-takeover"
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
  /** The vault's connection, wherever Lazurio's server answers. */
  vault?: VaultResult;
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

export async function brainSetup(host: SetupHost): Promise<SetupResult> {
  const status = await brainStatus(host);
  const command = { run: host.service, env: host.env };
  const { paths } = host;
  switch (status.state) {
    case "unsupported":
      return Object.freeze({ server: "unsupported", status });
    case "machines":
      return Object.freeze({ server: "machines", status });
    case "foreign":
      return Object.freeze({ server: "foreign", status });
    case "adoptable":
      return Object.freeze({ server: "waits-takeover", status });
    case "outdated":
      return Object.freeze({ server: "waits-move", status });
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
  server: "installed" | "started" | "running",
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
      idle: host.vault.idle,
      ...(host.tries === undefined ? {} : { tries: host.tries }),
      ...(host.waitMs === undefined ? {} : { waitMs: host.waitMs }),
    });
    if (vault === "rebuilt" || vault.startsWith("stop:rebuild-"))
      keys = await convergeBrainKeys({ paths, http: host.http, base });
  }
  return Object.freeze({
    server,
    keys: keys.outcomes,
    ...(vault === undefined ? {} : { vault }),
    status: await brainStatus(host),
  });
}
