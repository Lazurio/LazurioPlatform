import type { VaultUnsupportedReason } from "../vault/context";
import { isBitwardenRegion } from "../vault/endpoints";
import type { VaultPhase, VaultStatus } from "../vault/flow";
import type { MessageKey } from "./messages";

// The Environment's own vault on the tools screen (decision F53, the
// wireframe of prototypes-lazurio#33): the row says the state and opens the
// vault; the Environment sets the vault up itself. Pure, so it is testable
// without a DOM. The server's answers are accepted only in their exact form;
// everything returned is text for `textContent` or an https link, never
// markup.

type Copy = Readonly<Record<MessageKey, string>>;

const states = [
  "unsupported",
  "needs-connection",
  "not-set-up",
  "creating",
  "not-allowed",
  "connected",
  "revoked",
  "unreachable",
  "failed",
] as const;

const unsupportedReasons: readonly VaultUnsupportedReason[] = [
  "workstation",
  "folder-unreadable",
  "handover-missing",
  "handover-unreadable",
  "not-operator",
  "no-vault",
  "connection-unreadable",
];

const phases: readonly VaultPhase[] = [
  "install",
  "account",
  "vault",
  "sign-in",
];

const stages = [...phases, "sync", "status"] as const;

const plain = (value: unknown, max = 512): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= max &&
  !/[\p{Cc}\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/u.test(value);
const nullable = (value: unknown): value is string | null =>
  value === null || plain(value);
const count = (value: unknown): value is number | null =>
  value === null ||
  (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
const code = (value: unknown): value is string =>
  typeof value === "string" && /^[a-z0-9-]{1,80}$/.test(value);
const id = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);

/** A vault's own origin: https, a host, nothing else. */
function vaultOrigin(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      url.port === "" &&
      url.username === "" &&
      url.password === "" &&
      url.origin === value
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

/** "Otevřít trezor": the network's web vault filtered to the Environment's
 * vault, once it is connected. */
export function vaultOpenLink(status: VaultStatus | null): string | null {
  if (status?.state !== "connected") return null;
  const origin = vaultOrigin(status.vault);
  return origin === null || !id(status.organizationId)
    ? null
    : `${origin}/#/vault?organizationId=${status.organizationId}`;
}

/** A status answer of the server, only in its exact form. */
export function parseVaultStatus(input: unknown): VaultStatus | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  if (value.kind !== "vault-status" || !states.includes(value.state as never))
    return null;
  if (value.state === "unsupported")
    return unsupportedReasons.includes(value.reason as VaultUnsupportedReason)
      ? {
          kind: "vault-status",
          state: "unsupported",
          reason: value.reason as VaultUnsupportedReason,
        }
      : null;
  if (value.state === "needs-connection")
    return { kind: "vault-status", state: "needs-connection" };
  if (
    vaultOrigin(value.vault) === null ||
    !plain(value.account, 320) ||
    !nullable(value.name) ||
    typeof value.team !== "boolean" ||
    (value.origin !== "own" && value.origin !== "pilot-0197") ||
    // A personal Environment's own Bitwarden names its region.
    !(value.region === undefined || isBitwardenRegion(value.region))
  )
    return null;
  const facts = {
    vault: value.vault as string,
    account: value.account,
    name: value.name,
    team: value.team,
    origin: value.origin as "own" | "pilot-0197",
    ...(isBitwardenRegion(value.region) ? { region: value.region } : {}),
  };
  switch (value.state) {
    case "not-set-up":
      return phases.includes(value.next as VaultPhase)
        ? {
            kind: "vault-status",
            state: "not-set-up",
            ...facts,
            next: value.next as VaultPhase,
          }
        : null;
    case "creating":
      return { kind: "vault-status", state: "creating", ...facts };
    case "not-allowed":
      return { kind: "vault-status", state: "not-allowed", ...facts };
    case "connected":
      if (value.locked !== undefined && value.locked !== true) return null;
      return id(value.organizationId) &&
        id(value.collectionId) &&
        nullable(value.organization) &&
        count(value.items)
        ? {
            kind: "vault-status",
            state: "connected",
            ...facts,
            organizationId: value.organizationId,
            collectionId: value.collectionId,
            organization: value.organization,
            items: value.items,
            ...(value.locked === true ? { locked: true as const } : {}),
          }
        : null;
    case "revoked":
      return { kind: "vault-status", state: "revoked", ...facts };
    case "unreachable":
      return code(value.reason)
        ? {
            kind: "vault-status",
            state: "unreachable",
            ...facts,
            reason: value.reason,
          }
        : null;
    case "failed":
      return stages.includes(value.stage as never) &&
        code(value.reason) &&
        value.fallback === "agent"
        ? {
            kind: "vault-status",
            state: "failed",
            ...facts,
            stage: value.stage as (typeof stages)[number],
            reason: value.reason,
            fallback: "agent",
          }
        : null;
    default:
      return null;
  }
}

/** A running setup: `202 {kind: "vault-setting-up", job, phase}`. */
export function parseVaultSettingUp(
  input: unknown,
): Readonly<{ job: string; phase: VaultPhase }> | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  return value.kind === "vault-setting-up" &&
    typeof value.job === "string" &&
    /^[0-9a-f]{32}$/.test(value.job) &&
    phases.includes(value.phase as VaultPhase)
    ? { job: value.job, phase: value.phase as VaultPhase }
    : null;
}

