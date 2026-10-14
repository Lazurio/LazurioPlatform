import { randomUUID } from "node:crypto";
import type { InstallFetch } from "../tools/install";
import type { ToolRunner } from "../tools/status";
import type { BwCli, BwFailure } from "./bw";
import type {
  VaultContext,
  VaultUnsupported,
  VaultUnsupportedReason,
} from "./context";
import { installPinnedBw, pinnedInstalled } from "./install";
import type { PilotContext } from "./legacy-0197/context";
import {
  pilotEnv,
  pilotRefresh,
  pilotSecrets,
  pilotSecretsAdmission,
  pilotStatus,
} from "./legacy-0197/pilot";
import { ensureOwnVault } from "./organization";
import type { BitwardenPin } from "./pin";
import {
  DEVICE_TYPE_SDK,
  type Device,
  fetchApiKey,
  generateMasterPassword,
  passwordLogin,
  registerAccount,
  type VaultFetch,
  VaultwardenError,
} from "./register";
import {
  cliOf,
  lockMs,
  readSecrets,
  sharedSession,
  signedInAs,
  usableSession,
  withLock,
} from "./session";
import {
  accountOf,
  failedStatus,
  type SecretApplication,
  unsupportedStatus,
  type VaultEnvResult,
  type VaultFacts,
  type VaultFailureStage,
  type VaultPhase,
  type VaultSecretsRefusal,
  type VaultSecretsResult,
  type VaultStatus,
} from "./status";
import {
  completeAccount,
  createAccount,
  ensureVaultDirectories,
  forgetUnregisteredAccount,
  isReady,
  type ReadyAccount,
  readRecord,
  readSession,
  type VaultAccount,
  type VaultPaths,
  type VaultRecord,
  vaultPaths,
  writeRecord,
} from "./store";

export type {
  SecretApplication,
  VaultEnvironment,
  VaultEnvRefusal,
  VaultEnvResult,
  VaultFacts,
  VaultFailureStage,
  VaultPhase,
  VaultSecret,
  VaultSecretAbsence,
  VaultSecretsRefusal,
  VaultSecretsResult,
  VaultStatus,
} from "./status";

// The Environment's own vault (root decision 0198, decision F53): one core
// for the CLI (`lazurio vault`) and the Launchpad (Settings → Tools →
// bitwarden, and its start). Each Environment's technical account, which the
// network pre-allowed and the handover names, registers itself, creates the
// Environment's own organization in the network's Lazurio Vaultwarden with
// the first collection Agenti, and keeps one unlocked session its agents
// share. Status-driven and idempotent: every operation reads what is there
// and moves it on, so an interrupted one is completed by the next. Each
// mutation holds the account's kernel lock. Nothing secret is returned but
// by `env`, which hands the session to an agent's shell by design; the
// journal carries the operation, the outcome and a fixed reason, never a
// value. An Environment connected the 0197 way, whose handover names no
// vault yet, is read by the frozen subset in `legacy-0197/` instead.

/** Where the vault runs: trusted composition, never HTTP input. */
export type VaultHost = Readonly<{
  /** The Environment's vault, a 0197 pilot's, or why it has none here; read
   * at the start of every operation. */
  context: () => Promise<VaultContext | PilotContext | VaultUnsupported>;
  /** The state directory of one account: the vault's host and the key (the
   * own account itself; a 0197 pilot's Environment address). */
  directory: (host: string, key: string) => string;
  /** The product's install base, where the pinned CLI lives. */
  base: string;
  /** `~/.local/bin`, the standard entry of `bw`. */
  bin: string;
  home: string;
  path: string | undefined;
  platform: string;
  arch: string;
  run: ToolRunner;
  /** Test seams: the vault, the release download, the pin. */
  fetch?: VaultFetch | undefined;
  download?: InstallFetch | undefined;
  pin?: BitwardenPin | undefined;
  journal?: ((entry: VaultJournalEntry) => void) | undefined;
  /** "Používají agenti" on for the vault (decision F53): called once per
   * vault, after the setup in which it became ready (its collection Agenti
   * recorded), and never by a later setup, so a person who turns the switch
   * off keeps it off. A failure is journaled and is never the setup's. */
  enableForAgents?: (() => Promise<void>) | undefined;
  now?: (() => Date) | undefined;
  /** How long a mutation waits for another one (default 10 s; setup, which
   * may download the CLI, waits longer). */
  lockMs?: number | undefined;
}>;

