import { isAbsolute, join } from "node:path";
import type { MachineContext } from "../machine/context";
import { environmentIdOf } from "../shell/contract";
import { shellMessages } from "../shell/messages";

// The Environment vault (decision F43, root decision 0193): which vault this
// Environment's own account lives in, what the account is called and which
// collection is the Environment's. Pure: the handover, the kind of
// Environment and its name go in; the facts come out, or why this
// Environment has no vault account here. Nothing here reads a file.

/** The kinds of Remote Environment that get a vault account now. A
 * workstation (this computer) is the second wave. */
export type VaultEnvironmentKind = "personal" | "work" | "team" | "automated";

export type VaultContext = Readonly<{
  /** The vault of the Environment's network: `https://vaultwarden.<zone>`
   * where the handover's tailnet control server is `https://headscale.<zone>`. */
  vault: string;
  /** Its host; with the address it names the account's state directory. */
  host: string;
  /** The Environment's own address: `<machine>.<org>.lazurio.io` for an
   * Organization's Environment, `<slug>.lazurio.io` for a personal one. */
  address: string;
  /** The account: `vaultwarden@<address>`. */
  account: string;
  /** The machine part of the address: the work VM's name or the personal
   * slug. It identifies the Environment's collection. */
  machine: string;
  kind: VaultEnvironmentKind;
  /** The Environment's name as the shell gives it (decision 0185): its own
   * label (a Team's, a persona's) or its kind's, in the vault's language. */
  name: string;
  /** The Environment's own collection: `Environmenty/<name> · <machine>`. */
  collection: string;
  /** The Organization that owns the Environment, as the handover names it
   * (`owner.organization`, a lowercase slug); null for a personal
   * Environment, which a person owns. Its collection belongs to this
   * Organization's vault, so only its own applications read runtime
   * secrets from it (decision F46). */
  organization: string | null;
}>;

/** Why an Environment has no vault account here; every reason refuses
 * before anything is installed, written or sent. */
export type VaultUnsupportedReason =
  /** Not a Remote Environment (this computer, or not Linux): the second
   * wave of decision 0193. */
  | "workstation"
  /** The Environment's Folder (its preset) cannot be read. */
  | "folder-unreadable"
  /** The root-issued handover is not there. */
  | "handover-missing"
  /** The handover is there but cannot be trusted or read. */
  | "handover-unreadable"
  /** This process is not the handover's declared operator. */
  | "not-operator"
  /** The handover records no hosted entry, or its Launchpad origin gives no
   * Environment address. */
  | "no-address"
  /** The handover names no tailnet control server. */
  | "no-network"
  /** The control server is not `headscale.<zone>`, so the vault's address
   * is not known. */
  | "vault-unknown";

export type VaultUnsupported = Readonly<{
  kind: "unsupported";
  reason: VaultUnsupportedReason;
}>;

const hostedDomain = "lazurio.io";
const dnsLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** The collection prefix of decision 0193, in the vault's language. */
export const collectionPrefix = "Environmenty/";

/** The vault of a network from its tailnet control server: only
 * `https://headscale.<zone>` (an optional trailing slash, nothing else) gives
 * `https://vaultwarden.<zone>`; anything else is unknown (fail closed). */
export function vaultOriginOf(controlServer: string): string | null {
  let url: URL;
  try {
    url = new URL(controlServer);
  } catch {
    return null;
  }
  const written = controlServer.toLowerCase();
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    (written !== url.origin && written !== `${url.origin}/`)
  )
    return null;
  const labels = url.hostname.split(".");
  if (
    labels.length < 3 ||
    labels[0] !== "headscale" ||
    !labels.every((label) => dnsLabel.test(label))
  )
    return null;
  return `https://${["vaultwarden", ...labels.slice(1)].join(".")}`;
}

/** The Environment's name as the collection carries it: its own label when
 * it is plain one-line text without a slash (a slash nests collections in
 * the vault), otherwise its kind's name. */
export function environmentNameOf(
  kind: VaultEnvironmentKind,
  label: string | null,
): string {
  const clean = label?.trim() ?? "";
  return clean.length > 0 &&
    clean.length <= 64 &&
    !/[\p{Cc}/\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/u.test(clean)
    ? clean
    : shellMessages("cs").names[kind];
}

export const collectionNameOf = (name: string, machine: string): string =>
  `${collectionPrefix}${name} · ${machine}`;

/** Whether a collection the account sees is this Environment's: named
 * `Environmenty/<name> · <machine>` for this machine. The name part may
 * differ from the one shown (a Team's display name can change); the
 * machine part identifies the Environment. */
export function isEnvironmentCollection(
  name: string,
  context: Pick<VaultContext, "machine">,
): boolean {
  const suffix = ` · ${context.machine}`;
  return (
    name.startsWith(collectionPrefix) &&
    name.endsWith(suffix) &&
    name.length > collectionPrefix.length + suffix.length
  );
}

/** The vault facts of one Remote Environment: from the live handover (the
 * vault from its tailnet control server, the address from its Launchpad
 * entry, the one derivation of an Environment's id), the kind of
 * Environment its Folder records and the name the shell gives it. */
export function vaultContextOf(
  input: Readonly<{
    handover: MachineContext;
    kind: VaultEnvironmentKind;
    /** The Environment's own label, when it has one (a Team's, a
     * persona's); null names it by its kind. */
    label: string | null;
  }>,
): VaultContext | VaultUnsupported {
  const unsupported = (reason: VaultUnsupportedReason): VaultUnsupported =>
    Object.freeze({ kind: "unsupported", reason });
  const { handover } = input;
  const origin = handover.entry?.launchpad.external_origin;
  const id = origin === undefined ? null : environmentIdOf(origin);
  if (id === null) return unsupported("no-address");
  const labels = id.split(".");
  // A personal Environment is one label, an Organization's two.
  if (labels.length !== (handover.machine.kind === "personal-vm" ? 1 : 2))
    return unsupported("no-address");
  const controlServer = handover.network?.headscale_server_url;
  if (controlServer === undefined) return unsupported("no-network");
  const vault = vaultOriginOf(controlServer);
  if (vault === null) return unsupported("vault-unknown");
  const machine = labels[0] as string;
  const address = `${id}.${hostedDomain}`;
  const name = environmentNameOf(input.kind, input.label);
  return Object.freeze({
    vault,
    host: new URL(vault).hostname,
    address,
    account: `vaultwarden@${address}`,
    machine,
    kind: input.kind,
    name,
    collection: collectionNameOf(name, machine),
    organization:
      handover.owner.kind === "organization"
        ? handover.owner.organization
        : null,
  });
}

/** Where one Environment's account keeps its files: `${XDG_STATE_HOME:-~/
 * .local/state}/lazurio/vault/<vault host>/<Environment address>`, keyed by
 * the account's whole identity, so an Environment whose address changes
 * never reads the files of the account it had before (a relative
 * XDG_STATE_HOME is invalid and ignored, as for the install base). Both
 * parts are DNS names checked label by label above. */
export function vaultStateDirectory(
  identity: Pick<VaultContext, "host" | "address">,
  home: string,
  env: Readonly<Record<string, string | undefined>>,
): string {
  const xdg = env.XDG_STATE_HOME;
  const state =
    xdg !== undefined && xdg !== "" && isAbsolute(xdg)
      ? xdg
      : join(home, ".local", "state");
  return join(state, "lazurio", "vault", identity.host, identity.address);
}
