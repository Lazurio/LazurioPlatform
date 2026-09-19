import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalize } from "@tufjs/canonical-json";
import {
  Metadata,
  MetadataKind,
  type MetaFile,
  type Root,
  type Snapshot,
  type Targets,
  type Timestamp,
} from "@tufjs/models";
import { parseUniqueJson } from "../providers/unique-json";
import type { DurableWriter } from "./durable-file";
import { type ErrorContext, UpdateFailure } from "./errors";

/** The floor vector, `trust/floors.json` (docs/update.md "The floor vector").
 *
 * What must never go backwards is more than each role's own version, and the
 * pinned client's checks live in memory and in the role FILES: they die with
 * the process, with a lost file, and with a key rotation — a retained role
 * file signed by a revoked key no longer loads (store.js:68, :118), so the
 * floor inside it silently vanishes. This record keeps the facts themselves,
 * independent of who signed the roles:
 *
 *   root       highest trusted version; signed-content digest of each retained
 *              numbered root
 *   timestamp  version; signed-content digest; the snapshot reference it names
 *   snapshot   version; signed-content digest; EVERY entry of `snapshot.meta`
 *   roles      for targets and any other role named in `snapshot.meta`:
 *              version and signed-content digest of the last role verified
 *
 * SIGNED-CONTENT DIGEST: SHA-256 over the canonical JSON of the `signed`
 * object — `canonicalize(metadata.signed.toJSON())` from `@tufjs/canonical-json`,
 * byte for byte what `@tufjs/models` verifies a signature over
 * (dist/key.js:39-41 → dist/utils/verify.js:10; `toJSON` carries unrecognized
 * signed members, dist/base.js). So key order, whitespace and the SIGNATURES do
 * not count — a role re-signed by a rotated key is the same content — and any
 * change of a signed member, known or unknown, does.
 *
 * The record is facts, never authority: it authenticates nothing and selects
 * nothing. It only refuses. Members are keyed as they are in `snapshot.meta`
 * (`targets.json`), so enabling delegations later cannot weaken the rule.
 */
export type MetaFloor = Readonly<{
  version: number;
  length?: number;
  hashes?: Readonly<Record<string, string>>;
}>;
export type RoleFloor = Readonly<{ version: number; signedSha256: string }>;
export type FloorVector = Readonly<{
  root: Readonly<{
    version: number;
    /** Root version → signed-content digest of the retained numbered root. */
    retained: Readonly<Record<string, string>>;
  }>;
  timestamp: (RoleFloor & Readonly<{ snapshot: MetaFloor }>) | null;
  snapshot:
    | (RoleFloor & Readonly<{ meta: Readonly<Record<string, MetaFloor>> }>)
    | null;
  roles: Readonly<Record<string, RoleFloor>>;
}>;

export const floorsFile = "floors.json";
export const emptyFloors: FloorVector = Object.freeze({
  root: Object.freeze({ version: 0, retained: Object.freeze({}) }),
  timestamp: null,
  snapshot: null,
  roles: Object.freeze({}),
});

/** What one authenticated role states; the unit the vector is compared with
 * and merged from.
 */
export type RoleFacts =
  | Readonly<{ kind: "root"; version: number; signedSha256: string }>
  | Readonly<{
      kind: "timestamp";
      version: number;
      signedSha256: string;
      snapshot: MetaFloor;
    }>
  | Readonly<{
      kind: "snapshot";
      version: number;
      signedSha256: string;
      meta: Readonly<Record<string, MetaFloor>>;
    }>
  /** `name` as in `snapshot.meta`, e.g. `targets.json`. */
  | Readonly<{
      kind: "role";
      name: string;
      version: number;
      signedSha256: string;
    }>;

type AnyMetadata = Metadata<Root | Timestamp | Snapshot | Targets>;

export function signedDigest(metadata: AnyMetadata): string {
  return createHash("sha256")
    .update(canonicalize(metadata.signed.toJSON()))
    .digest("hex");
}

const metaFloor = (file: MetaFile): MetaFloor =>
  Object.freeze({
    version: file.version,
    ...(file.length === undefined ? {} : { length: file.length }),
    ...(file.hashes === undefined
      ? {}
      : { hashes: Object.freeze({ ...file.hashes }) }),
  });

function parse(kind: MetadataKind, text: string): AnyMetadata {
  const metadata = Metadata.fromJSON(
    kind as MetadataKind.Targets,
    parseUniqueJson(text) as Parameters<typeof Metadata.fromJSON>[1],
  ) as AnyMetadata;
  if (metadata.signed.type !== kind) throw new Error("Wrong role type");
  return metadata;
}

