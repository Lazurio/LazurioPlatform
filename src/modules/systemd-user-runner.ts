import { createHash } from "node:crypto";
import { inspectOwnedDirectory } from "../folder/owned-directory";
import type {
  ApplicationRef,
  ApplicationRunner,
  ApplicationStart,
  ApplicationState,
  ServiceIdentity,
} from "./application-runner";
import type { probeListenerHealth } from "./health";
import {
  observeOwnedListener,
  refuseOccupiedPorts,
} from "./listener-observation";
import {
  compareListenerOwner,
  type observeListenerBindings,
} from "./listener-ownership";
import { parseProcessLaunch } from "./process-launch";
import {
  isControlGroupEmpty,
  readProcessControlGroup,
  type ServiceManagerProcess,
} from "./service-manager-process";

const unitPrefix = "lazurio-app";
const descriptionPattern =
  /^Lazurio application; declaration sha256:([0-9a-f]{64})$/;
// Set by the service manager itself for every invocation. Applications get the
// declared environment; the invocation id is the only manager variable kept.
const managerInvocationVariables = [
  "MANAGERPID",
  "SYSTEMD_EXEC_PID",
  "MEMORY_PRESSURE_WATCH",
  "MEMORY_PRESSURE_WRITE",
  "JOURNAL_STREAM",
  "NOTIFY_SOCKET",
  "WATCHDOG_PID",
  "WATCHDOG_USEC",
];
const shownProperties = [
  "LoadState",
  "ActiveState",
  "SubState",
  "MainPID",
  "ExecMainStartTimestampMonotonic",
  "InvocationID",
  "ControlGroup",
  "Result",
  "WorkingDirectory",
  "Description",
  "Transient",
  "FragmentPath",
  "DropInPaths",
  "KillMode",
  "Restart",
  "Type",
] as const;
const stopTimeoutSeconds = 5;

// No NUL, control character or DEL: such text is never passed to the manager.
function hasControlCharacter(value: string) {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function readable(value: string) {
  const text = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24)
    .replace(/-+$/, "");
  return text || "x";
}

// Every unit of one canonical Organization directory shares this prefix, so two
// Folders (or two checkouts of the same Organization) can never collide or list
// each other's applications.
export function organizationUnitPrefix(organizationDirectory: string) {
  return `${unitPrefix}-${digest([
    "lazurio-application-unit-v1",
    organizationDirectory,
  ]).slice(0, 16)}-`;
}

// Coordination lock of one Organization directory, inside the user manager's own
// runtime directory: the same scope and lifetime as the transient units, never
// inside a module checkout, and gone with the last session like they are.
export function applicationCoordinationLockFile(
  runtimeDirectory: string,
  organizationDirectory: string,
) {
  if (
    !runtimeDirectory.startsWith("/") ||
    hasControlCharacter(runtimeDirectory)
  )
    throw new Error("Absolute user runtime directory required");
  return `${runtimeDirectory}/lazurio/${organizationUnitPrefix(
    organizationDirectory,
  )}coordination.lock`;
}

// Deterministic, sanitized and length-bounded. The readable part is lossy and
// for people only; uniqueness comes from the digest of the exact identity.
export function applicationUnitName(
  organizationDirectory: string,
  application: ApplicationRef,
) {
  const app = application.package.replace(/(^|\/)package\.json$/, "") || "root";
  return `${organizationUnitPrefix(organizationDirectory)}${[
    application.company,
    application.module,
    app,
  ]
    .map(readable)
    .join(".")}-${digest([
    "lazurio-application-unit-v1",
    organizationDirectory,
    application.company,
    application.module,
    application.package,
  ]).slice(0, 16)}.service`;
}

type UnitObservation = Readonly<
  | { kind: "not-running" }
  | { kind: "unrecognized" }
  | { kind: "unavailable" }
  | (UnitRecord & {
      kind: "running";
      phase: "starting" | "running" | "stopping";
    })
  | (UnitRecord & { kind: "ended" })
>;
type UnitRecord = {
  cwd: string;
  declarationDigest: string;
  controlGroup: string;
  service: ServiceIdentity;
};

