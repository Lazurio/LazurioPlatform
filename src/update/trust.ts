import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  Metadata,
  MetadataKind,
  type Root,
  type Snapshot,
  type Timestamp,
} from "@tufjs/models";
import { parseUniqueJson } from "../providers/unique-json";
import {
  type ChannelDocument,
  type ChannelFloor,
  isChannelFloor,
  isUpdateChannel,
  type UpdateChannel,
} from "./channel";
import type { DurableWriter } from "./durable-file";
import { UpdateFailure } from "./errors";

/** Durable trust: `<base>/trust/` holds the verified TUF metadata and the
 * channel floors (docs/update.md "State on disk", "Trust never rewinds").
 *
 *   root.json            the current trusted root — the only file the TUF
 *                        client is seeded with as its anchor
 *   <N>.root.json        the retained, verified root chain
 *   timestamp.json, snapshot.json, targets.json
 *   channel-floors.json  owned, schema-versioned channel high-water marks
 *
 * The directory tolerates unrelated entries: only these names are ever read.
 *
 * WHEN THE PINNED CLIENT PERSISTS (tuf-js 6.0.0, node_modules/tuf-js/dist):
 * the refresh runs in a scratch copy and `Updater.persistMetadata`
 * (updater.js:361-371) is a plain `writeFileSync` — neither atomic nor synced,
 * which is why the client never writes into `trust/` itself. For each role the
 * call order inside one refresh is:
 *
 *   root       updater.js:176 `updateRoot` → :178 persist. `updateRoot`
 *              (store.js:33-52) checks the signature threshold of the CURRENT
 *              root (:42), version == current + 1 (:44) and the new root's own
 *              signatures (:48). It does NOT check expiry: the final root's
 *              expiry is checked only when a timestamp is loaded
 *              (store.js:57-59), i.e. after the root was already persisted.
 *   timestamp  updater.js:213 `updateTimestamp` → :225 persist. store.js:53-93
 *              verifies the signature (:68) and rollback (:72-85), installs
 *              the timestamp in memory (:89) and THEN throws on expiry (:91),
 *              so an expired timestamp serves rollback protection in memory
 *              but never reaches :225. An equal version returns at :218-219
 *              without persisting.
 *   snapshot   updater.js:249 `updateSnapshot` → :251 persist. store.js:94-138
 *              checks length/hash against the timestamp (:108), signature
 *              (:118), rollback (:122-131), then expiry and the version named
 *              by the timestamp (:136 → :200-217) before returning.
 *   targets    updater.js:285 `updateDelegatedTargets` → :287 persist.
 *              store.js:139-176 checks hash (:156), signature (:165), version
 *              (:168) and expiry (:172) before installing.
 *
 * So timestamp, snapshot and targets are persisted only after their COMPLETE
 * verification, freshness included. The root is the one exception: it is
 * persisted after complete AUTHENTICITY verification but before the freshness
 * check of the final root. It is promoted regardless, deliberately:
 *  - this is the TUF client workflow itself (persist at 5.3.8, freeze check of
 *    the final root at 5.3.10): expiry is a statement about the freshness of a
 *    refresh, not about who may sign the next root;
 *  - an expired root is still the only valid anchor for its successor, and a
 *    root that revoked a key must never be forgotten. Dropping it would let a
 *    holder of the revoked key fork the chain on the next refresh — exactly
 *    the rewind this directory exists to prevent;
 *  - it cannot authenticate anything stale: every refresh re-checks the final
 *    root's expiry before it accepts any timestamp (store.js:57-59).
 * Promotion does not rest on the client's persistence order for roots at all:
 * `verifiedRootChain` re-verifies every link with the same `@tufjs/models`
 * primitives before a single root byte reaches `trust/`.
 *
 * AUTHENTICATED FAILURE-STATE FLOORS (docs/update.md "Check", item 2). The
 * statement "persisted only after complete verification" has a consequence:
 * a NEWER timestamp or snapshot that is authentic but EXPIRED never reaches
 * scratch. The store authenticates it, installs it in memory and only then
 * throws — timestamp: signature store.js:68, rollback :72-85, installed :89,
 * expiry thrown from :91 (→ :196-197); snapshot: hash :108, signature :118,
 * rollback :122-131, installed :133, expiry/version thrown from :136
 * (→ :209-215) — and `Updater` never reaches `persistMetadata`
 * (updater.js:225, :251). For the life of that process the role is the
 * client's rollback floor; on disk it would be lost, and a later replay of a
 * LOWER, still valid version would pass. `capturedFloor` below closes that
 * gap from the raw bytes the fetcher retained.
 *
 * Why a plain role file in `trust/` is a floor and nothing more — how the
 * pinned client loads an expired LOCAL role:
 *  - timestamp: updater.js:195-206 calls `updateTimestamp(local)` inside
 *    `try { … } catch { /* continue *\/ }`. store.js:89 installs the local
 *    timestamp BEFORE :91 throws on expiry, and the throw is swallowed, so the
 *    expired local timestamp stays in memory. The remote timestamp is then
 *    refused when its version (:72) or its snapshot version (:83) is lower,
 *    and is a no-op when equal (:76 → updater.js:218-219). With an equal,
 *    still expired timestamp the refresh ends at the snapshot step, because
 *    store.js:102 re-checks the final timestamp's expiry first.
 *  - snapshot: updater.js:230-233 calls `updateSnapshot(local, true)` inside a
 *    `try`; store.js:133 installs it BEFORE :136 throws (expired, or not the
 *    version the timestamp names), the catch at updater.js:234 fetches the
 *    remote snapshot, and store.js:122-131 refuses a remote snapshot whose
 *    targets version is lower than the installed local one.
 *  - targets: store.js:172-175 checks expiry BEFORE installing, so an expired
 *    local targets file is discarded without a trace. It carries no floor of
 *    its own in this client: the floor of the targets version is the snapshot's
 *    `meta` (:128). A targets role delivered last in a failed refresh is
 *    therefore never captured — nothing would be gained, and nothing expired
 *    may sit where a target could be authorized from.
 * In every path the final expiry checks (:102, :145, :172) run again before
 * a target is looked up, so expired metadata never authorizes a target.
 */
