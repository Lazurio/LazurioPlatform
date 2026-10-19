import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { acquireFileLock, FileLockError } from "../platform/flock";
import { parseUniqueJson } from "../providers/unique-json";
import { syncDirectory, writeDurableFile } from "../update/durable-file";
import type { BitwardenConnection } from "./context";
import {
  type BitwardenRegion,
  bitwardenRegions,
  isBitwardenRegion,
} from "./endpoints";
import { connectedAccount, deviceOf, ownPaths, type VaultHost } from "./flow";
import { pinnedInstalled } from "./install";
import { type VaultMembership, vaultMembership } from "./members";
import { carriesReceipt } from "./organization";
import {
  type ApiKeyLogin,
  accountKdf,
  apiKeyLogin,
  type Device,
  normalizeEmail,
  unlockPrivateKey,
  type VaultClient,
  VaultwardenError,
  vaultRequest,
} from "./register";
import { cliOf, lockMs, withLock } from "./session";
import {
  emptyRecord,
  forgetEnteredAccount,
  isEnteredEmail,
  isEnteredPassword,
  isVaultId,
  plainObject,
  type ReadyAccount,
  readOwned,
  readRecord,
  serialize,
  type VaultRecord,
  vaultPaths,
  writeEnteredAccount,
  writeRecord,
} from "./store";

// A personal Environment's own Bitwarden (root decision 0203 point 7, plan
// DEV-6631 task 775). A personal Environment no longer uses a Lazurio
// Vaultwarden: its person connects a Bitwarden of their choice, the
// Bitwarden cloud in the EU or the US, through a separate agents' account,
// never their main account. The cloud verifies e-mail on sign-up, so the
// person creates the agents' account and its API key and enters them once,
// with the account's master password, in Apps → Vault; which region it
// is in, the Environment finds itself (F53's amendment of 2026-10-16, (2)).
// From then on the Environment works on its own (flow.ts): it creates its
// vault, a Free organization for the agents' account (Owner). The person
// joins it only when they ask to: they enter the address of their own
// Bitwarden account afterwards, and the Environment invites it
// (`invitePersonalBitwarden`, invitee.ts).
//
// Connecting checks everything before anything is written: the API key
// signs in at the EU's identity host, or at the US's only where the EU's
// answers that it does not know the key (`invalid_client`), the profile
// names the agents' account, and the master password
// opens the account's keys with the KDF the cloud reports (PBKDF2 or
// Argon2id). Only then are the account's credentials written, whole, into
// the custody of decision F53 (the one place the Platform writes
// credentials, docs/public-development.md), and the connection beside it:
//
//   <state>/lazurio/vault/personal/                0700
//     lock                                         the kernel lock of
//                                                  connecting, inviting and
//                                                  disconnecting
//     connection.json                              0600, not secret: the
//                                                  region that accepted the
//                                                  key, the agents' account,
//                                                  the person's account to
//                                                  invite once they ask
//   <state>/lazurio/vault/<web host>/<account>/    the account's custody
//
// Disconnecting removes the account's credentials, its session and bw's
// store and signs bw out; the organization stays in Bitwarden, and the
// record of its ID stays here, so the same account connected again finds
// its vault. No value is ever returned, logged or journaled, and none
// reaches a process's arguments.

/** The fields of the connection form, exactly: the agents' account's API
 * key as Bitwarden's "API key" dialog names it, and its master password.
 * No region and no person: the region is the one that accepts the key,
 * and the person joins afterwards (`inviteeFields`). */
export const connectionFields = [
  "clientId",
  "clientSecret",
  "masterPassword",
] as const;

export type ConnectionInput = Readonly<
  Record<(typeof connectionFields)[number], unknown>
>;

/** The field of the invitation, exactly: the address of the person's own
 * Bitwarden account. */
export const inviteeFields = ["email"] as const;

export type InviteeInput = Readonly<
  Record<(typeof inviteeFields)[number], unknown>
>;

/** Why a value of the form is not one. */
export type ConnectionInvalid =
  | "client-id-invalid"
  | "client-secret-invalid"
  | "password-invalid";

/** Why a connection was not made, an invitation not asked for or a
 * disconnect not done: a fixed code, never a value or the cloud's words. */
