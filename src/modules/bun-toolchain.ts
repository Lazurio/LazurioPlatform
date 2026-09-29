import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { inspectCheckoutDirectory } from "../folder/owned-directory";
import { PreparationRefused } from "./preparation-refusal";
import { parseProcessLaunch } from "./process-launch";

const execute = promisify(execFile);

// Explicit trusted executable selection, not PATH discovery or publisher proof.
// A program can lie about its version; its provenance remains the tool owner’s duty.
// `packageManager` is the exact Bun the package pins, or null when it pins
// none: then the selected Bun is observed, whichever version it reports
// (decision F25).
export async function inspectBunToolchain(input: {
  executable: string;
  cwd: string;
  env: Record<string, string>;
  packageManager: string | null;
}) {
  if (
    input.packageManager !== null &&
    (!/^bun@\d+\.\d+\.\d+$/.test(input.packageManager) ||
      /[\r\n]/.test(input.packageManager))
  )
    throw new Error("Exact Bun version required");
  const launch = parseProcessLaunch({
    executable: input.executable,
    cwd: input.cwd,
    env: input.env,
    args: ["--version"],
  });
  try {
    await inspectCheckoutDirectory(launch.cwd);
    const { stdout, stderr } = await execute(
      launch.executable,
      [...launch.args],
      {
        cwd: launch.cwd,
        env: launch.env,
        encoding: "utf8",
        timeout: 5000,
        maxBuffer: 4096,
        killSignal: "SIGKILL",
        windowsHide: true,
      },
    );
    const version = stdout.replace(/\r?\n$/, "");
    if (
      stderr.length ||
      !/^\d+\.\d+\.\d+$/.test(version) ||
      /[\r\n]/.test(version)
    )
      return Object.freeze({ kind: "toolchain-unavailable" as const });
    const actual = `bun@${version}`;
    if (input.packageManager !== null && actual !== input.packageManager)
      return Object.freeze({
        kind: "toolchain-mismatch" as const,
        expected: input.packageManager,
        actual,
      });
    return Object.freeze({
      kind: "toolchain-observed" as const,
      executable: launch.executable,
      packageManager: actual,
    });
  } catch {
    // Do not expose environment or executable stderr as a user-facing diagnosis.
    return Object.freeze({ kind: "toolchain-unavailable" as const });
  }
}

/** The observed toolchain, or the refusal of the start: a pinned Bun the
 * selected one is not is `preparation-toolchain-mismatch`, named by the
 * owner's package.json (decision F25); an unavailable one stays untyped. */
export function requireBunToolchain(
  observed: Awaited<ReturnType<typeof inspectBunToolchain>>,
  owner: string,
) {
  if (observed.kind === "toolchain-mismatch")
    throw new PreparationRefused(
      "preparation-toolchain-mismatch",
      join(owner, "package.json"),
      "Required Bun toolchain unavailable",
    );
  if (observed.kind !== "toolchain-observed")
    throw new Error("Required Bun toolchain unavailable");
  return observed;
}
