import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";
import type { MachineContext } from "../machine/context";
import { type BitwardenRegion, bitwardenRegions } from "./endpoints";

// The Environment's own vault (root decision 0198, decision F53): which
// network vault this Environment's technical account lives in, what the
// account is called and what its vault is named, all as the root-issued
// handover's `vault` member says (DEV-6631 contract C2). Nothing is derived
// or guessed: without the member the Environment has no vault yet. Pure: the
// handover and the kind of Environment go in, the facts come out, or why
// this Environment has no vault here. Nothing here reads a file.
//
// A personal Environment whose handover names no vault keeps its vault in
// its person's own Bitwarden instead (root decision 0203 point 7): the
// person connects it, and the connection they made (connection.ts) names
// the region and the agents' account.

/** The kinds of Remote Environment. A workstation (this computer) is the
 * second wave of root decision 0193. */
export type VaultEnvironmentKind = "personal" | "work" | "team" | "automated";

export type VaultContext = Readonly<{
  kind: "own";
  /** The network's Lazurio Vaultwarden: `vault.server_url`. */
  vault: string;
  /** Its host; with the account it names the account's state directory. */
  host: string;
  /** The Environment's technical account: `vault.account`. */
  account: string;
  /** The vault's name, the name of the Environment's own organization in
   * Vaultwarden: `vault.name`. Its identity is its ID, never this name. */
  name: string;
  environment: VaultEnvironmentKind;
  /** The Organization that owns a work Environment (`owner.organization`, a
   * lowercase slug); null for a personal Environment, which a person owns.
   * It decides which applications read runtime secrets (decision F46 as F53
   * amends it). */
  organization: string | null;
  /** Whom an Organization's Environment is assigned to, as a fingerprint
   * (`assignmentOf`); null for a personal Environment, which never changes
   * hands. When it changes, the Správci of a work Environment leave its
   * vault (`src/vault/members.ts`). */
  assignment: string | null;
  /** A personal Environment's own Bitwarden (root decision 0203 point 7):
   * the Bitwarden cloud region of the agents' account the person connected,
   * and the address of the person's own Bitwarden account, which the vault
   * invites once the person asks (null until then). Absent for a Lazurio
   * Vaultwarden the handover names. */
  bitwarden?: Readonly<{ region: BitwardenRegion; invitee: string | null }>;
}>;

/** A personal Environment whose handover names no vault and whose person has
 * not connected their own Bitwarden yet (root decision 0203 point 7): only
 * the person moves it on, in Settings → Vault; nothing runs for it. `name`
 * is the name its vault gets once connected (`personalVaultName`), which
 * the page shows the person beforehand. */
export type VaultNeedsConnection = Readonly<{
  kind: "needs-connection";
  name: string;
}>;

/** The Bitwarden a personal Environment's person connected: the region
 * whose identity host accepted the agents' API key, the agents' account and
 * the person's own account the vault invites, null until the person asks to
 * be invited. Not secret; kept beside the custody (connection.ts). */
export type BitwardenConnection = Readonly<{
  region: BitwardenRegion;
  account: string;
  invitee: string | null;
}>;

/** The name of a personal Environment's own Bitwarden organization: "Osobní
 * <login>", the login of the handover's owner (at most 46 characters, under
 * Bitwarden's 50). */
export const personalVaultName = (login: string): string => `Osobní ${login}`;

/** The vault facts of a personal Environment whose person connected their
 * own Bitwarden: the region's web vault, the agents' account and the
 * organization "Osobní <login>" it owns. Null for any other handover. */
export function personalVaultContextOf(
  input: Readonly<{
    handover: MachineContext;
    connection: BitwardenConnection;
  }>,
): VaultContext | null {
  const { handover, connection } = input;
  if (handover.owner.kind !== "principal" || handover.vault !== undefined)
    return null;
  const web = bitwardenRegions[connection.region].web;
  return Object.freeze({
    kind: "own",
    vault: web,
    host: new URL(web).hostname,
    account: connection.account,
    name: personalVaultName(handover.owner.github_login),
    environment: "personal",
    organization: null,
    assignment: null,
    bitwarden: Object.freeze({
      region: connection.region,
      invitee: connection.invitee,
    }),
  });
}

/** Why an Environment has no vault here; every reason refuses before
 * anything is installed, written or sent. */
