import { randomBytes } from "node:crypto";
import { open, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { parseUniqueJson } from "../providers/unique-json";
import type { ToolProcessResult, ToolRunner } from "../tools/status";
import { isSession, isVaultId } from "./store";

// The Bitwarden CLI of one Environment vault account (decisions F43, F53), driven
// by the core and never by a person: always the pinned binary, always with
// the account's own BITWARDENCLI_APPDATA_DIR (bw rewrites its data file on
// every start, so no run may reach another profile), never interactive. A
// secret never reaches argv: the session goes in BW_SESSION, the API key in
// BW_CLIENTID/BW_CLIENTSECRET, the master password in a private file that
// `--passwordfile` reads and that is removed at once. bw's own output is
// parsed here and never leaves this module: `bw login --apikey` even prints
// a (still locked) session, and `bw create item` the item with its values.
// A new item (decision F54) goes to bw's standard input, encoded as bw reads
// it, never to argv.

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

/** One member of an organization, as `bw list org-members` lists it: only
 * what the Správci's membership reads (`src/vault/members.ts`). The member's
 * name and everything else is dropped here; the e-mail is compared, never
 * logged or returned. `type` as the vault reports it: 0 Owner, 1 Admin,
 * 2 User, 3 Manager, 4 Custom; `status` -1 revoked, 0 invited, 1 accepted,
 * 2 confirmed. */
export type BwMember = Readonly<{
  id: string;
  email: string;
  status: number;
  type: number;
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

/** `bw list org-members`: every entry must read, or the whole answer is
 * unreadable rather than guessed. */
export function parseOrgMembers(stdout: string): BwMember[] | null {
  const value = jsonOf(stdout);
  if (!Array.isArray(value)) return null;
  const members: BwMember[] = [];
  for (const entry of value) {
    const item = record(entry);
    if (
      item === null ||
      !isVaultId(item.id) ||
      typeof item.email !== "string" ||
      item.email.length === 0 ||
      item.email.length > 320 ||
      typeof item.status !== "number" ||
      !Number.isInteger(item.status) ||
      typeof item.type !== "number" ||
      !Number.isInteger(item.type)
    )
      return null;
    members.push(
      Object.freeze({
        id: item.id,
        email: item.email,
        status: item.status,
        type: item.type,
      }),
    );
  }
  return members;
}

/** One item of the Environment's vault that is a candidate for a declared
 * name: only what the selection of decision F46 reads. Every other field of
 * the item (its notes, its text fields, username, TOTP, URIs) is dropped
 * here and never leaves this module. */
export type BwSecretItem = Readonly<{
  name: string;
  organizationId: string | null;
  collectionIds: readonly string[];
  /** `login.password`; null when the item has no login or no password. */
  password: string | null;
  /** A Secure note's hidden custom fields (decision F46 as F54 amends it):
   * how many it has and, only when it has exactly one, that one's value;
   * null for every other kind of item. */
  hidden: Readonly<{ count: number; value: string | null }> | null;
}>;

/** bw's item types: a Secure note is 2; a hidden custom field is 1, a text
 * one 0. */
const secureNoteType = 2;
const hiddenFieldType = 1;
const textFieldType = 0;

/** The hidden custom fields of a Secure note, or undefined when its fields
 * are not of bw's shape. */
function hiddenFields(
  item: Record<string, unknown>,
): BwSecretItem["hidden"] | undefined {
  if (item.type !== secureNoteType) return null;
  const fields = item.fields ?? [];
  if (!Array.isArray(fields)) return undefined;
  const hidden: unknown[] = [];
  for (const entry of fields) {
    const field = record(entry);
    if (field === null) return undefined;
    if (field.type === hiddenFieldType) hidden.push(field.value);
  }
  const [only] = hidden;
  return Object.freeze({
    count: hidden.length,
    value: hidden.length === 1 && typeof only === "string" ? only : null,
  });
}

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
    const hidden = hiddenFields(item);
    if (hidden === undefined) return null;
    items.push(
      Object.freeze({
        name: item.name,
        organizationId,
        collectionIds: Object.freeze([...collectionIds]),
        password,
        hidden,
      }),
    );
  }
  return items;
}

/** A Secure note for the Environment's own vault (decision F54): the item an
 * agent's secret request becomes, one custom field per field of the
 * request, hidden for a secret one. */
export type BwNote = Readonly<{
  organizationId: string;
  collectionId: string;
  name: string;
  notes: string;
  fields: readonly Readonly<{ name: string; value: string; hidden: boolean }>[];
}>;

/** The note as `bw create item` reads it: the JSON of bw's item template,
 * base64-encoded (what `bw encode` prints). */
export function encodedNote(note: BwNote): string {
  const item = {
    organizationId: note.organizationId,
    collectionIds: [note.collectionId],
    folderId: null,
    type: secureNoteType,
    name: note.name,
    notes: note.notes,
    favorite: false,
    fields: note.fields.map((field) => ({
      name: field.name,
      value: field.value,
      type: field.hidden ? hiddenFieldType : textFieldType,
      linkedId: null,
    })),
    login: null,
    secureNote: { type: 0 },
    card: null,
    identity: null,
    reprompt: 0,
  };
  return Buffer.from(JSON.stringify(item), "utf8").toString("base64");
}

