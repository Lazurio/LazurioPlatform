import { Metadata, MetadataKind } from "@tufjs/models";
import type { JSONObject } from "@tufjs/models/dist/utils";
import { parseUniqueJson } from "../providers/unique-json";
import { parseTrustCheckpoint, type TrustCheckpoint } from "./trust-checkpoint";

const kinds = ["root", "timestamp", "snapshot", "targets"] as const;
type Kind = (typeof kinds)[number];
export type HistoricalFloors = Readonly<{
  kind: "historical-floors-only";
  root: string;
  rootVersion: number;
  timestampVersion: number | undefined;
  snapshotVersion: number | undefined;
  snapshotRoles: Readonly<Record<string, number>>;
  targetsVersion: number | undefined;
}>;
// Restart recovery must reconstruct authentication from owner-bound signed
// evidence, never adopt deserialized counters as another trust store.
const authenticated = new WeakSet<HistoricalFloors>();

function seal(value: HistoricalFloors): HistoricalFloors {
  Object.freeze(value.snapshotRoles);
  Object.freeze(value);
  authenticated.add(value);
  return value;
}

/** Seed from the installation owner's already-published trusted checkpoint.
 * This is an explicit trust-input boundary, NOT authentication of arbitrary cache
 * bytes. The caller must obtain/bind it through readPublishedPilotTrust; merely
 * passing parseTrustCheckpoint is insufficient to establish that provenance.
 *
 * A trusted cache may contain individually accepted roles from different refresh
 * stages or root-key generations. Requiring a fresh, coherent chain here would
 * discard precisely the historical state recovery needs to preserve. Freshness,
 * signature/link checks of new responses and final publication remain separate.
 * The owner's channel high-water remains separately owned and must also survive.
 */
export function historicalFloorsFromTrustedCheckpoint(
  input: TrustCheckpoint,
): HistoricalFloors {
  const { metadata } = parseTrustCheckpoint(input);
  const root = Metadata.fromJSON(
    MetadataKind.Root,
    envelope(metadata.root, "root"),
  );
  root.verifyDelegate("root", root);
  const timestamp = timestampFrom(metadata.timestamp);
  const snapshot = snapshotFrom(metadata.snapshot);
  const targets = Metadata.fromJSON(
    MetadataKind.Targets,
    envelope(metadata.targets, "targets"),
  );
  const snapshotRoles: Record<string, number> = {};
  for (const [name, meta] of Object.entries(snapshot.signed.meta)) {
    positiveVersion(meta.version);
    Object.defineProperty(snapshotRoles, name, {
      value: meta.version,
      enumerable: true,
    });
  }
  positiveVersion(timestamp.signed.snapshotMeta.version);
  return seal({
    kind: "historical-floors-only",
    root: metadata.root,
    rootVersion: root.signed.version,
    timestampVersion: timestamp.signed.version,
    snapshotVersion: Math.max(
      timestamp.signed.snapshotMeta.version,
      snapshot.signed.version,
    ),
    snapshotRoles,
    targetsVersion: targets.signed.version,
  });
}

function positiveVersion(version: number) {
  if (!Number.isSafeInteger(version) || version < 1)
    throw new Error("Invalid historical referenced version");
}

function envelope(source: string, kind: Kind): JSONObject {
  if (Buffer.byteLength(source) > 1024 * 1024)
    throw new Error("Historical metadata exceeds declaration limit");
  const value = parseUniqueJson(source) as JSONObject;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid historical envelope");
  const signed = value.signed as JSONObject;
  if (
    !signed ||
    typeof signed !== "object" ||
    Array.isArray(signed) ||
    signed._type !== kind ||
    !Number.isSafeInteger(signed.version) ||
    (signed.version as number) < 1
  )
    throw new Error("Invalid historical role or version");
  return value;
}

/** Authenticate one historical response chain, NOT its freshness or original
 * acceptance. The anchor must be bound to the owner's original trusted input.
 * An expired but signed chain only establishes conservative rollback floors.
 * No filesystem/cache adoption, network, target selection or installation occurs.
 *
 * This is a building block, not the owner recovery implementation: callers must
 * merge previously accepted floors and retain incomplete/refused transcripts.
 * In particular a new root does not authorize clearing older role/channel floors.
 */
