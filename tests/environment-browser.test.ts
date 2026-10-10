import { afterEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  browserCommand,
  browserLink,
  runBrowserCommand,
} from "../src/browser/cli";
import { browserExtensionDigest } from "../src/browser/people/extension";
import {
  browserCdpPort,
  browserProfileDirectory,
  browserUnit,
  browserViewUnit,
  displayUnit,
  installEnvironmentBrowser,
  observeEnvironmentBrowser,
  renderBrowserUnit,
  renderBrowserViewUnit,
  renderDisplayUnit,
} from "../src/browser/units";
import {
  browserEntryOf,
  browserViewUrl,
  isBrowserSession,
  resolveBrowserView,
} from "../src/browser/view";
import {
  BrowserWindowFailure,
  ensureThreadWindow,
  threadSession,
  type WindowSeams,
} from "../src/browser/window";
import { initializeHandoverFolder } from "../src/folder/initialize-folder";
import { parseMachineEntry } from "../src/folder/machine-binding";
import { renderManual } from "../src/folder/manual";
import { executionOs } from "../src/folder/platform";
import { presetProfile } from "../src/folder/presets";
import type { AuthFetcher } from "../src/launchpad/hosted-trust";
import { startLaunchpad } from "../src/launchpad/server";
import type { ProcessRunner } from "../src/update/self-check";
import { unitMarker } from "../src/update/service-control";
import {
  binding,
  bindings,
  entries,
  organizationWithEntry,
  withBrowser,
} from "./fixtures/machine-bindings";
import organizationContext from "./fixtures/machine-context.json";
import { commitOf, target } from "./fixtures/update-world";

// The Environment browser (root decision 0191, decisions F38 and F39): its
// units, their observation, the view's link, a thread's window and the CLI.
// No real systemd, browser or agent-browser: every command is recorded and
// answered. The people's view service itself is tested in
// environment-browser-view.test.ts.

const origin = "https://browser.workspace.example.lazurio.io";
const { team: _team, ...withoutTeamOwner } = organizationContext.owner;
const entry = Object.freeze({ origin, listenPort: 4848 });
const selector = "/home/operator/.local/share/lazurio/bin/lazurio";

let root: string | undefined;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});
async function temporary(prefix: string) {
  root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  return root;
}

// ---- Units -------------------------------------------------------------------

// The unit texts: the screen and the browser as proven on a Remote
// Environment on 2026-10-05 (Xvfb waits for its socket, Chrome is the browser
// unit's main process), the browser with F39's flags and its extension's
// digest, and the people's view as a long-running service of this
// installation.
const displayLines = [
  unitMarker,
  "[Unit]",
  "Description=Lazurio Environment display: the virtual screen of the Environment browser",
  "ConditionFileIsExecutable=/usr/bin/Xvfb",
  "",
  "[Service]",
  "Type=simple",
  "ExecStart=/usr/bin/Xvfb :1 -screen 0 1920x1080x24 -nolisten tcp",
  "ExecStartPost=/bin/sh -c 'i=0; while [ ! -S /tmp/.X11-unix/X1 ]; do i=$$((i+1)); [ $$i -gt 100 ] && exit 1; sleep 0.1; done'",
  "Restart=on-failure",
  "RestartSec=2",
  "",
  "[Install]",
  "WantedBy=default.target",
  "",
];
const browserLines = [
  unitMarker,
  "[Unit]",
  "Description=Lazurio Environment browser: one Chromium shared by the Environment's agents",
  "BindsTo=lazurio-display.service",
  "After=lazurio-display.service",
  "",
  "[Service]",
  "Type=simple",
  "Environment=DISPLAY=:1",
  `Environment=LAZURIO_BROWSER_EXTENSION=${browserExtensionDigest}`,
  "ExecStartPre=-/bin/rm -rf %h/.local/share/lazurio-browser/profile/Default/Sessions",
  'ExecStart=/bin/sh -c \'b=$$(ls -d %h/.agent-browser/browsers/chrome-*/chrome %h/.agent-browser/browsers/chrome-*/chrome-linux64/chrome 2>/dev/null | sort -V | tail -n 1); [ -x "$$b" ] || exit 78; exec "$$b" --user-data-dir=%h/.local/share/lazurio-browser/profile --remote-debugging-port=9222 --no-first-run --no-default-browser-check --password-store=basic --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows --hide-crash-restore-bubble --window-size=1280,900 --deny-permission-prompts --load-extension=%h/.local/share/lazurio-browser/extension --disable-features=DisableLoadExtensionCommandLineSwitch about:blank\'',
  "Restart=always",
  "RestartSec=3",
  "RestartPreventExitStatus=78",
  "MemoryHigh=25%",
  "MemoryMax=30%",
  "OOMPolicy=continue",
  "OOMScoreAdjust=250",
  "",
  "[Install]",
  "WantedBy=default.target",
  "",
];

