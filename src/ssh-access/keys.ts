import { constants } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import { fingerprintOf } from "../tools/ssh-key";
import { writeDurableFile } from "../update/durable-file";

// SSH from the person's devices (decision F49): the keys a person's own
// computer signs in with to this Environment over SSH. The one truth is the
// `authorized_keys` of the account the Launchpad runs as; nothing else
// records a key. A line the Launchpad writes ends with its marker comment
//
//   <type> <base64> lazurio-device:<device>:<added-by>:<YYYY-MM-DD>
//
// (no spaces; `<device>` the device's name reduced to `[a-z0-9-]`, at most
// 40 characters; `<added-by>` the account login the page named, lowercased,
// or `local`; the date in UTC). Only such a line, without options, is the
// Launchpad's: it is listed with its device and may be removed here. Every
// other line (the provisioning or recovery key, a key added by hand, a
// comment, a blank line) is kept byte for byte and never changed or removed.
// A write replaces the file in one rename (temporary file 0600 beside it,
// file sync, rename, directory sync) under one lock per file in this
// process. Nothing here reads, accepts or logs a private key.

/** The key types a device may register: ed25519, and its hardware-backed
 * (FIDO) form. */
export const deviceKeyTypes = [
  "ssh-ed25519",
  "sk-ssh-ed25519@openssh.com",
] as const;
export type DeviceKeyType = (typeof deviceKeyTypes)[number];

/** The marker comment's first field. */
export const markerPrefix = "lazurio-device";

