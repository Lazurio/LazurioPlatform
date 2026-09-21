import type { ServiceManagerProcess } from "../../src/modules/service-manager-process";

type Unit = {
  description: string;
  cwd: string;
  active: string;
  sub: string;
  result: string;
  invocationId: string;
  controlGroup: string;
  properties: Record<string, string>;
  environment: string[];
  command: string[];
  dropIns: string;
  transient: string;
  type: string;
  flags: string[];
  fragmentPath?: string;
};

// In-memory stand-in for the systemd user manager behind the injected process
// adapter. It reproduces the behaviour observed on a real manager (systemd 255):
// a name that is loaded or failed refuses a new transient unit until reset, a
// clean stop unloads the unit, and a failed unit keeps its record and result.
export function createFakeServiceManager(
  options: {
    runtimeDirectory?: string;
    version?: number;
    managerEnvironment?: string[];
  } = {},
) {
  const runtimeDirectory = options.runtimeDirectory ?? "/run/user/1000";
  const units = new Map<string, Unit>();
  const populated = new Set<string>();
  const calls: { program: string; args: readonly string[] }[] = [];
  let invocations = 0;
  const behaviour = {
    // "fail-loaded": systemd-run exits non-zero and leaves a failed record.
    // "timeout-loaded": the request is killed at its deadline (no exit code)
    // while the manager still completes the start.
    start: "ok" as "ok" | "fail" | "fail-loaded" | "timeout-loaded",
    // How many control-group observations stay populated after a stop.
    stopLeavesPopulatedFor: 0,
    stop: "ok" as "ok" | "stuck" | "timeout-failed",
    unavailable: false,
  };
  const slice = "/user.slice/user-1000.slice/user@1000.service/app.slice";
  const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
  const option = (args: readonly string[], name: string) =>
    args
      .filter((value) => value.startsWith(`${name}=`))
      .map((value) => value.slice(name.length + 1));
  const unitOfBusPath = (path: string) =>
    path
      .slice(path.lastIndexOf("/") + 1)
      .replace(/_([0-9a-f]{2})/g, (_match, hex: string) =>
        String.fromCharCode(Number.parseInt(hex, 16)),
      );
  const run: ServiceManagerProcess = async (program, args) => {
    calls.push({ program, args: [...args] });
    if (behaviour.unavailable) return { code: null, stdout: "", stderr: "" };
    if (program === "busctl") {
      const state = units.get(unitOfBusPath(args[4] as string));
      if (!state) return { code: 1, stdout: "", stderr: "no such unit" };
      const values: Record<string, unknown> = {
        ExecStartEx: {
          type: "a(sasasttttuii)",
          data: [
            [
              state.command[0],
              state.command,
              state.flags,
              0,
              0,
              0,
              0,
              4242,
              0,
              0,
            ],
          ],
        },
        Environment: { type: "as", data: state.environment },
        UnsetEnvironment: {
          type: "as",
          data: (state.properties.UnsetEnvironment ?? "")
            .split(" ")
            .filter((name) => name),
        },
      };
      return ok(
        `${args
          .slice(6)
          .map((name) => JSON.stringify(values[name]))
          .join("\n")}\n`,
      );
    }
    if (program === "systemd-run") {
      const unit = option(args, "--unit")[0] as string;
      if (units.has(unit))
        return { code: 1, stdout: "", stderr: "already loaded" };
      if (behaviour.start === "fail")
        return { code: 1, stdout: "", stderr: "failed" };
      const properties: Record<string, string> = {};
      for (const entry of option(args, "--property")) {
        const split = entry.indexOf("=");
        properties[entry.slice(0, split)] = entry.slice(split + 1);
      }
      const failed = behaviour.start === "fail-loaded";
      const controlGroup = `${slice}/${unit}`;
      units.set(unit, {
        description: option(args, "--description")[0] ?? "",
        cwd: option(args, "--working-directory")[0] ?? "",
        active: failed ? "failed" : "active",
        sub: failed ? "failed" : "running",
        result: failed ? "exit-code" : "success",
        invocationId: (++invocations).toString(16).padStart(32, "0"),
        controlGroup: failed ? "" : controlGroup,
        properties,
        environment: option(args, "--setenv"),
        command: args.slice(args.indexOf("--") + 1),
        dropIns: "",
        transient: "yes",
        type: option(args, "--service-type")[0] ?? "simple",
        flags: args.includes("--expand-environment=no")
          ? ["no-env-expand"]
          : [],
      });
      if (!failed) populated.add(controlGroup);
      if (behaviour.start === "timeout-loaded")
        return { code: null, stdout: "", stderr: "" };
      return failed ? { code: 1, stdout: "", stderr: "failed" } : ok();
    }
    if (args[0] === "--version")
      return ok(`systemd ${options.version ?? 255} (255.4)\n+PAM`);
    const verb = args[1];
    const unit = args[args.length - 1] as string;
    if (verb === "is-system-running")
      return { code: 1, stdout: "degraded\n", stderr: "" };
    if (verb === "show-environment")
      return ok(
        `${(
          options.managerEnvironment ?? [
            "HOME=/home/admin",
            "PATH=/usr/local/bin:/usr/bin",
            "SSH_AUTH_SOCK=/run/user/1000/gnupg/S.gpg-agent.ssh",
            "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus",
            "XDG_RUNTIME_DIR=/run/user/1000",
          ]
        ).join("\n")}\n`,
      );
    if (verb === "show") {
      const state = units.get(unit);
      const shown: Record<string, string> = state
        ? {
            Type: state.type,
            Restart: state.properties.Restart ?? "",
            MainPID: state.active === "active" ? "4242" : "0",
            Result: state.result,
            ExecMainStartTimestampMonotonic: "97457161",
            ControlGroup: state.controlGroup,
            WorkingDirectory: state.cwd,
            KillMode: state.properties.KillMode ?? "",
            UMask: state.properties.UMask ?? "0022",
            TimeoutStopUSec: state.properties.TimeoutStopSec ?? "1min 30s",
            StandardInput: state.properties.StandardInput ?? "null",
            StandardOutput: state.properties.StandardOutput ?? "journal",
            StandardError: state.properties.StandardError ?? "inherit",
            Description: state.description,
            LoadState: "loaded",
            ActiveState: state.active,
            SubState: state.sub,
            FragmentPath:
              state.fragmentPath ??
              `${runtimeDirectory}/systemd/transient/${unit}`,
            DropInPaths: state.dropIns,
            Transient: state.transient,
            InvocationID: state.invocationId,
          }
        : {
            Type: "simple",
            Restart: "no",
            MainPID: "0",
            Result: "success",
            ExecMainStartTimestampMonotonic: "0",
            ControlGroup: "",
            WorkingDirectory: "",
            KillMode: "control-group",
            UMask: "0022",
            TimeoutStopUSec: "1min 30s",
            StandardInput: "null",
            StandardOutput: "journal",
            StandardError: "inherit",
            Description: unit,
            LoadState: "not-found",
            ActiveState: "inactive",
            SubState: "dead",
            FragmentPath: "",
            DropInPaths: "",
            Transient: "no",
            InvocationID: "",
          };
      return ok(
        `${Object.entries(shown)
          .map(([name, value]) => `${name}=${value}`)
          .join("\n")}\n`,
      );
    }
    if (verb === "stop") {
      const state = units.get(unit);
      if (!state) return ok();
      if (behaviour.stop === "stuck")
        return { code: null, stdout: "", stderr: "" };
      if (behaviour.stopLeavesPopulatedFor === 0)
        populated.delete(state.controlGroup);
      if (behaviour.stop === "timeout-failed") {
        state.active = "failed";
        state.sub = "failed";
        state.result = "timeout";
        state.controlGroup = "";
      } else units.delete(unit);
      return ok();
    }
    if (verb === "reset-failed") {
      const state = units.get(unit);
      if (!state) return { code: 1, stdout: "", stderr: "not loaded" };
      if (state.active === "failed") units.delete(unit);
      return ok();
    }
    if (verb === "list-units") {
      const pattern = unit.replace(/\*\.service$/, "");
      return ok(
        JSON.stringify(
          [...units]
            .filter(([name]) => name.startsWith(pattern))
            .map(([name, state]) => ({
              unit: name,
              load: "loaded",
              active: state.active,
              sub: state.sub,
              description: state.description,
            })),
        ),
      );
    }
    return { code: 1, stdout: "", stderr: "unsupported" };
  };
  return {
    run,
    runtimeDirectory,
    units,
    calls,
    behaviour,
    slice,
    // Kernel view of a control group, as read from cgroup.events.
    controlGroupEmpty: async (controlGroup: string) => {
      if (behaviour.stopLeavesPopulatedFor > 0) {
        behaviour.stopLeavesPopulatedFor--;
        if (behaviour.stopLeavesPopulatedFor === 0)
          populated.delete(controlGroup);
        return false;
      }
      return !populated.has(controlGroup);
    },
    // The application's main process exits by itself with a failure.
    // `lingering`: the manager already reports the unit failed while the kernel
    // still holds processes in its group for a while.
    crash(unit: string, result = "exit-code", lingering = false) {
      const state = units.get(unit);
      if (!state) throw new Error("No such unit");
      if (!lingering) populated.delete(state.controlGroup);
      Object.assign(state, {
        active: "failed",
        sub: "failed",
        result,
        controlGroup: lingering ? state.controlGroup : "",
      });
    },
    commands: (verb: string) =>
      calls.filter(
        (call) =>
          (call.program === verb && ["systemd-run", "busctl"].includes(verb)) ||
          (call.program === "systemctl" && call.args[1] === verb),
      ),
  };
}