test("the three units render the screen, the browser with its extension and the people's view", () => {
  expect(renderDisplayUnit().split("\n")).toEqual(displayLines);
  expect(renderBrowserUnit().split("\n")).toEqual(browserLines);
  expect(renderBrowserViewUnit(entry, selector).split("\n")).toEqual([
    unitMarker,
    "[Unit]",
    "Description=Lazurio Environment browser view: one tab of a person is one tab of the Environment browser",
    "After=lazurio-browser.service",
    "",
    "[Service]",
    "Type=simple",
    "Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin",
    `ExecStart=${selector} browser serve --port 4848 --origin ${origin}`,
    "Restart=always",
    "RestartSec=2",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ]);
  // DevTools is never exposed: no address flag, so Chrome binds loopback.
  expect(renderBrowserUnit()).not.toContain("remote-debugging-address");
  expect(browserCdpPort).toBe(9222);
});

// Root decision 0195 point 4 (plan DEV-6656): on 2026-10-10 a work Remote
// Environment of 8 GiB froze. The kernel killed one process of the browser,
// systemd's default OOMPolicy=stop then stopped the whole browser, and Chrome
// came back with every tab of the last session, so memory was full again
// within two minutes. The browser now has a budget of its own, a lost tab costs
// only that tab, and a restarted browser opens none of the old tabs.
function serviceDirectives(unit: string): Map<string, string> {
  const directives = new Map<string, string>();
  const service = unit.slice(unit.indexOf("[Service]"), unit.indexOf("[Install]"));
  for (const line of service.split("\n")) {
    const split = line.indexOf("=");
    if (split > 0) directives.set(line.slice(0, split), line.slice(split + 1));
  }
  return directives;
}

test("the browser has a memory budget of its own, well below half the Environment's memory, and an exhausted budget costs a tab, not the browser", () => {
  const directives = serviceDirectives(renderBrowserUnit());
  const percent = (name: string) => {
    const value = directives.get(name) ?? "";
    expect(value).toMatch(/^\d+%$/);
    return Number.parseInt(value, 10);
  };
  // Relative to the Environment's memory, so a larger Environment gives its
  // browser more without another unit text. Reclaim and slow down first, then
  // a hard limit well below half of the Environment.
  expect(percent("MemoryHigh")).toBeLessThan(percent("MemoryMax"));
  expect(percent("MemoryMax")).toBeLessThanOrEqual(30);
  // A process the kernel kills inside the budget (a tab's renderer) ends that
  // tab, not the unit: systemd's default (stop) would end every window.
  expect(directives.get("OOMPolicy")).toBe("continue");
  // The user manager gives every user service 200 and Chrome gives a tab's
  // renderer 300: the rest of the browser sits between, so the kernel takes a
  // tab first, then the browser, then a Module, never the other way round.
  const adjust = Number(directives.get("OOMScoreAdjust"));
  expect(adjust).toBeGreaterThan(200);
  expect(adjust).toBeLessThan(300);
});

// The restorer is Chrome itself. Chrome for Testing 154 on Linux, started with
// the unit's flags on a profile with a previous session, reopened every tab of
// it after a clean exit, after SIGTERM (systemd's stop) and, with
// --hide-crash-restore-bubble, after SIGKILL. With the profile's Sessions
// directory gone it opened only the unit's about:blank in every case (PR
// evidence). So the unit removes that directory before each start, and keeps
// everything else of the profile: the Environment's sign-ins stay.
test("a restarted browser starts without the previous session's tabs and keeps the Environment's sign-ins", async () => {
  const home = await temporary("browser-restart-");
  const profile = browserProfileDirectory(home);
  const directives = serviceDirectives(renderBrowserUnit());
  const pre = directives.get("ExecStartPre") ?? "";
  // Optional ("-"): a browser that comes back with old tabs is better than no
  // browser at all.
  expect(pre.startsWith("-")).toBe(true);
  const command = pre.slice(1).replaceAll("%h", home).split(" ");
  // The directory removed is the one of the profile Chrome is started with.
  expect(directives.get("ExecStart")).toContain(
    `--user-data-dir=${browserProfileDirectory("%h")}`,
  );
  const run = async () => {
    const child = Bun.spawn(command, { stdout: "ignore", stderr: "pipe" });
    expect(await child.exited).toBe(0);
  };

  // A fresh profile: nothing to remove, the start goes on.
  await run();

  const kept = [
    "Local State",
    "Default/Preferences",
    "Default/Cookies",
    "Default/Login Data",
    "Default/Local Storage/leveldb/000003.log",
  ];
  for (const file of [
    ...kept,
    "Default/Sessions/Session_13436112497496356",
    "Default/Sessions/Tabs_13436008915240832",
  ]) {
    await mkdir(join(profile, file, ".."), { recursive: true });
    await writeFile(join(profile, file), "x");
  }
  await run();
  expect(await readdir(join(profile, "Default"))).not.toContain("Sessions");
  for (const file of kept)
    expect(await readFile(join(profile, file), "utf8")).toBe("x");
});

function recorder(failing: string[] = []) {
  const commands: string[][] = [];
  const run: ProcessRunner = async (command) => {
    commands.push([...command]);
    return { exitCode: failing.includes(command[2] ?? "") ? 1 : 0, stdout: "" };
  };
  return { commands, run };
}

