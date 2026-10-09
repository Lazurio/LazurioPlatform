import { randomBytes } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
import { acquireFileLock, type FileLock } from "../platform/flock";
import { parseUniqueJson } from "../providers/unique-json";
import { syncDirectory, writeDurableFile } from "../update/durable-file";

// The custody of one Environment vault account (decision F43): the files the
// account needs on this Environment and nothing else, in the Bitwarden CLI's
// own data directory that Lazurio gives it, owner-only:
//
//   <state>/lazurio/vault/<vault host>/        0700
//     lock                                     0600, empty: the kernel lock
//                                              of connect, refresh, unlock
//                                              and disconnect
//     bw/                                      0700, BITWARDENCLI_APPDATA_DIR
//       data.json                              bw's own store
//       lazurio-account.json                   0600, the account's secrets
//       lazurio-session                        0600, the one BW_SESSION
//       lazurio-vault.json                     0600, not secret: fingerprint
//                                              and the connected collection
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

/** What is not secret and saves a bw call: the account's fingerprint phrase
 * and the collection it was last connected to. A recorded collection that is
 * no longer seen after a sync is a revoked access. */
export type VaultRecord = Readonly<{
  fingerprint: string | null;
  organizationId: string | null;
  collectionId: string | null;
}>;

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isVaultId = (value: unknown): value is string =>
  typeof value === "string" && uuid.test(value);
/** The fingerprint phrase as `bw get fingerprint me` prints it: five words
 * of the EFF list joined by hyphens (a word may hold a hyphen itself). */
export const isFingerprint = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length <= 160 &&
  /^[a-z]+(?:-[a-z]+){4,9}$/.test(value);
/** A BW_SESSION as bw prints it: base64 of a 64-byte key. */
export const isSession = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9+/]{40,200}={0,2}$/.test(value);

const accountKeys = [
  "clientId",
  "clientSecret",
  "createdAt",
  "deviceIdentifier",
  "email",
  "masterPassword",
  "server",
] as const;

function plainObject(input: unknown): Record<string, unknown> | null {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    return null;
  const prototype = Object.getPrototypeOf(input);
  return prototype === Object.prototype || prototype === null
    ? (input as Record<string, unknown>)
    : null;
}

/** The account file, only in its exact form; anything else is refused, and
 * nothing of it is ever echoed. */
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
    email: text("email", /^vaultwarden@[a-z0-9.-]{1,240}$/),
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

function serialize(value: unknown): Uint8Array {
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

async function readOwned(path: string): Promise<string | null> {
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

/** Only a registration the vault refused leaves no account behind. */
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

const emptyRecord: VaultRecord = Object.freeze({
  fingerprint: null,
  organizationId: null,
  collectionId: null,
});

export async function readRecord(paths: VaultPaths): Promise<VaultRecord> {
  try {
    const text = await readOwned(paths.record);
    if (text === null) return emptyRecord;
    const value = plainObject(parseUniqueJson(text));
    if (
      value === null ||
      Object.keys(value).sort().join() !==
        "collectionId,fingerprint,organizationId" ||
      !(value.fingerprint === null || isFingerprint(value.fingerprint)) ||
      !(value.organizationId === null || isVaultId(value.organizationId)) ||
      !(value.collectionId === null || isVaultId(value.collectionId))
    )
      return emptyRecord;
    return Object.freeze({
      fingerprint: value.fingerprint as string | null,
      organizationId: value.organizationId as string | null,
      collectionId: value.collectionId as string | null,
    });
  } catch {
    // Not secret and derivable again: an unreadable record is no record.
    return emptyRecord;
  }
}

export async function writeRecord(
  paths: VaultPaths,
  record: VaultRecord,
): Promise<void> {
  const current = await readRecord(paths);
  if (
    current.fingerprint === record.fingerprint &&
    current.organizationId === record.organizationId &&
    current.collectionId === record.collectionId
  )
    return;
  await writeDurableFile(
    paths.data,
    "lazurio-vault.json",
    serialize({
      fingerprint: record.fingerprint,
      organizationId: record.organizationId,
      collectionId: record.collectionId,
    }),
  );
}

/** Disconnect: bw's own store, the session and the record go; the account
 * file stays, so connecting again signs the same account in. */
export async function forgetSignIn(paths: VaultPaths): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(paths.data);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries)
    if (entry !== "lazurio-account.json")
      await rm(join(paths.data, entry), { recursive: true, force: true });
  await syncDirectory(paths.data);
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
