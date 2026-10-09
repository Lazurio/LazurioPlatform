// Executor 1 of every Remote Environment (decision F44, root decision 0162
// addendum 2026-10-09), pinned per Platform release: not the latest release,
// because a new Executor can change its database, its service and its CLI,
// and Lazurio moves to it only after the e2e qualification. A new pin is a
// reviewed change of this file, with the integrity values read from the npm
// registry (`npm view executor@<version> --json`, `dist.integrity` of the
// package and of each platform package) and the qualification repeated.
//
// The npm package `executor` holds only a Node launcher; its optional
// dependencies `executor-<platform>` are aliases of the same package at
// `<version>-<platform>` and hold the program (a compiled Bun binary with the
// files beside it). Neither has install scripts or other dependencies. The
// platform packages declare no `libc`, so a plain `npm install` on Linux
// installs the glibc and the musl build both; Lazurio installs exactly the
// two tarballs below, verified before npm sees them.

export type ExecutorTarget = "linux-x64" | "linux-arm64";

export type ExecutorTarball = Readonly<{
  url: string;
  /** npm's `dist.integrity`: `sha512-<base64>` of the tarball. */
  integrity: string;
}>;

export type ExecutorPin = Readonly<{
  version: string;
  /** The package `executor`: the launcher and the bin entry. */
  main: ExecutorTarball;
  /** The package `executor-<target>` (`executor@<version>-<target>`). */
  platforms: Readonly<Record<ExecutorTarget, ExecutorTarball>>;
}>;

export const executorPin: ExecutorPin = Object.freeze({
  version: "1.6.10",
  main: Object.freeze({
    url: "https://registry.npmjs.org/executor/-/executor-1.6.10.tgz",
    integrity:
      "sha512-ipIuMJuuOsgWFzK/oDnABQPocPA2U0tYPagfLo+r4ZsFwfKiBYY+WCiVxwPlZcf1cWUCDg5BFH/WzOQ6jZFAqg==",
  }),
  platforms: Object.freeze({
    "linux-x64": Object.freeze({
      url: "https://registry.npmjs.org/executor/-/executor-1.6.10-linux-x64.tgz",
      integrity:
        "sha512-njvy/LzUWlVdDXuKTTGX6NCKhDpKdRjMf2T7KqumaZd2A7ZqXoIl65qeAyklFU+kkalLS6QW1Xs3lSSj+nfAPw==",
    }),
    "linux-arm64": Object.freeze({
      url: "https://registry.npmjs.org/executor/-/executor-1.6.10-linux-arm64.tgz",
      integrity:
        "sha512-SyzZsunGUhgwZoFEiWVqEIPV3h25SHKToWLrwId3p7FJqGuP/9ixMeOeXZ1CIS9j2kCws3F5iSUi3DQQ/6uxdw==",
    }),
  }),
});

/** The glibc builds of Linux only: Remote Environments are Debian or Ubuntu
 * guests. macOS follows once `executor install`'s launchd service is
 * verified (decision F44); a musl system fails the version check and keeps
 * nothing. */
export function executorTarget(
  platform: string,
  arch: string,
): ExecutorTarget | undefined {
  if (platform !== "linux") return undefined;
  if (arch !== "x64" && arch !== "arm64") return undefined;
  return `linux-${arch}`;
}

/** The loopback port of the service: Executor's default for its supervised
 * daemon (`DEFAULT_SERVICE_PORT`, `apps/cli/src/service.ts` of v1.6.10). */
export const executorPort = 4789;
export const executorAddress = `127.0.0.1:${executorPort}`;
/** The systemd user unit `executor install` writes (`SERVICE_LABEL`). */
export const executorUnit = "sh.executor.daemon.service";
/** The name of the MCP server in Codex and Claude Code. */
export const executorServerName = "executor";