test("installed only for a hosted operator whose handover routes the view; the browser restarts only when its own unit changed", async () => {
  const directory = join(await temporary("browser-units-"), "units");
  await mkdir(directory, { recursive: true });
  const { commands, run } = recorder();
  const env = { HOME: root, XDG_RUNTIME_DIR: "/run/user/1000" };

  expect(
    await installEnvironmentBrowser({
      directory,
      hosted: false,
      entry,
      selector,
      run,
      env,
    }),
  ).toEqual({ state: "skipped-not-hosted" });
  expect(
    await installEnvironmentBrowser({
      directory,
      hosted: true,
      entry: undefined,
      selector,
      run,
      env,
    }),
  ).toEqual({ state: "skipped-not-declared" });
  expect(await readdir(directory)).toEqual([]);
  expect(commands).toEqual([]);

  expect(
    await installEnvironmentBrowser({
      directory,
      hosted: true,
      entry,
      selector,
      run,
      env,
    }),
  ).toEqual({ state: "enabled" });
  expect((await readdir(directory)).sort()).toEqual(
    [browserUnit, browserViewUnit, displayUnit].sort(),
  );
  expect(commands).toEqual([
    ["systemctl", "--user", "daemon-reload"],
    [
      "systemctl",
      "--user",
      "enable",
      displayUnit,
      browserUnit,
      browserViewUnit,
    ],
    ["systemctl", "--user", "try-restart", browserUnit],
    ["systemctl", "--user", "try-restart", browserViewUnit],
    ["systemctl", "--user", "start", displayUnit, browserUnit, browserViewUnit],
  ]);
  // The extension is written next to the profile, never into it.
  expect(
    (
      await readdir(join(root ?? "", ".local/share/lazurio-browser/extension"))
    ).sort(),
  ).toEqual(["background.js", "manifest.json", "menu.js", "webauthn.js"]);
  const written = await stat(join(directory, browserUnit));

  // Repeated with the same entry: nothing rewritten, no reload, no restart;
  // `start` of active units changes nothing.
  commands.length = 0;
  expect(
    await installEnvironmentBrowser({
      directory,
      hosted: true,
      entry,
      selector,
      run,
      env,
    }),
  ).toEqual({ state: "enabled" });
  expect((await stat(join(directory, browserUnit))).mtimeMs).toBe(
    written.mtimeMs,
  );
  expect(commands).toEqual([
    [
      "systemctl",
      "--user",
      "enable",
      displayUnit,
      browserUnit,
      browserViewUnit,
    ],
    ["systemctl", "--user", "start", displayUnit, browserUnit, browserViewUnit],
  ]);

  // The gateway moved the view's port: only the view is rewritten and
  // restarted.
  commands.length = 0;
  expect(
    await installEnvironmentBrowser({
      directory,
      hosted: true,
      entry: { origin, listenPort: 4849 },
      selector,
      run,
      env,
    }),
  ).toEqual({ state: "enabled" });
  expect(await readFile(join(directory, browserViewUnit), "utf8")).toContain(
    "--port 4849",
  );
  expect(commands.filter((command) => command.includes("try-restart"))).toEqual(
    [["systemctl", "--user", "try-restart", browserViewUnit]],
  );
  expect(
    commands.some((command) =>
      ["stop", "restart", "kill"].includes(command[2] ?? ""),
    ),
  ).toBe(false);
});

test("a unit someone else wrote is left alone, and a refusing manager is a finding, never a throw", async () => {
  const directory = join(await temporary("browser-units-"), "units");
  await mkdir(directory, { recursive: true });
  const env = { HOME: root };
  await writeFile(join(directory, browserUnit), "[Unit]\nDescription=mine\n");
  const { commands, run } = recorder();
  const foreign = await installEnvironmentBrowser({
    directory,
    hosted: true,
    entry,
    selector,
    run,
    env,
  });
  expect(foreign).toMatchObject({ state: "foreign-unit", unit: browserUnit });
  expect(await readFile(join(directory, browserUnit), "utf8")).toBe(
    "[Unit]\nDescription=mine\n",
  );
  expect(commands).toEqual([]);
  await rm(join(directory, browserUnit));

  for (const [step, expected] of [
    ["daemon-reload", "reload"],
    ["enable", "enable"],
    ["start", "start"],
  ] as const) {
    await rm(directory, { recursive: true, force: true });
    await mkdir(directory, { recursive: true });
    const failing = recorder([step]);
    expect(
      await installEnvironmentBrowser({
        directory,
        hosted: true,
        entry,
        selector,
        run: failing.run,
        env,
      }),
    ).toMatchObject({ state: "failed", step: expected });
  }
});

// ---- Doctor ------------------------------------------------------------------

function managerAnswering(states: Record<string, string>) {
  const run: ProcessRunner = async (command) => {
    const unit = command.at(-1) ?? "";
    const state = states[unit] ?? "active";
    return {
      exitCode: 0,
      stdout:
        state === "not-found"
          ? "LoadState=not-found\nActiveState=inactive\n"
          : `LoadState=loaded\nActiveState=${state}\n`,
    };
  };
  return run;
}
const answering =
  (down: string[] = []) =>
  async (url: string) =>
    new Response("{}", {
      status: down.some((part) => url.includes(part)) ? 502 : 200,
    });

