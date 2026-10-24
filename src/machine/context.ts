import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import { readCustodiedDeclarationBytes } from "../providers/owned-json";
import { parseUniqueJson } from "../providers/unique-json";
import schema from "./lazurio-machine.v1.schema.json";

// Types describe the upstream wire contract; only the exact vendored schema
// validates it. No coercion, defaults, reference downloads or extra properties.
// Exactly one branch applies, distinguished by machine.kind: an Organization
// workspace VM on a virtualization host, or the one hosted personal VM of a
// person on a provider estate. Owner and host kinds never mix across branches.
type MachineOperator = Readonly<{
  os_user: string;
  home: string;
  lazurio_root: string;
}>;
type MachineNetwork = Readonly<{
  headscale_server_url: string;
  headscale_hostname: string;
}>;
// Zones of upstream decision 0155. Peers are names only, as Machines derives
// them from the home Conglomerate Host grants; nothing here is a grant either.
export type MachineZone = "personal" | "work";
export type MachinePeer = Readonly<{
  name: string;
  kind: "personal-vm" | "workspace-vm" | "client-device" | "conglomerate-host";
  zone: MachineZone | null;
  organization: string | null;
  ssh: Readonly<{
    host: string;
    user: string | null;
    direction: "outbound" | "inbound" | "both";
  }> | null;
  https: readonly string[];
}>;
export type MachineRelationships<Zone extends MachineZone = MachineZone> =
  Readonly<{ zone: Zone; peers: readonly MachinePeer[] }>;
// Authored per guest in the owner Deployment Repo and copied by Machines, never
// inferred. Only the Organization branch carries it. `automation` (Machines
// #277, decision 0169) names the responsible operator of an Automated
// Environment with the operator's shape, never the persona. `services` (root
// decision 0209, Machines docs/server-services.md §2) is the services
// Environment of a Proxmox server, "Služby serveru": a work Environment of the
// Organization that only its Owners and Admins enter; like `team` it names
// nobody.
export type OrganizationAssignment =
  | Readonly<{
      kind: "operator" | "automation";
      github_login: string;
      github_id: number;
    }>
  | Readonly<{ kind: "team" | "services" }>;
