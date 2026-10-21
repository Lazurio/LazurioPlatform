import { afterEach, expect, test } from "bun:test";
import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import {
  computerUnit,
  computerUseFinding,
  installComputerUse,
  observeComputerUse,
  renderComputerUnit,
} from "../src/computer/computer";
import { renderManual } from "../src/folder/manual";
import { presetProfile } from "../src/folder/presets";
import { renderInstructions } from "../src/folder/render";
import { runTool } from "../src/tools/status";
import type { ProcessRunner } from "../src/update/self-check";
import { unitMarker } from "../src/update/service-control";
import {
  type ExecutorWorld,
  executorWorld,
  writeExecutable,
} from "./fixtures/fake-executor";
import { bindings } from "./fixtures/machine-bindings";

// Computer Use of a Remote Environment (decision F59): the Cua Driver's daemon
// on the Environment's screen as the installer's user unit, its MCP proxy as
// the agents' server `computer` in Codex and Claude Code, and its state in
// doctor. No real systemd or driver: systemctl is recorded and answered, the
// harnesses and the driver are fakes on PATH.

let world: ExecutorWorld | undefined;
afterEach(async () => {
  await world?.close();
  world = undefined;
});

async function scene() {
  world = await executorWorld();
  const directory = join(world.home, ".config", "systemd", "user");
  await mkdir(directory, { recursive: true });
  await mkdir(join(world.home, ".local", "bin"), { recursive: true });
  const commands: string[][] = [];
  const failing: string[] = [];
  const run: ProcessRunner = async (command) => {
    commands.push([...command]);
    return { exitCode: failing.includes(command[2] ?? "") ? 1 : 0, stdout: "" };
  };
  const driver = join(world.home, ".local", "bin", "cua-driver");
  const socket = join(
    world.home,
    ".local",
    "state",
    "lazurio-computer",
    "driver.sock",
  );
  const input = {
    directory,
    hosted: true,
    declared: true,
    run,
    tools: runTool,
    platform: "linux",
    env: world.host.env,
  };
  return { world, directory, commands, failing, run, driver, socket, input };
}

// The driver's own `doctor --json`, answered from `~/cua-doctor.json` when
// the test writes one; its calls are recorded in `~/cua-driver.calls`.
const fakeDriver = `#!/bin/sh
echo "$* DISPLAY=$DISPLAY XDG_SESSION_TYPE=$XDG_SESSION_TYPE DBUS=$DBUS_SESSION_BUS_ADDRESS TELEMETRY=$CUA_DRIVER_RS_TELEMETRY_ENABLED UPDATE=$CUA_DRIVER_RS_UPDATE_CHECK" >> "$HOME/cua-driver.calls"
if [ "$1" = "doctor" ] && [ "$2" = "--json" ]; then
  if [ -f "$HOME/cua-doctor.json" ]; then cat "$HOME/cua-doctor.json"; exit 0; fi
  echo '{"ok":true,"probes":[{"label":"binary","status":"ok","message":"cua-driver 0.19.3 (x86_64-linux)"},{"label":"display server","status":"ok","message":"X11 (DISPLAY=:1)"},{"label":"X11 connection","status":"ok","message":"connected, 1 visible top-level window"},{"label":"AT-SPI","status":"ok","message":"org.a11y.Bus reachable via session bus"}]}'
  exit 0
fi
exit 64
`;

const probes = (
  overrides: Record<string, { status: string; message: string }>,
) =>
  JSON.stringify({
    ok: true,
    probes: [
      ["binary", "ok", "cua-driver 0.19.3 (x86_64-linux)"],
      ["display server", "ok", "X11 (DISPLAY=:1)"],
      ["X11 connection", "ok", "connected, 1 visible top-level window"],
      ["AT-SPI", "ok", "org.a11y.Bus reachable via session bus"],
    ].map(([label, status, message]) => ({
      label,
      ...(overrides[label ?? ""] ?? { status, message }),
    })),
  });

// ---- The unit ----------------------------------------------------------------

test("the unit runs the driver's daemon standalone on the screen, bound to it, skipped without the driver", () => {
  expect(renderComputerUnit().split("\n")).toEqual([
    unitMarker,
    "[Unit]",
    "Description=Lazurio Environment computer: Computer Use of the Environment's screen for every agent",
    "BindsTo=lazurio-display.service",
    "After=lazurio-display.service",
    "ConditionFileIsExecutable=%h/.local/bin/cua-driver",
    "",
    "[Service]",
    "Type=simple",
    "Environment=DISPLAY=:1",
    "Environment=XDG_SESSION_TYPE=x11",
    "Environment=DBUS_SESSION_BUS_ADDRESS=unix:path=%t/bus",
    "Environment=CUA_DRIVER_RS_TELEMETRY_ENABLED=false",
    "Environment=CUA_DRIVER_RS_UPDATE_CHECK=false",
    "ExecStart=%h/.local/bin/cua-driver serve --no-overlay --permission-mode standard --socket %h/.local/state/lazurio-computer/driver.sock",
    "Restart=on-failure",
    "RestartSec=3",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ]);
  // A host app's mode would end the daemon at once under systemd, whose
  // stdin is no liveness pipe.
  expect(renderComputerUnit()).not.toContain("--embedded");
  expect(renderComputerUnit()).not.toContain("LIVENESS");
});