export function authenticateHistoricalRoles(
  anchor: string,
  records: readonly Readonly<{ name: string; bytes: string }>[],
): HistoricalFloors {
  if (records.length > 260) throw new Error("Historical record limit");
  let root = Metadata.fromJSON(MetadataKind.Root, envelope(anchor, "root"));
  root.verifyDelegate("root", root);
  let rootBytes = anchor;
  let timestamp: ReturnType<typeof timestampFrom> | undefined;
  let snapshot: ReturnType<typeof snapshotFrom> | undefined;
  let targetsVersion: number | undefined;
  let phase = 0;
  let size = 0;
  for (const record of records) {
    size += Buffer.byteLength(record.bytes);
    if (size > 32 * 1024 * 1024) throw new Error("Historical byte limit");
    const match =
      /^(?:([1-9][0-9]*)\.)?(root|timestamp|snapshot|targets)\.json$/.exec(
        record.name,
      );
    if (!match) throw new Error("Invalid historical record name");
    const kind = match[2] as Kind;
    const ordinal = kinds.indexOf(kind);
    if (ordinal === 0) {
      if (phase !== 0) throw new Error("Historical root out of order");
      const next = Metadata.fromJSON(
        MetadataKind.Root,
        envelope(record.bytes, "root"),
      );
      if (
        next.signed.version !== root.signed.version + 1 ||
        match[1] !== String(next.signed.version)
      )
        throw new Error("Historical root must be consecutive and versioned");
      root.verifyDelegate("root", next);
      next.verifyDelegate("root", next);
      root = next;
      rootBytes = record.bytes;
      continue;
    }
    if (ordinal !== phase + 1)
      throw new Error("Historical role gap, duplicate or reordering");
    if (kind === "timestamp") {
      if (match[1]) throw new Error("Timestamp must be unversioned");
      timestamp = timestampFrom(record.bytes);
      root.verifyDelegate("timestamp", timestamp);
    } else if (kind === "snapshot") {
      if (!timestamp) throw new Error("Missing historical timestamp");
      timestamp.signed.snapshotMeta.verify(Buffer.from(record.bytes));
      snapshot = snapshotFrom(record.bytes);
      root.verifyDelegate("snapshot", snapshot);
      if (snapshot.signed.version !== timestamp.signed.snapshotMeta.version)
        throw new Error("Historical snapshot version mismatch");
      checkName(match[1], snapshot.signed.version);
    } else {
      const link = snapshot?.signed.meta["targets.json"];
      if (!link) throw new Error("Missing historical targets link");
      link.verify(Buffer.from(record.bytes));
      const targets = Metadata.fromJSON(
        MetadataKind.Targets,
        envelope(record.bytes, "targets"),
      );
      root.verifyDelegate("targets", targets);
      if (targets.signed.version !== link.version)
        throw new Error("Historical targets version mismatch");
      checkName(match[1], targets.signed.version);
      targetsVersion = targets.signed.version;
    }
    phase = ordinal;
  }
  const snapshotRoles: Record<string, number> = {};
  for (const [name, meta] of Object.entries(snapshot?.signed.meta ?? {})) {
    if (!Number.isSafeInteger(meta.version) || meta.version < 1)
      throw new Error("Invalid historical referenced version");
    Object.defineProperty(snapshotRoles, name, {
      value: meta.version,
      enumerable: true,
    });
  }
  const snapshotVersion = timestamp?.signed.snapshotMeta.version;
  if (
    snapshotVersion !== undefined &&
    (!Number.isSafeInteger(snapshotVersion) || snapshotVersion < 1)
  )
    throw new Error("Invalid historical snapshot reference");
  return seal({
    kind: "historical-floors-only" as const,
    root: rootBytes,
    rootVersion: root.signed.version,
    timestampVersion: timestamp?.signed.version,
    snapshotVersion,
    snapshotRoles: Object.freeze(snapshotRoles),
    targetsVersion,
  });
}

/** Carry conservative floors across an authenticated subsequent chain. A partial
 * cycle cannot erase older floors; a lower signed response is not acceptance or
 * installation authority. Root/key rotation never silently resets counters.
 */
export function continueHistoricalRoles(
  previous: HistoricalFloors,
  records: readonly Readonly<{ name: string; bytes: string }>[],
): HistoricalFloors {
  if (!authenticated.has(previous))
    throw new Error(
      "Historical continuation requires reconstructed authentication",
    );
  const next = authenticateHistoricalRoles(previous.root, records);
  const snapshotRoles: Record<string, number> = {};
  for (const name of new Set([
    ...Object.keys(previous.snapshotRoles),
    ...Object.keys(next.snapshotRoles),
  ])) {
    Object.defineProperty(snapshotRoles, name, {
      value: maximum(previous.snapshotRoles[name], next.snapshotRoles[name]),
      enumerable: true,
    });
  }
  return seal({
    kind: "historical-floors-only",
    root: next.root,
    rootVersion: next.rootVersion,
    timestampVersion: maximum(previous.timestampVersion, next.timestampVersion),
    snapshotVersion: maximum(previous.snapshotVersion, next.snapshotVersion),
    snapshotRoles,
    targetsVersion: maximum(previous.targetsVersion, next.targetsVersion),
  });
}

function maximum(a: number | undefined, b: number | undefined) {
  return a === undefined ? b : b === undefined ? a : Math.max(a, b);
}

function timestampFrom(bytes: string) {
  return Metadata.fromJSON(
    MetadataKind.Timestamp,
    envelope(bytes, "timestamp"),
  );
}
function snapshotFrom(bytes: string) {
  return Metadata.fromJSON(MetadataKind.Snapshot, envelope(bytes, "snapshot"));
}
function checkName(prefix: string | undefined, version: number) {
  if (prefix !== undefined && prefix !== String(version))
    throw new Error("Historical filename version mismatch");
}