export type ConnectionRefusal =
  | ConnectionInvalid
  /** The invitation's address is not an ordinary address. */
  | "email-invalid"
  /** Not offered here: only a personal Environment whose handover names no
   * vault connects its person's own Bitwarden; every other keeps the vault
   * its handover names, or has none here. */
  | "not-offered"
  /** A 0197 pilot's vault is read as before; nothing connects over it. */
  | "pilot-0197"
  /** Connected already: disconnect first. */
  | "connected"
  /** Nothing to disconnect, or nothing connected (or no vault yet) to
   * invite the person into. */
  | "not-connected"
  /** Neither region knows the API key: each identity server answered
   * `invalid_client` (register.ts `unknownClientAnswer`). */
  | "invalid-credentials"
  /** A region's identity server refused the API key otherwise than as
   * unknown (`invalid_request`, `invalid_grant`, an `access_denied`, another
   * 4xx): the account cannot sign in there now, and the person checks it in
   * Bitwarden. The other region is never asked in its place. */
  | "account-refused"
  /** The master password does not open the agents' account. */
  | "wrong-password"
  /** The address to invite is the agents' account: the person's own
   * account is another one. */
  | "same-account"
  /** Another address is invited already: disconnect and connect again to
   * invite another one. */
  | "invited"
  /** The agents' account owns or administers an organization already, other
   * than this Environment's own vault: not a separate agents' account, and
   * the cloud would refuse it a second Free organization. A fresh agents'
   * account connects. */
  | "owns-organization"
  /** A KDF other than PBKDF2-SHA256 and Argon2id, or out of their bounds. */
  | "unsupported-kdf"
  /** Keys of another form than Bitwarden's v1 account keys. */
  | "unsupported-keys"
  | "rate-limited"
  /** A region's identity host or the cloud's API did not answer: no region
   * is guessed. */
  | "unreachable"
  /** Another operation holds the lock. */
  | "busy"
  /** Any other answer of the cloud. */
  | "failed";

export type ConnectionAnswer =
  | Readonly<{ kind: "vault-connected" }>
  | Readonly<{ kind: "vault-connection-refused"; reason: ConnectionRefusal }>;

type Refused = Readonly<{
  kind: "vault-connection-refused";
  reason: ConnectionRefusal;
}>;

const refused = (reason: ConnectionRefusal): Refused =>
  Object.freeze({ kind: "vault-connection-refused", reason });

type Values = Readonly<{
  clientId: string;
  clientSecret: string;
  masterPassword: string;
}>;

/** The form's values, each in its exact form, or the first that is not:
 * the API key as Bitwarden issues it and the master password on one line.
 * The API key is trimmed (a copy brings white space along); the master
 * password is taken exactly as typed. */
export function connectionValues(
  input: ConnectionInput,
):
  | Readonly<{ ok: true; values: Values }>
  | Readonly<{ ok: false; reason: ConnectionInvalid }> {
  const fail = (reason: ConnectionInvalid) =>
    Object.freeze({ ok: false as const, reason });
  const trimmed = (value: unknown) =>
    typeof value === "string" ? value.trim() : null;
  const clientId = trimmed(input.clientId)?.toLowerCase() ?? null;
  if (clientId === null || !/^user\.[0-9a-f-]{36}$/.test(clientId))
    return fail("client-id-invalid");
  const clientSecret = trimmed(input.clientSecret);
  if (clientSecret === null || !/^[A-Za-z0-9]{8,128}$/.test(clientSecret))
    return fail("client-secret-invalid");
  if (!isEnteredPassword(input.masterPassword)) return fail("password-invalid");
  return Object.freeze({
    ok: true as const,
    values: Object.freeze({
      clientId,
      clientSecret,
      masterPassword: input.masterPassword,
    }),
  });
}

/** The address of the person's own Bitwarden account as typed: trimmed and
 * lowercased, as Bitwarden keeps it, or null when it is not an ordinary
 * address. */
export function inviteeValue(input: InviteeInput): string | null {
  const email =
    typeof input.email === "string" ? normalizeEmail(input.email) : null;
  return isEnteredEmail(email) ? email : null;
}

