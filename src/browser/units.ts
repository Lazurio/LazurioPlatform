import { readFile, readlink, realpath } from "node:fs/promises";
import { join } from "node:path";
import { writeDurableFile } from "../update/durable-file";
import { layout } from "../update/layout";
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
import { unreadableHolderFiles } from "./contract/node";
import { browserBounds } from "./contract/pure";
import { isGithubLogin } from "./people/cookies";
import {
  browserExtensionDigest,
  writeBrowserExtension,
} from "./people/extension";

/** The Environment browser of a Remote Environment (root decision 0191,
 * decisions F38 and F39): one virtual screen, one Chromium with one
 * persistent profile that every thread, agent and bot of the Environment
 * shares, and the people's view, where one tab of a person is one remote
 * tab. Three installer units, converged like the Codex app-server unit (F29):
 * written when their text differs, enabled and started. `install` and
 * `update` never stop the screen; they restart the browser only when its own
 * unit changed (a new flag or a new extension, F39 point 10), since that
 * closes every agent's window. Machines delivers the packages (Xvfb, Chrome
 * for Testing through agent-browser) and the gateway route; the Platform
 * owns what runs. */
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
 * it reaches every sign-in of the Environment. The contract's
 * (`browserBounds.devtoolsPort`, F50 C14). */
export const browserCdpPort = browserBounds.devtoolsPort;

/** The persistent profile, outside the Folder (which refuses foreign
 * entries) and outside the install base (product, not the person's state):
 * the Environment's sign-ins (0191 point 1). Wiping it is the hand-over's
 * step when a Work Environment passes to another person (0191 point 10). */
export const browserProfileDirectory = (home: string) =>
  join(home, ".local", "share", "lazurio-browser", "profile");

/** The virtual screen; no window grows past it. */
export const browserScreenSize = Object.freeze({ width: 1920, height: 1080 });

/** The gateway's loopback entry for the Environment browser itself
 * (LazurioPlatform#504, F39's addendum of 2026-10-18): its port
 * (`entry.browser.local_port`) and the Environment's own name, `<base>` of
 * every `https://<app>.<base>` (from `entry.modules.origin_template`). It
 * serves this Environment's own apps and modules without a sign-in, because
 * the Environment browser never holds a Lazurio session, and answers the
 * bare `<base>` with the hand-off to the person's own browser. */
export type BrowserLocalEntry = Readonly<{ port: number; base: string }>;

/** What the gateway tells the Environment about the view, from the handover
 * (`entry.browser`, Machines): where the person reaches it, the loopback
 * port the view service listens on and, where the gateway runs it, its
 * loopback entry for the browser itself (`local`). Never derived by
 * convention. */
export type BrowserEntry = Readonly<{
  origin: string;
  listenPort: number;
  local?: BrowserLocalEntry;
}>;

const dnsLabel = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const moduleTemplate = new RegExp(
  `^https://\\{module\\}\\.(${dnsLabel}(?:\\.${dnsLabel})+)$`,
);

/** The Environment's own name from the handover's module origin template
 * (`https://{module}.<base>`): `<base>`, which must have at least three
 * labels (`<environment>.<organization>.lazurio.io`, or a personal
 * `<slug>.lazurio.io`), so a rule for it can never cover all of
 * `lazurio.io` or a top-level domain. Null for anything else. */
export function environmentBaseOf(originTemplate: unknown): string | null {
  if (typeof originTemplate !== "string" || originTemplate.length > 270)
    return null;
  const base = moduleTemplate.exec(originTemplate)?.[1];
  return base !== undefined && base.split(".").length >= 3 ? base : null;
}

/** The loopback entry from the handover's members, or none: a port of the
 * schema's range and a base `environmentBaseOf` accepts. */
export function browserLocalEntry(
  localPort: unknown,
  originTemplate: unknown,
): BrowserLocalEntry | undefined {
  const base = environmentBaseOf(originTemplate);
  if (
    base === null ||
    !Number.isInteger(localPort) ||
    (localPort as number) < 1024 ||
    (localPort as number) > 65535
  )
    return undefined;
  return Object.freeze({ port: localPort as number, base });
}

/** Chrome's resolver rule for the loopback entry (#504): every name of this
 * Environment, `*.<base>` and the bare `<base>`, resolves to the gateway's
 * loopback entry and its port. Chrome's `*.<base>` does not cover `<base>`
 * itself, so both are named. The URL, its Host, its cookies and its TLS name
 * stay the page's own; only where Chrome connects changes. Other
 * Environments, the Dashboard and the sign-in service resolve as before,
 * where the browser's policy blocks them (Machines). A proxy changes nothing
 * here: Chrome asks a proxy by the URL's name, before it resolves, and a
 * guest whose environment forces one already lists `<base>` and `.<base>` in
 * its `no_proxy` (Machines#586); `--proxy-bypass-list` would be ignored,
 * since Chrome reads it only with `--proxy-server`. */