test("doctor: skipped where the browser cannot be, a warning naming the unit or the probe, ok when it all answers", async () => {
  const base = {
    platform: "linux",
    env: { XDG_RUNTIME_DIR: "/run/user/1000" },
    supervised: true,
    hosted: async () => true,
    entry,
    run: managerAnswering({}),
    fetch: answering(),
  } as const;
  expect(
    await observeEnvironmentBrowser({ ...base, platform: "darwin" }),
  ).toEqual({ outcome: "skipped", reason: "no-user-manager" });
  expect(
    await observeEnvironmentBrowser({ ...base, supervised: false }),
  ).toEqual({ outcome: "skipped", reason: "not-supervised" });
  expect(
    await observeEnvironmentBrowser({ ...base, hosted: async () => false }),
  ).toEqual({ outcome: "skipped", reason: "not-hosted" });
  expect(
    await observeEnvironmentBrowser({ ...base, entry: undefined }),
  ).toEqual({ outcome: "skipped", reason: "browser-not-declared" });
  expect(
    await observeEnvironmentBrowser({
      ...base,
      run: managerAnswering({ [browserUnit]: "failed" }),
    }),
  ).toEqual({
    outcome: "warn",
    reason: "browser-unit-failed",
    context: { unit: browserUnit },
  });
  expect(
    await observeEnvironmentBrowser({
      ...base,
      run: managerAnswering({ [displayUnit]: "not-found" }),
    }),
  ).toEqual({
    outcome: "warn",
    reason: "browser-unit-not-loaded",
    context: { unit: displayUnit },
  });
  expect(
    await observeEnvironmentBrowser({
      ...base,
      run: managerAnswering({ [browserViewUnit]: "inactive" }),
    }),
  ).toEqual({
    outcome: "warn",
    reason: "browser-unit-inactive",
    context: { unit: browserViewUnit },
  });
  expect(
    await observeEnvironmentBrowser({ ...base, fetch: answering(["9222"]) }),
  ).toEqual({ outcome: "warn", reason: "browser-not-answering" });
  expect(
    await observeEnvironmentBrowser({ ...base, fetch: answering(["4848"]) }),
  ).toEqual({ outcome: "warn", reason: "browser-view-not-answering" });
  expect(await observeEnvironmentBrowser(base)).toEqual({ outcome: "ok" });
});

// ---- The view ----------------------------------------------------------------

// A thread asks for its own tab before its agent opened one (the Browser
// panel of a new T3 Code thread): the view opens the thread's window first,
// so the person and the agent see the same tab. Without a session (the
// Launchpad's panel) it is a new remote tab: the view of every window is
// retired (root decision 0191 point 18, decision F39).
test("the view of a thread is its own tab, opened when it has none; without a session a new tab; nothing when the window cannot be opened", async () => {
  const opened: string[] = [];
  const openWindow = async (session: string) => {
    opened.push(session);
    return { targetId: "A".repeat(32) };
  };
  const thread = "t3-3745367c-d453-41df-b948-75e29eff8651";
  expect(await resolveBrowserView(entry, thread, { openWindow })).toEqual({
    available: true,
    view: `${origin}/t/${"A".repeat(32)}`,
    session: thread,
  });
  expect(opened).toEqual([thread]);
  // No session: a new remote tab, and no window is opened for it here.
  expect(await resolveBrowserView(entry, null, { openWindow })).toEqual({
    available: true,
    view: `${origin}/`,
    session: null,
  });
  expect(opened).toEqual([thread]);
  // The window cannot be opened: unavailable, never another tab.
  const failing = async () => {
    throw new Error("browser-unreachable");
  };
  expect(
    await resolveBrowserView(entry, "t3-another", { openWindow: failing }),
  ).toEqual({ available: false, reason: "view-unavailable" });
  expect(await resolveBrowserView(undefined, null, { openWindow })).toEqual({
    available: false,
    reason: "not-declared",
  });
  // No address carries a token any more.
  expect(browserViewUrl(origin, null)).toBe(`${origin}/`);
  expect(browserViewUrl(origin, "B".repeat(32))).toBe(
    `${origin}/t/${"B".repeat(32)}`,
  );
  expect(browserEntryOf(null)).toBeUndefined();
  expect(
    browserEntryOf({ browserOrigin: origin, browserListenPort: 4848 }),
  ).toEqual(entry);
});

// ---- A thread's window -------------------------------------------------------