export type VaultJournalEntry = Readonly<{
  operation: "setup" | "refresh" | "unlock" | "secrets" | "vault";
  outcome: string;
  reason?: string;
  /** The Launchpad's own setup after its start. */
  trigger?: "start";
}>;

const setupLockMs = 15 * 60_000;

const ownFacts = (context: VaultContext): VaultFacts => ({
  vault: context.vault,
  account: context.account,
  name: context.name,
  team: context.environment === "team",
  origin: "own",
});

const ownPaths = (host: VaultHost, context: VaultContext): VaultPaths =>
  vaultPaths(host.directory(context.host, context.account));

const notSetUp = (facts: VaultFacts, next: VaultPhase): VaultStatus => ({
  kind: "vault-status",
  state: "not-set-up",
  ...facts,
  next,
});

const creating = (facts: VaultFacts): VaultStatus => ({
  kind: "vault-status",
  state: "creating",
  ...facts,
});

/** Whether the Launchpad's start moves this vault on (the Executor pattern,
 * decision F44's addendum of 2026-10-11): an own vault not set up yet or
 * whose creation is not confirmed yet, one whose session is not the
 * unlocked one, or one whose name is no longer the handover's. Never a 0197
 * pilot, a vault that is not supported here, or one that ended in a failure
 * or a revocation: those wait for a person or an agent. */
export function setUpAtStart(status: VaultStatus): boolean {
  if (status.state === "unsupported" || status.origin !== "own") return false;
  if (status.state === "not-set-up" || status.state === "creating") return true;
  return (
    status.state === "connected" &&
    (status.locked === true || status.organization !== status.name)
  );
}

type Observation =
  | Readonly<{
      kind: "connected";
      organization: string;
      items: number | null;
    }>
  | Readonly<{ kind: "gone" }>
  | Readonly<{ kind: "failed"; reason: BwFailure }>;

/** What bw's local copy, as of its last sync, holds of the recorded
 * organization: confirmed (the account holds its key) or gone. */
async function observe(
  bw: BwCli,
  session: string,
  organizationId: string,
): Promise<Observation> {
  const organizations = await bw.organizations(session);
  if (!organizations.ok)
    return { kind: "failed", reason: organizations.reason };
  const own = organizations.value.find(
    (entry) => entry.id === organizationId && entry.status === 2,
  );
  if (own === undefined) return { kind: "gone" };
  const items = await bw.itemCount(session, organizationId);
  return {
    kind: "connected",
    organization: own.name,
    items: items.ok ? items.value : null,
  };
}

type Recorded = Readonly<{ organizationId: string; collectionId: string }>;

function statusOf(
  facts: VaultFacts,
  record: Recorded,
  observation: Exclude<Observation, { kind: "failed" }>,
): VaultStatus {
  if (observation.kind === "gone")
    return { kind: "vault-status", state: "revoked", ...facts };
  return {
    kind: "vault-status",
    state: "connected",
    ...facts,
    organizationId: record.organizationId,
    collectionId: record.collectionId,
    organization: observation.organization,
    items: observation.items,
  };
}

/** The ids the record holds once the vault exists. */
const recordedVault = (record: VaultRecord): Recorded | null =>
  record.organizationId !== null && record.collectionId !== null
    ? {
        organizationId: record.organizationId,
        collectionId: record.collectionId,
      }
    : null;

/** The account, the record and the CLI of a set-up own vault, or the status
 * that says what is missing. Local: nothing runs. */
async function ownState(
  host: VaultHost,
  context: VaultContext,
  facts: VaultFacts,
  paths: VaultPaths,
): Promise<
  | Readonly<{ kind: "ready"; account: ReadyAccount; recorded: Recorded }>
  | Readonly<{ kind: "status"; status: VaultStatus }>