const kindOfFile = (name: string): MetadataKind =>
  name === "timestamp.json"
    ? MetadataKind.Timestamp
    : name === "snapshot.json"
      ? MetadataKind.Snapshot
      : name.endsWith("root.json")
        ? MetadataKind.Root
        : MetadataKind.Targets;

/** Facts of a role that the CALLER has authenticated; this function parses
 * and measures, it verifies no signature. `name` is the file name in `trust/`.
 */
export function factsOf(name: string, text: string): RoleFacts {
  const kind = kindOfFile(name);
  const metadata = parse(kind, text);
  const common = {
    version: metadata.signed.version,
    signedSha256: signedDigest(metadata),
  };
  if (kind === MetadataKind.Root) return { kind: "root", ...common };
  if (kind === MetadataKind.Timestamp)
    return {
      kind: "timestamp",
      ...common,
      snapshot: metaFloor((metadata.signed as Timestamp).snapshotMeta),
    };
  if (kind === MetadataKind.Snapshot)
    return {
      kind: "snapshot",
      ...common,
      meta: Object.freeze(
        Object.fromEntries(
          Object.entries((metadata.signed as Snapshot).meta).map(
            ([role, file]) => [role, metaFloor(file)],
          ),
        ),
      ),
    };
  return { kind: "role", name, ...common };
}

export type FloorViolation = Readonly<{
  /** `timestamp`, `snapshot`, `root` or the name in `snapshot.meta`. */
  role: string;
  rule: "version" | "content" | "snapshot-reference" | "snapshot-meta" | "root";
  floor: number;
  offered: number;
}>;

export const violationContext = (violation: FloorViolation): ErrorContext => ({
  ...violation,
});

/** Same version must mean same recorded length and hashes, where both sides
 * recorded them: a reference is a statement about content too.
 */
function sameReference(floor: MetaFloor, offered: MetaFloor): boolean {
  if (
    floor.length !== undefined &&
    offered.length !== undefined &&
    floor.length !== offered.length
  )
    return false;
  for (const [algorithm, digest] of Object.entries(floor.hashes ?? {})) {
    const other = offered.hashes?.[algorithm];
    if (other !== undefined && other !== digest) return false;
  }
  return true;
}

/** The five rules of the contract, over ONE candidate. The first violation is
 * returned; nothing is changed. The candidate is authentic already — this is
 * rollback and equivocation, not authentication.
 */
export function violationOf(
  vector: FloorVector,
  facts: RoleFacts,
): FloorViolation | undefined {
  const versionOrContent = (
    role: string,
    floor: RoleFloor | null | undefined,
  ): FloorViolation | undefined => {
    if (!floor) return undefined;
    // 1. A version lower than its floor.
    if (facts.version < floor.version)
      return {
        role,
        rule: "version",
        floor: floor.version,
        offered: facts.version,
      };
    // 2. The same version with different signed content: equivocation.
    if (
      facts.version === floor.version &&
      facts.signedSha256 !== floor.signedSha256
    )
      return {
        role,
        rule: "content",
        floor: floor.version,
        offered: facts.version,
      };
    return undefined;
  };
  if (facts.kind === "root") {
    // 5. Chain verification is the caller's (`verifiedRootChain`); here: no
    // other content at a version that is already retained.
    const retained = vector.root.retained[String(facts.version)];
    return retained !== undefined && retained !== facts.signedSha256
      ? {
          role: "root",
          rule: "root",
          floor: facts.version,
          offered: facts.version,
        }
      : undefined;
  }
  if (facts.kind === "timestamp") {
    const own = versionOrContent("timestamp", vector.timestamp);
    if (own) return own;
    // 3. The snapshot it names must not be lower than any snapshot version
    // this Machine has authenticated — by reference or as a snapshot itself.
    const floor = Math.max(
      vector.timestamp?.snapshot.version ?? 0,
      vector.snapshot?.version ?? 0,
    );
    if (facts.snapshot.version < floor)
      return {
        role: "timestamp",
        rule: "snapshot-reference",
        floor,
        offered: facts.snapshot.version,
      };
    if (
      vector.timestamp &&
      facts.snapshot.version === vector.timestamp.snapshot.version &&
      !sameReference(vector.timestamp.snapshot, facts.snapshot)
    )
      return {
        role: "timestamp",
        rule: "content",
        floor,
        offered: facts.snapshot.version,
      };
    return undefined;
  }
  if (facts.kind === "snapshot") {
    const own = versionOrContent("snapshot", vector.snapshot);
    if (own) return own;
    const named = vector.timestamp?.snapshot.version ?? 0;
    if (facts.version < named)
      return {
        role: "snapshot",
        rule: "snapshot-reference",
        floor: named,
        offered: facts.version,
      };
    // 4. No previously recorded entry may disappear, go down, or change its
    // content at the same version; and no entry may be lower than a role of
    // that name that was actually verified.
    const names = new Set([
      ...Object.keys(vector.snapshot?.meta ?? {}),
      ...Object.keys(vector.roles),
    ]);
    for (const name of names) {
      const recorded = vector.snapshot?.meta[name];
      const floor = Math.max(
        recorded?.version ?? 0,
        vector.roles[name]?.version ?? 0,
      );
      const offered = facts.meta[name];
      if (!offered || offered.version < floor)
        return {
          role: name,
          rule: "snapshot-meta",
          floor,
          offered: offered?.version ?? 0,
        };
      if (
        recorded &&
        offered.version === recorded.version &&
        !sameReference(recorded, offered)
      )
        return {
          role: name,
          rule: "content",
          floor,
          offered: offered.version,
        };
    }
    return undefined;
  }
  const own = versionOrContent(facts.name, vector.roles[facts.name]);
  if (own) return own;
  const listed = vector.snapshot?.meta[facts.name]?.version ?? 0;
  return facts.version < listed
    ? {
        role: facts.name,
        rule: "version",
        floor: listed,
        offered: facts.version,
      }
    : undefined;
}