export function browserResolverRule(local: BrowserLocalEntry): string {
  const target = `127.0.0.1:${local.port}`;
  return `MAP *.${local.base} ${target},MAP ${local.base} ${target}`;
}

/** The browser's flags: `browserFlags`, and with the loopback entry its
 * resolver rule. Without it they are exactly `browserFlags`. */
export function browserLaunchFlags(
  local?: BrowserLocalEntry,
): readonly string[] {
  return local === undefined
    ? browserFlags
    : Object.freeze([
        ...browserFlags,
        `--host-resolver-rules=${browserResolverRule(local)}`,
      ]);
}

/** One flag as a word of the unit's `sh -c '…'`: as it is, or in double
 * quotes when it holds a space or a `*`. No flag holds a quote, `$`, a
 * backquote or a backslash (`environmentBaseOf`). */
const shellWord = (flag: string) =>
  /^[A-Za-z0-9_%=.,:/+-]+$/.test(flag) ? flag : `"${flag}"`;

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

/** Where Chrome keeps the last session of the profile's one user (`Default`),
 * in the unit's `%h` form: the tabs it reopens when it starts. */
const browserSessionsDirectory = join(
  browserProfileDirectory("%h"),
  "Default",
  "Sessions",
);

/** The browser's memory budget (root decision 0195 point 4, plan DEV-6656),
 * so heavy pages cost only the browser's tabs, never the Launchpad, T3 Code
 * or a Module. On 2026-10-10 one Environment of 8 GiB froze with a browser of
 * about 2 GiB, and another thrashed with one of 4.7 GiB.
 * - `MemoryMax=30%`: relative to the Environment's memory, so a larger
 *   Environment gives its browser more with the same unit text; about 2.3 GiB on
 *   the base Environment of 8 GiB. At the limit the kernel first reclaims the
 *   browser's own memory (into swap, where there is swap), then ends a
 *   process inside the browser.
 * - `MemorySwapMax=20%`: what the browser may move to swap, relative to the
 *   Environment's memory as systemd 255 resolves it. Swap in memory (zram)
 *   is not charged to the browser, so without it the browser could fill it.
 *   Together at most half the Environment's memory, most of it compressed.
 * - No `MemoryHigh`: without swap, a process past it stays throttled just
 *   above it for minutes, never reaches `MemoryMax`, and every process of the
 *   browser that allocates waits with it (measured on systemd 255). The hard
 *   limit ends the heaviest tab instead.
 * - `OOMPolicy=continue`: a process the kernel ends is mostly one tab's
 *   renderer, and only that tab goes. systemd's default (`stop`) turned one
 *   such tab into a restart of the whole browser.
 * - `OOMScoreAdjust=250`: the user manager gives every user service 200, and
 *   Chrome gives each tab's renderer 300. The rest of the browser between them
 *   makes the kernel's order a tab first, then the browser, then a Module. */
const browserMemoryBudget = Object.freeze([
  "MemoryMax=30%",
  "MemorySwapMax=20%",
  "OOMPolicy=continue",
  "OOMScoreAdjust=250",
]);

/** Chrome's flags, one per line of the docs (decisions F38 and F39):
 * - the persistent profile and loopback DevTools;
 * - no first-run or default-browser questions, nobody answers them;
 * - `--password-store=basic`: no desktop keyring on a virtual screen;
 * - no background throttling: an agent's window keeps working while the
 *   person watches another one;
 * - no crash-restore bubble after a restart of the unit. The bubble's
 *   question is answered with yes: Chrome then reopens the last session even
 *   after a crash, which is why the unit removes it before each start;
 * - the first window at a thread window's size;
 * - permission prompts are denied, never shown where nobody sees them;
 * - the Lazurio extension (a window per tab, passkeys declined), with the
 *   feature that turns `--load-extension` off in branded builds disabled. */
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
  // A thread's window until a person's view resizes it (F39 point 3): the
  // contract's page area in its window (`browserBounds`, F50 C14).
  `--window-size=${browserBounds.window.width},${browserBounds.window.height}`,
  "--deny-permission-prompts",
  "--load-extension=%h/.local/share/lazurio-browser/extension",
  "--disable-features=DisableLoadExtensionCommandLineSwitch",
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
 * there is no Chrome to run. The extension's digest is part of the text, so
 * a new extension is a changed unit, which restarts the browser.
 *
 * It starts without the tabs of the last session (root decision 0195 point
 * 4). Chrome for Testing reopens them by itself on Linux: after a clean exit,
 * after systemd's stop and, with the hidden crash bubble, after a crash. Each
 * restart then loaded the same heavy pages that had filled the memory, and no
 * one owned them: their target ids are new, so no thread's window and no
 * person's view knows them. Removing the session before the start is the one
 * place that covers every way the browser ends; the rest of the profile, with
 * the Environment's sign-ins, stays. Optional (`-`): should the removal ever
 * fail, a browser with old tabs is better than none. Threads open their
 * windows again with `lazurio browser window`. */
