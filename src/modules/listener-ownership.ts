import { execFile } from "node:child_process";
import { isIP } from "node:net";
import { promisify } from "node:util";

type Binding = Readonly<{
  pid: number;
  group: number;
  uid: number;
  fd: number;
  host: string;
  port: number;
}>;
type Observation = Readonly<
  { kind: "observed"; bindings: readonly Binding[] } | { kind: "unavailable" }
>;
const run = promisify(execFile);

function integer(value: string, minimum = 0) {
  if (
    !/^\d+$/.test(value) ||
    !Number.isSafeInteger(Number(value)) ||
    Number(value) < minimum
  )
    throw new Error("Malformed listener evidence");
  return Number(value);
}

// Decode only the requested lsof -Fpgufn fields; unexpected/incomplete output
// cannot become positive ownership evidence. No command names or cwd are read.
export function parseListenerBindings(
  output: string,
  port: number,
): readonly Binding[] {
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error("Declared port required");
  const bindings: Binding[] = [];
  let pid: number | undefined;
  let group: number | undefined;
  let uid: number | undefined;
  let fd: number | undefined;
  let named = true;
  let processBindings = 0;
  for (const line of output.split("\n")) {
    if (!line) continue;
    const value = line.slice(1);
    switch (line[0]) {
      case "p":
        if (!named) throw new Error("Incomplete listener evidence");
        if (pid !== undefined && processBindings === 0)
          throw new Error("Incomplete process evidence");
        processBindings = 0;
        pid = integer(value, 1);
        group = undefined;
        uid = undefined;
        fd = undefined;
        break;
      case "g":
        if (pid === undefined || group !== undefined || fd !== undefined)
          throw new Error("Unexpected process group");
        group = integer(value, 1);
        break;
      case "u":
        if (pid === undefined || uid !== undefined || fd !== undefined)
          throw new Error("Unexpected process user");
        uid = integer(value);
        break;
      case "f":
        if (
          !named ||
          pid === undefined ||
          group === undefined ||
          uid === undefined
        )
          throw new Error("Incomplete process evidence");
        fd = integer(value);
        named = false;
        break;
      case "n": {
        if (
          named ||
          fd === undefined ||
          pid === undefined ||
          group === undefined ||
          uid === undefined
        )
          throw new Error("Unexpected binding");
        const split = value.lastIndexOf(":");
        const rawHost = value.slice(0, split);
        const host =
          rawHost.startsWith("[") && rawHost.endsWith("]")
            ? rawHost.slice(1, -1)
            : rawHost;
        if (
          split < 1 ||
          integer(value.slice(split + 1), 1) !== port ||
          (host !== "*" && !isIP(host))
        )
          throw new Error("Unexpected listener address");
        bindings.push(Object.freeze({ pid, group, uid, fd, host, port }));
        named = true;
        processBindings++;
        break;
      }
      default:
        throw new Error("Unsupported listener evidence field");
    }
  }
  if (!named || (pid !== undefined && processBindings === 0))
    throw new Error("Incomplete listener evidence");
  return Object.freeze(bindings);
}

// lsof of the TCP sockets of one declared port, the one tool of both
// runners' evidence (macOS and Linux).
function lsof(port: number, args: readonly string[]) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error("Declared port required");
  const executable =
    process.platform === "darwin"
      ? "/usr/sbin/lsof"
      : process.platform === "linux"
        ? "/usr/bin/lsof"
        : null;
  if (!executable) return null;
  return run(executable, ["-nP", `-iTCP:${port}`, ...args], {
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LC_ALL: "C" },
    timeout: 5000,
    killSignal: "SIGKILL",
    maxBuffer: 64 * 1024,
  });
}

// lsof's exit when nothing matched: 1, and no output.
function nothingMatched(error: unknown) {
  const result = error as {
    code?: unknown;
    stdout?: unknown;
    stderr?: unknown;
    killed?: unknown;
  };
  return (
    result.code === 1 &&
    !result.killed &&
    result.stdout === "" &&
    result.stderr === ""
  );
}

export async function observeListenerBindings(
  port: number,
): Promise<Observation> {
  const running = lsof(port, ["-sTCP:LISTEN", "-Fpgufn"]);
  if (!running) return Object.freeze({ kind: "unavailable" });
  try {
    const { stdout, stderr } = await running;
    if (stderr.trim()) return Object.freeze({ kind: "unavailable" });
    return Object.freeze({
      kind: "observed",
      bindings: parseListenerBindings(stdout, port),
    });
  } catch (error) {
    // lsof's no-match exit is not proof that a port is globally free: process
    // visibility can be restricted. Never use this result as a bind reservation.
    if (nothingMatched(error))
      return Object.freeze({ kind: "observed", bindings: Object.freeze([]) });
    return Object.freeze({ kind: "unavailable" });
  }
}

/** Whether a TCP connection with this port at one end is open now: the
 * sign that someone uses a module app (root decision 0195 point 23). The
 * same lsof as the listener's evidence, so the operator's own processes,
 * among them the app's end of every connection to its listener. Null when
 * it cannot be told, which never counts as unused. */
export async function observeConnected(port: number): Promise<boolean | null> {
  const running = lsof(port, ["-sTCP:ESTABLISHED", "-t"]);
  if (!running) return null;
  try {
    const { stdout, stderr } = await running;
    return stderr.trim() ? null : stdout.trim() !== "";
  } catch (error) {
    return nothingMatched(error) ? false : null;
  }
}

// Shared comparison: every observed binding of the port must be the declared
// loopback address AND belong to the live owner. Wildcards are never equivalent.
// `owned` is the owner-specific evidence (process group or control group).
export function compareListenerOwner(
  observation: Observation,
  host: string,
  port: number,
  owned: (binding: Binding) => boolean,
) {
  if (
    !["127.0.0.1", "::1", "localhost"].includes(host) ||
    !Number.isInteger(port) ||
    port < 1024 ||
    port > 65535
  )
    throw new Error("Explicit declared listener required");
  if (observation.kind !== "observed") return "unavailable" as const;
  if (!observation.bindings.length) return "not-observed" as const;
  if (
    observation.bindings.some(
      (item) =>
        item.port !== port ||
        !(
          item.host === host ||
          (host === "localhost" && ["127.0.0.1", "::1"].includes(item.host))
        ),
    )
  )
    return "binding-mismatch" as const;
  if (observation.bindings.some((item) => !owned(item)))
    return "foreign-owner" as const;
  return "matches-owner" as const;
}

export function compareListenerGroup(
  observation: Observation,
  host: string,
  port: number,
  expectedGroup: number,
) {
  if (!Number.isSafeInteger(expectedGroup) || expectedGroup <= 1)
    throw new Error("Explicit declared listener and process group required");
  const result = compareListenerOwner(
    observation,
    host,
    port,
    (item) => item.group === expectedGroup,
  );
  if (result === "foreign-owner") return "foreign-group" as const;
  if (result === "matches-owner") return "matches-process-group" as const;
  return result;
}
