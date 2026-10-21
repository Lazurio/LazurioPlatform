import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { browserDisplay, displayUnit } from "../browser/units";
import {
  type AgentMcpServer,
  type AgentsFacts,
  ensureAgentMcp,
  observeAgentMcp,
  removeAgentMcp,
} from "../tools/agent-mcp";
import { runTool, type ToolRunner } from "../tools/status";
import { writeDurableFile } from "../update/durable-file";
import type { ProcessRunner } from "../update/self-check";
import {
  detectServiceControl,
  serviceCommandTimeoutMs,
  serviceEnvironment,
  systemctl,
  unitMarker,
  userUnitDirectory,
} from "../update/service-control";

/** Computer Use of a Remote Environment (decision F59, root decision 0191
 * points 8 and 42): every agent of the Environment, a thread of T3 Code as
 * well as a bot of Lazurio MausBot, works the programs on the Environment's
 * one screen (`:1`, the Environment browser's display) through one MCP server
 * named `computer`. It is a service of the Environment, not of one agent:
 * one daemon of the Cua Driver on the screen, run by the installer's user
 * unit, and the driver's own MCP proxy (`cua-driver mcp --socket`) as the
 * agents' entry, registered the way Executor's is (`../tools/agent-mcp`).
 * Machines delivers the pinned driver and the accessibility packages; the
 * Platform owns what runs and who is told. Agents take turns on the screen:
 * one mouse, one keyboard. */
export const computerUnit = "lazurio-computer.service";

/** The MCP server's name in Codex and Claude Code. */
export const computerServerName = "computer";

/** The Cua Driver release the Platform runs and Machines installs: the one
 * Lazurio MausBot's fork vetted (`third_party/cua-driver/README.md` of
 * Lazurio/OpenMausBot, upstream commit a1672e7b, the Linux x86_64 archive's
 * SHA-256 `3db9d425…5b10`, the driver's `ed5844fa…b4ac`). */
export const cuaDriverVersion = "0.19.3";

/** Where Machines installs the driver: the operator's `~/.local/bin`, like
 * every pinned tool of its resident toolchain (`resident-toolchain.json`). */
export const cuaDriverPath = (home: string) =>
  join(home, ".local", "bin", "cua-driver");

/** The daemon's socket, in the operator's home so the agents' entry names
 * it without a runtime directory: the driver creates the directory, removes
 * a stale socket before it binds and keeps the socket owner-only (0600). */
export const computerSocket = (home: string) =>
  join(home, ".local", "state", "lazurio-computer", "driver.sock");

/** The driver's own switches: no telemetry, no update check. Both are on by
 * default, and both the daemon (`serve`) and each agent's proxy (`mcp`)
 * report telemetry and check for an update when they start, so the daemon,
 * every proxy and doctor's run of the driver carry both. The names and the
 * values are the driver's at the pinned commit a1672e7b: `telemetry.rs`
 * `ENV_TELEMETRY_ENABLED` and `version_check.rs` `ENV_UPDATE_CHECK`, each
 * read by `parse_env_bool`, where `0`, `false`, `no` and `off` mean off;
 * an environment value wins over the persisted preference. */
export const driverSettings = Object.freeze([
  "CUA_DRIVER_RS_TELEMETRY_ENABLED=0",
  "CUA_DRIVER_RS_UPDATE_CHECK=0",
]);

/** The agents' entry: the driver's MCP proxy to the one daemon. An agent
 * never starts a runtime of its own: on Linux `cua-driver mcp` without
 * `--socket` would own one in its own process. */
export const computerMcpServer = (home: string): AgentMcpServer =>
  Object.freeze({
    name: computerServerName,
    command: cuaDriverPath(home),
    args: Object.freeze(["mcp", "--socket", computerSocket(home)]),
    env: driverSettings,
  });

/** The daemon on the screen. Bound to the screen like the browser.
 * - The driver itself is the condition: without it the unit is skipped, not
 *   failed, and the browser and everything else run as before.
 * - `serve` standalone: `--embedded` with its liveness pipe belongs to a
 *   host app that owns the daemon, and would end it at once under systemd.
 * - `--no-overlay`: the agent's cursor is a full-screen X11 window, which
 *   on a screen without a compositor would cover every program.
 * - `--permission-mode standard`, the driver's default, written out: the
 *   agent's own harness asks for approval where its mode asks.
 * - The session bus of the user manager (dbus-user-session), where the
 *   AT-SPI bus (at-spi2-core) is activated: the driver reads programs'
 *   accessibility trees through it. */
