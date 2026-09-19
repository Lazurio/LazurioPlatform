import type {
  Metadata,
  Root,
  Snapshot,
  Targets,
  Timestamp,
} from "@tufjs/models";
import {
  type ChannelDocument,
  channelTargetPath,
  parseChannelDocument,
  type UpdateChannel,
} from "../update/channel";
import { isProductVersion, updateTargets } from "../update/identity";
import {
  identityTargetPath,
  maxIdentityBytes,
  parseSignedIdentity,
} from "../update/signed-identity";
import { compareVersions } from "../update/version";
import { channelDocumentBytes, sameRelease } from "./channel-document";
import { PublishError } from "./errors";
import { type RoleName, roleNames, type Signer } from "./keys";
import {
  buildSnapshot,
  buildTargets,
  buildTimestamp,
  consistentTargetPath,
  defaultLifetimeDays,
  expiryAfter,
  type Lifetimes,
  metadataPath,
  parseMetadata,
  sha256,
  type TargetEntry,
  timestampPath,
  verifiesUnder,
} from "./metadata";

/** The publisher core (docs/update.md "Publishing"): every operation reads the
 * published tree and returns a PLAN — the files to add, in order. It performs
 * no I/O of its own beyond the `Tree` reader it is given, touches no network,
 * and never plans to change an immutable file. `applyPlan` (`tree.ts`) is the
 * only writer.
 *
 * The repository uses consistent snapshots:
 *
 *   metadata/<N>.root.json, <N>.targets.json, <N>.snapshot.json   immutable
 *   metadata/timestamp.json                                       the ONE mutable file
 *   targets/<directory>/<sha256>.<file>                           immutable
 *
 * Nothing is ever deleted, so a timestamp somebody still holds — a CDN cache,
 * an interrupted client — always describes a complete repository.
 */
export type Tree = Readonly<{
  read(path: string): Promise<Buffer | undefined>;
  /** File names directly inside `directory`; empty when it does not exist. */
  list(directory: string): Promise<readonly string[]>;
}>;

/** One file of a plan: literal bytes, or a local file to copy (an executable
 * published inside the tree) whose length and digest the plan already names.
 */
export type PlannedWrite = Readonly<
  { path: string } & ({ bytes: Buffer } | { file: string; sha256: string })
>;

export type Plan<Result> = Readonly<{
  /** In order; `metadata/timestamp.json`, when present, is last. */
  writes: readonly PlannedWrite[];
  result: Result;
}>;

type Loaded<M> = Readonly<{ version: number; bytes: Buffer; metadata: M }>;

export type Repository = Readonly<{
  /** The verified chain held by the tree, ascending; the last one is current. */
  roots: readonly Loaded<Metadata<Root>>[];
  timestamp: Loaded<Metadata<Timestamp>> | undefined;
  snapshot: Loaded<Metadata<Snapshot>> | undefined;
  targets: Loaded<Metadata<Targets>> | undefined;
}>;

export type PublishOptions = Readonly<{
  signers: Readonly<Partial<Record<RoleName, Signer>>>;
  now: Date;
  lifetimes?: Partial<Lifetimes>;
  /** Root to install first: the initial root of an empty tree, or the
   * successor of the published one. A root the tree already holds is a no-op.
   */
  root?: Uint8Array;
}>;

const currentRoot = (repository: Repository) =>
  repository.roots.at(-1) as Loaded<Metadata<Root>>;

function verifiedLink(
  previous: Metadata<Root> | undefined,
  next: Metadata<Root>,
): boolean {
  return (
    next.signed.consistentSnapshot &&
    verifiesUnder(next, "root", next) &&
    (previous === undefined ||
      (next.signed.version === previous.signed.version + 1 &&
        verifiesUnder(previous, "root", next)))
  );
}

/** Read and VERIFY what the tree publishes, as strictly as a client would.
 *
 * The tree is storage, not authority: whoever can write to the branch can put
 * anything there. Everything a plan builds on — above all the target entries
 * that the next run signs again with the real targets key — must therefore
 * carry valid signatures under the PUBLISHED current root. Metadata that does
 * not is refused (`repository-invalid`), never adopted and re-signed. Re-signing
 * happens only when the caller offers a legitimate successor root that replaces
 * a key, and then from content that verified under the root before it.
 *
 * A numbered targets or snapshot file above the referenced version is refused
 * as well: it is either the leftover of an interrupted local run, which a
 * person removes, or a sign that the timestamp was pointed back at an older
 * state.
 */
