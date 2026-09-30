import { access, constants, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ToolRunner } from "../tools/status";
import { writeDurableFile } from "./durable-file";
import type { ProcessRunner } from "./self-check";
import {
  serviceCommandTimeoutMs,
  serviceEnvironment,
  systemctl,
  unitMarker,
  unitPath,
} from "./service-control";

/** The operator's Codex app-server daemon, started with a hosted Machine
 * (decision F29, docs/update.md "State on disk"). Codex itself — binary,
 * version, updater, configuration, sign-in — is the operator's (root decision
 * 0161, F17): this unit only runs the operator's own `codex app-server daemon
 * start` at boot, so a Codex client connecting over SSH finds the daemon.
 * Nothing here installs, updates or configures Codex, and nothing here ever
 * stops or restarts the daemon: that would end live Codex sessions.
 */
export const codexAppServerUnit = "lazurio-codex-app-server.service";

/** The standard entry of the operator's Codex (decision 0161 point 6), the
 * one the unit runs; `%h` in the unit. */
export const codexEntry = (home: string) =>
  join(home, ".local", "bin", "codex");

/** The unit text, the same bytes for every install base: it names no base
 * and no Folder, so the marker on its first line alone says it is the
 * installer's (an unmarked file of that name is someone else's and is never
 * rewritten), and there is nothing to record in an `[X-Lazurio]` section.
 *
 * - `ConditionFileIsExecutable=`: no Codex, no start and no failure; the
 *   next boot (or `systemctl --user start`) starts it once Codex is there.
 *   Conditions resolve `%h` and follow the link to the standalone release.
 * - `Type=oneshot` + `RemainAfterExit=yes`: `daemon start` detaches the
 *   daemon and exits; the unit stays `active` for what it started.
 * - `KillMode=process`: the daemon's processes (the app-server and Codex's
 *   own pid-update loop) are Codex's to stop, through `ExecStop=`; systemd
 *   does not signal them behind Codex's back when the unit is stopped.
 * - No `Restart=`: Codex supervises its own daemon; a failed start stays
 *   visible as `failed` for `lazurio doctor` instead of looping.
 * - No `PrivateTmp=`: the daemon's socket lives under `/tmp`, where a client
 *   session of the same account must find it.
 * - No ordering against the Launchpad unit: neither needs the other.
 * - `TimeoutStartSec=60`: a first start may copy the daemon package; the
 *   installer's `systemctl` call is bounded by the same minute.
 */
