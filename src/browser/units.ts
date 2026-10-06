import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeDurableFile } from "../update/durable-file";
import type { ProcessRunner } from "../update/self-check";
import {
  detectServiceControl,
  serviceCommandTimeoutMs,
  serviceEnvironment,
  systemctl,
  systemdQuote,
  unitMarker,
  unitPath,
  userUnitDirectory,
} from "../update/service-control";

/** The Environment browser of a Remote Environment (root decision 0191,
 * decision F38): one virtual screen, one Chromium with one persistent profile
 * that every thread, agent and bot of the Environment shares, and the
 * agent-browser dashboard as the person's view of its windows. Three
 * installer units, converged like the Codex app-server unit (F29): written
 * when their text differs, enabled and started; `install` and `update` never
 * stop the screen or the browser, since that would close every agent's
 * window. Machines delivers the packages (Xvfb, Chrome for Testing through
 * agent-browser) and the gateway route; the Platform owns what runs. */
export const displayUnit = "lazurio-display.service";
export const browserUnit = "lazurio-browser.service";
export const browserViewUnit = "lazurio-browser-view.service";
export const browserUnits = [
  displayUnit,
  browserUnit,
  browserViewUnit,
] as const;
export type BrowserUnit = (typeof browserUnits)[number];

/** The Environment's one virtual screen. The desktop of the second wave
 * (0191 point 8) shows this screen; Computer Use works on it. */
export const browserDisplay = ":1";
const screen = "1920x1080x24";
const displaySocket = "/tmp/.X11-unix/X1";

/** The browser's DevTools port, on loopback only (Chrome binds 127.0.0.1 for
 * `--remote-debugging-port`). Never routed by the gateway: whoever reaches
 * it reaches every sign-in of the Environment. */
export const browserCdpPort = 9222;

/** The persistent profile, outside the Folder (which refuses foreign
 * entries) and outside the install base (product, not the person's state):
 * the Environment's sign-ins (0191 point 1). Wiping it is the hand-over's
 * step when a Work Environment passes to another person (0191 point 10). */
export const browserProfileDirectory = (home: string) =>
  join(home, ".local", "share", "lazurio-browser", "profile");

/** The size of a thread's window and of its view, so the view's pointer
 * lands where the page is (the dashboard maps clicks with this viewport). */
export const browserWindowSize = Object.freeze({ width: 1280, height: 800 });

/** What the gateway tells the Environment about the view, from the handover
 * (`entry.browser`, Machines): where the person reaches it and the loopback
 * port the dashboard listens on. Never derived by convention. */
export type BrowserEntry = Readonly<{ origin: string; listenPort: number }>;

// Chrome for Testing as agent-browser installs it under the operator's home
// (Machines: `agent-browser install`): the only path Machines' AppArmor
// profile `agent-browser-chrome` admits, so the sandbox works. The newest
// version wins (`sort -V`); none at all ends with EX_CONFIG (78), which the
// unit does not restart, so `lazurio doctor` sees the failure instead of a
// loop. `$$` is systemd's escape of a literal `$`.
const chromeCandidates = [
  "%h/.agent-browser/browsers/chrome-*/chrome",
  "%h/.agent-browser/browsers/chrome-*/chrome-linux64/chrome",
];

/** Chrome's flags, one per line of the docs (decision F38):
 * - the persistent profile and loopback DevTools;
 * - no first-run or default-browser questions, nobody answers them;
 * - `--password-store=basic`: no desktop keyring on a virtual screen;
 * - no background throttling: an agent's window keeps working while the
 *   person watches another one;
 * - no crash-restore bubble after a restart of the unit;
 * - the first window at a thread window's size. */
export const browserFlags = Object.freeze([
  "--user-data-dir=%h/.local/share/lazurio-browser/profile",
  `--remote-debugging-port=${browserCdpPort}`,
  "--no-first-run",
  "--no-default-browser-check",
  "--password-store=basic",
  "--disable-background-timer-throttling",
  "--disable-renderer-backgrounding",
  "--disable-backgrounding-occluded-windows",
  "--hide-crash-restore-bubble",
  `--window-size=${browserWindowSize.width},${browserWindowSize.height + 100}`,
]);

/** The screen: Xvfb on `:1`, no TCP. `Type=simple` and a start that waits
 * for the screen's socket, so the browser after it finds the screen. */