export async function loadRepository(
  tree: Tree,
): Promise<Repository | undefined> {
  const names = await tree.list("metadata");
  const numbered = (role: string) =>
    names
      .map((name) => new RegExp(`^([1-9]\\d*)\\.${role}\\.json$`).exec(name))
      .filter((match) => match !== null)
      .map((match) => Number(match[1]))
      .sort((a, b) => a - b);
  const rootVersions = numbered("root");
  if (rootVersions.length === 0) {
    if (names.length > 0) throw new PublishError("repository-invalid", "root");
    return undefined;
  }
  const roots: Loaded<Metadata<Root>>[] = [];
  for (const version of rootVersions) {
    const bytes = await tree.read(metadataPath("root", version));
    if (!bytes) throw new PublishError("repository-invalid", "root");
    const metadata = parseMetadata("root", bytes);
    if (
      metadata.signed.version !== version ||
      !verifiedLink(roots.at(-1)?.metadata, metadata)
    )
      throw new PublishError("repository-invalid", `${version}.root.json`);
    roots.push({ version, bytes, metadata });
  }
  const root = (roots.at(-1) as Loaded<Metadata<Root>>).metadata;
  const timestampBytes = await tree.read(timestampPath);
  if (!timestampBytes) {
    // Only a root: nothing was published yet, and nothing else may be here.
    if (names.some((name) => !/^[1-9]\d*\.root\.json$/.test(name)))
      throw new PublishError(
        "repository-invalid",
        "metadata without timestamp",
      );
    return {
      roots,
      timestamp: undefined,
      snapshot: undefined,
      targets: undefined,
    };
  }
  const timestamp = parseMetadata("timestamp", timestampBytes);
  if (!verifiesUnder(root, "timestamp", timestamp))
    throw new PublishError("repository-invalid", "timestamp signature");
  const linked = async <R extends "snapshot" | "targets">(
    role: R,
    meta: { version: number; length?: number; hashes?: Record<string, string> },
  ) => {
    const bytes = await tree.read(metadataPath(role, meta.version));
    const metadata = bytes ? parseMetadata(role, bytes) : undefined;
    if (
      !bytes ||
      !metadata ||
      metadata.signed.version !== meta.version ||
      (meta.length !== undefined && meta.length !== bytes.length) ||
      (meta.hashes?.sha256 !== undefined &&
        meta.hashes.sha256 !== sha256(bytes))
    )
      throw new PublishError(
        "repository-invalid",
        `${meta.version}.${role}.json`,
      );
    if (!verifiesUnder(root, role, metadata))
      throw new PublishError("repository-invalid", `${role} signature`);
    const unreferenced = numbered(role).find(
      (version) => version > meta.version,
    );
    if (unreferenced !== undefined)
      throw new PublishError(
        "repository-invalid",
        `unreferenced ${unreferenced}.${role}.json`,
      );
    return { version: meta.version, bytes, metadata };
  };
  const snapshot = await linked("snapshot", timestamp.signed.snapshotMeta);
  const targetsMeta = snapshot.metadata.signed.meta["targets.json"];
  if (!targetsMeta) throw new PublishError("repository-invalid", "snapshot");
  const targets = await linked("targets", targetsMeta);
  return {
    roots,
    timestamp: {
      version: timestamp.signed.version,
      bytes: timestampBytes,
      metadata: timestamp,
    },
    snapshot,
    targets,
  };
}

function targetEntries(repository: Repository | undefined) {
  const entries = new Map<string, TargetEntry>();
  const files = repository?.targets?.metadata.signed.targets ?? {};
  for (const [path, file] of Object.entries(files)) {
    const digest = file.hashes.sha256;
    if (digest === undefined)
      throw new PublishError("repository-invalid", "targets");
    const url = file.custom.url;
    entries.set(path, {
      length: file.length,
      sha256: digest,
      ...(typeof url === "string" ? { custom: { url } } : {}),
    });
  }
  return entries;
}

