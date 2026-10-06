import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  bindMachineOperator,
  MachineContextError,
  type MachineContextSource,
  productionMachineContextSource,
  readMachineContext,
} from "./context";

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

/** What the hosted context of this process is, in three kinds that are never
 * collapsed into one another (issue #83):
 * - `absent`: positively no hosted Folder of this account — not Linux, no
 *   handover at all, or a valid handover whose declared operator is another
 *   account (or root);
 * - `hosted`: this process is the declared operator of a readable, valid
 *   handover; `folder` is its declared Folder (not yet read);
 * - `unreadable`: a handover is there but cannot be trusted or read (unsafe
 *   custody, a permission error, malformed JSON, a schema mismatch), or the
 *   account's own system record cannot be resolved to tell whether it is the
 *   operator. Never a workstation. */
export type HostedOperatorContext =
  | Readonly<{
      kind: "absent";
      reason:
        | "machine-platform-unsupported"
        | "machine-context-missing"
        | "machine-operator-mismatch";
    }>
  | Readonly<{ kind: "hosted"; folder: string }>
  | Readonly<{
      kind: "unreadable";
      reason:
        | "machine-context-invalid"
        | "machine-context-custody"
        | "machine-operator-unavailable";
    }>;

type OperatorRecord = Awaited<ReturnType<typeof readLinuxOperator>>;

/** Where the discovery reads: the handover's source and the account's
 * system record. Production reads `/etc/lazurio` as root custody and the
 * effective UID through getent; a test names a private root and a record. */
export type HostedOperatorSources = Readonly<{
  handover: MachineContextSource;
  operator: () => Promise<OperatorRecord>;
}>;
const productionSources: HostedOperatorSources = Object.freeze({
  handover: productionMachineContextSource,
  operator: readLinuxOperator,
});

// The Folder of a hosted Machine, when this process is its declared operator:
// what `lazurio update` and `update status` report a needed refresh against
// (decision F17 addendum 2026-09-28) and whose preset decides the Team rule of
// gh. Read-only.
export async function discoverHostedOperator(
  sources: HostedOperatorSources = productionSources,
): Promise<HostedOperatorContext> {
  const unreadable = (
    reason: Extract<HostedOperatorContext, { kind: "unreadable" }>["reason"],
  ) => Object.freeze({ kind: "unreadable" as const, reason });
  const absent = (
    reason: Extract<HostedOperatorContext, { kind: "absent" }>["reason"],
  ) => Object.freeze({ kind: "absent" as const, reason });
  const code = (error: unknown) =>
    error instanceof MachineContextError ? error.code : undefined;
  let context: Awaited<ReturnType<typeof readMachineContext>>["context"];
  try {
    ({ context } = await readMachineContext(sources.handover));
  } catch (error) {
    const reason = code(error);
    if (
      reason === "machine-platform-unsupported" ||
      reason === "machine-context-missing"
    )
      return absent(reason);
    return unreadable(
      reason === "machine-context-invalid"
        ? "machine-context-invalid"
        : "machine-context-custody",
    );
  }
  // A handover whose operator fields disagree with each other is invalid, not
  // another account's: `bindMachineOperator` reports both as a mismatch.
  const declared = context.operator;
  if (
    declared.home !== `/home/${declared.os_user}` ||
    declared.lazurio_root !== `${declared.home}/Lazurio`
  )
    return unreadable("machine-context-invalid");
  let operator: OperatorRecord;
  try {
    operator = await sources.operator();
  } catch (error) {
    // Root, or a real UID that differs from the effective one, is not the
    // declared operator; any other failure leaves it unknown.
    return code(error) === "machine-operator-mismatch"
      ? absent("machine-operator-mismatch")
      : unreadable("machine-operator-unavailable");
  }
  try {
    return Object.freeze({
      kind: "hosted" as const,
      folder: join(
        sources.handover.root,
        bindMachineOperator(context, operator),
      ),
    });
  } catch (error) {
    return code(error) === "machine-operator-mismatch"
      ? absent("machine-operator-mismatch")
      : unreadable("machine-operator-unavailable");
  }
}

/** The hosted operator Folder as the commands' `hostedFolder` seam takes it:
 * the Folder when this process is the declared operator, undefined when
 * there is positively none, and a rejection with the typed
 * `MachineContextError` when a hosted context is there but unreadable, so no
 * caller can take it for a workstation without handling it. */
export async function hostedOperatorFolder(
  sources: HostedOperatorSources = productionSources,
): Promise<string | undefined> {
  const found = await discoverHostedOperator(sources);
  if (found.kind === "unreadable") throw new MachineContextError(found.reason);
  return found.kind === "hosted" ? found.folder : undefined;
}
