import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTool, type ToolRunner } from "../../src/tools/status";

// A fake `ssh` for the route tries (decision F70's addendum): `ssh -G <id>`
// is answered by the real OpenSSH over the account's own config in a test
// home, and the connection itself is recorded, never made. OpenSSH expands
// `~` from the account database, not from `HOME`, so the config and every
// file it includes are copied with `~/` replaced by the test home first.

export type RouteTry = Readonly<{
  environment: string;
  command: readonly string[];
  /** The pinned keys the try was given, read while it ran. */
  knownHosts: string;
}>;

async function resolve(home: string, environment: string) {
  const directory = await mkdtemp(join(tmpdir(), "lazurio-ssh-g-"));
  let copies = 0;
  const copy = async (path: string, to: string): Promise<boolean> => {
    const text = await readFile(path, "utf8").catch(() => null);
    if (text === null) return false;
    const lines: string[] = [];
    for (const line of text.replaceAll("~/", `${home}/`).split("\n")) {
      const include = /^\s*Include\s+(\S+)\s*$/i.exec(line);
      if (include === null) {
        lines.push(line);
        continue;
      }
      copies += 1;
      const included = join(directory, `included-${copies}`);
      if (await copy(include[1] as string, included))
        lines.push(`Include ${included}`);
    }
    await writeFile(to, lines.join("\n"));
    return true;
  };
  try {
    const config = join(directory, "config");
    if (!(await copy(join(home, ".ssh", "config"), config)))
      await writeFile(config, "");
    return await runTool(["ssh", "-F", config, "-G", environment], 5_000, {
      PATH: process.env.PATH ?? "",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** `answers` by Environment id (default: reached); `beforeResolve` and
 * `afterResolve` run around `ssh -G`, to change the files in between. */
export function routeSsh(
  home: string,
  options: Readonly<{
    answers?: Record<string, Awaited<ReturnType<ToolRunner>>>;
    beforeResolve?: (environment: string) => Promise<void>;
    afterResolve?: (environment: string) => Promise<void>;
    other?: ToolRunner;
  }> = {},
) {
  const tries: RouteTry[] = [];
  const resolved: string[] = [];
  const run: ToolRunner = async (command, timeoutMs, env, extra) => {
    if (command[0] !== "ssh") {
      if (options.other === undefined)
        throw new Error(`Unexpected command ${command[0]}`);
      return options.other(command, timeoutMs, env, extra);
    }
    if (command[1] === "-G") {
      const environment = command[2] as string;
      resolved.push(environment);
      await options.beforeResolve?.(environment);
      const answer = await resolve(home, environment);
      await options.afterResolve?.(environment);
      return answer;
    }
    const environment = command.at(-2) as string;
    const file = command
      .find((part) => part.startsWith("UserKnownHostsFile="))
      ?.slice("UserKnownHostsFile=".length);
    tries.push({
      environment,
      command,
      knownHosts:
        file === undefined ? "" : await readFile(file, "utf8").catch(() => ""),
    });
    return (
      options.answers?.[environment] ?? { exitCode: 0, stdout: "", stderr: "" }
    );
  };
  return {
    run,
    resolved,
    tries,
    /** The Environment ids actually connected to, in order. */
    get tried() {
      return tries.map((entry) => entry.environment);
    },
  };
}
