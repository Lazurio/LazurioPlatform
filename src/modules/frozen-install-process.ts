import { inspectBunToolchain } from "./bun-toolchain";
import { startGuardedProcess } from "./guarded-process";
import {
  type inspectInstallAuthority,
  verifyInstallAuthority,
} from "./install-authority";
import { parseProcessLaunch } from "./process-launch";

type Outcome =
  | Readonly<{ kind: "process-exited"; code: number }>
  | Readonly<{
      kind:
        | "cancelled"
        | "timed-out"
        | "authority-changed"
        | "launch-failed"
        | "guard-lost";
    }>;

// Internal effect under the resolved dependency owner's operation lock. This is
// NOT an installer/readiness API: the caller still owns authorization, repository
// and local dependency postconditions, clean-tree custody and lifecycle decisions.
// Script execution is explicit trusted module code, not sandboxed code. Retain the
// returned handle if cleanup is incomplete; never lose ownership or report ready.
type ProcessInput = {
  authority: Awaited<ReturnType<typeof inspectInstallAuthority>>;
  executable: string;
  platformExecutable: string;
  env: Record<string, string>;
  timeoutMs: number;
  signal?: AbortSignal;
};

export function modulePreparationArgs(
  authority: ProcessInput["authority"],
  script: string,
) {
  const scripts = authority.manifest.scripts;
  if (
    typeof script !== "string" ||
    !/^[A-Za-z][A-Za-z0-9:_-]*$/.test(script) ||
    !scripts ||
    typeof scripts !== "object" ||
    Array.isArray(scripts) ||
    !Object.hasOwn(scripts, script) ||
    typeof (scripts as Record<string, unknown>)[script] !== "string" ||
    !(scripts as Record<string, string>)[script]?.trim()
  )
    throw new Error("Explicit declared module preparation script required");
  return Object.freeze(["--no-env-file", "run", script]);
}

export function runFrozenInstallProcess(input: ProcessInput) {
  return runBunOwnerProcess(input, [
    "--no-env-file",
    "install",
    "--frozen-lockfile",
  ]);
}

// The trusted lifecycle adapter selects a declared script in the exact install
// owner. This is not a DB resolver, remote recipe, arbitrary CLI argument or grant.
export function runModulePreparationProcess(
  input: ProcessInput & { script: string },
) {
  return runBunOwnerProcess(
    input,
    modulePreparationArgs(input.authority, input.script),
  );
}

async function runBunOwnerProcess(
  input: ProcessInput,
  args: readonly string[],
) {
  if (
    !Number.isInteger(input.timeoutMs) ||
    input.timeoutMs < 1 ||
    input.timeoutMs > 600_000
  )
    throw new Error("Bounded install timeout required");
  // Capture data before asynchronous work; a caller cannot swap args/environment.
  const launch = parseProcessLaunch({
    executable: input.executable,
    cwd: input.authority.owner,
    args,
    env: input.env,
  });
  const authority = input.authority;
  const signal = input.signal;
  const deadline = performance.now() + input.timeoutMs;
  if (signal?.aborted) return Object.freeze({ kind: "cancelled" as const });
  const toolchain = await inspectBunToolchain({
    ...launch,
    packageManager: authority.packageManager,
  });
  if (toolchain.kind !== "toolchain-observed") return toolchain;
  if (!(await verifyInstallAuthority(authority)))
    return Object.freeze({ kind: "authority-changed" as const });
  if (signal?.aborted) return Object.freeze({ kind: "cancelled" as const });
  if (performance.now() >= deadline)
    return Object.freeze({ kind: "timed-out" as const });
  const handle = await startGuardedProcess(launch, input.platformExecutable);
  let outcome: Outcome = { kind: "launch-failed" };
  try {
    if ((await handle.started).kind === "started") {
      for (;;) {
        if (signal?.aborted) {
          outcome = { kind: "cancelled" };
          break;
        }
        if (performance.now() >= deadline) {
          outcome = { kind: "timed-out" };
          break;
        }
        if (!(await verifyInstallAuthority(authority))) {
          outcome = { kind: "authority-changed" };
          break;
        }
        const state = handle.inspect();
        if (state.appExitCode !== null) {
          outcome = { kind: "process-exited", code: state.appExitCode };
          break;
        }
        if (state.guardExitCode !== null) {
          outcome = { kind: "guard-lost" };
          break;
        }
        await Bun.sleep(25);
      }
    }
  } finally {
    // Even exit 0 may leave script descendants. Drain this retained process group
    // before returning; no destructive signal to an imported/stale numeric PID.
    await handle.stop();
  }
  if (!(await verifyInstallAuthority(authority)))
    outcome = { kind: "authority-changed" };
  return Object.freeze({
    ...outcome,
    cleanup: handle.inspect().stopped ? "group-stopped" : "incomplete",
    handle,
  });
}