export function renderComputerUnit(): string {
  return [
    unitMarker,
    "[Unit]",
    "Description=Lazurio Environment computer: Computer Use of the Environment's screen for every agent",
    `BindsTo=${displayUnit}`,
    `After=${displayUnit}`,
    "ConditionFileIsExecutable=%h/.local/bin/cua-driver",
    "",
    "[Service]",
    "Type=simple",
    `Environment=DISPLAY=${browserDisplay}`,
    "Environment=XDG_SESSION_TYPE=x11",
    "Environment=DBUS_SESSION_BUS_ADDRESS=unix:path=%t/bus",
    ...driverSettings.map((setting) => `Environment=${setting}`),
    "ExecStart=%h/.local/bin/cua-driver serve --no-overlay --permission-mode standard --socket %h/.local/state/lazurio-computer/driver.sock",
    "Restart=on-failure",
    "RestartSec=3",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

/** What `lazurio install` or `lazurio update` did with Computer Use. Never
 * a reason for either to fail. */
export type ComputerUse =
  /** The unit is written (or already identical), enabled and started, and
   * each installed harness has the entry `computer` (as `agents` says). */
  | Readonly<{ state: "enabled"; agents: AgentsFacts }>
  /** The unit is in place, but Machines has not installed the driver: the
   * unit is skipped by its condition, and the agents' own entries are
   * removed until it is there. */
  | Readonly<{ state: "driver-missing"; agents: AgentsFacts; next: string }>
  /** Not the declared operator of a Machine handover: nothing written. */
  | Readonly<{ state: "skipped-not-hosted" }>
  /** The handover has no `entry.browser`, so the Environment has no screen;
   * nothing written or stopped. */
  | Readonly<{ state: "skipped-not-declared" }>
  /** A unit of this name the installer did not write. */
  | Readonly<{ state: "foreign-unit"; next: string }>
  | Readonly<{
      state: "failed";
      step: "unit" | "reload" | "enable" | "start";
      next: string;
    }>;

const foreignNext = `A unit ${computerUnit} that lazurio install did not write is left unchanged, so Computer Use is not set up. To have lazurio install manage it, remove that file and run the same install again.`;
const failedNext = `Computer Use is not set up to start with this Environment; the Environment browser and the Launchpad are not affected. Read systemctl --user status ${computerUnit}, then run the same install again.`;
const driverMissingNext =
  "Computer Use waits for the Cua Driver at ~/.local/bin/cua-driver, which is installed with the Environment (Machines). Until then agents have no computer tool; the Environment browser works as before.";

export const computerUseFailed = (
  step: "unit" | "reload" | "enable" | "start",
): ComputerUse => Object.freeze({ state: "failed", step, next: failedNext });

/** Where the harnesses are looked for: the operator's `~/.local/bin` first,
 * where Machines installs Codex and Claude Code, whatever PATH the caller
 * (a Machines apply, an agent's shell) has, then that PATH. */
const harnessPath = (home: string, path: string | undefined) =>
  [
    join(home, ".local", "bin"),
    ...(path ?? "/usr/local/bin:/usr/bin:/bin").split(":"),
  ]
    .filter((entry, index, all) => entry !== "" && all.indexOf(entry) === index)
    .join(":");

/** Whether the driver is there to run: a regular executable file. */
async function driverPresent(home: string): Promise<boolean> {
  try {
    const info = await stat(cuaDriverPath(home));
    return info.isFile() && (info.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/** Write the unit when it differs, reread the manager once, enable and
 * start it; restart it when its own text changed (agents' sessions on the
 * screen end, the programs stay). Then the agents' entries follow the
 * driver: added where it is there, Lazurio's own removed where it is not.
 * The screen and the browser are never touched. */
export async function installComputerUse(
  input: Readonly<{
    directory: string;
    hosted: boolean;
    /** Whether the handover's `entry` carries `browser`: the screen. */
    declared: boolean;
    run: ProcessRunner;
    /** Codex and Claude Code, for the agents' entries. */
    tools: ToolRunner;
    platform: string;
    env: Readonly<Record<string, string | undefined>>;
  }>,
): Promise<ComputerUse> {
  if (!input.hosted) return Object.freeze({ state: "skipped-not-hosted" });
  if (!input.declared) return Object.freeze({ state: "skipped-not-declared" });
  const home = input.env.HOME;
  if (home === undefined || !home.startsWith("/"))
    return computerUseFailed("unit");
  const command = { run: input.run, env: input.env };
  const text = renderComputerUnit();
  let changed: boolean;
  try {
    const existing = await readFile(
      join(input.directory, computerUnit),
      "utf8",
    ).catch((error: NodeJS.ErrnoException) => {
      if (error?.code === "ENOENT") return undefined;
      throw error;
    });
    if (existing !== undefined && !existing.startsWith(unitMarker))
      return Object.freeze({ state: "foreign-unit", next: foreignNext });
    changed = existing !== text;
    if (changed)
      await writeDurableFile(input.directory, computerUnit, Buffer.from(text));
  } catch {
    return computerUseFailed("unit");
  }
  if (changed && !(await systemctl(command, "daemon-reload")))
    return computerUseFailed("reload");
  if (!(await systemctl(command, "enable", computerUnit)))
    return computerUseFailed("enable");
  if (changed && !(await systemctl(command, "try-restart", computerUnit)))
    return computerUseFailed("start");
  if (!(await systemctl(command, "start", computerUnit)))
    return computerUseFailed("start");
  const agents = {
    home,
    path: harnessPath(home, input.env.PATH),
    platform: input.platform,
    env: input.env,
    run: input.tools,
    server: computerMcpServer(home),
  };
  if (await driverPresent(home))
    return Object.freeze({
      state: "enabled",
      agents: await ensureAgentMcp(agents),
    });
  return Object.freeze({
    state: "driver-missing",
    agents: await removeAgentMcp(agents),
    next: driverMissingNext,
  });
}

/** Like the Environment browser's units (F38): on a supervised base, for
 * the declared operator of a handover; undefined where there is nothing to
 * converge (not Linux, no user manager, no supervised Launchpad unit of this
 * base). The handover's `entry.browser` is asked only when the rest holds. */
export async function convergeComputerUse(
  input: Readonly<{
    base: string;
    platform: string;
    env: Readonly<Record<string, string | undefined>>;
    run: ProcessRunner;
    tools?: ToolRunner | undefined;
    hosted: () => Promise<boolean>;
    declared: () => Promise<boolean>;
  }>,
): Promise<ComputerUse | undefined> {
  const directory = userUnitDirectory(input.env);
  if (input.platform !== "linux" || directory === undefined) return undefined;
  if ((await detectServiceControl(input)) === null) return undefined;
  const hosted = await input.hosted().catch(() => false);
  return installComputerUse({
    directory,
    hosted,
    declared: hosted ? await input.declared().catch(() => false) : false,
    run: input.run,
    tools: input.tools ?? runTool,
    platform: input.platform,
    env: input.env,
  });
}

/** The finding in words, only when something needs a person. */
export function computerUseFinding(value: ComputerUse | undefined): string[] {
  if (value === undefined) return [];
  switch (value.state) {
    case "skipped-not-hosted":
    case "skipped-not-declared":
      return [];
    case "enabled":
      return Object.values(value.agents).some(
        (state) =>
          state === "missing" || state === "conflict" || state === "unknown",
      )
        ? [
            "Computer Use runs, but not every agent has the MCP server computer: lazurio doctor (check computer-use) names the harness; an entry of that name that is not Lazurio's is left as it is.",
          ]
        : [];
    default:
      return [value.next];
  }
}

// ---- Observation, for `lazurio doctor` --------------------------------------

/** How Computer Use is, in doctor's terms. Never `fail`: an Environment
 * works without it, and the Machines preflight stops on any `fail`. */
export type ComputerUseObservation = Readonly<{
  outcome: "ok" | "warn" | "skipped";
  reason?: string;
  context?: Readonly<Record<string, string>>;
}>;

export const computerUseReasons = [
  "computer-driver-missing",
  "computer-unit-not-loaded",
  "computer-unit-failed",
  "computer-unit-inactive",
  "computer-doctor-unreadable",
  "computer-display-unavailable",
  "computer-accessibility-unavailable",
  "computer-agents-missing",
] as const;

const driverDoctorTimeoutMs = 15_000;

type DriverProbe = Readonly<{ label: string; status: string; message: string }>;

/** The driver's own `doctor --json` (`{ok, probes: [{label, status,
 * message}]}`), or null for anything else. */
function driverReport(
  stdout: string,
): Readonly<{ ok: boolean; probes: readonly DriverProbe[] }> | null {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object") return null;
  const { ok, probes } = value as { ok?: unknown; probes?: unknown };
  if (typeof ok !== "boolean" || !Array.isArray(probes)) return null;
  const valid = probes.every(
    (probe) =>
      probe !== null &&
      typeof probe === "object" &&
      typeof probe.label === "string" &&
      typeof probe.status === "string" &&
      typeof probe.message === "string",
  );
  return valid ? { ok, probes: probes as DriverProbe[] } : null;
}

/** Read-only: the driver, `systemctl --user show` of the unit, the driver's
 * own `doctor --json` on the screen (the display an X11 one, the AT-SPI bus
 * reachable), then whether each installed harness has the entry. Skipped
 * where the screen cannot be: no user manager, an unsupervised installation,
 * not a hosted Machine, a handover without `entry.browser`. Never starts or
 * restarts anything; the driver's doctor on Linux only reads. */
export async function observeComputerUse(
  input: Readonly<{
    platform: string;
    env: Readonly<Record<string, string | undefined>>;
    supervised: boolean;
    hosted: () => Promise<boolean>;
    declared: boolean;
    run: ProcessRunner;
    tools: ToolRunner;
  }>,
): Promise<ComputerUseObservation> {
  const skipped = (reason: string) =>
    Object.freeze({ outcome: "skipped" as const, reason });
  const warn = (reason: string, context?: Record<string, string>) =>
    Object.freeze({
      outcome: "warn" as const,
      reason,
      ...(context === undefined ? {} : { context: Object.freeze(context) }),
    });
  const runtime = input.env.XDG_RUNTIME_DIR;
  const home = input.env.HOME;
  if (input.platform !== "linux" || !runtime) return skipped("no-user-manager");
  if (!input.supervised) return skipped("not-supervised");
  if (!(await input.hosted().catch(() => false))) return skipped("not-hosted");
  if (!input.declared) return skipped("browser-not-declared");
  if (
    home === undefined ||
    !home.startsWith("/") ||
    !(await driverPresent(home))
  )
    return warn("computer-driver-missing");

  const shown = await input
    .run(
      [
        "systemctl",
        "--user",
        "show",
        "--property=LoadState,ActiveState",
        "--",
        computerUnit,
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
  if (properties.get("LoadState") === "not-found")
    return warn("computer-unit-not-loaded");
  const active = properties.get("ActiveState");
  if (active === "failed") return warn("computer-unit-failed");
  if (active !== "active") return warn("computer-unit-inactive");

  // The driver's doctor in the unit's environment.
  const doctored = await input
    .tools([cuaDriverPath(home), "doctor", "--json"], driverDoctorTimeoutMs, {
      HOME: home,
      PATH: input.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      XDG_RUNTIME_DIR: runtime,
      DISPLAY: browserDisplay,
      XDG_SESSION_TYPE: "x11",
      DBUS_SESSION_BUS_ADDRESS:
        input.env.DBUS_SESSION_BUS_ADDRESS ?? `unix:path=${runtime}/bus`,
      ...Object.fromEntries(
        driverSettings.map((setting) => setting.split("=")),
      ),
    })
    .catch(() => "timeout" as const);
  const report = doctored === "timeout" ? null : driverReport(doctored.stdout);
  if (report === null) return warn("computer-doctor-unreadable");
  const probe = (label: string) =>
    report.probes.find((entry) => entry.label === label);
  const version = /\b(\d{1,6}\.\d{1,6}\.\d{1,6})\b/.exec(
    probe("binary")?.message ?? "",
  )?.[1];
  const context: Record<string, string> =
    version === undefined ? {} : { toolVersion: version };
  const display = probe("display server");
  if (
    display?.status !== "ok" ||
    !display.message.startsWith("X11 ") ||
    probe("X11 connection")?.status === "err"
  )
    return warn("computer-display-unavailable", context);
  if (probe("AT-SPI")?.status !== "ok")
    return warn("computer-accessibility-unavailable", context);

  const agents = await observeAgentMcp({
    home,
    path: harnessPath(home, input.env.PATH),
    platform: input.platform,
    env: input.env,
    run: input.tools,
    server: computerMcpServer(home),
  });
  const withAgents = {
    ...context,
    codexMcp: agents.codex,
    claudeMcp: agents.claude,
  };
  if (
    Object.values(agents).some(
      (state) =>
        state === "missing" || state === "conflict" || state === "unknown",
    )
  )
    return warn("computer-agents-missing", withAgents);
  return Object.freeze({
    outcome: "ok" as const,
    context: Object.freeze(withAgents),
  });
}
