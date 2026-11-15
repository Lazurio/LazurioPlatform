import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  browserCommand,
  browserCommandWithoutNotice,
  browserLink,
  runBrowserCommand,
} from "../src/browser/cli";
import {
  agentBrowserSocketDirectory,
  stopSessionDaemon,
} from "../src/browser/contract/node";
import {
  browserCliExit,
  browserViewUrl,
  isStrip,
  threadSession,
} from "../src/browser/contract/pure";
import {
  browserExtensionDigest,
  browserExtensionWorker,
} from "../src/browser/people/extension";
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
import { browserEntryOf, resolveBrowserView } from "../src/browser/view";
import {
  BrowserWindowFailure,
  bindThreadWindow,
  ensureThreadWindow,
  heldThreadWindows,
  openInThreadWindow,
  readThreadSessions,
  recordThreadWindow,
  sessionHoldMayRemain,
  takeTab,
  threadOfSession,
  type WindowSeams,
} from "../src/browser/window";
import { initializeHandoverFolder } from "../src/folder/initialize-folder";
import { parseMachineEntry } from "../src/folder/machine-binding";
import { renderManual } from "../src/folder/manual";
import { executionOs } from "../src/folder/platform";
import { presetProfile } from "../src/folder/presets";
import type { AuthFetcher } from "../src/launchpad/hosted-trust";
import { processNewTabHost } from "../src/launchpad/new-tab-routes";
import { startLaunchpad } from "../src/launchpad/server";
import {
  exitFailure,
  exitOk,
  exitUpdateAvailable,
  exitUsage,
} from "../src/update/errors";
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
import { freePort } from "./fixtures/ports";
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
  'ExecStart=/bin/sh -c \'b=$$(ls -d %h/.agent-browser/browsers/chrome-*/chrome %h/.agent-browser/browsers/chrome-*/chrome-linux64/chrome 2>/dev/null | sort -V | tail -n 1); [ -x "$$b" ] || exit 78; exec "$$b" --user-data-dir=%h/.local/share/lazurio-browser/profile --remote-debugging-port=9222 --no-first-run --no-default-browser-check --password-store=basic --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows --hide-crash-restore-bubble --window-size=1280,900 --deny-permission-prompts --load-extension=%h/.local/share/lazurio-browser/extension --disable-features=DisableLoadExtensionCommandLineSwitch --enable-features=WebMCPTesting,DevToolsWebMCPSupport about:blank\'',
  "Restart=always",
  "RestartSec=3",
  "RestartPreventExitStatus=78",
  "MemoryMax=30%",
  'ExecStartPre=-/bin/sh -c \'m=; while read -r k v u; do [ "$$k" = MemTotal: ] && [ "$$u" = kB ] && m=$$v; done < /proc/meminfo; case $$m in ""|0*|*[!0-9]*) exit 1;; esac; t=$$((m*1024)); b=$$((t-4294967296)); f=$$((t*30/100)); [ $$b -gt $$f ] || b=$$f; exec systemctl --user set-property --runtime %n MemoryMax=$$b\'',
  "MemorySwapMax=20%",
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
// The directives of the unit's [Service], each with every value it has there:
// systemd runs repeated ExecStartPre= lines one after the other.
function serviceDirectives(unit: string): Map<string, string[]> {
  const directives = new Map<string, string[]>();
  const service = unit.slice(
    unit.indexOf("[Service]"),
    unit.indexOf("[Install]"),
  );
  for (const line of service.split("\n")) {
    const split = line.indexOf("=");
    if (split > 0) {
      const name = line.slice(0, split);
      directives.set(name, [
        ...(directives.get(name) ?? []),
        line.slice(split + 1),
      ]);
    }
  }
  return directives;
}
const directive = (directives: Map<string, string[]>, name: string) =>
  directives.get(name)?.join("\n");

test("the browser has a memory budget of its own, and an exhausted budget costs a tab, not the browser or anything else", () => {
  const directives = serviceDirectives(renderBrowserUnit());
  // The unit's own limit is the floor of root decision 0195 point 22, and the
  // limit wherever a start cannot compute more: 30 % of the Environment's
  // memory, as systemd resolves it. The start raises it (next test). What
  // the browser may move to swap stays relative to the Environment's memory.
  expect(directive(directives, "MemoryMax")).toBe("30%");
  expect(directive(directives, "MemorySwapMax")).toBe("20%");
  // No throttle below the limit: without swap, systemd 255 kept a process
  // past MemoryHigh stalled just above it for minutes, and every process of
  // the browser that allocated stalled with it, instead of ending a tab.
  expect(directives.has("MemoryHigh")).toBe(false);
  // A process the kernel kills inside the budget (a tab's renderer) ends that
  // tab, not the unit: systemd's default (stop) would end every window.
  expect(directive(directives, "OOMPolicy")).toBe("continue");
  // The user manager gives every user service 200 and Chrome gives a tab's
  // renderer 300: the rest of the browser sits between, so the kernel takes a
  // tab first, then the browser, then a Module, never the other way round.
  const adjust = Number(directive(directives, "OOMScoreAdjust"));
  expect(adjust).toBeGreaterThan(200);
  expect(adjust).toBeLessThan(300);
});

// Root decision 0195 point 22 (F38's addendum of 2026-10-20): at 30 % the
// browser of an Environment of 8 GiB had about 2.3 GiB, and the kernel ended
// about 80 of its renderers in 7 days (#525). The browser may now take the
// Environment's memory except a reserve of 4 GiB for the core, agents,
// Modules and builds, and never less than 30 %. The memory is the one the
// Environment's system sees (MemTotal), so the reserve stays whole. Before
// each start the unit computes the limit and sets it for this boot on its own
// name (`systemctl --user set-property --runtime %n`), so its text stays the
// same on every Environment, and an Environment resized (which restarts it)
// has its new limit without another step. Run here as systemd runs the line:
// `$$` is a `$`, `%n` the unit's name, against a meminfo of each size, with
// a `systemctl` that records what it is asked. On systemd 255 the same line
// set the cgroup the browser then runs in (PR evidence).
async function computedMemoryLimit(
  directory: string,
  meminfo: string | null,
  systemctlExit = 0,
) {
  await mkdir(directory, { recursive: true });
  const file = join(directory, "meminfo");
  if (meminfo !== null) await writeFile(file, meminfo);
  const asked = join(directory, "asked");
  const bin = join(directory, "bin");
  await mkdir(bin);
  await writeFile(
    join(bin, "systemctl"),
    `#!/bin/sh\nprintf '%s\\n' "$@" > '${asked}'\nexit ${systemctlExit}\n`,
  );
  await chmod(join(bin, "systemctl"), 0o755);
  const line = serviceDirectives(renderBrowserUnit())
    .get("ExecStartPre")
    ?.find((candidate) => candidate.includes("set-property"));
  // Optional ("-"): a start whose computation fails keeps the unit's 30 %.
  const quoted = /^-\/bin\/sh -c '([^']*)'$/.exec(line ?? "")?.[1];
  expect(quoted).toBeDefined();
  const script = (quoted ?? "")
    .replaceAll("$$", "$")
    .replaceAll("%n", browserUnit)
    .replaceAll("/proc/meminfo", file);
  const child = Bun.spawn(["/bin/sh", "-c", script], {
    env: { PATH: `${bin}:/usr/bin:/bin` },
    stdout: "ignore",
    stderr: "ignore",
  });
  const exit = await child.exited;
  const args = await readFile(asked, "utf8").then(
    (text) => text.trimEnd().split("\n"),
    () => null,
  );
  return { exit, args };
}
const meminfo = (kibibytes: number | string) =>
  `MemTotal:       ${kibibytes} kB\nMemFree:          812344 kB\nMemAvailable:    2402100 kB\nSwapTotal:       4194300 kB\n`;