test("the session follows the thread: named, T3 Code's, Codex's, Claude Code's; agent-browser's alphabet", () => {
  expect(threadSession("mine", {})).toBe("mine");
  expect(threadSession("bad name", {})).toBeNull();
  expect(
    threadSession(undefined, {
      AGENT_BROWSER_SESSION: "t3-thread",
      CODEX_THREAD_ID: "019a",
    }),
  ).toBe("t3-thread");
  expect(threadSession(undefined, { CODEX_THREAD_ID: "019a-5b2c" })).toBe(
    "codex-019a-5b2c",
  );
  expect(
    threadSession(undefined, { CLAUDE_CODE_SESSION_ID: "5d66.d6b4:x" }),
  ).toBe("claude-5d66-d6b4-x");
  expect(threadSession(undefined, {})).toBeNull();
  expect(
    threadSession(undefined, { CODEX_THREAD_ID: "x".repeat(100) })?.length,
  ).toBe(64);
  expect(isBrowserSession("a".repeat(65))).toBe(false);
});

function windowSeams(
  input: Readonly<{
    socketDir: string;
    targets: string[];
    created?: unknown;
    failing?: string[];
  }>,
) {
  const calls: unknown[] = [];
  const seams: WindowSeams = {
    env: {
      HOME: "/home/operator",
      AGENT_BROWSER_SOCKET_DIR: input.socketDir,
    },
    run: async (command) => {
      calls.push([...command]);
      return {
        exitCode: (input.failing ?? []).some((word) => command.includes(word))
          ? 1
          : 0,
        stdout: "",
      };
    },
    targets: async () => new Set(input.targets),
    cdp: async (method, params) => {
      calls.push([method, params]);
      return input.created ?? { targetId: "NEWTARGET" };
    },
  };
  return { seams, calls };
}

test("a thread's window: the bound one while it is open, otherwise a new window of the shared context bound and pinned without a fixed viewport", async () => {
  const socketDir = await temporary("browser-window-");
  // Bound and open: reused, nothing created.
  await writeFile(
    join(socketDir, "codex-a.target"),
    JSON.stringify({ targetId: "OPEN", url: "about:blank", pinned: true }),
  );
  const reused = windowSeams({ socketDir, targets: ["OPEN"] });
  expect(await ensureThreadWindow("codex-a", undefined, reused.seams)).toEqual({
    session: "codex-a",
    targetId: "OPEN",
    created: false,
  });
  expect(reused.calls).toEqual([]);

  // Bound but closed, or never bound: a new window in the default context
  // (no browserContextId), then agent-browser's own tab binding and a pin by
  // a command that changes nothing: the people's view sets the page size
  // (F39 point 3).
  const created = windowSeams({ socketDir, targets: [] });
  expect(
    await ensureThreadWindow("codex-a", "https://example.com", created.seams),
  ).toEqual({ session: "codex-a", targetId: "NEWTARGET", created: true });
  expect(created.calls).toEqual([
    [
      "Target.createTarget",
      { url: "https://example.com", newWindow: true, width: 1280, height: 900 },
    ],
    [
      "/home/operator/.local/bin/agent-browser",
      "--cdp",
      "9222",
      "--session",
      "codex-a",
      "--no-pin-tab",
      "tab",
      "NEWTARGET",
    ],
    [
      "/home/operator/.local/bin/agent-browser",
      "--cdp",
      "9222",
      "--session",
      "codex-a",
      "--pin-tab",
      "get",
      "url",
    ],
  ]);

  const unbound = windowSeams({ socketDir, targets: [], failing: ["tab"] });
  await expect(
    ensureThreadWindow("codex-b", undefined, unbound.seams),
  ).rejects.toEqual(new BrowserWindowFailure("bind-failed"));
  const refused = windowSeams({ socketDir, targets: [], created: {} });
  await expect(
    ensureThreadWindow("codex-c", undefined, refused.seams),
  ).rejects.toEqual(new BrowserWindowFailure("window-create-failed"));
});

// After the browser restarted (its budget ran out, or an update changed its
// unit), no target id survives and no old tab comes back. A thread whose
// agent-browser session is still pinned to its old window gets a clear,
// recoverable answer from agent-browser (`tab_gone`), and `lazurio browser
// window` gives it a new window of its own: never the start page the restarted
// browser opened, never another thread's tab.
test("after the browser restarts, a thread gets a new window of its own, never the start page or an old tab", async () => {
  const socketDir = await temporary("browser-window-restart-");
  await writeFile(
    join(socketDir, "codex-a.target"),
    JSON.stringify({
      targetId: "BEFORE_RESTART",
      url: "https://example.com/",
      pinned: true,
    }),
  );
  // What the restarted browser has: the unit's about:blank and the window of
  // another thread that already came back.
  const restarted = windowSeams({
    socketDir,
    targets: ["STARTUP_BLANK", "OTHER_THREAD"],
  });
  expect(
    await ensureThreadWindow("codex-a", "https://example.com/", restarted.seams),
  ).toEqual({ session: "codex-a", targetId: "NEWTARGET", created: true });
  expect(restarted.calls[0]).toEqual([
    "Target.createTarget",
    {
      url: "https://example.com/",
      newWindow: true,
      width: 1280,
      height: 900,
    },
  ]);
  // The session is bound to the new window, explicitly, which also ends
  // agent-browser's tab_gone state; then pinned again.
  expect(restarted.calls.slice(1)).toEqual([
    [
      "/home/operator/.local/bin/agent-browser",
      "--cdp",
      "9222",
      "--session",
      "codex-a",
      "--no-pin-tab",
      "tab",
      "NEWTARGET",
    ],
    [
      "/home/operator/.local/bin/agent-browser",
      "--cdp",
      "9222",
      "--session",
      "codex-a",
      "--pin-tab",
      "get",
      "url",
    ],
  ]);
  expect(JSON.stringify(restarted.calls)).not.toMatch(
    /STARTUP_BLANK|OTHER_THREAD|BEFORE_RESTART/,
  );
});

