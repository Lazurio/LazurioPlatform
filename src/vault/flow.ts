import { randomUUID } from "node:crypto";
import type { FileLock } from "../platform/flock";
import { FileLockError } from "../platform/flock";
import type { InstallFetch } from "../tools/install";
import type { ToolRunner } from "../tools/status";
import {
  type BwCli,
  type BwCollection,
  type BwFailure,
  type BwOrganization,
  bwCli,
} from "./bw";
import {
  isEnvironmentCollection,
  type VaultContext,
  type VaultUnsupported,
  type VaultUnsupportedReason,
} from "./context";
import { installPinnedBw, pinnedBinary, pinnedInstalled } from "./install";
import type { BitwardenPin } from "./pin";
import {
  DEVICE_TYPE_SDK,
  fetchApiKey,
  generateMasterPassword,
  passwordLogin,
  registerAccount,
  type VaultFetch,
  VaultwardenError,
} from "./register";
import {
  completeAccount,
  createAccount,
  ensureVaultDirectories,
  forgetSignIn,
  forgetUnregisteredAccount,
  isReady,
  lockVault,
  type ReadyAccount,
  readAccount,
  readRecord,
  readSession,
  type VaultPaths,
  type VaultRecord,
  vaultPaths,
  writeRecord,
  writeSession,
} from "./store";

// The Environment vault (decision F43, root decision 0193): one core for the
// CLI (`lazurio vault`) and the Launchpad (Settings → Tools → bitwarden).
// Status-driven and idempotent: every operation reads what is there and
// moves it on, so an interrupted one is completed by the next. Each mutation
// holds the account's kernel lock. Nothing secret is returned but by `env`,
// which hands the session to an agent's shell by design; the journal carries
// the operation, the outcome and a fixed reason, never a value.

/** Where the vault runs: trusted composition, never HTTP input. */
export type VaultHost = Readonly<{
  /** The Environment's vault, or why it has none here; read at the start
   * of every operation. */
  context: () => Promise<VaultContext | VaultUnsupported>;
  /** The account's state directory: its vault host and the Environment's
   * address, the account's whole identity. */
  directory: (identity: Pick<VaultContext, "host" | "address">) => string;
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
  now?: (() => Date) | undefined;
  /** How long a mutation waits for another one (default 10 s; connect,
   * which may download the CLI, waits longer). */
  lockMs?: number | undefined;
}>;

export type VaultJournalEntry = Readonly<{
  operation: "connect" | "refresh" | "disconnect" | "unlock";
  outcome: string;
  reason?: string;
}>;

/** What the row and the dialog show, in every state. */
export type VaultFacts = Readonly<{
  /** `https://vaultwarden.<zone>` */
  vault: string;
  /** `vaultwarden@<Environment address>` */
  account: string;
  /** The Environment's collection: the one it is connected to, otherwise
   * the name the operator gives it. */
  collection: string;
  /** The Environment's name in the collection. */
  name: string;
  /** A Team's Environment: the whole Team sees the collection. */
  team: boolean;
}>;

export type VaultFailureStage =
  | "install"
  | "account"
  | "sign-in"
  | "sync"
  | "status";