export const roleFiles = [
  "timestamp.json",
  "snapshot.json",
  "targets.json",
] as const;
const floorsFile = "channel-floors.json";

export type Seed = Readonly<{
  /** Whether `trust/root.json` existed; false means a caller-supplied root. */
  established: boolean;
  root: string;
  roles: ReadonlyMap<string, string>;
}>;

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Owned security state must not be replaceable by another account. */
export async function ensureOwnedDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (
    !stat.isDirectory() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o022) !== 0
  )
    throw new UpdateFailure("trust-invalid", { reason: "unsafe-directory" });
}

function parseRoot(text: string): Metadata<Root> {
  const value = parseUniqueJson(text);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid root envelope");
  const root = Metadata.fromJSON(
    MetadataKind.Root,
    value as Parameters<typeof Metadata.fromJSON>[1],
  );
  if (root.signed.type !== MetadataKind.Root) throw new Error("Not a root");
  return root;
}

/** Decide the trust anchor of this refresh. The bootstrap root is accepted
 * only while no root was ever promoted; an established installation never
 * falls back to it, and missing trust is never silently converted into one.
 */
export async function readSeed(
  trustDirectory: string,
  bootstrapRoot: Uint8Array | undefined,
): Promise<Seed> {
  const durable = await readOptional(join(trustDirectory, "root.json"));
  if (durable !== undefined && bootstrapRoot !== undefined)
    throw new UpdateFailure("trust-conflict");
  if (durable === undefined && bootstrapRoot === undefined)
    throw new UpdateFailure("trust-missing");
  let root: string;
  try {
    root =
      durable ??
      new TextDecoder("utf-8", { fatal: true }).decode(
        bootstrapRoot as Uint8Array,
      );
    const parsed = parseRoot(root);
    parsed.verifyDelegate(MetadataKind.Root, parsed);
  } catch {
    throw new UpdateFailure("trust-invalid", {
      subject: durable === undefined ? "bootstrap-root" : "root",
    });
  }
  const roles = new Map<string, string>();
  for (const name of roleFiles) {
    // An unreadable older role is not fatal: the client discards what it
    // cannot verify under the current root and fetches it again.
    const text = await readOptional(join(trustDirectory, name));
    if (text !== undefined) roles.set(name, text);
  }
  return Object.freeze({ established: durable !== undefined, root, roles });
}

export async function seedScratch(scratch: string, seed: Seed): Promise<void> {
  await writeFile(join(scratch, "root.json"), seed.root, { mode: 0o600 });
  for (const [name, text] of seed.roles)
    await writeFile(join(scratch, name), text, { mode: 0o600 });
}

/** Every root from the seed to the scratch's final root, each link verified:
 * signed by the threshold of its predecessor, exactly one version ahead and
 * self-signed (the checks of store.js:42-48). `fetched` is untrusted received
 * bytes; only a version that verifies AND leads to the final root is returned.
 */
