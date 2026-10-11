import { randomBytes } from "node:crypto";
import { open, rm } from "node:fs/promises";
import { join } from "node:path";
import { parseUniqueJson } from "../providers/unique-json";
import type { ToolProcessResult, ToolRunner } from "../tools/status";
import { isFingerprint, isSession, isVaultId } from "./store";

// The Bitwarden CLI of one Environment vault account (decision F43), driven
// by the core and never by a person: always the pinned binary, always with
// the account's own BITWARDENCLI_APPDATA_DIR (bw rewrites its data file on
// every start, so no run may reach another profile), never interactive. A
// secret never reaches argv: the session goes in BW_SESSION, the API key in
// BW_CLIENTID/BW_CLIENTSECRET, the master password in a private file that
// `--passwordfile` reads and that is removed at once. bw's own output is
// parsed here and never leaves this module: `bw login --apikey` even prints
// a (still locked) session.

export type BwEnvironment = Readonly<{
  /** The pinned binary, by its absolute path. */
  binary: string;
  /** BITWARDENCLI_APPDATA_DIR: the account's own data directory. */
  data: string;
  home: string;
  path: string | undefined;
  run: ToolRunner;
}>;

/** Why a bw step did not succeed, as a fixed code: never bw's output. */
export type BwFailure =
  /** The session is not (or no longer) the unlocked one. */
  | "locked"
  /** bw is not signed in to any account. */
  | "unauthenticated"
  /** The vault cannot be reached. */
  | "unreachable"
  /** The vault's login rate limit (burst 10, then 1 a minute). */
  | "rate-limited"
  /** The vault refused the API key or the master password. */
  | "invalid-credentials"
  /** bw is signed in to a server and refuses another one. */
  | "logout-required"
  | "timeout"
  | "spawn-failed"
  /** It answered, but not in the shape this module reads. */
  | "unreadable"
  | "failed";

export type BwResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; reason: BwFailure }>;

export type BwStatus = Readonly<{
  status: "unauthenticated" | "locked" | "unlocked";
  serverUrl: string | null;
  userEmail: string | null;
}>;

/** Membership status as the vault reports it: -1 revoked, 0 invited, 1
 * accepted, 2 confirmed. Only a confirmed member holds the organization's
 * key. */
export type BwOrganization = Readonly<{
  id: string;
  name: string;
  status: number;
}>;

export type BwCollection = Readonly<{
  id: string;
  organizationId: string;
  name: string;
}>;

const timeouts = {
  local: 60_000,
  network: 120_000,
} as const;
/** A whole item list may be large; only its length, or the items of the
 * declared names, are read. */
const itemsMaxBytes = 64 * 1024 * 1024;

const ok = <T>(value: T): BwResult<T> => Object.freeze({ ok: true, value });
const fail = <T>(reason: BwFailure): BwResult<T> =>
  Object.freeze({ ok: false, reason });

/** What a failed bw run means, by bw's and the vault's fixed messages. */
export function bwFailureOf(result: ToolProcessResult): BwFailure {
  if (result === "timeout") return "timeout";
  const output = `${result.stdout}\n${result.stderr}`;
  if (/vault is locked/i.test(output)) return "locked";
  if (/you are not logged in/i.test(output)) return "unauthenticated";
  if (/too many (login )?requests|\b429\b/i.test(output)) return "rate-limited";
  if (/logout required before server config update/i.test(output))
    return "logout-required";
  if (
    /incorrect client_secret|invalid client_id|malformed client_id|invalid master password|username or password is incorrect|invalid_client|invalid_grant/i.test(
      output,
    )
  )
    return "invalid-credentials";
  if (
    /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|EHOSTUNREACH|ENETUNREACH|socket hang up|getaddrinfo|fetch failed|failed to fetch|network ?error|request to \S+ failed|certificate|self[- ]signed|UNABLE_TO_VERIFY|\b50[234]\b/i.test(
      output,
    )
  )
    return "unreachable";
  return "failed";
}

function jsonOf(text: string): unknown {
  try {
    return parseUniqueJson(text.trim());
  } catch {
    return undefined;
  }
}

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** `bw status`: the state of bw's profile and the given session. */
export function parseBwStatus(stdout: string): BwStatus | null {
  const value = record(jsonOf(stdout));
  if (
    value === null ||
    (value.status !== "unauthenticated" &&
      value.status !== "locked" &&
      value.status !== "unlocked")
  )
    return null;
  const text = (field: unknown) =>
    typeof field === "string" && field.length <= 512 ? field : null;
  return Object.freeze({
    status: value.status,
    serverUrl: text(value.serverUrl),
    userEmail: text(value.userEmail),
  });
}