export function renderDisplayUnit(): string {
  return [
    unitMarker,
    "[Unit]",
    "Description=Lazurio Environment display: the virtual screen of the Environment browser",
    "ConditionFileIsExecutable=/usr/bin/Xvfb",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=/usr/bin/Xvfb ${browserDisplay} -screen 0 ${screen} -nolisten tcp`,
    `ExecStartPost=/bin/sh -c 'i=0; while [ ! -S ${displaySocket} ]; do i=$$((i+1)); [ $$i -gt 100 ] && exit 1; sleep 0.1; done'`,
    "Restart=on-failure",
    "RestartSec=2",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

/** The browser: the newest Chrome for Testing, headed on the screen, `exec`
 * so Chrome is the unit's main process. Bound to the screen; restarted
 * whenever it ends (a person closing the last window included), except when
 * there is no Chrome to run. */
export function renderBrowserUnit(): string {
  const command = [
    `b=$$(ls -d ${chromeCandidates.join(" ")} 2>/dev/null | sort -V | tail -n 1)`,
    '[ -x "$$b" ] || exit 78',
    `exec "$$b" ${browserFlags.join(" ")} about:blank`,
  ].join("; ");
  return [
    unitMarker,
    "[Unit]",
    "Description=Lazurio Environment browser: one Chromium shared by the Environment's agents",
    `BindsTo=${displayUnit}`,
    `After=${displayUnit}`,
    "",
    "[Service]",
    "Type=simple",
    `Environment=DISPLAY=${browserDisplay}`,
    `ExecStart=/bin/sh -c '${command}'`,
    "Restart=always",
    "RestartSec=3",
    "RestartPreventExitStatus=78",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

/** The view: agent-browser's own dashboard, allowed for the gateway's origin
 * only, so its access token and its Origin check stay on (decision F38).
 * `dashboard start` detaches and exits, as Codex's daemon does in F29:
 * `oneshot`, `RemainAfterExit=yes`, `KillMode=process`, stopped by agent-
 * browser itself. `AGENT_BROWSER_CDP` makes what the dashboard runs use the
 * Environment browser, never a browser of its own. */
export function renderBrowserViewUnit(entry: BrowserEntry): string {
  return [
    unitMarker,
    "[Unit]",
    "Description=Lazurio Environment browser view: the agent-browser dashboard behind the gateway",
    "ConditionFileIsExecutable=%h/.local/bin/agent-browser",
    "",
    "[Service]",
    "Type=oneshot",
    "RemainAfterExit=yes",
    "KillMode=process",
    `Environment=PATH=${unitPath}`,
    `Environment=AGENT_BROWSER_CDP=${browserCdpPort}`,
    `ExecStart=%h/.local/bin/agent-browser dashboard start --port ${entry.listenPort} --allowed-origins ${systemdQuote(entry.origin)}`,
    "ExecStop=-%h/.local/bin/agent-browser dashboard stop",
    "TimeoutStartSec=60",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

export function renderBrowserUnits(
  entry: BrowserEntry,
): Readonly<Record<BrowserUnit, string>> {
  return Object.freeze({
    [displayUnit]: renderDisplayUnit(),
    [browserUnit]: renderBrowserUnit(),
    [browserViewUnit]: renderBrowserViewUnit(entry),
  });
}

/** What `lazurio install` or `lazurio update` did with the Environment
 * browser's units. Never a reason for either to fail. */
export type EnvironmentBrowser =
  /** Written (or already identical), enabled and started. */
  | Readonly<{ state: "enabled" }>
  /** Not the declared operator of a Machine handover: nothing written. */
  | Readonly<{ state: "skipped-not-hosted" }>
  /** The handover has no `entry.browser`: the gateway routes no view, so the
   * Environment has no browser to run; nothing written or stopped. */
  | Readonly<{ state: "skipped-not-declared" }>
  /** A unit of one of these names the installer did not write. */
  | Readonly<{ state: "foreign-unit"; unit: BrowserUnit; next: string }>
  | Readonly<{
      state: "failed";
      step: "unit" | "reload" | "enable" | "start";
      next: string;
    }>;

const foreignNext = (unit: BrowserUnit) =>
  `A unit ${unit} that lazurio install did not write is left unchanged, so the Environment browser is not set up. To have lazurio install manage it, remove that file and run the same install again.`;
const failedNext = `The Environment browser is not set up to start with this Environment; the Launchpad is not affected. Read systemctl --user status ${browserUnits.join(" ")}, then run the same install again.`;

export const environmentBrowserFailed = (
  step: "unit" | "reload" | "enable" | "start",
): EnvironmentBrowser =>
  Object.freeze({ state: "failed", step, next: failedNext });

/** Write what differs, reread the manager once, enable and start all three.
 * `start` of an active unit changes nothing, so the screen and the browser
 * keep running across every install and update. Only the view is restarted,
 * and only when its own text changed (the gateway moved its port or
 * origin): a new dashboard costs a viewer one reload, nothing else. */
export async function installEnvironmentBrowser(
  input: Readonly<{
    directory: string;
    hosted: boolean;
    entry: BrowserEntry | undefined;
    run: ProcessRunner;
    env: Readonly<Record<string, string | undefined>>;
  }>,
): Promise<EnvironmentBrowser> {
  if (!input.hosted) return Object.freeze({ state: "skipped-not-hosted" });
  if (input.entry === undefined)
    return Object.freeze({ state: "skipped-not-declared" });
  const failed = environmentBrowserFailed;
  const command = { run: input.run, env: input.env };
  const texts = renderBrowserUnits(input.entry);
  const changed: BrowserUnit[] = [];
  try {
    for (const unit of browserUnits) {
      const existing = await readFile(
        join(input.directory, unit),
        "utf8",
      ).catch((error: NodeJS.ErrnoException) => {
        if (error?.code === "ENOENT") return undefined;
        throw error;
      });
      if (existing !== undefined && !existing.startsWith(unitMarker))
        return Object.freeze({
          state: "foreign-unit",
          unit,
          next: foreignNext(unit),
        });
      if (existing !== texts[unit]) changed.push(unit);
    }
    for (const unit of changed)
      await writeDurableFile(input.directory, unit, Buffer.from(texts[unit]));
  } catch {
    return failed("unit");
  }
  if (changed.length > 0 && !(await systemctl(command, "daemon-reload")))
    return failed("reload");
  if (!(await systemctl(command, "enable", ...browserUnits)))
    return failed("enable");
  if (
    changed.includes(browserViewUnit) &&
    !(await systemctl(command, "try-restart", browserViewUnit))
  )
    return failed("start");
  if (!(await systemctl(command, "start", ...browserUnits)))
    return failed("start");
  return Object.freeze({ state: "enabled" });
}

/** Like the entry units (F29): on a supervised base, for the declared
 * operator of a handover; undefined where there is nothing to converge (not
 * Linux, no user manager, no supervised Launchpad unit of this base). The
 * handover's `entry.browser` is asked only when the rest holds. */
export async function convergeEnvironmentBrowser(
  input: Readonly<{
    base: string;
    platform: string;
    env: Readonly<Record<string, string | undefined>>;
    run: ProcessRunner;
    hosted: () => Promise<boolean>;
    entry: () => Promise<BrowserEntry | undefined>;
  }>,
): Promise<EnvironmentBrowser | undefined> {
  const directory = userUnitDirectory(input.env);
  if (input.platform !== "linux" || directory === undefined) return undefined;
  const service = await detectServiceControl(input);
  if (service === null) return undefined;
  const hosted = await input.hosted().catch(() => false);
  return installEnvironmentBrowser({
    directory,
    hosted,
    entry: hosted ? await input.entry().catch(() => undefined) : undefined,
    run: input.run,
    env: input.env,
  });
}

// ---- Observation, for `lazurio doctor` --------------------------------------

/** How the Environment browser is, in doctor's terms: `ok`, `warn` with a
 * reason, or `skipped` with a reason. Never `fail`: an Environment works
 * without its browser, and the Machines preflight stops on any `fail`. */
export type EnvironmentBrowserObservation = Readonly<{
  outcome: "ok" | "warn" | "skipped";
  reason?: string;
  context?: Readonly<Record<string, string>>;
}>;

export const environmentBrowserReasons = [
  "browser-not-declared",
  "browser-unit-not-loaded",
  "browser-unit-failed",
  "browser-unit-inactive",
  "browser-not-answering",
  "browser-view-not-answering",
] as const;

const probeTimeoutMs = 3_000;

/** Read-only: `systemctl --user show` of the three units, then whether the
 * browser's DevTools and the view answer on loopback. Skipped where the
 * browser cannot be: no user manager, an unsupervised installation, not a
 * hosted Machine, a handover without `entry.browser`. Never starts,
 * restarts or asks agent-browser anything (its own `doctor` cleans files). */
export async function observeEnvironmentBrowser(
  input: Readonly<{
    platform: string;
    env: Readonly<Record<string, string | undefined>>;
    supervised: boolean;
    hosted: () => Promise<boolean>;
    entry: BrowserEntry | undefined;
    run: ProcessRunner;
    fetch: (url: string, init: RequestInit) => Promise<Response>;
  }>,
): Promise<EnvironmentBrowserObservation> {
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
  if (input.entry === undefined) return skipped("browser-not-declared");
  for (const unit of browserUnits) {
    const shown = await input
      .run(
        [
          "systemctl",
          "--user",
          "show",
          "--property=LoadState,ActiveState",
          "--",
          unit,
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
      if (split > 0)
        properties.set(line.slice(0, split), line.slice(split + 1));
    }
    if (properties.get("LoadState") === "not-found")
      return warn("browser-unit-not-loaded", { unit });
    const active = properties.get("ActiveState");
    if (active === "failed") return warn("browser-unit-failed", { unit });
    if (active !== "active") return warn("browser-unit-inactive", { unit });
  }
  const answers = async (url: string) => {
    try {
      const response = await input.fetch(url, {
        redirect: "error",
        signal: AbortSignal.timeout(probeTimeoutMs),
      });
      await response.body?.cancel();
      return response.ok;
    } catch {
      return false;
    }
  };
  if (!(await answers(`http://127.0.0.1:${browserCdpPort}/json/version`)))
    return warn("browser-not-answering");
  if (!(await answers(`http://127.0.0.1:${input.entry.listenPort}/`)))
    return warn("browser-view-not-answering");
  return Object.freeze({ outcome: "ok" as const });
}