function verifiedRootChain(
  seedRoot: string,
  finalRoot: string,
  fetched: ReadonlyMap<number, string>,
): { version: number; text: string }[] {
  let current = parseRoot(seedRoot);
  const chain = [{ version: current.signed.version, text: seedRoot }];
  while (chain.at(-1)?.text !== finalRoot) {
    const version = current.signed.version + 1;
    const text = fetched.get(version);
    if (text === undefined) throw new Error("Root chain incomplete");
    const next = parseRoot(text);
    current.verifyDelegate(MetadataKind.Root, next);
    if (next.signed.version !== version) throw new Error("Root chain gap");
    next.verifyDelegate(MetadataKind.Root, next);
    chain.push({ version, text });
    current = next;
  }
  return chain;
}

/** A role the client was judging when the refresh failed, re-verified WITHOUT
 * the client and WITHOUT looking at expiry: is it an authentic, newer version
 * that must be remembered as a rollback floor? Returns the text to keep, or
 * undefined to discard. Every check the store makes before it installs the
 * role in memory is repeated here with the same `@tufjs/models` primitives:
 *
 *   timestamp  signature threshold of the trusted root's timestamp role
 *              (store.js:68); version and snapshot version not below the
 *              trusted timestamp's (:72, :83). An equal version is nothing new.
 *   snapshot   length and hashes recorded by the newest authenticated
 *              timestamp (:108), signature threshold (:118), exactly the
 *              version that timestamp names (:214), and no targets version
 *              below the trusted snapshot's (:122-131).
 */
function capturedFloor(input: {
  delivered: Readonly<{ file: string; bytes: Buffer }>;
  root: Metadata<Root>;
  /** Text of the role as currently trusted (seed), if any. */
  trusted: string | undefined;
  /** Newest authenticated timestamp: the client's, or a just captured floor. */
  timestamp: string | undefined;
}): string | undefined {
  const { delivered, root } = input;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      delivered.bytes,
    );
    const json = (source: string) =>
      parseUniqueJson(source) as Parameters<typeof Metadata.fromJSON>[1];
    const timestampOf = (source: string): Metadata<Timestamp> => {
      const metadata = Metadata.fromJSON(MetadataKind.Timestamp, json(source));
      if (metadata.signed.type !== MetadataKind.Timestamp)
        throw new Error("Not a timestamp");
      root.verifyDelegate(MetadataKind.Timestamp, metadata);
      return metadata;
    };
    const snapshotOf = (source: string): Metadata<Snapshot> => {
      const metadata = Metadata.fromJSON(MetadataKind.Snapshot, json(source));
      if (metadata.signed.type !== MetadataKind.Snapshot)
        throw new Error("Not a snapshot");
      root.verifyDelegate(MetadataKind.Snapshot, metadata);
      return metadata;
    };
    // A trusted file that no longer verifies under this root is no floor.
    const orNone = <T>(read: (source: string) => T, source?: string) => {
      try {
        return source === undefined ? undefined : read(source);
      } catch {
        return undefined;
      }
    };
    if (delivered.file === "timestamp.json") {
      const next = timestampOf(text);
      const trusted = orNone(timestampOf, input.trusted);
      if (
        trusted &&
        (next.signed.version <= trusted.signed.version ||
          next.signed.snapshotMeta.version <
            trusted.signed.snapshotMeta.version)
      )
        return undefined;
      return text;
    }
    if (delivered.file === "snapshot.json") {
      const timestamp = orNone(timestampOf, input.timestamp);
      if (!timestamp) return undefined;
      timestamp.signed.snapshotMeta.verify(delivered.bytes);
      const next = snapshotOf(text);
      if (next.signed.version !== timestamp.signed.snapshotMeta.version)
        return undefined;
      const trusted = orNone(snapshotOf, input.trusted);
      for (const [name, info] of Object.entries(trusted?.signed.meta ?? {})) {
        const replacement = next.signed.meta[name];
        if (!replacement || replacement.version < info.version)
          return undefined;
      }
      return text;
    }
  } catch {
    // Not authentic, or not metadata at all.
  }
  // Roots are captured by `verifiedRootChain`; targets carry no floor (above).
  return undefined;
}

/** Capture trust when the refresh ENDS — success or failure — and before the
 * scratch is deleted, in the two ways of docs/update.md "Check":
 *  1. role files the client persisted in scratch (complete verification);
 *  2. after a FAILED refresh, the role delivered last, when `capturedFloor`
 *     authenticates it as a newer version. It is written as the ordinary role
 *     file: for the client an expired local role is a version floor and
 *     nothing else (see the top of this file).
 *
 * Order: numbered root chain ascending, `root.json`, timestamp, snapshot,
 * targets; each file by temporary file + sync + rename + directory sync. The
 * first failed write stops promotion, so `trust/` always holds a PREFIX of
 * that order. Every prefix is a state the client recovers from by itself: a
 * newer root with older roles is re-verified under that root, and a newer
 * timestamp with an older snapshot makes the client fetch the snapshot the
 * timestamp names (updater.js:231-256). A crash before the first write equals
 * a refresh that never ran — a floor included: the same repository state
 * yields the same floor at the next check.
 */