/** Element-wise maximum. Monotonic by construction: nothing in the result is
 * lower than in `vector`, whatever `facts` says, so merging is safe even for
 * facts that were not compared first.
 */
export function mergeFloors(
  vector: FloorVector,
  all: readonly RoleFacts[],
): FloorVector {
  let { root, timestamp, snapshot } = vector;
  const roles: Record<string, RoleFloor> = { ...vector.roles };
  for (const facts of all) {
    const role: RoleFloor = {
      version: facts.version,
      signedSha256: facts.signedSha256,
    };
    if (facts.kind === "root")
      root = {
        version: Math.max(root.version, facts.version),
        retained: {
          [String(facts.version)]: facts.signedSha256,
          // What is retained already is never replaced.
          ...root.retained,
        },
      };
    else if (facts.kind === "timestamp") {
      if (!timestamp || facts.version > timestamp.version)
        timestamp = {
          ...role,
          snapshot:
            timestamp && timestamp.snapshot.version > facts.snapshot.version
              ? timestamp.snapshot
              : facts.snapshot,
        };
    } else if (facts.kind === "snapshot") {
      if (!snapshot || facts.version > snapshot.version) {
        const meta: Record<string, MetaFloor> = { ...facts.meta };
        for (const [name, floor] of Object.entries(snapshot?.meta ?? {}))
          if ((meta[name]?.version ?? 0) < floor.version) meta[name] = floor;
        snapshot = { ...role, meta };
      }
    } else if ((roles[facts.name]?.version ?? 0) < facts.version)
      roles[facts.name] = role;
  }
  return { root, timestamp, snapshot, roles };
}

/** Stable text: equal vectors are equal bytes, so "nothing changed" is a
 * string comparison and an unchanged vector is never rewritten.
 */
export function serializeFloors(vector: FloorVector): string {
  return `${canonicalize({ schemaVersion: 1, ...vector })}\n`;
}

const isDigest = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const isVersion = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

function parseMetaFloor(value: unknown): MetaFloor {
  if (
    !isRecord(value) ||
    !isVersion(value.version) ||
    !(value.length === undefined || isVersion(value.length)) ||
    !(
      value.hashes === undefined ||
      (isRecord(value.hashes) &&
        Object.values(value.hashes).every((hash) => typeof hash === "string"))
    )
  )
    throw new Error("Unrecognized floor reference");
  return Object.freeze({
    version: value.version,
    ...(value.length === undefined ? {} : { length: value.length }),
    ...(value.hashes === undefined
      ? {}
      : { hashes: value.hashes as Record<string, string> }),
  });
}

function parseRoleFloor(value: unknown): RoleFloor {
  if (
    !isRecord(value) ||
    !isVersion(value.version) ||
    !isDigest(value.signedSha256)
  )
    throw new Error("Unrecognized role floor");
  return { version: value.version, signedSha256: value.signedSha256 };
}

