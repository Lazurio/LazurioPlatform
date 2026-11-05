import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import type { MachineAccount } from "../folder/machine-binding";
import { readCustodiedDeclarationBytes } from "../providers/owned-json";
import { parseUniqueJson } from "../providers/unique-json";
import {
  AssignmentReceiptError,
  type AuthSourcedHandover,
  isAuthSourced,
  parseAssignmentReceipt,
  resolveAssignedContext,
} from "./assignment";
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
// Zones of upstream decision 0155. Peers are names and public identity only,
// as Machines derives them from the home Conglomerate Host grants; nothing
// here is a grant either. `environment`, `access` and `ssh.host_keys` (root
// decision 0192, addendum of 2026-10-26; Machines #948) come only together,
// on a peer whose edge that addendum's rule opens rather than a reviewed
// device grant: a work VM of an Organization assigned to this personal
// Machine's owner, reached outbound over SSH under its named account, with
// its Environment id and the host keys from the Organization's records.
// Machines writes them only for a Platform that reads them; they are read
// as written, and only a personal Machine's Folder and the person's SSH
// config use them (src/ssh-access/environments.ts).
export type MachineZone = "personal" | "work";
export type MachinePeer = Readonly<{
  name: string;
  kind: "personal-vm" | "workspace-vm" | "client-device" | "conglomerate-host";
  zone: MachineZone | null;
  organization: string | null;
  environment?: string;
  access?: "assigned";
  ssh: Readonly<{
    host: string;
    user: string | null;
    direction: "outbound" | "inbound" | "both";
    host_keys?: readonly Readonly<{ type: "ssh-ed25519"; key: string }>[];
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
// `{kind: operator, account}` only as the Platform resolves a free work
// Environment's assignee from its receipt (root decision 0216): their
// Lazurio account, with a GitHub account only if one is linked (root
// decision 0192), never on the wire.
export type OrganizationAssignment =
  | Readonly<{
      kind: "operator" | "automation";
      github_login: string;
      github_id: number;
    }>
  | Readonly<{ kind: "operator"; account: MachineAccount }>
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
// A Personal Environment's own AI pool (root decision 0181, addendum of
// 2026-11-05; Machines workloads/workspace-vm/personal-ai-pool.ts): at most
// one, the fork it runs and the loopback port of its Management Center, never
// a hostname. Only the personal branch carries it, never on an auth-sourced
// handover, and Machines writes it only for a Platform that reads it. The
// catalog lists it in the Personalspace group (`serverServicesOf` in
// src/organizations/catalog.ts, decision F32's addendum of 2026-11-05).
export type PersonalMachineService = Readonly<{
  id: "ai-pool";
  kind: "ai-pool";
  repository: "Lazurio/CLIProxyAPI";
  page_port: number;
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
// Where this Environment's home Conglomerate Host runs its access service
// (root decision 0224, decision F70; HumanAndMachine-ai/Machines#1040):
// `http://<host node>.<MagicDNS domain>:8444`. Optional and closed on both
// branches, written only while that host switches the service on and for a
// Platform release that reads it.
export type MachineAccessService = Readonly<{ origin: string }>;
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
  access_service?: MachineAccessService;
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
  // `principal` as a handover declares it; `account` only as the Platform
  // resolves a free personal Environment's owner from its assignment receipt
  // (`readMachineContext`, root decision 0216): the first assignee's Lazurio
  // account, never on the wire.
  owner:
    | Readonly<{
        kind: "principal";
        github_login: string;
        github_id: number;
      }>
    | Readonly<{ kind: "account" } & MachineAccount>;
  operator: MachineOperator;
  host: Readonly<{
    kind: "provider-estate";
    estate_id: string;
    custody_repository: string;
    record_path: string;
  }>;
  network: MachineNetwork;
  relationships?: MachineRelationships<"personal">;
  access_service?: MachineAccessService;
  entry?: MachineEntry;
  vault?: MachineVault;
  services?: readonly PersonalMachineService[];
  installed: MachineInstalled;
  account: null;
}>;
export type MachineContext =
  | OrganizationWorkspaceContext
  | PersonalMachineContext;
// Everything the schema accepts: a context as above, or the auth-sourced
// handover of a free Environment (root decision 0216, Machines
// docs/free-environments.md §5.4), which names nobody and points to its
// assignment receipt (src/machine/assignment.ts). Only `readMachineContext`
// turns the latter into a context, once the receipt names a person.
export type MachineHandover = MachineContext | AuthSourcedHandover;

const ajv = new Ajv2020({ strict: true });
const validate = ajv.compile<MachineHandover>(schema);
// The wire schema's own rules for the members an assignment receipt fills
// in, which a resolved context is held to again: its person is no wire
// shape (`MachineAccount`), so the whole document is not.
function wireRule(name: "entry" | "operator") {
  const rule = ajv.getSchema(`${schema.$id}#/$defs/${name}`);
  if (rule === undefined) throw new Error("Vendored schema rule missing");
  return rule;
}
const validEntry = wireRule("entry");
const validOperator = wireRule("operator");
export const machineContextPath = "/etc/lazurio/lazurio.machine.json";

export class MachineContextError extends Error {
  constructor(
    public readonly code:
      | "machine-context-missing"
      | "machine-context-invalid"
      | "machine-context-custody"
      | "machine-platform-unsupported"
      | "machine-operator-mismatch"
      | "machine-operator-unavailable"
      // decision F68: this process is not the installed product
      | "machine-not-installed-product"
      // A free Environment (root decision 0216) whose receipt names nobody
      // yet, or whose assignment was released (src/machine/assignment.ts).
      | "machine-assignment-pending"
      | "machine-assignment-released",
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

/** A handover the vendored schema accepts, auth-sourced or not. */
export function parseMachineHandover(bytes: Uint8Array): MachineHandover {
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

/** A handover that is a context by itself. An auth-sourced one is not: its
 * person is its receipt's, which only `readMachineContext` reads. */
export function parseMachineContext(bytes: Uint8Array): MachineContext {
  const handover = parseMachineHandover(bytes);
  if (isAuthSourced(handover))
    throw new MachineContextError("machine-assignment-pending");
  return handover;
}

/** The context of an auth-sourced handover from its receipt's bytes (none
 * while the finisher wrote none). The handover itself passed the vendored
 * schema; what the receipt fills in, the operator and the entry's origins,
 * is held to the schema's own rules for them again, and its person to the
 * receipt's closed rules (`parseAssignmentReceipt`). */
export function assignedMachineContext(
  handover: AuthSourcedHandover,
  receiptBytes: Uint8Array | null,
): MachineContext {
  if (receiptBytes === null)
    throw new MachineContextError("machine-assignment-pending");
  let resolved: MachineContext;
  try {
    const receipt = parseAssignmentReceipt(
      parseUniqueJson(
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
          receiptBytes,
        ),
      ),
    );
    resolved = structuredClone(resolveAssignedContext(handover, receipt));
  } catch (error) {
    throw new MachineContextError(
      error instanceof AssignmentReceiptError
        ? error.code
        : "machine-context-invalid",
    );
  }
  if (
    isAuthSourced(resolved) ||
    !validOperator(resolved.operator) ||
    (resolved.entry !== undefined && !validEntry(resolved.entry))
  )
    throw new MachineContextError("machine-context-invalid");
  freeze(resolved);
  return resolved;
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
// The handover as written, auth-sourced or not: what `machine inspect` prints.
export async function readMachineHandover(
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
    context: parseMachineHandover(bytes),
    digest: createHash("sha256").update(bytes).digest("hex"),
  });
}

/** The context of this Machine: its handover, and for an auth-sourced one
 * the person its receipt names (`assignedMachineContext`). The receipt lies
 * beside the handover, under the same root custody, and is read only for an
 * auth-sourced handover. The digest stays the handover's: the receipt's
 * facts a context takes are written once, at the first binding, except a
 * work assignee's current GitHub link, which a refresh records like any
 * other assignment. */
export async function readMachineContext(
  source: MachineContextSource = productionMachineContextSource,
) {
  const observed = await readMachineHandover(source);
  if (!isAuthSourced(observed.context))
    return Object.freeze({
      context: observed.context,
      digest: observed.digest,
      authSourced: false,
    });
  let receipt: Buffer | null;
  try {
    receipt = await readCustodiedDeclarationBytes(
      join(source.root, observed.context.assignment_receipt.path),
      source.custodian,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw new MachineContextError("machine-context-custody");
    receipt = null;
  }
  return Object.freeze({
    context: assignedMachineContext(observed.context, receipt),
    digest: observed.digest,
    authSourced: true,
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
