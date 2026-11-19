import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { syncDirectory } from "../../update/durable-file";
import {
  type ArchiveAttachment,
  type ArchiveRecord,
  archiveFormat,
  archivePlatform,
  assistantName,
  attachmentFileName,
  attachmentsName,
  type Check,
  compareRecords,
  conversationOf,
  countBy,
  directoryStamp,
  fatalFailures,
  groupOf,
  isMissing,
  manifestName,
  missingAttachmentsCheck,
  recordChecks,
  recordsName,
  serializeRecords,
  sortedObject,
} from "./format";
import {
  bump,
  type Draft,
  hermesAttachment,
  hermesSchemaVersion,
  missingHermesColumns,
  type PendingAttachment,
  readHermes,
  type Stats,
} from "./hermes";
import { recountHermes, recountT3 } from "./recount";
import { missingT3Columns, readT3, t3SchemaVersion } from "./t3";

// `lazurio buddy archive export` (plan LZD-0033 R6a): Buddy GEN3's
// conversation from Hermes's and his T3 Code's stores in the person's home,
// opened read-only, into a new archive directory. Nothing runs Hermes or T3
// Code, nothing writes to their stores, nothing uses the network. The
// archive is written into a hidden directory beside the target and renamed
// into place only when every check passed, so a failure leaves no archive
// and no part of one. Answers carry counts and paths, never a text.

export const hermesStore = join(".hermes", "state.db");
export const t3Store = join(".t3-buddy", "userdata", "statev2.sqlite");
export const t3Attachments = join(".t3-buddy", "userdata", "attachments");

export type ArchiveExport = Readonly<{
  kind: "buddy-archive-export";
  state: "exported" | "refused" | "failed";
  reason?: string;
  path?: string;
  records?: number;
  by?: Record<string, number>;
  attachments?: number;
  attachments_missing?: number;
  /** With t3-source-missing: Hermes's web-chat rows left to T3 Code. */
  covered_rows?: number;
  failed?: readonly string[];
}>;

const answer = (
  state: ArchiveExport["state"],
  rest: Omit<ArchiveExport, "kind" | "state"> = {},
): ArchiveExport => ({ kind: "buddy-archive-export", state, ...rest });

const exists = (path: string) =>
  lstat(path).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );

/** A source store opened only to read: SQLite's read-only mode and
 * `query_only`, so not even a stray statement could write. */
