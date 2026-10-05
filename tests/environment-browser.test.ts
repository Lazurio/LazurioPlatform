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
import {
  browserCdpPort,
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

// The Environment browser (root decision 0191, decision F38): its units,
// their observation, the view's link, a thread's window and the CLI. No real
// systemd, browser or agent-browser: every command is recorded and answered.

const origin = "https://browser.workspace.example.lazurio.io";
const { team: _team, ...withoutTeamOwner } = organizationContext.owner;
const entry = Object.freeze({ origin, listenPort: 4848 });
const token = "a".repeat(64);

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

// The exact unit texts proven on a Remote Environment on 2026-10-05: Xvfb
// waits for its socket, Chrome is the browser unit's main process, the
// dashboard detaches from its oneshot unit.
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
  'ExecStart=/bin/sh -c \'b=$$(ls -d %h/.agent-browser/browsers/chrome-*/chrome %h/.agent-browser/browsers/chrome-*/chrome-linux64/chrome 2>/dev/null | sort -V | tail -n 1); [ -x "$$b" ] || exit 78; exec "$$b" --user-data-dir=%h/.local/share/lazurio-browser/profile --remote-debugging-port=9222 --no-first-run --no-default-browser-check --password-store=basic --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows --hide-crash-restore-bubble --window-size=1280,900 about:blank\'',
  "Restart=always",
  "RestartSec=3",
  "RestartPreventExitStatus=78",
  "",
  "[Install]",
  "WantedBy=default.target",
  "",
];

test("the three units render the texts proven on a Remote Environment", () => {
  expect(renderDisplayUnit().split("\n")).toEqual(displayLines);
  expect(renderBrowserUnit().split("\n")).toEqual(browserLines);
  expect(renderBrowserViewUnit(entry).split("\n")).toEqual([
    unitMarker,
    "[Unit]",
    "Description=Lazurio Environment browser view: the agent-browser dashboard behind the gateway",
    "ConditionFileIsExecutable=%h/.local/bin/agent-browser",
    "",
    "[Service]",
    "Type=oneshot",
    "RemainAfterExit=yes",
    "KillMode=process",
    "Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin",
    "Environment=AGENT_BROWSER_CDP=9222",
    `ExecStart=%h/.local/bin/agent-browser dashboard start --port 4848 --allowed-origins ${origin}`,
    "ExecStop=-%h/.local/bin/agent-browser dashboard stop",
    "TimeoutStartSec=60",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ]);
  // DevTools is never exposed: no address flag, so Chrome binds loopback.
  expect(renderBrowserUnit()).not.toContain("remote-debugging-address");
  expect(browserCdpPort).toBe(9222);
});

function recorder(failing: string[] = []) {
  const commands: string[][] = [];
  const run: ProcessRunner = async (command) => {
    commands.push([...command]);
    return { exitCode: failing.includes(command[2] ?? "") ? 1 : 0, stdout: "" };
  };
  return { commands, run };
}

