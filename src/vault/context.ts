import { isAbsolute, join } from "node:path";
import type { MachineContext } from "../machine/context";

// The Environment's own vault (root decision 0198, decision F53): which
// network vault this Environment's technical account lives in, what the
// account is called and what its vault is named, all as the root-issued
// handover's `vault` member says (DEV-6631 contract C2). Nothing is derived
// or guessed: without the member the Environment has no vault yet. Pure: the
// handover and the kind of Environment go in, the facts come out, or why
// this Environment has no vault here. Nothing here reads a file.

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
}>;

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
  | "no-vault";

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
  });
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
  const xdg = env.XDG_STATE_HOME;
  const state =
    xdg !== undefined && xdg !== "" && isAbsolute(xdg)
      ? xdg
      : join(home, ".local", "state");
  return join(state, "lazurio", "vault", host, key);
}
