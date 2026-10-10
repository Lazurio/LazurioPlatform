import type { VaultUnsupportedReason } from "../vault/context";
import type { VaultPhase, VaultStatus } from "../vault/flow";
import type { MessageKey } from "./messages";
import { fill } from "./update-view";

// The Environment vault on the tools screen (decision F43, the wireframe of
// prototypes-lazurio#24): pure, so it is testable without a DOM. The server's
// answers are accepted only in their exact form; everything returned is text
// for `textContent`, never markup.

type Copy = Readonly<Record<MessageKey, string>>;

const states = [
  "unsupported",
  "not-installed",
  "none",
  "awaiting-invite",
  "confirming",
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
  "no-address",
  "no-network",
  "vault-unknown",
];

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
const phrase = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length <= 160 &&
  /^[a-z]+(?:-[a-z]+){4,9}$/.test(value);

/** The vault's own address: only `https://vaultwarden.<zone>`. */
export function vaultLink(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      url.hostname.startsWith("vaultwarden.") &&
      url.port === "" &&
      url.username === "" &&
      url.password === "" &&
      `${url.origin}` === value.replace(/\/$/, "")
      ? `${url.origin}/`
      : null;
  } catch {
    return null;
  }
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
  if (
    vaultLink(value.vault) === null ||
    !plain(value.account, 320) ||
    !plain(value.collection) ||
    !plain(value.name, 128) ||
    typeof value.team !== "boolean"
  )
    return null;
  const facts = {
    vault: value.vault as string,
    account: value.account,
    collection: value.collection,
    name: value.name,
    team: value.team,
  };
  const locked = value.locked === true ? { locked: true as const } : {};
  if (value.locked !== undefined && value.locked !== true) return null;
  switch (value.state) {
    case "not-installed":
    case "none":
      return typeof value.registered === "boolean"
        ? {
            kind: "vault-status",
            state: value.state,
            ...facts,
            registered: value.registered,
          }
        : null;
    case "awaiting-invite":
      return { kind: "vault-status", state: "awaiting-invite", ...facts };
    case "confirming":
      return phrase(value.fingerprint) && nullable(value.organization)
        ? {
            kind: "vault-status",
            state: "confirming",
            ...facts,
            fingerprint: value.fingerprint,
            organization: value.organization,
            ...locked,
          }
        : null;
    case "connected":
      return phrase(value.fingerprint) &&
        nullable(value.organization) &&
        count(value.collections) &&
        count(value.items)
        ? {
            kind: "vault-status",
            state: "connected",
            ...facts,
            fingerprint: value.fingerprint,
            organization: value.organization,
            collections: value.collections,
            items: value.items,
            ...locked,
          }
        : null;
    case "revoked":
      return value.fingerprint === null || phrase(value.fingerprint)
        ? {
            kind: "vault-status",
            state: "revoked",
            ...facts,
            fingerprint: value.fingerprint,
          }
        : null;
    case "unreachable":
      return (value.fingerprint === null || phrase(value.fingerprint)) &&
        code(value.reason)
        ? {
            kind: "vault-status",
            state: "unreachable",
            ...facts,
            fingerprint: value.fingerprint,
            reason: value.reason,
          }
        : null;
    case "failed":
      return ["install", "account", "sign-in", "sync", "status"].includes(
        value.stage as string,
      ) &&
        code(value.reason) &&
        value.fallback === "agent"
        ? {
            kind: "vault-status",
            state: "failed",
            ...facts,
            stage: value.stage as "install",
            reason: value.reason,
            fallback: "agent",
          }
        : null;
    default:
      return null;
  }
}

/** A running connect: `202 {kind: "vault-connecting", job, phase}`. */
export function parseVaultConnecting(
  input: unknown,
): Readonly<{ job: string; phase: VaultPhase }> | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  return value.kind === "vault-connecting" &&
    typeof value.job === "string" &&
    /^[0-9a-f]{32}$/.test(value.job) &&
    (value.phase === "install" ||
      value.phase === "account" ||
      value.phase === "sign-in")
    ? { job: value.job, phase: value.phase }
    : null;
}

/** Czech plurals: 1, 2–4, 0 and 5 and more; English: 1 and the rest. */
function plural(
  value: number,
  copy: Copy,
  keys: readonly [MessageKey, MessageKey, MessageKey],
): string {
  const key =
    value === 1 ? keys[0] : value >= 2 && value <= 4 ? keys[1] : keys[2];
  return fill(copy[key], { count: String(value) });
}

/** "2 kolekce · 14 položek": what the account sees. */
export function vaultSeen(
  collections: number,
  items: number,
  copy: Copy,
): string {
  return `${plural(collections, copy, [
    "vaultCollectionsOne",
    "vaultCollectionsFew",
    "vaultCollectionsMany",
  ])} · ${plural(items, copy, ["vaultItemsOne", "vaultItemsFew", "vaultItemsMany"])}`;
}

export type VaultRowLine = Readonly<{
  text: string;
  /** The colour of the line: `signed-in` (success), `signed-out`
   * (warning), `unknown` (quiet). */
  state: "signed-in" | "signed-out" | "unknown";
}>;

