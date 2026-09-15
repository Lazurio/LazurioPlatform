import { Metadata, MetadataKind } from "@tufjs/models";
import type { JSONObject } from "@tufjs/models/dist/utils";
import { parseUniqueJson } from "../providers/unique-json";

const kinds = ["root", "timestamp", "snapshot", "targets"] as const;
type Kind = (typeof kinds)[number];

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
) {
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
  return Object.freeze({
    kind: "historical-floors-only" as const,
    root: rootBytes,
    rootVersion: root.signed.version,
    timestampVersion: timestamp?.signed.version,
    snapshotVersion,
    snapshotRoles: Object.freeze(snapshotRoles),
    targetsVersion,
  });
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
