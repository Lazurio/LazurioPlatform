import { createHash } from "node:crypto";
import {
  type Key,
  Metadata,
  MetadataKind,
  MetaFile,
  Root,
  Snapshot,
  TargetFile,
  Targets,
  Timestamp,
} from "@tufjs/models";
import { parseUniqueJson } from "../providers/unique-json";
import { PublishError } from "./errors";
import { type RoleName, roleNames, type Signer, signatureOf } from "./keys";

/** Pure builders of signed TUF metadata and the names of a consistent-snapshot
 * repository. The publisher and the loopback fixture
 * (`scripts/update-fixture.ts`) both build every byte through this module, so
 * what tests prove about the client holds for what the publisher writes.
 */
export const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

/** Metadata lifetimes in days (docs/release-cycle.md: policy, not TUF
 * defaults). Configurable per call; these are the defaults.
 */
export type Lifetimes = Readonly<Record<RoleName, number>>;
export const defaultLifetimeDays: Lifetimes = Object.freeze({
  root: 365,
  targets: 90,
  snapshot: 30,
  timestamp: 7,
});

const dayMs = 86_400_000;

/** `YYYY-MM-DDTHH:MM:SSZ`, the specification's date-time form. */
export function expiryAfter(now: Date, days: number): string {
  if (!Number.isFinite(days) || days <= 0)
    throw new PublishError("invalid-input", "lifetime");
  return new Date(now.getTime() + days * dayMs)
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z");
}

/** Tree paths. Everything except `timestampPath` is immutable once written. */
export const timestampPath = "metadata/timestamp.json";
export const metadataPath = (role: RoleName, version: number) =>
  role === "timestamp" ? timestampPath : `metadata/${version}.${role}.json`;

/** Consistent-snapshot name of a target: `<directory>/<sha256>.<file>`. */
export function consistentTargetPath(path: string, digest: string): string {
  const slash = path.lastIndexOf("/");
  return `targets/${path.slice(0, slash + 1)}${digest}.${path.slice(slash + 1)}`;
}

export function signMetadata(
  signed: Root | Targets | Snapshot | Timestamp,
  signers: readonly Signer[],
): Buffer {
  if (signers.length === 0) throw new PublishError("key-missing", signed.type);
  const metadata = new Metadata(signed);
  for (const signer of signers)
    metadata.sign((bytes) => signatureOf(signer, bytes), true);
  return Buffer.from(JSON.stringify(metadata.toJSON()));
}

const signedFields = (version: number, expires: string) => {
  if (!Number.isSafeInteger(version) || version < 1)
    throw new PublishError("invalid-input", "version");
  return { version, specVersion: "1.0.0", expires };
};

/** Root metadata naming one or more keys per role, threshold one (the pilot
 * policy of docs/release-cycle.md; docs/release-keys.md discloses the risk).
 */
export function buildRoot(input: {
  version: number;
  expires: string;
  keys: Readonly<Record<RoleName, readonly Key[]>>;
  signers: readonly Signer[];
}): Buffer {
  const root = new Root({
    ...signedFields(input.version, input.expires),
    consistentSnapshot: true,
  });
  for (const role of roleNames) {
    if (input.keys[role].length === 0)
      throw new PublishError("key-missing", role);
    for (const key of input.keys[role]) root.addKey(key, role);
  }
  return signMetadata(root, input.signers);
}

/** One signed target. `custom` is part of the signed bytes; the client reads
 * `custom.url` as the download location of an artifact.
 */
export type TargetEntry = Readonly<{
  length: number;
  sha256: string;
  custom?: Readonly<Record<string, string>>;
}>;

export function buildTargets(input: {
  version: number;
  expires: string;
  targets: ReadonlyMap<string, TargetEntry>;
  signer: Signer;
}): Buffer {
  const files: Record<string, TargetFile> = {};
  for (const path of [...input.targets.keys()].sort()) {
    const entry = input.targets.get(path) as TargetEntry;
    files[path] = new TargetFile({
      path,
      length: entry.length,
      hashes: { sha256: entry.sha256 },
      ...(entry.custom ? { unrecognizedFields: { custom: entry.custom } } : {}),
    });
  }
  return signMetadata(
    new Targets({
      ...signedFields(input.version, input.expires),
      targets: files,
    }),
    [input.signer],
  );
}

const metaFile = (version: number, bytes: Buffer) =>
  new MetaFile({
    version,
    length: bytes.length,
    hashes: { sha256: sha256(bytes) },
  });

export function buildSnapshot(input: {
  version: number;
  expires: string;
  targetsVersion: number;
  targetsBytes: Buffer;
  /** Further `snapshot.meta` entries, file name → version. The publisher has
   * no delegations and passes none; the fixture uses it to prove the client's
   * rule that an entry, once listed, never disappears or goes down. */
  extraMeta?: Readonly<Record<string, number>>;
  signer: Signer;
}): Buffer {
  return signMetadata(
    new Snapshot({
      ...signedFields(input.version, input.expires),
      meta: {
        "targets.json": metaFile(input.targetsVersion, input.targetsBytes),
        ...Object.fromEntries(
          Object.entries(input.extraMeta ?? {}).map(([name, version]) => [
            name,
            new MetaFile({ version }),
          ]),
        ),
      },
    }),
    [input.signer],
  );
}

export function buildTimestamp(input: {
  version: number;
  expires: string;
  snapshotVersion: number;
  snapshotBytes: Buffer;
  signer: Signer;
}): Buffer {
  return signMetadata(
    new Timestamp({
      ...signedFields(input.version, input.expires),
      snapshotMeta: metaFile(input.snapshotVersion, input.snapshotBytes),
    }),
    [input.signer],
  );
}

const kinds = {
  root: MetadataKind.Root,
  targets: MetadataKind.Targets,
  snapshot: MetadataKind.Snapshot,
  timestamp: MetadataKind.Timestamp,
} as const;

type Parsed = {
  root: Metadata<Root>;
  targets: Metadata<Targets>;
  snapshot: Metadata<Snapshot>;
  timestamp: Metadata<Timestamp>;
};

/** Parse published metadata of the named role; shape only, no signatures. */
export function parseMetadata<R extends RoleName>(
  role: R,
  bytes: Uint8Array,
): Parsed[R] {
  try {
    const value = parseUniqueJson(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    const parse = Metadata.fromJSON as (
      kind: MetadataKind,
      data: unknown,
    ) => Parsed[R];
    const metadata = parse(kinds[role], value);
    if (metadata.signed.type !== kinds[role]) throw new Error("kind");
    return metadata;
  } catch {
    throw new PublishError("repository-invalid", role);
  }
}

/** Whether `metadata` carries the threshold of valid signatures `root`
 * requires for `role` — the same primitive the client verifies with.
 */
export function verifiesUnder(
  root: Metadata<Root>,
  role: RoleName,
  metadata: Parsed[RoleName],
): boolean {
  try {
    root.verifyDelegate(role, metadata);
    return true;
  } catch {
    return false;
  }
}