/** `bw create item`: the new item's id, and only that. bw prints the whole
 * item, values included; nothing else of it is read or kept. An item that is
 * not in the organization asked for is not taken for the one created. */
export function parseCreatedItem(
  stdout: string,
  organizationId: string,
): string | null {
  const value = record(jsonOf(stdout));
  return value !== null &&
    value.object === "item" &&
    isVaultId(value.id) &&
    value.organizationId === organizationId
    ? value.id
    : null;
}

export type BwCli = ReturnType<typeof bwCli>;

export function bwCli(environment: BwEnvironment) {
  // Never a bw without a data directory of its own: bw rewrites its store on
  // every start, so a run without one would reach a default profile (a
  // person's own bw). Refused before anything runs, and set last on every
  // run, so nothing a step adds can replace it.
  if (!isAbsolute(environment.data) || !isAbsolute(environment.binary))
    throw new Error("bw runs only by its path, with its own data directory");
  const data = environment.data;
  const base: Record<string, string> = {
    PATH: environment.path ?? "/usr/bin:/bin",
    HOME: environment.home,
    BW_NOINTERACTION: "true",
  };
  async function run(
    args: readonly string[],
    extra: Readonly<Record<string, string>> = {},
    timeoutMs: number = timeouts.local,
    maxBytes?: number,
    stdin?: string,
  ): Promise<ToolProcessResult | "spawn-failed"> {
    try {
      return await environment.run(
        [environment.binary, ...args],
        timeoutMs,
        { ...base, ...extra, BITWARDENCLI_APPDATA_DIR: data },
        maxBytes === undefined && stdin === undefined
          ? undefined
          : {
              ...(maxBytes === undefined ? {} : { maxBytes }),
              ...(stdin === undefined ? {} : { stdin }),
            },
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
    stdin?: string,
  ): Promise<BwResult<T>> {
    const result = await run(args, extra, timeoutMs, maxBytes, stdin);
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
    /** How many items the account sees, or of one organization. bw has no
     * count: the list is read in memory for its length only and dropped. */
    itemCount(
      value: string,
      organizationId?: string,
    ): Promise<BwResult<number>> {
      return step(
        [
          "list",
          "items",
          ...(organizationId === undefined
            ? []
            : ["--organizationid", organizationId]),
          "--nointeraction",
        ],
        (stdout) => {
          const items = jsonOf(stdout);
          return Array.isArray(items) ? items.length : null;
        },
        session(value),
        timeouts.local,
        itemsMaxBytes,
      );
    },
    /** The items of one organization, or of one collection of it (a 0197
     * pilot), whose name is one of `names` (decision F46). The ids are not
     * secret and go on argv; bw filters by them, and the caller selects
     * again by every field. */
    secretItems(
      value: string,
      scope: Readonly<{ organizationId: string; collectionId?: string }>,
      names: ReadonlySet<string>,
    ): Promise<BwResult<BwSecretItem[]>> {
      return step(
        [
          "list",
          "items",
          "--organizationid",
          scope.organizationId,
          ...(scope.collectionId === undefined
            ? []
            : ["--collectionid", scope.collectionId]),
          "--nointeraction",
        ],
        (stdout) => parseSecretItems(stdout, names),
        session(value),
        timeouts.local,
        itemsMaxBytes,
      );
    },
    /** The members of one organization, as the vault answers now (bw asks
     * the server; the organization must be in bw's synced copy). */
    orgMembers(
      value: string,
      organizationId: string,
    ): Promise<BwResult<BwMember[]>> {
      return step(
        [
          "list",
          "org-members",
          "--organizationid",
          organizationId,
          "--nointeraction",
        ],
        parseOrgMembers,
        session(value),
        timeouts.network,
      );
    },
    /** Confirms an accepted member: bw encrypts the organization's key to
     * the member's public key, which the vault hands out (0198 point 2: the
     * fingerprint is not compared, the host's root is the higher boundary).
     * The ids are not secret and go on argv. */
    confirmMember(
      value: string,
      memberId: string,
      organizationId: string,
    ): Promise<BwResult<true>> {
      return step(
        [
          "confirm",
          "org-member",
          memberId,
          "--organizationid",
          organizationId,
          "--nointeraction",
        ],
        () => true as const,
        session(value),
        timeouts.network,
      );
    },
    /** Creates one Secure note in the Environment's own vault (decision
     * F54): the item, values included, goes to bw's standard input, encoded
     * as `bw encode` would, never to argv; of bw's answer only the new
     * item's id is read. */
    createNote(value: string, note: BwNote): Promise<BwResult<string>> {
      return step(
        ["create", "item", "--nointeraction"],
        (stdout) => parseCreatedItem(stdout, note.organizationId),
        session(value),
        timeouts.network,
        undefined,
        encodedNote(note),
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
