import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { attachmentChecks } from "./export";
import {
  type ArchiveRecord,
  archiveFormat,
  type Check,
  countBy,
  fatalFailures,
  isMissing,
  manifestName,
  recordChecks,
  recordsName,
} from "./format";

// `lazurio buddy archive verify <dir>` (plan LZD-0033 R6a): an archive
// checked from itself alone, so it still works once Hermes is gone: the
// format, `records.jsonl` against the manifest's digest and counts, every
// record's id, order and fields, and every attachment's bytes against its
// sha256. It names what does not match by check, id and count, never by a
// text.

export type ArchiveVerify = Readonly<{
  kind: "buddy-archive-verify";
  state: "verified" | "failed";
  reason?: string;
  path: string;
  records?: number;
  checks?: readonly Check[];
  failed?: readonly string[];
}>;

type Manifest = {
  format?: unknown;
  conversations?: unknown;
  counts?: {
    records?: unknown;
    by?: unknown;
    attachments?: unknown;
    attachments_missing?: unknown;
  };
  first_ts?: unknown;
  last_ts?: unknown;
  integrity?: { records_sha256?: unknown; records_bytes?: unknown };
};

const sameCounts = (a: unknown, b: Record<string, number>) =>
  typeof a === "object" &&
  a !== null &&
  JSON.stringify(Object.entries(a).sort()) ===
    JSON.stringify(Object.entries(b).sort());

export async function verifyArchive(path: string): Promise<ArchiveVerify> {
  const failed = (reason: string): ArchiveVerify => ({
    kind: "buddy-archive-verify",
    state: "failed",
    reason,
    path,
  });
  let manifest: Manifest;
  let bytes: Buffer;
  try {
    manifest = JSON.parse(await readFile(join(path, manifestName), "utf8"));
    bytes = await readFile(join(path, recordsName));
  } catch {
    return failed("unreadable");
  }
  const checks: Check[] = [];
  const check = (name: string, ok: boolean, detail = "") =>
    checks.push({ name, ok, detail });
  check(
    "format",
    manifest?.format === archiveFormat,
    typeof manifest?.format === "string" ? manifest.format : "",
  );
  check(
    "records.sha256",
    createHash("sha256").update(bytes).digest("hex") ===
      manifest.integrity?.records_sha256 &&
      bytes.length === manifest.integrity?.records_bytes,
    `${bytes.length} bytes`,
  );

  const text = bytes.toString("utf8");
  const lines = text === "" ? [] : text.split("\n");
  const ended = lines.length === 0 || lines.pop() === "";
  const records: ArchiveRecord[] = [];
  const unparsed: number[] = [];
  lines.forEach((line, index) => {
    try {
      const record: unknown = JSON.parse(line);
      if (
        typeof record !== "object" ||
        record === null ||
        Array.isArray(record)
      )
        throw new Error("record");
      records.push(record as ArchiveRecord);
    } catch {
      unparsed.push(index + 1);
    }
  });
  check(
    "records.lines",
    ended && unparsed.length === 0,
    unparsed.length === 0
      ? `${records.length} records`
      : `unreadable lines ${unparsed.slice(0, 5).join(", ")}`,
  );
  checks.push(...recordChecks(records));

  const counts = manifest.counts ?? {};
  const by = countBy(records);
  check(
    "counts.records",
    counts.records === records.length,
    `archive ${records.length}, manifest ${String(counts.records)}`,
  );
  check("counts.by", sameCounts(counts.by, by));
  const attachments = records.reduce(
    (n, r) => n + (Array.isArray(r.attachments) ? r.attachments.length : 0),
    0,
  );
  const missing = records.reduce(
    (n, r) =>
      n +
      (Array.isArray(r.attachments)
        ? r.attachments.filter(isMissing).length
        : 0),
    0,
  );
  check(
    "counts.attachments",
    counts.attachments === attachments &&
      counts.attachments_missing === missing,
    `${attachments} attachments, ${missing} missing`,
  );
  check(
    "counts.first-last",
    manifest.first_ts === (records[0]?.ts ?? null) &&
      manifest.last_ts === (records[records.length - 1]?.ts ?? null),
  );
  const conversations = new Set(
    Array.isArray(manifest.conversations)
      ? manifest.conversations.map((c: { id?: unknown }) => c?.id)
      : [],
  );
  const orphans = records.filter((r) => !conversations.has(r.conversation));
  check(
    "conversations",
    orphans.length === 0,
    orphans.length === 0 ? "" : `${orphans.length} records`,
  );
  checks.push(...(await attachmentChecks(path, records)));

  const fatal = fatalFailures(checks);
  return {
    kind: "buddy-archive-verify",
    state: fatal.length === 0 ? "verified" : "failed",
    path,
    records: records.length,
    checks,
    ...(fatal.length === 0 ? {} : { failed: fatal }),
  };
}