export function renderCodexAppServerUnit(): string {
  return [
    unitMarker,
    "[Unit]",
    "Description=Codex app-server daemon (operator's Codex)",
    "ConditionFileIsExecutable=%h/.local/bin/codex",
    "",
    "[Service]",
    "Type=oneshot",
    "RemainAfterExit=yes",
    "KillMode=process",
    `Environment=PATH=${unitPath}`,
    "ExecStart=%h/.local/bin/codex app-server daemon start",
    "ExecStop=-%h/.local/bin/codex app-server daemon stop",
    "TimeoutStartSec=60",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

/** What `lazurio install --service` did with the Codex unit. Never a reason
 * for the installation to fail: the Launchpad is installed and switched
 * whatever happens here, and `next` says what a person or agent does. */
export type CodexAppServer =
  /** Written (or already identical), enabled and started; a missing Codex
   * skips only the start, by the unit's condition. */
  | Readonly<{ state: "enabled" }>
  /** Not the declared operator of a Machine handover: nothing written. */
  | Readonly<{ state: "skipped-not-hosted" }>
  /** A unit of that name the installer did not write: left unchanged. */
  | Readonly<{ state: "foreign-unit"; next: string }>
  | Readonly<{
      state: "failed";
      step: "unit" | "reload" | "enable" | "start";
      next: string;
    }>;

const foreignNext = `A unit ${codexAppServerUnit} that lazurio install did not write is left unchanged. To have lazurio install manage it, remove that file and run the same install again.`;
const failedNext = `The Codex app-server daemon is not set up to start with this Environment; the Launchpad is not affected. Read systemctl --user status ${codexAppServerUnit}, then run the same install again.`;

export const codexAppServerFailed = (
  step: "unit" | "reload" | "enable" | "start",
): CodexAppServer => Object.freeze({ state: "failed", step, next: failedNext });

/** After the Launchpad unit is in place: write the unit when its text
 * differs (then reread the manager), enable it and start it. `start` of an
 * active unit changes nothing, so a repeated install or an offline update
 * never touches a running daemon; there is no `restart` or `stop` here. */
export async function installCodexAppServer(
  input: Readonly<{
    directory: string;
    hosted: boolean;
    run: ProcessRunner;
    env: Readonly<Record<string, string | undefined>>;
  }>,
): Promise<CodexAppServer> {
  if (!input.hosted) return Object.freeze({ state: "skipped-not-hosted" });
  const failed = codexAppServerFailed;
  const command = { run: input.run, env: input.env };
  const text = renderCodexAppServerUnit();
  try {
    const existing = await readFile(
      join(input.directory, codexAppServerUnit),
      "utf8",
    ).catch((error: NodeJS.ErrnoException) => {
      if (error?.code === "ENOENT") return undefined;
      throw error;
    });
    if (existing !== undefined && !existing.startsWith(unitMarker))
      return Object.freeze({ state: "foreign-unit", next: foreignNext });
    if (existing !== text) {
      await writeDurableFile(
        input.directory,
        codexAppServerUnit,
        Buffer.from(text),
      );
      if (!(await systemctl(command, "daemon-reload"))) return failed("reload");
    }
  } catch {
    return failed("unit");
  }
  if (!(await systemctl(command, "enable", codexAppServerUnit)))
    return failed("enable");
  if (!(await systemctl(command, "start", codexAppServerUnit)))
    return failed("start");
  return Object.freeze({ state: "enabled" });
}

// ---- Observation, for `lazurio doctor` --------------------------------------

/** How the Codex daemon of this Environment is, in doctor's terms: `ok`,
 * `warn` with a reason, or `skipped` with a reason. Never `fail`: the
 * daemon is the operator's and a Codex client's, not the product's. */
export type CodexAppServerObservation = Readonly<{
  outcome: "ok" | "warn" | "skipped";
  reason?: string;
  context?: Readonly<Record<string, string>>;
}>;

export const codexAppServerReasons = [
  "codex-missing",
  "daemon-not-running",
  "daemon-state-unknown",
] as const;

const daemonTimeoutMs = 10_000;

async function executable(path: string): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) return false;
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The first line of the output that is a JSON object, or the whole. */
function statusOf(output: string): unknown {
  for (const candidate of [output, ...output.split("\n")]) {
    try {
      const value = JSON.parse(candidate.trim()) as { status?: unknown };
      if (value !== null && typeof value === "object") return value.status;
    } catch {}
  }
  return undefined;
}

/** Read-only: `systemctl --user show` of the unit and, when it is active,
 * `codex app-server daemon version` (which asks the daemon and starts
 * nothing), bounded. Skipped where the unit cannot be there: no user
 * manager, an unsupervised installation, not a hosted Machine, no Codex at
 * its standard entry. `hosted` is asked only when the rest holds. */
export async function observeCodexAppServer(
  input: Readonly<{
    platform: string;
    env: Readonly<Record<string, string | undefined>>;
    supervised: boolean;
    hosted: () => Promise<boolean>;
    run: ProcessRunner;
    tools: Readonly<{
      path: string | undefined;
      home: string | undefined;
      run: ToolRunner;
    }>;
  }>,
): Promise<CodexAppServerObservation> {
  const skipped = (reason: string) =>
    Object.freeze({ outcome: "skipped" as const, reason });
  const warn = (reason: string, context?: Record<string, string>) =>
    Object.freeze({
      outcome: "warn" as const,
      reason,
      ...(context === undefined ? {} : { context: Object.freeze(context) }),
    });
  if (input.platform !== "linux" || !input.env.XDG_RUNTIME_DIR)
    return skipped("no-user-manager");
  if (!input.supervised) return skipped("not-supervised");
  if (!(await input.hosted().catch(() => false))) return skipped("not-hosted");
  const home = input.env.HOME;
  const codex = home === undefined ? undefined : codexEntry(home);
  if (codex === undefined || !(await executable(codex)))
    return skipped("codex-missing");

  const shown = await input
    .run(
      [
        "systemctl",
        "--user",
        "show",
        "--property=LoadState,ActiveState,SubState,Result",
        "--",
        codexAppServerUnit,
      ],
      serviceCommandTimeoutMs,
      serviceEnvironment(input.env),
    )
    .catch(() => "timeout" as const);
  if (shown === "timeout" || shown.exitCode !== 0)
    return skipped("user-manager-unreachable");
  const properties = new Map<string, string>();
  for (const line of shown.stdout.split("\n")) {
    const split = line.indexOf("=");
    if (split > 0) properties.set(line.slice(0, split), line.slice(split + 1));
  }
  const unit = {
    activeState: properties.get("ActiveState") ?? "unknown",
    subState: properties.get("SubState") ?? "unknown",
    result: properties.get("Result") ?? "unknown",
  };
  if (properties.get("LoadState") === "not-found")
    return warn("unit-not-loaded");
  switch (unit.activeState) {
    case "active":
      break;
    case "failed":
      return warn("unit-failed", unit);
    case "inactive":
    case "deactivating":
      return warn("unit-inactive", unit);
    default:
      return skipped("unit-state-unknown");
  }

  // The unit stays active after its start; whether the daemon still runs is
  // Codex's answer.
  const env: Record<string, string> = {};
  if (input.tools.path) env.PATH = input.tools.path;
  if (input.tools.home) env.HOME = input.tools.home;
  const answer = await input.tools
    .run([codex, "app-server", "daemon", "version"], daemonTimeoutMs, env)
    .catch(() => "timeout" as const);
  const status =
    answer === "timeout" ? undefined : statusOf(answer.stdout.trim());
  if (status === "running") return Object.freeze({ outcome: "ok" as const });
  return warn(
    status === "notRunning" ? "daemon-not-running" : "daemon-state-unknown",
  );
}