// ---- Convergence -------------------------------------------------------------

test("installed only for a hosted operator with a screen; the agents get the MCP server computer once, restarted only when the unit changed", async () => {
  const { world, directory, commands, driver, socket, input } = await scene();
  await writeExecutable(driver, fakeDriver);

  expect(await installComputerUse({ ...input, hosted: false })).toEqual({
    state: "skipped-not-hosted",
  });
  expect(await installComputerUse({ ...input, declared: false })).toEqual({
    state: "skipped-not-declared",
  });
  expect(await readdir(directory)).toEqual([]);
  expect(commands).toEqual([]);
  expect(await world.calls("codex.calls")).toEqual([]);

  expect(await installComputerUse(input)).toEqual({
    state: "enabled",
    agents: { codex: "registered", claude: "registered" },
  });
  expect(await readdir(directory)).toEqual([computerUnit]);
  expect(await readFile(join(directory, computerUnit), "utf8")).toBe(
    renderComputerUnit(),
  );
  expect(commands).toEqual([
    ["systemctl", "--user", "daemon-reload"],
    ["systemctl", "--user", "enable", computerUnit],
    ["systemctl", "--user", "try-restart", computerUnit],
    ["systemctl", "--user", "start", computerUnit],
  ]);
  // Each harness's own CLI, the driver's proxy to the one daemon, both
  // switches off.
  expect(
    (await world.calls("codex.calls")).filter((line) =>
      line.startsWith("mcp add"),
    ),
  ).toEqual([
    `mcp add computer --env CUA_DRIVER_RS_TELEMETRY_ENABLED=false --env CUA_DRIVER_RS_UPDATE_CHECK=false -- ${driver} mcp --socket ${socket}|codex_home=`,
  ]);
  expect(
    (await world.calls("claude.calls")).filter((line) =>
      line.startsWith("mcp add"),
    ),
  ).toEqual([
    `mcp add --scope user computer -e CUA_DRIVER_RS_TELEMETRY_ENABLED=false -e CUA_DRIVER_RS_UPDATE_CHECK=false -- ${driver} mcp --socket ${socket}|traffic=1|config=`,
  ]);
  expect(
    JSON.parse(await readFile(join(world.home, ".claude.json"), "utf8"))
      .mcpServers.computer,
  ).toEqual({
    type: "stdio",
    command: driver,
    args: ["mcp", "--socket", socket],
    env: {
      CUA_DRIVER_RS_TELEMETRY_ENABLED: "false",
      CUA_DRIVER_RS_UPDATE_CHECK: "false",
    },
  });
  const written = await stat(join(directory, computerUnit));

  // Repeated: nothing rewritten, reloaded or restarted, nothing added again.
  commands.length = 0;
  expect(await installComputerUse(input)).toMatchObject({ state: "enabled" });
  expect((await stat(join(directory, computerUnit))).mtimeMs).toBe(
    written.mtimeMs,
  );
  expect(commands).toEqual([
    ["systemctl", "--user", "enable", computerUnit],
    ["systemctl", "--user", "start", computerUnit],
  ]);
  for (const harness of ["codex.calls", "claude.calls"])
    expect(
      (await world.calls(harness)).filter((line) => line.startsWith("mcp add")),
    ).toHaveLength(1);
  // Never the screen or the browser.
  expect(commands.flat().some((word) => word.includes("display"))).toBe(false);
  expect(commands.flat().some((word) => word.includes("browser"))).toBe(false);
});