> {
  const account = await accountOf(paths, context);
  if (account === "unreadable")
    return {
      kind: "status",
      status: failedStatus(facts, "account", "account-unreadable"),
    };
  if (account === "mismatch")
    return {
      kind: "status",
      status: failedStatus(facts, "account", "account-mismatch"),
    };
  if (!(await pinnedInstalled(host.base, host.pin)))
    return { kind: "status", status: notSetUp(facts, "install") };
  if (account === null || !isReady(account))
    return { kind: "status", status: notSetUp(facts, "account") };
  let record: VaultRecord;
  try {
    record = await readRecord(paths);
  } catch {
    return {
      kind: "status",
      status: failedStatus(facts, "vault", "record-unreadable"),
    };
  }
  const recorded = recordedVault(record);
  if (recorded === null)
    return {
      kind: "status",
      status:
        record.organizationId === null && record.pendingKey !== null
          ? creating(facts)
          : notSetUp(facts, "vault"),
    };
  return { kind: "ready", account, recorded };
}

/** `status`: local, no network, no mutation. */
export async function vaultStatus(host: VaultHost): Promise<VaultStatus> {
  const context = await host.context();
  if (context.kind === "unsupported") return unsupportedStatus(context.reason);
  if (context.kind === "pilot") return pilotStatus(host, context);
  const facts = ownFacts(context);
  const paths = ownPaths(host, context);
  const state = await ownState(host, context, facts, paths);
  if (state.kind === "status") return state.status;
  const { account, recorded } = state;
  const bw = cliOf(host, paths);
  const session = await readSession(paths).catch(() => null);
  const signedIn = await bw.status(session);
  if (signedIn.ok && !signedInAs(signedIn.value, account))
    return notSetUp(facts, "sign-in");
  const locked: VaultStatus = {
    kind: "vault-status",
    state: "connected",
    ...facts,
    ...recorded,
    organization: null,
    items: null,
    locked: true,
  };
  if (session === null) return locked;
  const observation = await observe(bw, session, recorded.organizationId);
  if (observation.kind === "failed") {
    if (observation.reason === "unauthenticated")
      return notSetUp(facts, "sign-in");
    if (observation.reason === "locked") return locked;
    return failedStatus(facts, "status", observation.reason);
  }
  return statusOf(facts, recorded, observation);
}

const deviceOf = (account: VaultAccount): Device => ({
  identifier: account.deviceIdentifier,
  name: "Lazurio Launchpad",
  type: DEVICE_TYPE_SDK,
});

type Step<T> =
  | Readonly<{ kind: "ready"; value: T }>
  | Readonly<{ kind: "status"; status: VaultStatus }>;

/** A refusal of the vault in words of the status: unreachable, or failed at
 * `stage` with the vault's fixed reason. */
function refusalOf(
  facts: VaultFacts,
  stage: VaultFailureStage,
  error: unknown,
): Step<never> {
  const reason =
    error instanceof VaultwardenError ? error.reason : "unexpected";
  return {
    kind: "status",
    status:
      reason === "unreachable"
        ? { kind: "vault-status", state: "unreachable", ...facts, reason }
        : failedStatus(facts, stage, reason),
  };
}

/** The account: created once with a password generated here, written before
 * the registration (the vault refuses a second one, so a lost password
 * would need the network's operator), registered, logged in with the
 * Environment's one device identifier, and its API key added. An unfinished
 * one is resumed: logged in when the vault has it, registered when it does
 * not. */
