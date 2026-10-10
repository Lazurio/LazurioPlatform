import { lstat, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { acquireFileLock, type FileLock } from "../platform/flock";
import { parseUniqueJson } from "../providers/unique-json";
import { syncDirectory, writeDurableFile } from "../update/durable-file";
import {
  type GithubHttp,
  GithubOAuthError,
  GithubRequestError,
  GithubTokenNotExpiring,
  isAccessToken,
  isRefreshToken,
  refreshTokenPair,
} from "./oauth";
import {
  ensurePrivateDirectory,
  isAppClientId,
  isGithubLogin,
  type PilotOrganization,
  type PilotPaths,
  sameLogin,
} from "./pilot";

// One Organization's sign-in on this Environment (decision F46): the user
// access token of that Organization's sign-in app, its refresh token and
// what the sign-in checked, in one owner-only file per Organization. The
// access token lives eight hours, the refresh token six months; each refresh
// gives a new pair and ends the old one at once, so a refresh runs only under
// the Organization's kernel lock and re-reads the file first: two processes
// that refreshed with the same refresh token would end the sign-in. The file
// is replaced whole (temporary file, sync, rename), so a reader without the
// lock always sees one complete pair. No token is ever written anywhere else:
// not to the Folder, Git config, a log, the journal or an error.

export const signInSchema = "lazurio.github-sign-in.v1";

export type StoredSignIn = Readonly<{
  schema: typeof signInSchema;
  organization: Readonly<{ login: string; id: number }>;
  clientId: string;
  installationId: number;
  /** The person the tokens act for, checked at the sign-in. */
  account: Readonly<{ login: string; id: number }>;
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  refreshTokenExpiresAt: string;
  signedInAt: string;
  refreshedAt: string | null;
}>;

/** A refresh starts this long before the access token ends. */
export const refreshMarginMs = 10 * 60 * 1000;
/** An access token this close to its end is never handed out. */
export const expiryGraceMs = 30 * 1000;
/** How long a caller waits for another process's refresh or sign-out. */
export const lockWaitMs = 30_000;

const fileName = (login: string) => `${login.toLowerCase()}.json`;
export const signInFile = (paths: PilotPaths, login: string) =>
  join(paths.stateDirectory, fileName(login));
const lockFile = (paths: PilotPaths, login: string) =>
  join(paths.stateDirectory, `${login.toLowerCase()}.lock`);

const iso = (time: number) => new Date(time).toISOString();
const isTime = (value: unknown): value is string =>
  typeof value === "string" &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value) &&
  Number.isFinite(Date.parse(value));
const isId = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

const keys = [
  "accessToken",
  "accessTokenExpiresAt",
  "account",
  "clientId",
  "installationId",
  "organization",
  "refreshToken",
  "refreshTokenExpiresAt",
  "refreshedAt",
  "schema",
  "signedInAt",
] as const;

function plainObject(input: unknown): Record<string, unknown> | null {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    return null;
  const prototype = Object.getPrototypeOf(input);
  return prototype === Object.prototype || prototype === null
    ? (input as Record<string, unknown>)
    : null;
}

function identity(input: unknown): Readonly<{ login: string; id: number }> {
  const value = plainObject(input);
  if (
    value === null ||
    Object.keys(value).sort().join() !== "id,login" ||
    !isGithubLogin(value.login) ||
    !isId(value.id)
  )
    throw new Error("Invalid sign-in");
  return Object.freeze({ login: value.login, id: value.id });
}