test("without the driver the unit waits for it and the agents' own entries go; another entry, and one named computer that is not Lazurio's, stay", async () => {
  const { world, driver, input } = await scene();
  await writeExecutable(driver, fakeDriver);
  expect(await installComputerUse(input)).toMatchObject({ state: "enabled" });
  // The operator's own entries beside Lazurio's.
  const claudeFile = join(world.home, ".claude.json");
  const claude = JSON.parse(await readFile(claudeFile, "utf8"));
  claude.mcpServers.notes = { type: "stdio", command: "/opt/notes", args: [] };
  await writeFile(claudeFile, JSON.stringify(claude));

  await rm(driver);
  const missing = await installComputerUse(input);
  expect(missing).toMatchObject({
    state: "driver-missing",
    agents: { codex: "missing", claude: "missing" },
  });
  expect(computerUseFinding(missing)).toEqual([
    "Computer Use waits for the Cua Driver at ~/.local/bin/cua-driver, which is installed with the Environment (Machines). Until then agents have no computer tool; the Environment browser works as before.",
  ]);
  expect(
    (await world.calls("codex.calls")).filter((line) =>
      line.startsWith("mcp remove"),
    ),
  ).toEqual(["mcp remove computer|codex_home="]);
  expect(
    (await world.calls("claude.calls")).filter((line) =>
      line.startsWith("mcp remove"),
    ),
  ).toEqual(["mcp remove --scope user computer|traffic=1|config="]);
  expect(
    Object.keys(JSON.parse(await readFile(claudeFile, "utf8")).mcpServers),
  ).toEqual(["notes"]);

  // An entry named computer the operator made for something else is never
  // removed, and never replaced once the driver is there.
  const foreign = JSON.parse(await readFile(claudeFile, "utf8"));
  foreign.mcpServers.computer = {
    type: "stdio",
    command: "/opt/other-computer",
    args: [],
  };
  await writeFile(claudeFile, JSON.stringify(foreign));
  expect(await installComputerUse(input)).toMatchObject({
    state: "driver-missing",
    agents: { claude: "conflict" },
  });
  await writeExecutable(driver, fakeDriver);
  const conflict = await installComputerUse(input);
  expect(conflict).toEqual({
    state: "enabled",
    agents: { codex: "registered", claude: "conflict" },
  });
  expect(computerUseFinding(conflict)).toHaveLength(1);
  expect(
    JSON.parse(await readFile(claudeFile, "utf8")).mcpServers.computer.command,
  ).toBe("/opt/other-computer");
});

// Machines installs Codex and Claude Code into ~/.local/bin; a Machines
// apply or an agent's shell may run `lazurio install` without it on PATH.
test("the harnesses in ~/.local/bin get the entry whatever PATH the caller has", async () => {
  const { world, driver, input } = await scene();
  await writeExecutable(driver, fakeDriver);
  const bin = join(world.home, ".local", "bin");
  for (const harness of ["codex", "claude"])
    await copyFile(join(world.fakes, harness), join(bin, harness));
  const onlyBun = join(world.parent, "only-bun");
  await mkdir(onlyBun);
  await symlink(process.execPath, join(onlyBun, "bun"));
  expect(
    await installComputerUse({
      ...input,
      env: { ...input.env, PATH: `${onlyBun}:/usr/bin:/bin` },
    }),
  ).toEqual({
    state: "enabled",
    agents: { codex: "registered", claude: "registered" },
  });
});

test("a unit someone else wrote is left alone, and a refusing manager is a finding, never a throw; no agent is told before the unit runs", async () => {
  const { world, directory, commands, failing, driver, input } = await scene();
  await writeExecutable(driver, fakeDriver);
  await writeFile(join(directory, computerUnit), "[Unit]\nDescription=mine\n");
  expect(await installComputerUse(input)).toMatchObject({
    state: "foreign-unit",
  });
  expect(await readFile(join(directory, computerUnit), "utf8")).toBe(
    "[Unit]\nDescription=mine\n",
  );
  expect(commands).toEqual([]);
  await rm(join(directory, computerUnit));

  for (const [step, expected] of [
    ["daemon-reload", "reload"],
    ["enable", "enable"],
    ["start", "start"],
  ] as const) {
    await rm(join(directory, computerUnit), { force: true });
    failing.length = 0;
    failing.push(step);
    expect(await installComputerUse(input)).toMatchObject({
      state: "failed",
      step: expected,
    });
  }
  expect(await world.calls("codex.calls")).toEqual([]);
  expect(await world.calls("claude.calls")).toEqual([]);
});

// ---- Doctor ------------------------------------------------------------------

function managerAnswering(state: string): ProcessRunner {
  return async () => ({
    exitCode: 0,
    stdout:
      state === "not-found"
        ? "LoadState=not-found\nActiveState=inactive\n"
        : `LoadState=loaded\nActiveState=${state}\n`,
  });
}

