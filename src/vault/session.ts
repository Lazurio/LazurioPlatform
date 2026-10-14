import type { FileLock } from "../platform/flock";
import { FileLockError } from "../platform/flock";
import {
  type BwCli,
  type BwFailure,
  type BwSecretItem,
  type BwStatus,
  bwCli,
} from "./bw";
import type { VaultHost } from "./flow";
import { pinnedBinary, pinnedInstalled } from "./install";
import type { VaultSecret } from "./status";
import {
  lockVault,
  type ReadyAccount,
  readSession,
  type VaultPaths,
  writeSession,
} from "./store";

// The one unlocked session of an account (decision F43 point 5, kept by
// F53): every `bw unlock` ends the sessions before it, so the Environment
// keeps one and its agents share it. Used by the Environment's own vault and
// by the frozen 0197 pilot subset alike; nothing here decides which vault an
// Environment has.

export const lockMs = 10_000;

export function cliOf(host: VaultHost, paths: VaultPaths): BwCli {
  return bwCli({
    binary: pinnedBinary(host.base, host.pin),
    data: paths.data,
    home: host.home,
    path: host.path,
    run: host.run,
  });
}

/** Whether bw's profile is signed in to exactly this account at exactly this
 * vault. Anything else (no sign-in, another account or vault, as after an
 * agent's `bw login` in this data directory) is not the Environment's
 * sign-in: it is never used, reported as connected or handed out. */
export function signedInAs(
  state: BwStatus,
  account: Readonly<{ email: string; server: string }>,
): boolean {
  return (
    state.status !== "unauthenticated" &&
    state.userEmail?.toLowerCase() === account.email &&
    state.serverUrl?.replace(/\/+$/, "") === account.server
  );
}

/** `work` under the account's kernel lock, or `busy` when another holder
 * keeps it past `timeoutMs`. */
export async function withLock<T>(
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

export type Session =
  | Readonly<{ ok: true; session: string; fresh: boolean }>
  | Readonly<{ ok: false; reason: BwFailure }>;

/** The recorded session while it is the unlocked one, otherwise a new
 * unlock, written before it is handed out. Only under the account's lock. */
export async function usableSession(
  host: VaultHost,
  bw: BwCli,
  paths: VaultPaths,
  account: ReadyAccount,
): Promise<Session> {
  const current = await readSession(paths).catch(() => null);
  const state = await bw.status(current);
  if (!state.ok) return { ok: false, reason: state.reason };
  if (!signedInAs(state.value, account))
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

export type SharedRefusal =
  | "not-installed"
  | "not-connected"
  | "busy"
  | "unlock-failed";

export type SharedSession =
  | Readonly<{ ok: true; bw: BwCli; session: string }>
  | Readonly<{ ok: false; reason: SharedRefusal }>;

/** The one unlocked session of a connected account, for an agent's shell or
 * a start's secrets. A session that is no longer the unlocked one is
 * replaced under the account's lock; another process that replaced it
 * meanwhile is trusted, so two readers never unlock twice. */
export async function sharedSession(
  host: VaultHost,
  paths: VaultPaths,
  account: ReadyAccount,
): Promise<SharedSession> {
  if (!(await pinnedInstalled(host.base, host.pin)))
    return { ok: false, reason: "not-installed" };
  const bw = cliOf(host, paths);
  const current = await readSession(paths).catch(() => null);
  if (current !== null) {
    const state = await bw.status(current);
    if (state.ok && !signedInAs(state.value, account))
      return { ok: false, reason: "not-connected" };
    if (state.ok && state.value.status === "unlocked")
      return { ok: true, bw, session: current };
  }
  return withLock(
    paths,
    host.lockMs ?? 60_000,
    (): SharedSession => ({ ok: false, reason: "busy" }),
    async () => {
      const session = await usableSession(host, bw, paths, account);
      if (session.ok) return { ok: true, bw, session: session.session };
      return {
        ok: false,
        reason:
          session.reason === "unauthenticated"
            ? "not-connected"
            : "unlock-failed",
      };
    },
  );
}

/** Why the vault gave no values at all (decision F46): of the session, the
 * sync or bw's answer. */
export type ReadRefusal =
  | "not-connected"
  | "locked"
  | "busy"
  | "unreachable"
  | "vault-failed";

/** The values of `names` in one scope of the vault (decision F46): a sync
 * first, so a value changed in the vault takes effect at the next start,
 * then the one item named exactly so in the scope, its login password the
 * value. With `notes` (the Environment's own vault, decision F54) a Secure
 * note gives the value of its one hidden custom field; a note with more than
 * one is `ambiguous`, never guessed. The frozen 0197 pilot reads login
 * passwords only, as before. `connect` gives the shared session (again,
 * when another bw run replaced it meanwhile). Values are returned to the
 * caller only. */
export async function readSecrets(
  connect: () => Promise<SharedSession>,
  scope: Readonly<{ organizationId: string; collectionId?: string }>,
  names: readonly string[],
  options: Readonly<{ notes?: boolean }> = {},
): Promise<
  | Readonly<{ ok: true; secrets: ReadonlyMap<string, VaultSecret> }>
  | Readonly<{ ok: false; reason: ReadRefusal }>
> {
  const sessionRefusal = (reason: SharedRefusal): ReadRefusal =>
    reason === "busy"
      ? "busy"
      : reason === "unlock-failed"
        ? "locked"
        : "not-connected";
  let connected = await connect();
  if (!connected.ok)
    return { ok: false, reason: sessionRefusal(connected.reason) };
  let synced = await connected.bw.sync(connected.session);
  // Replaced by another bw run since the check: once more.
  if (!synced.ok && synced.reason === "locked") {
    connected = await connect();
    if (!connected.ok)
      return { ok: false, reason: sessionRefusal(connected.reason) };
    synced = await connected.bw.sync(connected.session);
  }
  if (!synced.ok)
    return {
      ok: false,
      reason:
        synced.reason === "unauthenticated" ||
        synced.reason === "invalid-credentials"
          ? "not-connected"
          : synced.reason === "locked"
            ? "locked"
            : synced.reason === "unreachable" || synced.reason === "timeout"
              ? "unreachable"
              : "vault-failed",
    };
  const items = await connected.bw.secretItems(
    connected.session,
    scope,
    new Set(names),
  );
  if (!items.ok)
    return {
      ok: false,
      reason: items.reason === "locked" ? "locked" : "vault-failed",
    };
  const secrets = new Map<string, VaultSecret>();
  for (const name of names) {
    const matches = items.value.filter(
      (item) =>
        item.name === name &&
        item.organizationId === scope.organizationId &&
        (scope.collectionId === undefined ||
          item.collectionIds.includes(scope.collectionId)),
    );
    const [only] = matches;
    secrets.set(
      name,
      only === undefined
        ? { kind: "absent", reason: "missing" }
        : matches.length > 1
          ? { kind: "absent", reason: "ambiguous" }
          : secretOf(only, options.notes === true),
    );
  }
  return { ok: true, secrets };
}

/** The value of the one item of a name: its login password, or, where notes
 * count, the one hidden field of a Secure note. */
function secretOf(item: BwSecretItem, notes: boolean): VaultSecret {
  if (item.password !== null && item.password !== "")
    return { kind: "value", value: item.password };
  if (notes && item.hidden !== null) {
    if (item.hidden.count > 1) return { kind: "absent", reason: "ambiguous" };
    if (item.hidden.value !== null && item.hidden.value !== "")
      return { kind: "value", value: item.hidden.value };
  }
  return { kind: "absent", reason: "empty" };
}
