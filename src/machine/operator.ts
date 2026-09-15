import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { promisify } from "node:util";
import { MachineContextError } from "./context";

export function parseOperatorRecord(output: string, uid: number) {
  const lines = output.trimEnd().split("\n");
  const fields = lines[0]?.split(":");
  if (
    !Number.isSafeInteger(uid) ||
    uid <= 0 ||
    lines.length !== 1 ||
    fields?.length !== 7 ||
    !/^[a-z][a-z0-9-]{0,31}$/.test(fields[0] ?? "") ||
    fields[2] !== String(uid) ||
    !/^\/home\/[a-z][a-z0-9-]{0,31}$/.test(fields[5] ?? "")
  )
    throw new MachineContextError("machine-operator-unavailable");
  return Object.freeze({
    platform: "linux",
    uid,
    username: fields[0] as string,
    homedir: fields[5] as string,
  });
}

// Bun 1.4.2 userInfo() can derive username/home from ambient environment.
// Resolve the actual effective UID through Linux NSS, with no shell, caller PATH
// or user-controlled options. Ubuntu supplies getent as part of its base system.
export async function readLinuxOperator() {
  if (process.platform !== "linux")
    throw new MachineContextError("machine-platform-unsupported");
  const uid = process.getuid?.();
  if (uid === 0 || uid !== process.geteuid?.())
    throw new MachineContextError("machine-operator-mismatch");
  if (uid === undefined)
    throw new MachineContextError("machine-operator-unavailable");
  try {
    for (const path of ["/usr", "/usr/bin", "/usr/bin/getent"]) {
      const stat = await lstat(path);
      if (
        (await realpath(path)) !== path ||
        stat.uid !== 0 ||
        (stat.mode & 0o022) !== 0 ||
        (path === "/usr/bin/getent" ? !stat.isFile() : !stat.isDirectory())
      )
        throw new Error("Unsafe system account resolver");
    }
    const { stdout } = await promisify(execFile)(
      "/usr/bin/getent",
      ["passwd", String(uid)],
      {
        env: { PATH: "/usr/bin:/bin", LANG: "C" },
        cwd: "/",
        timeout: 5000,
        maxBuffer: 16384,
        encoding: "utf8",
      },
    );
    return parseOperatorRecord(stdout, uid);
  } catch {
    throw new MachineContextError("machine-operator-unavailable");
  }
}