const namePattern = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const addedByPattern = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/;
const markerPattern =
  /^lazurio-device:([a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?):([a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?):(\d{4}-\d{2}-\d{2})$/;
// Every key type OpenSSH names, so that one of another type, or one behind
// options, is told apart from text that is no key at all.
const knownKeyType =
  /^(?:ssh-(?:ed25519|ed448|rsa|dss)|ecdsa-sha2-nistp(?:256|384|521)|sk-(?:ssh-ed25519|ecdsa-sha2-nistp256)@openssh\.com|rsa-sha2-(?:256|512)|[a-z0-9.-]+-cert-v01@openssh\.com)$/;
const keyTypeShape = /^[a-z0-9][a-z0-9@.-]{2,63}$/;

/** The longest public key field the Launchpad reads, and the largest
 * `authorized_keys` it handles. */
const maxKeyText = 8 * 1024;
const maxFileBytes = 1024 * 1024;

/** The account login the page names, as the marker writes it, or `local`
 * when it names none. A provenance label, never evidence of a person (F11):
 * whoever is admitted acts as this account anyway. */
export function addedByLabel(login: unknown): string | null {
  if (login === undefined || login === null) return "local";
  if (typeof login !== "string") return null;
  const label = login.toLowerCase();
  return addedByPattern.test(label) ? label : null;
}

/** A device's name as the marker writes it: accents dropped, lowercase,
 * every run of other characters one dash, at most 40 characters; null when
 * nothing remains. */
export function deviceName(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 200) return null;
  const name = raw
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return namePattern.test(name) ? name : null;
}

/** The marker comment of a line the Launchpad writes. */
export function markerComment(
  device: string,
  addedBy: string,
  date: string,
): string {
  return `${markerPrefix}:${device}:${addedBy}:${date}`;
}

/** The fields of a marker comment, or null when it is none. */
export function parseMarker(
  comment: string,
): Readonly<{ device: string; addedBy: string; added: string }> | null {
  const match = markerPattern.exec(comment);
  if (match === null) return null;
  return {
    device: match[1] as string,
    addedBy: match[2] as string,
    added: match[3] as string,
  };
}

// One SSH wire string of `blob` at `offset`: its bytes and where the next
// begins, or null past the end.
function wireString(
  blob: Buffer,
  offset: number,
): { value: Buffer; next: number } | null {
  if (offset + 4 > blob.length) return null;
  const start = offset + 4;
  const end = start + blob.readUInt32BE(offset);
  if (end > blob.length) return null;
  return { value: blob.subarray(start, end), next: end };
}

// The decoded key of a base64 field, only when the field is its canonical
// encoding (a stray character never decodes to something else).
function decodeKey(field: string): Buffer | null {
  if (field.length > maxKeyText || !/^[A-Za-z0-9+/]+={0,2}$/.test(field))
    return null;
  const blob = Buffer.from(field, "base64");
  if (
    blob.length === 0 ||
    blob.toString("base64").replace(/=+$/, "") !== field.replace(/=+$/, "")
  )
    return null;
  return blob;
}

// The key type a decoded key names: its first wire string.
function embeddedType(blob: Buffer): string | null {
  const type = wireString(blob, 0);
  return type === null ? null : type.value.toString("latin1");
}

// Whether `blob` is exactly a complete key of a device type: the type, the
// 32-byte public key and, for a FIDO key, its application, nothing after.
function completeDeviceKey(type: DeviceKeyType, blob: Buffer): boolean {
  const named = wireString(blob, 0);
  if (named === null || named.value.toString("latin1") !== type) return false;
  const key = wireString(blob, named.next);
  if (key === null || key.value.length !== 32) return false;
  if (type === "ssh-ed25519") return key.next === blob.length;
  const application = wireString(blob, key.next);
  return (
    application !== null &&
    application.value.length > 0 &&
    application.next === blob.length
  );
}

const isDeviceType = (type: string): type is DeviceKeyType =>
  (deviceKeyTypes as readonly string[]).includes(type);

/** Why a pasted public key is refused. */
export type KeyRefusal =
  | "key-missing"
  | "private-key"
  | "multiple-lines"
  | "options-not-allowed"
  | "unsupported-type"
  | "invalid-key"
  | "not-a-public-key";

/** The one public key line a device registers: `type base64`, whatever
 * comment followed it dropped. Exactly one line, ed25519 or its FIDO form,
 * no options; the key must decode and name the same type. */
export function parseDeviceKey(
  raw: unknown,
):
  | Readonly<{ type: DeviceKeyType; key: string; fingerprint: string }>
  | Readonly<{ refused: KeyRefusal }> {
  if (typeof raw !== "string" || raw.trim() === "")
    return { refused: "key-missing" };
  if (/PRIVATE KEY|PuTTY-User-Key-File/i.test(raw))
    return { refused: "private-key" };
  if (raw.length > maxKeyText) return { refused: "invalid-key" };
  const lines = raw.split(/\r?\n|\r/).filter((line) => line.trim() !== "");
  if (lines.length > 1) return { refused: "multiple-lines" };
  const tokens = (lines[0] as string).trim().split(/[ \t]+/);
  const type = tokens[0] as string;
  if (!knownKeyType.test(type))
    return {
      refused: tokens.slice(1).some((token) => knownKeyType.test(token))
        ? "options-not-allowed"
        : "not-a-public-key",
    };
  if (!isDeviceType(type)) return { refused: "unsupported-type" };
  const blob = tokens[1] === undefined ? null : decodeKey(tokens[1]);
  if (blob === null || !completeDeviceKey(type, blob))
    return { refused: "invalid-key" };
  const key = blob.toString("base64");
  return { type, key, fingerprint: fingerprintOf(`${type} ${key}`) };
}

/** One line of `authorized_keys` as the Launchpad reads it. */
export type KeyLine =
  | Readonly<{ kind: "other" }>
  | Readonly<{ kind: "unreadable" }>
  | Readonly<{
      kind: "key";
      type: string;
      key: string;
      comment: string;
      options: boolean;
    }>;

// `type base64 [comment]` at the start of `text`, when the key decodes and
// names that type.
function keyFields(
  text: string,
): { type: string; key: string; comment: string } | null {
  const match = /^(\S+)[ \t]+(\S+)(?:[ \t]+(.*))?$/.exec(text);
  if (match === null) return null;
  const [, type = "", field = "", comment = ""] = match;
  if (!keyTypeShape.test(type)) return null;
  const blob = decodeKey(field);
  if (blob === null || embeddedType(blob) !== type) return null;
  return { type, key: field, comment: comment.trim() };
}

/** A line of `authorized_keys`: a blank line or a comment; a key, with or
 * without options before it (`sshd(8)` AUTHORIZED_KEYS FILE FORMAT: options
 * end at the first space outside double quotes); or a line the Launchpad
 * cannot read. */
export function parseKeyLine(text: string): KeyLine {
  const line = text.replace(/\r$/, "").trim();
  if (line === "" || line.startsWith("#")) return { kind: "other" };
  const direct = keyFields(line);
  if (direct !== null) return { kind: "key", ...direct, options: false };
  let quoted = false;
  let index = 0;
  for (; index < line.length; index++) {
    const character = line[index];
    if (quoted && character === "\\") index++;
    else if (character === '"') quoted = !quoted;
    else if (!quoted && (character === " " || character === "\t")) break;
  }
  if (quoted || index >= line.length) return { kind: "unreadable" };
  const behind = keyFields(line.slice(index).trimStart());
  return behind === null
    ? { kind: "unreadable" }
    : { kind: "key", ...behind, options: true };
}

/** A key the Launchpad added for a device. */
export type DeviceKey = Readonly<{
  origin: "launchpad";
  type: DeviceKeyType;
  fingerprint: string;
  device: string;
  addedBy: string;
  added: string;
}>;

/** A line added outside the Launchpad: listed, never changed or removed
 * here. `fingerprint` and `type` are null for a line the Launchpad cannot
 * read; `comment` is its own comment, shortened, when it has one. */
export type OutsideKey = Readonly<{
  origin: "outside";
  type: string | null;
  fingerprint: string | null;
  comment: string | null;
}>;

export type ListedKey = DeviceKey | OutsideKey;

// The Launchpad's own line: a device type, no options, exactly its marker.
function listed(line: KeyLine): ListedKey | null {
  if (line.kind === "other") return null;
  if (line.kind === "unreadable")
    return { origin: "outside", type: null, fingerprint: null, comment: null };
  const fingerprint = fingerprintOf(`${line.type} ${line.key}`);
  const marker = line.options ? null : parseMarker(line.comment);
  if (marker !== null && isDeviceType(line.type))
    return { origin: "launchpad", type: line.type, fingerprint, ...marker };
  // Shown as text: without control characters.
  const comment = [...line.comment]
    .filter((character) => character >= " " && character !== "\u007f")
    .join("")
    .trim();
  return {
    origin: "outside",
    type: line.type,
    fingerprint,
    comment: comment === "" ? null : comment.slice(0, 100),
  };
}

/** Why the file cannot be read or written here. */
export type FileRefusal =
  | "ssh-directory-unsafe"
  | "authorized-keys-symlink"
  | "authorized-keys-not-file"
  | "authorized-keys-foreign-owner"
  | "authorized-keys-too-large";

/** Where the keys live, and who must own them. */
export type KeysLocation = Readonly<{
  /** The account's home directory. */
  home: string;
  /** The account's uid; undefined where the platform has none. */
  uid: number | undefined;
}>;

const sshDirectory = (location: KeysLocation) => join(location.home, ".ssh");
const keysName = "authorized_keys";

type Read =
  | Readonly<{ bytes: Buffer; directory: boolean }>
  | Readonly<{ refused: FileRefusal }>;

// The file's bytes, opened without following a link and checked on the
// open handle: a regular file of this account in a real `~/.ssh` directory.
// A missing directory or file reads as empty.
async function readKeys(location: KeysLocation): Promise<Read> {
  const directory = sshDirectory(location);
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { bytes: Buffer.alloc(0), directory: false };
    if (code === "ELOOP" || code === "ENOTDIR")
      return { refused: "ssh-directory-unsafe" };
    throw error;
  }
  try {
    // A directory, not a link to one; the file's owner is checked below.
    if (!(await handle.stat()).isDirectory())
      return { refused: "ssh-directory-unsafe" };
  } finally {
    await handle.close();
  }
  try {
    handle = await open(
      join(directory, keysName),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { bytes: Buffer.alloc(0), directory: true };
    if (code === "ELOOP") return { refused: "authorized-keys-symlink" };
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return { refused: "authorized-keys-not-file" };
    if (location.uid !== undefined && info.uid !== location.uid)
      return { refused: "authorized-keys-foreign-owner" };
    if (info.size > maxFileBytes)
      return { refused: "authorized-keys-too-large" };
    const bytes = await handle.readFile();
    if (bytes.length > maxFileBytes)
      return { refused: "authorized-keys-too-large" };
    return { bytes, directory: true };
  } finally {
    await handle.close();
  }
}

// The lines of the file as byte ranges: each line's text and the bytes it
// occupies with its newline, so a kept line is written back exactly.
function lines(
  bytes: Buffer,
): { text: string; start: number; end: number; line: KeyLine }[] {
  const result: { text: string; start: number; end: number; line: KeyLine }[] =
    [];
  let start = 0;
  while (start < bytes.length) {
    const newline = bytes.indexOf(0x0a, start);
    const stop = newline === -1 ? bytes.length : newline;
    const text = bytes.subarray(start, stop).toString("utf8");
    result.push({
      text,
      start,
      end: newline === -1 ? bytes.length : newline + 1,
      line: parseKeyLine(text),
    });
    start = stop + 1;
  }
  return result;
}

/** Every key line of the file, in its order. */
export async function listKeys(
  location: KeysLocation,
): Promise<
  Readonly<{ keys: readonly ListedKey[] }> | Readonly<{ refused: FileRefusal }>
> {
  const read = await readKeys(location);
  if ("refused" in read) return read;
  return {
    keys: lines(read.bytes).flatMap((entry) => {
      const key = listed(entry.line);
      return key === null ? [] : [key];
    }),
  };
}

// One writer per file in this process; the next waits for the one before.
const queues = new Map<string, Promise<void>>();
function serialized<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const before = queues.get(key) ?? Promise.resolve();
  const run = before.then(operation);
  const after = run.then(
    () => undefined,
    () => undefined,
  );
  queues.set(key, after);
  void after.then(() => {
    if (queues.get(key) === after) queues.delete(key);
  });
  return run;
}