async function ensureAccount(
  host: VaultHost,
  context: VaultContext,
  facts: VaultFacts,
  paths: VaultPaths,
): Promise<Step<ReadyAccount>> {
  const existing = await accountOf(paths, context);
  if (existing === "unreadable")
    return {
      kind: "status",
      status: failedStatus(facts, "account", "account-unreadable"),
    };
  if (existing === "mismatch")
    return {
      kind: "status",
      status: failedStatus(facts, "account", "account-mismatch"),
    };
  if (existing !== null && isReady(existing))
    return { kind: "ready", value: existing };
  const account =
    existing ??
    (await (async () => {
      const created = {
        email: context.account,
        server: context.vault,
        deviceIdentifier: randomUUID(),
        masterPassword: generateMasterPassword(),
        createdAt: (host.now?.() ?? new Date()).toISOString(),
      };
      await createAccount(paths, created);
      return created;
    })());
  const client = { fetch: host.fetch };
  const login = () =>
    passwordLogin(client, {
      serverUrl: context.vault,
      email: account.email,
      password: account.masterPassword,
      device: deviceOf(account),
    });
  let session: Awaited<ReturnType<typeof login>> | undefined;
  if (existing !== null) {
    // Resumed: the registration may have happened before an interruption.
    try {
      session = await login();
    } catch (error) {
      if (
        !(error instanceof VaultwardenError) ||
        error.reason !== "invalid-credentials"
      )
        return refusalOf(facts, "account", error);
    }
  }
  if (session === undefined) {
    try {
      await registerAccount(client, {
        serverUrl: context.vault,
        email: account.email,
        password: account.masterPassword,
        name: context.name,
      });
    } catch (error) {
      if (error instanceof VaultwardenError && error.reason === "not-invited") {
        // A password generated in this run leaves nothing behind: the vault
        // has no account with it. A resumed account file stays: the vault's
        // refusal does not tell "not allowed" from "exists already", so it
        // may hold the only copy of a registered account's password.
        if (existing === null) await forgetUnregisteredAccount(paths);
        return {
          kind: "status",
          status: { kind: "vault-status", state: "not-allowed", ...facts },
        };
      }
      return refusalOf(facts, "account", error);
    }
    try {
      session = await login();
    } catch (error) {
      return refusalOf(facts, "account", error);
    }
  }
  try {
    const key = await fetchApiKey(client, session);
    return {
      kind: "ready",
      value: await completeAccount(paths, account, key),
    };
  } catch (error) {
    return refusalOf(facts, "account", error);
  }
}

/** The Environment's own organization and its collection Agenti, created,
 * recognized by the record or renamed (organization.ts). */
async function ensureVault(
  host: VaultHost,
  context: VaultContext,
  facts: VaultFacts,
  paths: VaultPaths,
  account: ReadyAccount,
): Promise<Step<Recorded & Readonly<{ becameReady: boolean }>>> {
  let record: VaultRecord;
  try {
    record = await readRecord(paths);
  } catch {
    return {
      kind: "status",
      status: failedStatus(facts, "vault", "record-unreadable"),
    };
  }
  try {
    const own = await ensureOwnVault({
      client: { fetch: host.fetch },
      server: context.vault,
      account,
      name: context.name,
      device: deviceOf(account),
      record,
      save: (next) => writeRecord(paths, next),
      now: () => host.now?.() ?? new Date(),
      // Never a key or an id: that a creation never happened, nothing else.
      discarded: () =>
        host.journal?.({ operation: "vault", outcome: "receipt-expired" }),
    });
    if (own.kind === "creating")
      return { kind: "status", status: creating(facts) };
    if (own.kind === "gone")
      return {
        kind: "status",
        status: { kind: "vault-status", state: "revoked", ...facts },
      };
    if (own.kind === "collection-unknown")
      return {
        kind: "status",
        status: failedStatus(facts, "vault", "collection-unknown"),
      };
    if (own.created) host.journal?.({ operation: "vault", outcome: "created" });
    if (own.renamed) host.journal?.({ operation: "vault", outcome: "renamed" });
    // Ready from now on: this run recorded its collection Agenti, which
    // happens once per vault.
    const becameReady = record.collectionId === null;
    if (becameReady) host.journal?.({ operation: "vault", outcome: "ready" });
    return {
      kind: "ready",
      value: {
        organizationId: own.organizationId,
        collectionId: own.collectionId,
        becameReady,
      },
    };
  } catch (error) {
    // The API key refused: the network's operator removed or disabled the
    // account (or rotated its key); nothing here can sign it in again.
    if (
      error instanceof VaultwardenError &&
      error.reason === "invalid-credentials"
    )
      return {
        kind: "status",
        status: { kind: "vault-status", state: "revoked", ...facts },
      };
    return refusalOf(facts, "vault", error);
  }
}

