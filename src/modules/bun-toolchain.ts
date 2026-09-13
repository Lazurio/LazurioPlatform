import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { inspectOwnedDirectory } from "../folder/owned-directory";
import { parseProcessLaunch } from "./process-launch";

const execute = promisify(execFile);

// Explicit trusted executable selection, not PATH discovery or publisher proof.
// A program can lie about its version; its provenance remains the tool owner’s duty.
export async function inspectBunToolchain(input: {
  executable: string;
  cwd: string;
  env: Record<string, string>;
  packageManager: string;
}) {
  if (
    !/^bun@\d+\.\d+\.\d+$/.test(input.packageManager) ||
    /[\r\n]/.test(input.packageManager)
  )
    throw new Error("Exact Bun version required");
  const launch = parseProcessLaunch({
    executable: input.executable,
    cwd: input.cwd,
    env: input.env,
    args: ["--version"],
  });
  try {
    await inspectOwnedDirectory(launch.cwd);
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
    if (`bun@${version}` !== input.packageManager)
      return Object.freeze({
        kind: "toolchain-mismatch" as const,
        expected: input.packageManager,
        actual: `bun@${version}`,
      });
    return Object.freeze({
      kind: "toolchain-observed" as const,
      executable: launch.executable,
      packageManager: input.packageManager,
    });
  } catch {
    // Do not expose environment or executable stderr as a user-facing diagnosis.
    return Object.freeze({ kind: "toolchain-unavailable" as const });
  }
}