export async function promoteVerified(input: {
  trustDirectory: string;
  scratch: string;
  seed: Seed;
  fetchedRoots: ReadonlyMap<number, string>;
  /** Only after a FAILED refresh: the role the client was judging. */
  lastDelivered: Readonly<{ file: string; bytes: Buffer }> | undefined;
  write: DurableWriter;
}): Promise<string[]> {
  const { seed, trustDirectory, scratch, write } = input;
  const finalRoot = await readFile(join(scratch, "root.json"), "utf8");
  const chain = verifiedRootChain(seed.root, finalRoot, input.fetchedRoots);
  const changedRoles: { name: string; text: string }[] = [];
  for (const name of roleFiles) {
    let text = await readOptional(join(scratch, name));
    if (input.lastDelivered?.file === name)
      text =
        capturedFloor({
          delivered: input.lastDelivered,
          root: parseRoot(finalRoot),
          trusted: seed.roles.get(name),
          timestamp:
            changedRoles.find((role) => role.name === "timestamp.json")?.text ??
            (await readOptional(join(scratch, "timestamp.json"))),
        }) ?? text;
    if (text !== undefined && text !== seed.roles.get(name))
      changedRoles.push({ name, text });
  }
  // A caller-supplied root that verified nothing carries no accepted trust:
  // keeping it out means a wrong or mistyped bootstrap root can never wedge
  // the installation, and the same command can simply be repeated.
  if (!seed.established && finalRoot === seed.root && !changedRoles.length)
    return [];
  const promoted: string[] = [];
  const put = async (name: string, text: string) => {
    await write(trustDirectory, name, Buffer.from(text, "utf8"));
    promoted.push(name);
  };
  for (const { version, text } of chain) {
    const name = `${version}.root.json`;
    if ((await readOptional(join(trustDirectory, name))) !== text)
      await put(name, text);
  }
  if (!seed.established || finalRoot !== seed.root)
    await put("root.json", finalRoot);
  for (const { name, text } of changedRoles) await put(name, text);
  return promoted;
}

type Floors = Partial<Record<UpdateChannel, ChannelFloor>>;

/** A missing file means no floor yet. Anything unreadable is refused rather
 * than treated as absent: forgetting a floor is a rewind. A newer schema is
 * refused rather than guessed (docs/update.md "State on disk").
 */
export async function readChannelFloors(
  trustDirectory: string,
): Promise<Floors> {
  const text = await readOptional(join(trustDirectory, floorsFile));
  if (text === undefined) return {};
  const invalid = (reason: string) =>
    new UpdateFailure("trust-invalid", { subject: "channel-floors", reason });
  let value: unknown;
  try {
    value = parseUniqueJson(text);
  } catch {
    throw invalid("malformed");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw invalid("malformed");
  const record = value as Record<string, unknown>;
  if (
    typeof record.schemaVersion === "number" &&
    Number.isSafeInteger(record.schemaVersion) &&
    record.schemaVersion > 1
  )
    throw invalid("newer-schema");
  const channels = record.channels;
  if (
    record.schemaVersion !== 1 ||
    Object.keys(record).sort().join(",") !== "channels,schemaVersion" ||
    !channels ||
    typeof channels !== "object" ||
    Array.isArray(channels)
  )
    throw invalid("malformed");
  const floors: Floors = {};
  for (const [channel, floor] of Object.entries(channels)) {
    if (!isUpdateChannel(channel) || !isChannelFloor(floor))
      throw invalid("malformed");
    floors[channel] = Object.freeze({ ...floor });
  }
  return floors;
}

/** Only after the signed document was verified, and only forward. */
export async function advanceChannelFloor(input: {
  trustDirectory: string;
  floors: Floors;
  document: ChannelDocument;
  write: DurableWriter;
}): Promise<void> {
  const floor = input.floors[input.document.channel];
  if (floor && input.document.sequence <= floor.sequence) return;
  const channels: Floors = {
    ...input.floors,
    [input.document.channel]: {
      sequence: input.document.sequence,
      documentSha256: input.document.documentSha256,
    },
  };
  await input.write(
    input.trustDirectory,
    floorsFile,
    Buffer.from(`${JSON.stringify({ schemaVersion: 1, channels })}\n`),
  );
}