async function channelDocument(
  tree: Tree,
  entries: ReadonlyMap<string, TargetEntry>,
  channel: UpdateChannel,
): Promise<ChannelDocument | undefined> {
  const path = channelTargetPath(channel);
  const entry = entries.get(path);
  if (!entry) return undefined;
  const bytes = await tree.read(consistentTargetPath(path, entry.sha256));
  if (!bytes || sha256(bytes) !== entry.sha256)
    throw new PublishError("repository-invalid", path);
  try {
    return parseChannelDocument(bytes, channel);
  } catch {
    throw new PublishError("repository-invalid", path);
  }
}

/** Decide the root of this plan and whether it has to be written. */
function planRoot(
  repository: Repository | undefined,
  offered: Uint8Array | undefined,
): { root: Metadata<Root>; write: PlannedWrite | undefined } {
  const current = repository ? currentRoot(repository) : undefined;
  if (offered === undefined) {
    if (!current) throw new PublishError("root-missing");
    return { root: current.metadata, write: undefined };
  }
  const bytes = Buffer.from(offered);
  const next = parseMetadata("root", bytes);
  if (current && next.signed.version <= current.version) {
    // A root the chain already holds — the current one, or an older one that
    // a release tag from before a rotation still carries — changes nothing.
    const published = repository?.roots.find(
      (root) => root.version === next.signed.version,
    );
    if (!published?.bytes.equals(bytes))
      throw new PublishError("root-chain", "published version, other bytes");
    return { root: current.metadata, write: undefined };
  }
  if (!verifiedLink(current?.metadata, next))
    throw new PublishError(
      "root-chain",
      `published ${current?.version ?? "none"}, offered ${next.signed.version}`,
    );
  return {
    root: next,
    write: { path: metadataPath("root", next.signed.version), bytes },
  };
}

type Change = Readonly<{
  targets?: ReadonlyMap<string, TargetEntry>;
  files?: readonly PlannedWrite[];
  resign?: ReadonlySet<"targets" | "snapshot" | "timestamp">;
}>;

/** The ONE place that turns a change into ordered writes: target files, root,
 * targets, snapshot and the timestamp LAST. A role is rebuilt when its
 * content changes, when the role above it was rebuilt, when asked, or when
 * what is published — verified under the published root by `loadRepository` —
 * does not verify under the successor root this plan installs.
 */
function assemble(
  repository: Repository | undefined,
  change: Change,
  options: PublishOptions,
): PlannedWrite[] {
  const { root, write: rootWrite } = planRoot(repository, options.root);
  const lifetimes = { ...defaultLifetimeDays, ...options.lifetimes };
  const signerFor = (role: "targets" | "snapshot" | "timestamp") => {
    const signer = options.signers[role];
    if (!signer) throw new PublishError("key-missing", role);
    if (!root.signed.roles[role]?.keyIDs.includes(signer.key.keyID))
      throw new PublishError("key-unauthorized", role);
    return signer;
  };
  const stale = (role: "targets" | "snapshot" | "timestamp") => {
    const published = repository?.[role];
    return (
      !published ||
      change.resign?.has(role) === true ||
      !verifiesUnder(root, role, published.metadata)
    );
  };
  const writes: PlannedWrite[] = [...(change.files ?? [])];
  if (rootWrite) writes.push(rootWrite);

  let targets = repository?.targets;
  const rebuiltTargets = change.targets !== undefined || stale("targets");
  if (rebuiltTargets) {
    const version = (targets?.version ?? 0) + 1;
    const bytes = buildTargets({
      version,
      expires: expiryAfter(options.now, lifetimes.targets),
      targets: change.targets ?? targetEntries(repository),
      signer: signerFor("targets"),
    });
    targets = { version, bytes, metadata: parseMetadata("targets", bytes) };
    writes.push({ path: metadataPath("targets", version), bytes });
  }
  if (!targets) throw new PublishError("repository-invalid", "targets");

  let snapshot = repository?.snapshot;
  const rebuiltSnapshot = rebuiltTargets || stale("snapshot");
  if (rebuiltSnapshot) {
    const version = (snapshot?.version ?? 0) + 1;
    const bytes = buildSnapshot({
      version,
      expires: expiryAfter(options.now, lifetimes.snapshot),
      targetsVersion: targets.version,
      targetsBytes: targets.bytes,
      signer: signerFor("snapshot"),
    });
    snapshot = { version, bytes, metadata: parseMetadata("snapshot", bytes) };
    writes.push({ path: metadataPath("snapshot", version), bytes });
  }
  if (!snapshot) throw new PublishError("repository-invalid", "snapshot");

  if (rebuiltSnapshot || stale("timestamp")) {
    const bytes = buildTimestamp({
      version: (repository?.timestamp?.version ?? 0) + 1,
      expires: expiryAfter(options.now, lifetimes.timestamp),
      snapshotVersion: snapshot.version,
      snapshotBytes: snapshot.bytes,
      signer: signerFor("timestamp"),
    });
    writes.push({ path: timestampPath, bytes });
  }
  return writes;
}

