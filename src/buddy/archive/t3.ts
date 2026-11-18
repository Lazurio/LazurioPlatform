import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { isoFromString } from "./format";
import {
  bump,
  type Columns,
  columnsOf,
  type Draft,
  mimeOf,
  normalizeSpace,
  type PendingAttachment,
  type Stats,
} from "./hermes";

// Buddy's T3 Code, `~/.t3-buddy/userdata/statev2.sqlite` (plan LZD-0033
// R6a): his web chat as the person saw it, with the files they attached in
// `userdata/attachments/`. Ported from the V4 export.

const PAGE_CHIP = /\s*\[([^\]]*)\]\((t3-context:\/\/[^)]*)\)\s*$/;

export function missingT3Columns(db: Database): string[] {
  const messages = columnsOf(db, "orchestration_v2_projection_messages");
  for (const name of [
    "message_id",
    "thread_id",
    "role",
    "created_at",
    "payload_json",
  ])
    if (!messages.has(name)) throw new Error(`t3-messages-${name}`);
  const threads = columnsOf(db, "orchestration_v2_projection_threads");
  if (!threads.has("thread_id")) throw new Error("t3-threads-thread_id");
  return threads.has("deleted_at")
    ? []
    : ["orchestration_v2_projection_threads.deleted_at"];
}

export function t3SchemaVersion(db: Database): number | null {
  try {
    const row = db
      .query("select max(migration_id) as version from effect_sql_migrations")
      .get() as { version: unknown } | null;
    return typeof row?.version === "number" ? row.version : null;
  } catch {
    return null;
  }
}

/** The condition of a message whose thread is not deleted. */
export const liveThread = (threads: Columns, message = "m") =>
  `exists (select 1 from orchestration_v2_projection_threads t where t.thread_id = ${message}.thread_id${
    threads.has("deleted_at") ? " and t.deleted_at is null" : ""
  })`;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Where T3 Code keeps an attachment: `<id><extension>` in its directory,
 * found among the names there that start with `<id>.`; the one with the
 * extension of its media type first. */
export function t3Attachment(
  directory: string,
  listing: readonly string[],
  attachment: unknown,
): PendingAttachment {
  const entry = isObject(attachment) ? attachment : {};
  const id = typeof entry.id === "string" ? entry.id : "";
  const name =
    typeof entry.name === "string" && entry.name !== "" ? entry.name : id;
  const mime =
    typeof entry.mimeType === "string" && entry.mimeType !== ""
      ? entry.mimeType
      : mimeOf(name);
  const size =
    typeof entry.sizeBytes === "number" ? { size: entry.sizeBytes } : {};
  if (!/^[A-Za-z0-9_-]+$/.test(id))
    return { name: name || "file", mime, ...size, reason: "invalid-id" };
  const hits = listing.filter((file) => file.startsWith(`${id}.`)).sort();
  const preferred = hits.find((file) => mimeOf(file) === mime) ?? hits[0];
  return preferred === undefined
    ? { name, mime, ...size, reason: "absent" }
    : { name, mime, ...size, path: join(directory, preferred) };
}

type MessageRow = {
  message_id: string;
  role: string;
  created_at: string;
  payload_json: string;
};

/** The web chat's messages: the person's own (never what T3 Code's
 * Delegace sent for Buddy, which the window hides), and Buddy's, as
 * commentary where Hermes recorded the same text as commentary. */
export function readT3(
  db: Database,
  attachments: Readonly<{ directory: string; listing: readonly string[] }>,
  chatCommentary: ReadonlySet<string>,
  stats: Stats,
): Draft[] {
  const threads = columnsOf(db, "orchestration_v2_projection_threads");
  const rows = db
    .query(
      `select m.message_id, m.role, m.created_at, m.payload_json from orchestration_v2_projection_messages m where ${liveThread(threads)} order by m.created_at, m.message_id`,
    )
    .all() as MessageRow[];
  const out: Draft[] = [];
  for (const row of rows) {
    bump(stats, "t3.rows_total");
    let payload: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(row.payload_json);
      if (!isObject(parsed)) throw new Error("payload");
      payload = parsed;
    } catch {
      bump(stats, "t3.warn.payload_unparsed");
      continue;
    }
    const text = typeof payload.text === "string" ? payload.text : "";
    const ts = isoFromString(
      typeof payload.createdAt === "string" && payload.createdAt !== ""
        ? payload.createdAt
        : row.created_at,
    );
    const source = { db: "t3", message_id: row.message_id };
    if (row.role === "user") {
      if (payload.createdBy !== "user") {
        // Sent for Buddy by T3 Code's Delegace, hidden in the window.
        bump(stats, "t3.skipped.delegace_notification");
        continue;
      }
      const chip = PAGE_CHIP.exec(text);
      const draft: Draft = {
        id: `t3:${row.message_id}`,
        ts,
        channel: "chat",
        tag: "t3",
        author: "user",
        kind: "message",
        text: (chip === null ? text : text.slice(0, chip.index)).trim(),
        attachments: (Array.isArray(payload.attachments)
          ? payload.attachments
          : []
        ).map((attachment) =>
          t3Attachment(attachments.directory, attachments.listing, attachment),
        ),
        ...(chip === null
          ? {}
          : {
              context: { page: (chip[1] ?? "").trim(), ref: chip[2] ?? "" },
            }),
        source,
      };
      out.push(draft);
      bump(stats, "t3.user.message");
    } else if (row.role === "assistant") {
      const kind = chatCommentary.has(normalizeSpace(text))
        ? "commentary"
        : "message";
      out.push({
        id: `t3:${row.message_id}`,
        ts,
        channel: "chat",
        tag: "t3",
        author: "assistant",
        kind,
        text: text.trim(),
        attachments: [],
        source,
      });
      bump(stats, `t3.buddy.${kind}`);
    } else bump(stats, `t3.skipped.${row.role}`);
  }
  return out;
}