/** bw signed in to exactly this account at exactly this vault. */
async function signIn(
  bw: BwCli,
  account: ReadyAccount,
): Promise<
  Readonly<{ ok: true }> | Readonly<{ ok: false; reason: BwFailure }>
> {
  const state = await bw.status(null);
  if (!state.ok) return state;
  if (signedInAs(state.value, account)) return { ok: true };
  // Another sign-in in this account's data directory is signed out first.
  if (state.value.status !== "unauthenticated") {
    const out = await bw.logout(null);
    if (!out.ok) return out;
  }
  const configured = await bw.configServer(account.server);
  if (!configured.ok) return configured;
  const login = await bw.loginApiKey(account.clientId, account.clientSecret);
  return login.ok ? { ok: true } : login;
}

/** The vault became ready in this setup: "Používají agenti" on for it, by
 * the composition (decision F53), after the account's lock is released. Best
 * effort: a failure is journaled and is never the setup's, and the switch
 * stays where it is for a person to turn. */
async function turnAgentsOn(host: VaultHost): Promise<void> {
  if (host.enableForAgents === undefined) return;
  try {
    await host.enableForAgents();
  } catch {
    host.journal?.({ operation: "vault", outcome: "agents-not-enabled" });
  }
}

const unreachableOr = (
  facts: VaultFacts,
  stage: VaultFailureStage,
  reason: BwFailure,
): VaultStatus =>
  reason === "unreachable" || reason === "timeout"
    ? { kind: "vault-status", state: "unreachable", ...facts, reason }
    : failedStatus(facts, stage, reason);

/** `setup`: installs the pinned CLI, registers the account when there is
 * none, creates the Environment's own vault (or finds it by its ID, renamed
 * when the handover's name changed), signs bw in with the API key, unlocks
 * the one session and syncs. Idempotent: a vault that is set up is checked,
 * renamed when needed, unlocked and synced again. Never runs twice at once.
 * The setup in which the vault becomes ready turns the agents' switch on
 * (`enableForAgents`); no later one does. A 0197 pilot is only read: no
 * Environment is connected the old way any more. */
export async function vaultSetup(
  host: VaultHost,
  onPhase: (phase: VaultPhase) => void = () => undefined,
): Promise<VaultStatus> {
  const context = await host.context();
  if (context.kind === "unsupported") return unsupportedStatus(context.reason);
  if (context.kind === "pilot") return pilotStatus(host, context);
  const facts = ownFacts(context);
  const paths = ownPaths(host, context);
  const journal = (status: VaultStatus) => {
    host.journal?.({
      operation: "setup",
      outcome: status.state,
      ...("reason" in status ? { reason: status.reason } : {}),
    });
    return status;
  };
  await ensureVaultDirectories(paths);
  const ready = { became: false };
  const status = await withLock(
    paths,
    host.lockMs ?? setupLockMs,
    () => journal(failedStatus(facts, "install", "busy")),
    async () => {
      onPhase("install");
      const installed = await installPinnedBw({
        base: host.base,
        bin: host.bin,
        data: paths.data,
        home: host.home,
        path: host.path,
        platform: host.platform,
        arch: host.arch,
        run: host.run,
        fetch: host.download,
        pin: host.pin,
      });
      if (installed.kind === "unsupported-platform")
        return journal(failedStatus(facts, "install", "unsupported-platform"));
      if (installed.kind === "install-failed")
        return journal(failedStatus(facts, "install", installed.reason));
      if (installed.entry === "conflict")
        return journal(failedStatus(facts, "install", "entry-conflict"));
      onPhase("account");
      const account = await ensureAccount(host, context, facts, paths);
      if (account.kind === "status") return journal(account.status);
      onPhase("vault");
      const vault = await ensureVault(
        host,
        context,
        facts,
        paths,
        account.value,
      );
      if (vault.kind === "status") return journal(vault.status);
      ready.became = vault.value.becameReady;
      onPhase("sign-in");
      const bw = cliOf(host, paths);
      const signedIn = await signIn(bw, account.value);
      if (!signedIn.ok)
        return journal(unreachableOr(facts, "sign-in", signedIn.reason));
      const session = await usableSession(host, bw, paths, account.value);
      if (!session.ok)
        return journal(failedStatus(facts, "sign-in", session.reason));
      const synced = await bw.sync(session.session);
      if (!synced.ok)
        return journal(unreachableOr(facts, "sync", synced.reason));
      const observation = await observe(
        bw,
        session.session,
        vault.value.organizationId,
      );
      if (observation.kind === "failed")
        return journal(failedStatus(facts, "status", observation.reason));
      return journal(statusOf(facts, vault.value, observation));
    },
  );
  if (ready.became) await turnAgentsOn(host);
  return status;
}