/** A built executable and what the build says about it. */
export type ReleaseArtifact = Readonly<{
  target: string;
  sha256: string;
  length: number;
  /** Exact bytes of the signed `identity.json`. */
  identity: Buffer;
  /** Where clients download the executable (a release asset). Signed into the
   * target's `custom.url`. Without it the executable is published inside the
   * tree under its consistent-snapshot name and `file` must be given. */
  url?: string;
  file?: string;
}>;

export type ReleaseInput = Readonly<{
  channel: UpdateChannel;
  version: string;
  notes: string;
  artifacts: readonly ReleaseArtifact[];
  /** Default: the channel's current one, else `0.0.1`. */
  minimumVersion?: string;
  /** Accept `http://127.0.0.1` download locations (fixtures only). */
  allowLoopbackUrls?: boolean;
}>;

/** Generated notes are bounded like every other small signed document. */
export const maxReleaseNotesBytes = 256 * 1024;
export const releaseNotesPath = (version: string) =>
  `releases/${version}/notes.md`;

function checkedUrl(value: string, allowLoopback: boolean): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PublishError("invalid-input", "url");
  }
  const loopback =
    allowLoopback && url.protocol === "http:" && url.hostname === "127.0.0.1";
  if (
    (url.protocol !== "https:" && !loopback) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.href !== value
  )
    throw new PublishError("invalid-input", "url");
  return value;
}

export type ReleaseResult = Readonly<{
  kind: "published" | "unchanged";
  channel: UpdateChannel;
  version: string;
  sequence: number;
}>;

/** Add a release to a channel: signed artifacts, identities, notes and the new
 * channel document. Publishing the same release again is a no-op, so a failed
 * deployment can simply be repeated; a different release under a version the
 * channel already reached is refused.
 */