export type VaultStatus =
  | Readonly<{
      kind: "vault-status";
      state: "unsupported";
      reason: VaultUnsupportedReason;
    }>
  | (VaultFacts &
      Readonly<{
        kind: "vault-status";
        /** `not-installed`: the pinned CLI is not here; `none`: no account
         * signed in. `registered`: the account exists in the vault
         * (connecting again only signs it in). */
        state: "not-installed" | "none";
        registered: boolean;
      }>)
  | (VaultFacts &
      Readonly<{
        kind: "vault-status";
        /** The vault refused the registration: the address is not invited
         * (yet). Nothing was left behind. */
        state: "awaiting-invite";
      }>)
  | (VaultFacts &
      Readonly<{
        kind: "vault-status";
        /** Signed in; the organization or the collection is not visible
         * yet: an Admin confirms the member by its fingerprint. */
        state: "confirming";
        fingerprint: string;
        /** A confirmed organization without the collection, when there is
         * one. */
        organization: string | null;
        /** The session is not the unlocked one; refresh unlocks it. */
        locked?: true;
      }>)
  | (VaultFacts &
      Readonly<{
        kind: "vault-status";
        state: "connected";
        fingerprint: string;
        organization: string | null;
        /** How many collections and items the account sees; null when the
         * session was not unlocked (refresh unlocks it). */
        collections: number | null;
        items: number | null;
        locked?: true;
      }>)
  | (VaultFacts &
      Readonly<{
        kind: "vault-status";
        /** It was connected; the organization or the collection is gone. */
        state: "revoked";
        fingerprint: string | null;
      }>)
  | (VaultFacts &
      Readonly<{
        kind: "vault-status";
        state: "unreachable";
        fingerprint: string | null;
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

export type VaultPhase = "install" | "account" | "sign-in";

/** What `lazurio vault env` hands an agent's shell. */
export type VaultEnvironment = Readonly<{
  BITWARDENCLI_APPDATA_DIR: string;
  BW_SESSION: string;
  LAZURIO_VAULT_ORGANIZATION_ID: string;
  LAZURIO_VAULT_COLLECTION_ID: string;
}>;

export type VaultEnvResult =
  | Readonly<{ kind: "vault-env"; env: VaultEnvironment }>
  | Readonly<{
      kind: "vault-env-refused";
      reason:
        | VaultUnsupportedReason
        | "not-installed"
        | "not-connected"
        | "busy"
        | "unlock-failed";
    }>;

const lockMs = 10_000;
const connectLockMs = 15 * 60_000;

const factsOf = (context: VaultContext): VaultFacts => ({
  vault: context.vault,
  account: context.account,
  collection: context.collection,
  name: context.name,
  team: context.kind === "team",
});

function cliOf(host: VaultHost, paths: VaultPaths): BwCli {
  return bwCli({
    binary: pinnedBinary(host.base, host.pin),
    data: paths.data,
    home: host.home,
    path: host.path,
    run: host.run,
  });
}

/** The account's own collection among those it sees: the one named as the
 * operator was shown, the one it was connected to, or the only one named
 * for this machine. */
export function environmentCollection(
  collections: readonly BwCollection[],
  context: VaultContext,
  record: VaultRecord,
): BwCollection | undefined {
  const exact = collections.find((entry) => entry.name === context.collection);
  if (exact !== undefined) return exact;
  const recorded = collections.find(
    (entry) => entry.id === record.collectionId,
  );
  if (recorded !== undefined) return recorded;
  const named = collections.filter((entry) =>
    isEnvironmentCollection(entry.name, context),
  );
  return named.length === 1 ? named[0] : undefined;
}

type Observation =
  | Readonly<{
      kind: "connected";
      organization: BwOrganization | undefined;
      collection: BwCollection;
      collections: number;
      items: number | null;
    }>
  | Readonly<{ kind: "confirming"; organization: string | null }>
  | Readonly<{ kind: "revoked" }>
  | Readonly<{ kind: "failed"; reason: BwFailure }>;

/** What the account sees in bw's local copy, as of its last sync. A
 * collection counts only in a confirmed organization; an organization
 * reported as revoked, or a recorded collection that is gone, is a revoked
 * access. */
async function observe(
  bw: BwCli,
  session: string,
  context: VaultContext,
  record: VaultRecord,
): Promise<Observation> {
  const organizations = await bw.organizations(session);
  if (!organizations.ok)
    return { kind: "failed", reason: organizations.reason };
  const collections = await bw.collections(session);
  if (!collections.ok) return { kind: "failed", reason: collections.reason };
  const confirmed = organizations.value.filter((entry) => entry.status === 2);
  const visible = collections.value.filter((entry) =>
    confirmed.some((organization) => organization.id === entry.organizationId),
  );
  const own = environmentCollection(visible, context, record);
  if (own !== undefined) {
    const items = await bw.itemCount(session);
    return {
      kind: "connected",
      organization: confirmed.find((entry) => entry.id === own.organizationId),
      collection: own,
      collections: visible.length,
      items: items.ok ? items.value : null,
    };
  }
  if (
    record.collectionId !== null ||
    organizations.value.some((entry) => entry.status === -1)
  )
    return { kind: "revoked" };
  return { kind: "confirming", organization: confirmed[0]?.name ?? null };
}

async function fingerprintOf(
  bw: BwCli,
  session: string,
  record: VaultRecord,
): Promise<string | null> {
  if (record.fingerprint !== null) return record.fingerprint;
  const read = await bw.fingerprint(session);
  return read.ok ? read.value : null;
}

/** The status of an observation with the facts. */
function statusOf(
  facts: VaultFacts,
  observation: Exclude<Observation, { kind: "failed" }>,
  fingerprint: string | null,
): VaultStatus {
  if (observation.kind === "revoked")
    return { kind: "vault-status", state: "revoked", ...facts, fingerprint };
  if (fingerprint === null)
    return failedStatus(facts, "status", "fingerprint-unreadable");
  if (observation.kind === "confirming")
    return {
      kind: "vault-status",
      state: "confirming",
      ...facts,
      fingerprint,
      organization: observation.organization,
    };
  return {
    kind: "vault-status",
    state: "connected",
    ...facts,
    collection: observation.collection.name,
    fingerprint,
    organization: observation.organization?.name ?? null,
    collections: observation.collections,
    items: observation.items,
  };
}

function failedStatus(
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

/** The status of a session that is not the unlocked one, from the record:
 * nothing is unlocked by a read. */
function lockedStatus(facts: VaultFacts, record: VaultRecord): VaultStatus {
  if (record.fingerprint === null)
    return failedStatus(facts, "status", "locked");
  if (record.collectionId !== null)
    return {
      kind: "vault-status",
      state: "connected",
      ...facts,
      fingerprint: record.fingerprint,
      organization: null,
      collections: null,
      items: null,
      locked: true,
    };
  return {
    kind: "vault-status",
    state: "confirming",
    ...facts,
    fingerprint: record.fingerprint,
    organization: null,
    locked: true,
  };
}

type Prepared =
  | Readonly<{ kind: "status"; status: VaultStatus }>
  | Readonly<{
      kind: "ready";
      context: VaultContext;
      facts: VaultFacts;
      paths: VaultPaths;
    }>;

async function prepare(host: VaultHost): Promise<Prepared> {
  const context = await host.context();
  if (context.kind === "unsupported")
    return {
      kind: "status",
      status: {
        kind: "vault-status",
        state: "unsupported",
        reason: context.reason,
      },
    };
  return {
    kind: "ready",
    context,
    facts: factsOf(context),
    paths: vaultPaths(host.directory(context)),
  };
}

const none = (
  facts: VaultFacts,
  state: "not-installed" | "none",
  registered: boolean,
): VaultStatus => ({ kind: "vault-status", state, ...facts, registered });

/** The account file, or a failure when it is there and unreadable or not
 * this Environment's account (never replaced: it holds the only copy of the
 * account's password). An account serves only the Environment whose address
 * and vault it carries; its directory is keyed by them, and this holds even
 * when a file is not where it belongs. */
async function accountOf(
  paths: VaultPaths,
  context: VaultContext,
): Promise<
  Awaited<ReturnType<typeof readAccount>> | "unreadable" | "mismatch"
> {
  let account: Awaited<ReturnType<typeof readAccount>>;
  try {
    account = await readAccount(paths);
  } catch {
    return "unreadable";
  }
  return account !== null &&
    (account.email !== context.account || account.server !== context.vault)
    ? "mismatch"
    : account;
}

/** `status`: local, no network, no mutation. */
export async function vaultStatus(host: VaultHost): Promise<VaultStatus> {
  const prepared = await prepare(host);
  if (prepared.kind === "status") return prepared.status;
  const { context, facts, paths } = prepared;
  const account = await accountOf(paths, context);
  if (account === "unreadable")
    return failedStatus(facts, "account", "account-unreadable");
  if (account === "mismatch")
    return failedStatus(facts, "account", "account-mismatch");
  const ready = account !== null && isReady(account);
  if (!(await pinnedInstalled(host.base, host.pin)))
    return none(facts, "not-installed", ready);
  if (!ready) return none(facts, "none", false);
  const bw = cliOf(host, paths);
  const record = await readRecord(paths);
  const session = await readSession(paths).catch(() => null);
  if (session === null) {
    const state = await bw.status(null);
    if (state.ok && state.value.status === "unauthenticated")
      return none(facts, "none", true);
    return lockedStatus(facts, record);
  }
  const observation = await observe(bw, session, context, record);
  if (observation.kind === "failed") {
    if (observation.reason === "unauthenticated")
      return none(facts, "none", true);
    if (observation.reason === "locked") return lockedStatus(facts, record);
    return failedStatus(facts, "status", observation.reason);
  }
  return statusOf(facts, observation, await fingerprintOf(bw, session, record));
}

async function locked<T>(
  paths: VaultPaths,
  timeoutMs: number,
  busy: () => T | Promise<T>,
  work: () => Promise<T>,
): Promise<T> {
  let lock: FileLock;
  try {
    lock = await lockVault(paths, timeoutMs);
  } catch (error) {
    if (error instanceof FileLockError && error.reason === "busy")
      return busy();
    throw error;
  }
  try {
    return await work();
  } finally {
    await lock.release();
  }
}

type Session =
  | Readonly<{ ok: true; session: string; fresh: boolean }>
  | Readonly<{ ok: false; reason: BwFailure }>;

/** The one session of the Environment: the recorded one while it is the
 * unlocked one, otherwise a new unlock, written before it is handed out.
 * Only under the account's lock. */
async function usableSession(
  host: VaultHost,
  bw: BwCli,
  paths: VaultPaths,
  account: ReadyAccount,
): Promise<Session> {
  const current = await readSession(paths).catch(() => null);
  const state = await bw.status(current);
  if (!state.ok) return { ok: false, reason: state.reason };
  if (state.value.status === "unauthenticated")
    return { ok: false, reason: "unauthenticated" };
  if (state.value.status === "unlocked" && current !== null)
    return { ok: true, session: current, fresh: false };
  const unlocked = await bw.unlock(account.masterPassword);
  host.journal?.({
    operation: "unlock",
    outcome: unlocked.ok ? "unlocked" : "failed",
    ...(unlocked.ok ? {} : { reason: unlocked.reason }),
  });
  if (!unlocked.ok) return unlocked;
  await writeSession(paths, unlocked.value);
  return { ok: true, session: unlocked.value, fresh: true };
}

/** `refresh`: a sync with the vault, a new unlock when the session is no
 * longer the unlocked one, and the status after it. */
export async function vaultRefresh(host: VaultHost): Promise<VaultStatus> {
  const prepared = await prepare(host);
  if (prepared.kind === "status") return prepared.status;
  const { context, facts, paths } = prepared;
  const account = await accountOf(paths, context);
  if (
    account === "unreadable" ||
    account === "mismatch" ||
    account === null ||
    !isReady(account) ||
    !(await pinnedInstalled(host.base, host.pin))
  )
    return vaultStatus(host);
  return locked(
    paths,
    host.lockMs ?? lockMs,
    () => vaultStatus(host),
    async () => {
      const bw = cliOf(host, paths);
      const record = await readRecord(paths);
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
            ? none(facts, "none", true)
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
      const fingerprint = await fingerprintOf(bw, session.session, record);
      if (!synced.ok) {
        if (synced.reason === "unauthenticated")
          return journal(none(facts, "none", true));
        if (synced.reason === "invalid-credentials")
          return journal({
            kind: "vault-status",
            state: "revoked",
            ...facts,
            fingerprint,
          });
        // The CLI itself did not run: not a question of the vault.
        if (synced.reason === "spawn-failed")
          return journal(failedStatus(facts, "sync", synced.reason));
        return journal({
          kind: "vault-status",
          state: "unreachable",
          ...facts,
          fingerprint,
          reason: synced.reason,
        });
      }
      const observation = await observe(bw, session.session, context, record);
      if (observation.kind === "failed")
        return journal(failedStatus(facts, "status", observation.reason));
      await recordObservation(paths, record, observation, fingerprint);
      return journal(statusOf(facts, observation, fingerprint));
    },
  );
}

/** The record follows what was seen: the fingerprint always, the collection
 * once connected. A revoked access keeps it, so the row says so until the
 * operator connects again. */
async function recordObservation(
  paths: VaultPaths,
  record: VaultRecord,
  observation: Exclude<Observation, { kind: "failed" }>,
  fingerprint: string | null,
): Promise<void> {
  await writeRecord(paths, {
    fingerprint: fingerprint ?? record.fingerprint,
    organizationId:
      observation.kind === "connected"
        ? observation.collection.organizationId
        : record.organizationId,
    collectionId:
      observation.kind === "connected"
        ? observation.collection.id
        : record.collectionId,
  }).catch(() => undefined);
}

type AccountOutcome =
  | Readonly<{ kind: "ready"; account: ReadyAccount }>
  | Readonly<{ kind: "status"; status: VaultStatus }>;

/** The account: created once with a password generated here, written before
 * the registration (the vault refuses a second one, so a lost password
 * would need an Admin), registered, logged in with the Environment's one
 * device identifier, and its API key added. An unfinished one is resumed:
 * logged in when the vault has it, registered when it does not. */
async function ensureAccount(
  host: VaultHost,
  context: VaultContext,
  facts: VaultFacts,
  paths: VaultPaths,
): Promise<AccountOutcome> {
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
    return { kind: "ready", account: existing };
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
  const device = {
    identifier: account.deviceIdentifier,
    name: "Lazurio Launchpad",
    type: DEVICE_TYPE_SDK,
  };
  const login = () =>
    passwordLogin(client, {
      serverUrl: context.vault,
      email: account.email,
      password: account.masterPassword,
      device,
    });
  const failure = (error: unknown): AccountOutcome => {
    const reason =
      error instanceof VaultwardenError ? error.reason : "unexpected";
    return {
      kind: "status",
      status:
        reason === "unreachable"
          ? {
              kind: "vault-status",
              state: "unreachable",
              ...facts,
              fingerprint: null,
              reason,
            }
          : failedStatus(facts, "account", reason),
    };
  };
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
        return failure(error);
    }
  }
  if (session === undefined) {
    try {
      await registerAccount(client, {
        serverUrl: context.vault,
        email: account.email,
        password: account.masterPassword,
        name: `Environment ${context.name} · ${context.machine}`,
      });
    } catch (error) {
      if (error instanceof VaultwardenError && error.reason === "not-invited") {
        // Nothing is left behind: the vault has no account with it.
        await forgetUnregisteredAccount(paths);
        return {
          kind: "status",
          status: { kind: "vault-status", state: "awaiting-invite", ...facts },
        };
      }
      return failure(error);
    }
    try {
      session = await login();
    } catch (error) {
      return failure(error);
    }
  }
  try {
    const key = await fetchApiKey(client, session);
    return {
      kind: "ready",
      account: await completeAccount(paths, account, key),
    };
  } catch (error) {
    return failure(error);
  }
}

/** `connect`: installs the pinned CLI, creates the account when there is
 * none, signs it in with its API key, unlocks the one session and syncs.
 * Connecting again after a revoked access starts a new confirmation: the
 * record of the collection is dropped. Never runs twice at once. */
export async function vaultConnect(
  host: VaultHost,
  onPhase: (phase: VaultPhase) => void = () => undefined,
): Promise<VaultStatus> {
  const prepared = await prepare(host);
  if (prepared.kind === "status") return prepared.status;
  const { context, facts, paths } = prepared;
  const journal = (status: VaultStatus) => {
    host.journal?.({
      operation: "connect",
      outcome: status.state,
      ...("reason" in status ? { reason: status.reason } : {}),
    });
    return status;
  };
  await ensureVaultDirectories(paths);
  return locked(
    paths,
    host.lockMs ?? connectLockMs,
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
      onPhase("sign-in");
      const bw = cliOf(host, paths);
      const signedIn = await signIn(bw, account.account);
      if (!signedIn.ok)
        return journal(
          signedIn.reason === "unreachable" || signedIn.reason === "timeout"
            ? {
                kind: "vault-status",
                state: "unreachable",
                ...facts,
                fingerprint: null,
                reason: signedIn.reason,
              }
            : failedStatus(facts, "sign-in", signedIn.reason),
        );
      const session = await usableSession(host, bw, paths, account.account);
      if (!session.ok)
        return journal(failedStatus(facts, "sign-in", session.reason));
      const synced = await bw.sync(session.session);
      const empty: VaultRecord = {
        fingerprint: null,
        organizationId: null,
        collectionId: null,
      };
      const fingerprint = await fingerprintOf(bw, session.session, empty);
      if (!synced.ok)
        return journal(
          synced.reason === "unreachable" || synced.reason === "timeout"
            ? {
                kind: "vault-status",
                state: "unreachable",
                ...facts,
                fingerprint,
                reason: synced.reason,
              }
            : failedStatus(facts, "sync", synced.reason),
        );
      const observation = await observe(bw, session.session, context, empty);
      if (observation.kind === "failed")
        return journal(failedStatus(facts, "status", observation.reason));
      await writeRecord(paths, empty).catch(() => undefined);
      await recordObservation(paths, empty, observation, fingerprint);
      return journal(statusOf(facts, observation, fingerprint));
    },
  );
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
  const signedIn = state.value.status !== "unauthenticated";
  if (
    signedIn &&
    state.value.userEmail?.toLowerCase() === account.email &&
    state.value.serverUrl?.replace(/\/+$/, "") === account.server
  )
    return { ok: true };
  if (signedIn) {
    const out = await bw.logout(null);
    if (!out.ok) return out;
  }
  const configured = await bw.configServer(account.server);
  if (!configured.ok) return configured;
  const login = await bw.loginApiKey(account.clientId, account.clientSecret);
  return login.ok ? { ok: true } : login;
}

