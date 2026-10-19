import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { parseUniqueJson } from "../providers/unique-json";
import { writeDurableFile } from "../update/durable-file";
import type { BwFailure, BwNote } from "./bw";
import type { VaultContext, VaultUnsupportedReason } from "./context";
import {
  connectedAccount,
  ownPaths,
  type Recorded,
  type VaultHost,
} from "./flow";
import { isSecretRequestId } from "./request-id";
import { cliOf, lockMs, usableSession, withLock } from "./session";
import { plainObject, readOwned, serialize, type VaultPaths } from "./store";

export { isSecretRequestId } from "./request-id";

// An agent's secret request (root decision 0198 point 9 (c), decision F54):
// what an agent cannot get any other way, it asks a person for in words the
// person understands (what it needs, why, and where in the service the
// person finds it), with the fields it needs. The request waits in the
// Environment's Launchpad (Apps → Trezor and its own page); any person
// admitted to the Environment fills it in or declines it, without an account
// in the vault, and the Environment saves the values as one Secure note in
// its own vault, in the collection Agenti. The agent learns only the state
// and the item's name, and reads the values from the vault.
//
// One core for `lazurio vault request` and the Launchpad, coordinated by
// files and the account's lock, never by a call between them: one JSON file
// per request beside the account's custody,
//
//   <state>/lazurio/vault/<vault host>/<account>/requests/   0700
//     <id>.json                                              0600
//
// written whole (a new file renamed into place) under the account's kernel
// lock, read without it. A request never holds a value: the values go from
// the person's form straight to bw's standard input, and nowhere else (not
// to argv, a file, the journal, a log or an answer).

/** One value the agent asks for, by the name the service gives it; a secret
 * one is a hidden field of the item and a password input on the page. */
export type SecretRequestField = Readonly<{ name: string; secret: boolean }>;

export type SecretRequestState = "pending" | "saved" | "declined";

/** A request as it is kept and answered: never a value. */
export type SecretRequest = Readonly<{
  /** Random, 24 lowercase base32 characters: its file and its page. */
  id: string;
  /** The name of the vault item the values become, all the agent reads
   * back. */
  item: string;
  /** What the agent needs, as it says it mid-sentence ("klíč pro
   * připojení k fakturaci"). */
  need: string;
  /** Why, in one short line. */
  why: string;
  /** Where in the service the person finds it. */
  where: string;
  fields: readonly SecretRequestField[];
  createdAt: string;
  state: SecretRequestState;
  /** When a person saved or declined it; null while it waits. */
  answeredAt: string | null;
}>;

/** The bounds of a request: what a person reads in one look, and what one
 * item of the vault holds. */
export const secretRequestLimits = Object.freeze({
  item: 100,
  need: 200,
  why: 300,
  where: 300,
  field: 60,
  fields: 10,
  /** One value, in characters (a private key in PEM fits). */
  value: 10_000,
  /** Requests waiting at once: a runaway agent stops here. */
  pending: 50,
});

/** Why the agent's words or fields cannot become a request. */
export type SecretRequestInvalid =
  | "item-invalid"
  | "need-invalid"
  | "why-invalid"
  | "where-invalid"
  | "fields-missing"
  | "too-many-fields"
  | "field-invalid"
  | "field-duplicate";

/** Why a request cannot be created, read or answered: a fixed code, never a
 * value or bw's output. */
export type SecretRequestRefusal =
  /** Why this Environment has no vault here (context.ts). */
  | VaultUnsupportedReason
  /** A 0197 pilot's vault is read only: no requests. */
  | "pilot-0197"
  /** The Environment's own vault is not set up (yet), or signed out. */
  | "not-connected"
  | "not-found"
  /** Saved or declined already; `state` says which. */
  | "answered"
  /** As many requests wait already as a person can answer. */
  | "too-many"
  | SecretRequestInvalid
  /** The values are not exactly the request's fields, each a non-empty
   * text within the bound. */
  | "values-invalid"
  /** Another operation holds the account's lock. */
  | "busy"
  /** The session could not be unlocked. */
  | "locked"
  | "unreachable"
  /** bw did not answer in the shape this core reads, or did not run. */
  | "vault-failed";

