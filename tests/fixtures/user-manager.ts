import type { ProcessRunner } from "../../src/update/self-check";

/** The person's runtime directory, as a user service has it. */
export const userRuntime = { XDG_RUNTIME_DIR: "/run/user/1000" } as const;

/** A stand-in of systemd that, like `systemctl --user`, reaches the person's
 * user manager only with the environment it needs: without
 * `XDG_RUNTIME_DIR` (or `DBUS_SESSION_BUS_ADDRESS`) systemctl fails ("Failed
 * to connect to bus") and prints nothing on standard output. The process
 * runner passes a child nothing it is not given, so a call that forgets the
 * environment reads nothing, as on a real Environment. */
export const userManager =
  (systemd: ProcessRunner): ProcessRunner =>
  async (command, timeoutMs, env) =>
    command[0] === "systemctl" &&
    env?.XDG_RUNTIME_DIR === undefined &&
    env?.DBUS_SESSION_BUS_ADDRESS === undefined
      ? { exitCode: 1, stdout: "", stderr: "" }
      : systemd(command, timeoutMs, env);