test("the browser's limit is the Environment's memory minus 4 GiB, at least 30 %, set before each start", async () => {
  const directory = await temporary("browser-memory-");
  const limit = (bytes: number) => [
    "--user",
    "set-property",
    "--runtime",
    browserUnit,
    `MemoryMax=${bytes}`,
  ];
  const reserve = 4 * 1024 ** 3;
  for (const [name, kibibytes, bytes] of [
    // 4 GiB: MemTotal − 4 GiB is nothing, 30 % stays.
    ["4", 4011184, 1232235724],
    // 8 GiB, the base Environment: about 3.75 GiB instead of 2.3 GiB.
    ["8", 8131784, 4031979520],
    // 16 GiB (MemTotal 16 770 785 280 B): about 11.6 GiB.
    ["16", 16377720, 12475817984],
    // 64 GiB: about 58.8 GiB.
    ["64", 65842712, 63127969792],
  ] as const) {
    const total = kibibytes * 1024;
    expect(Math.max(Math.floor((total * 30) / 100), total - reserve)).toBe(
      bytes,
    );
    expect(
      await computedMemoryLimit(join(directory, name), meminfo(kibibytes)),
    ).toEqual({ exit: 0, args: limit(bytes) });
  }
  // Where the Environment's memory cannot be read, nothing is set and the
  // unit's 30 % holds: no meminfo, no MemTotal, one that is not a number of
  // kibibytes, or zero, which would otherwise be a limit of nothing.
  for (const [name, text] of [
    ["missing", null],
    ["no-total", "MemFree:          812344 kB\n"],
    ["not-a-number", meminfo("8131784x")],
    ["zero", meminfo(0)],
    ["other-unit", "MemTotal:       8131784 MB\n"],
  ] as const) {
    const computed = await computedMemoryLimit(join(directory, name), text);
    expect(computed.exit).not.toBe(0);
    expect(computed.args).toBeNull();
  }
  // A manager that refuses the setting fails the step, which the unit
  // ignores ("-"): the browser starts with its 30 %.
  const refused = await computedMemoryLimit(
    join(directory, "refused"),
    meminfo(8131784),
    1,
  );
  expect(refused).toEqual({ exit: 1, args: limit(4031979520) });
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
  const pre =
    directives
      .get("ExecStartPre")
      ?.find((candidate) => candidate.includes("/bin/rm ")) ?? "";
  // Optional ("-"): a browser that comes back with old tabs is better than no
  // browser at all.
  expect(pre.startsWith("-")).toBe(true);
  const command = pre.slice(1).replaceAll("%h", home).split(" ");
  // The directory removed is the one of the profile Chrome is started with.
  expect(directive(directives, "ExecStart")).toContain(
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
  ).toEqual(
    [
      browserExtensionWorker,
      "manifest.json",
      "menu.js",
      "payment.js",
      "sheets.js",
      "webauthn.js",
    ].sort(),
  );
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

// Root decision 0191 point 32: doctor names a holder file that cannot be read,
// whose tabs do not end until it can.
test("doctor: a warning names the holder files that cannot be read", async () => {
  const runtime = await mkdtemp(join(tmpdir(), "browser-doctor-"));
  try {
    const holders = join(runtime, "lazurio-browser", "holders");
    await mkdir(holders, { recursive: true });
    const base = {
      platform: "linux",
      env: { XDG_RUNTIME_DIR: runtime },
      supervised: true,
      hosted: async () => true,
      entry,
      run: managerAnswering({}),
      fetch: answering(),
    } as const;
    await writeFile(
      join(holders, "launchpad.json"),
      JSON.stringify({ strip: "launchpad", tabs: [] }),
    );
    expect(await observeEnvironmentBrowser(base)).toEqual({ outcome: "ok" });
    await writeFile(join(holders, "t3-a.json"), "{");
    expect(await observeEnvironmentBrowser(base)).toEqual({
      outcome: "warn",
      reason: "browser-holder-unreadable",
      context: { files: "t3-a.json" },
    });
  } finally {
    await rm(runtime, { recursive: true, force: true });
  }
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
  expect(isStrip("a".repeat(65))).toBe(false);
});

// Target ids as Chrome writes them: 32 hexadecimal digits in upper case. A
// binding or a new target of any other form is no tab (decision F50, C1).
const OPEN = "0E".repeat(16);
const NEWTARGET = "0F".repeat(16);
const STARTUP_BLANK = "1A".repeat(16);
const OTHER_THREAD = "1B".repeat(16);
const BEFORE_RESTART = "1C".repeat(16);

/** What agent-browser leaves of a `tab <id>` that succeeded: the session's
 * binding names the tab (`<socket dir>/<session>.target`, C7). */
async function bindAs(
  command: readonly string[],
  failed: boolean,
  env: Readonly<Record<string, string | undefined>>,
) {
  const tab = command.indexOf("tab");
  const sockets = agentBrowserSocketDirectory(env);
  if (failed || tab < 1 || command[tab - 1] !== "--no-pin-tab") return;
  if (sockets === undefined) return;
  await mkdir(sockets, { recursive: true });
  await writeFile(
    join(sockets, `${command[command.indexOf("--session") + 1]}.target`),
    JSON.stringify({ targetId: command[tab + 1], url: "", pinned: false }),
  );
}

function windowSeams(
  input: Readonly<{
    socketDir: string;
    targets: string[];
    created?: unknown;
    failing?: string[];
    /** The environment instead of a home and the socket directory. */
    env?: Readonly<Record<string, string>>;
    /** What the browser's navigation of a new window comes to. */
    navigation?: "started" | "pending" | "failed";
  }>,
) {
  const calls: unknown[] = [];
  const seams: WindowSeams = {
    env: input.env ?? {
      HOME: "/home/operator",
      AGENT_BROWSER_SOCKET_DIR: input.socketDir,
    },
    run: async (command) => {
      calls.push([...command]);
      const failed = (input.failing ?? []).some((word) =>
        command.includes(word),
      );
      // agent-browser records the tab `tab <id>` bound the session to.
      await bindAs(command, failed, seams.env);
      return { exitCode: failed ? 1 : 0, stdout: "" };
    },
    targets: async () => new Set(input.targets),
    cdp: async (method, params) => {
      calls.push([method, params]);
      return input.created ?? { targetId: NEWTARGET };
    },
    navigate: async (targetId, url) => {
      calls.push(["Page.navigate", targetId, url]);
      return input.navigation ?? "started";
    },
  };
  return { seams, calls };
}

test("a thread's window: the bound one while it is open, otherwise a new window of the shared context bound and pinned without a fixed viewport", async () => {
  const socketDir = await temporary("browser-window-");
  // Bound and open: reused, nothing created.
  await writeFile(
    join(socketDir, "codex-a.target"),
    JSON.stringify({ targetId: OPEN, url: "about:blank", pinned: true }),
  );
  const reused = windowSeams({ socketDir, targets: [OPEN] });
  expect(await ensureThreadWindow("codex-a", undefined, reused.seams)).toEqual({
    session: "codex-a",
    targetId: OPEN,
    created: false,
  });
  // An address never moves the open window (the Folder manual says so).
  expect(
    await ensureThreadWindow("codex-a", "https://example.org", reused.seams),
  ).toEqual({ session: "codex-a", targetId: OPEN, created: false });
  expect(reused.calls).toEqual([]);

  // Bound but closed, or never bound: a new window in the default context
  // (no browserContextId) at about:blank, then agent-browser's own tab
  // binding and a pin by a command that changes nothing (the people's view
  // sets the page size, F39 point 3), and only then the address, as a
  // navigation the browser starts itself (#987).
  const created = windowSeams({ socketDir, targets: [] });
  expect(
    await ensureThreadWindow("codex-a", "https://example.com", created.seams),
  ).toEqual({
    session: "codex-a",
    targetId: NEWTARGET,
    created: true,
    navigation: "started",
  });
  expect(created.calls).toEqual([
    [
      "Target.createTarget",
      { url: "about:blank", newWindow: true, width: 1280, height: 900 },
    ],
    [
      "/home/operator/.local/bin/agent-browser",
      "--cdp",
      "9222",
      "--session",
      "codex-a",
      "--no-pin-tab",
      "tab",
      NEWTARGET,
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
    ["Page.navigate", NEWTARGET, "https://example.com"],
  ]);
  // An address that is slow, or that the browser refuses, leaves the window
  // bound and says how the navigation went.
  for (const navigation of ["pending", "failed"] as const) {
    const slow = windowSeams({ socketDir, targets: [], navigation });
    expect(
      await ensureThreadWindow(
        `codex-${navigation}`,
        "https://example.com/slow",
        slow.seams,
      ),
    ).toEqual({
      session: `codex-${navigation}`,
      targetId: NEWTARGET,
      created: true,
      navigation,
    });
  }

  const unbound = windowSeams({ socketDir, targets: [], failing: ["tab"] });
  await expect(
    ensureThreadWindow("codex-b", undefined, unbound.seams),
  ).rejects.toEqual(new BrowserWindowFailure("bind-failed"));
  const refused = windowSeams({ socketDir, targets: [], created: {} });
  await expect(
    ensureThreadWindow("codex-c", undefined, refused.seams),
  ).rejects.toEqual(new BrowserWindowFailure("window-create-failed"));
});

// One target-id check for every reader (decision F50 point 2, C1): the window
// took any text that was not empty as a binding or a new target.
test("a thread's window takes a target only by its target id: a binding of another form is none, one in lower case names the tab, a new target of another form fails", async () => {
  const socketDir = await temporary("browser-window-ids-");
  // The browser lists a page by that name, but it is no target id: a new
  // window, never that page.
  await writeFile(
    join(socketDir, "codex-a.target"),
    JSON.stringify({ targetId: "OPEN", url: "about:blank", pinned: true }),
  );
  const named = windowSeams({ socketDir, targets: ["OPEN"] });
  expect(await ensureThreadWindow("codex-a", undefined, named.seams)).toEqual({
    session: "codex-a",
    targetId: NEWTARGET,
    created: true,
  });
  // A binding in lower case names the open tab, in upper case.
  await writeFile(
    join(socketDir, "codex-b.target"),
    JSON.stringify({
      targetId: OPEN.toLowerCase(),
      url: "about:blank",
      pinned: true,
    }),
  );
  const lower = windowSeams({ socketDir, targets: [OPEN] });
  expect(await ensureThreadWindow("codex-b", undefined, lower.seams)).toEqual({
    session: "codex-b",
    targetId: OPEN,
    created: false,
  });
  expect(lower.calls).toEqual([]);
  // A new target the browser names in another form is no window.
  const odd = windowSeams({
    socketDir,
    targets: [],
    created: { targetId: "WINDOW_1" },
  });
  await expect(
    ensureThreadWindow("codex-c", undefined, odd.seams),
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
      targetId: BEFORE_RESTART,
      url: "https://example.com/",
      pinned: true,
    }),
  );
  // What the restarted browser has: the unit's about:blank and the window of
  // another thread that already came back.
  const restarted = windowSeams({
    socketDir,
    targets: [STARTUP_BLANK, OTHER_THREAD],
  });
  expect(
    await ensureThreadWindow(
      "codex-a",
      "https://example.com/",
      restarted.seams,
    ),
  ).toEqual({
    session: "codex-a",
    targetId: NEWTARGET,
    created: true,
    navigation: "started",
  });
  expect(restarted.calls[0]).toEqual([
    "Target.createTarget",
    {
      url: "about:blank",
      newWindow: true,
      width: 1280,
      height: 900,
    },
  ]);
  // The session is bound to the new window, explicitly, which also ends
  // agent-browser's tab_gone state; then pinned again, and only then the
  // window goes to its address.
  expect(restarted.calls.slice(1, -1)).toEqual([
    [
      "/home/operator/.local/bin/agent-browser",
      "--cdp",
      "9222",
      "--session",
      "codex-a",
      "--no-pin-tab",
      "tab",
      NEWTARGET,
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
  expect(restarted.calls.at(-1)).toEqual([
    "Page.navigate",
    NEWTARGET,
    "https://example.com/",
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
      const id = String(created.length + 1).padStart(32, "0");
      created.push(id);
      open.add(id);
      return { targetId: id };
    },
    navigate: async () => "started",
  };
  const [first, second] = await Promise.all([
    ensureThreadWindow("t3-new", undefined, seams),
    ensureThreadWindow("t3-new", undefined, seams),
  ]);
  const only = "1".padStart(32, "0");
  expect(created).toEqual([only]);
  expect([first.targetId, second.targetId]).toEqual([only, only]);
  expect([first.created, second.created].sort()).toEqual([false, true]);
  expect(
    JSON.parse(await readFile(join(socketDir, "t3-new.target"), "utf8")),
  ).toEqual({ targetId: only });
});

// ---- A binding that fails (#974) ---------------------------------------------

const FOREIGN = "2A".repeat(16);
const EARLIER = "2B".repeat(16);
const SECOND = "2C".repeat(16);
const STRIP_TAB = "2D".repeat(16);

/** agent-browser 0.37 and 0.43 as #974 found them on the Environment
 * browser: a daemon that starts takes up its session's binding while that
 * tab is open, else makes the first live tab of `Target.getTargets` its own,
 * whoever's it is; `tab <id>` fails on a page that does not answer its probe
 * within 3 + 10 s (`unresponsive`), or answers success without moving
 * (`misreported`), or outlasts the runner (`late`: the runner gives up, the
 * daemon goes on, fails and only then records its tab, and, as 0.37 does,
 * drops a shutdown asked meanwhile, `lateMs` later); and after every command,
 * a failed one too, the daemon records its tab in the session's binding. A
 * shutdown asked on the session's socket ends the daemon, unless the test sets
 * `hooks.shutdown`: `refuse` answers that it did not shut down, `linger`
 * acknowledges but the daemon does not end (its `.pid` stays). `hooks.ended`
 * runs once a shutdown ended the daemon, before the clean-up reads the
 * binding. `quiet()` waits for every command that outlasted the runner. */
async function foreignWorld(
  input: Readonly<{
    first: string;
    open: readonly string[];
    unresponsive?: readonly string[];
    misreported?: readonly string[];
    late?: readonly string[];
    lateMs?: number;
    endWithinMs?: number;
    pages?: Readonly<Record<string, string>>;
  }>,
) {
  const runtime = await temporary("browser-window-974-");
  const sockets = join(runtime, "agent-browser");
  await mkdir(sockets, { recursive: true, mode: 0o700 });
  const open = [...input.open];
  const unresponsive = new Set(input.unresponsive ?? []);
  const misreported = new Set(input.misreported ?? []);
  const late = new Set(input.late ?? []);
  const busy = new Map<string, Promise<void>>();
  const lateWrites: Promise<void>[] = [];
  const hooks: {
    shutdown: "end" | "refuse" | "linger";
    ended?: ((session: string) => Promise<void>) | undefined;
  } = { shutdown: "end" };
  const fresh = [NEWTARGET, SECOND];
  const active = new Map<string, string>();
  const calls: unknown[] = [];
  const binding = async (session: string): Promise<unknown> => {
    try {
      return JSON.parse(
        await readFile(join(sockets, `${session}.target`), "utf8"),
      );
    } catch {
      return null;
    }
  };
  const seams: WindowSeams = {
    env: { HOME: "/home/operator", XDG_RUNTIME_DIR: runtime },
    run: async (command) => {
      calls.push([...command]);
      const session = command[command.indexOf("--session") + 1] as string;
      if (!active.has(session)) {
        const bound = ((await binding(session)) as { targetId?: unknown })
          ?.targetId;
        active.set(
          session,
          typeof bound === "string" && open.includes(bound)
            ? bound
            : input.first,
        );
        await writeFile(join(sockets, `${session}.pid`), `${process.pid}\n`);
      }
      const record = () =>
        writeFile(
          join(sockets, `${session}.target`),
          JSON.stringify({
            targetId: active.get(session),
            url: "",
            pinned: command.includes("--pin-tab"),
          }),
        );
      const tab = command.indexOf("tab");
      let exitCode = 0;
      if (tab !== -1) {
        const id = command[tab + 1] as string;
        if (late.has(id)) {
          const write = (async () => {
            await new Promise((resolve) =>
              setTimeout(resolve, input.lateMs ?? 50),
            );
            await record();
            busy.delete(session);
          })();
          busy.set(session, write);
          lateWrites.push(write);
          return "timeout";
        }
        if (!open.includes(id) || unresponsive.has(id)) exitCode = 1;
        else if (!misreported.has(id)) active.set(session, id);
      }
      await record();
      return { exitCode, stdout: "" };
    },
    targets: async () => new Set(open),
    pages: async () =>
      new Map(open.map((id) => [id, input.pages?.[id] ?? "about:blank"])),
    cdp: async (method, params) => {
      calls.push([method, params]);
      const id = fresh.shift() as string;
      open.push(id);
      return { targetId: id };
    },
    navigate: async (targetId, url) => {
      calls.push(["Page.navigate", targetId, url]);
      return "started";
    },
    daemon: {
      ask: async (socketPath) => {
        const session = basename(socketPath, ".sock");
        calls.push(["shutdown", session]);
        if (hooks.shutdown === "refuse")
          return { kind: "reply", line: '{"success":false}' };
        // Busy with a command: no answer, and the request is dropped.
        if (busy.has(session)) return { kind: "no-answer" };
        if (hooks.shutdown === "end") {
          active.delete(session);
          await rm(join(sockets, `${session}.pid`), { force: true });
          await hooks.ended?.(session);
        }
        return { kind: "reply", line: '{"success":true}' };
      },
      exitWithinMs: 50,
    },
    endWithinMs: input.endWithinMs ?? 2_000,
  };
  /** Every argument and DevTools method used: never a close of a tab. */
  const words = () =>
    calls.flatMap((call) => (Array.isArray(call) ? (call as unknown[]) : []));
  const quiet = () => Promise.all(lateWrites);
  return {
    runtime,
    sockets,
    seams,
    calls,
    binding,
    unresponsive,
    words,
    hooks,
    quiet,
  };
}

// #974: a thread asked for its first window at a page that did not answer;
// agent-browser's `tab <id>` failed after 13 s and left the thread's session
// bound to the tab another agent (`upload-fix`) worked in. `window` failed,
// but the next one handed out that tab and T3 Code took it into the thread.
test("a binding that fails and leaves the session on another agent's tab: the session is let go and that binding removed, no tab is closed, nothing is recorded, and the next window is a new one of the session's own (#974)", async () => {
  const world = await foreignWorld({
    first: FOREIGN,
    open: [FOREIGN],
    unresponsive: [NEWTARGET],
  });
  const other = JSON.stringify({
    targetId: FOREIGN,
    url: "http://127.0.0.1:8701/index.html",
    pinned: true,
  });
  await writeFile(join(world.sockets, "upload-fix.target"), other);
  await expect(
    ensureThreadWindow("t3-thread", "https://example.com/", world.seams, {
      thread: "t3-thread",
    }),
  ).rejects.toEqual(new BrowserWindowFailure("bind-failed"));
  // The session is bound to no tab, and its daemon was asked to end as
  // `done` asks it.
  expect(await world.binding("t3-thread")).toBeNull();
  expect(world.calls).toContainEqual(["shutdown", "t3-thread"]);
  // The other agent's binding is untouched, and no tab was closed: neither
  // agent-browser's `close` nor `tab close`, nor DevTools.
  expect(await readFile(join(world.sockets, "upload-fix.target"), "utf8")).toBe(
    other,
  );
  expect(world.words()).not.toContain("close");
  expect(world.words()).not.toContain("Target.closeTarget");
  // Nothing of the session is left for `tabs` or `done --all`.
  expect(await readThreadSessions("t3-thread", world.seams.env)).toEqual([]);
  // The next window: a new one of its own, never the other agent's tab.
  world.unresponsive.clear();
  expect(
    await ensureThreadWindow("t3-thread", "https://example.com/", world.seams, {
      thread: "t3-thread",
    }),
  ).toEqual({
    session: "t3-thread",
    targetId: SECOND,
    created: true,
    recorded: true,
    navigation: "started",
  });
});

test("a binding counts only once the session's binding names the tab: an answer of success that left the session elsewhere is a failure, and the session is let go (#974)", async () => {
  const world = await foreignWorld({
    first: FOREIGN,
    open: [FOREIGN],
    misreported: [NEWTARGET],
  });
  await expect(
    ensureThreadWindow("codex-a", undefined, world.seams),
  ).rejects.toEqual(new BrowserWindowFailure("bind-failed"));
  expect(await world.binding("codex-a")).toBeNull();
  expect(world.calls).toContainEqual(["shutdown", "codex-a"]);
});

test("a binding whose command outlasts the runner: the daemon goes on and records another agent's tab later, so it is waited for until it ends and that binding removed (#974)", async () => {
  const world = await foreignWorld({
    first: FOREIGN,
    open: [FOREIGN],
    late: [NEWTARGET],
  });
  await expect(
    ensureThreadWindow("t3-thread", undefined, world.seams),
  ).rejects.toEqual(new BrowserWindowFailure("bind-failed"));
  expect(await world.binding("t3-thread")).toBeNull();
  // Asked again once that command was over, the daemon has ended, so
  // nothing records the tab again.
  expect(
    world.calls.filter((call) =>
      Bun.deepEquals(call, ["shutdown", "t3-thread"]),
    ).length,
  ).toBeGreaterThan(1);
  await expect(stat(join(world.sockets, "t3-thread.pid"))).rejects.toThrow();
});

test("browser open's binding that fails: the thread's session stays on its earlier window; one the failure moved to another tab is let go; the page stays open (#974)", async () => {
  const world = await foreignWorld({
    first: FOREIGN,
    open: [FOREIGN, EARLIER, STRIP_TAB],
    unresponsive: [STRIP_TAB],
  });
  // The thread works in its earlier window.
  expect(await bindThreadWindow("t3-thread", EARLIER, world.seams)).toBe(true);
  // The hub's new tab does not answer: the session stays where it worked,
  // and its daemon goes on.
  expect(await bindThreadWindow("t3-thread", STRIP_TAB, world.seams)).toBe(
    false,
  );
  expect(await world.binding("t3-thread")).toMatchObject({
    targetId: EARLIER,
  });
  expect(world.calls).not.toContainEqual(["shutdown", "t3-thread"]);
  // A session with no window yet that the failure left on another agent's
  // tab is let go.
  expect(await bindThreadWindow("t3-other", STRIP_TAB, world.seams)).toBe(
    false,
  );
  expect(await world.binding("t3-other")).toBeNull();
  expect(world.calls).toContainEqual(["shutdown", "t3-other"]);
  expect(world.words()).not.toContain("close");
  expect(world.words()).not.toContain("Target.closeTarget");
});

test("a page the thread shows already that cannot be bound: bind-failed, the session let go, the page left in the strip, no window created (#974)", async () => {
  const world = await foreignWorld({
    first: FOREIGN,
    open: [FOREIGN, STRIP_TAB],
    unresponsive: [STRIP_TAB],
    pages: { [STRIP_TAB]: "https://vault.example.com/#/vault" },
  });
  const holders = join(world.runtime, "lazurio-browser", "holders");
  await mkdir(holders, { recursive: true });
  const strip = JSON.stringify({
    strip: "t3-thread",
    label: "t3-thread",
    tabs: [STRIP_TAB],
  });
  await writeFile(join(holders, "t3-thread.json"), strip);
  await expect(
    ensureThreadWindow(
      "t3-thread",
      "https://vault.example.com/#/send",
      world.seams,
    ),
  ).rejects.toEqual(new BrowserWindowFailure("bind-failed"));
  expect(await world.binding("t3-thread")).toBeNull();
  expect(world.calls).toContainEqual(["shutdown", "t3-thread"]);
  expect(world.words()).not.toContain("Target.createTarget");
  expect(world.words()).not.toContain("close");
  expect(await readFile(join(holders, "t3-thread.json"), "utf8")).toBe(strip);
});

// ---- A binding Lazurio has not verified (Pablo's review of #986) -------------

/** Where `window` marks a session's binding as not verified, beside the
 * window records (`$XDG_RUNTIME_DIR/lazurio-browser/unverified`). */
const unverifiedMark = (runtime: string, session: string) =>
  join(runtime, "lazurio-browser", "unverified", `${session}.json`);

const present = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

const createdWindows = (calls: readonly unknown[]) =>
  calls.filter(
    (call) => Array.isArray(call) && call[0] === "Target.createTarget",
  ).length;

// Pablo's review of #986: a `tab <id>` that outlasted the runner stayed busy
// past the shutdown deadline, the clean-up gave up, and the daemon recorded
// another agent's tab in the session's binding afterwards. The next `window`
// believed that live binding and handed out the other agent's tab.
test("a binding whose command stays busy past the shutdown deadline: the other agent's tab its daemon records afterwards is never handed out, and the next window first lets the daemon end and removes that binding (#974, review of #986)", async () => {
  const world = await foreignWorld({
    first: FOREIGN,
    open: [FOREIGN],
    late: [NEWTARGET],
    lateMs: 300,
    endWithinMs: 50,
  });
  const first = await ensureThreadWindow("t3-thread", undefined, world.seams, {
    thread: "t3-thread",
  }).catch((error: unknown) => error);
  // The daemon goes on and records the other agent's tab after the clean-up
  // stopped waiting for it.
  await world.quiet();
  expect(await world.binding("t3-thread")).toMatchObject({ targetId: FOREIGN });
  // The next window never takes it: a new window of the session's own.
  expect(
    await ensureThreadWindow("t3-thread", undefined, world.seams, {
      thread: "t3-thread",
    }),
  ).toEqual({
    session: "t3-thread",
    targetId: SECOND,
    created: true,
    recorded: true,
  });
  // The first window did not say the session was bound to no other tab: its
  // binding could not be verified yet.
  expect(first).toEqual(new BrowserWindowFailure("binding-unverified"));
  expect(await world.binding("t3-thread")).toMatchObject({ targetId: SECOND });
  expect(await present(unverifiedMark(world.runtime, "t3-thread"))).toBe(false);
  expect(world.words()).not.toContain("close");
  expect(world.words()).not.toContain("Target.closeTarget");
});

for (const mode of ["refuse", "linger"] as const)
  test(`a daemon that ${mode === "refuse" ? "refuses to shut down" : "acknowledges a shutdown but does not end"} after a failed binding: while it runs, window opens nothing and fails, tabs and done --all do not count the session, and its binding is never handed out (#974, review of #986)`, async () => {
    const world = await foreignWorld({
      first: FOREIGN,
      open: [FOREIGN],
      late: [NEWTARGET],
      lateMs: 30,
      endWithinMs: 200,
    });
    world.hooks.shutdown = mode;
    const first = await ensureThreadWindow(
      "t3-thread",
      undefined,
      world.seams,
      { thread: "t3-thread" },
    ).catch((error: unknown) => error);
    await world.quiet();
    expect(await world.binding("t3-thread")).toMatchObject({
      targetId: FOREIGN,
    });
    // Its daemon still runs: the binding cannot be verified, so the next
    // window opens nothing and fails, and closes nothing.
    const created = createdWindows(world.calls);
    await expect(
      ensureThreadWindow("t3-thread", undefined, world.seams, {
        thread: "t3-thread",
      }),
    ).rejects.toEqual(new BrowserWindowFailure("binding-unverified"));
    expect(createdWindows(world.calls)).toBe(created);
    expect(await world.binding("t3-thread")).toMatchObject({
      targetId: FOREIGN,
    });
    // Nor is the session the thread's confirmed window meanwhile.
    expect(await readThreadSessions("t3-thread", world.seams.env)).toEqual([
      {
        session: "t3-thread",
        targetId: FOREIGN,
        running: true,
        socket: false,
        confirmed: false,
        doubt: "unverified",
        owned: true,
        recorded: false,
        taken: null,
      },
    ]);
    expect(await heldThreadWindows("t3-thread", world.seams)).toEqual([]);
    // Once its daemon ends, the next window removes that binding and opens
    // a window of the session's own.
    world.hooks.shutdown = "end";
    expect(
      await ensureThreadWindow("t3-thread", undefined, world.seams, {
        thread: "t3-thread",
      }),
    ).toEqual({
      session: "t3-thread",
      targetId: SECOND,
      created: true,
      recorded: true,
    });
    expect(first).toEqual(new BrowserWindowFailure("binding-unverified"));
    expect(world.words()).not.toContain("close");
    expect(world.words()).not.toContain("Target.closeTarget");
  });

test("a binding the clean-up cannot remove: window does not report the session as bound to no other tab, refuses the session until the binding is gone, and then opens a window of its own (#974, review of #986)", async () => {
  const world = await foreignWorld({
    first: FOREIGN,
    open: [FOREIGN],
    unresponsive: [NEWTARGET],
  });
  // Once the daemon ended, its binding cannot be removed: here a directory
  // stands in its place.
  const target = join(world.sockets, "t3-thread.target");
  world.hooks.ended = async () => {
    await rm(target, { recursive: true, force: true });
    await mkdir(target);
    await writeFile(join(target, "in-the-way"), "");
  };
  await expect(
    ensureThreadWindow("t3-thread", undefined, world.seams, {
      thread: "t3-thread",
    }),
  ).rejects.toEqual(new BrowserWindowFailure("binding-unverified"));
  expect(await present(unverifiedMark(world.runtime, "t3-thread"))).toBe(true);
  expect(await readThreadSessions("t3-thread", world.seams.env)).toEqual([
    {
      session: "t3-thread",
      targetId: null,
      running: false,
      socket: false,
      confirmed: false,
      doubt: "unverified",
      owned: true,
      recorded: false,
      taken: null,
    },
  ]);
  // Still in the way: the next window fails again and opens nothing.
  const created = createdWindows(world.calls);
  await expect(
    ensureThreadWindow("t3-thread", undefined, world.seams, {
      thread: "t3-thread",
    }),
  ).rejects.toEqual(new BrowserWindowFailure("binding-unverified"));
  expect(createdWindows(world.calls)).toBe(created);
  // Gone: the session gets a window of its own.
  world.hooks.ended = undefined;
  await rm(target, { recursive: true, force: true });
  expect(
    await ensureThreadWindow("t3-thread", undefined, world.seams, {
      thread: "t3-thread",
    }),
  ).toMatchObject({ targetId: SECOND, created: true });
  expect(await present(unverifiedMark(world.runtime, "t3-thread"))).toBe(false);
});

test("a binding unreadable before and after a failed command proves nothing: the session is not let off as bound to no other tab, its mark stays, and window refuses it while its daemon runs (#974, second review of #986)", async () => {
  const world = await foreignWorld({
    first: FOREIGN,
    open: [FOREIGN],
    unresponsive: [NEWTARGET],
  });
  world.hooks.shutdown = "refuse";
  // A directory in place of the binding: unreadable before the command and
  // after it, whatever the daemon is on.
  const target = join(world.sockets, "t3-thread.target");
  await mkdir(target);
  await writeFile(join(target, "in-the-way"), "");
  // The daemon answers its failure but cannot record its tab there: the
  // binding reads the same before and after, and says nothing about where
  // the running daemon is.
  const seams = {
    ...world.seams,
    run: (async (...args: Parameters<typeof world.seams.run>) =>
      world.seams
        .run(...args)
        .catch(() => ({ exitCode: 1, stdout: "" }))) as typeof world.seams.run,
  };
  await expect(
    ensureThreadWindow("t3-thread", undefined, seams, {
      thread: "t3-thread",
    }),
  ).rejects.toEqual(new BrowserWindowFailure("binding-unverified"));
  await world.quiet();
  expect(await present(unverifiedMark(world.runtime, "t3-thread"))).toBe(true);
  const created = createdWindows(world.calls);
  await expect(
    ensureThreadWindow("t3-thread", undefined, seams, {
      thread: "t3-thread",
    }),
  ).rejects.toEqual(new BrowserWindowFailure("binding-unverified"));
  expect(createdWindows(world.calls)).toBe(created);
});

// A `window` killed while it bound the session (the harness's own timeout):
// its mark stays, so the binding the fresh daemon recorded meanwhile is not
// believed by `window`, `apps open` or `browser open`.
test("a session marked unverified by a window that did not finish: window, apps open and browser open run no command in it and fail while its daemon runs, then settle it once it ends (#974, review of #986)", async () => {
  const world = await foreignWorld({
    first: FOREIGN,
    open: [FOREIGN, STRIP_TAB],
  });
  // The fresh daemon made the other agent's tab its own and recorded it.
  await world.seams.run(
    [
      "/home/operator/.local/bin/agent-browser",
      "--cdp",
      "9222",
      "--session",
      "t3-thread",
      "--no-pin-tab",
      "get",
      "url",
    ],
    30_000,
  );
  expect(await world.binding("t3-thread")).toMatchObject({ targetId: FOREIGN });
  const mark = unverifiedMark(world.runtime, "t3-thread");
  await mkdir(dirname(mark), { recursive: true });
  await writeFile(
    mark,
    JSON.stringify({
      schema: "lazurio.browser-unverified-binding.v1",
      session: "t3-thread",
      targetId: NEWTARGET,
      before: null,
    }),
  );
  world.hooks.shutdown = "linger";
  const commands = () =>
    world.calls.filter(
      (call) =>
        Array.isArray(call) && String(call[0]).includes("agent-browser"),
    ).length;
  const ran = commands();
  expect(await bindThreadWindow("t3-thread", STRIP_TAB, world.seams)).toBe(
    false,
  );
  await expect(
    openInThreadWindow("t3-thread", "https://app.example.com/", world.seams),
  ).rejects.toEqual(new BrowserWindowFailure("binding-unverified"));
  await expect(
    ensureThreadWindow("t3-thread", "https://example.com/", world.seams),
  ).rejects.toEqual(new BrowserWindowFailure("binding-unverified"));
  expect(commands()).toBe(ran);
  expect(createdWindows(world.calls)).toBe(0);
  expect(await present(mark)).toBe(true);
  // Its daemon ends: the binding to the other agent's tab goes, and the
  // page the hub opened is bound to the session.
  world.hooks.shutdown = "end";
  expect(await bindThreadWindow("t3-thread", STRIP_TAB, world.seams)).toBe(
    true,
  );
  expect(await world.binding("t3-thread")).toMatchObject({
    targetId: STRIP_TAB,
  });
  expect(await present(mark)).toBe(false);
  expect(world.words()).not.toContain("close");
});

test("a mark that cannot be written: the session is not touched, and window fails (#974, review of #986)", async () => {
  const world = await foreignWorld({ first: FOREIGN, open: [FOREIGN] });
  // Something else is where the marks go.
  await mkdir(join(world.runtime, "lazurio-browser"), { recursive: true });
  await writeFile(join(world.runtime, "lazurio-browser", "unverified"), "");
  await expect(
    ensureThreadWindow("t3-thread", undefined, world.seams),
  ).rejects.toEqual(new BrowserWindowFailure("bind-failed"));
  expect(world.words()).not.toContain("tab");
  expect(await world.binding("t3-thread")).toBeNull();
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
    expect(text).toContain("`lazurio browser link --url <");
    expect(text).toContain("`lazurio browser window --session <");
    expect(text).not.toMatch(/web T3 has none|ve webovém T3 nejsou/);
  }
});

// How a page reaches the Operator is explained, not prescribed (F38 addendum of
// 2026-10-12): a plain link, a link to a tab of the Environment, and what each
// client does with them, with ChatGPT Desktop's own browser on the Operator's
// computer, so the agent chooses the way.
test("the Folder explains how a page reaches the Operator in each client and leaves the way to the agent", () => {
  for (const locale of ["cs", "en"] as const) {
    const text = renderManual({
      preset: "hosted-organization-personal",
      machine: bindings.organizationBrowser,
      profile: presetProfile("hosted-organization-personal", "linux", {
        locale,
      }),
    })["manual/this-machine.md"];
    const section = text.slice(
      text.indexOf(
        locale === "cs"
          ? "### Jak uživatel stránku uvidí"
          : "### How the user sees a page",
      ),
      text.indexOf(
        locale === "cs"
          ? "### Práce v prohlížeči"
          : "### Working in the browser",
      ),
    );
    const ways =
      locale === "cs"
        ? [
            "**Obyčejný odkaz**",
            "**Odkaz na záložku Environmentu**",
            "**Webové T3 Code**",
            "**ChatGPT Desktop**",
            "**Launchpad**",
            "vyber tu, která mu dává největší smysl",
            "rádi vidí rovnou vedle chatu",
          ]
        : [
            "**A plain link**",
            "**A link to a tab of the Environment**",
            "**Web T3 Code**",
            "**ChatGPT Desktop**",
            "**The Launchpad**",
            "choose the one that makes the most sense to them",
            "right beside the chat",
          ];
    for (const way of ways) expect(section).toContain(way);
    const bullet = (lead: string) =>
      section.split("\n").find((line) => line.startsWith(`- **${lead}`)) ?? "";
    // A plain address the Operator opens in ChatGPT Desktop runs on their
    // computer: the agent opens it in a new tab of the Environment browser,
    // never with `lazurio browser window --url`, which keeps a window it has.
    const desktop = bullet("ChatGPT Desktop");
    expect(desktop).toContain(
      locale === "cs" ? "bod Nová záložka" : "the point A new tab",
    );
    expect(desktop).not.toContain("lazurio browser window");
    // Web T3 opens the panel by itself only for a thread in view on a wide
    // screen; otherwise the agent's tab waits in the strip.
    expect(
      bullet(locale === "cs" ? "Webové T3 Code" : "Web T3 Code"),
    ).toContain(
      locale === "cs"
        ? "počká v liště panelu"
        : "waits for them in the panel's strip",
    );
    const yourWindow =
      text
        .split("\n")
        .find((line) =>
          line.startsWith(
            locale === "cs" ? "- **Tvoje okno.**" : "- **Your window.**",
          ),
        ) ?? "";
    expect(yourWindow).toContain(
      locale === "cs"
        ? "Adresa z `--url` platí jen pro nové okno"
        : "`--url` applies only to a new window",
    );
    expect(text).not.toMatch(/Pohled pro Operátora|The Operator's view\.\*\*/);
  }
});

// Root decision 0191 point 28: an agent lets go of its window when its work
// there is done, and the hub ends the tab once nothing holds or views it. It
// never closes the tab for everyone with agent-browser's `tab close`.
test("the Folder tells an agent to let go of its window, never to close it for everyone", () => {
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
          locale === "cs" ? "- **Konec.**" : "- **When done.**",
        ),
      );
    expect(line).toContain("`lazurio browser done`");
    expect(line).toMatch(
      locale === "cs"
        ? /`agent-browser … tab close` ani `close` nepoužívej/
        : /Never use `agent-browser … tab close` or `close`/,
    );
    expect(text).not.toMatch(/Close your window with|Své okno zavři/);
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
          locale === "cs" ? "- **Po ztrátě záložky" : "- **After a lost tab",
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
// A work matter from the personal Environment: a window in the work
// Environment's browser over SSH, shown in the right panel by its link, never
// loaded in the personal browser (root 0191 points 19–23, task 503).
test("the personal Folder shows a work Environment's browser by its link and never loads it here", () => {
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
    const [heading, never] =
      locale === "cs"
        ? [
            "**Prohlížeč pracovního Environmentu.**",
            "Pohled ani stránky pracovního Environmentu nikdy nenačítej v prohlížeči tohoto Environmentu.",
          ]
        : [
            "**A work Environment's browser.**",
            "Never load the work Environment's view or its pages in this Environment's browser.",
          ];
    expect(personal).toContain(heading);
    expect(personal).toContain(never);
    expect(personal).toContain("lazurio browser window --session");
    expect(personal).toContain("0.0.45-lazurio.6");
    expect(work).not.toContain(heading);
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
      schema: "lazurio.browser-cli.v1",
      kind: "browser-window",
      session: "codex-019a",
      targetId: NEWTARGET,
      created: true,
      link: `${origin}/t/${NEWTARGET}`,
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
    // With --json each command says so with its own kind (F50 point 2):
    // `link --json` used to answer as `browser-window`.
    for (const action of ["window", "link", "done"] as const) {
      const answer = await runBrowserCommand(
        [action, "--folder", plain.folder, "--json"],
        context({ HOME: plain.home, CODEX_THREAD_ID: "019a" }, seams),
      );
      expect(answer.code).toBe(10);
      expect(JSON.parse(answer.stdout ?? "")).toEqual({
        schema: "lazurio.browser-cli.v1",
        kind: `browser-${action}`,
        available: false,
      });
    }
  },
);

// A development preview (F22 addendum of 2026-10-20) opens in a new tab or a
// new session's window. `--url` applies only when `lazurio browser window`
// creates the window, so a thread that already has one would hand over its
// previous page (Pablo's review of #549). The rendered Folder's own command,
// run for a thread whose window is open, must open the preview's address.
test.skipIf(process.platform === "win32")(
  "the rendered preview command opens the preview for a thread that already has its window",
  async () => {
    const { home, folder } = await folderWith(bindings.organizationBrowser);
    const manual = await readFile(
      join(folder, "manual", "this-machine.md"),
      "utf8",
    );
    const point =
      manual
        .split("\n")
        .find(
          (line) =>
            line.startsWith("- **Development preview.**") ||
            line.startsWith("- **Vývojový náhled.**"),
        ) ?? "";
    expect(point).toContain("`preview_open`");
    expect(point).toContain("`reuseExistingTab: false`");
    expect(point).toMatch(/the point A new tab|bodu Nová záložka/);
    expect(point).toContain("`created: false`");
    // Never the thread's own session with an address.
    expect(point).not.toMatch(/--session <(session|sezení)> --url/);
    const command =
      /`lazurio browser (window --session <(?:session|sezení)>-preview --url <[^>]+> --json)`/.exec(
        point,
      )?.[1];
    expect(command).toBeDefined();

    const socketDir = join(home, "sockets");
    await mkdir(socketDir);
    await writeFile(
      join(socketDir, "codex-019a.target"),
      JSON.stringify({ targetId: OPEN, url: "about:blank", pinned: true }),
    );
    const env = { HOME: home, CODEX_THREAD_ID: "019a" };
    const preview = "http://127.0.0.1:5199/";

    // The trap: the thread's own window comes back unmoved.
    const own = windowSeams({ socketDir, targets: [OPEN] });
    const reused = await runBrowserCommand(
      ["window", "--url", preview, "--folder", folder, "--json"],
      context(env, own.seams),
    );
    expect(JSON.parse(reused.stdout ?? "")).toMatchObject({
      session: "codex-019a",
      targetId: OPEN,
      created: false,
    });
    expect(own.calls).toEqual([]);

    // The manual's command opens a new window at the preview's address.
    const args = (command ?? "")
      .replace(/<(session|sezení)>/, "codex-019a")
      .replace(/<[^>]+>/, preview)
      .split(" ");
    const fresh = windowSeams({ socketDir, targets: [OPEN] });
    const opened = await runBrowserCommand(
      [...args, "--folder", folder],
      context(env, fresh.seams),
    );
    expect(opened.code).toBe(0);
    expect(JSON.parse(opened.stdout ?? "")).toEqual({
      schema: "lazurio.browser-cli.v1",
      kind: "browser-window",
      session: "codex-019a-preview",
      targetId: NEWTARGET,
      created: true,
      link: `${origin}/t/${NEWTARGET}`,
      command: "agent-browser --cdp 9222 --session codex-019a-preview",
    });
    // Opened blank and bound, then sent to the preview (#987).
    expect(fresh.calls[0]).toEqual([
      "Target.createTarget",
      { url: "about:blank", newWindow: true, width: 1280, height: 900 },
    ]);
    expect(fresh.calls.at(-1)).toEqual(["Page.navigate", NEWTARGET, preview]);

    // A preview session that has its window already says so, as the manual
    // tells the agent to check.
    await writeFile(
      join(socketDir, "codex-019a-preview.target"),
      JSON.stringify({ targetId: NEWTARGET, url: preview, pinned: true }),
    );
    const again = windowSeams({ socketDir, targets: [OPEN, NEWTARGET] });
    const taken = await runBrowserCommand(
      [...args, "--folder", folder],
      context(env, again.seams),
    );
    expect(JSON.parse(taken.stdout ?? "")).toMatchObject({ created: false });
    expect(again.calls).toEqual([]);
  },
);

// Root decision 0191 point 28: letting go asks the session's own daemon on
// that session's socket to shut down and never signals a process id (Pablo's
// review of #348): a stale .pid whose number a live process named
// agent-browser now has, even another session's daemon, is never touched.
test.skipIf(process.platform === "win32")(
  "letting go asks the session's own daemon on its socket and signals no process",
  async () => {
    const sockets = await temporary("browser-daemon-");
    const heard: Record<string, string[]> = { "codex-1": [], "codex-2": [] };
    const servers: Server[] = [];
    const daemon = (
      session: "codex-1" | "codex-2",
      reply: (line: string) => string | null,
    ) =>
      new Promise<void>((resolve) => {
        const server = createServer((socket) => {
          socket.on("data", async (chunk) => {
            const line = chunk.toString("utf8").trim();
            heard[session]?.push(line);
            const answer = reply(line);
            if (answer === null) return;
            // agent-browser answers, then exits and removes its .pid.
            socket.write(`${answer}\n`);
            await rm(join(sockets, `${session}.pid`), { force: true });
          });
        });
        servers.push(server);
        server.listen(join(sockets, `${session}.sock`), () => resolve());
      });
    const acknowledged = (line: string) =>
      JSON.stringify({
        id: (JSON.parse(line) as { id: string }).id,
        success: true,
        data: { closed: true },
      });
    // A live process named agent-browser whose id codex-1's stale .pid
    // names: a daemon by process id would end it.
    const named = join(sockets, "agent-browser");
    await symlink("/bin/sleep", named);
    const sleeper = Bun.spawn([named, "30"]);
    try {
      expect(await stopSessionDaemon(sockets, "codex-1")).toBe("none");
      await writeFile(join(sockets, "codex-1.pid"), String(sleeper.pid));
      await daemon("codex-2", acknowledged);
      expect(await stopSessionDaemon(sockets, "codex-1")).toBe("none");
      expect(heard["codex-2"]).toEqual([]);
      expect(sleeper.killed || sleeper.exitCode !== null).toBe(false);
      // A socket file nobody listens on is no daemon either.
      await writeFile(join(sockets, "codex-3.sock"), "");
      expect(await stopSessionDaemon(sockets, "codex-3")).toBe("none");
      // codex-1's own daemon: one shutdown line, then its .pid is gone.
      await daemon("codex-1", acknowledged);
      expect(await stopSessionDaemon(sockets, "codex-1")).toBe("stopped");
      expect(heard["codex-1"]?.map((line) => JSON.parse(line))).toEqual([
        {
          id: "lazurio-browser-done",
          action: "__agent_browser_internal_shutdown",
        },
      ]);
      expect(
        await readFile(join(sockets, "codex-1.pid")).catch(() => null),
      ).toBeNull();
      expect(sleeper.exitCode).toBeNull();
      // A daemon that refuses: nothing changed.
      expect(
        await stopSessionDaemon(sockets, "codex-2", {
          ask: async () => ({
            kind: "reply",
            line: JSON.stringify({ success: false, error: "busy" }),
          }),
        }),
      ).toBe("refused");
      // No answer after the command went out, or an answer while the .pid
      // stays (Pablo's review of 3122df40): the daemon may still hold the
      // window, so it is never reported as stopped.
      expect(
        await stopSessionDaemon(sockets, "codex-2", {
          ask: async () => ({ kind: "no-answer" }),
        }),
      ).toBe("unconfirmed");
      await writeFile(join(sockets, "codex-2.pid"), "4343");
      expect(
        await stopSessionDaemon(sockets, "codex-2", {
          ask: async () => ({ kind: "reply", line: '{"success":true}' }),
          exitWithinMs: 150,
        }),
      ).toBe("unconfirmed");
      // A name outside the session alphabet is no session.
      expect(await stopSessionDaemon(sockets, "../codex-1")).toBe("none");
    } finally {
      sleeper.kill();
      for (const server of servers) server.close();
    }
  },
);

// What letting go sends today (#348): agent-browser's internal shutdown, one
// line on the session's own socket. The contract's vectors pin only the
// outcomes, since decision F50 point 2 moves this to a documented command of
// the agent-browser fork; this test keeps today's line.
test("letting go sends agent-browser's internal shutdown, one exact line, on the session's own socket", async () => {
  const sent: (readonly [string, string])[] = [];
  const directory = join(tmpdir(), "agent-browser");
  expect(
    await stopSessionDaemon(directory, "codex-1", {
      ask: async (socketPath, line) => {
        sent.push([socketPath, line]);
        return { kind: "absent" };
      },
    }),
  ).toBe("none");
  expect(sent).toEqual([
    [
      join(directory, "codex-1.sock"),
      '{"id":"lazurio-browser-done","action":"__agent_browser_internal_shutdown"}\n',
    ],
  ]);
});

// Pablo's review of Lazurio/t3code#56, which has the same code: a socket or a
// .pid that cannot be reached proves nothing, so it is never "none" or
// "stopped".
test.skipIf(process.platform === "win32")(
  "letting go: a socket or a .pid that cannot be reached is unconfirmed",
  async () => {
    const sockets = await temporary("browser-daemon-");
    const server = createServer(() => undefined);
    await new Promise<void>((resolve) =>
      server.listen(join(sockets, "codex-1.sock"), () => resolve()),
    );
    try {
      // A daemon listens, but its socket cannot be opened.
      await chmod(join(sockets, "codex-1.sock"), 0o000);
      expect(await stopSessionDaemon(sockets, "codex-1")).toBe("unconfirmed");
    } finally {
      server.close();
    }
    // Acknowledged, and the .pid's directory cannot be read.
    const pids = await temporary("browser-pid-");
    await writeFile(join(pids, "codex-1.pid"), "4242\n");
    try {
      expect(
        await stopSessionDaemon(pids, "codex-1", {
          ask: async () => {
            await chmod(pids, 0o000);
            return { kind: "reply", line: '{"success":true}' } as const;
          },
          exitWithinMs: 150,
        }),
      ).toBe("unconfirmed");
    } finally {
      await chmod(pids, 0o700);
    }
    expect(await readFile(join(pids, "codex-1.pid"), "utf8")).toBe("4242\n");
  },
);

// Root decision 0191 points 28 and 29: `done` lets go of the thread's window;
// `link --url` opens a page for the person that nobody holds.
test.skipIf(process.platform === "win32")(
  "lazurio browser: done lets go of the thread's window; link --url opens a page that nobody holds",
  async () => {
    const { home, folder } = await folderWith(bindings.organizationBrowser);
    const socketDir = join(home, "sockets");
    await mkdir(socketDir);
    const asked: string[] = [];
    const daemonSeams = {
      ask: async (socketPath: string) => {
        asked.push(socketPath);
        return socketPath.endsWith("/codex-019a.sock")
          ? ({ kind: "reply", line: '{"success":true}' } as const)
          : ({ kind: "absent" } as const);
      },
      exists: async () => false,
    };
    const env = {
      HOME: home,
      CODEX_THREAD_ID: "019a",
      AGENT_BROWSER_SOCKET_DIR: socketDir,
    };
    const done = await runBrowserCommand(
      ["done", "--folder", folder, "--json"],
      {
        ...context(env),
        daemonSeams,
      },
    );
    expect(done.code).toBe(0);
    expect(JSON.parse(done.stdout ?? "")).toEqual({
      schema: "lazurio.browser-cli.v1",
      kind: "browser-done",
      session: "codex-019a",
      outcome: "stopped",
    });
    expect(asked).toEqual([join(socketDir, "codex-019a.sock")]);
    // No daemon runs for another session: nothing to let go, and done.
    const none = await runBrowserCommand(
      ["done", "--session", "codex-other", "--folder", folder, "--json"],
      { ...context(env), daemonSeams },
    );
    expect(JSON.parse(none.stdout ?? "")).toMatchObject({ outcome: "none" });
    expect(none.code).toBe(0);
    // A daemon that refuses, or acknowledges but has not exited: a failure.
    const refused = await runBrowserCommand(
      ["done", "--folder", folder, "--json"],
      {
        ...context(env),
        daemonSeams: {
          ask: async () =>
            ({ kind: "reply", line: '{"success":false}' }) as const,
        },
      },
    );
    expect(refused.code).toBe(1);
    expect(JSON.parse(refused.stdout ?? "")).toMatchObject({
      outcome: "refused",
    });
    const lingering = await runBrowserCommand(
      ["done", "--folder", folder, "--json"],
      {
        ...context(env),
        daemonSeams: {
          ask: async () =>
            ({ kind: "reply", line: '{"success":true}' }) as const,
          exists: async () => true,
          exitWithinMs: 150,
        },
      },
    );
    expect(lingering.code).toBe(1);
    expect(JSON.parse(lingering.stdout ?? "")).toMatchObject({
      outcome: "unconfirmed",
    });
    // done has no --url, and needs a session.
    expect(
      (
        await runBrowserCommand(
          ["done", "--url", "https://example.com/", "--folder", folder],
          context(env),
        )
      ).code,
    ).toBe(2);
    expect(
      (
        await runBrowserCommand(
          ["done", "--folder", folder],
          context({ HOME: home }),
        )
      ).code,
    ).toBe(2);

    // link --url: one loopback request for a tab without a strip.
    const opened: unknown[] = [];
    const tab = "AB".repeat(16);
    const openTab = async (
      _entry: { listenPort: number },
      url: string,
      strip: string | null,
    ) => {
      opened.push([url, strip]);
      return { kind: "opened", tab } as const;
    };
    const link = await runBrowserCommand(
      ["link", "--url", "https://example.com/x", "--folder", folder, "--json"],
      { ...context({ HOME: home }), openTab },
    );
    expect(link.code).toBe(0);
    expect(JSON.parse(link.stdout ?? "")).toEqual({
      schema: "lazurio.browser-cli.v1",
      kind: "browser-link",
      session: null,
      targetId: tab,
      link: `${origin}/t/${tab}`,
    });
    expect(opened).toEqual([["https://example.com/x", null]]);
    // The hub refused or did not answer: a failure. With a session: usage.
    const unreachable = await runBrowserCommand(
      ["link", "--url", "https://example.com/x", "--folder", folder],
      {
        ...context({ HOME: home }),
        openTab: async () =>
          ({ kind: "refused", reason: "hub-unreachable" }) as const,
      },
    );
    expect(unreachable.code).toBe(1);
    expect(
      (
        await runBrowserCommand(
          [
            "link",
            "--url",
            "https://example.com/x",
            "--session",
            "codex-1",
            "--folder",
            folder,
          ],
          { ...context({ HOME: home }), openTab },
        )
      ).code,
    ).toBe(2);
    expect(opened).toHaveLength(1);
    // No address on the view host of an Environment browser, for the
    // person's page or a window's first one (F50 point 2): a usage answer,
    // nothing opened.
    for (const args of [
      ["link", "--url", `${origin}/t/${tab}`],
      ["window", "--url", `${origin}/t/${tab}`, "--session", "codex-1"],
      ["link", "--url", "https://browser.vm-02.example.lazurio.io/"],
    ]) {
      const viewHost = await runBrowserCommand([...args, "--folder", folder], {
        ...context({ HOME: home }),
        openTab,
      });
      expect(viewHost.code).toBe(2);
      expect(viewHost.stderr).toBe("The view does not open that address.");
    }
    expect(opened).toHaveLength(1);
  },
);

// Root decision 0201 point 5 (Lazurio/LazurioPlatform#427): `lazurio
// browser open <address>` is the Remote Environment's default browser, the
// command BROWSER and xdg-open hand a page to. It opens only http and https,
// through the view's hub like `link --url`; in a T3 Code thread it binds the
// thread's session to the new tab, so T3 Code's right panel shows it.
test.skipIf(process.platform === "win32")(
  "lazurio browser open: an http(s) address opens in the Environment browser, a T3 Code thread's panel shows it, nothing else opens",
  async () => {
    const { home, folder } = await folderWith(bindings.organizationBrowser);
    const tab = "CD".repeat(16);
    const link = `${origin}/t/${tab}`;
    const opened: unknown[] = [];
    const openTab = async (
      _entry: { listenPort: number },
      url: string,
      strip: string | null,
    ) => {
      opened.push([url, strip]);
      return { kind: "opened", tab } as const;
    };
    const socketDir = await temporary("browser-open-");

    // A person's terminal or the Launchpad: no thread. One tab that nobody
    // holds, as `link --url` opens it, and its link.
    const signIn =
      "https://auth.openai.com/oauth/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback";
    const plain = await runBrowserCommand(
      ["open", signIn, "--folder", folder],
      {
        ...context({ HOME: home }),
        openTab,
      },
    );
    expect(plain).toEqual({
      code: 0,
      stdout: `Opened in the Environment browser: ${link}`,
    });
    const json = await runBrowserCommand(
      ["open", "http://localhost:3000/", "--folder", folder, "--json"],
      { ...context({ HOME: home }), openTab },
    );
    expect(json.code).toBe(0);
    expect(JSON.parse(json.stdout ?? "")).toEqual({
      schema: "lazurio.browser-cli.v1",
      kind: "browser-open",
      session: null,
      targetId: tab,
      link,
    });
    expect(opened).toEqual([
      [signIn, null],
      ["http://localhost:3000/", null],
    ]);

    // Only http and https: no file, script, scheme of an app or a bare path
    // reaches the browser. A usage answer that says why, nothing opened.
    for (const address of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "about:blank",
      "data:text/html,<p>x</p>",
      "mailto:someone@example.com",
      "chrome://settings",
      "ftp://example.com/",
      "/home/operator/report.html",
      "example.com",
    ]) {
      const refused = await runBrowserCommand(
        ["open", address, "--folder", folder],
        { ...context({ HOME: home }), openTab },
      );
      expect(refused.code).toBe(2);
      expect(refused.stderr).toBe(
        "The Environment browser opens only http and https addresses.",
      );
    }
    // The view host of an Environment browser is never opened inside it
    // (F50 point 2).
    const viewHost = await runBrowserCommand(
      ["open", `${origin}/t/${tab}`, "--folder", folder],
      { ...context({ HOME: home }), openTab },
    );
    expect(viewHost.code).toBe(2);
    expect(viewHost.stderr).toBe("The view does not open that address.");
    // One address, given as the argument xdg-open and BROWSER pass.
    for (const args of [
      ["open"],
      ["open", "https://example.com/", "https://example.org/"],
      ["open", "--url", "https://example.com/"],
      ["open", "https://example.com/", "--session", "codex-1"],
    ])
      expect(
        (
          await runBrowserCommand([...args, "--folder", folder], {
            ...context({ HOME: home }),
            openTab,
          })
        ).code,
      ).toBe(2);
    expect(opened).toHaveLength(2);

    // The hub refused the address: usage; did not answer: a failure that
    // says what to do.
    const invalid = await runBrowserCommand(
      ["open", "https://example.com/", "--folder", folder],
      {
        ...context({ HOME: home }),
        openTab: async () =>
          ({ kind: "refused", reason: "invalid-request" }) as const,
      },
    );
    expect(invalid.code).toBe(2);
    const unreachable = await runBrowserCommand(
      ["open", "https://example.com/", "--folder", folder, "--json"],
      {
        ...context({ HOME: home }),
        openTab: async () =>
          ({ kind: "refused", reason: "hub-unreachable" }) as const,
      },
    );
    expect(unreachable.code).toBe(1);
    expect(unreachable.stderr).toBe(
      "The users' view of the Environment browser did not open the tab. Run lazurio doctor.",
    );

    // An Environment without the browser (a workstation, an entry without
    // its view): exit 10 and why, nothing opened, so the calling program
    // shows its address instead.
    const plainFolder = await folderWith(organizationWithEntry());
    const none = await runBrowserCommand(
      ["open", signIn, "--folder", plainFolder.folder],
      { ...context({ HOME: plainFolder.home }), openTab },
    );
    expect(none.code).toBe(10);
    expect(none.stdout).toBeUndefined();
    expect(none.stderr).toBe(
      "The address did not open: this Environment has no Environment browser. Open it in your own browser.",
    );
    const noneJson = await runBrowserCommand(
      ["open", signIn, "--folder", plainFolder.folder, "--json"],
      { ...context({ HOME: plainFolder.home }), openTab },
    );
    expect(noneJson.code).toBe(10);
    expect(JSON.parse(noneJson.stdout ?? "")).toEqual({
      schema: "lazurio.browser-cli.v1",
      kind: "browser-open",
      available: false,
    });
    expect(opened).toHaveLength(2);

    // A T3 Code thread (AGENT_BROWSER_SESSION, which T3 Code sets for every
    // process of a thread): the tab is opened for the thread's strip and the
    // thread's session is bound to it and pinned, agent-browser's own
    // commands. T3 Code records a tab its thread's session newly binds and
    // shows it in the thread's panel (F47 point 4).
    const thread = windowSeams({ socketDir, targets: [] });
    const inThread = await runBrowserCommand(
      ["open", signIn, "--folder", folder, "--json"],
      {
        ...context(
          { HOME: home, AGENT_BROWSER_SESSION: "t3-thread-1" },
          thread.seams,
        ),
        openTab,
      },
    );
    expect(inThread.code).toBe(0);
    expect(JSON.parse(inThread.stdout ?? "")).toEqual({
      schema: "lazurio.browser-cli.v1",
      kind: "browser-open",
      session: "t3-thread-1",
      targetId: tab,
      link,
    });
    expect(opened.at(-1)).toEqual([signIn, "t3-thread-1"]);
    expect(thread.calls).toEqual([
      [
        "/home/operator/.local/bin/agent-browser",
        "--cdp",
        "9222",
        "--session",
        "t3-thread-1",
        "--no-pin-tab",
        "tab",
        tab,
      ],
      [
        "/home/operator/.local/bin/agent-browser",
        "--cdp",
        "9222",
        "--session",
        "t3-thread-1",
        "--pin-tab",
        "get",
        "url",
      ],
    ]);
    const inThreadText = await runBrowserCommand(
      ["open", signIn, "--folder", folder],
      {
        ...context(
          { HOME: home, AGENT_BROWSER_SESSION: "t3-thread-1" },
          windowSeams({ socketDir, targets: [] }).seams,
        ),
        openTab,
      },
    );
    expect(inThreadText).toEqual({
      code: 0,
      stdout: `Opened in the Environment browser, in this thread's panel: ${link}`,
    });

    // A binding that fails leaves the page open: done, without the thread,
    // and stderr says the panel does not show it.
    const unbound = await runBrowserCommand(
      ["open", signIn, "--folder", folder],
      {
        ...context(
          { HOME: home, AGENT_BROWSER_SESSION: "t3-thread-1" },
          windowSeams({ socketDir, targets: [], failing: ["--no-pin-tab"] })
            .seams,
        ),
        openTab,
      },
    );
    expect(unbound.code).toBe(0);
    expect(unbound.stdout).toBe(`Opened in the Environment browser: ${link}`);
    expect(unbound.stderr).toBe(
      "This thread's panel does not show it: agent-browser did not bind the thread's session to the tab.",
    );

    // A Codex or Claude Code thread has no panel that follows its session,
    // and its agent's own window would end once nothing holds it: its
    // session is never moved. The page opens for nobody's strip.
    const codex = windowSeams({ socketDir, targets: [] });
    const inCodex = await runBrowserCommand(
      ["open", signIn, "--folder", folder, "--json"],
      {
        ...context({ HOME: home, CODEX_THREAD_ID: "019a" }, codex.seams),
        openTab,
      },
    );
    expect(JSON.parse(inCodex.stdout ?? "")).toMatchObject({
      session: null,
      targetId: tab,
    });
    expect(opened.at(-1)).toEqual([signIn, null]);
    expect(codex.calls).toEqual([]);
  },
);

// The default browser runs inside other programs (gh, codex, an agent's
// xdg-open), so it ends without the update notice, as the view service does.
test("lazurio browser open and serve end without the update notice", () => {
  expect(browserCommandWithoutNotice(["open", "https://example.com/"])).toBe(
    true,
  );
  expect(browserCommandWithoutNotice(["serve", "--port", "1"])).toBe(true);
  for (const action of ["window", "link", "done"])
    expect(browserCommandWithoutNotice([action])).toBe(false);
});

// The browser command's exit statuses are the CLI's own.
test("lazurio browser exits as the rest of the CLI does", () => {
  expect(browserCliExit).toEqual({
    done: exitOk,
    failure: exitFailure,
    usage: exitUsage,
    // `take` without --confirm described the tab and changed nothing
    // (F38, addendum of 2026-11-15).
    confirm: 3,
    noBrowser: exitUpdateAvailable,
  });
});

// ---- The Launchpad's routes --------------------------------------------------

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
    undefined,
    undefined,
    undefined,
    undefined,
    // Nová karta's host without a runtime directory or service manager: the
    // test never reads or writes this account's holder files (F47).
    processNewTabHost({}, process.platform),
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

// ---- A thread's windows: tabs, done --all and the note of window ------------

// An agent sees which windows of the Environment browser are its own
// thread's, never another thread's, and lets go of them all at once. A
// session's name is no evidence of its thread (Pablo's review of #971):
// names are free, so `team-2` may be a window of `team` or a thread of its
// own. `lazurio browser window` records the thread when it opens a window
// (`$XDG_RUNTIME_DIR/lazurio-browser/windows/<session>.json`), and only that
// record, or the thread's own session, makes a window the thread's. No
// number limits them (decided on 2026-11-14): a new window opens however
// many the thread holds, and `window` names the others. The bindings and
// daemons are agent-browser's files (C7); the tabs are the hub's loopback
// list.
const TAB_A = "2A".repeat(16);
const TAB_B = "2B".repeat(16);
const TAB_C = "2C".repeat(16);
const TAB_D = "2D".repeat(16);
const TAB_E = "2E".repeat(16);
const TAB_F = "2F".repeat(16);

async function bindSessionFiles(
  socketDir: string,
  session: string,
  targetId: string,
  files: Readonly<{ pid?: string; sock?: boolean }> = {},
) {
  await writeFile(
    join(socketDir, `${session}.target`),
    JSON.stringify({ targetId, url: "about:blank", pinned: true }),
  );
  if (files.pid !== undefined)
    await writeFile(join(socketDir, `${session}.pid`), files.pid);
  if (files.sock === true)
    await writeFile(join(socketDir, `${session}.sock`), "");
}

/** A window `lazurio browser window` opened for `thread`: agent-browser's
 * binding and the thread's record. */
async function openedWindow(
  env: Readonly<Record<string, string>>,
  session: string,
  thread: string,
  targetId: string,
  files: Readonly<{ pid?: string; sock?: boolean }> = {},
) {
  await bindSessionFiles(
    env.AGENT_BROWSER_SOCKET_DIR as string,
    session,
    targetId,
    files,
  );
  expect(await recordThreadWindow(env, { session, thread, targetId })).toBe(
    true,
  );
}

const tabFacts = (
  id: string,
  facts: Readonly<{
    agents?: string[];
    viewers?: number;
    url?: string;
    title?: string;
    grace?: { kind: "release" | "viewer" | "unviewed"; endsAt: string } | null;
  }> = {},
) => ({
  id,
  url: facts.url ?? `https://example.com/${id.slice(0, 2)}`,
  title: facts.title ?? "",
  favicon: null,
  openedAt: "2026-11-14T10:00:00.000Z",
  usedAt: "2026-11-14T10:00:00.000Z",
  opener: { kind: "unknown" } as const,
  agents: facts.agents ?? [],
  holders: [],
  viewers: facts.viewers ?? 0,
  closing: null,
  grace: facts.grace ?? null,
});

const sessionsOf = async (
  thread: string,
  env: Readonly<Record<string, string>>,
) =>
  (await readThreadSessions(thread, env)).map(
    ({ session, confirmed }) => [session, confirmed] as const,
  );

test("a thread's windows are its own session and those recorded for it: a name that looks like a further window decides nothing", async () => {
  const base = await temporary("browser-thread-");
  const socketDir = join(base, "sockets");
  await mkdir(socketDir);
  const env = {
    HOME: "/home/operator",
    AGENT_BROWSER_SOCKET_DIR: socketDir,
    XDG_RUNTIME_DIR: join(base, "run"),
  };
  const running = { pid: String(process.pid) };
  // Three independent threads whose sessions look like a thread and its
  // further windows.
  await openedWindow(env, "team", "codex-x", TAB_A, running);
  await openedWindow(env, "team-2", "codex-y", TAB_B, running);
  await openedWindow(env, "team-3", "codex-z", TAB_C, running);
  expect(await sessionsOf("codex-x", env)).toEqual([["team", true]]);
  expect(await sessionsOf("codex-y", env)).toEqual([["team-2", true]]);
  expect(await sessionsOf("codex-z", env)).toEqual([["team-3", true]]);
  // A thread named team takes its own session and nothing else, whatever
  // its name; that another thread opened its session is not confirmed.
  expect(await sessionsOf("team", env)).toEqual([["team", false]]);
  expect(await sessionsOf("team-2", env)).toEqual([["team-2", false]]);
  // Another T3 Code thread whose id ends in -1, a window of t3-a with a
  // name of no pattern, and a session opened without lazurio browser
  // window (no record): each only its own thread's.
  await bindSessionFiles(socketDir, "t3-a-1", TAB_D, running);
  await bindSessionFiles(socketDir, "t3-a", TAB_E, running);
  await openedWindow(env, "t3-a-1000", "t3-a", TAB_F, running);
  await bindSessionFiles(socketDir, "t3-a-2", TAB_F, running);
  expect(await sessionsOf("t3-a", env)).toEqual([
    ["t3-a", true],
    ["t3-a-1000", true],
  ]);
  expect(await sessionsOf("t3-a-1", env)).toEqual([["t3-a-1", true]]);
  expect(await sessionsOf("t3-a-2", env)).toEqual([["t3-a-2", true]]);
  // A session named on purpose is a window of the thread its record names,
  // or of its own thread without one.
  for (const [session, thread] of [
    ["team", "codex-x"],
    ["team-2", "codex-y"],
    ["team-3", "codex-z"],
    ["t3-a-1", "t3-a-1"],
    ["t3-a-1000", "t3-a"],
    ["t3-a-2", "t3-a-2"],
  ] as const)
    expect(await threadOfSession(session, env)).toEqual({
      kind: "thread",
      thread,
    });
  // The record is the Platform's own file, owner-only, beside the holders.
  const record = join(env.XDG_RUNTIME_DIR, "lazurio-browser", "windows");
  expect((await stat(join(record, "team-2.json"))).mode & 0o777).toBe(0o600);
  expect((await stat(record)).mode & 0o777).toBe(0o700);
  expect(
    JSON.parse(await readFile(join(record, "team-2.json"), "utf8")),
  ).toEqual({
    schema: "lazurio.browser-window.v1",
    session: "team-2",
    thread: "codex-y",
    targetId: TAB_B,
  });
  // Nothing is recorded without a runtime directory, nor for a name
  // outside the grammar: such a window is its own session's only.
  expect(
    await recordThreadWindow(
      { AGENT_BROWSER_SOCKET_DIR: socketDir },
      { session: "team-4", thread: "codex-x", targetId: TAB_A },
    ),
  ).toBe(false);
  expect(
    await recordThreadWindow(env, {
      session: "../team-4",
      thread: "codex-x",
      targetId: TAB_A,
    }),
  ).toBe(false);
  expect(await readThreadSessions("codex-1", { HOME: "/nowhere" })).toEqual([]);
});

test("a recorded window is confirmed while its binding names the recorded tab; the thread holds the confirmed ones whose daemon runs, and no number limits them", async () => {
  const base = await temporary("browser-thread-");
  const socketDir = join(base, "sockets");
  await mkdir(socketDir);
  const env = {
    HOME: "/home/operator",
    AGENT_BROWSER_SOCKET_DIR: socketDir,
    XDG_RUNTIME_DIR: join(base, "run"),
  };
  const running = { pid: String(process.pid) };
  await bindSessionFiles(socketDir, "codex-1", TAB_A, running);
  await openedWindow(env, "codex-1-2", "codex-1", TAB_B, running);
  // Let go: its binding stays, no daemon runs.
  await openedWindow(env, "notes", "codex-1", TAB_C);
  // Bound to another tab since it was opened: maybe stale, not confirmed.
  await openedWindow(env, "codex-1-5", "codex-1", TAB_D, running);
  await bindSessionFiles(socketDir, "codex-1-5", TAB_E, running);
  // A record that cannot be read names no thread: the window may be any
  // thread's, this one's too, so it is never left out and never confirmed.
  await bindSessionFiles(socketDir, "codex-1-preview", TAB_E, running);
  await writeFile(
    join(
      env.XDG_RUNTIME_DIR,
      "lazurio-browser",
      "windows",
      "codex-1-preview.json",
    ),
    "{",
  );
  expect(
    (await readThreadSessions("codex-1", env)).map(
      ({ session, targetId, running, confirmed, doubt }) => [
        session,
        targetId,
        running,
        confirmed,
        doubt,
      ],
    ),
  ).toEqual([
    ["codex-1", TAB_A, true, true, null],
    ["codex-1-2", TAB_B, true, true, null],
    ["codex-1-5", TAB_E, true, false, "rebound"],
    ["codex-1-preview", TAB_E, true, false, "unreadable"],
    ["notes", TAB_C, false, true, null],
  ]);
  // Another thread sees it too, as not confirmed, and none of codex-1's.
  expect(await sessionsOf("codex-2", env)).toEqual([
    ["codex-1-preview", false],
  ]);
  // A daemon whose process ended no longer runs.
  expect(
    (await readThreadSessions("codex-1", env, () => false)).map(
      (entry) => entry.running,
    ),
  ).toEqual([false, false, false, false, false]);
  expect(await threadOfSession("codex-1-5", env)).toEqual({
    kind: "ambiguous",
  });
  expect(await threadOfSession("codex-1-preview", env)).toEqual({
    kind: "ambiguous",
  });

  const open = [TAB_A, TAB_B, TAB_C, TAB_D, TAB_E];
  const addresses = new Map(
    open.map((id) => [id, `https://example.com/${id.slice(0, 2)}`]),
  );
  // The windows it holds: a confirmed running daemon bound to an open page,
  // with its address. notes was let go; codex-1-5 is not confirmed.
  const full = windowSeams({ socketDir, targets: open, env });
  expect(
    await heldThreadWindows("codex-1", {
      ...full.seams,
      pages: async () => addresses,
    }),
  ).toEqual([
    { session: "codex-1", targetId: TAB_A, url: "https://example.com/2A" },
    { session: "codex-1-2", targetId: TAB_B, url: "https://example.com/2B" },
  ]);
  // Without the pages' addresses, the open targets; a closed page is no
  // longer held.
  expect(
    await heldThreadWindows(
      "codex-1",
      windowSeams({ socketDir, targets: [TAB_A, TAB_D], env }).seams,
    ),
  ).toEqual([{ session: "codex-1", targetId: TAB_A, url: "" }]);
  // No number limits them: a new window opens however many the thread
  // holds, and is recorded as the thread's.
  expect(
    await ensureThreadWindow("codex-1-4", undefined, full.seams, {
      thread: "codex-1",
    }),
  ).toEqual({
    session: "codex-1-4",
    targetId: NEWTARGET,
    created: true,
    recorded: true,
  });
  await bindSessionFiles(socketDir, "codex-1-4", NEWTARGET);
  expect(await threadOfSession("codex-1-4", env)).toEqual({
    kind: "thread",
    thread: "codex-1",
  });
  // The window a session has already stays its own and is never recorded
  // anew, whoever asks for it.
  expect(
    await ensureThreadWindow("codex-1-2", undefined, full.seams, {
      thread: "codex-other",
    }),
  ).toEqual({ session: "codex-1-2", targetId: TAB_B, created: false });
  expect(await threadOfSession("codex-1-2", env)).toEqual({
    kind: "thread",
    thread: "codex-1",
  });
});

test("after nothing answered on a session's socket, its window may still be held while its .pid names a running process and its binding is there", async () => {
  const socketDir = await temporary("browser-hold-");
  const env = { HOME: "/home/operator", AGENT_BROWSER_SOCKET_DIR: socketDir };
  await bindSessionFiles(socketDir, "codex-1", TAB_A, {
    pid: String(process.pid),
  });
  expect(await sessionHoldMayRemain(env, "codex-1")).toBe(true);
  expect(await sessionHoldMayRemain(env, "codex-1", () => false)).toBe(false);
  // A .pid that cannot be understood counts as running, as the hub counts it.
  await writeFile(join(socketDir, "codex-1.pid"), "");
  expect(await sessionHoldMayRemain(env, "codex-1", () => false)).toBe(true);
  // Without a binding the hub counts no hold; without a .pid no daemon.
  await writeFile(join(socketDir, "codex-2.pid"), String(process.pid));
  expect(await sessionHoldMayRemain(env, "codex-2")).toBe(false);
  await bindSessionFiles(socketDir, "codex-3", TAB_B);
  expect(await sessionHoldMayRemain(env, "codex-3")).toBe(false);
  expect(await sessionHoldMayRemain({}, "codex-1")).toBe(false);
});

test.skipIf(process.platform === "win32")(
  "lazurio browser tabs lists only the calling thread's windows; done --all lets go of every one; a new window names the thread's others",
  async () => {
    const { home, folder } = await folderWith(bindings.organizationBrowser);
    const socketDir = join(home, "sockets");
    await mkdir(socketDir);
    const running = String(process.pid);
    const env = {
      HOME: home,
      CODEX_THREAD_ID: "019a",
      AGENT_BROWSER_SOCKET_DIR: socketDir,
      XDG_RUNTIME_DIR: join(home, "run"),
    };
    await bindSessionFiles(socketDir, "codex-019a", TAB_A, {
      pid: running,
      sock: true,
    });
    await openedWindow(env, "codex-019a-2", "codex-019a", TAB_B, {
      sock: true,
    });
    // Let go, and the user still views it.
    await openedWindow(env, "codex-019a-3", "codex-019a", TAB_C);
    // Its tab is gone.
    await openedWindow(env, "codex-019a-4", "codex-019a", "3F".repeat(16));
    // Another thread's windows are never listed nor let go, whatever their
    // names: one recorded for another thread, one opened without lazurio
    // browser window, and another thread's own session.
    await openedWindow(env, "codex-019a-9", "codex-other", TAB_E, {
      pid: running,
      sock: true,
    });
    await bindSessionFiles(socketDir, "codex-019a-7", TAB_F, {
      pid: running,
      sock: true,
    });
    await bindSessionFiles(socketDir, "codex-other", TAB_D, {
      pid: running,
      sock: true,
    });
    const grace = {
      kind: "viewer" as const,
      endsAt: "2026-11-14T10:05:00.000Z",
    };
    const listed = {
      kind: "tabs" as const,
      tabs: [
        tabFacts(TAB_A, { agents: ["codex-019a"], title: "Pull request" }),
        tabFacts(TAB_B, { agents: ["codex-019a-2"], viewers: 1 }),
        tabFacts(TAB_C, { viewers: 2 }),
        tabFacts(TAB_D, { agents: ["codex-other"], viewers: 1 }),
        tabFacts(TAB_E, { agents: ["codex-019a-9"] }),
        tabFacts(TAB_F, { agents: ["codex-019a-7"] }),
      ],
    };
    const listTabs = async () => listed;
    // The hub has no title for a tab nobody views: the browser's is taken.
    const pageTitles = async () =>
      new Map([
        [TAB_B, "From the browser"],
        [TAB_D, "Another thread's page"],
      ]);
    const tabs = await runBrowserCommand(
      ["tabs", "--folder", folder, "--json"],
      { ...context(env), listTabs, pageTitles },
    );
    expect(tabs.code).toBe(0);
    expect(JSON.parse(tabs.stdout ?? "")).toEqual({
      schema: "lazurio.browser-cli.v1",
      kind: "browser-tabs",
      session: "codex-019a",
      windows: [
        {
          session: "codex-019a",
          targetId: TAB_A,
          url: "https://example.com/2A",
          title: "Pull request",
          link: `${origin}/t/${TAB_A}`,
          held: true,
          viewers: 0,
          sleeping: false,
          endsAt: null,
        },
        {
          session: "codex-019a-2",
          targetId: TAB_B,
          url: "https://example.com/2B",
          title: "From the browser",
          link: `${origin}/t/${TAB_B}`,
          held: true,
          viewers: 1,
          sleeping: false,
          endsAt: null,
        },
        {
          session: "codex-019a-3",
          targetId: TAB_C,
          url: "https://example.com/2C",
          title: "",
          link: `${origin}/t/${TAB_C}`,
          held: false,
          viewers: 2,
          sleeping: false,
          endsAt: null,
        },
      ],
      ambiguous: [],
      complete: true,
      taken: [],
    });
    // A window of the thread named on purpose lists the same thread.
    const fromFurther = await runBrowserCommand(
      ["tabs", "--session", "codex-019a-2", "--folder", folder, "--json"],
      { ...context(env), listTabs, pageTitles },
    );
    expect(JSON.parse(fromFurther.stdout ?? "").session).toBe("codex-019a");
    // Another thread's window, and one with no record, are refused: nothing
    // is listed.
    for (const session of ["codex-019a-9", "codex-019a-7", "codex-other"]) {
      const refused = await runBrowserCommand(
        ["tabs", "--session", session, "--folder", folder, "--json"],
        { ...context(env), listTabs, pageTitles },
      );
      expect(refused.code).toBe(1);
      expect(refused.stdout).toBeUndefined();
      expect(refused.stderr).toBe(
        `${session} is not a window of this thread: lazurio browser window did not open it for this thread, and tabs and done --all take only this thread's windows. If it is yours, let go of it alone with lazurio browser done --session ${session}.`,
      );
    }
    // As text: each window with its link and state, and the reminder to
    // check before telling the user.
    const text = await runBrowserCommand(["tabs", "--folder", folder], {
      ...context(env),
      pageTitles,
      listTabs: async () => ({
        kind: "tabs" as const,
        tabs: [tabFacts(TAB_C, { grace })],
      }),
    });
    expect(text.stdout).toBe(
      [
        "This thread holds 0 windows.",
        "- codex-019a-3: https://example.com/2C",
        `  The user's link: ${origin}/t/${TAB_C}`,
        "  let go; nobody views it; ends at 2026-11-14T10:05:00.000Z unless held or viewed again",
        "Before you tell the user your windows are closed, run lazurio browser tabs again: a window you let go that the user views stays for them.",
      ].join("\n"),
    );
    const empty = await runBrowserCommand(["tabs", "--folder", folder], {
      ...context(env),
      pageTitles,
      listTabs: async () => ({ kind: "tabs" as const, tabs: [] }),
    });
    // codex-019a's daemon still runs: it may hold a window, though no tab
    // is listed; it is the thread's own session, so it is no window here.
    expect(empty.stdout).toBe(
      "This thread has no window in the Environment browser.",
    );
    // The hub did not answer: unknown, a failure.
    const unreachable = await runBrowserCommand(
      ["tabs", "--folder", folder, "--json"],
      {
        ...context(env),
        pageTitles,
        listTabs: async () =>
          ({ kind: "refused", reason: "hub-unreachable" }) as const,
      },
    );
    expect(unreachable.code).toBe(1);
    expect(unreachable.stderr).toContain("did not list its tabs");

    // done --all asks every window of the thread whose daemon may run, and
    // no other.
    const asked: string[] = [];
    const acknowledging = {
      ask: async (socketPath: string) => {
        asked.push(socketPath);
        return { kind: "reply", line: '{"success":true}' } as const;
      },
      exists: async () => false,
    };
    const done = await runBrowserCommand(
      ["done", "--all", "--folder", folder, "--json"],
      { ...context(env), daemonSeams: acknowledging },
    );
    expect(done.code).toBe(0);
    expect(JSON.parse(done.stdout ?? "")).toEqual({
      schema: "lazurio.browser-cli.v1",
      kind: "browser-done",
      session: "codex-019a",
      outcome: "stopped",
      sessions: [
        { session: "codex-019a", outcome: "stopped" },
        { session: "codex-019a-2", outcome: "stopped" },
      ],
      ambiguous: [],
    });
    expect(asked.sort()).toEqual([
      join(socketDir, "codex-019a-2.sock"),
      join(socketDir, "codex-019a.sock"),
    ]);
    // Naming another thread's window lets go of nothing.
    asked.length = 0;
    const foreign = await runBrowserCommand(
      ["done", "--all", "--session", "codex-019a-9", "--folder", folder],
      { ...context(env), daemonSeams: acknowledging },
    );
    expect(foreign.code).toBe(1);
    expect(foreign.stderr).toContain(
      "codex-019a-9 is not a window of this thread",
    );
    expect(asked).toEqual([]);
    // One that has not confirmed: a failure, named, the others let go.
    const partial = await runBrowserCommand(
      ["done", "--all", "--folder", folder],
      {
        ...context(env),
        daemonSeams: {
          ask: async (socketPath: string) =>
            socketPath.endsWith("codex-019a-2.sock")
              ? ({ kind: "no-answer" } as const)
              : ({ kind: "reply", line: '{"success":true}' } as const),
          exists: async () => false,
        },
      },
    );
    expect(partial.code).toBe(1);
    expect(partial.stderr).toBe(
      [
        "- codex-019a: let go",
        "- codex-019a-2: not confirmed; it may still hold the window",
        "Check what remains with lazurio browser tabs in a few seconds: a window ends 8 s after it was let go unless the user views it.",
      ].join("\n"),
    );
    // A window rebound to another tab since it was opened may be another
    // thread's now: tabs names it apart, done --all leaves it and fails.
    await openedWindow(env, "codex-019a-5", "codex-019a", TAB_D);
    await bindSessionFiles(socketDir, "codex-019a-5", TAB_F, { sock: true });
    const doubtful = await runBrowserCommand(
      ["tabs", "--folder", folder, "--json"],
      { ...context(env), listTabs, pageTitles },
    );
    expect(JSON.parse(doubtful.stdout ?? "")).toMatchObject({
      ambiguous: ["codex-019a-5"],
    });
    expect(
      JSON.parse(doubtful.stdout ?? "").windows.map(
        (window: { session: string }) => window.session,
      ),
    ).toEqual(["codex-019a", "codex-019a-2", "codex-019a-3"]);
    asked.length = 0;
    const leftAlone = await runBrowserCommand(
      ["done", "--all", "--folder", folder, "--json"],
      { ...context(env), daemonSeams: acknowledging },
    );
    expect(leftAlone.code).toBe(1);
    expect(JSON.parse(leftAlone.stdout ?? "")).toMatchObject({
      outcome: "unconfirmed",
      sessions: [
        { session: "codex-019a", outcome: "stopped" },
        { session: "codex-019a-2", outcome: "stopped" },
      ],
      ambiguous: ["codex-019a-5"],
    });
    expect(asked).not.toContain(join(socketDir, "codex-019a-5.sock"));
    const leftText = await runBrowserCommand(
      ["done", "--all", "--folder", folder],
      { ...context(env), daemonSeams: acknowledging },
    );
    expect(leftText.code).toBe(1);
    expect(leftText.stderr).toBe(
      [
        "- codex-019a: let go",
        "- codex-019a-2: let go",
        "done --all did not let go of these windows, and this thread may still hold them: their record or binding does not confirm that they are this thread's. Let go of one that is yours with lazurio browser done --session <session>, and leave the others alone:",
        "- codex-019a-5: its window changed since lazurio browser window opened it",
        "Check what remains with lazurio browser tabs in a few seconds: a window ends 8 s after it was let go unless the user views it.",
      ].join("\n"),
    );
    const ambiguousSession = await runBrowserCommand(
      ["tabs", "--session", "codex-019a-5", "--folder", folder],
      { ...context(env), listTabs, pageTitles },
    );
    expect(ambiguousSession.code).toBe(1);
    expect(ambiguousSession.stderr).toContain(
      "It cannot be told which thread codex-019a-5 is a window of",
    );
    await rm(join(socketDir, "codex-019a-5.sock"));
    await rm(join(socketDir, "codex-019a-5.target"));
    // A window whose binding a failed lazurio browser window left
    // unverified (#974, Pablo's review of #986) may name another agent's
    // tab: tabs names it apart by its session only. It is the thread's own
    // window by its record, so done --all lets go of it and settles the
    // binding (F38, addendum of 2026-11-15).
    const UNVERIFIED_TAB = "47".repeat(16);
    await openedWindow(env, "codex-019a-6", "codex-019a", UNVERIFIED_TAB, {
      sock: true,
    });
    const mark = join(env.XDG_RUNTIME_DIR, "lazurio-browser", "unverified");
    await mkdir(mark, { recursive: true });
    await writeFile(
      join(mark, "codex-019a-6.json"),
      JSON.stringify({
        schema: "lazurio.browser-unverified-binding.v1",
        session: "codex-019a-6",
        targetId: UNVERIFIED_TAB,
        before: null,
      }),
    );
    const unverifiedTabs = await runBrowserCommand(
      ["tabs", "--folder", folder, "--json"],
      { ...context(env), listTabs, pageTitles },
    );
    expect(JSON.parse(unverifiedTabs.stdout ?? "")).toMatchObject({
      ambiguous: ["codex-019a-6"],
    });
    expect(
      JSON.parse(unverifiedTabs.stdout ?? "").windows.map(
        (window: { session: string }) => window.session,
      ),
    ).not.toContain("codex-019a-6");
    const unverifiedText = await runBrowserCommand(
      ["tabs", "--folder", folder],
      { ...context(env), listTabs, pageTitles },
    );
    expect(unverifiedText.stdout).toContain(
      "- codex-019a-6: its binding is not verified since a lazurio browser window did not finish, so it may name another agent's tab; lazurio browser done --session <session> lets go of it and settles it",
    );
    expect(unverifiedText.stdout).not.toContain(UNVERIFIED_TAB);
    asked.length = 0;
    const unverifiedDone = await runBrowserCommand(
      ["done", "--all", "--folder", folder, "--json"],
      { ...context(env), daemonSeams: acknowledging },
    );
    expect(JSON.parse(unverifiedDone.stdout ?? "")).toMatchObject({
      ambiguous: [],
    });
    expect(
      JSON.parse(unverifiedDone.stdout ?? "").sessions.map(
        (entry: { session: string }) => entry.session,
      ),
    ).toContain("codex-019a-6");
    expect(asked).toContain(join(socketDir, "codex-019a-6.sock"));
    // Its daemon has ended, so the mark is settled and the binding, which
    // names the recorded tab, stays.
    expect(await present(join(mark, "codex-019a-6.json"))).toBe(false);
    await rm(join(socketDir, "codex-019a-6.sock"), { force: true });
    await rm(join(socketDir, "codex-019a-6.target"));
    // A thread with nothing running: nothing to let go, and done.
    const nothing = await runBrowserCommand(
      ["done", "--all", "--folder", folder, "--json"],
      context({ ...env, CODEX_THREAD_ID: "nothing" }),
    );
    expect(nothing.code).toBe(0);
    expect(JSON.parse(nothing.stdout ?? "")).toMatchObject({
      session: "codex-nothing",
      outcome: "none",
      sessions: [],
      ambiguous: [],
    });
    // --all belongs to done and tabs only, --confirm to take only; tabs
    // takes no address, take one tab and no address.
    for (const args of [
      ["window", "--all"],
      ["link", "--all"],
      ["tabs", "--url", "https://example.com/"],
      ["open", "https://example.com/", "--all"],
      ["window", "--confirm"],
      ["done", "--confirm"],
      ["tabs", "--confirm"],
      ["take"],
      ["take", "2A".repeat(16), "--all"],
      ["take", "2A".repeat(16), "--url", "https://example.com/"],
      ["take", "2A".repeat(16), "2B".repeat(16)],
      ["take", "not-a-tab"],
    ])
      expect(
        (await runBrowserCommand([...args, "--folder", folder], context(env)))
          .code,
      ).toBe(2);

    // A sixth window while the thread holds five: it opens and exits 0, is
    // recorded as the thread's, and stderr names the five with their
    // addresses and how to let go of them; another thread's are not named.
    for (const n of [3, 4, 5])
      await openedWindow(
        env,
        `codex-019a-${n}`,
        "codex-019a",
        `4${n}`.repeat(16),
        { pid: running },
      );
    await bindSessionFiles(socketDir, "codex-019a-2", TAB_B, { pid: running });
    const held = [
      TAB_A,
      TAB_B,
      "43".repeat(16),
      "44".repeat(16),
      "45".repeat(16),
      TAB_D,
      TAB_E,
      TAB_F,
    ];
    const pages = async () =>
      new Map(held.map((id) => [id, `https://example.com/${id.slice(0, 2)}`]));
    const note = [
      "This thread's other windows in the Environment browser:",
      "- codex-019a: https://example.com/2A",
      "- codex-019a-2: https://example.com/2B",
      "- codex-019a-3: https://example.com/43",
      "- codex-019a-4: https://example.com/44",
      "- codex-019a-5: https://example.com/45",
      "Let go of those you no longer need right away: lazurio browser done --session <session> lets go of one, lazurio browser done --all of every window of the thread, this one too. lazurio browser tabs lists them.",
    ].join("\n");
    const sixth = windowSeams({ socketDir, targets: held, env });
    const opened = await runBrowserCommand(
      [
        "window",
        "--session",
        "codex-019a-6",
        "--url",
        "https://example.com/",
        "--folder",
        folder,
      ],
      context(env, { ...sixth.seams, pages }),
    );
    expect(opened.code).toBe(0);
    expect(opened.stdout?.split("\n")[0]).toBe("Your window is open.");
    expect(opened.stderr).toBe(note);
    expect(sixth.calls[0]).toEqual([
      "Target.createTarget",
      expect.objectContaining({ url: "about:blank", newWindow: true }),
    ]);
    expect(sixth.calls.at(-1)).toEqual([
      "Page.navigate",
      NEWTARGET,
      "https://example.com/",
    ]);
    await bindSessionFiles(socketDir, "codex-019a-6", NEWTARGET);
    expect(await threadOfSession("codex-019a-6", env)).toEqual({
      kind: "thread",
      thread: "codex-019a",
    });
    // With --json the answer on stdout is the same as ever, and the note
    // stays on stderr.
    const seventh = windowSeams({ socketDir, targets: held, env });
    const json = await runBrowserCommand(
      ["window", "--session", "codex-019a-7b", "--folder", folder, "--json"],
      context(env, { ...seventh.seams, pages }),
    );
    expect(json.code).toBe(0);
    expect(JSON.parse(json.stdout ?? "")).toMatchObject({
      kind: "browser-window",
      session: "codex-019a-7b",
      created: true,
    });
    expect(json.stderr).toBe(note);
    // The window a session has already, and a thread that holds no other
    // window: no note.
    const reused = await runBrowserCommand(
      ["window", "--session", "codex-019a-2", "--folder", folder],
      context(env, {
        ...windowSeams({ socketDir, targets: held, env }).seams,
        pages,
      }),
    );
    expect(reused.code).toBe(0);
    expect(reused.stderr).toBeUndefined();
    const alone = await runBrowserCommand(
      ["window", "--session", "claude-alone", "--folder", folder],
      context(
        { ...env, CODEX_THREAD_ID: "alone" },
        { ...windowSeams({ socketDir, targets: held, env }).seams, pages },
      ),
    );
    expect(alone.code).toBe(0);
    expect(alone.stderr).toBeUndefined();
    // Nor when the thread's windows cannot be read: the window is open all
    // the same.
    const unread = windowSeams({ socketDir, targets: held, env });
    const unknown = await runBrowserCommand(
      ["window", "--session", "codex-019a-8", "--folder", folder],
      context(env, {
        ...unread.seams,
        pages: async () => {
          throw new Error("the browser did not answer");
        },
      }),
    );
    expect(unknown.code).toBe(0);
    expect(unknown.stderr).toBeUndefined();
    // A window that cannot be recorded says that tabs and done --all do not
    // see it.
    const { XDG_RUNTIME_DIR: _runtime, ...unrecordable } = env;
    const norecord = windowSeams({
      socketDir,
      targets: held,
      env: unrecordable,
    });
    const unrecorded = await runBrowserCommand(
      ["window", "--session", "codex-019a-10", "--folder", folder],
      context(unrecordable, {
        ...norecord.seams,
        pages: async () => {
          throw new Error("the browser did not answer");
        },
      }),
    );
    expect(unrecorded.code).toBe(0);
    expect(unrecorded.stderr).toBe(
      "This window is not recorded as this thread's, so lazurio browser tabs and done --all do not see it. Let go of it with lazurio browser done --session codex-019a-10.",
    );
  },
);

test.skipIf(process.platform === "win32")(
  "independent sessions named team-2 and team-3: tabs and done --all of one never touch the other, with or without the harness's identity",
  async () => {
    const { home, folder } = await folderWith(bindings.organizationBrowser);
    const socketDir = join(home, "sockets");
    await mkdir(socketDir);
    const running = String(process.pid);
    // No harness names a thread: each window opened by --session is its own
    // thread (window records it so).
    const bare = {
      HOME: home,
      AGENT_BROWSER_SOCKET_DIR: socketDir,
      XDG_RUNTIME_DIR: join(home, "run"),
    };
    for (const [session, tab] of [
      ["team", TAB_A],
      ["team-2", TAB_B],
      ["team-3", TAB_C],
    ] as const)
      await openedWindow(bare, session, session, tab, {
        pid: running,
        sock: true,
      });
    const listTabs = async () => ({
      kind: "tabs" as const,
      tabs: [
        tabFacts(TAB_A, { agents: ["team"] }),
        tabFacts(TAB_B, { agents: ["team-2"] }),
        tabFacts(TAB_C, { agents: ["team-3"] }),
      ],
    });
    const pageTitles = async () => new Map<string, string>();
    const asked: string[] = [];
    const daemonSeams = {
      ask: async (socketPath: string) => {
        asked.push(socketPath);
        return { kind: "reply", line: '{"success":true}' } as const;
      },
      exists: async () => false,
    };
    for (const session of ["team", "team-2", "team-3"]) {
      const listed = await runBrowserCommand(
        ["tabs", "--session", session, "--folder", folder, "--json"],
        { ...context(bare), listTabs, pageTitles },
      );
      expect(listed.code).toBe(0);
      expect(JSON.parse(listed.stdout ?? "")).toMatchObject({
        session,
        ambiguous: [],
      });
      expect(
        JSON.parse(listed.stdout ?? "").windows.map(
          (window: { session: string }) => window.session,
        ),
      ).toEqual([session]);
    }
    const done = await runBrowserCommand(
      ["done", "--all", "--session", "team-2", "--folder", folder, "--json"],
      { ...context(bare), daemonSeams },
    );
    expect(done.code).toBe(0);
    expect(JSON.parse(done.stdout ?? "")).toMatchObject({
      session: "team-2",
      outcome: "stopped",
      sessions: [{ session: "team-2", outcome: "stopped" }],
    });
    expect(asked).toEqual([join(socketDir, "team-2.sock")]);
    // The same names opened by three Codex threads: each thread's tabs and
    // done --all take its own window only.
    asked.length = 0;
    for (const [session, thread, tab] of [
      ["team", "codex-x", TAB_A],
      ["team-2", "codex-y", TAB_B],
      ["team-3", "codex-z", TAB_C],
    ] as const)
      await openedWindow(bare, session, thread, tab, {
        pid: running,
        sock: true,
      });
    const codex = (id: string) => ({ ...bare, CODEX_THREAD_ID: id });
    const fromY = await runBrowserCommand(
      ["done", "--all", "--session", "team-2", "--folder", folder, "--json"],
      { ...context(codex("y")), daemonSeams },
    );
    expect(fromY.code).toBe(0);
    expect(JSON.parse(fromY.stdout ?? "")).toMatchObject({
      session: "codex-y",
      sessions: [{ session: "team-2", outcome: "stopped" }],
    });
    expect(asked).toEqual([join(socketDir, "team-2.sock")]);
    const listedY = await runBrowserCommand(
      ["tabs", "--folder", folder, "--json"],
      { ...context(codex("y")), listTabs, pageTitles },
    );
    expect(
      JSON.parse(listedY.stdout ?? "").windows.map(
        (window: { session: string }) => window.session,
      ),
    ).toEqual(["team-2"]);
    // Thread x naming team-2 is refused: it lets go of nothing.
    asked.length = 0;
    const fromX = await runBrowserCommand(
      ["done", "--all", "--session", "team-2", "--folder", folder],
      { ...context(codex("x")), daemonSeams },
    );
    expect(fromX.code).toBe(1);
    expect(fromX.stderr).toContain("team-2 is not a window of this thread");
    expect(asked).toEqual([]);
  },
);

test.skipIf(process.platform === "win32")(
  "done and done --all report a window whose daemon's process runs while nothing answers on its socket as not let go",
  async () => {
    const { home, folder } = await folderWith(bindings.organizationBrowser);
    const socketDir = join(home, "sockets");
    await mkdir(socketDir);
    const env = {
      HOME: home,
      CODEX_THREAD_ID: "019b",
      AGENT_BROWSER_SOCKET_DIR: socketDir,
      XDG_RUNTIME_DIR: join(home, "run"),
    };
    // A live .pid without a socket, and with a socket nobody listens on
    // (refused): the hub still counts the binding and the process as a hold.
    await bindSessionFiles(socketDir, "codex-019b", TAB_A, {
      pid: String(process.pid),
    });
    for (const refused of [false, true]) {
      if (refused) await writeFile(join(socketDir, "codex-019b.sock"), "");
      const json = await runBrowserCommand(
        ["done", "--folder", folder, "--json"],
        context(env),
      );
      expect(json.code).toBe(1);
      expect(JSON.parse(json.stdout ?? "")).toEqual({
        schema: "lazurio.browser-cli.v1",
        kind: "browser-done",
        session: "codex-019b",
        outcome: "unconfirmed",
      });
      const text = await runBrowserCommand(["done", "--folder", folder], {
        ...context(env),
      });
      expect(text.code).toBe(1);
      expect(text.stderr).toBe(
        "Your session's agent-browser process still runs, but nothing answers on its socket, so it may still hold your window. Run lazurio browser done again in a moment; if it stays, run lazurio doctor. Never signal the process.",
      );
      const all = await runBrowserCommand(
        ["done", "--all", "--folder", folder, "--json"],
        context(env),
      );
      expect(all.code).toBe(1);
      expect(JSON.parse(all.stdout ?? "")).toMatchObject({
        outcome: "unconfirmed",
        sessions: [{ session: "codex-019b", outcome: "unconfirmed" }],
      });
      const allText = await runBrowserCommand(
        ["done", "--all", "--folder", folder],
        context(env),
      );
      expect(allText.code).toBe(1);
      expect(allText.stderr?.split("\n")[0]).toBe(
        "- codex-019b: its process still runs, but nothing answers on its socket: it may still hold the window",
      );
    }
    // Once its process has ended, nothing holds the window: none, and done.
    const ended = await runBrowserCommand(
      ["done", "--all", "--folder", folder, "--json"],
      { ...context(env), alive: () => false },
    );
    expect(ended.code).toBe(0);
    expect(JSON.parse(ended.stdout ?? "")).toMatchObject({
      outcome: "none",
      sessions: [{ session: "codex-019b", outcome: "none" }],
    });
    const single = await runBrowserCommand(
      ["done", "--folder", folder, "--json"],
      { ...context(env), alive: () => false },
    );
    expect(single.code).toBe(0);
    expect(JSON.parse(single.stdout ?? "").outcome).toBe("none");
  },
);

// A record that cannot be read names no thread, and a session's name proves
// none (Pablo's review of #971 on 54e2fefd): its window may be any thread's,
// the caller's too. Dropping it let tabs say no window remains and done
// --all succeed while it may still be held; every thread's answer now names
// it apart, by its session only, and says it is not complete.
test.skipIf(process.platform === "win32")(
  "a neighbour window whose record cannot be read is never left out: every thread's tabs names it by its session only and is not complete, and done --all leaves it and fails",
  async () => {
    const { home, folder } = await folderWith(bindings.organizationBrowser);
    const socketDir = join(home, "sockets");
    await mkdir(socketDir);
    const running = String(process.pid);
    const env = {
      HOME: home,
      CODEX_THREAD_ID: "019c",
      AGENT_BROWSER_SOCKET_DIR: socketDir,
      XDG_RUNTIME_DIR: join(home, "run"),
    };
    const lonely = { ...env, CODEX_THREAD_ID: "lonely" };
    await bindSessionFiles(socketDir, "codex-019c", TAB_A, {
      pid: running,
      sock: true,
    });
    await openedWindow(env, "codex-019c-2", "codex-019c", TAB_B, {
      sock: true,
    });
    // Another thread's window with a record that reads: never named.
    await openedWindow(env, "team", "codex-other", TAB_D, {
      pid: running,
      sock: true,
    });
    const records = join(env.XDG_RUNTIME_DIR, "lazurio-browser", "windows");
    const neighbour = join(records, "preview.json");
    const listed = {
      kind: "tabs" as const,
      tabs: [
        tabFacts(TAB_A, { agents: ["codex-019c"] }),
        tabFacts(TAB_B, { agents: ["codex-019c-2"] }),
        tabFacts(TAB_D, { agents: ["team"], title: "Another thread's page" }),
        tabFacts(TAB_E, {
          agents: ["preview"],
          url: "https://example.com/neighbour",
          title: "The neighbour's page",
        }),
      ],
    };
    const listTabs = async () => listed;
    const pageTitles = async () => new Map<string, string>();
    const acknowledging = (asked: string[]) => ({
      ask: async (socketPath: string) => {
        asked.push(socketPath);
        return { kind: "reply", line: '{"success":true}' } as const;
      },
      exists: async () => false,
    });
    const neverShown = (output: string | undefined) => {
      for (const fact of [
        TAB_E,
        "example.com/neighbour",
        "The neighbour's page",
        TAB_D,
        "Another thread's page",
      ])
        expect(output ?? "").not.toContain(fact);
    };
    const broken: readonly (readonly [string, () => Promise<void>])[] = [
      ["a JSON that does not parse", () => writeFile(neighbour, "{")],
      [
        "a record without its thread",
        () =>
          writeFile(
            neighbour,
            JSON.stringify({
              schema: "lazurio.browser-window.v1",
              session: "preview",
              targetId: TAB_E,
            }),
          ),
      ],
      [
        "a record naming a thread but without its tab",
        () =>
          writeFile(
            neighbour,
            JSON.stringify({
              schema: "lazurio.browser-window.v1",
              session: "preview",
              thread: "codex-other",
            }),
          ),
      ],
      ["a directory in its place", () => mkdir(neighbour)],
      // Root reads a file of any mode; elsewhere one of mode 000 cannot be
      // read.
      ...(process.getuid?.() === 0
        ? []
        : [
            [
              "a file that cannot be read",
              async () => {
                await writeFile(neighbour, "{}");
                await chmod(neighbour, 0o000);
              },
            ] as const,
          ]),
    ];
    for (const [form, write] of broken) {
      await rm(neighbour, { recursive: true, force: true });
      await bindSessionFiles(socketDir, "preview", TAB_E, {
        pid: running,
        sock: true,
      });
      await write();

      // The calling thread: its confirmed windows, and the neighbour apart.
      const tabs = await runBrowserCommand(
        ["tabs", "--folder", folder, "--json"],
        { ...context(env), listTabs, pageTitles },
      );
      expect([form, tabs.code]).toEqual([form, 0]);
      const answer = JSON.parse(tabs.stdout ?? "");
      expect([
        form,
        answer.windows.map((window: { session: string }) => window.session),
        answer.ambiguous,
      ]).toEqual([form, ["codex-019c", "codex-019c-2"], ["preview"]]);
      neverShown(tabs.stdout);
      // Another thread sees it too: a record that cannot be read names no
      // thread, so its window may be any thread's.
      const other = await runBrowserCommand(
        ["tabs", "--folder", folder, "--json"],
        {
          ...context({ ...env, CODEX_THREAD_ID: "other" }),
          listTabs,
          pageTitles,
        },
      );
      expect(JSON.parse(other.stdout ?? "")).toMatchObject({
        session: "codex-other",
        ambiguous: ["preview"],
      });
      const text = await runBrowserCommand(["tabs", "--folder", folder], {
        ...context(env),
        listTabs,
        pageTitles,
      });
      expect(text.code).toBe(0);
      // The first line says the list is not complete, why, and what to do;
      // the listing still exits 0 (F38, addendum of 2026-11-15).
      expect(text.stdout?.split("\n")[0]).toBe(
        'This list is not complete: lazurio browser cannot confirm whether the windows under "Not confirmed" are this thread\'s. The listing itself worked, so running it again tells nothing more. Let go of a window that is yours with lazurio browser done --session <session>, and leave the others alone.',
      );
      expect(text.stdout?.split("\n").slice(-3)).toEqual([
        "Not confirmed as this thread's (their record or binding does not confirm it):",
        "- preview: its record cannot be read, so it may be any thread's window",
        "Before you tell the user your windows are closed, run lazurio browser tabs again: a window you let go that the user views stays for them.",
      ]);
      neverShown(text.stdout);
      // A thread with no confirmed window never hears that none remains.
      const none = await runBrowserCommand(["tabs", "--folder", folder], {
        ...context(lonely),
        listTabs,
        pageTitles,
      });
      expect(none.stdout?.split("\n")[1]).toBe(
        "This thread has no confirmed window in the Environment browser.",
      );
      expect(none.stdout).not.toContain(
        "This thread has no window in the Environment browser.",
      );
      expect(none.stdout).toContain("This list is not complete");

      // done --all lets go of the thread's confirmed windows, never of the
      // neighbour, and fails naming it.
      const asked: string[] = [];
      const done = await runBrowserCommand(
        ["done", "--all", "--folder", folder, "--json"],
        { ...context(env), daemonSeams: acknowledging(asked) },
      );
      expect([form, done.code]).toEqual([form, 1]);
      expect(JSON.parse(done.stdout ?? "")).toEqual({
        schema: "lazurio.browser-cli.v1",
        kind: "browser-done",
        session: "codex-019c",
        outcome: "unconfirmed",
        sessions: [
          { session: "codex-019c", outcome: "stopped" },
          { session: "codex-019c-2", outcome: "stopped" },
        ],
        ambiguous: ["preview"],
      });
      expect(asked.sort()).toEqual([
        join(socketDir, "codex-019c-2.sock"),
        join(socketDir, "codex-019c.sock"),
      ]);
      const doneText = await runBrowserCommand(
        ["done", "--all", "--folder", folder],
        { ...context(env), daemonSeams: acknowledging([]) },
      );
      expect(doneText.code).toBe(1);
      expect(doneText.stdout).toBeUndefined();
      expect(doneText.stderr).toBe(
        [
          "- codex-019c: let go",
          "- codex-019c-2: let go",
          "done --all did not let go of these windows, and this thread may still hold them: their record or binding does not confirm that they are this thread's. Let go of one that is yours with lazurio browser done --session <session>, and leave the others alone:",
          "- preview: its record cannot be read, so it may be any thread's window",
          "Check what remains with lazurio browser tabs in a few seconds: a window ends 8 s after it was let go unless the user views it.",
        ].join("\n"),
      );
      // A thread with nothing of its own to let go does not succeed either.
      const lonelyAsked: string[] = [];
      const lonelyDone = await runBrowserCommand(
        ["done", "--all", "--folder", folder, "--json"],
        { ...context(lonely), daemonSeams: acknowledging(lonelyAsked) },
      );
      expect(lonelyDone.code).toBe(1);
      expect(JSON.parse(lonelyDone.stdout ?? "")).toMatchObject({
        session: "codex-lonely",
        outcome: "unconfirmed",
        sessions: [],
        ambiguous: ["preview"],
      });
      expect(lonelyAsked).toEqual([]);
      // Named on purpose, its thread cannot be told: nothing listed.
      const named = await runBrowserCommand(
        ["tabs", "--session", "preview", "--folder", folder],
        { ...context(env), listTabs, pageTitles },
      );
      expect(named.code).toBe(1);
      expect(named.stdout).toBeUndefined();
      expect(named.stderr).toContain(
        "It cannot be told which thread preview is a window of",
      );
      await chmod(neighbour, 0o700).catch(() => undefined);
    }

    // Once its daemon has ended, nothing holds it: done --all succeeds, and
    // tabs names it only while its binding names a tab the hub still lists.
    await rm(join(socketDir, "preview.pid"));
    await rm(join(socketDir, "preview.sock"));
    const released = await runBrowserCommand(
      ["done", "--all", "--folder", folder, "--json"],
      { ...context(env), daemonSeams: acknowledging([]) },
    );
    expect(released.code).toBe(0);
    expect(JSON.parse(released.stdout ?? "")).toMatchObject({
      outcome: "stopped",
      ambiguous: [],
    });
    const viewed = await runBrowserCommand(
      ["tabs", "--folder", folder, "--json"],
      { ...context(env), listTabs, pageTitles },
    );
    expect(JSON.parse(viewed.stdout ?? "").ambiguous).toEqual(["preview"]);
    const gone = await runBrowserCommand(
      ["tabs", "--folder", folder, "--json"],
      {
        ...context(env),
        listTabs: async () => ({
          ...listed,
          tabs: listed.tabs.filter((tab) => tab.id !== TAB_E),
        }),
        pageTitles,
      },
    );
    expect(JSON.parse(gone.stdout ?? "").ambiguous).toEqual([]);
  },
);

// An agent lists its own windows, reads helper pages in one window, lets go
// of all of them and checks before it tells the user; in ChatGPT Desktop the
// user has one window's link in the right panel, and a further window is a
// new link the agent explains.
test("the Folder tells an agent to list its own windows, keep them few and check before saying they are closed", () => {
  for (const locale of ["cs", "en"] as const) {
    const text = renderManual({
      preset: "hosted-organization-personal",
      machine: bindings.organizationBrowser,
      profile: presetProfile("hosted-organization-personal", "linux", {
        locale,
      }),
    })["manual/this-machine.md"];
    const point = (start: string) =>
      text.split("\n").find((line) => line.startsWith(start)) ?? "";
    const cs = locale === "cs";
    const windows = point(cs ? "- **Tvoje okna.**" : "- **Your windows.**");
    expect(windows).toContain("`lazurio browser tabs`");
    expect(windows).toContain("`agent-browser … tab list`");
    // No limit: the agent keeps track of its windows and lets go of them.
    expect(windows).not.toMatch(cs ? /nejvýš \d/ : /at most \d/);
    expect(windows).toContain("`lazurio browser window`");
    expect(windows).toContain(cs ? "hned pusť" : "as soon as you no longer");
    const desktop = point(
      cs
        ? "- **Okna v ChatGPT Desktopu.**"
        : "- **Windows in ChatGPT Desktop.**",
    );
    expect(desktop).toContain("`https://browser.…/t/<id>`");
    expect(desktop).toContain("--session <");
    const done = point(cs ? "- **Konec.**" : "- **When done.**");
    expect(done).toContain("`lazurio browser done --all`");
    expect(done).toContain("`lazurio browser tabs`");
    expect(point(cs ? "- **Nová záložka.**" : "- **A new tab.**")).toContain(
      cs ? "v jednom takovém okně" : "in one such window",
    );
    // F38, addendum of 2026-11-15: an incomplete list is no failure to
    // repeat; a window opens blank; the shared browser's overview, and a
    // tab taken only on purpose, with --confirm, knowing from whom.
    expect(windows).toContain("`complete: false`");
    expect(windows).toContain(cs ? "neopakuj ho" : "do not run it again");
    const own = point(cs ? "- **Tvoje okno.**" : "- **Your window.**");
    expect(own).toContain(cs ? "otevře prázdné" : "opens blank");
    expect(own).toContain("`lazurio browser done --session <");
    const shared = point(
      cs ? "- **Sdílený prohlížeč.**" : "- **A shared browser.**",
    );
    expect(shared).toContain("`lazurio browser tabs --all`");
    expect(shared).toContain(cs ? "vědomě nepřevezmeš" : "take it on purpose");
    const take = point(cs ? "- **Převzetí záložky.**" : "- **Taking a tab.**");
    expect(take).toContain("`lazurio browser take <id>`");
    expect(take).toContain("`lazurio browser take <id> --confirm`");
    expect(take).toContain(cs ? "od koho" : "from whom");
    expect(take).toContain(cs ? "kódem 3" : "exits 3");
    expect(done).toContain(cs ? "vyřídí" : "settles it");
  }
  // Only where the Environment has its browser.
  const without = renderManual({
    preset: "hosted-organization-personal",
    machine: bindings.organization,
    profile: presetProfile("hosted-organization-personal", "linux"),
  })["manual/this-machine.md"];
  expect(without).not.toContain("lazurio browser take");
});

// ---- The shared browser: every tab, taking one on purpose (F38, addendum of
// 2026-11-15) ------------------------------------------------------------------
//
// The Environment browser is shared: agents may work together and see every
// tab of the Environment (`tabs --all`), and one may take another's tab, but
// only on purpose: `take` without --confirm describes from whom and what
// happens and changes nothing; with it the holders are let go as `done` lets
// go of one, the session is bound and the window recorded. Nothing is closed,
// agent-browser's bindings of the earlier holders stay (removing one would
// send its next command to the first live tab of the browser, measured on
// 0.37 and 0.43), and the earlier holder learns it from its own `tabs` and
// `window`.

const TAKEN_TAB = "4A".repeat(16);
const OWN_TAB = "4B".repeat(16);

/** The taker's world: the hub lists `TAKEN_TAB`, which a T3 Code thread's
 * session `t3-other` is bound to while its daemon runs and whose strip holds
 * it, viewed by one person. Its daemon, asked to shut down, ends: its `.pid`
 * and socket go. */
async function takeWorld() {
  const { home, folder } = await folderWith(bindings.organizationBrowser);
  const socketDir = join(home, "sockets");
  await mkdir(socketDir);
  const runtime = join(home, "run");
  await mkdir(runtime, { mode: 0o700 });
  const env = {
    HOME: home,
    CODEX_THREAD_ID: "019a",
    AGENT_BROWSER_SOCKET_DIR: socketDir,
    XDG_RUNTIME_DIR: runtime,
  };
  await bindSessionFiles(socketDir, "t3-other", TAKEN_TAB, {
    pid: String(process.pid),
    sock: true,
  });
  const tabs = [
    {
      ...tabFacts(TAKEN_TAB, {
        agents: ["t3-other"],
        viewers: 1,
        title: "Form",
        url: "https://example.org/form",
      }),
      holders: [{ strip: "t3-other", label: "Thread title" }],
    },
    tabFacts(OWN_TAB, { url: "https://example.com/own" }),
  ];
  const listTabs = async () => ({ kind: "tabs" as const, tabs });
  const pageTitles = async () => new Map<string, string>();
  const asked: string[] = [];
  const daemon = {
    ask: async (socketPath: string) => {
      asked.push(basename(socketPath, ".sock"));
      const session = basename(socketPath, ".sock");
      await rm(join(socketDir, `${session}.pid`), { force: true });
      await rm(join(socketDir, `${session}.sock`), { force: true });
      return { kind: "reply", line: '{"success":true}' } as const;
    },
    exists: async (path: string) => present(path),
  };
  const browser = windowSeams({
    socketDir,
    targets: [TAKEN_TAB, OWN_TAB],
    env,
  });
  const seams: WindowSeams = { ...browser.seams, daemon };
  const run = (args: readonly string[], extra: Record<string, string> = {}) =>
    runBrowserCommand([...args, "--folder", folder], {
      ...context({ ...env, ...extra }, seams),
      listTabs,
      pageTitles,
      daemonSeams: daemon,
    });
  return {
    env,
    folder,
    socketDir,
    runtime,
    run,
    asked,
    daemon,
    calls: browser.calls,
  };
}

test.skipIf(process.platform === "win32")(
  "take: without --confirm it only describes from whom and what happens; with it the holders are let go, the session bound and recorded, nothing closed, and the earlier holder learns it",
  async () => {
    const world = await takeWorld();
    const before = await readFile(
      join(world.socketDir, "t3-other.target"),
      "utf8",
    );
    // Described only: exit 3, nothing asked, run or written.
    const described = await world.run(["take", TAKEN_TAB, "--json"]);
    expect(described.code).toBe(3);
    expect(JSON.parse(described.stdout ?? "")).toEqual({
      schema: "lazurio.browser-cli.v1",
      kind: "browser-take",
      session: "codex-019a",
      targetId: TAKEN_TAB,
      url: "https://example.org/form",
      title: "Form",
      link: `https://browser.workspace.example.lazurio.io/t/${TAKEN_TAB}`,
      command: "agent-browser --cdp 9222 --session codex-019a",
      taken: false,
      from: [
        {
          session: "t3-other",
          thread: "t3-other",
          running: true,
          unverified: false,
          taken: false,
        },
      ],
      strips: [{ strip: "t3-other", label: "Thread title" }],
      viewers: 1,
    });
    const text = await world.run(["take", TAKEN_TAB.toLowerCase()]);
    expect(text.code).toBe(3);
    expect(text.stdout?.split("\n")).toEqual([
      `Taking the tab ${TAKEN_TAB}: https://example.org/form „Form“`,
      `The user's link: https://browser.workspace.example.lazurio.io/t/${TAKEN_TAB}`,
      "You take it from:",
      "- session t3-other (thread t3-other): its agent-browser runs: its agent may be working in it now",
      "Kept by, unchanged:",
      "- panel t3-other “Thread title”",
      "the user views it (1)",
      "With --confirm: the sessions above are let go as lazurio browser done lets go of one, your session codex-019a is bound to the tab, and the tab is recorded as this thread's window. Their bindings stay, and their thread sees in lazurio browser tabs that this thread took the tab; if their agent goes on in its session, it works in the same tab as you, and agent-browser does not tell it. Nothing is closed, and whoever has the tab open keeps it.",
      "Take it only as a deliberate decision, when the user asked for it or you work with that agent on purpose:",
      `  lazurio browser take ${TAKEN_TAB} --confirm`,
    ]);
    expect(world.asked).toEqual([]);
    expect(world.calls).toEqual([]);
    expect(await present(join(world.runtime, "lazurio-browser", "taken"))).toBe(
      false,
    );

    // The overview names every tab with who holds it.
    const overview = await world.run(["tabs", "--all", "--json"]);
    expect(overview.code).toBe(0);
    expect(JSON.parse(overview.stdout ?? "")).toMatchObject({
      complete: true,
      all: [
        {
          targetId: TAKEN_TAB,
          yours: false,
          viewers: 1,
          sessions: [
            {
              session: "t3-other",
              thread: "t3-other",
              running: true,
              unverified: false,
              taken: false,
            },
          ],
          strips: [{ strip: "t3-other", label: "Thread title" }],
        },
        { targetId: OWN_TAB, yours: false, sessions: [], strips: [] },
      ],
    });
    const overviewText = (await world.run(["tabs", "--all"])).stdout ?? "";
    expect(overviewText).toContain(
      `- ${TAKEN_TAB}: https://example.org/form „Form“\n  The user's link: https://browser.workspace.example.lazurio.io/t/${TAKEN_TAB}\n  Held by: session t3-other (thread t3-other, its agent-browser runs); panel t3-other “Thread title”\n  the user views it (1)`,
    );
    expect(overviewText).toContain(
      "No agent-browser session or place holds it.",
    );
    expect(overviewText).toContain("lazurio browser take <id>");

    // Confirmed: the holder is let go, the session bound and recorded.
    const taken = await world.run(["take", TAKEN_TAB, "--confirm", "--json"]);
    expect(taken.code).toBe(0);
    expect(JSON.parse(taken.stdout ?? "")).toMatchObject({
      kind: "browser-take",
      session: "codex-019a",
      targetId: TAKEN_TAB,
      taken: true,
      from: [{ session: "t3-other", running: true }],
    });
    expect(world.asked).toEqual(["t3-other"]);
    expect(world.calls).toContainEqual([
      join(world.env.HOME, ".local", "bin", "agent-browser"),
      "--cdp",
      "9222",
      "--session",
      "codex-019a",
      "--no-pin-tab",
      "tab",
      TAKEN_TAB,
    ]);
    expect(JSON.stringify(world.calls)).not.toMatch(/close/i);
    // The earlier holder's binding stays as it was, and it gets a note.
    expect(
      await readFile(join(world.socketDir, "t3-other.target"), "utf8"),
    ).toBe(before);
    expect(
      JSON.parse(
        await readFile(
          join(world.runtime, "lazurio-browser", "taken", "t3-other.json"),
          "utf8",
        ),
      ),
    ).toMatchObject({
      schema: "lazurio.browser-taken-window.v1",
      session: "t3-other",
      targetId: TAKEN_TAB,
      thread: "codex-019a",
      by: "codex-019a",
    });
    // It is the taker's window now.
    expect(
      JSON.parse((await world.run(["tabs", "--json"])).stdout ?? "").windows,
    ).toMatchObject([{ session: "codex-019a", targetId: TAKEN_TAB }]);
    // Taking it again changes nothing.
    world.asked.length = 0;
    const again = await world.run(["take", TAKEN_TAB]);
    expect(again.code).toBe(0);
    expect(again.stdout?.split("\n")[0]).toBe(
      `The tab ${TAKEN_TAB} is your session's window already.`,
    );
    expect(world.asked).toEqual([]);

    // The earlier holder: its tabs names the window as taken, complete.
    const holder = { AGENT_BROWSER_SESSION: "t3-other" };
    const holderTabs = JSON.parse(
      (await world.run(["tabs", "--json"], holder)).stdout ?? "",
    );
    expect(holderTabs).toMatchObject({
      session: "t3-other",
      windows: [],
      ambiguous: [],
      complete: true,
      taken: [
        {
          session: "t3-other",
          targetId: TAKEN_TAB,
          thread: "codex-019a",
          by: "codex-019a",
        },
      ],
    });
    expect((await world.run(["tabs"], holder)).stdout).toContain(
      "- t3-other: https://example.org/form, taken by the thread codex-019a (session codex-019a) at ",
    );
    // Its window is a new one, never the taken tab, and says why.
    world.calls.length = 0;
    const window = await world.run(["window", "--json"], holder);
    expect(window.code).toBe(0);
    expect(JSON.parse(window.stdout ?? "")).toMatchObject({
      session: "t3-other",
      targetId: NEWTARGET,
      created: true,
    });
    expect(window.stderr).toContain(
      `Your earlier window in this session (${TAKEN_TAB}) was taken by the thread codex-019a (session codex-019a) at `,
    );
    expect(
      await present(
        join(world.runtime, "lazurio-browser", "taken", "t3-other.json"),
      ),
    ).toBe(false);
  },
);

test.skipIf(process.platform === "win32")(
  "take refuses, with nothing changed, a tab that is not there, a session that would leave its own window, and a holder that does not let go",
  async () => {
    const world = await takeWorld();
    const missing = await world.run(["take", "4C".repeat(16), "--confirm"]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain(
      `The Environment browser has no tab ${"4C".repeat(16)}.`,
    );
    expect((await world.run(["take", "4C"])).code).toBe(2);
    // The calling session has a window of its own: never left silently.
    await bindSessionFiles(world.socketDir, "codex-019a", OWN_TAB);
    const busy = await world.run(["take", TAKEN_TAB, "--confirm"]);
    expect(busy.code).toBe(1);
    expect(busy.stderr).toContain(
      `Take the tab into another session (lazurio browser take ${TAKEN_TAB} --session codex-019a-2)`,
    );
    expect(world.asked).toEqual([]);
    // In another session, a holder that refuses to shut down: nothing taken.
    const refusing: WindowSeams = {
      ...windowSeams({
        socketDir: world.socketDir,
        targets: [TAKEN_TAB, OWN_TAB],
        env: world.env,
      }).seams,
      daemon: {
        ask: async () => ({ kind: "reply", line: '{"success":false}' }),
      },
    };
    await expect(
      takeTab("codex-019a-2", TAKEN_TAB, refusing, { thread: "codex-019a" }),
    ).rejects.toEqual(new BrowserWindowFailure("holder-busy", "t3-other"));
    expect(await present(join(world.socketDir, "codex-019a-2.target"))).toBe(
      false,
    );
  },
);

test.skipIf(process.platform === "win32")(
  "take never calls a binding a window left unverified the session's window: without --confirm it refuses as window does, with it the binding is settled first or nothing is taken (C19, review of #993)",
  async () => {
    const world = await takeWorld();
    // An earlier window of the calling session did not finish binding it:
    // its binding names the other thread's tab, the mark keeps another one,
    // and its daemon still runs.
    await bindSessionFiles(world.socketDir, "codex-019a", TAKEN_TAB, {
      pid: String(process.pid),
      sock: true,
    });
    const mark = unverifiedMark(world.runtime, "codex-019a");
    await mkdir(dirname(mark), { recursive: true });
    await writeFile(
      mark,
      JSON.stringify({
        schema: "lazurio.browser-unverified-binding.v1",
        session: "codex-019a",
        targetId: "4D".repeat(16),
        before: null,
      }),
    );
    const described = await world.run(["take", TAKEN_TAB]);
    expect(described.code).toBe(1);
    expect(described.stdout ?? "").not.toContain("window already");
    expect(described.stderr).toContain(
      "The session codex-019a has no window for now",
    );
    expect(world.asked).toEqual([]);
    expect(await present(mark)).toBe(true);
    // Confirmed while its daemon does not end: refused, nothing taken.
    const lingering: WindowSeams = {
      ...windowSeams({
        socketDir: world.socketDir,
        targets: [TAKEN_TAB, OWN_TAB],
        env: world.env,
      }).seams,
      daemon: {
        ask: async () => ({ kind: "reply", line: '{"success":true}' }),
        exists: async (path: string) => present(path),
        exitWithinMs: 50,
      },
    };
    await expect(
      takeTab("codex-019a", TAKEN_TAB, lingering, { thread: "codex-019a" }),
    ).rejects.toEqual(
      new BrowserWindowFailure("binding-unverified", "codex-019a"),
    );
    expect(
      await present(
        join(world.runtime, "lazurio-browser", "taken", "t3-other.json"),
      ),
    ).toBe(false);
    expect(await present(mark)).toBe(true);
  },
);

test.skipIf(process.platform === "win32")(
  "take takes nothing when the note for an earlier holder cannot be written: the session is not bound, the window not recorded and the holder's binding stays (review of #993)",
  async () => {
    const world = await takeWorld();
    const before = await readFile(
      join(world.socketDir, "t3-other.target"),
      "utf8",
    );
    // The notes' directory is no directory.
    await mkdir(join(world.runtime, "lazurio-browser"), { recursive: true });
    await writeFile(join(world.runtime, "lazurio-browser", "taken"), "");
    const taken = await world.run(["take", TAKEN_TAB, "--confirm"]);
    expect(taken.code).toBe(1);
    expect(taken.stderr).toContain(
      "could not write the note that tells the session t3-other",
    );
    expect(taken.stderr).toContain("Nothing was taken");
    expect(
      world.calls.some(
        (call) =>
          Array.isArray(call) &&
          call.includes("codex-019a") &&
          call.includes("tab") &&
          call.includes(TAKEN_TAB),
      ),
    ).toBe(false);
    expect(await present(join(world.socketDir, "codex-019a.target"))).toBe(
      false,
    );
    expect(
      await readFile(join(world.socketDir, "t3-other.target"), "utf8"),
    ).toBe(before);
    expect(
      JSON.parse((await world.run(["tabs", "--json"])).stdout ?? "").windows,
    ).toEqual([]);
  },
);

test.skipIf(process.platform === "win32")(
  "take whose binding fails gives the holders their window back only once the taker is proven off the tab; otherwise their notes stay and the taker is marked unverified (review of #993)",
  async () => {
    const world = await takeWorld();
    const note = join(
      world.runtime,
      "lazurio-browser",
      "taken",
      "t3-other.json",
    );
    const before = await readFile(
      join(world.socketDir, "t3-other.target"),
      "utf8",
    );
    const endsOnlyHolders = {
      ask: async (socketPath: string) => {
        const session = basename(socketPath, ".sock");
        world.asked.push(session);
        if (session === "t3-other") {
          await rm(join(world.socketDir, `${session}.pid`), { force: true });
          await rm(join(world.socketDir, `${session}.sock`), { force: true });
        }
        return { kind: "reply", line: '{"success":true}' } as const;
      },
      exists: async (path: string) => present(path),
      exitWithinMs: 50,
    };
    const pinFails = (): WindowSeams => ({
      ...windowSeams({
        socketDir: world.socketDir,
        targets: [TAKEN_TAB, OWN_TAB],
        env: world.env,
        failing: ["--pin-tab"],
      }).seams,
      daemon: endsOnlyHolders,
      endWithinMs: 0,
    });
    // `tab` answers and the pin does not: the taker is on the tab, its
    // daemon has ended, so its binding goes and the holder's note with it.
    await expect(
      takeTab("codex-019a", TAKEN_TAB, pinFails(), { thread: "codex-019a" }),
    ).rejects.toEqual(new BrowserWindowFailure("bind-failed"));
    expect(await present(join(world.socketDir, "codex-019a.target"))).toBe(
      false,
    );
    expect(await present(note)).toBe(false);
    expect(
      await readFile(join(world.socketDir, "t3-other.target"), "utf8"),
    ).toBe(before);
    // The same with the taker's daemon still running: it cannot be proven
    // off the tab, so the note stays and the taker is marked unverified.
    await bindSessionFiles(world.socketDir, "t3-other", TAKEN_TAB, {
      pid: String(process.pid),
      sock: true,
    });
    await writeFile(
      join(world.socketDir, "codex-019a.pid"),
      String(process.pid),
    );
    await writeFile(join(world.socketDir, "codex-019a.sock"), "");
    await expect(
      takeTab("codex-019a", TAKEN_TAB, pinFails(), { thread: "codex-019a" }),
    ).rejects.toEqual(new BrowserWindowFailure("binding-unverified"));
    expect(JSON.parse(await readFile(note, "utf8"))).toMatchObject({
      session: "t3-other",
      targetId: TAKEN_TAB,
      by: "codex-019a",
    });
    expect(await present(unverifiedMark(world.runtime, "codex-019a"))).toBe(
      true,
    );
    expect(
      JSON.parse((await world.run(["tabs", "--json"])).stdout ?? "").windows,
    ).toEqual([]);
  },
);

test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "take whose binding fails keeps the taker unverified by the mark written before the binding, even when no mark can be written afterwards (review of #993)",
  async () => {
    const world = await takeWorld();
    const marks = join(world.runtime, "lazurio-browser", "unverified");
    await writeFile(
      join(world.socketDir, "codex-019a.pid"),
      String(process.pid),
    );
    await writeFile(join(world.socketDir, "codex-019a.sock"), "");
    const base = windowSeams({
      socketDir: world.socketDir,
      targets: [TAKEN_TAB, OWN_TAB],
      env: world.env,
      failing: ["--pin-tab"],
    }).seams;
    const seams: WindowSeams = {
      ...base,
      // The pin fails, and from then on no mark can be written.
      run: async (command, ...rest) => {
        if (command.includes("--pin-tab")) await chmod(marks, 0o500);
        return base.run(command, ...rest);
      },
      daemon: {
        ask: async (socketPath: string) => {
          const session = basename(socketPath, ".sock");
          if (session === "t3-other") {
            await rm(join(world.socketDir, `${session}.pid`), { force: true });
            await rm(join(world.socketDir, `${session}.sock`), { force: true });
          }
          return { kind: "reply", line: '{"success":true}' } as const;
        },
        exists: async (path: string) => present(path),
        exitWithinMs: 50,
      },
      endWithinMs: 0,
    };
    try {
      await expect(
        takeTab("codex-019a", TAKEN_TAB, seams, { thread: "codex-019a" }),
      ).rejects.toEqual(new BrowserWindowFailure("binding-unverified"));
    } finally {
      await chmod(marks, 0o700);
    }
    expect(await present(unverifiedMark(world.runtime, "codex-019a"))).toBe(
      true,
    );
    expect(
      await present(
        join(world.runtime, "lazurio-browser", "taken", "t3-other.json"),
      ),
    ).toBe(true);
    const tabs = JSON.parse((await world.run(["tabs", "--json"])).stdout ?? "");
    expect(tabs.windows).toEqual([]);
    expect(tabs.complete).toBe(false);
    // Its next window settles the mark once its daemon ends and opens a new
    // window, never the taken tab.
    const window = await world.run(["window", "--json"]);
    expect(window.code).toBe(0);
    expect(JSON.parse(window.stdout ?? "")).toMatchObject({
      session: "codex-019a",
      targetId: NEWTARGET,
      created: true,
    });
  },
);

test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "take whose binding is verified but whose mark can then be neither rewritten nor removed reports the take unfinished, never a success a later window undoes (review of #993)",
  async () => {
    const world = await takeWorld();
    const marks = join(world.runtime, "lazurio-browser", "unverified");
    const base = windowSeams({
      socketDir: world.socketDir,
      targets: [TAKEN_TAB, OWN_TAB],
      env: world.env,
    }).seams;
    const seams: WindowSeams = {
      ...base,
      // The pin succeeds, and from then on the marks cannot change.
      run: async (command, ...rest) => {
        const result = await base.run(command, ...rest);
        if (command.includes("--pin-tab")) await chmod(marks, 0o500);
        return result;
      },
      daemon: world.daemon,
    };
    try {
      await expect(
        takeTab("codex-019a", TAKEN_TAB, seams, { thread: "codex-019a" }),
      ).rejects.toEqual(new BrowserWindowFailure("binding-unverified"));
    } finally {
      await chmod(marks, 0o700);
    }
    // Unfinished: the window is not recorded as the thread's, and the
    // session stays unverified until done or window settles it.
    expect(await present(unverifiedMark(world.runtime, "codex-019a"))).toBe(
      true,
    );
    expect(
      JSON.parse((await world.run(["tabs", "--json"])).stdout ?? "").windows,
    ).toEqual([]);
  },
);

test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "done --all settles every unverified session of the thread, a mark alone or a recorded window bound elsewhere, and done and done --all fail while a binding stays unsettled (review of #993)",
  async () => {
    const { home, folder } = await folderWith(bindings.organizationBrowser);
    const socketDir = join(home, "sockets");
    await mkdir(socketDir);
    const env = {
      HOME: home,
      CODEX_THREAD_ID: "019a",
      AGENT_BROWSER_SOCKET_DIR: socketDir,
      XDG_RUNTIME_DIR: join(home, "run"),
    };
    const marks = join(env.XDG_RUNTIME_DIR, "lazurio-browser", "unverified");
    await mkdir(marks, { recursive: true });
    const mark = (session: string, targetId: string | null) =>
      writeFile(
        join(marks, `${session}.json`),
        JSON.stringify({
          schema: "lazurio.browser-unverified-binding.v1",
          session,
          targetId,
          before: null,
        }),
      );
    // A mark alone, written before a window's first command.
    await mark("codex-019a", null);
    // A window recorded for the thread whose binding names another tab now,
    // its daemon ended.
    await openedWindow(env, "codex-019a-3", "codex-019a", TAB_B);
    await bindSessionFiles(socketDir, "codex-019a-3", TAB_F);
    await mark("codex-019a-3", TAB_B);
    const settled = await runBrowserCommand(
      ["done", "--all", "--folder", folder, "--json"],
      context(env),
    );
    expect(settled.code).toBe(0);
    expect(await present(join(marks, "codex-019a.json"))).toBe(false);
    expect(await present(join(marks, "codex-019a-3.json"))).toBe(false);
    expect(await present(join(socketDir, "codex-019a-3.target"))).toBe(false);
    // The same window with its daemon running: never let go, named, and
    // done --all fails.
    await bindSessionFiles(socketDir, "codex-019a-3", TAB_F, {
      pid: String(process.pid),
      sock: true,
    });
    await mark("codex-019a-3", TAB_B);
    const held = await runBrowserCommand(
      ["done", "--all", "--folder", folder, "--json"],
      context(env),
    );
    expect(held.code).toBe(1);
    expect(JSON.parse(held.stdout ?? "")).toMatchObject({
      ambiguous: ["codex-019a-3"],
    });
    await rm(join(socketDir, "codex-019a-3.pid"));
    await rm(join(socketDir, "codex-019a-3.sock"));
    // A mark that cannot be removed: done --all and done fail and say so.
    await chmod(marks, 0o500);
    try {
      const all = await runBrowserCommand(
        ["done", "--all", "--folder", folder, "--json"],
        context(env),
      );
      expect(all.code).toBe(1);
      expect(JSON.parse(all.stdout ?? "")).toMatchObject({
        unsettled: ["codex-019a-3"],
      });
      // C13: the reason is the first line of stderr, with --json too.
      expect(all.stderr?.split("\n")[0]).toContain(
        "Its binding is still not verified",
      );
      const allText = await runBrowserCommand(
        ["done", "--all", "--folder", folder],
        context(env),
      );
      expect(allText.code).toBe(1);
      expect(allText.stderr).toContain("Its binding is still not verified");
      const one = await runBrowserCommand(
        ["done", "--session", "codex-019a-3", "--folder", folder, "--json"],
        context(env),
      );
      expect(one.code).toBe(1);
      expect(JSON.parse(one.stdout ?? "")).toMatchObject({
        unsettled: ["codex-019a-3"],
      });
      const oneText = await runBrowserCommand(
        ["done", "--session", "codex-019a-3", "--folder", folder],
        context(env),
      );
      expect(oneText.code).toBe(1);
      expect(oneText.stderr?.split("\n")[0]).toContain(
        "Its binding is still not verified",
      );
    } finally {
      await chmod(marks, 0o700);
    }
  },
);

test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "done --all finds a mark before agent-browser's socket directory exists, and fails when the marks cannot be listed (review of #993)",
  async () => {
    const { home, folder } = await folderWith(bindings.organizationBrowser);
    const env = {
      HOME: home,
      CODEX_THREAD_ID: "019a",
      AGENT_BROWSER_SOCKET_DIR: join(home, "sockets-not-yet"),
      XDG_RUNTIME_DIR: join(home, "run"),
    };
    const marks = join(env.XDG_RUNTIME_DIR, "lazurio-browser", "unverified");
    await mkdir(marks, { recursive: true });
    await writeFile(
      join(marks, "codex-019a.json"),
      JSON.stringify({
        schema: "lazurio.browser-unverified-binding.v1",
        session: "codex-019a",
        targetId: null,
        before: null,
      }),
    );
    const settled = await runBrowserCommand(
      ["done", "--all", "--folder", folder, "--json"],
      context(env),
    );
    expect(settled.code).toBe(0);
    expect(await present(join(marks, "codex-019a.json"))).toBe(false);
    // Marks that cannot be listed prove nothing settled: done --all fails.
    await chmod(marks, 0o000);
    try {
      const unlisted = await runBrowserCommand(
        ["done", "--all", "--folder", folder, "--json"],
        context(env),
      );
      expect(unlisted.code).toBe(1);
    } finally {
      await chmod(marks, 0o700);
    }
  },
);