export async function addRelease(
  tree: Tree,
  input: ReleaseInput,
  options: PublishOptions,
): Promise<Plan<ReleaseResult>> {
  const repository = await loadRepository(tree);
  const entries = targetEntries(repository);
  if (!isProductVersion(input.version))
    throw new PublishError("invalid-input", "version");
  if (input.artifacts.length === 0)
    throw new PublishError("invalid-input", "artifacts");
  const notes = Buffer.from(input.notes, "utf8");
  if (notes.length > maxReleaseNotesBytes)
    throw new PublishError("invalid-input", "notes");

  const documentTargets: Record<string, string> = {};
  const files: PlannedWrite[] = [];
  const put = (path: string, entry: TargetEntry, write?: PlannedWrite) => {
    const published = entries.get(path);
    if (
      published &&
      (published.length !== entry.length ||
        published.sha256 !== entry.sha256 ||
        published.custom?.url !== entry.custom?.url)
    )
      throw new PublishError("immutable-conflict", path);
    entries.set(path, entry);
    if (write) files.push(write);
  };
  for (const artifact of input.artifacts) {
    if (
      !(updateTargets as readonly string[]).includes(artifact.target) ||
      documentTargets[artifact.target] !== undefined ||
      !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
      !Number.isSafeInteger(artifact.length) ||
      artifact.length < 1 ||
      artifact.identity.length > maxIdentityBytes
    )
      throw new PublishError("invalid-input", `artifact ${artifact.target}`);
    // The client holds the signed identity against the signed artifact and the
    // channel's version; a release that would fail there is never signed.
    let identity: ReturnType<typeof parseSignedIdentity>;
    try {
      identity = parseSignedIdentity(artifact.identity);
    } catch {
      throw new PublishError("invalid-input", `identity ${artifact.target}`);
    }
    if (
      identity.target !== artifact.target ||
      identity.version !== input.version ||
      identity.artifactSha256 !== artifact.sha256 ||
      identity.artifactBytes !== artifact.length
    )
      throw new PublishError("invalid-input", `identity ${artifact.target}`);
    const path = `artifacts/${artifact.sha256}/lazurio`;
    if (artifact.url !== undefined)
      put(path, {
        length: artifact.length,
        sha256: artifact.sha256,
        custom: {
          url: checkedUrl(artifact.url, input.allowLoopbackUrls === true),
        },
      });
    else if (artifact.file !== undefined)
      put(
        path,
        { length: artifact.length, sha256: artifact.sha256 },
        {
          path: consistentTargetPath(path, artifact.sha256),
          file: artifact.file,
          sha256: artifact.sha256,
        },
      );
    else throw new PublishError("invalid-input", `artifact ${artifact.target}`);
    const identityPath = identityTargetPath(path);
    const identityDigest = sha256(artifact.identity);
    put(
      identityPath,
      { length: artifact.identity.length, sha256: identityDigest },
      {
        path: consistentTargetPath(identityPath, identityDigest),
        bytes: artifact.identity,
      },
    );
    documentTargets[artifact.target] = path;
  }

  const current = await channelDocument(tree, entries, input.channel);
  if (current) {
    if (sameRelease(current, input.version, documentTargets))
      return {
        writes: [],
        result: {
          kind: "unchanged",
          channel: input.channel,
          version: current.version,
          sequence: current.sequence,
        },
      };
    if (compareVersions(input.version, current.version) <= 0)
      throw new PublishError(
        "not-newer",
        `${input.channel} offers ${current.version}`,
      );
    for (const target of Object.keys(current.targets))
      if (documentTargets[target] === undefined)
        throw new PublishError("target-dropped", target);
  }
  const notesPath = releaseNotesPath(input.version);
  const notesDigest = sha256(notes);
  put(
    notesPath,
    { length: notes.length, sha256: notesDigest },
    { path: consistentTargetPath(notesPath, notesDigest), bytes: notes },
  );
  const sequence = (current?.sequence ?? 0) + 1;
  const document = channelDocumentBytes({
    channel: input.channel,
    sequence,
    version: input.version,
    minimumVersion: input.minimumVersion ?? current?.minimumVersion ?? "0.0.1",
    targets: documentTargets,
  });
  const documentPath = channelTargetPath(input.channel);
  const documentDigest = sha256(document);
  // The channel path is the one target whose entry is replaced by design.
  entries.set(documentPath, {
    length: document.length,
    sha256: documentDigest,
  });
  files.push({
    path: consistentTargetPath(documentPath, documentDigest),
    bytes: document,
  });
  return {
    writes: assemble(repository, { targets: entries, files }, options),
    result: {
      kind: "published",
      channel: input.channel,
      version: input.version,
      sequence,
    },
  };
}

/** Promote `preview` to `stable`: a new signed `stable` document that names
 * the SAME artifact paths — the same digests, never a rebuild. The exact
 * version is part of the request, so an approval can never promote something
 * newer than what was reviewed. Pre-releases are never promoted.
 */
export async function promote(
  tree: Tree,
  input: Readonly<{ version: string }>,
  options: PublishOptions,
): Promise<Plan<ReleaseResult>> {
  const repository = await loadRepository(tree);
  const entries = targetEntries(repository);
  const preview = await channelDocument(tree, entries, "preview");
  if (!preview || preview.version !== input.version)
    throw new PublishError(
      "version-mismatch",
      `preview offers ${preview?.version ?? "nothing"}`,
    );
  if (input.version.includes("-"))
    throw new PublishError("invalid-input", "pre-release");
  const stable = await channelDocument(tree, entries, "stable");
  if (stable) {
    if (sameRelease(stable, preview.version, preview.targets))
      return {
        writes: [],
        result: {
          kind: "unchanged",
          channel: "stable",
          version: stable.version,
          sequence: stable.sequence,
        },
      };
    if (compareVersions(preview.version, stable.version) <= 0)
      throw new PublishError("not-newer", `stable offers ${stable.version}`);
    for (const target of Object.keys(stable.targets))
      if (preview.targets[target] === undefined)
        throw new PublishError("target-dropped", target);
  }
  const sequence = (stable?.sequence ?? 0) + 1;
  const document = channelDocumentBytes({
    channel: "stable",
    sequence,
    version: preview.version,
    minimumVersion: preview.minimumVersion,
    targets: preview.targets,
  });
  const path = channelTargetPath("stable");
  const digest = sha256(document);
  entries.set(path, { length: document.length, sha256: digest });
  return {
    writes: assemble(
      repository,
      {
        targets: entries,
        files: [{ path: consistentTargetPath(path, digest), bytes: document }],
      },
      options,
    ),
    result: {
      kind: "published",
      channel: "stable",
      version: preview.version,
      sequence,
    },
  };
}