/** `refresh`: a sync with the vault, a new unlock when the session is no
 * longer the unlocked one, and the status after it. A vault that is not set
 * up yet answers its local status: only a setup moves it on. */
export async function vaultRefresh(host: VaultHost): Promise<VaultStatus> {
  const context = await host.context();
  if (context.kind === "unsupported") return unsupportedStatus(context.reason);
  if (context.kind === "pilot") return pilotRefresh(host, context);
  const facts = ownFacts(context);
  const paths = ownPaths(host, context);
  const state = await ownState(host, context, facts, paths);
  if (state.kind === "status") return state.status;
  const { account, recorded } = state;
  return withLock(
    paths,
    host.lockMs ?? lockMs,
    () => vaultStatus(host),
    async () => {
      const bw = cliOf(host, paths);
      const journal = (status: VaultStatus) => {
        host.journal?.({
          operation: "refresh",
          outcome: status.state,
          ...("reason" in status ? { reason: status.reason } : {}),
        });
        return status;
      };
      let session = await usableSession(host, bw, paths, account);
      if (!session.ok)
        return journal(
          session.reason === "unauthenticated"
            ? notSetUp(facts, "sign-in")
            : failedStatus(facts, "sign-in", session.reason),
        );
      let synced = await bw.sync(session.session);
      // Unlocked by another bw run since the check: unlock once more.
      if (!synced.ok && synced.reason === "locked" && !session.fresh) {
        session = await usableSession(host, bw, paths, account);
        if (!session.ok)
          return journal(failedStatus(facts, "sign-in", session.reason));
        synced = await bw.sync(session.session);
      }
      if (!synced.ok) {
        if (synced.reason === "unauthenticated")
          return journal(notSetUp(facts, "sign-in"));
        if (synced.reason === "invalid-credentials")
          return journal({ kind: "vault-status", state: "revoked", ...facts });
        // The CLI itself did not run: not a question of the vault.
        if (synced.reason === "spawn-failed")
          return journal(failedStatus(facts, "sync", synced.reason));
        return journal({
          kind: "vault-status",
          state: "unreachable",
          ...facts,
          reason: synced.reason,
        });
      }
      const observation = await observe(
        bw,
        session.session,
        recorded.organizationId,
      );
      if (observation.kind === "failed")
        return journal(failedStatus(facts, "status", observation.reason));
      return journal(statusOf(facts, recorded, observation));
    },
  );
}

/** `env`: the session for an agent's shell, and the ids of the vault and
 * of Agenti. A session that is no longer the unlocked one is replaced under
 * the account's lock; another process that replaced it meanwhile is
 * trusted, so two agents never unlock twice. */
export async function vaultEnv(host: VaultHost): Promise<VaultEnvResult> {
  const context = await host.context();
  if (context.kind === "unsupported")
    return { kind: "vault-env-refused", reason: context.reason };
  if (context.kind === "pilot") return pilotEnv(host, context);
  const paths = ownPaths(host, context);
  const ready = await connectedAccount(paths, context);
  if (ready === null)
    return { kind: "vault-env-refused", reason: "not-connected" };
  const shared = await sharedSession(host, paths, ready.account);
  if (!shared.ok) return { kind: "vault-env-refused", reason: shared.reason };
  return {
    kind: "vault-env",
    env: {
      BITWARDENCLI_APPDATA_DIR: paths.data,
      BW_SESSION: shared.session,
      LAZURIO_VAULT_ORGANIZATION_ID: ready.recorded.organizationId,
      LAZURIO_VAULT_COLLECTION_ID: ready.recorded.collectionId,
    },
  };
}