/** The state under the row's name (the wireframe's row states). */
export function vaultRowLine(
  status: VaultStatus | null,
  copy: Copy,
): VaultRowLine {
  if (status === null) return { text: copy.vaultRowChecking, state: "unknown" };
  switch (status.state) {
    case "unsupported":
      return {
        text:
          status.reason === "workstation"
            ? copy.vaultRowSecondWave
            : copy.vaultRowUnavailable,
        state: "unknown",
      };
    case "not-installed":
    case "none":
    case "awaiting-invite":
    case "failed":
      return { text: copy.vaultRowNone, state: "unknown" };
    case "confirming":
      // Confirmed in an organization, without the Environment's collection.
      return {
        text:
          status.organization === null
            ? copy.vaultRowConfirming
            : copy.vaultRowCollection,
        state: "signed-out",
      };
    case "connected":
      return {
        text:
          status.collections === null || status.items === null
            ? copy.vaultRowConnected
            : `${copy.vaultRowConnected} · ${vaultSeen(status.collections, status.items, copy)}`,
        state: "signed-in",
      };
    case "revoked":
      return { text: copy.vaultRowRevoked, state: "signed-out" };
    case "unreachable":
      return { text: copy.vaultRowUnreachable, state: "signed-out" };
  }
}

export type VaultAction = "connect" | "continue" | "reconnect" | "retry";

export type VaultActions = Readonly<{
  primary: Readonly<{ action: VaultAction; label: string }> | null;
  disconnect: boolean;
}>;

/** The row's controls in each state: one next step, and "Odpojit" once an
 * account is signed in here. */
export function vaultActions(
  status: VaultStatus | null,
  copy: Copy,
): VaultActions {
  if (status === null || status.state === "unsupported")
    return { primary: null, disconnect: false };
  switch (status.state) {
    case "not-installed":
    case "none":
    case "awaiting-invite":
    case "failed":
      return {
        primary: { action: "connect", label: copy.vaultActionConnect },
        disconnect: false,
      };
    case "confirming":
      return {
        primary: { action: "continue", label: copy.vaultActionContinue },
        disconnect: true,
      };
    case "connected":
      return { primary: null, disconnect: true };
    case "revoked":
      return {
        primary: { action: "reconnect", label: copy.vaultActionReconnect },
        disconnect: true,
      };
    case "unreachable":
      return {
        primary: { action: "retry", label: copy.vaultActionRetry },
        disconnect: true,
      };
  }
}

/** The four steps of the dialog. */
export type VaultStep = "invite" | "connect" | "confirm" | "done";
export const vaultSteps: readonly VaultStep[] = [
  "invite",
  "connect",
  "confirm",
  "done",
];

/** Where "Připojit", "Pokračovat" or "Připojit znovu" opens the dialog: an
 * account that exists only signs in again, a revoked one is invited again. */
export function vaultStartStep(
  status: VaultStatus,
  action: VaultAction,
): VaultStep {
  if (action === "continue") return "confirm";
  if (action === "reconnect") return "invite";
  if (
    (status.state === "none" || status.state === "not-installed") &&
    status.registered
  )
    return "connect";
  return "invite";
}

/** The step a connect's answer leads to, and the line it says. */
export function vaultAfterConnect(
  status: VaultStatus,
  copy: Copy,
): Readonly<{ step: VaultStep; failure: string | null; agent: boolean }> {
  switch (status.state) {
    case "confirming":
      return { step: "confirm", failure: null, agent: false };
    case "connected":
      return { step: "done", failure: null, agent: false };
    case "awaiting-invite":
    case "revoked":
      return { step: "invite", failure: copy.vaultNotInvited, agent: false };
    case "unreachable":
      return {
        step: "connect",
        failure: copy.vaultUnreachableLine,
        agent: false,
      };
    case "failed":
      return {
        step: "connect",
        failure: fill(copy.vaultFailed, {
          stage: status.stage,
          reason: status.reason,
        }),
        agent: true,
      };
    case "unsupported":
      return {
        step: "invite",
        failure: copy.vaultRowUnavailable,
        agent: false,
      };
    default:
      return { step: "invite", failure: null, agent: false };
  }
}

/** The automatic steps of "Environment se připojí", marked by the phase the
 * connect reports. */
export function vaultPhaseMarks(
  phase: VaultPhase | "done" | null,
  copy: Copy,
): readonly Readonly<{ label: string; mark: "done" | "running" | "next" }>[] {
  const order: readonly VaultPhase[] = ["install", "account", "sign-in"];
  const labels: Readonly<Record<VaultPhase, string>> = {
    install: copy.vaultPhaseInstall,
    account: copy.vaultPhaseAccount,
    "sign-in": copy.vaultPhaseSignIn,
  };
  const at =
    phase === "done"
      ? order.length
      : phase === null
        ? -1
        : order.indexOf(phase);
  return order.map((step, index) => ({
    label: labels[step],
    mark: index < at ? "done" : index === at ? "running" : "next",
  }));
}

/** How often the confirmation step asks the vault again. */
export const vaultPollMs = 5_000;
/** How soon a running connect is asked again. */
export const vaultConnectPollMs = 1_000;