test("a session whose tab another thread took gets a new window from apps open too, and the taken tab is never navigated; a new window whose address the browser refuses fails apps open", async () => {
  const runtime = await temporary("browser-taken-open-");
  const socketDir = join(runtime, "agent-browser");
  await mkdir(socketDir, { recursive: true });
  const env = { HOME: "/home/operator", XDG_RUNTIME_DIR: runtime };
  await bindSessionFiles(socketDir, "claude-019a", TAKEN_TAB);
  await mkdir(join(runtime, "lazurio-browser", "taken"), { recursive: true });
  await writeFile(
    join(runtime, "lazurio-browser", "taken", "claude-019a.json"),
    JSON.stringify({
      schema: "lazurio.browser-taken-window.v1",
      session: "claude-019a",
      targetId: TAKEN_TAB,
      thread: "codex-019b",
      by: "codex-019b",
      at: "2026-11-15T08:00:00.000Z",
    }),
  );
  const opened = windowSeams({ socketDir, targets: [TAKEN_TAB], env });
  const window = await openInThreadWindow(
    "claude-019a",
    "https://example.org/landing",
    opened.seams,
  );
  expect(window).toMatchObject({
    targetId: NEWTARGET,
    created: true,
    takenBy: { thread: "codex-019b" },
  });
  expect(opened.calls).toContainEqual([
    "Page.navigate",
    NEWTARGET,
    "https://example.org/landing",
  ]);
  expect(JSON.stringify(opened.calls)).not.toContain('"open"');
  expect(JSON.stringify(opened.calls)).not.toContain(
    `"Page.navigate","${TAKEN_TAB}"`,
  );
  const refused = windowSeams({
    socketDir,
    targets: [],
    env,
    navigation: "failed",
  });
  await expect(
    openInThreadWindow("claude-019b", "https://example.org/x", refused.seams),
  ).rejects.toEqual(new BrowserWindowFailure("navigate-failed"));
});