/** `disconnect`: bw signs out and its store, the session and the record go;
 * the account stays in the vault and in its file, so connecting again signs
 * the same account in. Access ends completely only when an Admin removes the
 * account in the vault. */
export async function vaultDisconnect(host: VaultHost): Promise<VaultStatus> {
  const prepared = await prepare(host);
  if (prepared.kind === "status") return prepared.status;
  const { context, facts, paths } = prepared;
  const result = await locked(
    paths,
    host.lockMs ?? lockMs,
    () => failedStatus(facts, "sign-in", "busy"),
    async () => {
      // Another account's file is neither signed out nor cleared here.
      if ((await accountOf(paths, context)) === "mismatch")
        return failedStatus(facts, "account", "account-mismatch");
      if (await pinnedInstalled(host.base, host.pin)) {
        const session = await readSession(paths).catch(() => null);
        await cliOf(host, paths).logout(session);
      }
      await forgetSignIn(paths);
      return null;
    },
  );
  const status = result ?? (await vaultStatus(host));
  host.journal?.({
    operation: "disconnect",
    outcome: result === null ? "disconnected" : status.state,
    ...(status.state === "failed" ? { reason: status.reason } : {}),
  });
  return status;
}

/** `env`: the session for an agent's shell. A session that is no longer the
 * unlocked one is replaced under the account's lock; another process that
 * replaced it meanwhile is trusted, so two agents never unlock twice. */