// Review of 24ab283: the Launchpad's view (a T3 thread's panel) and the CLI can
// ask for the same thread's window at the same moment. Both saw no binding and
// each created a window; the binding kept the second, the first was orphaned
// and the person and the agent could again see different windows. The check
// and the creation now run under one lock of the account.
test("two simultaneous requests for one thread's window create it once and both get it", async () => {
  const runtime = await temporary("browser-window-lock-");
  const socketDir = join(runtime, "agent-browser");
  await mkdir(socketDir, { mode: 0o700 });
  const created: string[] = [];
  const open = new Set<string>();
  const pause = () => new Promise((resolve) => setTimeout(resolve, 30));
  const seams: WindowSeams = {
    env: { HOME: "/home/operator", XDG_RUNTIME_DIR: runtime },
    // agent-browser's `tab <id>` writes the binding the next check reads.
    run: async (command) => {
      await pause();
      const index = command.indexOf("tab");
      if (index !== -1 && command[index - 1] === "--no-pin-tab") {
        const session = command[command.indexOf("--session") + 1];
        await writeFile(
          join(socketDir, `${session}.target`),
          JSON.stringify({ targetId: command[index + 1] }),
        );
      }
      return { exitCode: 0, stdout: "" };
    },
    targets: async () => new Set(open),
    cdp: async () => {
      await pause();
      const id = `WINDOW_${created.length + 1}`;
      created.push(id);
      open.add(id);
      return { targetId: id };
    },
  };
  const [first, second] = await Promise.all([
    ensureThreadWindow("t3-new", undefined, seams),
    ensureThreadWindow("t3-new", undefined, seams),
  ]);
  expect(created).toEqual(["WINDOW_1"]);
  expect([first.targetId, second.targetId]).toEqual(["WINDOW_1", "WINDOW_1"]);
  expect([first.created, second.created].sort()).toEqual([false, true]);
  expect(
    JSON.parse(await readFile(join(socketDir, "t3-new.target"), "utf8")),
  ).toEqual({ targetId: "WINDOW_1" });
});

// ---- The recorded entry ------------------------------------------------------

test("the entry records the browser's view both or neither, by the wire rules", () => {
  const base = {
    externalOrigin: "https://launchpad.workspace.example.lazurio.io",
    authCheckUrl: "https://workspace.example.lazurio.io/oauth2/auth",
    authCookieName: "__Secure-lazurio-workspace",
    listenPort: 20000,
    t3codeOrigin: "https://t3code.workspace.example.lazurio.io",
    moduleOriginTemplate: "https://{module}.workspace.example.lazurio.io",
  };
  expect(
    parseMachineEntry({
      ...base,
      browserOrigin: origin,
      browserListenPort: 4848,
    }),
  ).toMatchObject({ browserOrigin: origin, browserListenPort: 4848 });
  expect(parseMachineEntry(base)).not.toHaveProperty("browserOrigin");
  for (const bad of [
    { browserOrigin: origin },
    { browserOrigin: `${origin}/`, browserListenPort: 4848 },
    { browserOrigin: origin, browserListenPort: 80 },
    { browserOrigin: origin, browserListenPort: "4848" },
  ])
    expect(() => parseMachineEntry({ ...base, ...bad })).toThrow();
  // The handover projects it.
  expect(bindings.organizationBrowser.entry).toMatchObject({
    browserOrigin: origin,
    browserListenPort: 4848,
  });
  expect(organizationWithEntry().entry).not.toHaveProperty("browserOrigin");
});

// The Folder tells an agent how to show the Operator a new page without taking
// over a tab they have open (root decision 0191 point 12), and that T3 Code's
// preview tools drive this browser (Lazurio/t3code, plan DEV-6646).
test("the Folder opens a new page in a new tab and names T3 Code's preview tools", () => {
  for (const locale of ["cs", "en"] as const) {
    const manual = renderManual({
      preset: "hosted-organization-personal",
      machine: bindings.organizationBrowser,
      profile: presetProfile("hosted-organization-personal", "linux", {
        locale,
      }),
    });
    const text = manual["manual/this-machine.md"];
    expect(text).toContain("`preview_open`");
    expect(text).toContain("`reuseExistingTab: false`");
    expect(text).toContain("`lazurio browser window --session <");
    expect(text).not.toMatch(/web T3 has none|ve webovém T3 nejsou/);
  }
});

