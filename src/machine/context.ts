import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { dirname } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import { readCustodiedDeclarationBytes } from "../providers/owned-json";
import { parseUniqueJson } from "../providers/unique-json";
import schema from "./lazurio-machine.v1.schema.json";

// Types describe the upstream wire contract; only the exact vendored schema
// validates it. No coercion, defaults, reference downloads or extra properties.
export type MachineContext = Readonly<{
  schema_version: "lazurio.machine.v1";
  machine: Readonly<{
    id: string;
    kind: "workspace-vm";
    name: string;
    vmid: number;
  }>;
  owner: Readonly<{
    kind: "organization";
    organization: string;
    organization_key?: string;
    team?: string;
  }>;
  operator: Readonly<{ os_user: string; home: string; lazurio_root: string }>;
  host: Readonly<{
    kind: "virtualization-host";
    machine_id: string;
    custody_repository: string;
    provider: string;
  }>;
  network?: Readonly<{
    headscale_server_url: string;
    headscale_hostname: string;
  }>;
  installed: Readonly<{
    machines_release: Readonly<{
      repository: string;
      version: string;
      commit: string;
    }>;
    deployment_head: string;
    recorded_at: string;
  }>;
  account: null;
}>;

const validate = new Ajv2020({ strict: true }).compile<MachineContext>(schema);
export const machineContextPath = "/etc/lazurio/lazurio.machine.json";

export class MachineContextError extends Error {
  constructor(
    public readonly code:
      | "machine-context-missing"
      | "machine-context-invalid"
      | "machine-context-custody"
      | "machine-platform-unsupported"
      | "machine-operator-mismatch",
  ) {
    super(code);
  }
}

function freeze(value: unknown): void {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
}

export function parseMachineContext(bytes: Uint8Array): MachineContext {
  try {
    if (bytes.byteLength > 1024 * 1024) throw new Error("Oversized context");
    const input: unknown = parseUniqueJson(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
    );
    if (!validate(input)) throw new Error("Schema mismatch");
    freeze(input);
    return input;
  } catch {
    // Never include private declarations, paths or validator input in diagnostics.
    throw new MachineContextError("machine-context-invalid");
  }
}

// Read-only. A root-issued identity is descriptive context, never an access grant.
// The production location/custodian cannot be overridden through CLI/env flags.
export async function readMachineContext() {
  if (process.platform !== "linux")
    throw new MachineContextError("machine-platform-unsupported");
  let bytes: Buffer;
  try {
    for (let path = dirname(machineContextPath); ; path = dirname(path)) {
      const stat = await lstat(path);
      if (
        !stat.isDirectory() ||
        stat.uid !== 0 ||
        (stat.mode & 0o022) !== 0 ||
        (await realpath(path)) !== path
      )
        throw new Error("Unsafe Machine context parent");
      if (path === "/") break;
    }
    bytes = await readCustodiedDeclarationBytes(machineContextPath, 0);
  } catch (error) {
    throw new MachineContextError(
      (error as NodeJS.ErrnoException).code === "ENOENT"
        ? "machine-context-missing"
        : "machine-context-custody",
    );
  }
  return Object.freeze({
    context: parseMachineContext(bytes),
    digest: createHash("sha256").update(bytes).digest("hex"),
  });
}

// Pure binding check, also used with synthetic runtime evidence in tests.
// Production evidence comes from os.userInfo(), never HOME/USER environment vars.
export function bindMachineOperator(
  context: MachineContext,
  runtime: { platform: string; uid: number; username: string; homedir: string },
): string {
  const operator = context.operator;
  if (runtime.platform !== "linux")
    throw new MachineContextError("machine-platform-unsupported");
  if (
    runtime.uid <= 0 ||
    runtime.username !== operator.os_user ||
    runtime.homedir !== operator.home ||
    operator.home !== `/home/${operator.os_user}` ||
    operator.lazurio_root !== `${operator.home}/Lazurio`
  )
    throw new MachineContextError("machine-operator-mismatch");
  return operator.lazurio_root;
}