// --- The connection file ------------------------------------------------

const connectionFile = (directory: string) =>
  join(directory, "connection.json");

/** The connection a personal Environment's person made, or null when there
 * is none. Its `invitee` is null until the person asks to be invited. A
 * file that is there but is not one throws: nothing is guessed
 * (`connection-unreadable`). */
export async function readConnection(
  directory: string,
): Promise<BitwardenConnection | null> {
  const text = await readOwned(connectionFile(directory));
  if (text === null) return null;
  const value = plainObject(parseUniqueJson(text));
  if (
    value === null ||
    Object.keys(value).sort().join() !== "account,invitee,region" ||
    !isBitwardenRegion(value.region) ||
    !isEnteredEmail(value.account) ||
    !(value.invitee === null || isEnteredEmail(value.invitee)) ||
    value.account === value.invitee
  )
    throw new Error("Invalid vault connection");
  return Object.freeze({
    region: value.region,
    account: value.account,
    invitee: value.invitee,
  });
}

/** The connection written whole, durably. */
const writeConnection = (directory: string, connection: BitwardenConnection) =>
  writeDurableFile(
    directory,
    "connection.json",
    serialize({
      region: connection.region,
      account: connection.account,
      invitee: connection.invitee,
    }),
  );

async function ensureConnectionDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const entry = await lstat(directory);
  if (!entry.isDirectory() || entry.isSymbolicLink())
    throw new Error("Vault connection directory is not a directory");
  await chmod(directory, 0o700);
}

/** Work under the lock of connecting, inviting and disconnecting (the
 * host's lock timeout, as the account's lock), or `busy`. */
