import type { VaultUnsupportedReason } from "./context";
import { readAccount, type VaultAccount, type VaultPaths } from "./store";

// What the vault core answers (decisions F43, F46 and F53): the status of an
// Environment's vault, what an agent's shell gets and what a start's secrets
// are, for the own vault (flow.ts) and the frozen 0197 pilot subset
// (legacy-0197/) alike. Never a secret but the session `env` hands out and
// the values a start reads.

/** What every status of an Environment's vault says. */
export type VaultFacts = Readonly<{
  /** The network's vault: `vault.server_url`. */
  vault: string;
  /** The Environment's technical account. */
  account: string;
  /** The vault's name (`vault.name`); a 0197 pilot has none. */
  name: string | null;
  /** A Team's Environment: the whole Team works with its vault. */
  team: boolean;
  /** `own`: the Environment's own vault (root decision 0198). `pilot-0197`:
   * the collection a 0197 pilot was given in a person's organization, read
   * as before until its handover names a vault and DEV-6631 task 649 moves
   * its items. */
  origin: "own" | "pilot-0197";
}>;

/** The steps of a setup, in order. */
export type VaultPhase = "install" | "account" | "vault" | "sign-in";

export type VaultFailureStage = VaultPhase | "sync" | "status";

export type VaultStatus =
  | Readonly<{
      kind: "vault-status";
      state: "unsupported";
      reason: VaultUnsupportedReason;
    }>
  | (VaultFacts &
      Readonly<{
        kind: "vault-status";
        /** Not set up yet; `next` is the step a setup takes first. */
        state: "not-set-up";
        next: VaultPhase;
      }>)
  | (VaultFacts &
      Readonly<{
        kind: "vault-status";
        /** The vault's creation was asked for and is not confirmed yet (its
         * answer was lost, or the vault does not list it yet): the next
         * setup looks for it again, and nothing is created twice. */
        state: "creating";
      }>)
  | (VaultFacts &
      Readonly<{
        kind: "vault-status";
        /** The vault refused to register the account: the network has not
         * pre-allowed its address (yet), or removed the unused
         * pre-allowance. A person of the network acts; nothing was left
         * behind. */
        state: "not-allowed";
      }>)
  | (VaultFacts &
      Readonly<{
        kind: "vault-status";
        state: "connected";
        organizationId: string;
        /** Agenti; a 0197 pilot's collection. */
        collectionId: string;
        /** The organization's name as bw's copy holds it; null when the
         * session was not unlocked (`locked`). */
        organization: string | null;
        /** How many items the vault holds; null when locked. */
        items: number | null;
        /** The session is not the unlocked one; refresh unlocks it. */
        locked?: true;
      }>)
  | (VaultFacts &
      Readonly<{
        kind: "vault-status";
        /** The account no longer has the vault: its organization is gone or
         * its API key is refused (only the network's operator can do
         * either); a 0197 pilot's collection is no longer shared. */
        state: "revoked";
      }>)
  | (VaultFacts &
      Readonly<{
        kind: "vault-status";
        state: "unreachable";
        reason: string;
      }>)
  | (VaultFacts &
      Readonly<{
        kind: "vault-status";
        state: "failed";
        stage: VaultFailureStage;
        reason: string;
        /** The prepared prompt of an agent who completes it. */
        fallback: "agent";
      }>);

/** What `lazurio vault env` hands an agent's shell. */
export type VaultEnvironment = Readonly<{
  BITWARDENCLI_APPDATA_DIR: string;
  BW_SESSION: string;
  LAZURIO_VAULT_ORGANIZATION_ID: string;
  LAZURIO_VAULT_COLLECTION_ID: string;
}>;

export type VaultEnvRefusal =
  | VaultUnsupportedReason
  | "not-installed"
  | "not-connected"
  | "busy"
  | "unlock-failed";

export type VaultEnvResult =
  | Readonly<{ kind: "vault-env"; env: VaultEnvironment }>
  | Readonly<{ kind: "vault-env-refused"; reason: VaultEnvRefusal }>;

export const unsupportedStatus = (
  reason: VaultUnsupportedReason,
): VaultStatus => ({ kind: "vault-status", state: "unsupported", reason });

export function failedStatus(
  facts: VaultFacts,
  stage: VaultFailureStage,
  reason: string,
): VaultStatus {
  return {
    kind: "vault-status",
    state: "failed",
    ...facts,
    stage,
    reason,
    fallback: "agent",
  };
}

/** The account file, or a failure when it is there and unreadable or not
 * this Environment's account (never replaced: it holds the only copy of the
 * account's password). */
export async function accountOf(
  paths: VaultPaths,
  expected: Readonly<{ account: string; vault: string }>,
): Promise<VaultAccount | null | "unreadable" | "mismatch"> {
  let account: VaultAccount | null;
  try {
    account = await readAccount(paths);
  } catch {
    return "unreadable";
  }
  return account !== null &&
    (account.email !== expected.account || account.server !== expected.vault)
    ? "mismatch"
    : account;
}

/** Why no runtime secret of an application can be read from the
 * Environment's vault (decision F46 as F53 amends it): a fixed code, never
 * bw's output. */
export type VaultSecretsRefusal =
  /** This computer: no vault yet (the second wave of 0193). */
  | "workstation"
  /** A Remote Environment without a vault (no handover vault, not its
   * operator, an unreadable handover). */
  | "no-vault-identity"
  /** A Personalspace application on a work Environment: it reads secrets
   * only in its person's own personal Environment. */
  | "personalspace"
  /** An Organization's application on a personal Environment, whose vault
   * serves the Personalspace's applications only. */
  | "personal-environment"
  /** An application of another Organization than the one that owns the
   * work Environment. */
  | "other-organization"
  /** The vault is not set up here (not installed, no account or vault,
   * signed out, the access revoked). */
  | "not-connected"
  /** The session could not be unlocked. */
  | "locked"
  /** Another process holds the account's lock. */
  | "busy"
  /** The vault cannot be reached for the sync. */
  | "unreachable"
  /** bw did not answer in the shape this core reads, or did not run. */
  | "vault-failed";

/** Why one declared name has no value (decision F46). */
export type VaultSecretAbsence =
  /** No item of that exact name in the vault. */
  | "missing"
  /** More than one such item: which one is meant is not guessed. */
  | "ambiguous"
  /** The one item has no login password, or an empty one. */
  | "empty";

export type VaultSecret =
  | Readonly<{ kind: "value"; value: string }>
  | Readonly<{ kind: "absent"; reason: VaultSecretAbsence }>;

export type VaultSecretsResult =
  | Readonly<{
      kind: "vault-secrets";
      /** Every requested name, with its value or why it has none. */
      secrets: ReadonlyMap<string, VaultSecret>;
    }>
  | Readonly<{ kind: "vault-secrets-refused"; reason: VaultSecretsRefusal }>;

/** The application that asks: the Organization it belongs to (its runtime
 * `company`) and whether it is a Personalspace module. */
export type SecretApplication = Readonly<{
  company: string;
  personalspace: boolean;
}>;