export async function vaultEnv(host: VaultHost): Promise<VaultEnvResult> {
  const refuse = (
    reason: Extract<VaultEnvResult, { kind: "vault-env-refused" }>["reason"],
  ): VaultEnvResult => ({ kind: "vault-env-refused", reason });
  const context = await host.context();
  if (context.kind === "unsupported") return refuse(context.reason);
  const paths = vaultPaths(host.directory(context));
  if (!(await pinnedInstalled(host.base, host.pin)))
    return refuse("not-installed");
  const account = await accountOf(paths, context);
  if (
    account === "unreadable" ||
    account === "mismatch" ||
    account === null ||
    !isReady(account)
  )
    return refuse("not-connected");
  const record = await readRecord(paths);
  if (record.organizationId === null || record.collectionId === null)
    return refuse("not-connected");
  const { organizationId, collectionId } = record;
  const answer = (session: string): VaultEnvResult => ({
    kind: "vault-env",
    env: {
      BITWARDENCLI_APPDATA_DIR: paths.data,
      BW_SESSION: session,
      LAZURIO_VAULT_ORGANIZATION_ID: organizationId,
      LAZURIO_VAULT_COLLECTION_ID: collectionId,
    },
  });
  const bw = cliOf(host, paths);
  const current = await readSession(paths).catch(() => null);
  if (current !== null) {
    const state = await bw.status(current);
    if (state.ok && state.value.status === "unlocked") return answer(current);
    if (state.ok && state.value.status === "unauthenticated")
      return refuse("not-connected");
  }
  return locked(
    paths,
    host.lockMs ?? 60_000,
    () => refuse("busy"),
    async () => {
      const session = await usableSession(host, bw, paths, account);
      if (session.ok) return answer(session.session);
      return refuse(
        session.reason === "unauthenticated"
          ? "not-connected"
          : "unlock-failed",
      );
    },
  );
}