// The services of a services Environment (root decision 0209, Machines
// docs/server-services.md §2.1): each one's id and kind, its one
// productionspace repository and the loopback port of its page. Only the
// Organization branch carries it, and Machines writes it together with the
// `services` assignment. The handover is read with it exactly as written.
// The catalog reads it, only where the assignment is `services`
// (`serverServicesOf` in src/organizations/catalog.ts): Productionspace
// lists the services that name a repository, and a service's page opens on
// this Environment's loopback in its Environment browser (decision F32's
// addendum of 2026-10-24). The page's path is not here: the Platform knows
// it per kind (src/organizations/server-services.ts).
export type MachineService = Readonly<{
  id: string;
  kind:
    | "ai-pool"
    | "ai-gateway"
    | "http"
    | "diagnostics"
    | "public-entry"
    | "dns01";
  repository?: string;
  page_port?: number;
}>;
// How the Machine is entered through its workspace gateway, rendered by
// Machines from the same route catalog as the gateway (Machines 0.12.93).
// Optional and closed on both branches; finished values, never a convention.
// `mausbot` (DEV-6632) is present only on a Machine that runs Lazurio MausBot;
// `browser` (root decision 0191, F38) only where the gateway routes the view
// of the Environment browser; `environment_relay` (root decision 0194, DEV-6653
// contract C3, Machines #449) only on an Organization work VM that declares its
// own identity at the Lazurio issuer: the unix socket on which the Launchpad
// asks the Dashboard as this Environment. `sign_out` (Machines#358, F36's
// addendum of 2026-10-16) only behind the Platform Launchpad: the path of the
// person's sign-out, which the gateway serves on the shell's origins.
// `audience` (root decision 0204, Machines #560, decision F55) only on a work
// VM whose gateway admits any Lazurio account: its Environment is public.
// `browser.local_port` (LazurioPlatform#504, F39's addendum of 2026-10-18)
// only where the gateway runs its loopback entry for the Environment browser,
// which serves the Environment's own apps without a sign-in. `buddy` (root
// decision 0210, Machines #811, F61's addendum of 2026-10-22) only on a
// personal VM that declares Buddy: the origin and loopback port of his own T3
// Code, of the same base host as the Launchpad's origin; the work branch of
// the schema forbids it.
export type MachineEntry = Readonly<{
  launchpad: Readonly<{
    external_origin: string;
    auth_check_url: string;
    auth_cookie_name: string;
    listen_port: number;
  }>;
  t3code: Readonly<{ external_origin: string }>;
  modules: Readonly<{ origin_template: string }>;
  mausbot?: Readonly<{ external_origin: string; listen_port: number }>;
  browser?: Readonly<{
    external_origin: string;
    listen_port: number;
    local_port?: number;
  }>;
  environment_relay?: Readonly<{ socket: string }>;
  sign_out?: Readonly<{ path: string }>;
  audience?: "public";
  buddy?: Readonly<{ external_origin: string; listen_port: number }>;
}>;
// This Environment's own vault (root decision 0198 point 1, DEV-6631 contract
// C2): the network's Lazurio Vaultwarden, the technical account the network
// generated and pre-allowed for this Environment alone, and the vault's name.
// Optional and closed on both branches: Machines writes it only for a
// Platform release that reads it, because a reader vendoring an earlier
// schema refuses the whole document (as for `entry` and its members).
export type MachineVault = Readonly<{
  server_url: string;
  account: string;
  name: string;
}>;
type MachineInstalled = Readonly<{
  machines_release: Readonly<{
    repository: string;
    version: string;
    commit: string;
  }>;
  deployment_head: string;
  recorded_at: string;
}>;
export type OrganizationWorkspaceContext = Readonly<{
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
    assignment?: OrganizationAssignment;
  }>;
  operator: MachineOperator;
  host: Readonly<{
    kind: "virtualization-host";
    machine_id: string;
    custody_repository: string;
    provider: string;
  }>;
  network?: MachineNetwork;
  relationships?: MachineRelationships<"work">;
  entry?: MachineEntry;
  vault?: MachineVault;
  services?: readonly MachineService[];
  installed: MachineInstalled;
  account: null;
}>;
export type PersonalMachineContext = Readonly<{
  schema_version: "lazurio.machine.v1";
  machine: Readonly<{
    id: string;
    kind: "personal-vm";
    name: string;
    vmid: number;
  }>;
  owner: Readonly<{
    kind: "principal";
    github_login: string;
    github_id: number;
  }>;
  operator: MachineOperator;
  host: Readonly<{
    kind: "provider-estate";
    estate_id: string;
    custody_repository: string;
    record_path: string;
  }>;
  network: MachineNetwork;
  relationships?: MachineRelationships<"personal">;
  entry?: MachineEntry;
  vault?: MachineVault;
  installed: MachineInstalled;
  account: null;
}>;
export type MachineContext =
  | OrganizationWorkspaceContext
  | PersonalMachineContext;

const validate = new Ajv2020({ strict: true }).compile<MachineContext>(schema);
export const machineContextPath = "/etc/lazurio/lazurio.machine.json";

export class MachineContextError extends Error {
  constructor(
    public readonly code:
      | "machine-context-missing"
      | "machine-context-invalid"
      | "machine-context-custody"
      | "machine-platform-unsupported"
      | "machine-operator-mismatch"
      | "machine-operator-unavailable",
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

/** Where the handover is read: the platform, the filesystem root the fixed
 * path lies under and the account that must own it and every parent up to
 * that root. Production is Linux, `/` and root; a test names a private
 * directory it owns instead, so the same custody checks, parser and schema
 * read real files there. A parameter only: no CLI flag or environment
 * variable reaches it. */
export type MachineContextSource = Readonly<{
  platform: string;
  root: string;
  custodian: number;
}>;
export const productionMachineContextSource: MachineContextSource =
  Object.freeze({ platform: process.platform, root: "/", custodian: 0 });

// Read-only. A root-issued identity is descriptive context, never an access grant.
// The production location/custodian cannot be overridden through CLI/env flags.
export async function readMachineContext(
  source: MachineContextSource = productionMachineContextSource,
) {
  if (source.platform !== "linux")
    throw new MachineContextError("machine-platform-unsupported");
  const file = join(source.root, machineContextPath);
  let bytes: Buffer;
  try {
    for (let path = dirname(file); ; path = dirname(path)) {
      const stat = await lstat(path);
      if (
        !stat.isDirectory() ||
        stat.uid !== source.custodian ||
        (stat.mode & 0o022) !== 0 ||
        (await realpath(path)) !== path
      )
        throw new Error("Unsafe Machine context parent");
      if (path === source.root || path === dirname(path)) break;
    }
    bytes = await readCustodiedDeclarationBytes(file, source.custodian);
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
// Production evidence comes from the UID's system record, never HOME/USER vars.
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