test("doctor: skipped where the screen cannot be, a warning with the reason and the next step's subject, ok with the driver's version and both harnesses", async () => {
  const { world, driver, input } = await scene();
  const base = {
    platform: "linux",
    env: world.host.env,
    supervised: true,
    hosted: async () => true,
    declared: true,
    run: managerAnswering("active"),
    tools: runTool,
  } as const;
  expect(await observeComputerUse({ ...base, platform: "darwin" })).toEqual({
    outcome: "skipped",
    reason: "no-user-manager",
  });
  expect(await observeComputerUse({ ...base, supervised: false })).toEqual({
    outcome: "skipped",
    reason: "not-supervised",
  });
  expect(
    await observeComputerUse({ ...base, hosted: async () => false }),
  ).toEqual({ outcome: "skipped", reason: "not-hosted" });
  expect(await observeComputerUse({ ...base, declared: false })).toEqual({
    outcome: "skipped",
    reason: "browser-not-declared",
  });
  // Machines has not delivered the driver yet.
  expect(await observeComputerUse(base)).toEqual({
    outcome: "warn",
    reason: "computer-driver-missing",
  });
  await writeExecutable(driver, fakeDriver);
  for (const [state, reason] of [
    ["not-found", "computer-unit-not-loaded"],
    ["failed", "computer-unit-failed"],
    ["inactive", "computer-unit-inactive"],
  ] as const)
    expect(
      await observeComputerUse({ ...base, run: managerAnswering(state) }),
    ).toEqual({ outcome: "warn", reason });

  // The driver's own doctor.
  const doctorFile = join(world.home, "cua-doctor.json");
  await writeFile(doctorFile, "not json");
  expect(await observeComputerUse(base)).toEqual({
    outcome: "warn",
    reason: "computer-doctor-unreadable",
  });
  await writeFile(
    doctorFile,
    probes({
      "display server": {
        status: "warn",
        message: "neither DISPLAY nor WAYLAND_DISPLAY set",
      },
    }),
  );
  expect(await observeComputerUse(base)).toEqual({
    outcome: "warn",
    reason: "computer-display-unavailable",
    context: { toolVersion: "0.19.3" },
  });
  await writeFile(
    doctorFile,
    probes({
      "AT-SPI": { status: "warn", message: "accessibility bus not reachable" },
    }),
  );
  expect(await observeComputerUse(base)).toEqual({
    outcome: "warn",
    reason: "computer-accessibility-unavailable",
    context: { toolVersion: "0.19.3" },
  });
  // A screen with no window yet is still an X11 screen.
  await writeFile(
    doctorFile,
    probes({
      "X11 connection": {
        status: "warn",
        message: "no top-level windows returned",
      },
    }),
  );
  expect(await observeComputerUse(base)).toEqual({
    outcome: "warn",
    reason: "computer-agents-missing",
    context: {
      toolVersion: "0.19.3",
      codexMcp: "missing",
      claudeMcp: "missing",
    },
  });
  // The driver's doctor ran on the screen, with the session bus and without
  // telemetry or an update check.
  expect((await world.calls("cua-driver.calls")).at(-1)).toBe(
    `doctor --json DISPLAY=:1 XDG_SESSION_TYPE=x11 DBUS=unix:path=${world.host.env.XDG_RUNTIME_DIR}/bus TELEMETRY=false UPDATE=false`,
  );

  await rm(doctorFile);
  expect(await installComputerUse(input)).toMatchObject({ state: "enabled" });
  expect(await observeComputerUse(base)).toEqual({
    outcome: "ok",
    context: {
      toolVersion: "0.19.3",
      codexMcp: "registered",
      claudeMcp: "registered",
    },
  });
});

// ---- The Folder --------------------------------------------------------------

test("the Folder tells agents about the tool computer only where the Environment has its screen: one agent on it at a time, the browser beside it", () => {
  for (const locale of ["cs", "en"] as const) {
    const profile = presetProfile("hosted-organization-personal", "linux", {
      locale,
    });
    const source = (machine: typeof bindings.organizationBrowser) => ({
      preset: "hosted-organization-personal" as const,
      machine,
      profile,
    });
    const agents = renderInstructions(source(bindings.organizationBrowser));
    const manual =
      renderManual(source(bindings.organizationBrowser))[
        "manual/this-machine.md"
      ] ?? "";
    expect(agents).toContain("`computer` (Computer Use)");
    expect(manual).toContain("### Computer Use");
    expect(manual).toContain("`computer-use`");
    expect(manual).toContain("`lazurio-computer`");
    expect(agents).toMatch(
      locale === "cs"
        ? /vždy jen jeden agent/
        : /one agent works on it at a time/,
    );
    expect(manual).toMatch(
      locale === "cs"
        ? /Uživatel obrazovku zatím nevidí/
        : /The user cannot see the screen yet/,
    );

    const without = bindings.organizationEntry;
    expect(renderInstructions(source(without))).not.toContain("`computer`");
    expect(
      renderManual(source(without))["manual/this-machine.md"],
    ).not.toContain("Computer Use");
  }
});