export type AddKeyResult =
  | Readonly<{
      kind: "ssh-key-added";
      /** Added now, or the key was already allowed (nothing written). */
      outcome: "added" | "already-present";
      key: ListedKey;
    }>
  | Readonly<{ kind: "blocked"; reason: FileRefusal }>;

/** Adds one device key with the Launchpad's marker, unless the same key is
 * already allowed: then the line that allows it is answered and nothing is
 * written, so an agent may simply try again. */
export function addDeviceKey(
  location: KeysLocation,
  input: Readonly<{
    key: Readonly<{ type: DeviceKeyType; key: string; fingerprint: string }>;
    device: string;
    addedBy: string;
    date: string;
  }>,
): Promise<AddKeyResult> {
  const directory = sshDirectory(location);
  return serialized(join(directory, keysName), async () => {
    const read = await readKeys(location);
    if ("refused" in read) return { kind: "blocked", reason: read.refused };
    for (const entry of lines(read.bytes)) {
      const key = listed(entry.line);
      if (key?.fingerprint === input.key.fingerprint)
        return { kind: "ssh-key-added", outcome: "already-present", key };
    }
    const comment = markerComment(input.device, input.addedBy, input.date);
    const line = `${input.key.type} ${input.key.key} ${comment}\n`;
    const kept =
      read.bytes.length === 0 || read.bytes[read.bytes.length - 1] === 0x0a
        ? read.bytes
        : Buffer.concat([read.bytes, Buffer.from("\n")]);
    if (!read.directory) await mkdir(directory, { mode: 0o700 });
    await writeDurableFile(
      directory,
      keysName,
      Buffer.concat([kept, Buffer.from(line, "utf8")]),
    );
    const added = listed(parseKeyLine(line));
    if (added === null) throw new Error("The written line is not a key");
    return { kind: "ssh-key-added", outcome: "added", key: added };
  });
}