/** The ready account and the recorded vault, or null: nothing else is the
 * Environment's connected vault. */
async function connectedAccount(
  paths: VaultPaths,
  context: VaultContext,
): Promise<Readonly<{ account: ReadyAccount; recorded: Recorded }> | null> {
  const account = await accountOf(paths, context);
  if (
    account === "unreadable" ||
    account === "mismatch" ||
    account === null ||
    !isReady(account)
  )
    return null;
  const record = await readRecord(paths).catch(() => null);
  const recorded = record === null ? null : recordedVault(record);
  return recorded === null ? null : { account, recorded };
}

/** Which applications read the Environment's own vault (root decision 0198
 * point 4: personal and work Environments alike): on a work Environment an
 * application of the Organization that owns it (slugs compare as GitHub's,
 * case-insensitively), on a personal one the Personalspace's applications.
 * Null when it may. */
function ownAdmission(
  context: VaultContext,
  application: SecretApplication,
): VaultSecretsRefusal | null {
  if (context.organization === null)
    return application.personalspace ? null : "personal-environment";
  if (application.personalspace) return "personalspace";
  return context.organization.toLowerCase() ===
    application.company.toLowerCase()
    ? null
    : "other-organization";
}

const unsupportedRefusal = (
  reason: VaultUnsupportedReason,
): VaultSecretsRefusal =>
  reason === "workstation" ? "workstation" : "no-vault-identity";

/** Whether an application may read runtime secrets from this Environment's
 * vault, as far as is known without running bw. Null when it may. */
export async function vaultSecretsAdmission(
  host: VaultHost,
  application: SecretApplication,
): Promise<VaultSecretsRefusal | null> {
  const context = await host.context();
  if (context.kind === "unsupported") return unsupportedRefusal(context.reason);
  if (context.kind === "pilot")
    return pilotSecretsAdmission(host, context, application);
  return ownAdmission(context, application);
}

/** The values of the runtime secrets `names` of an application (decision
 * F46, root decision 0177): a sync first, then the one item named exactly
 * so anywhere in the Environment's own vault (any of its collections), its
 * login password the value. Values are returned to the caller only; the
 * journal gets the outcome and a fixed reason. */
export async function vaultSecrets(
  host: VaultHost,
  input: SecretApplication & Readonly<{ names: readonly string[] }>,
): Promise<VaultSecretsResult> {
  const result = await readVaultSecrets(host, input);
  host.journal?.({
    operation: "secrets",
    outcome: result.kind === "vault-secrets" ? "read" : "refused",
    ...(result.kind === "vault-secrets" ? {} : { reason: result.reason }),
  });
  return result;
}

async function readVaultSecrets(
  host: VaultHost,
  input: SecretApplication & Readonly<{ names: readonly string[] }>,
): Promise<VaultSecretsResult> {
  const refuse = (reason: VaultSecretsRefusal): VaultSecretsResult => ({
    kind: "vault-secrets-refused",
    reason,
  });
  const context = await host.context();
  if (context.kind === "unsupported")
    return refuse(unsupportedRefusal(context.reason));
  if (context.kind === "pilot") return pilotSecrets(host, context, input);
  const admission = ownAdmission(context, input);
  if (admission !== null) return refuse(admission);
  const paths = ownPaths(host, context);
  const ready = await connectedAccount(paths, context);
  if (ready === null) return refuse("not-connected");
  const read = await readSecrets(
    () => sharedSession(host, paths, ready.account),
    { organizationId: ready.recorded.organizationId },
    input.names,
  );
  return read.ok
    ? { kind: "vault-secrets", secrets: read.secrets }
    : refuse(read.reason);
}