// The browser lives within its memory budget (root decision 0195 point 4):
// over it, the kernel ends a tab, or the whole browser restarts without its
// old tabs. The Folder tells an agent what it then sees and how it goes on:
// a page that stopped answering is opened again; a window that is gone
// (agent-browser's `tab_gone`) is replaced by `lazurio browser window`, whose
// new link goes to the Operator. Never a restart of the browser.
test("the Folder tells an agent how to go on when the browser lost its tab or restarted", () => {
  for (const locale of ["cs", "en"] as const) {
    const text = renderManual({
      preset: "hosted-organization-personal",
      machine: bindings.organizationBrowser,
      profile: presetProfile("hosted-organization-personal", "linux", {
        locale,
      }),
    })["manual/this-machine.md"];
    const line = text
      .split("\n")
      .find((candidate) =>
        candidate.startsWith(
          locale === "cs" ? "- **Po ztrátě karty" : "- **After a lost tab",
        ),
      );
    expect(line).toBeDefined();
    expect(line).toContain("`tab_gone`");
    expect(line).toContain("`lazurio browser window`");
    expect(line).toContain("`open <");
  }
});

// A matter's work happens in the Environment it belongs to: the Operator's
// personal matters and their sign-ins in the personal Environment's browser,
// an Organization's in its Environment (plan DEV-6646, 2026-10-09).
test("the Folder keeps personal matters in the personal browser and an Organization's in its own", () => {
  for (const locale of ["cs", "en"] as const) {
    const render = (
      preset: "hosted-personal" | "hosted-organization-personal",
      machine: typeof bindings.organizationBrowser,
    ) =>
      renderManual({
        preset,
        machine,
        profile: presetProfile(preset, "linux", { locale }),
      })["manual/this-machine.md"];
    const personal = render("hosted-personal", bindings.personalBrowser);
    const work = render(
      "hosted-organization-personal",
      bindings.organizationBrowser,
    );
    const [personalBrowser, workBrowser, otherEnvironment] =
      locale === "cs"
        ? [
            "**Osobní prohlížeč.**",
            "**Prohlížeč Organizace.**",
            "Práce v jiném Environmentu",
          ]
        : [
            "**A personal browser.**",
            "**An Organization's browser.**",
            "Work in another Environment",
          ];
    expect(personal).toContain(personalBrowser);
    expect(personal).toContain(otherEnvironment);
    expect(personal).not.toContain(workBrowser);
    expect(work).toContain(workBrowser);
    expect(work).not.toContain(personalBrowser);
    expect(work).not.toContain(otherEnvironment);
  }
});

// ---- The CLI -----------------------------------------------------------------

async function folderWith(machine: typeof bindings.organizationBrowser) {
  const home = join(await temporary("browser-cli-"), "home");
  await mkdir(home, { mode: 0o700 });
  const folder = join(home, "Lazurio");
  await mkdir(folder, { mode: 0o700 });
  await mkdir(join(folder, "organizations"), { mode: 0o755 });
  await mkdir(join(folder, "personalspace"), { mode: 0o700 });
  const preset = "hosted-organization-personal";
  await initializeHandoverFolder(folder, {
    preset,
    machine,
    profile: presetProfile(preset, executionOs(process.platform)),
  });
  return { home, folder };
}
const context = (env: Record<string, string>, seams?: WindowSeams) => ({
  identity: { version: "1.0.0", commit: commitOf("1.0.0"), target },
  platform: process.platform,
  env,
  executable: "/unused",
  hostedFolder: undefined,
  windowSeams: seams,
});

test.skipIf(process.platform === "win32")(
  "lazurio browser: the thread's window with its link and command; the link alone; nothing without the browser's view",
  async () => {
    const { home, folder } = await folderWith(bindings.organizationBrowser);
    const launchpad = "https://launchpad.workspace.example.lazurio.io";
    const socketDir = join(home, "sockets");
    await mkdir(socketDir);
    const { seams } = windowSeams({ socketDir, targets: [] });
    const env = { HOME: home, CODEX_THREAD_ID: "019a" };

    const window = await runBrowserCommand(
      ["window", "--folder", folder, "--json"],
      context(env, seams),
    );
    expect(window.code).toBe(0);
    expect(JSON.parse(window.stdout ?? "")).toEqual({
      kind: "browser-window",
      session: "codex-019a",
      targetId: "NEWTARGET",
      created: true,
      link: `${origin}/t/NEWTARGET`,
      command: "agent-browser --cdp 9222 --session codex-019a",
    });
    expect(browserLink(launchpad, origin, null)).toBe(`${origin}/`);
    expect(browserLink(launchpad, origin, "codex-019a")).toBe(
      `${launchpad}/.lazurio/browser?session=codex-019a`,
    );
    expect(browserCommand("x")).toBe("agent-browser --cdp 9222 --session x");

    const link = await runBrowserCommand(
      ["link", "--folder", folder],
      context({ HOME: home }),
    );
    expect(link).toEqual({ code: 0, stdout: `${origin}/` });

    // No session from the thread and none named: a usage answer.
    expect(
      (
        await runBrowserCommand(
          ["window", "--folder", folder],
          context({ HOME: home }, seams),
        )
      ).code,
    ).toBe(2);
    expect(
      (await runBrowserCommand(["window", "--url", "file:///etc"], context({})))
        .code,
    ).toBe(2);

    // A Folder whose entry has no view: exit 10, nothing done.
    const plain = await folderWith(organizationWithEntry());
    const none = await runBrowserCommand(
      ["window", "--folder", plain.folder],
      context({ HOME: plain.home, CODEX_THREAD_ID: "019a" }, seams),
    );
    expect(none.code).toBe(10);
    expect(none.stdout).toBeUndefined();
  },
);

