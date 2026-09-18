import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";
import { inspectOwnedDirectory } from "../folder/owned-directory";

const run = promisify(execFile);
export function githubRemoteCoordinate(input: string): string | null {
  // Never accept embedded HTTPS credentials, overrides, query strings or local
  // transports. Return only a coordinate, never the raw (possibly secret) URL.
  const match =
    /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9_.-]+)$/.exec(
      input,
    );
  if (!match || match[0] !== input) return null;
  const name = (match[2] as string).replace(/\.git$/, "");
  if (!name || name === "." || name === "..") return null;
  return `${match[1]}/${name}`;
}

// Read-only POSIX development adapter. A matching remote is local configuration,
// not proof of remote rights, repository contents, or a trustworthy working tree.
export async function inspectGitCheckout(
  directory: string,
  executable: string,
) {
  if (
    !["darwin", "linux"].includes(process.platform) ||
    !isAbsolute(executable) ||
    executable.includes("\0")
  )
    throw new Error("Explicit qualified Git executable required");
  try {
    const before = await inspectOwnedDirectory(directory);
    const command = async (args: string[]) => {
      const { stdout, stderr } = await run(executable, args, {
        cwd: directory,
        env: {
          PATH: "/usr/bin:/bin",
          LC_ALL: "C",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_OPTIONAL_LOCKS: "0",
          GIT_TERMINAL_PROMPT: "0",
        },
        timeout: 5000,
        killSignal: "SIGKILL",
        maxBuffer: 64 * 1024,
        encoding: "utf8",
      });
      if (stderr.trim()) throw new Error("Git inspection unavailable");
      return stdout;
    };
    const root = (await command(["rev-parse", "--show-toplevel"])).replace(
      /\n$/,
      "",
    );
    if (root !== directory)
      return Object.freeze({ kind: "not-checkout-root" as const });
    const gitDirectory = (
      await command(["rev-parse", "--absolute-git-dir"])
    ).replace(/\n$/, "");
    const commonDirectory = (
      await command(["rev-parse", "--path-format=absolute", "--git-common-dir"])
    ).replace(/\n$/, "");
    const gitBefore = await inspectOwnedDirectory(gitDirectory);
    const commonBefore = await inspectOwnedDirectory(commonDirectory);
    const readRemote = () =>
      command([
        "config",
        "--local",
        "--no-includes",
        "--null",
        "--get-all",
        "remote.origin.url",
      ]);
    const raw = await readRemote();
    // Multiple origins or embedded control bytes cannot become one identity.
    if (!raw.endsWith("\0") || raw.split("\0").length !== 2)
      return Object.freeze({ kind: "remote-unavailable" as const });
    const coordinate = githubRemoteCoordinate(raw.slice(0, -1));
    if (!coordinate)
      return Object.freeze({ kind: "remote-unavailable" as const });
    if ((await readRemote()) !== raw)
      return Object.freeze({ kind: "checkout-changed" as const });
    const after = await inspectOwnedDirectory(directory);
    const gitAfter = await inspectOwnedDirectory(gitDirectory);
    const commonAfter = await inspectOwnedDirectory(commonDirectory);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      gitBefore.dev !== gitAfter.dev ||
      gitBefore.ino !== gitAfter.ino ||
      commonBefore.dev !== commonAfter.dev ||
      commonBefore.ino !== commonAfter.ino ||
      (await command(["rev-parse", "--absolute-git-dir"])).replace(
        /\n$/,
        "",
      ) !== gitDirectory ||
      (
        await command([
          "rev-parse",
          "--path-format=absolute",
          "--git-common-dir",
        ])
      ).replace(/\n$/, "") !== commonDirectory
    )
      return Object.freeze({ kind: "checkout-changed" as const });
    return Object.freeze({
      kind: "checkout-observed" as const,
      directory,
      gitDirectory,
      commonDirectory,
      repository: coordinate,
    });
  } catch {
    return Object.freeze({ kind: "unavailable" as const });
  }
}