// Linux owner: each application is a TRANSIENT systemd user service. Nothing is
// written to the account's unit directories, nothing survives a reboot, and
// identity, state and the control group are always read back from the service
// manager. This process never holds a PID and never signals a process itself.
export function createSystemdUserRunner(input: {
  organizationDirectory: string;
  runtimeDirectory: string;
  run: ServiceManagerProcess;
  observeBindings?: typeof observeListenerBindings;
  probeHealth?: typeof probeListenerHealth;
  processControlGroup?: typeof readProcessControlGroup;
  controlGroupEmpty?: typeof isControlGroupEmpty;
  inspectDirectory?: (directory: string) => Promise<unknown>;
  sleep?: (milliseconds: number) => Promise<unknown>;
  // Bounded wait for the manager and the kernel to agree the group is gone.
  confirmStopMs?: number;
}): ApplicationRunner {
  const organization = input.organizationDirectory;
  const run = input.run;
  const processControlGroup =
    input.processControlGroup ?? readProcessControlGroup;
  const controlGroupEmpty = input.controlGroupEmpty ?? isControlGroupEmpty;
  const inspectDirectory = input.inspectDirectory ?? inspectOwnedDirectory;
  const sleep =
    input.sleep ?? ((milliseconds: number) => Bun.sleep(milliseconds));
  if (
    ![organization, input.runtimeDirectory].every(
      (path) => path.startsWith("/") && !hasControlCharacter(path),
    )
  )
    throw new Error("Canonical Organization and runtime directories required");
  const confirmStopMs = input.confirmStopMs ?? 5000;
  if (
    !Number.isInteger(confirmStopMs) ||
    confirmStopMs < 1 ||
    confirmStopMs > 30_000
  )
    throw new Error("Bounded stop confirmation required");
  const prefix = organizationUnitPrefix(organization);
  const identify = (application: ApplicationRef) =>
    applicationUnitName(organization, application);
  let expansionFlag: boolean | null = null;

  async function observe(unit: string): Promise<UnitObservation> {
    const unavailable = Object.freeze({ kind: "unavailable" as const });
    let result: Awaited<ReturnType<ServiceManagerProcess>>;
    try {
      result = await run(
        "systemctl",
        [
          "--user",
          "show",
          "--no-pager",
          `--property=${shownProperties.join(",")}`,
          "--",
          unit,
        ],
        { timeoutMs: 5000 },
      );
    } catch {
      return unavailable;
    }
    if (result.code !== 0) return unavailable;
    const properties = new Map<string, string>();
    for (const line of result.stdout.split("\n")) {
      if (!line) continue;
      const split = line.indexOf("=");
      if (split < 1 || properties.has(line.slice(0, split))) return unavailable;
      properties.set(line.slice(0, split), line.slice(split + 1));
    }
    const value = (name: (typeof shownProperties)[number]) =>
      properties.get(name);
    if (shownProperties.some((name) => value(name) === undefined))
      return unavailable;
    const active = value("ActiveState") as string;
    if (value("LoadState") === "not-found" || active === "inactive")
      return Object.freeze({ kind: "not-running" as const });
    if (value("LoadState") !== "loaded") return unavailable;
    // Only the exact shape this runner generates is ever controlled. A unit file,
    // a drop-in written by hand or a different policy under this name is foreign.
    const description = descriptionPattern.exec(value("Description") as string);
    const cwd = value("WorkingDirectory") as string;
    if (
      value("Transient") !== "yes" ||
      value("FragmentPath") !==
        `${input.runtimeDirectory}/systemd/transient/${unit}` ||
      value("DropInPaths") !== "" ||
      value("KillMode") !== "control-group" ||
      value("Restart") !== "no" ||
      value("Type") !== "exec" ||
      !description ||
      !(cwd === organization || cwd.startsWith(`${organization}/`))
    )
      return Object.freeze({ kind: "unrecognized" as const });
    const invocationId = value("InvocationID") as string;
    if (!/^[0-9a-f]{32}$/.test(invocationId)) return unavailable;
    const service = Object.freeze({
      unit,
      invocationId,
      activeState: active,
      subState: value("SubState") as string,
      result: value("Result") as string,
    });
    const observation = {
      cwd,
      declarationDigest: description[1] as string,
      controlGroup: value("ControlGroup") as string,
      service,
    };
    if (active === "failed")
      return Object.freeze({ kind: "ended" as const, ...observation });
    if (!["active", "activating", "deactivating"].includes(active))
      return unavailable;
    if (!observation.controlGroup.startsWith("/")) return unavailable;
    return Object.freeze({
      kind: "running" as const,
      phase:
        active === "activating"
          ? ("starting" as const)
          : active === "deactivating"
            ? ("stopping" as const)
            : ("running" as const),
      ...observation,
    });
  }

  // A failed unit keeps its record until reset. The service manager has already
  // stopped its control group; confirm that before clearing the record.
  async function clearFailed(unit: string, controlGroup: string) {
    if (controlGroup && !(await controlGroupEmpty(controlGroup))) return false;
    const reset = await run(
      "systemctl",
      ["--user", "reset-failed", "--", unit],
      {
        timeoutMs: 5000,
      },
    );
    if (reset.code === null) return false;
    return (await observe(unit)).kind === "not-running";
  }

  async function supportsExpansionFlag() {
    if (expansionFlag === null) {
      const version = await run("systemctl", ["--version"], {
        timeoutMs: 5000,
      });
      const match = /^systemd (\d+)/.exec(version.stdout);
      if (version.code !== 0 || !match)
        throw new Error("Service manager version unavailable");
      expansionFlag = Number(match[1]) >= 254;
    }
    return expansionFlag;
  }

  // Bounded definition from the validated launch only: exact argv (no shell),
  // exact working directory, an allowlisted environment and nothing inherited
  // from the manager (its environment carries session sockets and credentials).
  async function definition(unit: string, request: ApplicationStart) {
    const launch = parseProcessLaunch(request.launch);
    const texts = [launch.executable, launch.cwd, ...launch.args];
    for (const [name, entry] of Object.entries(launch.env))
      texts.push(name, entry);
    if (
      texts.some(hasControlCharacter) ||
      !/^[0-9a-f]{64}$/.test(request.declarationDigest) ||
      !(
        launch.cwd === organization || launch.cwd.startsWith(`${organization}/`)
      )
    )
      throw new Error("Launch outside the owned Organization directory");
    await inspectDirectory(organization);
    await inspectDirectory(launch.cwd);
    const args = [
      "--user",
      "--quiet",
      "--no-ask-password",
      `--unit=${unit}`,
      `--description=Lazurio application; declaration sha256:${request.declarationDigest}`,
      "--service-type=exec",
      `--working-directory=${launch.cwd}`,
      "--property=KillMode=control-group",
      "--property=Restart=no",
      "--property=UMask=0077",
      `--property=TimeoutStopSec=${stopTimeoutSeconds}s`,
      "--property=StandardInput=null",
      "--property=StandardOutput=null",
      "--property=StandardError=null",
    ];
    // The manager expands $VARIABLE in arguments unless told not to. Older
    // managers cannot be told, so such an argument is refused instead.
    if (await supportsExpansionFlag()) args.push("--expand-environment=no");
    else if (launch.args.some((entry) => entry.includes("$")))
      throw new Error("Argument would be expanded by the service manager");
    const environment = await run("systemctl", ["--user", "show-environment"], {
      timeoutMs: 5000,
    });
    if (environment.code !== 0)
      throw new Error("Service manager environment unavailable");
    const unset = new Set(managerInvocationVariables);
    for (const line of environment.stdout.split("\n")) {
      if (!line) continue;
      const name = line.slice(0, Math.max(0, line.indexOf("=")));
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
        throw new Error("Unexpected service manager environment");
      unset.add(name);
    }
    for (const [name, entry] of Object.entries(launch.env)) {
      unset.delete(name);
      args.push(`--setenv=${name}=${entry}`);
    }
    if (unset.size)
      args.push(`--property=UnsetEnvironment=${[...unset].sort().join(" ")}`);
    return Object.freeze([...args, "--", launch.executable, ...launch.args]);
  }

  const runner: ApplicationRunner = {
    kind: "systemd-user" as const,
    survivesOwnerExit: true,
    identify,
    async inspect(application: ApplicationRef): Promise<ApplicationState> {
      const state = await observe(identify(application));
      if (state.kind === "running")
        return Object.freeze({
          kind: "running" as const,
          phase: state.phase,
          cwd: state.cwd,
          declarationDigest: state.declarationDigest,
          service: state.service,
        });
      if (state.kind === "ended")
        return Object.freeze({
          kind: "ended" as const,
          cwd: state.cwd,
          result: state.service.result,
          cleanup:
            !state.controlGroup || (await controlGroupEmpty(state.controlGroup))
              ? ("on-start" as const)
              : ("explicit-stop" as const),
          service: state.service,
        });
      return Object.freeze({ kind: state.kind });
    },
    async start(request) {
      const unit = identify(request.application);
      let argv: readonly string[];
      try {
        const state = await observe(unit);
        if (state.kind === "running")
          return Object.freeze({ kind: "already-managed" as const });
        if (state.kind === "unavailable")
          return Object.freeze({ kind: "inspection-unavailable" as const });
        if (state.kind === "unrecognized")
          return Object.freeze({ kind: "launch-failed" as const });
        // Validate everything before any effect, including clearing a record.
        const refusal = await refuseOccupiedPorts(
          request.ports,
          input.observeBindings,
        );
        if (refusal) return refusal;
        argv = await definition(unit, request);
        // The manager refuses a start while a failed record of this name remains.
        if (
          state.kind === "ended" &&
          !(await clearFailed(unit, state.controlGroup))
        )
          return Object.freeze({
            kind: "application-cleanup-required" as const,
          });
      } catch {
        return Object.freeze({ kind: "launch-failed" as const });
      }
      let started: Awaited<ReturnType<ServiceManagerProcess>> | null = null;
      try {
        started = await run("systemd-run", argv, { timeoutMs: 20_000 });
      } catch {
        /* the manager's view below decides what exists */
      }
      if (started?.code === 0)
        return Object.freeze({ kind: "started" as const });
      // A failed start must leave no half-owned service behind.
      const after = await observe(unit);
      if (after.kind === "ended") await clearFailed(unit, after.controlGroup);
      if (after.kind === "running") {
        // The manager refused because the name is taken: someone else's start won.
        if (started && started.code !== null)
          return Object.freeze({ kind: "already-managed" as const });
        // Our own request outlived its deadline: withdraw it, never half-own it.
        return (await runner.stop(request.application)).kind === "group-stopped"
          ? Object.freeze({ kind: "launch-failed" as const })
          : Object.freeze({ kind: "application-cleanup-required" as const });
      }
      return Object.freeze({ kind: "launch-failed" as const });
    },
    async observeListener(application, listener, timeoutMs = 1500) {
      const unit = identify(application);
      const first = await observe(unit);
      if (first.kind !== "running" || first.phase !== "running")
        return Object.freeze({ kind: "lifecycle-inactive" as const });
      return observeOwnedListener({
        listener,
        timeoutMs,
        ...(input.observeBindings
          ? { observeBindings: input.observeBindings }
          : {}),
        ...(input.probeHealth ? { probeHealth: input.probeHealth } : {}),
        // The same invocation, as reported by the manager at each step.
        active: async () => {
          const current = await observe(unit);
          return (
            current.kind === "running" &&
            current.phase === "running" &&
            current.service.invocationId === first.service.invocationId &&
            current.controlGroup === first.controlGroup
          );
        },
        ownership: async (bindings, declared) => {
          const owned = new Set<number>();
          if (bindings.kind === "observed")
            for (const binding of bindings.bindings) {
              const group = await processControlGroup(binding.pid);
              if (
                group !== null &&
                (group === first.controlGroup ||
                  group.startsWith(`${first.controlGroup}/`))
              )
                owned.add(binding.pid);
            }
          const result = compareListenerOwner(
            bindings,
            declared.host,
            declared.port,
            (binding) => owned.has(binding.pid),
          );
          if (result === "matches-owner") return null;
          return result === "foreign-owner" ? "foreign-control-group" : result;
        },
      });
    },
    async stop(application) {
      const unit = identify(application);
      const stopped = Object.freeze({ kind: "group-stopped" as const });
      const incomplete = Object.freeze({ kind: "incomplete" as const });
      const before = await observe(unit);
      if (before.kind === "not-running") return stopped;
      if (before.kind === "unavailable" || before.kind === "unrecognized")
        return incomplete;
      if (before.kind === "ended")
        return (await clearFailed(unit, before.controlGroup))
          ? stopped
          : incomplete;
      try {
        // Blocks until the manager's stop job ends: SIGTERM to the whole control
        // group, then SIGKILL after the unit's bounded stop timeout.
        await run("systemctl", ["--user", "stop", "--", unit], {
          timeoutMs: (stopTimeoutSeconds * 2 + 10) * 1000,
        });
      } catch {
        /* the manager's view below decides */
      }
      const deadline = performance.now() + confirmStopMs;
      do {
        const current = await observe(unit);
        if (
          current.kind === "not-running" &&
          (await controlGroupEmpty(before.controlGroup))
        )
          return stopped;
        if (current.kind === "ended")
          return (await controlGroupEmpty(before.controlGroup)) &&
            (await clearFailed(unit, current.controlGroup))
            ? stopped
            : incomplete;
        if (current.kind === "unrecognized") return incomplete;
        await sleep(50);
      } while (performance.now() < deadline);
      return incomplete;
    },
    async list() {
      const unavailable = Object.freeze({ kind: "unavailable" as const });
      try {
        const result = await run(
          "systemctl",
          [
            "--user",
            "list-units",
            "--all",
            "--type=service",
            "--output=json",
            "--no-pager",
            "--",
            `${prefix}*.service`,
          ],
          { timeoutMs: 5000 },
        );
        if (result.code !== 0) return unavailable;
        const units: unknown = JSON.parse(result.stdout.trim() || "[]");
        if (!Array.isArray(units)) return unavailable;
        const applications = [];
        for (const entry of units) {
          const unit = (entry as { unit?: unknown })?.unit;
          const active = (entry as { active?: unknown })?.active;
          if (typeof unit !== "string" || typeof active !== "string")
            return unavailable;
          if (!unit.startsWith(prefix) || active === "inactive") continue;
          applications.push(
            Object.freeze({
              id: unit,
              state:
                active === "failed" ? ("ended" as const) : ("running" as const),
            }),
          );
        }
        return Object.freeze({
          kind: "listed" as const,
          applications: Object.freeze(applications),
        });
      } catch {
        return unavailable;
      }
    },
    // Owner shutdown never stops a service: outliving the Launchpad is the point.
    async close() {
      return Object.freeze({ kind: "closed" as const });
    },
  };
  return Object.freeze(runner);
}