// ---- The Launchpad's routes --------------------------------------------------

const freePort = () => {
  const probe = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(""),
  });
  const port = probe.port;
  probe.stop(true);
  if (port === undefined) throw new Error("The probe listens on a port");
  return port;
};

async function hostedLaunchpad(withView: boolean) {
  const parent = await temporary("launchpad-browser-");
  const folder = join(parent, "Lazurio");
  await mkdir(folder, { mode: 0o700 });
  await mkdir(join(folder, "organizations"), { mode: 0o755 });
  await mkdir(join(folder, "personalspace"), { mode: 0o700 });
  const preset = "hosted-organization-personal";
  const listenPort = freePort();
  const host = "workspace.example.lazurio.io";
  const handover = {
    ...entries.organization,
    launchpad: { ...entries.organization.launchpad, listen_port: listenPort },
  };
  await initializeHandoverFolder(folder, {
    preset,
    machine: binding({
      ...organizationContext,
      owner: withoutTeamOwner,
      entry: withView ? withBrowser(handover, host) : handover,
    }),
    profile: presetProfile(preset, executionOs(process.platform)),
  });
  const fetcher: AuthFetcher = async (_url, init) =>
    new Headers(init.headers).get("cookie") ===
    "__Secure-lazurio-workspace=valid"
      ? new Response("ok")
      : new Response("no", { status: 401 });
  const app = await startLaunchpad(
    folder,
    undefined,
    undefined,
    undefined,
    { fetcher },
    {
      path: parent,
      home: parent,
      platform: process.platform,
      run: async () => "timeout",
    },
    {},
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    {
      openWindow: async (session: string) => {
        if (session !== "codex-a") throw new Error("browser-unreachable");
        return { targetId: "C".repeat(32) };
      },
    },
  );
  const base = `http://127.0.0.1:${listenPort}`;
  const valid = {
    host: new URL(`https://launchpad.${host}`).host,
    cookie: "__Secure-lazurio-workspace=valid",
  };
  return {
    get: (path: string, headers: Record<string, string> = valid) =>
      fetch(`${base}${path}`, { headers, redirect: "manual" }),
    post: (path: string) =>
      fetch(`${base}${path}`, {
        method: "POST",
        headers: {
          ...valid,
          origin: `https://launchpad.${host}`,
          "sec-fetch-site": "same-origin",
          "content-type": "application/json",
        },
        body: "{}",
      }),
    close: () => app.close(),
  };
}

test.skipIf(process.platform === "win32")(
  "hosted: /.lazurio/browser.json answers the view and /.lazurio/browser hands a link's browser over to it, behind the gateway's admission",
  async () => {
    const hosted = await hostedLaunchpad(true);
    try {
      const answer = await hosted.get("/.lazurio/browser.json?session=codex-a");
      expect(answer.status).toBe(200);
      expect(answer.headers.get("cache-control")).toBe("no-store");
      const view = `${origin}/t/${"C".repeat(32)}`;
      expect(await answer.json()).toEqual({
        available: true,
        view,
        session: "codex-a",
      });
      const handOver = await hosted.get("/.lazurio/browser?session=codex-a");
      expect([handOver.status, handOver.headers.get("location")]).toEqual([
        302,
        view,
      ]);
      expect(handOver.headers.get("referrer-policy")).toBe("no-referrer");
      // A new remote tab without a session.
      expect(await (await hosted.get("/.lazurio/browser.json")).json()).toEqual(
        { available: true, view: `${origin}/`, session: null },
      );
      // A thread whose window cannot be opened: unavailable, not found.
      expect(
        (await hosted.get("/.lazurio/browser?session=codex-b")).status,
      ).toBe(404);
      // Only `session`, only agent-browser's alphabet, only GET, only
      // admitted.
      for (const path of [
        "/.lazurio/browser.json?session=a%20b",
        "/.lazurio/browser.json?session=a&session=b",
        "/.lazurio/browser.json?other=1",
      ])
        expect((await hosted.get(path)).status).toBe(400);
      expect((await hosted.post("/.lazurio/browser.json")).status).toBe(405);
      expect(
        (await hosted.get("/.lazurio/browser.json", { host: "x" })).status,
      ).toBe(401);
    } finally {
      await hosted.close();
    }
  },
);

test.skipIf(process.platform === "win32")(
  "hosted without the browser's view: unavailable, and the hand-over is not found",
  async () => {
    const hosted = await hostedLaunchpad(false);
    try {
      expect(await (await hosted.get("/.lazurio/browser.json")).json()).toEqual(
        { available: false, reason: "not-declared" },
      );
      expect((await hosted.get("/.lazurio/browser")).status).toBe(404);
    } finally {
      await hosted.close();
    }
  },
);
