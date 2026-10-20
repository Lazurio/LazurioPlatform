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
import { join } from "node:path";
import {
  browserCommand,
  browserCommandWithoutNotice,
  browserLink,
  runBrowserCommand,
} from "../src/browser/cli";
import { stopSessionDaemon } from "../src/browser/contract/node";
import {
  browserCliExit,
  browserViewUrl,
  isStrip,
  threadSession,
} from "../src/browser/contract/pure";
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
import { browserEntryOf, resolveBrowserView } from "../src/browser/view";
import {
  BrowserWindowFailure,
  ensureThreadWindow,
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
  'ExecStart=/bin/sh -c \'b=$$(ls -d %h/.agent-browser/browsers/chrome-*/chrome %h/.agent-browser/browsers/chrome-*/chrome-linux64/chrome 2>/dev/null | sort -V | tail -n 1); [ -x "$$b" ] || exit 78; exec "$$b" --user-data-dir=%h/.local/share/lazurio-browser/profile --remote-debugging-port=9222 --no-first-run --no-default-browser-check --password-store=basic --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows --hide-crash-restore-bubble --window-size=1280,900 --deny-permission-prompts --load-extension=%h/.local/share/lazurio-browser/extension --disable-features=DisableLoadExtensionCommandLineSwitch about:blank\'',
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
      return input.created ?? { targetId: NEWTARGET };
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
  // (no browserContextId), then agent-browser's own tab binding and a pin by
  // a command that changes nothing: the people's view sets the page size
  // (F39 point 3).
  const created = windowSeams({ socketDir, targets: [] });
  expect(
    await ensureThreadWindow("codex-a", "https://example.com", created.seams),
  ).toEqual({ session: "codex-a", targetId: NEWTARGET, created: true });
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
  ).toEqual({ session: "codex-a", targetId: NEWTARGET, created: true });
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
          ? "### Jak Operátor stránku uvidí"
          : "### How the Operator sees a page",
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
      "The people's view of the Environment browser did not open the tab. Run lazurio doctor.",
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