export type VaultRowLine = Readonly<{
  text: string;
  /** The colour of the line: `signed-in` (success), `signed-out`
   * (warning), `unknown` (quiet). */
  state: "signed-in" | "signed-out" | "unknown";
}>;

const phaseKeys: Readonly<Record<VaultPhase, MessageKey>> = {
  install: "vaultPhaseInstall",
  account: "vaultPhaseAccount",
  vault: "vaultPhaseVault",
  "sign-in": "vaultPhaseSignIn",
};

/** The state under the row's name: the step of a setup that runs, or the
 * state the server read. */
export function vaultRowLine(
  status: VaultStatus | null,
  running: VaultPhase | null,
  copy: Copy,
): VaultRowLine {
  if (running !== null)
    return { text: copy[phaseKeys[running]], state: "unknown" };
  if (status === null) return { text: copy.vaultRowChecking, state: "unknown" };
  switch (status.state) {
    case "unsupported":
      return {
        text:
          status.reason === "workstation"
            ? copy.vaultRowSecondWave
            : status.reason === "no-vault"
              ? copy.vaultRowNoVault
              : copy.vaultRowUnavailable,
        state: "unknown",
      };
    // A personal Environment's own Bitwarden waits for its person.
    case "needs-connection":
      return { text: copy.vaultRowNeedsConnection, state: "unknown" };
    case "not-set-up":
      return { text: copy.vaultRowNotSetUp, state: "unknown" };
    case "creating":
      return { text: copy.vaultRowCreating, state: "unknown" };
    case "not-allowed":
      return { text: copy.vaultRowNotAllowed, state: "signed-out" };
    case "connected":
      return { text: copy.vaultRowConnected, state: "signed-in" };
    case "revoked":
      return {
        text:
          status.origin === "own" ? copy.vaultRowRemoved : copy.vaultRowRevoked,
        state: "signed-out",
      };
    case "unreachable":
      return { text: copy.vaultRowUnreachable, state: "signed-out" };
    case "failed":
      return { text: copy.vaultRowFailed, state: "signed-out" };
  }
}

/** The row's one action besides "Otevřít trezor": set the own vault up
 * when nothing set it up yet, or try again after a setup that stopped or a
 * creation not confirmed yet. A vault the network has not allowed or has
 * revoked waits for a person of the network, and a 0197 pilot is only read:
 * neither offers one. */
export function vaultAction(
  status: VaultStatus | null,
  running: VaultPhase | null,
  copy: Copy,
): string | null {
  if (
    running !== null ||
    status === null ||
    status.state === "unsupported" ||
    status.state === "needs-connection" ||
    status.origin !== "own"
  )
    return null;
  if (status.state === "not-set-up") return copy.vaultActionSetUp;
  return status.state === "failed" ||
    status.state === "unreachable" ||
    status.state === "creating"
    ? copy.vaultActionRetry
    : null;
}

/** How soon a running setup is asked again. */
export const vaultSetupPollMs = 1_000;