export type RefreshRole = "targets" | "snapshot" | "timestamp";

/** Re-sign roles with a fresh expiry and the next version; no target changes.
 * A role below a re-signed one is re-signed with it (its content names the
 * bytes above). With no role named, only what the (new) root requires is
 * rebuilt — that is how a rotated root is installed.
 */
export async function refresh(
  tree: Tree,
  roles: readonly RefreshRole[],
  options: PublishOptions,
): Promise<Plan<Readonly<{ rewritten: readonly string[] }>>> {
  const repository = await loadRepository(tree);
  const writes = assemble(repository, { resign: new Set(roles) }, options);
  return { writes, result: { rewritten: writes.map((write) => write.path) } };
}

/** Days of remaining validity below which a role counts as low. Snapshot and
 * timestamp margins are when the scheduled job renews them; targets and root
 * margins are when a person with the protected keys must act.
 */
export type Margins = Readonly<Record<RoleName, number>>;
export const defaultMarginDays: Margins = Object.freeze({
  root: 60,
  targets: 30,
  snapshot: 20,
  timestamp: 5,
});

export type RoleStatus = Readonly<{
  role: RoleName;
  version: number;
  expires: string;
  remainingDays: number;
  marginDays: number;
  low: boolean;
}>;

export function repositoryStatus(
  repository: Repository,
  now: Date,
  margins: Partial<Margins> = {},
): Readonly<{ roles: readonly RoleStatus[]; low: readonly RoleName[] }> {
  const limits = { ...defaultMarginDays, ...margins };
  const roles: RoleStatus[] = [];
  for (const role of roleNames) {
    const loaded = role === "root" ? currentRoot(repository) : repository[role];
    if (!loaded) throw new PublishError("repository-invalid", role);
    const expires = loaded.metadata.signed.expires;
    const remainingDays =
      Math.floor(((Date.parse(expires) - now.getTime()) / 86_400_000) * 100) /
      100;
    if (!Number.isFinite(remainingDays))
      throw new PublishError("repository-invalid", role);
    roles.push({
      role,
      version: loaded.version,
      expires,
      remainingDays,
      marginDays: limits[role],
      low: remainingDays < limits[role],
    });
  }
  return {
    roles,
    low: roles.filter((entry) => entry.low).map((entry) => entry.role),
  };
}

/** Every object the CURRENT metadata references: the numbered chain, and for
 * each signed target either its file inside the tree or its signed URL. The
 * caller proves the URLs over the network; this proves the tree.
 */
export async function referencedObjects(tree: Tree): Promise<
  Readonly<{
    external: readonly Readonly<{
      path: string;
      url: string;
      length: number;
      sha256: string;
    }>[];
    /** Artifact paths the channel documents select right now. */
    selected: readonly string[];
  }>
> {
  // Signatures of every role were verified by `loadRepository`.
  const repository = await loadRepository(tree);
  if (!repository?.targets) throw new PublishError("repository-invalid");
  const entries = targetEntries(repository);
  const external = [];
  for (const [path, entry] of entries) {
    if (entry.custom?.url !== undefined) {
      external.push({
        path,
        url: entry.custom.url,
        length: entry.length,
        sha256: entry.sha256,
      });
      continue;
    }
    const bytes = await tree.read(consistentTargetPath(path, entry.sha256));
    if (
      !bytes ||
      bytes.length !== entry.length ||
      sha256(bytes) !== entry.sha256
    )
      throw new PublishError("unreachable", path);
  }
  const selected = new Set<string>();
  for (const channel of ["stable", "preview"] as const) {
    const document = await channelDocument(tree, entries, channel);
    for (const path of Object.values(document?.targets ?? {})) {
      if (!entries.has(path) || !entries.has(identityTargetPath(path)))
        throw new PublishError("unreachable", path);
      selected.add(path);
    }
  }
  return { external, selected: [...selected].sort() };
}