test("installed only for a hosted operator whose handover routes the view; never stops the screen or the browser", async () => {
  const directory = join(await temporary("browser-units-"), "units");
  await mkdir(directory, { recursive: true });
  const { commands, run } = recorder();
  const env = { HOME: root, XDG_RUNTIME_DIR: "/run/user/1000" };

  expect(
    await installEnvironmentBrowser({
      directory,
      hosted: false,
      entry,
      run,
      env,
    }),
  ).toEqual({ state: "skipped-not-hosted" });
  expect(
    await installEnvironmentBrowser({
      directory,
      hosted: true,
      entry: undefined,
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
    ["systemctl", "--user", "try-restart", browserViewUnit],
    ["systemctl", "--user", "start", displayUnit, browserUnit, browserViewUnit],
  ]);
  const written = await stat(join(directory, browserUnit));

  // Repeated with the same entry: nothing rewritten, no reload, no restart;
  // `start` of active units changes nothing.
  commands.length = 0;
  expect(
    await installEnvironmentBrowser({
      directory,
      hosted: true,
      entry,
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

function dashboard(
  answer: unknown,
  sessions: unknown = [],
): Readonly<{ run: ProcessRunner; fetch: typeof fetch; calls: string[][] }> {
  const calls: string[][] = [];
  const run: ProcessRunner = async (command) => {
    calls.push([...command]);
    return answer === null
      ? { exitCode: 1, stdout: "" }
      : { exitCode: 0, stdout: JSON.stringify(answer) };
  };
  const fetcher = (async (url: string, init?: RequestInit) => {
    calls.push(["fetch", url, new Headers(init?.headers).get("origin") ?? ""]);
    return Response.json(sessions);
  }) as typeof fetch;
  return { run, fetch: fetcher, calls };
}
const started = (urls: unknown) => ({
  success: true,
  data: { access_urls: urls, port: 4848 },
});

test("the view: the dashboard's token from agent-browser's own answer, the session's window by its stream port", async () => {
  const env = { HOME: "/home/operator", XDG_RUNTIME_DIR: "/run/user/1000" };
  const ok = dashboard(
    started([`${origin}/#dashboard-access-token=${token}`]),
    [
      { engine: "chrome", port: 42791, session: "codex-thread" },
      { engine: "chrome", port: 42337, session: "other" },
    ],
  );
  expect(
    await resolveBrowserView(entry, "codex-thread", { ...ok, env }),
  ).toEqual({
    available: true,
    view: `${origin}/?port=42791&view=.html#dashboard-access-token=${token}`,
    session: "codex-thread",
  });
  // Exactly the unit's settings, on the Environment's own agent-browser, and
  // the session list asked on loopback with a loopback Origin.
  expect(ok.calls[0]).toEqual([
    "/home/operator/.local/bin/agent-browser",
    "dashboard",
    "start",
    "--port",
    "4848",
    "--allowed-origins",
    origin,
    "--json",
  ]);
  expect(ok.calls[1]).toEqual([
    "fetch",
    "http://127.0.0.1:4848/api/sessions",
    "http://127.0.0.1:4848",
  ]);
  // A session that is not running yet, or none named: every window.
  expect(await resolveBrowserView(entry, "unknown", { ...ok, env })).toEqual({
    available: true,
    view: `${origin}/#dashboard-access-token=${token}`,
    session: "unknown",
  });
  expect(await resolveBrowserView(entry, null, { ...ok, env })).toMatchObject({
    available: true,
    session: null,
  });
  // No entry, no agent-browser, another origin or a token of another shape.
  expect(await resolveBrowserView(undefined, null, { ...ok, env })).toEqual({
    available: false,
    reason: "not-declared",
  });
  for (const answer of [
    null,
    started([]),
    started([`https://elsewhere.example/#dashboard-access-token=${token}`]),
    started([`${origin}/#dashboard-access-token=xyz`]),
    { success: true },
  ]) {
    const refused = dashboard(answer);
    expect(await resolveBrowserView(entry, null, { ...refused, env })).toEqual({
      available: false,
      reason: "view-unavailable",
    });
  }
  expect(browserViewUrl(origin, token, null)).toBe(
    `${origin}/#dashboard-access-token=${token}`,
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

test("a thread's window: the bound one while it is open, otherwise a new window of the shared context bound and pinned", async () => {
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
  // (no browserContextId), then agent-browser's own tab binding and pin.
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
      "set",
      "viewport",
      "1280",
      "800",
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
      link: `${launchpad}/.lazurio/browser?session=codex-019a`,
      command: "agent-browser --cdp 9222 --session codex-019a",
    });
    expect(browserLink(launchpad, null)).toBe(`${launchpad}/.lazurio/browser`);
    expect(browserCommand("x")).toBe("agent-browser --cdp 9222 --session x");

    const link = await runBrowserCommand(
      ["link", "--folder", folder],
      context({ HOME: home }),
    );
    expect(link).toEqual({ code: 0, stdout: `${launchpad}/.lazurio/browser` });

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
  const view = dashboard(
    started([`${origin}/#dashboard-access-token=${token}`]),
    [{ engine: "chrome", port: 42791, session: "codex-a" }],
  );
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
    { run: view.run, fetch: view.fetch, env: { HOME: "/home/operator" } },
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
      const view = `${origin}/?port=42791&view=.html#dashboard-access-token=${token}`;
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
      // Every window without a session.
      expect(
        await (await hosted.get("/.lazurio/browser.json")).json(),
      ).toMatchObject({ available: true, session: null });
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
