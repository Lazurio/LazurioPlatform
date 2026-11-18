// The conversation archive of Buddy GEN3 (plan LZD-0033 R6a):
// `lazurio.conversation-archive.v1`, a directory with `manifest.json`,
// `records.jsonl` and `attachments/`. This file holds what the export and
// its verification share: the record's shape, its order and the checks that
// need nothing but the archive itself, so `verify` runs them after the
// sources are gone.

export const archiveFormat = "lazurio.conversation-archive.v1";
export const archivePlatform = "buddy-gen3";
export const assistantName = "Buddy GEN3";
export const manifestName = "manifest.json";
export const recordsName = "records.jsonl";
export const attachmentsName = "attachments";
/** The one check whose failure is reported, never fatal. */
export const missingAttachmentsCheck = "attachments.missing";

export type Author = "user" | "assistant" | "system";
export type Kind = "message" | "commentary" | "question" | "answer" | "notice";
const authors: readonly string[] = ["user", "assistant", "system"];
const kinds: readonly string[] = [
  "message",
  "commentary",
  "question",
  "answer",
  "notice",
];

export type PresentAttachment = Readonly<{
  name: string;
  mime: string;
  path: string;
  size: number;
  sha256: string;
}>;
export type MissingAttachment = Readonly<{
  name: string;
  mime: string;
  size?: number;
  missing: true;
  reason: string;
}>;
export type ArchiveAttachment = PresentAttachment | MissingAttachment;

export type ArchiveRecord = Readonly<{
  id: string;
  ts: string;
  conversation: string;
  platform: string;
  channel: string;
  author: Author;
  author_name?: string;
  kind: Kind;
  text: string;
  attachments: readonly ArchiveAttachment[];
  options?: readonly string[];
  context?: Readonly<{ page: string; ref: string }>;
  source: Readonly<Record<string, string | number>>;
}>;

export type Check = Readonly<{ name: string; ok: boolean; detail: string }>;

export const conversationOf = (channel: string) =>
  `${archivePlatform}:${channel}`;

export const isMissing = (
  attachment: ArchiveAttachment,
): attachment is MissingAttachment =>
  (attachment as { missing?: unknown }).missing === true;

/** ISO-8601 UTC with milliseconds from Unix seconds, as Python's
 * `fromtimestamp` rounds to microseconds and the reference truncates them. */
export function isoFromEpoch(seconds: number): string {
  const micros = Math.round(seconds * 1e6);
  return new Date(Math.floor(micros / 1000)).toISOString();
}

const isoPattern = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const isoLoose =
  /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d+))?(Z|[+-]\d\d:\d\d)$/;

/** An ISO timestamp of T3 Code in the archive's form; unchanged when it is
 * no timestamp, which the checks then name. */
export function isoFromString(value: string): string {
  if (isoPattern.test(value)) return value;
  const match = isoLoose.exec(value);
  if (match === null) return value;
  const fraction = (match[2] ?? "").slice(0, 3).padEnd(3, "0");
  const date = new Date(`${match[1]}.${fraction}${match[3]}`);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}

/** The UTC stamp of a default archive directory: yyyymmddThhmmssZ. */
export const directoryStamp = (now: Date) =>
  now
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z")
    .replaceAll("-", "")
    .replaceAll(":", "");

const kindOrder = (kind: string) =>
  kind === "question" ? 1 : kind === "answer" ? 2 : 0;
const compareStrings = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The archive's order: time, a question before its answer, then id. */
export function compareRecords(
  a: Pick<ArchiveRecord, "ts" | "kind" | "id">,
  b: Pick<ArchiveRecord, "ts" | "kind" | "id">,
): number {
  return (
    compareStrings(a.ts, b.ts) ||
    kindOrder(a.kind) - kindOrder(b.kind) ||
    compareStrings(a.id, b.id)
  );
}

export const groupOf = (
  record: Pick<ArchiveRecord, "channel" | "author" | "kind">,
) => `${record.channel}/${record.author}/${record.kind}`;