async function underConnectionLock<T>(
  host: Pick<VaultHost, "connection" | "lockMs">,
  busy: () => T,
  work: () => Promise<T>,
): Promise<T> {
  const directory = host.connection;
  await ensureConnectionDirectory(directory);
  let lock: Awaited<ReturnType<typeof acquireFileLock>>;
  try {
    lock = await acquireFileLock(join(directory, "lock"), {
      timeoutMs: host.lockMs ?? lockMs,
    });
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

// --- Connecting -----------------------------------------------------------

const refusalOf = (error: unknown): ConnectionRefusal => {
  if (!(error instanceof VaultwardenError)) return "failed";
  switch (error.reason) {
    // Unknown to the region asked last, or refused there for another reason.
    case "invalid-credentials":
      return error.unknownClient ? "invalid-credentials" : "account-refused";
    case "wrong-password":
    case "unsupported-kdf":
    case "unsupported-keys":
    case "rate-limited":
    case "unreachable":
      return error.reason;
    default:
      return "failed";
  }
};

/** What a profile says of its account's organizations against the record
 * this Environment keeps for it: whether the account owns or administers an
 * organization that is not provably this Environment's vault, and whether
 * the recorded vault is gone from its memberships (a person deleted it in
 * Bitwarden). The recorded vault (an earlier connection of the same account)
 * is this Environment's. While a creation's receipt is unresolved, one more
 * Owner or Admin organization may be: only the one whose public key the
 * vault's API shows the account (`ask`, its token) as that receipt, by the
 * test the setup finds its creation with (`carriesReceipt`). Any other
 * Owner or Admin organization, one whose key is refused, and a second one
 * that carries the receipt count as another organization (fail closed); a
 * failure of the API throws. Every entry must read; null otherwise. */
async function organizationsOf(
  profile: Record<string, unknown>,
  record: VaultRecord,
  ask: (path: string) => Promise<unknown>,
): Promise<Readonly<{ ownsOther: boolean; recordedGone: boolean }> | null> {
  if (!Array.isArray(profile.organizations)) return null;
  const administered: string[] = [];
  let recordedListed = false;
  for (const entry of profile.organizations) {
    const organization = plainObject(entry);
    if (
      organization === null ||
      !isVaultId(organization.id) ||
      typeof organization.type !== "number"
    )
      return null;
    if (organization.id === record.organizationId) recordedListed = true;
    else if (organization.type === 0 || organization.type === 1)
      administered.push(organization.id);
  }
  const recordedGone =
    record.organizationId !== null &&
    record.pendingKey === null &&
    !recordedListed;
  const { pendingKey } = record;
  if (pendingKey === null)
    return { ownsOther: administered.length > 0, recordedGone };
  let carrying = 0;
  for (const id of administered) {
    if ((await carriesReceipt(ask, id, pendingKey)) !== "carries")
      return { ownsOther: true, recordedGone };
    carrying += 1;
  }
  return { ownsOther: carrying > 1, recordedGone };
}

/** The regions in the order the API key is tried: the EU first. */
const regionOrder: readonly BitwardenRegion[] = ["eu", "us"];

/** The API key signed in at the region whose identity host accepts it: the
 * EU's first, the US's only where the EU's identity server answers that it
 * does not know the key, HTTP 400 `invalid_client` and nothing else
 * (register.ts `unknownClientAnswer`, after bitwarden/server's Identity and
 * Duende IdentityServer 7.4.6). Both answering so is `invalid-credentials`.
 * Any other answer of the first region stops there: another refusal
 * (`invalid_request`, `invalid_grant`, an `access_denied`, another 4xx) as
 * `account-refused`, a rate limit as `rate-limited`, and a host that does not
 * answer or answers 5xx as `unreachable`; the other region is never tried in
 * its place, so a region is never guessed. */
async function regionLogin(
  client: VaultClient,
  values: Values,
  device: Device,
): Promise<Readonly<{ region: BitwardenRegion; login: ApiKeyLogin }>> {
  for (const [index, region] of regionOrder.entries()) {
    try {
      const login = await apiKeyLogin(client, {
        serverUrl: bitwardenRegions[region].web,
        clientId: values.clientId,
        clientSecret: values.clientSecret,
        device,
      });
      return { region, login };
    } catch (error) {
      if (
        index === regionOrder.length - 1 ||
        !(error instanceof VaultwardenError) ||
        error.reason !== "invalid-credentials" ||
        !error.unknownClient
      )
        throw error;
    }
  }
  throw new VaultwardenError("invalid-credentials", 400, true);
}

/** The agents' account the values name, checked as a client unlocks it:
 * signed in with its API key at the identity host of the region that
 * accepts it (`regionLogin`), named by its profile, a separate agents'
 * account (owning or administering no organization but this Environment's
 * vault: agents holding its credentials would reach that organization's
 * items too), its keys opened by the master password with the KDF the cloud
 * reports. Nothing is written; the answer holds the region, the account to
 * keep and, when the vault recorded for it is gone from Bitwarden, its ID
 * (`gone`). */
async function verifiedAccount(
  host: VaultHost,
  values: Values,
): Promise<
  | Readonly<{
      ok: true;
      region: BitwardenRegion;
      account: ReadyAccount;
      gone: string | null;
    }>
  | Readonly<{ ok: false; reason: ConnectionRefusal }>
> {
  const client = { fetch: host.fetch };
  // The Environment's one device in this account's logins from now on.
  const deviceIdentifier = randomUUID();
  try {
    const { region, login } = await regionLogin(
      client,
      values,
      deviceOf({ deviceIdentifier }),
    );
    const server = bitwardenRegions[region].web;
    // The cloud's API as the agents' account, with the token it signed in to.
    const ask = (path: string) =>
      vaultRequest(client, server, path, { token: login.accessToken });
    const profile = plainObject(await ask("/api/accounts/profile"));
    const email =
      typeof profile?.email === "string" ? normalizeEmail(profile.email) : "";
    if (
      profile === null ||
      profile.id !== login.userId ||
      !isEnteredEmail(email)
    )
      return { ok: false, reason: "failed" };
    // This account's vault from an earlier connection is its own, and so is
    // the one organization that carries its unresolved creation's receipt;
    // anything else it owns or administers is not.
    const record = await readRecord(
      vaultPaths(host.directory(new URL(server).hostname, email)),
    ).catch(() => emptyRecord);
    const organizations = await organizationsOf(profile, record, ask);
    if (organizations === null) return { ok: false, reason: "failed" };
    if (organizations.ownsOther)
      return { ok: false, reason: "owns-organization" };
    await unlockPrivateKey({
      email,
      password: values.masterPassword,
      protectedUserKey: login.protectedUserKey,
      encryptedPrivateKey: login.encryptedPrivateKey,
      kdf: await accountKdf(client, login, email),
    });
    return {
      ok: true,
      region,
      account: Object.freeze({
        email,
        server,
        deviceIdentifier,
        masterPassword: values.masterPassword,
        createdAt: (host.now?.() ?? new Date()).toISOString(),
        clientId: values.clientId,
        clientSecret: values.clientSecret,
      }),
      gone: organizations.recordedGone ? record.organizationId : null,
    };
  } catch (error) {
    return { ok: false, reason: refusalOf(error) };
  }
}

/**
 * Connects a personal Environment's own Bitwarden from the form's values
 * (root decision 0203 point 7): only a personal Environment whose handover
 * names no vault, that is not a 0197 pilot and is not connected yet. The
 * agents' account is checked first (`verifiedAccount`), in the region that
 * accepts its API key; then, under the connection's lock, its credentials
 * are written whole into its custody and the connection beside it, with
 * that region and nobody to invite yet. A vault recorded for this account
 * that is gone from Bitwarden (a person deleted it there, which in their
 * own Bitwarden is theirs to do) is forgotten, so the setup creates a new
 * one: the person's connecting again is the decision, never a setup on its
 * own. The vault itself is created by the setup that follows
 * (`vaultSetup`), which the caller starts. Values go nowhere but the
 * custody; the journal gets the outcome and a fixed reason.
 */
export async function connectPersonalBitwarden(
  host: VaultHost,
  input: ConnectionInput,
): Promise<ConnectionAnswer> {
  const journal = (outcome: string, reason?: string) =>
    host.journal?.({
      operation: "connect",
      outcome,
      ...(reason === undefined ? {} : { reason }),
    });
  const checked = connectionValues(input);
  if (!checked.ok) return refused(checked.reason);
  const context = await host.context();
  if (context.kind === "pilot") return refused("pilot-0197");
  if (context.kind === "own")
    return refused(
      context.bitwarden === undefined ? "not-offered" : "connected",
    );
  if (context.kind === "unsupported")
    return refused(
      context.reason === "connection-unreadable" ? "connected" : "not-offered",
    );
  const verified = await verifiedAccount(host, checked.values);
  if (!verified.ok) {
    journal("refused", verified.reason);
    return refused(verified.reason);
  }
  const { region, account, gone } = verified;
  return underConnectionLock(
    host,
    () => refused("busy"),
    async () => {
      // Connected meanwhile by another request: nothing is written.
      if (
        (await readConnection(host.connection).catch(() => "unreadable")) !==
        null
      )
        return refused("connected");
      const paths = vaultPaths(
        host.directory(new URL(account.server).hostname, account.email),
      );
      const written = await withLock(
        paths,
        host.lockMs ?? lockMs,
        () => false,
        async () => {
          // The vault the person deleted in Bitwarden, if the record still
          // names it as it did when the profile was read.
          const current = await readRecord(paths).catch(() => null);
          if (
            gone !== null &&
            current?.organizationId === gone &&
            current.pendingKey === null
          ) {
            await writeRecord(paths, emptyRecord);
            journal("record-discarded");
          }
          await writeEnteredAccount(paths, account);
          return true;
        },
      );
      if (!written) return refused("busy");
      await writeConnection(host.connection, {
        region,
        account: account.email,
        invitee: null,
      });
      journal("connected");
      return Object.freeze({ kind: "vault-connected" as const });
    },
  );
}

// --- Inviting the person --------------------------------------------------

/** Nobody: whom the gateway admitted changes nothing in a personal
 * Environment's own Bitwarden (members.ts). */
const nobody = Object.freeze({ subject: null, username: null });

/**
 * The person asks to see the agents' passwords in their own Bitwarden too
 * (root decision 0203 point 7, F53's amendment of 2026-10-16, (2)): the
 * address of their own Bitwarden account becomes the connection's invitee,
 * once, and the membership look invites it at once as a User with Manage
 * on Agenti (`vaultMembership`, invitee.ts), as every later look and setup
 * moves it on. Only a connected personal Environment's own Bitwarden whose
 * vault exists takes it; never the agents' account itself (`same-account`),
 * and never a second address (`invited`: disconnecting and connecting
 * again starts afresh); the same address again only looks again. The
 * answer is the person's membership; the address goes nowhere but the
 * connection and the cloud's invitation, and the journal gets the outcome.
 */
export async function invitePersonalBitwarden(
  host: VaultHost,
  input: InviteeInput,
): Promise<VaultMembership | Refused> {
  const email = inviteeValue(input);
  if (email === null) return refused("email-invalid");
  const context = await host.context();
  if (context.kind === "pilot") return refused("pilot-0197");
  if (context.kind !== "own")
    return refused(
      context.kind === "needs-connection" ||
        context.reason === "connection-unreadable"
        ? "not-connected"
        : "not-offered",
    );
  const { bitwarden } = context;
  if (bitwarden === undefined) return refused("not-offered");
  if (email === context.account) return refused("same-account");
  if (bitwarden.invitee !== null && bitwarden.invitee !== email)
    return refused("invited");
  // The invitation names the vault's collection Agenti: no vault, nobody to
  // invite into it yet.
  if ((await connectedAccount(ownPaths(host, context), context)) === null)
    return refused("not-connected");
  if (bitwarden.invitee === null) {
    const set = await underConnectionLock(
      host,
      () => "busy" as const,
      async () => {
        // Read again under the lock: disconnected, connected anew or
        // invited meanwhile by another request.
        const connection = await readConnection(host.connection).catch(
          () => null,
        );
        if (
          connection === null ||
          connection.account !== context.account ||
          connection.region !== bitwarden.region
        )
          return "not-connected" as const;
        if (connection.invitee !== null)
          return connection.invitee === email
            ? ("set" as const)
            : ("invited" as const);
        await writeConnection(host.connection, {
          ...connection,
          invitee: email,
        });
        host.journal?.({ operation: "members", outcome: "invitee-set" });
        return "set" as const;
      },
    );
    if (set !== "set") return refused(set);
  }
  return vaultMembership(host, nobody);
}

// --- Disconnecting ----------------------------------------------------------

export type DisconnectAnswer =
  | Readonly<{ kind: "vault-disconnected" }>
  | Readonly<{ kind: "vault-connection-refused"; reason: ConnectionRefusal }>;

/**
 * Disconnects a personal Environment's own Bitwarden (root decision 0203
 * point 7): bw signs out of the agents' account and its credentials, its
 * session and bw's store leave this Environment, then the connection. The
 * organization stays in Bitwarden and its record here, so connecting the
 * same account again finds its vault; nothing is deleted in Bitwarden. A
 * connection that cannot be read is removed as well, without touching any
 * account.
 */
export async function disconnectPersonalBitwarden(
  host: VaultHost,
): Promise<DisconnectAnswer> {
  const context = await host.context();
  const connected =
    (context.kind === "own" && context.bitwarden !== undefined) ||
    (context.kind === "unsupported" &&
      context.reason === "connection-unreadable");
  if (!connected)
    return Object.freeze({
      kind: "vault-connection-refused",
      reason: "not-connected",
    });
  const busy = (): DisconnectAnswer =>
    Object.freeze({ kind: "vault-connection-refused", reason: "busy" });
  return underConnectionLock(host, busy, async () => {
    const connection = await readConnection(host.connection).catch(() => null);
    if (connection !== null) {
      const web = bitwardenRegions[connection.region].web;
      const paths = vaultPaths(
        host.directory(new URL(web).hostname, connection.account),
      );
      const forgotten = await withLock(
        paths,
        host.lockMs ?? lockMs,
        () => false,
        async () => {
          // Signed out first, while bw still has the account; a bw that is
          // not there or not signed in has nothing to sign out.
          if (await pinnedInstalled(host.base, host.pin))
            await cliOf(host, paths).logout(null);
          await forgetEnteredAccount(paths);
          return true;
        },
      );
      if (!forgotten) return busy();
    }
    await rm(connectionFile(host.connection), { force: true });
    await syncDirectory(host.connection).catch(() => undefined);
    host.journal?.({ operation: "disconnect", outcome: "disconnected" });
    return Object.freeze({ kind: "vault-disconnected" });
  });
}
