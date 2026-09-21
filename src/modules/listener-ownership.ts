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

export async function observeListenerBindings(
  port: number,
): Promise<Observation> {
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error("Declared port required");
  const executable =
    process.platform === "darwin"
      ? "/usr/sbin/lsof"
      : process.platform === "linux"
        ? "/usr/bin/lsof"
        : null;
  if (!executable) return Object.freeze({ kind: "unavailable" });
  try {
    const { stdout, stderr } = await run(
      executable,
      ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpgufn"],
      {
        env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LC_ALL: "C" },
        timeout: 5000,
        killSignal: "SIGKILL",
        maxBuffer: 64 * 1024,
      },
    );
    if (stderr.trim()) return Object.freeze({ kind: "unavailable" });
    return Object.freeze({
      kind: "observed",
      bindings: parseListenerBindings(stdout, port),
    });
  } catch (error) {
    const result = error as {
      code?: unknown;
      stdout?: unknown;
      stderr?: unknown;
      killed?: unknown;
    };
    // lsof's no-match exit is not proof that a port is globally free: process
    // visibility can be restricted. Never use this result as a bind reservation.
    if (
      result.code === 1 &&
      !result.killed &&
      result.stdout === "" &&
      result.stderr === ""
    )
      return Object.freeze({ kind: "observed", bindings: Object.freeze([]) });
    return Object.freeze({ kind: "unavailable" });
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
