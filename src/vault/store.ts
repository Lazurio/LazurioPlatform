import { randomBytes } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
import { acquireFileLock, type FileLock } from "../platform/flock";
import { parseUniqueJson } from "../providers/unique-json";
import { syncDirectory, writeDurableFile } from "../update/durable-file";

// The custody of one Environment vault account (decisions F43 and F52): the
// files the account needs on this Environment and nothing else, written by
// Lazurio beside bw's own store in the data directory it gives bw, owner-only,
// in a directory keyed by the vault and the account (context.ts):
//
//   <state>/lazurio/vault/<vault host>/<account>/   0700
//     lock                                     0600, empty: the kernel lock
//                                              of setup, refresh and unlock
//     bw/                                      0700, BITWARDENCLI_APPDATA_DIR
//       data.json                              bw's own store
//       lazurio-account.json                   0600, the account's secrets
//       lazurio-session                        0600, the one BW_SESSION
//       lazurio-vault.json                     0600, not secret: the ids of
//                                              the Environment's own vault
//
// No secret is ever written anywhere else: not to the Folder, a log, the
// journal, Diagnostics or an error.

export type VaultPaths = Readonly<{
  directory: string;
  lock: string;
  /** BITWARDENCLI_APPDATA_DIR of every bw process of this account. */
  data: string;
  account: string;
  session: string;
  record: string;
}>;

export function vaultPaths(directory: string): VaultPaths {
  const data = join(directory, "bw");
  return Object.freeze({
    directory,
    lock: join(directory, "lock"),
    data,
    account: join(data, "lazurio-account.json"),
    session: join(data, "lazurio-session"),
    record: join(data, "lazurio-vault.json"),
  });
}

/** The account of this Environment: the master password generated here (no
 * person knows it), the one device identifier its own logins use, and, once
 * fetched, its personal API key, which `bw login --apikey` takes. */
export type VaultAccount = Readonly<{
  email: string;
  server: string;
  deviceIdentifier: string;
  masterPassword: string;
  createdAt: string;
  clientId?: string;
  clientSecret?: string;
}>;
export type ReadyAccount = VaultAccount &
  Readonly<{ clientId: string; clientSecret: string }>;

export const isReady = (account: VaultAccount): account is ReadyAccount =>
  account.clientId !== undefined && account.clientSecret !== undefined;

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isVaultId = (value: unknown): value is string =>
  typeof value === "string" && uuid.test(value);
/** A BW_SESSION as bw prints it: base64 of a 64-byte key. */
export const isSession = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9+/]{40,200}={0,2}$/.test(value);
/** An RSA public key as Vaultwarden keeps it: SPKI, base64. */
export const isPublicKey = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9+/]{100,2000}={0,2}$/.test(value);

const accountKeys = [
  "clientId",
  "clientSecret",
  "createdAt",
  "deviceIdentifier",
  "email",
  "masterPassword",
  "server",
] as const;

export function plainObject(input: unknown): Record<string, unknown> | null {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    return null;
  const prototype = Object.getPrototypeOf(input);
  return prototype === Object.prototype || prototype === null
    ? (input as Record<string, unknown>)
    : null;
}

/** The account file, only in its exact form; anything else is refused, and
 * nothing of it is ever echoed. Whose account it is, every caller checks
 * against its own context (the handover's `vault.account`, or a 0197
 * pilot's `vaultwarden@<address>`). */
export function parseAccount(input: unknown): VaultAccount {
  const value = plainObject(input);
  if (value === null) throw new Error("Invalid vault account");
  for (const key of Object.keys(value))
    if (!(accountKeys as readonly string[]).includes(key))
      throw new Error("Invalid vault account");
  const text = (key: string, pattern: RegExp) => {
    const field = value[key];
    if (typeof field !== "string" || !pattern.test(field))
      throw new Error("Invalid vault account");
    return field;
  };
  const account: VaultAccount = {
    email: text("email", /^[a-z0-9](?:[a-z0-9-]{0,62})@[a-z0-9.-]{1,240}$/),
    server: text("server", /^https:\/\/[a-z0-9.-]{1,240}(?::\d{1,5})?$/),
    deviceIdentifier: text(
      "deviceIdentifier",
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    ),
    masterPassword: text("masterPassword", /^[A-Za-z0-9_-]{43,128}$/),
    createdAt: text("createdAt", /^\d{4}-\d\d-\d\dT[0-9:.]+Z$/),
  };
  const withKey = value.clientId !== undefined;
  if (withKey !== (value.clientSecret !== undefined))
    throw new Error("Invalid vault account");
  if (!withKey) return Object.freeze(account);
  return Object.freeze({
    ...account,
    clientId: text("clientId", /^user\.[0-9a-f-]{36}$/),
    clientSecret: text("clientSecret", /^[A-Za-z0-9]{8,128}$/),
  });
}