const plainName = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 512 &&
  !/[\p{Cc}\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/u.test(value);

/** `bw list organizations`. */
export function parseOrganizations(stdout: string): BwOrganization[] | null {
  const value = jsonOf(stdout);
  if (!Array.isArray(value)) return null;
  const organizations: BwOrganization[] = [];
  for (const entry of value) {
    const item = record(entry);
    if (
      item === null ||
      !isVaultId(item.id) ||
      !plainName(item.name) ||
      typeof item.status !== "number" ||
      !Number.isInteger(item.status)
    )
      return null;
    organizations.push(
      Object.freeze({ id: item.id, name: item.name, status: item.status }),
    );
  }
  return organizations;
}

/** `bw list collections`. */
export function parseCollections(stdout: string): BwCollection[] | null {
  const value = jsonOf(stdout);
  if (!Array.isArray(value)) return null;
  const collections: BwCollection[] = [];
  for (const entry of value) {
    const item = record(entry);
    if (
      item === null ||
      !isVaultId(item.id) ||
      !isVaultId(item.organizationId) ||
      !plainName(item.name)
    )
      return null;
    collections.push(
      Object.freeze({
        id: item.id,
        organizationId: item.organizationId,
        name: item.name,
      }),
    );
  }
  return collections;
}

/** One item of the Environment's collection that is a candidate for a
 * declared name: only what the selection of decision F46 reads. Every other
 * field of the item (its notes, fields, username, TOTP, URIs) is dropped
 * here and never leaves this module. */
export type BwSecretItem = Readonly<{
  name: string;
  organizationId: string | null;
  collectionIds: readonly string[];
  /** `login.password`; null when the item has no login or no password. */
  password: string | null;
}>;

/** `bw list items`: the items whose name is one of `names`, exactly. An
 * entry that is not an item object, or a candidate whose ids are not of the
 * vault's shape, makes the whole answer unreadable rather than guessed. */
export function parseSecretItems(
  stdout: string,
  names: ReadonlySet<string>,
): BwSecretItem[] | null {
  const value = jsonOf(stdout);
  if (!Array.isArray(value)) return null;
  const items: BwSecretItem[] = [];
  for (const entry of value) {
    const item = record(entry);
    if (item === null) return null;
    if (typeof item.name !== "string" || !names.has(item.name)) continue;
    const organizationId = item.organizationId ?? null;
    const collectionIds = item.collectionIds ?? [];
    if (
      !(organizationId === null || isVaultId(organizationId)) ||
      !Array.isArray(collectionIds) ||
      !collectionIds.every(isVaultId)
    )
      return null;
    const login = record(item.login);
    const password =
      login !== null && typeof login.password === "string"
        ? login.password
        : null;
    items.push(
      Object.freeze({
        name: item.name,
        organizationId,
        collectionIds: Object.freeze([...collectionIds]),
        password,
      }),
    );
  }
  return items;
}

export type BwCli = ReturnType<typeof bwCli>;

export function bwCli(environment: BwEnvironment) {
  const base: Record<string, string> = {
    PATH: environment.path ?? "/usr/bin:/bin",
    HOME: environment.home,
    BITWARDENCLI_APPDATA_DIR: environment.data,
    BW_NOINTERACTION: "true",
  };
  async function run(
    args: readonly string[],
    extra: Readonly<Record<string, string>> = {},
    timeoutMs: number = timeouts.local,
    maxBytes?: number,
  ): Promise<ToolProcessResult | "spawn-failed"> {
    try {
      return await environment.run(
        [environment.binary, ...args],
        timeoutMs,
        { ...base, ...extra },
        maxBytes === undefined ? undefined : { maxBytes },
      );
    } catch {
      return "spawn-failed";
    }
  }
  async function step<T>(
    args: readonly string[],
    read: (stdout: string) => T | null,
    extra: Readonly<Record<string, string>> = {},
    timeoutMs?: number,
    maxBytes?: number,
  ): Promise<BwResult<T>> {
    const result = await run(args, extra, timeoutMs, maxBytes);
    if (result === "spawn-failed") return fail("spawn-failed");
    if (result === "timeout" || result.exitCode !== 0)
      return fail(bwFailureOf(result));
    const value = read(result.stdout);
    return value === null ? fail("unreadable") : ok(value);
  }
  const session = (value: string | null): Record<string, string> =>
    value === null ? {} : { BW_SESSION: value };

  return Object.freeze({
    /** The version bw reports, run like every other step. */
    async version(): Promise<string | null> {
      const result = await run(["--version"]);
      if (result === "spawn-failed" || result === "timeout") return null;
      if (result.exitCode !== 0) return null;
      return /^\d+\.\d+\.\d+$/.test(result.stdout.trim())
        ? result.stdout.trim()
        : null;
    },
    status(value: string | null): Promise<BwResult<BwStatus>> {
      return step(["status", "--nointeraction"], parseBwStatus, session(value));
    },
    configServer(url: string): Promise<BwResult<true>> {
      return step(
        ["config", "server", url, "--nointeraction"],
        () => true as const,
      );
    },
    /** Signs bw in with the account's API key. The session it prints is
     * still locked and is never read. */
    loginApiKey(
      clientId: string,
      clientSecret: string,
    ): Promise<BwResult<true>> {
      return step(
        ["login", "--apikey", "--nointeraction"],
        () => true as const,
        { BW_CLIENTID: clientId, BW_CLIENTSECRET: clientSecret },
        timeouts.network,
      );
    },
    /** A new unlocked session from the master password. Every unlock ends
     * every earlier session of this profile. */
    async unlock(password: string): Promise<BwResult<string>> {
      const file = join(
        environment.data,
        `.lazurio-unlock-${randomBytes(8).toString("hex")}`,
      );
      try {
        const handle = await open(file, "wx", 0o600);
        try {
          await handle.writeFile(`${password}\n`);
        } finally {
          await handle.close();
        }
        return await step(
          ["unlock", "--passwordfile", file, "--raw", "--nointeraction"],
          (stdout) => (isSession(stdout.trim()) ? stdout.trim() : null),
          {},
          timeouts.network,
        );
      } catch {
        return fail("failed");
      } finally {
        await rm(file, { force: true });
      }
    },
    sync(value: string): Promise<BwResult<true>> {
      return step(
        ["sync", "--nointeraction"],
        () => true as const,
        session(value),
        timeouts.network,
      );
    },
    organizations(value: string): Promise<BwResult<BwOrganization[]>> {
      return step(
        ["list", "organizations", "--nointeraction"],
        parseOrganizations,
        session(value),
      );
    },
    collections(value: string): Promise<BwResult<BwCollection[]>> {
      return step(
        ["list", "collections", "--nointeraction"],
        parseCollections,
        session(value),
      );
    },
    /** How many items the account sees. bw has no count: the list is read
     * in memory for its length only and dropped. */
    itemCount(value: string): Promise<BwResult<number>> {
      return step(
        ["list", "items", "--nointeraction"],
        (stdout) => {
          const items = jsonOf(stdout);
          return Array.isArray(items) ? items.length : null;
        },
        session(value),
        timeouts.local,
        itemsMaxBytes,
      );
    },
    /** The items of one collection of one organization whose name is one of
     * `names` (decision F46). The ids are not secret and go on argv; bw
     * filters by them, and the caller selects again by every field. */
    secretItems(
      value: string,
      scope: Readonly<{ organizationId: string; collectionId: string }>,
      names: ReadonlySet<string>,
    ): Promise<BwResult<BwSecretItem[]>> {
      return step(
        [
          "list",
          "items",
          "--organizationid",
          scope.organizationId,
          "--collectionid",
          scope.collectionId,
          "--nointeraction",
        ],
        (stdout) => parseSecretItems(stdout, names),
        session(value),
        timeouts.local,
        itemsMaxBytes,
      );
    },
    fingerprint(value: string): Promise<BwResult<string>> {
      return step(
        ["get", "fingerprint", "me", "--nointeraction"],
        (stdout) => (isFingerprint(stdout.trim()) ? stdout.trim() : null),
        session(value),
      );
    },
    logout(value: string | null): Promise<BwResult<true>> {
      return step(
        ["logout", "--nointeraction"],
        () => true as const,
        session(value),
      );
    },
  });
}