export function countBy(
  records: readonly ArchiveRecord[],
): Record<string, number> {
  const counts = new Map<string, number>();
  for (const record of records) {
    const key = groupOf(record);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Object.fromEntries(
    [...counts].sort(([a], [b]) => compareStrings(a, b)),
  );
}

export const sortedObject = <T>(entries: Iterable<[string, T]>) =>
  Object.fromEntries(
    [...entries].sort(([a], [b]) => compareStrings(a, b)),
  ) as Record<string, T>;

export const serializeRecords = (records: readonly ArchiveRecord[]) =>
  records.map((record) => `${JSON.stringify(record)}\n`).join("");

// What the export strips from the sources and must never be left in a text:
// envelopes of Hermes's gateway, page chips of T3 Code, attachment lines.
const leftovers = [
  "[OUT-OF-BAND",
  "[/OUT-OF-BAND",
  "Gateway message origin",
  "[kanban]",
  "t3-context://",
  "[Image attached at:",
  "Kontext stránky (údaje",
];
const mediaLine = /^\s*MEDIA:/m;

const few = (ids: readonly string[]) =>
  ids.length === 0
    ? ""
    : `${ids.length}: ${ids.slice(0, 5).join(", ")}${ids.length > 5 ? ", …" : ""}`;

/** The checks that need only the records: unique ids, the order, no empty
 * record, valid fields and no envelope left. Details name ids and counts,
 * never a text. */
export function recordChecks(records: readonly ArchiveRecord[]): Check[] {
  const seen = new Set<string>();
  const duplicates: string[] = [];
  const unordered: string[] = [];
  const empty: string[] = [];
  const invalid: string[] = [];
  const left: string[] = [];
  records.forEach((record, index) => {
    if (seen.has(record.id)) duplicates.push(record.id);
    seen.add(record.id);
    const previous = records[index - 1];
    if (previous !== undefined && compareRecords(previous, record) >= 0)
      unordered.push(record.id);
    if (
      typeof record.text !== "string" ||
      !Array.isArray(record.attachments) ||
      // Text, an attachment or the options of a question: the export's
      // rule for what it keeps.
      (record.text.trim() === "" &&
        record.attachments.length === 0 &&
        !(Array.isArray(record.options) && record.options.length > 0))
    )
      empty.push(record.id);
    if (
      typeof record.id !== "string" ||
      typeof record.ts !== "string" ||
      !isoPattern.test(record.ts) ||
      record.platform !== archivePlatform ||
      typeof record.channel !== "string" ||
      record.conversation !== conversationOf(record.channel) ||
      !authors.includes(record.author) ||
      !kinds.includes(record.kind) ||
      (record.author === "user") !== (record.author_name === undefined)
    )
      invalid.push(record.id);
    const text = typeof record.text === "string" ? record.text : "";
    if (
      leftovers.some((marker) => text.includes(marker)) ||
      mediaLine.test(text) ||
      text.trim() === "NO_REPLY"
    )
      left.push(record.id);
  });
  return [
    {
      name: "records.ids-unique",
      ok: duplicates.length === 0,
      detail: few(duplicates),
    },
    {
      name: "records.sorted",
      ok: unordered.length === 0,
      detail: few(unordered),
    },
    { name: "records.non-empty", ok: empty.length === 0, detail: few(empty) },
    { name: "records.fields", ok: invalid.length === 0, detail: few(invalid) },
    {
      name: "records.no-envelope-left",
      ok: left.length === 0,
      detail: few(left),
    },
  ];
}

export const fatalFailures = (checks: readonly Check[]) =>
  checks
    .filter((check) => !check.ok && check.name !== missingAttachmentsCheck)
    .map((check) => check.name);

/** An attachment's file name in the archive: the first 12 hex digits of its
 * sha256 and its original name with only safe characters. */
export function attachmentFileName(
  sha256: string,
  name: string,
  prefix = 12,
): string {
  const base = name.split(/[/\\]/).pop() ?? "";
  const safe = base
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^[._]+/, "")
    .slice(-80);
  return `${sha256.slice(0, prefix)}-${safe === "" ? "file" : safe}`;
}

export const attachmentFilePattern =
  /^attachments\/[0-9a-f]{12,64}-[A-Za-z0-9._-]+$/;