/** Throws on anything but a well-formed record of the known schema. */
export function parseFloors(text: string): FloorVector {
  const value = parseUniqueJson(text);
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !isRecord(value.root) ||
    !isVersion(value.root.version) ||
    !isRecord(value.root.retained) ||
    !Object.entries(value.root.retained).every(
      ([version, digest]) => /^[1-9]\d*$/.test(version) && isDigest(digest),
    ) ||
    !isRecord(value.roles)
  )
    throw new Error("Unrecognized floor vector");
  const timestamp = value.timestamp;
  const snapshot = value.snapshot;
  return {
    root: {
      version: value.root.version,
      retained: value.root.retained as Record<string, string>,
    },
    timestamp:
      timestamp === null
        ? null
        : {
            ...parseRoleFloor(timestamp),
            snapshot: parseMetaFloor(
              (timestamp as Record<string, unknown>).snapshot,
            ),
          },
    snapshot:
      snapshot === null
        ? null
        : {
            ...parseRoleFloor(snapshot),
            meta: Object.fromEntries(
              Object.entries(
                (snapshot as Record<string, unknown>).meta as Record<
                  string,
                  unknown
                >,
              ).map(([name, floor]) => [name, parseMetaFloor(floor)]),
            ),
          },
    roles: Object.fromEntries(
      Object.entries(value.roles).map(([name, floor]) => [
        name,
        parseRoleFloor(floor),
      ]),
    ),
  };
}

/** Rebuild the vector from what `trust/` retains, for a `floors.json` that is
 * missing or unreadable. The retained numbered roots are walked as a verified
 * chain; each role file then contributes its facts when it verifies under ANY
 * root of that chain, newest first — the root that was valid for it. A role
 * signed by a since revoked key is exactly the case this exists for. Never
 * throws and never returns less than those files prove.
 */
export async function rebuildFloors(
  trustDirectory: string,
): Promise<FloorVector> {
  const text = (name: string) =>
    readFile(join(trustDirectory, name), "utf8").catch(() => undefined);
  const versions = (await readdir(trustDirectory).catch(() => []))
    .map((name) => /^([1-9]\d*)\.root\.json$/.exec(name)?.[1])
    .filter((version): version is string => version !== undefined)
    .map(Number)
    .sort((left, right) => left - right);
  const chain: Metadata<Root>[] = [];
  const facts: RoleFacts[] = [];
  const candidates = [
    ...(await Promise.all(
      versions.map((version) => text(`${version}.root.json`)),
    )),
    await text("root.json"),
  ];
  for (const candidate of candidates) {
    if (candidate === undefined) continue;
    try {
      const root = parse(MetadataKind.Root, candidate) as Metadata<Root>;
      const previous = chain.at(-1);
      root.verifyDelegate(MetadataKind.Root, root);
      if (previous) {
        if (root.signed.version === previous.signed.version) continue;
        if (root.signed.version !== previous.signed.version + 1) break;
        previous.verifyDelegate(MetadataKind.Root, root);
      }
      chain.push(root);
      facts.push(factsOf("root.json", candidate));
    } catch {
      // Not a link of the chain: what came before it still stands.
    }
  }
  for (const name of ["timestamp.json", "snapshot.json", "targets.json"]) {
    const candidate = await text(name);
    if (candidate === undefined) continue;
    for (const root of [...chain].reverse())
      try {
        const kind = kindOfFile(name);
        root.verifyDelegate(kind, parse(kind, candidate));
        facts.push(factsOf(name, candidate));
        break;
      } catch {
        // Try the root before it.
      }
  }
  return mergeFloors(emptyFloors, facts);
}

/** The durable vector, or the rebuilt one. `stored` is the text on disk when
 * it was usable, so the caller knows whether a write is due.
 */
export async function readFloors(
  trustDirectory: string,
): Promise<Readonly<{ vector: FloorVector; stored: string | undefined }>> {
  try {
    const stored = await readFile(join(trustDirectory, floorsFile), "utf8");
    return { vector: parseFloors(stored), stored };
  } catch {
    return { vector: await rebuildFloors(trustDirectory), stored: undefined };
  }
}

export async function writeFloors(
  trustDirectory: string,
  vector: FloorVector,
  write: DurableWriter,
): Promise<void> {
  await write(trustDirectory, floorsFile, Buffer.from(serializeFloors(vector)));
}

export function rollback(violation: FloorViolation): UpdateFailure {
  return new UpdateFailure("metadata-rollback", violationContext(violation));
}