export function renderBrowserUnit(local?: BrowserLocalEntry): string {
  const command = [
    `b=$$(ls -d ${chromeCandidates.join(" ")} 2>/dev/null | sort -V | tail -n 1)`,
    '[ -x "$$b" ] || exit 78',
    `exec "$$b" ${browserLaunchFlags(local).map(shellWord).join(" ")} about:blank`,
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
    `Environment=LAZURIO_BROWSER_EXTENSION=${browserExtensionDigest}`,
    `ExecStartPre=-/bin/rm -rf ${browserSessionsDirectory}`,
    `ExecStart=/bin/sh -c '${command}'`,
    "Restart=always",
    "RestartSec=3",
    "RestartPreventExitStatus=78",
    ...browserMemoryBudget,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

/** The one line that says which installation, port and origin the view
 * serves. */
export const browserViewExecStart = (entry: BrowserEntry, selector: string) =>
  `ExecStart=${[
    selector,
    "browser",
    "serve",
    "--port",
    String(entry.listenPort),
    "--origin",
    entry.origin,
  ]
    .map(systemdQuote)
    .join(" ")}`;

/** The view: the Platform's own people's view (decision F39), this
 * installation's `lazurio browser serve` on the entry's loopback port for the
 * gateway's origin. A long-running service, restarted whenever it ends. */
export function renderBrowserViewUnit(
  entry: BrowserEntry,
  selector: string,
): string {
  return [
    unitMarker,
    "[Unit]",
    "Description=Lazurio Environment browser view: one tab of a person is one tab of the Environment browser",
    `After=${browserUnit}`,
    "",
    "[Service]",
    "Type=simple",
    `Environment=PATH=${unitPath}`,
    browserViewExecStart(entry, selector),
    "Restart=always",
    "RestartSec=2",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

export function renderBrowserUnits(
  entry: BrowserEntry,
  selector: string,
): Readonly<Record<BrowserUnit, string>> {
  return Object.freeze({
    [displayUnit]: renderDisplayUnit(),
    [browserUnit]: renderBrowserUnit(entry.local),
    [browserViewUnit]: renderBrowserViewUnit(entry, selector),
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
 * `start` of an active unit changes nothing, so the screen keeps running
 * across every install and update. The view is restarted when its own text
 * changed (a new installation path, port or origin): a viewer reconnects.
 * The browser is restarted when its own text changed (F39 point 10): its
 * windows close, agents open theirs again, the profile keeps its sign-ins. */
export async function installEnvironmentBrowser(
  input: Readonly<{
    directory: string;
    hosted: boolean;
    entry: BrowserEntry | undefined;
    /** This installation's `lazurio`, which the view unit runs. */
    selector: string;
    run: ProcessRunner;
    env: Readonly<Record<string, string | undefined>>;
  }>,
): Promise<EnvironmentBrowser> {
  if (!input.hosted) return Object.freeze({ state: "skipped-not-hosted" });
  if (input.entry === undefined)
    return Object.freeze({ state: "skipped-not-declared" });
  const failed = environmentBrowserFailed;
  const command = { run: input.run, env: input.env };
  const texts = renderBrowserUnits(input.entry, input.selector);
  const changed: BrowserUnit[] = [];
  try {
    const home = input.env.HOME;
    if (home === undefined || !home.startsWith("/")) return failed("unit");
    await writeBrowserExtension(home);
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
  for (const unit of [browserUnit, browserViewUnit] as const)
    if (
      changed.includes(unit) &&
      !(await systemctl(command, "try-restart", unit))
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
    selector: layout(input.base).selector,
    run: input.run,
    env: input.env,
  });
}

/** Whether a view unit is the installer's for this base and entry: the
 * marker on its first line AND the exact `ExecStart=` line this base's
 * selector and the entry give, as `unitBelongsToBase` proves the Launchpad's.
 * Its other lines may come from another version of the installer. */
export function viewUnitBelongsToBase(
  unitText: string,
  entry: BrowserEntry,
  selector: string,
): boolean {
  if (!unitText.startsWith(unitMarker)) return false;
  try {
    return unitText.split("\n").includes(browserViewExecStart(entry, selector));
  } catch {
    // A port or origin no ExecStart can carry was never written by the
    // installer.
    return false;
  }
}

/** What `restartStaleBrowserView` found and did. */
export type BrowserViewRefresh =
  | "restarted"
  | "current"
  | "not-running"
  | "not-supervised"
  | "not-installed"
  | "foreign-unit"
  | "unknown"
  | "failed";

/** After an update the view keeps running the installation it started with.
 * Its unit runs this installation's stable selector, so the unit's text stays
 * the same and the update's convergence does not restart it; the old view
 * then serves until a reboot, without what the new version changed (its hub,
 * decision F47, #334). Every update restarts the supervised Launchpad, so the
 * Launchpad restarts the view when it starts, only where all of this holds
 * (Pablo's review of #336), and touches nothing otherwise:
 * - the base is supervised: its Launchpad unit is the installer's for this
 *   base (`detectServiceControl`);
 * - the view's unit is the installer's for this base and entry
 *   (`viewUnitBelongsToBase`), never a foreign unit of the same name;
 * - this process is the installed version, the one the selector names;
 * - the running view's executable differs from it, or its file was replaced.
 * A viewer reconnects; the browser and its tabs are untouched. */
export async function restartStaleBrowserView(
  input: Readonly<{
    base: string;
    platform: string;
    entry: BrowserEntry;
    run: ProcessRunner;
    env: Readonly<Record<string, string | undefined>>;
    /** This process's executable (`process.execPath`). */
    executable: string;
    readlink?: (path: string) => Promise<string>;
    realpath?: (path: string) => Promise<string>;
  }>,
): Promise<BrowserViewRefresh> {
  const directory = userUnitDirectory(input.env);
  if (input.platform !== "linux" || directory === undefined)
    return "not-supervised";
  if ((await detectServiceControl(input).catch(() => null)) === null)
    return "not-supervised";
  const selector = layout(input.base).selector;
  const unit = await readFile(join(directory, browserViewUnit), "utf8").catch(
    () => undefined,
  );
  if (unit === undefined) return "not-running";
  if (!viewUnitBelongsToBase(unit, input.entry, selector))
    return "foreign-unit";
  const resolve = input.realpath ?? realpath;
  let installed: string;
  let own: string;
  try {
    installed = await resolve(selector);
    own = await resolve(input.executable);
  } catch {
    return "unknown";
  }
  if (own !== installed) return "not-installed";
  const shown = await input
    .run(
      [
        "systemctl",
        "--user",
        "show",
        "--property=MainPID",
        "--value",
        browserViewUnit,
      ],
      serviceCommandTimeoutMs,
      serviceEnvironment(input.env),
    )
    .catch(() => null);
  if (shown === null || shown === "timeout" || shown.exitCode !== 0)
    return "unknown";
  const pid = Number.parseInt(shown.stdout.trim(), 10);
  if (!Number.isInteger(pid) || pid < 2) return "not-running";
  let running: string;
  try {
    running = await (input.readlink ?? readlink)(`/proc/${pid}/exe`);
  } catch {
    return "unknown";
  }
  if (!running.endsWith(" (deleted)") && running === installed)
    return "current";
  return (await systemctl(input, "try-restart", browserViewUnit))
    ? "restarted"
    : "failed";
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
  "browser-holder-unreadable",
] as const;

const probeTimeoutMs = 3_000;

/** Read-only: `systemctl --user show` of the three units, whether the
 * browser's DevTools and the view answer on loopback, then whether every
 * holder file can be read (root decision 0191 point 32). Skipped where the
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
  // An answer that is ok, and the GitHub login it names, if any.
  const answers = async (url: string) => {
    try {
      const response = await input.fetch(url, {
        redirect: "error",
        signal: AbortSignal.timeout(probeTimeoutMs),
      });
      if (!response.ok) {
        await response.body?.cancel();
        return null;
      }
      const text = await response.text().catch(() => "");
      let github: unknown;
      try {
        github = (JSON.parse(text) as { github?: unknown }).github;
      } catch {}
      return { github: isGithubLogin(github) ? github : null };
    } catch {
      return null;
    }
  };
  if (
    (await answers(`http://127.0.0.1:${browserCdpPort}/json/version`)) === null
  )
    return warn("browser-not-answering");
  const view = await answers(
    `http://127.0.0.1:${input.entry.listenPort}/.lazurio/health`,
  );
  if (view === null) return warn("browser-view-not-answering");
  // Root decision 0191 point 32: the tabs such a file held at the hub's last
  // reading of it do not end until it can be read again, and a file the hub
  // has not read since the view started holds none. Doctor cannot tell which.
  const unreadable = await unreadableHolderFiles(input.env);
  if (unreadable.length > 0)
    return warn("browser-holder-unreadable", { files: unreadable.join(", ") });
  // Whom the browser's kept github.com sign-in names (#504): signed in to
  // GitHub as this login, a public name. None in a public Environment,
  // whose view removes that sign-in.
  return view.github === null
    ? Object.freeze({ outcome: "ok" as const })
    : Object.freeze({
        outcome: "ok" as const,
        context: Object.freeze({ github: view.github }),
      });
}