/** A sign-in file only in its exact form; nothing of it is ever echoed. */
export function parseStoredSignIn(input: unknown): StoredSignIn {
  const value = plainObject(input);
  if (
    value === null ||
    Object.keys(value).sort().join() !== [...keys].join() ||
    value.schema !== signInSchema ||
    !isAppClientId(value.clientId) ||
    !isId(value.installationId) ||
    !isAccessToken(value.accessToken) ||
    !isRefreshToken(value.refreshToken) ||
    !isTime(value.accessTokenExpiresAt) ||
    !isTime(value.refreshTokenExpiresAt) ||
    !isTime(value.signedInAt) ||
    !(value.refreshedAt === null || isTime(value.refreshedAt))
  )
    throw new Error("Invalid sign-in");
  return Object.freeze({
    schema: signInSchema,
    organization: identity(value.organization),
    clientId: value.clientId,
    installationId: value.installationId,
    account: identity(value.account),
    accessToken: value.accessToken,
    accessTokenExpiresAt: value.accessTokenExpiresAt,
    refreshToken: value.refreshToken,
    refreshTokenExpiresAt: value.refreshTokenExpiresAt,
    signedInAt: value.signedInAt,
    refreshedAt: value.refreshedAt as string | null,
  });
}

/** The sign-in of one Organization: none, the file, or `unreadable` when a
 * file is there that is not one (it is never used, never repaired). */
export async function readStoredSignIn(
  paths: PilotPaths,
  login: string,
): Promise<StoredSignIn | null | "unreadable"> {
  const path = signInFile(paths, login);
  let text: string;
  try {
    const entry = await lstat(path);
    if (!entry.isFile()) return "unreadable";
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return "unreadable";
  }
  try {
    const signIn = parseStoredSignIn(parseUniqueJson(text));
    return sameLogin(signIn.organization.login, login) ? signIn : "unreadable";
  } catch {
    return "unreadable";
  }
}

export async function writeStoredSignIn(
  paths: PilotPaths,
  signIn: StoredSignIn,
): Promise<void> {
  const checked = parseStoredSignIn(JSON.parse(JSON.stringify(signIn)));
  await ensurePrivateDirectory(paths.stateDirectory);
  await writeDurableFile(
    paths.stateDirectory,
    fileName(checked.organization.login),
    Buffer.from(`${JSON.stringify(checked, null, 2)}\n`),
  );
}

export async function removeStoredSignIn(
  paths: PilotPaths,
  login: string,
): Promise<void> {
  await rm(signInFile(paths, login), { force: true });
  await syncDirectory(paths.stateDirectory).catch(() => undefined);
}

/** The kernel lock of one Organization's sign-in (src/platform/flock.ts):
 * held by a refresh, the final write of a sign-in and a sign-out. A crashed
 * holder never blocks the next one; each holder re-reads the file. */
export async function lockOrganization(
  paths: PilotPaths,
  login: string,
  timeoutMs = lockWaitMs,
): Promise<FileLock> {
  await ensurePrivateDirectory(paths.stateDirectory);
  return acquireFileLock(lockFile(paths, login), { timeoutMs });
}

export type SignInToken =
  | Readonly<{
      kind: "token";
      token: string;
      /** Epoch milliseconds. */
      expiresAt: number;
      account: string;
      /** This call refreshed the pair. */
      refreshed: boolean;
    }>
  | Readonly<{
      kind: "signed-out";
      reason:
        | "not-signed-in"
        /** GitHub refused the refresh (revoked, or the chain was broken);
         * the sign-in was removed. */
        | "refresh-rejected"
        /** The refresh token itself ran out (six months unused). */
        | "sign-in-expired"
        /** The sign-in belongs to another app than the configured one. */
        | "app-changed";
    }>
  | Readonly<{
      kind: "unavailable";
      reason: /** The refresh could not reach GitHub and the access token is
       * spent. */
        | "unreachable"
        /** Another process held the lock too long. */
        | "busy"
        /** The sign-in file is not one this version reads. */
        | "unreadable";
    }>;

const fresh = (signIn: StoredSignIn, now: number, margin: number) =>
  Date.parse(signIn.accessTokenExpiresAt) - now > margin;