export type SecretRequestAnswer =
  | (Readonly<{ kind: "vault-request" }> & SecretRequest)
  | Readonly<{
      kind: "vault-request-refused";
      reason: SecretRequestRefusal;
      state?: SecretRequestState;
    }>;

export type SecretRequestsAnswer =
  | Readonly<{
      kind: "vault-requests";
      /** Oldest first. */
      requests: readonly SecretRequest[];
    }>
  | Readonly<{ kind: "vault-request-refused"; reason: SecretRequestRefusal }>;

/** What the agent gives: `--item`, `--need`, `--why`, `--where` and each
 * `--field "<Name>[:secret]"`. */
export type SecretRequestInput = Readonly<{
  item: unknown;
  need: unknown;
  why: unknown;
  where: unknown;
  fields: readonly unknown[];
}>;

// Control characters (a line break too), and the marks that reorder text.
const unsafe = /[\p{Cc}\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/u;
const length = (text: string) => [...text].length;

/** One line of plain text, trimmed, within its bounds; null otherwise. */
function plainLine(value: unknown, min: number, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return length(text) >= min && length(text) <= max && !unsafe.test(text)
    ? text
    : null;
}

const secretSuffix = ":secret";

/** `<Name>` or `<Name>:secret`: the field's name as the service gives it,
 * and whether its value is secret. */
export function parseFieldSpec(spec: unknown): SecretRequestField | null {
  if (typeof spec !== "string") return null;
  const secret = spec.endsWith(secretSuffix);
  const name = plainLine(
    secret ? spec.slice(0, -secretSuffix.length) : spec,
    1,
    secretRequestLimits.field,
  );
  return name === null ? null : Object.freeze({ name, secret });
}

type Draft = Omit<SecretRequest, "id" | "createdAt" | "state" | "answeredAt">;

/** The request the agent's words make, or the first reason they cannot. */
export function secretRequestDraft(
  input: SecretRequestInput,
):
  | Readonly<{ ok: true; draft: Draft }>
  | Readonly<{ ok: false; reason: SecretRequestInvalid }> {
  const refuse = (reason: SecretRequestInvalid) =>
    Object.freeze({ ok: false as const, reason });
  const item = plainLine(input.item, 1, secretRequestLimits.item);
  if (item === null) return refuse("item-invalid");
  const need = plainLine(input.need, 3, secretRequestLimits.need);
  if (need === null) return refuse("need-invalid");
  const why = plainLine(input.why, 3, secretRequestLimits.why);
  if (why === null) return refuse("why-invalid");
  const where = plainLine(input.where, 3, secretRequestLimits.where);
  if (where === null) return refuse("where-invalid");
  if (input.fields.length === 0) return refuse("fields-missing");
  if (input.fields.length > secretRequestLimits.fields)
    return refuse("too-many-fields");
  const fields: SecretRequestField[] = [];
  const seen = new Set<string>();
  for (const spec of input.fields) {
    const field = parseFieldSpec(spec);
    if (field === null) return refuse("field-invalid");
    // One value per name: names that differ only in case would read alike.
    const key = field.name.toLowerCase();
    if (seen.has(key)) return refuse("field-duplicate");
    seen.add(key);
    fields.push(field);
  }
  return Object.freeze({
    ok: true as const,
    draft: Object.freeze({
      item,
      need,
      why,
      where,
      fields: Object.freeze(fields),
    }),
  });
}

// --- Store ---------------------------------------------------------------

const fileName = /^([a-z2-7]{24})\.json$/;

const base32 = "abcdefghijklmnopqrstuvwxyz234567";

/** 15 random bytes as 24 lowercase base32 characters: safe in a path, a
 * file name and a command line (never a leading dash). */
export function newSecretRequestId(): string {
  const bytes = randomBytes(15);
  let bits = 0;
  let value = 0;
  let id = "";
  for (const byte of bytes) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      id += base32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return id;
}

/** Where one account keeps its requests. */
export const requestsDirectory = (paths: VaultPaths): string =>
  join(paths.directory, "requests");

const keys = [
  "answeredAt",
  "createdAt",
  "fields",
  "id",
  "item",
  "need",
  "state",
  "where",
  "why",
].join();
const timestamp = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/;

/** A request file, only in its exact form and only as the request of its
 * own name; anything else is not a request. */
export function parseSecretRequest(
  text: string,
  id: string,
): SecretRequest | null {
  let value: Record<string, unknown> | null;
  try {
    value = plainObject(parseUniqueJson(text));
  } catch {
    return null;
  }
  if (value === null || Object.keys(value).sort().join() !== keys) return null;
  const draft = secretRequestDraft({
    item: value.item,
    need: value.need,
    why: value.why,
    where: value.where,
    fields: Array.isArray(value.fields)
      ? value.fields.map((field) => {
          const entry = plainObject(field);
          return entry !== null &&
            Object.keys(entry).sort().join() === "name,secret" &&
            typeof entry.name === "string" &&
            typeof entry.secret === "boolean"
            ? `${entry.name}${entry.secret ? secretSuffix : ""}`
            : null;
        })
      : [],
  });
  const state = value.state;
  if (
    !draft.ok ||
    value.id !== id ||
    !isSecretRequestId(value.id) ||
    typeof value.createdAt !== "string" ||
    !timestamp.test(value.createdAt) ||
    (state !== "pending" && state !== "saved" && state !== "declined") ||
    (state === "pending"
      ? value.answeredAt !== null
      : typeof value.answeredAt !== "string" ||
        !timestamp.test(value.answeredAt)) ||
    // The names as written, not trimmed or merged.
    JSON.stringify(draft.draft.fields) !== JSON.stringify(value.fields) ||
    draft.draft.item !== value.item ||
    draft.draft.need !== value.need ||
    draft.draft.why !== value.why ||
    draft.draft.where !== value.where
  )
    return null;
  return Object.freeze({
    id,
    ...draft.draft,
    createdAt: value.createdAt,
    state,
    answeredAt: value.answeredAt as string | null,
  });
}

/** One request, or null when there is none of that id (or its file is not a
 * request). */
export async function readSecretRequest(
  paths: VaultPaths,
  id: string,
): Promise<SecretRequest | null> {
  if (!isSecretRequestId(id)) return null;
  let text: string | null;
  try {
    text = await readOwned(join(requestsDirectory(paths), `${id}.json`));
  } catch {
    return null;
  }
  return text === null ? null : parseSecretRequest(text, id);
}

/** Every request of the account, oldest first. A file that is not a request
 * is not listed. */
export async function readSecretRequests(
  paths: VaultPaths,
): Promise<SecretRequest[]> {
  let names: string[];
  try {
    names = await readdir(requestsDirectory(paths));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const requests: SecretRequest[] = [];
  for (const name of names.sort()) {
    const id = fileName.exec(name)?.[1];
    if (id === undefined) continue;
    const request = await readSecretRequest(paths, id);
    if (request !== null) requests.push(request);
  }
  return requests.sort(
    (a, b) =>
      a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
}

async function writeSecretRequest(
  paths: VaultPaths,
  request: SecretRequest,
): Promise<void> {
  const directory = requestsDirectory(paths);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const entry = await lstat(directory);
  if (!entry.isDirectory() || entry.isSymbolicLink())
    throw new Error("Vault requests directory is not a directory");
  await chmod(directory, 0o700);
  await writeDurableFile(directory, `${request.id}.json`, serialize(request));
}

// --- Operations ----------------------------------------------------------

const refused = (
  reason: SecretRequestRefusal,
  state?: SecretRequestState,
): SecretRequestAnswer =>
  Object.freeze({
    kind: "vault-request-refused" as const,
    reason,
    ...(state === undefined ? {} : { state }),
  });

const answered = (request: SecretRequest): SecretRequestAnswer =>
  Object.freeze({ kind: "vault-request" as const, ...request });

type Own =
  | Readonly<{ ok: true; context: VaultContext; paths: VaultPaths }>
  | Readonly<{ ok: false; reason: SecretRequestRefusal }>;

/** The Environment's own vault: requests exist only there. */
async function ownVault(host: VaultHost): Promise<Own> {
  const context = await host.context();
  if (context.kind === "unsupported")
    return { ok: false, reason: context.reason };
  // A personal Environment whose person has not connected their Bitwarden.
  if (context.kind === "needs-connection")
    return { ok: false, reason: "not-connected" };
  if (context.kind === "pilot") return { ok: false, reason: "pilot-0197" };
  return { ok: true, context, paths: ownPaths(host, context) };
}

const now = (host: VaultHost) => (host.now?.() ?? new Date()).toISOString();

/** `lazurio vault request`: a new request, waiting for a person. Only where
 * the Environment's own vault is set up, for the request's item goes there. */
export async function createSecretRequest(
  host: VaultHost,
  input: SecretRequestInput,
): Promise<SecretRequestAnswer> {
  const checked = secretRequestDraft(input);
  if (!checked.ok) return refused(checked.reason);
  const own = await ownVault(host);
  if (!own.ok) return refused(own.reason);
  if ((await connectedAccount(own.paths, own.context)) === null)
    return refused("not-connected");
  return withLock(
    own.paths,
    host.lockMs ?? lockMs,
    () => refused("busy"),
    async () => {
      const waiting = (await readSecretRequests(own.paths)).filter(
        (request) => request.state === "pending",
      );
      if (waiting.length >= secretRequestLimits.pending)
        return refused("too-many");
      const request: SecretRequest = Object.freeze({
        id: newSecretRequestId(),
        ...checked.draft,
        createdAt: now(host),
        state: "pending",
        answeredAt: null,
      });
      await writeSecretRequest(own.paths, request);
      host.journal?.({ operation: "request", outcome: "created" });
      return answered(request);
    },
  );
}

/** Every request of the Environment's own vault, oldest first. */
export async function listSecretRequests(
  host: VaultHost,
): Promise<SecretRequestsAnswer> {
  const own = await ownVault(host);
  if (!own.ok)
    return Object.freeze({
      kind: "vault-request-refused" as const,
      reason: own.reason,
    });
  return Object.freeze({
    kind: "vault-requests" as const,
    requests: Object.freeze(await readSecretRequests(own.paths)),
  });
}

/** One request, as the agent and the person see it. */
export async function secretRequestOf(
  host: VaultHost,
  id: string,
): Promise<SecretRequestAnswer> {
  const own = await ownVault(host);
  if (!own.ok) return refused(own.reason);
  const request = await readSecretRequest(own.paths, id);
  return request === null ? refused("not-found") : answered(request);
}

/** The person's values, in the order of the request's fields: exactly its
 * fields, each a non-empty text within the bound (surrounding white space,
 * which a copy brings along, removed); null otherwise. */
function valuesOf(
  request: SecretRequest,
  input: unknown,
): readonly string[] | null {
  const value = plainObject(input);
  if (value === null || Reflect.ownKeys(value).length !== request.fields.length)
    return null;
  const values: string[] = [];
  for (const field of request.fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field.name);
    if (descriptor === undefined || !("value" in descriptor)) return null;
    const text = descriptor.value;
    if (typeof text !== "string") return null;
    const trimmed = text.trim();
    if (
      trimmed === "" ||
      length(trimmed) > secretRequestLimits.value ||
      trimmed.includes("\0")
    )
      return null;
    values.push(trimmed);
  }
  return values;
}

/** The item's notes: what the agent needed, why, and where it is found, so
 * a person who opens the item in the vault knows what it is. Never a
 * value. */
export const secretRequestNotes = (request: SecretRequest): string =>
  [
    `${request.need.charAt(0).toUpperCase()}${request.need.slice(1)}`,
    request.why,
    request.where,
  ].join("\n");

/** The Secure note a request becomes, in the collection Agenti. */
function noteOf(
  request: SecretRequest,
  values: readonly string[],
  vault: Recorded,
): BwNote {
  return {
    organizationId: vault.organizationId,
    collectionId: vault.collectionId,
    name: request.item,
    notes: secretRequestNotes(request),
    fields: request.fields.map((field, index) => ({
      name: field.name,
      value: values[index] as string,
      hidden: field.secret,
    })),
  };
}

const sessionRefusal = (reason: BwFailure): SecretRequestRefusal =>
  reason === "unauthenticated"
    ? "not-connected"
    : reason === "unreachable" || reason === "timeout"
      ? "unreachable"
      : "locked";

const createRefusal = (reason: BwFailure): SecretRequestRefusal =>
  reason === "locked"
    ? "locked"
    : reason === "unauthenticated" || reason === "invalid-credentials"
      ? "not-connected"
      : reason === "unreachable" || reason === "timeout"
        ? "unreachable"
        : "vault-failed";

/** Uložit do trezoru: the values become one Secure note in the
 * Environment's own vault (collection Agenti), through bw's standard input,
 * then a sync, and the request is saved. Any person admitted to the
 * Environment answers; no account in the vault is needed (root decision
 * 0198 point 9). Under the account's lock, so a request is answered once. */
export async function saveSecretRequest(
  host: VaultHost,
  id: string,
  input: unknown,
): Promise<SecretRequestAnswer> {
  if (!isSecretRequestId(id)) return refused("not-found");
  const own = await ownVault(host);
  if (!own.ok) return refused(own.reason);
  const ready = await connectedAccount(own.paths, own.context);
  if (ready === null) return refused("not-connected");
  const journal = (outcome: string, reason?: string) =>
    host.journal?.({
      operation: "request",
      outcome,
      ...(reason === undefined ? {} : { reason }),
    });
  return withLock(
    own.paths,
    host.lockMs ?? lockMs,
    () => refused("busy"),
    async () => {
      const request = await readSecretRequest(own.paths, id);
      if (request === null) return refused("not-found");
      if (request.state !== "pending")
        return refused("answered", request.state);
      const values = valuesOf(request, input);
      if (values === null) return refused("values-invalid");
      const bw = cliOf(host, own.paths);
      let session = await usableSession(host, bw, own.paths, ready.account);
      if (!session.ok) {
        journal("refused", session.reason);
        return refused(sessionRefusal(session.reason));
      }
      const note = noteOf(request, values, ready.recorded);
      let created = await bw.createNote(session.session, note);
      // Unlocked by another bw run since the check: once more. Nothing was
      // created: bw refuses a locked vault before it sends anything.
      if (!created.ok && created.reason === "locked" && !session.fresh) {
        session = await usableSession(host, bw, own.paths, ready.account);
        if (!session.ok) {
          journal("refused", session.reason);
          return refused(sessionRefusal(session.reason));
        }
        created = await bw.createNote(session.session, note);
      }
      if (!created.ok) {
        journal("refused", created.reason);
        return refused(createRefusal(created.reason));
      }
      // The item is in the vault now; the sync brings bw's copy up to date
      // for the agents, and a failed one only delays that.
      const synced = await bw.sync(session.session);
      const saved: SecretRequest = Object.freeze({
        ...request,
        state: "saved",
        answeredAt: now(host),
      });
      await writeSecretRequest(own.paths, saved);
      journal("saved", synced.ok ? undefined : `sync-${synced.reason}`);
      return answered(saved);
    },
  );
}

/** Odmítnout: nothing goes to the vault; the agent learns it was declined. */
export async function declineSecretRequest(
  host: VaultHost,
  id: string,
): Promise<SecretRequestAnswer> {
  if (!isSecretRequestId(id)) return refused("not-found");
  const own = await ownVault(host);
  if (!own.ok) return refused(own.reason);
  return withLock(
    own.paths,
    host.lockMs ?? lockMs,
    () => refused("busy"),
    async () => {
      const request = await readSecretRequest(own.paths, id);
      if (request === null) return refused("not-found");
      if (request.state !== "pending")
        return refused("answered", request.state);
      const declined: SecretRequest = Object.freeze({
        ...request,
        state: "declined",
        answeredAt: now(host),
      });
      await writeSecretRequest(own.paths, declined);
      host.journal?.({ operation: "request", outcome: "declined" });
      return answered(declined);
    },
  );
}