export function serialize(value: unknown): Uint8Array {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

/** Creates the owner-only directories of one account, refusing a link in
 * their place. */
export async function ensureVaultDirectories(paths: VaultPaths): Promise<void> {
  for (const directory of [paths.directory, paths.data]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const entry = await lstat(directory);
    if (!entry.isDirectory() || entry.isSymbolicLink())
      throw new Error("Vault directory is not a directory");
    await chmod(directory, 0o700);
  }
}

/** A file of the account's custody, or null when there is none. A link or
 * anything but a regular file throws. */
export async function readOwned(path: string): Promise<string | null> {
  try {
    const entry = await lstat(path);
    if (!entry.isFile()) throw new Error("Vault file is not a regular file");
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function readAccount(
  paths: VaultPaths,
): Promise<VaultAccount | null> {
  const text = await readOwned(paths.account);
  return text === null ? null : parseAccount(parseUniqueJson(text));
}

/** The account file before the account exists in the vault: the generated
 * password and device identifier, written durably and only when no account
 * file is there (an atomic link, never a replacement), so a registration that
 * the vault accepted can never lose its password. */
export async function createAccount(
  paths: VaultPaths,
  account: VaultAccount,
): Promise<void> {
  if (isReady(account)) throw new Error("A new account has no API key yet");
  const temporary = join(
    paths.data,
    `.lazurio-account.json.tmp-${randomBytes(8).toString("hex")}`,
  );
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(serialize(account));
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await link(temporary, paths.account);
  } finally {
    await rm(temporary, { force: true });
  }
  await syncDirectory(paths.data);
}

/** The API key joins the account once: the same account, durably replaced. */
export async function completeAccount(
  paths: VaultPaths,
  account: VaultAccount,
  key: Readonly<{ clientId: string; clientSecret: string }>,
): Promise<ReadyAccount> {
  const current = await readAccount(paths);
  if (
    current === null ||
    isReady(current) ||
    current.masterPassword !== account.masterPassword ||
    current.email !== account.email
  )
    throw new Error("The vault account changed");
  const ready = parseAccount({ ...current, ...key }) as ReadyAccount;
  await writeDurableFile(paths.data, "lazurio-account.json", serialize(ready));
  return ready;
}

/** A registration the vault refused, of a password generated in the same
 * run, leaves no account behind. */
export async function forgetUnregisteredAccount(
  paths: VaultPaths,
): Promise<void> {
  const current = await readAccount(paths).catch(() => null);
  if (current !== null && !isReady(current))
    await rm(paths.account, { force: true });
  await syncDirectory(paths.data).catch(() => undefined);
}

export async function readSession(paths: VaultPaths): Promise<string | null> {
  const text = await readOwned(paths.session);
  if (text === null) return null;
  const session = text.trim();
  return isSession(session) ? session : null;
}

export async function writeSession(
  paths: VaultPaths,
  session: string,
): Promise<void> {
  if (!isSession(session)) throw new Error("Invalid session");
  await writeDurableFile(paths.data, "lazurio-session", Buffer.from(session));
}

/** The Environment's own vault (decision F52), not secret: its organization
 * and its first collection, Agenti, by ID, which is the vault's whole
 * identity (names never are). `pendingKey` is the receipt of a creation
 * under way: the new organization's public key, written before it is
 * created, so an organization whose answer was lost is recognized as this
 * account's own afterwards and never created twice. */
export type VaultRecord = Readonly<{
  organizationId: string | null;
  collectionId: string | null;
  pendingKey: string | null;
}>;

export const emptyRecord: VaultRecord = Object.freeze({
  organizationId: null,
  collectionId: null,
  pendingKey: null,
});

/** The record, or the empty one when there is none. A record that is there
 * but cannot be read throws: it may be the only memory of the vault's ID, so
 * nothing is ever created in its place. */
export async function readRecord(paths: VaultPaths): Promise<VaultRecord> {
  const text = await readOwned(paths.record);
  if (text === null) return emptyRecord;
  const value = plainObject(parseUniqueJson(text));
  if (
    value === null ||
    Object.keys(value).sort().join() !==
      "collectionId,organizationId,pendingKey" ||
    !(value.organizationId === null || isVaultId(value.organizationId)) ||
    !(value.collectionId === null || isVaultId(value.collectionId)) ||
    !(value.pendingKey === null || isPublicKey(value.pendingKey)) ||
    (value.collectionId !== null && value.organizationId === null)
  )
    throw new Error("Invalid vault record");
  return Object.freeze({
    organizationId: value.organizationId as string | null,
    collectionId: value.collectionId as string | null,
    pendingKey: value.pendingKey as string | null,
  });
}

export async function writeRecord(
  paths: VaultPaths,
  record: VaultRecord,
): Promise<void> {
  await writeDurableFile(
    paths.data,
    "lazurio-vault.json",
    serialize({
      organizationId: record.organizationId,
      collectionId: record.collectionId,
      pendingKey: record.pendingKey,
    }),
  );
}

/** The kernel lock of one account's mutations (src/platform/flock.ts): a
 * crashed holder never blocks the next one, and each holder re-reads the
 * files, which are always whole. */
export async function lockVault(
  paths: VaultPaths,
  timeoutMs: number,
): Promise<FileLock> {
  await ensureVaultDirectories(paths);
  return acquireFileLock(paths.lock, { timeoutMs });
}