function openReadOnly(path: string): Database {
  const db = new Database(path, { readonly: true });
  try {
    db.exec("PRAGMA query_only = ON");
    db.exec("PRAGMA busy_timeout = 5000");
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

const inside = (root: string, path: string) =>
  path === root || path.startsWith(root + sep);

async function writePrivate(path: string, bytes: string | Uint8Array) {
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
  await chmod(path, 0o600);
}

/** Copies attachments into the archive: only a regular file whose real
 * path is inside the home, read without following a final symlink, named
 * by its sha256, checked again after the copy. */
class Copier {
  readonly written = new Map<string, string>();
  constructor(
    readonly home: string,
    readonly realHome: string,
    readonly directory: string,
  ) {}

  async copy(pending: PendingAttachment): Promise<ArchiveAttachment> {
    const missing = (reason: string): ArchiveAttachment => ({
      name: pending.name,
      mime: pending.mime,
      ...(pending.size === undefined ? {} : { size: pending.size }),
      missing: true,
      reason,
    });
    if (pending.path === undefined) return missing(pending.reason ?? "absent");
    if (!isAbsolute(pending.path)) return missing("not-absolute");
    const lexical = resolve(pending.path);
    if (!inside(this.home, lexical) && !inside(this.realHome, lexical))
      return missing("outside-home");
    let real: string;
    try {
      real = await realpath(lexical);
    } catch (error) {
      return missing(
        (error as NodeJS.ErrnoException).code === "ENOENT" ||
          (error as NodeJS.ErrnoException).code === "ENOTDIR"
          ? "absent"
          : "unreadable",
      );
    }
    if (!inside(this.realHome, real)) return missing("outside-home");
    let bytes: Uint8Array;
    try {
      const file = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        if (!(await file.stat()).isFile()) return missing("not-a-file");
        bytes = await file.readFile();
      } finally {
        await file.close();
      }
    } catch {
      return missing("unreadable");
    }
    const digest = sha256(bytes);
    let name = attachmentFileName(digest, pending.name);
    const known = this.written.get(name);
    // Two contents under one short prefix and name: the full digest.
    if (known !== undefined && known !== digest)
      name = attachmentFileName(digest, pending.name, 64);
    if (this.written.get(name) !== digest) {
      const target = join(this.directory, name);
      await writePrivate(target, bytes);
      if (sha256(await readFile(target)) !== digest)
        throw new Error("attachment-copy-mismatch");
      this.written.set(name, digest);
    }
    return {
      name: pending.name,
      mime: pending.mime,
      path: `${attachmentsName}/${name}`,
      size: bytes.length,
      sha256: digest,
    };
  }
}

const titleOf = (channel: string) =>
  channel === "chat"
    ? "Chat"
    : `${channel.slice(0, 1).toUpperCase()}${channel.slice(1)}`;

async function finish(draft: Draft, copier: Copier): Promise<ArchiveRecord> {
  const attachments: ArchiveAttachment[] = [];
  for (const pending of draft.attachments)
    attachments.push(await copier.copy(pending));
  return {
    id: draft.id,
    ts: draft.ts,
    conversation: conversationOf(draft.channel),
    platform: archivePlatform,
    channel: draft.channel,
    author: draft.author,
    ...(draft.author === "user" ? {} : { author_name: assistantName }),
    kind: draft.kind,
    text: draft.text,
    attachments,
    ...(draft.options === undefined ? {} : { options: draft.options }),
    ...(draft.context === undefined ? {} : { context: draft.context }),
    source: draft.source,
  };
}

/** A record with nothing in it: no text (trimmed of any whitespace), no
 * attachment and no options. It is not emitted; only its count is kept. */
export const emptyDraft = (draft: Draft) =>
  draft.text.trim() === "" &&
  draft.attachments.length === 0 &&
  (draft.options === undefined || draft.options.length === 0);

/** The recount compared, group by group, with the records plus the empty
 * ones left out: the recount decides which rows count by the same rule as
 * the export, and every one of them is either a record or a counted skip. */
function recountChecks(
  records: readonly ArchiveRecord[],
  empty: Readonly<Record<string, number>>,
  hermes: Map<string, number> | undefined,
  t3: Map<string, number> | undefined,
): Check[] {
  const by: Record<string, number> = { ...empty };
  for (const [key, n] of Object.entries(countBy(records)))
    by[key] = (by[key] ?? 0) + n;
  const checks: Check[] = [];
  const compare = (name: string, exported: number, source: number) =>
    checks.push({
      name: `recount.${name}`,
      ok: exported === source,
      detail: `archive ${exported}, source ${source}`,
    });
  if (hermes !== undefined) {
    // Every group of Hermes's channels; of the web chat only its questions
    // and answers, whose messages T3 Code counts.
    const fromHermes = (key: string) =>
      !key.startsWith("chat/") ||
      key === "chat/assistant/question" ||
      key === "chat/user/answer";
    const groups = new Set([
      ...[...hermes.keys()].filter((key) => !key.startsWith("unparsed/")),
      ...Object.keys(by).filter(fromHermes),
      "chat/assistant/question",
      "chat/user/answer",
    ]);
    for (const key of [...groups].sort())
      compare(key, by[key] ?? 0, hermes.get(key) ?? 0);
  }
  if (t3 !== undefined) {
    compare(
      "chat/user/message",
      by["chat/user/message"] ?? 0,
      t3.get("chat/user/message") ?? 0,
    );
    compare(
      "chat/assistant/message+commentary",
      (by["chat/assistant/message"] ?? 0) +
        (by["chat/assistant/commentary"] ?? 0),
      t3.get("chat/assistant/message+commentary") ?? 0,
    );
    compare(
      "chat/user/attachments",
      records
        .filter(
          (r) =>
            r.channel === "chat" && r.author === "user" && r.kind === "message",
        )
        .reduce((sum, r) => sum + r.attachments.length, 0),
      t3.get("chat/user/attachments") ?? 0,
    );
  }
  return checks;
}

/** Every source row the export could not parse fails the archive: it may
 * hide a question, an answer or commentary. The recount's own count (SQL,
 * json_valid = 0) and the export's must both be zero. */
function parseChecks(
  stats: Stats,
  recounts: readonly (Map<string, number> | undefined)[],
): Check[] {
  const checks: Check[] = [];
  for (const recount of recounts)
    for (const [key, source] of recount ?? []) {
      if (!key.startsWith("unparsed/")) continue;
      const [, store, what] = key.split("/");
      let exported = 0;
      for (const [name, n] of stats)
        if (name.startsWith(`${store}.`) && name.endsWith(`.unparsed.${what}`))
          exported += n;
      checks.push({
        name: `source.parseable.${store}.${what}`,
        ok: source === 0 && exported === 0,
        detail: `source ${source} rows, export ${exported} rows`,
      });
    }
  return checks;
}

/** Each present attachment's file in the archive against its sha256, and
 * the missing ones listed. Shared with `verify`. */
export async function attachmentChecks(
  archive: string,
  records: readonly ArchiveRecord[],
): Promise<Check[]> {
  const bad: string[] = [];
  const listed = new Set<string>();
  let missing = 0;
  for (const record of records)
    for (const attachment of Array.isArray(record.attachments)
      ? record.attachments
      : []) {
      if (isMissing(attachment)) {
        missing += 1;
        continue;
      }
      const path = attachment.path;
      const name =
        typeof path === "string" ? path.slice(attachmentsName.length + 1) : "";
      if (
        typeof path !== "string" ||
        !path.startsWith(`${attachmentsName}/`) ||
        name === "" ||
        name.includes("/") ||
        name.startsWith(".")
      ) {
        bad.push(record.id);
        continue;
      }
      listed.add(name);
      try {
        const stat = await lstat(join(archive, attachmentsName, name));
        const bytes = stat.isFile()
          ? await readFile(join(archive, attachmentsName, name))
          : undefined;
        if (
          bytes === undefined ||
          bytes.length !== attachment.size ||
          sha256(bytes) !== attachment.sha256
        )
          bad.push(record.id);
      } catch {
        bad.push(record.id);
      }
    }
  let unlisted: string[] = [];
  try {
    unlisted = (await readdir(join(archive, attachmentsName))).filter(
      (name) => !listed.has(name),
    );
  } catch {
    unlisted = [];
  }
  return [
    {
      name: "attachments.sha256",
      ok: bad.length === 0,
      detail: `${listed.size} files${bad.length > 0 ? `, mismatch in ${bad.slice(0, 5).join(", ")}` : ""}`,
    },
    {
      name: "attachments.unlisted",
      ok: unlisted.length === 0,
      detail: unlisted.length === 0 ? "" : `${unlisted.length} files`,
    },
    {
      name: missingAttachmentsCheck,
      ok: missing === 0,
      detail: `${missing} missing`,
    },
  ];
}

type Source = Readonly<{
  kind: "hermes-state" | "t3-buddy-state";
  path: string;
  schema_version: number | null;
  missing_columns: readonly string[];
}>;

export type ExportOptions = Readonly<{
  home: string;
  output?: string | undefined;
  version: string;
  now: () => Date;
}>;

export async function exportArchive(
  options: ExportOptions,
): Promise<ArchiveExport> {
  const { home } = options;
  if (!isAbsolute(home)) return answer("failed", { reason: "home-unknown" });
  let realHome: string;
  try {
    realHome = await realpath(home);
  } catch {
    return answer("failed", { reason: "home-unknown" });
  }
  const now = options.now();
  const target =
    options.output ??
    join(home, "Buddy", "archiv", `buddy-gen3-${directoryStamp(now)}`);
  if (await exists(target))
    return answer("refused", { reason: "output-exists", path: target });
  const parent = dirname(target);
  if (options.output !== undefined) {
    const stat = await lstat(parent).catch(() => undefined);
    if (stat === undefined || !stat.isDirectory())
      return answer("refused", {
        reason: "output-parent-missing",
        path: target,
      });
  }

  // Read both stores first, entirely, and close them.
  const stats: Stats = new Map();
  const sources: Source[] = [];
  let drafts: Draft[] = [];
  let hermesCounts: Map<string, number> | undefined;
  let t3Counts: Map<string, number> | undefined;
  const hermesPath = join(home, hermesStore);
  const t3Path = join(home, t3Store);
  const hasHermes = await exists(hermesPath);
  const hasT3 = await exists(t3Path);
  if (!hasHermes && !hasT3) return answer("failed", { reason: "no-sources" });
  // Every Buddy GEN3 runs Hermes: Telegram, the questions and the
  // commentary live only there, so without it nothing can be complete.
  if (!hasHermes) return answer("refused", { reason: "hermes-source-missing" });
  let covered = 0;
  let chatCommentary: ReadonlySet<string> = new Set();
  try {
    {
      const db = openReadOnly(hermesPath);
      try {
        const missing = missingHermesColumns(db);
        sources.push({
          kind: "hermes-state",
          path: hermesStore,
          schema_version: hermesSchemaVersion(db),
          missing_columns: missing,
        });
        const read = readHermes(db, home, hermesAttachment, stats);
        drafts = [...read.platform, ...read.chatQa];
        chatCommentary = read.chatCommentary;
        covered = read.covered;
        hermesCounts = recountHermes(db);
      } finally {
        db.close();
      }
    }
  } catch {
    return answer("failed", { reason: "source-unreadable" });
  }
  // The web chat's messages are T3 Code's: Hermes's rows of it were left to
  // T3 Code, and without its store they would be lost without a trace.
  const t3Missing = answer("refused", {
    reason: "t3-source-missing",
    covered_rows: covered,
  });
  if (!hasT3 && covered > 0) return t3Missing;
  try {
    if (hasT3) {
      const db = openReadOnly(t3Path);
      try {
        const missing = missingT3Columns(db);
        sources.push({
          kind: "t3-buddy-state",
          path: t3Store,
          schema_version: t3SchemaVersion(db),
          missing_columns: missing,
        });
        const directory = join(home, t3Attachments);
        const listing = await readdir(directory).catch(() => [] as string[]);
        drafts.push(
          ...readT3(db, { directory, listing }, chatCommentary, stats),
        );
        t3Counts = recountT3(db);
      } finally {
        db.close();
      }
    }
  } catch {
    return covered > 0
      ? t3Missing
      : answer("failed", { reason: "source-unreadable" });
  }

  if (options.output === undefined)
    await mkdir(parent, { recursive: true, mode: 0o700 });
  const staging = join(parent, `.${basename(target)}.${randomUUID()}.partial`);
  let published = false;
  try {
    await mkdir(staging, { mode: 0o700 });
    await chmod(staging, 0o700);
    const attachmentsDirectory = join(staging, attachmentsName);
    await mkdir(attachmentsDirectory, { mode: 0o700 });
    await chmod(attachmentsDirectory, 0o700);
    const copier = new Copier(home, realHome, attachmentsDirectory);
    const records: ArchiveRecord[] = [];
    const empty: Record<string, number> = {};
    for (const draft of drafts) {
      if (emptyDraft(draft)) {
        bump(stats, `${draft.tag}.skipped.empty`);
        const key = groupOf(draft);
        empty[key] = (empty[key] ?? 0) + 1;
        continue;
      }
      records.push(await finish(draft, copier));
    }
    records.sort(compareRecords);

    const jsonl = serializeRecords(records);
    await writePrivate(join(staging, recordsName), jsonl);
    const checks = [
      ...recordChecks(records),
      ...recountChecks(records, empty, hermesCounts, t3Counts),
      ...parseChecks(stats, [hermesCounts, t3Counts]),
      ...(await attachmentChecks(staging, records)),
    ];
    const missing = records.flatMap((record) =>
      record.attachments.flatMap((attachment) =>
        isMissing(attachment)
          ? [
              {
                record: record.id,
                name: attachment.name,
                reason: attachment.reason,
              },
            ]
          : [],
      ),
    );
    const by = countBy(records);
    const attachments = records.reduce((n, r) => n + r.attachments.length, 0);
    const summary = {
      path: target,
      records: records.length,
      by,
      attachments,
      attachments_missing: missing.length,
    };
    const failed = fatalFailures(checks);
    if (failed.length > 0)
      return answer("failed", { reason: "incomplete", ...summary, failed });

    const channels = [
      ...new Set(records.map((record) => record.channel)),
    ].sort();
    const manifest = {
      format: archiveFormat,
      exported_at: now.toISOString(),
      exporter: { product: "lazurio", version: options.version },
      sources,
      conversations: channels.map((channel) => ({
        id: conversationOf(channel),
        platform: archivePlatform,
        channel,
        title: titleOf(channel),
      })),
      counts: {
        records: records.length,
        by,
        attachments,
        attachments_missing: missing.length,
      },
      first_ts: records[0]?.ts ?? null,
      last_ts: records[records.length - 1]?.ts ?? null,
      integrity: {
        records_sha256: sha256(new TextEncoder().encode(jsonl)),
        records_bytes: Buffer.byteLength(jsonl),
      },
      completeness: { checks, missing },
      source_accounting: sortedObject(stats),
    };
    await writePrivate(
      join(staging, manifestName),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    await syncDirectory(attachmentsDirectory);
    await syncDirectory(staging);
    if (await exists(target))
      return answer("refused", { reason: "output-exists", path: target });
    await rename(staging, target);
    published = true;
    await syncDirectory(parent);
    return answer("exported", summary);
  } finally {
    if (!published) await rm(staging, { recursive: true, force: true });
  }
}

/** Where an archive lies relative to the home, for words to the person. */
export const shownPath = (home: string, path: string) => {
  const rel = relative(home, path);
  return rel.startsWith("..") || isAbsolute(rel) ? path : `~/${rel}`;
};