export type RemoveKeyResult =
  | Readonly<{
      kind: "ssh-key-removed";
      key: DeviceKey;
      /** The same key is still allowed by a line added outside the
       * Launchpad, which stays. */
      stillAllowed: boolean;
    }>
  | Readonly<{
      kind: "blocked";
      reason: FileRefusal | "not-found" | "not-launchpad-key";
    }>;

/** Removes the Launchpad's lines of one key; a key only lines added outside
 * the Launchpad allow is refused, and those lines stay. */
export function removeDeviceKey(
  location: KeysLocation,
  fingerprint: string,
): Promise<RemoveKeyResult> {
  const directory = sshDirectory(location);
  return serialized(join(directory, keysName), async () => {
    const read = await readKeys(location);
    if ("refused" in read) return { kind: "blocked", reason: read.refused };
    const all = lines(read.bytes).map((entry) => ({
      ...entry,
      key: listed(entry.line),
    }));
    const matching = all.filter(
      (entry) => entry.key?.fingerprint === fingerprint,
    );
    if (matching.length === 0) return { kind: "blocked", reason: "not-found" };
    const own = matching.flatMap((entry) =>
      entry.key?.origin === "launchpad" ? [{ ...entry, key: entry.key }] : [],
    );
    const first = own[0]?.key;
    if (first === undefined)
      return { kind: "blocked", reason: "not-launchpad-key" };
    const removed = new Set(own.map((entry) => entry.start));
    await writeDurableFile(
      directory,
      keysName,
      Buffer.concat(
        all
          .filter((entry) => !removed.has(entry.start))
          .map((entry) => read.bytes.subarray(entry.start, entry.end)),
      ),
    );
    return {
      kind: "ssh-key-removed",
      key: first,
      stillAllowed: own.length < matching.length,
    };
  });
}