test.skipIf(process.platform === "win32")(
  "an unverified binding: window names the session and what to do, and done settles it once its daemon has ended, so the next window opens",
  async () => {
    const world = await takeWorld();
    const mark = join(world.runtime, "lazurio-browser", "unverified");
    await mkdir(mark, { recursive: true });
    // A window that did not finish left the session on another agent's tab,
    // its daemon still running.
    await bindSessionFiles(world.socketDir, "codex-019a", TAKEN_TAB, {
      pid: String(process.pid),
      sock: true,
    });
    await writeFile(
      join(mark, "codex-019a.json"),
      JSON.stringify({
        schema: "lazurio.browser-unverified-binding.v1",
        session: "codex-019a",
        targetId: NEWTARGET,
        before: null,
      }),
    );
    const blocked = await runBrowserCommand(
      ["window", "--folder", world.folder],
      {
        ...context(world.env, {
          ...windowSeams({
            socketDir: world.socketDir,
            targets: [TAKEN_TAB],
            env: world.env,
          }).seams,
          // A shutdown asked meanwhile is not taken: the daemon runs on.
          daemon: { ask: async () => ({ kind: "no-answer" }) },
        }),
      },
    );
    expect(blocked.code).toBe(1);
    expect(blocked.stderr).toContain(
      "The session codex-019a has no window for now",
    );
    expect(blocked.stderr).toContain(
      "Let go of it with lazurio browser done --session codex-019a",
    );
    expect(blocked.stderr).toContain(
      "lazurio browser window --session codex-019a-2",
    );
    // done lets go of the daemon and settles the binding: the foreign tab
    // is no longer the session's, and the mark is gone.
    const done = await world.run(["done"]);
    expect(done.code).toBe(0);
    expect(done.stdout).toContain(
      "Its unverified binding is settled: lazurio browser window opens a window in this session again.",
    );
    expect(await present(join(mark, "codex-019a.json"))).toBe(false);
    expect(await present(join(world.socketDir, "codex-019a.target"))).toBe(
      false,
    );
    const window = await world.run(["window", "--json"]);
    expect(window.code).toBe(0);
    expect(JSON.parse(window.stdout ?? "")).toMatchObject({
      targetId: NEWTARGET,
      created: true,
    });
  },
);