const handOut = (signIn: StoredSignIn, refreshed: boolean): SignInToken =>
  Object.freeze({
    kind: "token",
    token: signIn.accessToken,
    expiresAt: Date.parse(signIn.accessTokenExpiresAt),
    account: signIn.account.login,
    refreshed,
  });

/** The access token of one Organization's sign-in, refreshed first when it
 * ends within `refreshMarginMs`. Never starts a sign-in: a missing or ended
 * one is `signed-out` (fail closed, the caller says what to do). A refresh
 * that GitHub refuses removes the sign-in; one that does not reach GitHub
 * keeps it and hands out the current token while it still works. */
export async function organizationToken(
  input: Readonly<{
    paths: PilotPaths;
    organization: PilotOrganization;
    http: GithubHttp;
    now: () => number;
    lockTimeoutMs?: number;
  }>,
): Promise<SignInToken> {
  const { paths, organization, http, now } = input;
  const signedOut = (
    reason: Extract<SignInToken, { kind: "signed-out" }>["reason"],
  ) => Object.freeze({ kind: "signed-out" as const, reason });
  const unavailable = (
    reason: Extract<SignInToken, { kind: "unavailable" }>["reason"],
  ) => Object.freeze({ kind: "unavailable" as const, reason });
  const settle = (
    signIn: StoredSignIn | null | "unreadable",
  ): SignInToken | StoredSignIn => {
    if (signIn === null) return signedOut("not-signed-in");
    if (signIn === "unreadable") return unavailable("unreadable");
    if (signIn.clientId !== organization.clientId)
      return signedOut("app-changed");
    return signIn;
  };
  const first = settle(await readStoredSignIn(paths, organization.login));
  if ("kind" in first) return first;
  if (fresh(first, now(), refreshMarginMs)) return handOut(first, false);

  let lock: FileLock;
  try {
    lock = await lockOrganization(
      paths,
      organization.login,
      input.lockTimeoutMs ?? lockWaitMs,
    );
  } catch {
    // Someone else refreshes: the current token while it still works.
    return fresh(first, now(), expiryGraceMs)
      ? handOut(first, false)
      : unavailable("busy");
  }
  try {
    // Another process may have refreshed while this one waited.
    const current = settle(await readStoredSignIn(paths, organization.login));
    if ("kind" in current) return current;
    if (fresh(current, now(), refreshMarginMs)) return handOut(current, false);
    if (Date.parse(current.refreshTokenExpiresAt) <= now()) {
      if (fresh(current, now(), expiryGraceMs)) return handOut(current, false);
      await removeStoredSignIn(paths, organization.login);
      return signedOut("sign-in-expired");
    }
    let pair: Awaited<ReturnType<typeof refreshTokenPair>>;
    try {
      pair = await refreshTokenPair(
        http,
        current.clientId,
        current.refreshToken,
        now,
      );
    } catch (error) {
      // GitHub refused the refresh token (it no longer works, and neither
      // does a token copied with it), or answered without a refresh token so
      // the chain cannot go on: the sign-in has ended.
      if (
        error instanceof GithubOAuthError ||
        error instanceof GithubTokenNotExpiring
      ) {
        await removeStoredSignIn(paths, organization.login);
        return signedOut("refresh-rejected");
      }
      if (!(error instanceof GithubRequestError)) throw error;
      return fresh(current, now(), expiryGraceMs)
        ? handOut(current, false)
        : unavailable("unreachable");
    }
    const next: StoredSignIn = Object.freeze({
      ...current,
      accessToken: pair.accessToken,
      accessTokenExpiresAt: iso(pair.accessTokenExpiresAt),
      refreshToken: pair.refreshToken,
      refreshTokenExpiresAt: iso(pair.refreshTokenExpiresAt),
      refreshedAt: iso(now()),
    });
    // The old pair stopped working the moment GitHub answered: the new one
    // is written before anything may use it.
    await writeStoredSignIn(paths, next);
    return handOut(next, true);
  } finally {
    await lock.release();
  }
}