export type VaultUnsupportedReason =
  /** Not a Remote Environment (this computer, or not Linux): the second
   * wave of root decision 0193. */
  | "workstation"
  /** The Environment's Folder (its preset) cannot be read. */
  | "folder-unreadable"
  /** The root-issued handover is not there. */
  | "handover-missing"
  /** The handover is there but cannot be trusted or read. */
  | "handover-unreadable"
  /** This process is not the handover's declared operator. */
  | "not-operator"
  /** The handover names no vault for this Environment (yet): Machines
   * writes the member only where the network pre-allowed its account. */
  | "no-vault"
  /** A personal Environment's record of the Bitwarden its person connected
   * is there but cannot be read: nothing is guessed; disconnecting removes
   * it (root decision 0203 point 7). */
  | "connection-unreadable";

export type VaultUnsupported = Readonly<{
  kind: "unsupported";
  reason: VaultUnsupportedReason;
}>;

/** The vault facts of one Remote Environment from its live handover and the
 * kind of Environment its Folder records. */
export function vaultContextOf(
  input: Readonly<{
    handover: MachineContext;
    environment: VaultEnvironmentKind;
  }>,
): VaultContext | VaultUnsupported {
  const vault = input.handover.vault;
  if (vault === undefined)
    return Object.freeze({ kind: "unsupported", reason: "no-vault" });
  const { owner } = input.handover;
  return Object.freeze({
    kind: "own",
    vault: vault.server_url,
    host: new URL(vault.server_url).hostname,
    account: vault.account,
    name: vault.name,
    environment: input.environment,
    organization: owner.kind === "organization" ? owner.organization : null,
    assignment: assignmentOf(input.handover),
  });
}

/**
 * Whom an Organization's Environment is assigned to, as a fingerprint the
 * vault's state keeps (DEV-6631 task 638b): the Organization that owns it
 * and its handover `owner.assignment` by kind and GitHub id, never a login
 * or a name, so a renamed login is the same assignment and a reassignment is
 * another one. A SHA-256, so the vault's state holds no person. Null for a
 * personal Environment: its Owner is its only person and never changes.
 */
export function assignmentOf(handover: MachineContext): string | null {
  const { owner } = handover;
  if (owner.kind !== "organization") return null;
  const assignment = owner.assignment;
  const whom =
    assignment === undefined
      ? null
      : assignment.kind === "team"
        ? ["team"]
        : [assignment.kind, assignment.github_id];
  return createHash("sha256")
    .update(
      JSON.stringify([
        "lazurio.vault.assignment.v1",
        owner.organization.toLowerCase(),
        whom,
      ]),
    )
    .digest("hex");
}

/** Where one account keeps its files: `${XDG_STATE_HOME:-~/.local/state}/
 * lazurio/vault/<vault host>/<key>`. The key of an Environment's own account
 * is the account itself, so an account the handover replaces never reads
 * the files of the one before, and the address-keyed directory of a 0197
 * pilot (`legacy-0197/`) stays beside it untouched. A relative
 * XDG_STATE_HOME is invalid and ignored, as for the install base. Both parts
 * come from the schema-checked handover (a DNS name, an e-mail address of
 * DNS labels): neither holds a slash. */
export function vaultStateDirectory(
  host: string,
  key: string,
  home: string,
  env: Readonly<Record<string, string | undefined>>,
): string {
  if ([host, key].some((part) => part === "" || /[/\\]|^\.\.?$/.test(part)))
    throw new Error("Invalid vault state directory");
  return join(vaultStateRoot(home, env), host, key);
}

/** `${XDG_STATE_HOME:-~/.local/state}/lazurio/vault`, where every account's
 * directory is. */
function vaultStateRoot(
  home: string,
  env: Readonly<Record<string, string | undefined>>,
): string {
  const xdg = env.XDG_STATE_HOME;
  const state =
    xdg !== undefined && xdg !== "" && isAbsolute(xdg)
      ? xdg
      : join(home, ".local", "state");
  return join(state, "lazurio", "vault");
}

/** Where a personal Environment keeps which Bitwarden its person connected
 * (root decision 0203 point 7): `<state>/lazurio/vault/personal`, beside the
 * accounts' directories and never one of them (those are named by a vault's
 * host, which has a dot). */
export const connectionDirectory = (
  home: string,
  env: Readonly<Record<string, string | undefined>>,
): string => join(vaultStateRoot(home, env), "personal");
