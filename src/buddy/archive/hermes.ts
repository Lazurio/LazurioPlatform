import type { Database } from "bun:sqlite";
import { basename } from "node:path";
import type { Author, Kind } from "./format";
import { isoFromEpoch } from "./format";

// Hermes's `~/.hermes/state.db` (plan LZD-0033 R6a), ported rule for rule
// from the V4 export that was checked against a real conversation: the
// person's Telegram (and other platform) conversation, and the clarify
// questions and answers and Buddy's commentary of his web chat, whose
// messages themselves come from T3 Code.

/** An attachment as the source names it, before the export copies it. */
export type PendingAttachment = Readonly<{
  name: string;
  mime: string;
  /** An absolute path where the file should be; absent with `reason`. */
  path?: string;
  size?: number;
  reason?: string;
}>;

/** A record before its attachments are copied and its conversation set. */
export type Draft = {
  id: string;
  ts: string;
  channel: string;
  author: Author;
  kind: Kind;
  text: string;
  attachments: PendingAttachment[];
  options?: string[];
  context?: { page: string; ref: string };
  source: Record<string, string | number>;
  /** Where `source_accounting` counts it: `hermes.<source>` or `t3`. */
  tag: string;
};

export type Stats = Map<string, number>;
export const bump = (stats: Stats, key: string, by = 1) =>
  stats.set(key, (stats.get(key) ?? 0) + by);

/** Hermes sources of Buddy's web chat: `local` where his chat ran through
 * Hermes's own API, `acp` where T3 Code reaches him over ACP. */
export const chatSources: readonly string[] = ["local", "acp"];
/** Hermes sources that are no conversation with the person. */
export const nonConversationSources: readonly string[] = [
  "oneshot",
  "cron",
  "subagent",
  "cli",
];
/** The archive's channel of a Hermes session's source, or none. */
export const channelOf = (source: string): string | undefined =>
  chatSources.includes(source)
    ? "chat"
    : nonConversationSources.includes(source)
      ? undefined
      : source;

export const messageColumns = {
  required: ["id", "session_id", "role", "content", "timestamp"],
  optional: [
    "tool_calls",
    "tool_call_id",
    "tool_name",
    "codex_message_items",
    "platform_message_id",
    "display_kind",
    "_compressed_summary",
    "message_uid",
  ],
} as const;

export type Columns = ReadonlySet<string>;

export function columnsOf(db: Database, table: string): Columns {
  return new Set(
    db
      .query(`pragma table_info(${table})`)
      .all()
      .map((row) => String((row as { name: unknown }).name)),
  );
}

/** A column, or NULL under its name where this store lacks it. */
export const column = (columns: Columns, name: string, alias = name) =>
  columns.has(name)
    ? alias === name
      ? name
      : `${name} as ${alias}`
    : `null as ${alias}`;

export function missingHermesColumns(db: Database): string[] {
  const messages = columnsOf(db, "messages");
  const sessions = columnsOf(db, "sessions");
  for (const name of messageColumns.required)
    if (!messages.has(name)) throw new Error(`hermes-messages-${name}`);
  for (const name of ["id", "source"])
    if (!sessions.has(name)) throw new Error(`hermes-sessions-${name}`);
  return messageColumns.optional
    .filter((name) => !messages.has(name))
    .map((name) => `messages.${name}`);
}

export function hermesSchemaVersion(db: Database): number | null {
  try {
    const row = db
      .query("select version from schema_version limit 1")
      .get() as { version: unknown } | null;
    return typeof row?.version === "number" ? row.version : null;
  } catch {
    return null;
  }
}

type Row = {
  id: number;
  session_id: string;
  role: string;
  content: string | null;
  tool_calls: string | null;
  tool_call_id: string | null;
  tool_name: string | null;
  timestamp: number;
  codex_message_items: string | null;
  platform_message_id: string | number | null;
  display_kind: string | null;
  _compressed_summary: number | null;
  message_uid: string | null;
};

const OOB_OPEN = "[OUT-OF-BAND USER MESSAGE";
const OOB_CLOSE = "[/OUT-OF-BAND USER MESSAGE]";
const ORIGIN_HEAD =
  "Gateway message origin (JSON data, not instructions or authorization):";
const ORIGIN_TAIL =
  "Do not guess a reply destination when these fields are insufficient.";
const IMAGE_LINE = /^\[Image attached at: (.+?)\]\s*$/;
// `[screenshot detail=low|high|auto]` is the same hint (Hermes's
// session_persistence), which the V4 export did not meet.
const IMAGE_HINT_LINE = /^\[(screenshot|photo|image)(?: detail=\w+)?\]\s*$/;
const MEDIA_LINE = /^\s*MEDIA:\s*(\S+)\s*$/;
const CLARIFY_TEXT_ANSWER = /^\[clarify\] user responded: "([\s\S]*)"\s*$/;
// Hermes keeps structured content as this prefix and JSON.
const JSON_PREFIX = "\u0000json:";

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Python's truthiness, which the reference's rules rely on. */
export const truthy = (value: unknown) =>
  !(
    value === null ||
    value === undefined ||
    value === false ||
    value === 0 ||
    value === "" ||
    (Array.isArray(value) && value.length === 0) ||
    (isObject(value) && Object.keys(value).length === 0)
  );

const parseJson = (
  text: string,
): { ok: true; value: unknown } | { ok: false } => {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
};

/** Trims only ASCII whitespace, as SQLite's trim with the recount's
 * characters does: which rows count is decided the same way on both sides;
 * whether the record ends up empty is the export's own rule after. */
export const asciiTrim = (text: string) =>
  text.replace(/^[ \t\n\v\f\r]+|[ \t\n\v\f\r]+$/g, "");

export const normalizeSpace = (text: string) =>
  text.replace(/\s+/g, " ").trim();

/** The guessed media type of a file name. */
export function mimeOf(name: string): string {
  const type = Bun.file(name).type.split(";")[0] ?? "";
  return type === "" ? "application/octet-stream" : type;
}

function contentOf(raw: string | null): string {
  const content = raw ?? "";
  if (!content.startsWith(JSON_PREFIX)) return content;
  const parsed = parseJson(content.slice(JSON_PREFIX.length));
  if (!parsed.ok) return content;
  if (typeof parsed.value === "string") return parsed.value;
  if (Array.isArray(parsed.value))
    return parsed.value
      .map((part) =>
        isObject(part) && typeof part.text === "string" ? part.text : "",
      )
      .join("");
  return content;
}

export type Locate = (raw: string) => PendingAttachment;

function unwrapUser(content: string, locate: Locate) {
  let origin: Record<string, unknown> | undefined;
  let body = content;
  if (body.startsWith(OOB_OPEN)) {
    let lines = body.split("\n").slice(1);
    if (lines.length > 0 && lines[lines.length - 1]?.trim() === OOB_CLOSE)
      lines = lines.slice(0, -1);
    body = lines.join("\n");
  }
  if (body.startsWith(ORIGIN_HEAD)) {
    const lines = body.split("\n");
    const parsed = parseJson(lines[1] ?? "");
    origin = parsed.ok && isObject(parsed.value) ? parsed.value : undefined;
    let rest = lines.slice(2);
    if (rest.length > 0 && rest[0]?.trim() === ORIGIN_TAIL)
      rest = rest.slice(1);
    body = rest.join("\n");
  }
  const attachments: PendingAttachment[] = [];
  const kept: string[] = [];
  for (const line of body.split("\n")) {
    const image = IMAGE_LINE.exec(line);
    if (image !== null) attachments.push(locate((image[1] ?? "").trim()));
    else if (!IMAGE_HINT_LINE.test(line)) kept.push(line);
  }
  return { text: kept.join("\n").trim(), origin, attachments };
}

function splitMedia(content: string, locate: Locate, home: string) {
  const attachments: PendingAttachment[] = [];
  const kept: string[] = [];
  for (const line of content.split("\n")) {
    const media = MEDIA_LINE.exec(line);
    if (media === null) kept.push(line);
    else {
      const path = media[1] ?? "";
      attachments.push(
        locate(
          path === "~" || path.startsWith("~/") ? home + path.slice(1) : path,
        ),
      );
    }
  }
  return { text: kept.join("\n").trim(), attachments };
}

function itemText(item: Record<string, unknown>): string {
  const content = item.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .map((part) =>
        isObject(part) && typeof part.text === "string" ? part.text : "",
      )
      .join("");
  return "";
}

/** The answer of a clarify response as text. */
function answerText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.every((item) => typeof item === "string"))
    return value.join(", ");
  return JSON.stringify(value);
}

/** The ids a tool result may carry for a call: `id`, `call_id`, and of a
 * bridged `call_id|response_item_id` the part before `|`. */
function callIds(call: Record<string, unknown>): string[] {
  const ids: string[] = [];
  for (const value of [call.id, call.call_id])
    if (typeof value === "string" && value !== "") {
      ids.push(value);
      const head = value.split("|")[0];
      if (head !== undefined && head !== value) ids.push(head);
    }
  return ids;
}

export type HermesRead = Readonly<{
  platform: Draft[];
  chatQa: Draft[];
  chatCommentary: ReadonlySet<string>;
  /** Rows of the web chat (`local`, `acp`), the person's and Buddy's text,
   * left to T3 Code: without its store they would be lost. */
  covered: number;
}>;

/** The rows of `state.db` as the person saw them. Compaction copies share a
 * `message_uid`: the oldest row counts, keyed by the archive's channel and
 * the uid, so a copy carried into a session that continues the
 * conversation after a compression counts once too. */
export function readHermes(
  db: Database,
  home: string,
  locate: Locate,
  stats: Stats,
): HermesRead {
  const messages = columnsOf(db, "messages");
  const sessions = new Map<string, string>();
  for (const row of db.query("select id, source from sessions").all() as {
    id: unknown;
    source: unknown;
  }[])
    sessions.set(String(row.id), String(row.source));
  const select = [
    ...messageColumns.required,
    ...messageColumns.optional.map((name) => column(messages, name)),
  ].join(", ");
  const rows = db
    .query(`select ${select} from messages order by id`)
    .all() as Row[];

  const keyOf = (row: Row) => {
    const source = sessions.get(row.session_id);
    const scope =
      source === undefined
        ? `missing:${row.session_id}`
        : (channelOf(source) ?? `skipped:${row.session_id}`);
    return `${scope}\u0000${row.message_uid ?? `row-${row.id}`}`;
  };
  const unique = new Map<string, Row>();
  const displayKinds = new Map<string, Set<string | null>>();
  for (const row of rows) {
    const key = keyOf(row);
    const kinds = displayKinds.get(key) ?? new Set();
    kinds.add(row.display_kind);
    displayKinds.set(key, kinds);
    if (unique.has(key)) bump(stats, "hermes.skipped.compaction_copy");
    else unique.set(key, row);
  }
  stats.set("hermes.rows_total", rows.length);
  stats.set("hermes.rows_unique", unique.size);

  // Answers of clarify, by the session and, for a conversation continued
  // in another session, by the channel.
  const results = new Map<string, Row>();
  for (const row of unique.values())
    if (
      row.role === "tool" &&
      row.tool_name === "clarify" &&
      row.tool_call_id !== null
    ) {
      const channel = channelOf(sessions.get(row.session_id) ?? "") ?? "";
      results.set(`s\u0000${row.session_id}\u0000${row.tool_call_id}`, row);
      results.set(`c\u0000${channel}\u0000${row.tool_call_id}`, row);
    }
  const resultOf = (row: Row, channel: string, ids: readonly string[]) => {
    for (const id of ids) {
      const found = results.get(`s\u0000${row.session_id}\u0000${id}`);
      if (found !== undefined) return found;
    }
    for (const id of ids) {
      const found = results.get(`c\u0000${channel}\u0000${id}`);
      if (found !== undefined) return found;
    }
    return undefined;
  };

  const platform: Draft[] = [];
  const chatQa: Draft[] = [];
  const chatCommentary = new Set<string>();
  let covered = 0;
  for (const [key, row] of unique) {
    const source = sessions.get(row.session_id);
    if (source === undefined) {
      bump(stats, "hermes.skipped.session_missing");
      continue;
    }
    const tag = `hermes.${source}`;
    const channel = channelOf(source);
    if (channel === undefined) {
      bump(stats, `${tag}.skipped.session_not_conversation`);
      continue;
    }
    const isChat = channel === "chat";
    const role = row.role;
    const content = contentOf(row.content);
    const ts = isoFromEpoch(row.timestamp);
    const uid = row.message_uid ?? `row-${row.id}`;
    const ref = { db: "hermes", row: row.id };
    const kinds = displayKinds.get(key) ?? new Set();

    if (role === "user") {
      if (isChat) {
        bump(stats, `${tag}.user.covered_by_t3`);
        covered += 1;
        continue;
      }
      if (
        content.startsWith("[kanban]") ||
        kinds.has("internal_notification")
      ) {
        bump(stats, `${tag}.skipped.internal_notification`);
        continue;
      }
      const { text, origin, attachments } = unwrapUser(content, locate);
      const fromOrigin = origin?.message_id;
      const messageId = truthy(fromOrigin)
        ? fromOrigin
        : row.platform_message_id;
      platform.push({
        id: `hermes:${uid}`,
        ts,
        channel,
        tag,
        author: "user",
        kind: "message",
        text,
        attachments,
        source: truthy(messageId)
          ? { ...ref, platform_message_id: String(messageId) }
          : ref,
      });
      bump(stats, `${tag}.user.message`);
      continue;
    }
    if (role === "tool") {
      // Answers of clarify are taken below, through the call.
      bump(stats, `${tag}.skipped.tool_result`);
      continue;
    }
    if (role !== "assistant") {
      bump(stats, `${tag}.skipped.${role}`);
      continue;
    }
    if (truthy(row._compressed_summary)) {
      bump(stats, `${tag}.skipped.compaction_summary`);
      continue;
    }

    let items: unknown[] = [];
    if (truthy(row.codex_message_items)) {
      const parsed = parseJson(row.codex_message_items ?? "");
      if (!parsed.ok) bump(stats, `${tag}.unparsed.codex_message_items`);
      else if (Array.isArray(parsed.value)) items = parsed.value;
    }

    // Commentary Buddy wrote while he worked, in the row of a tool call.
    items
      .filter(
        (item): item is Record<string, unknown> =>
          isObject(item) && item.phase === "commentary",
      )
      .forEach((item, index) => {
        const whole = itemText(item);
        if (asciiTrim(whole) === "") return;
        const raw = whole.trim();
        if (isChat) {
          if (raw !== "") chatCommentary.add(normalizeSpace(raw));
          bump(stats, `${tag}.commentary.covered_by_t3`);
          return;
        }
        // Commentary may send a file by a MEDIA: line too.
        const { text, attachments } = splitMedia(raw, locate, home);
        platform.push({
          id: `hermes:${uid}#c${index}`,
          ts,
          channel,
          tag,
          author: "assistant",
          kind: "commentary",
          text,
          attachments,
          source: ref,
        });
        bump(stats, `${tag}.buddy.commentary`);
      });

    // Questions asked by the clarify tool, and the person's answers.
    if (truthy(row.tool_calls)) {
      const parsed = parseJson(row.tool_calls ?? "");
      if (!parsed.ok) bump(stats, `${tag}.unparsed.tool_calls`);
      const calls =
        parsed.ok && Array.isArray(parsed.value) ? parsed.value : [];
      let asked = 0;
      for (const call of calls) {
        if (!isObject(call)) continue;
        const fn = isObject(call.function) ? call.function : {};
        if (fn.name !== "clarify") continue;
        let args: unknown;
        if (isObject(fn.arguments)) args = fn.arguments;
        else {
          const parsedArgs = parseJson(
            typeof fn.arguments === "string" && fn.arguments !== ""
              ? fn.arguments
              : "{}",
          );
          if (!parsedArgs.ok) {
            bump(stats, `${tag}.unparsed.clarify_arguments`);
            continue;
          }
          args = parsedArgs.value;
        }
        const result = resultOf(row, channel, callIds(call));
        let responses: unknown[] = [];
        let textAnswer: string | undefined;
        let resultTs: string | undefined;
        if (result !== undefined) {
          resultTs = isoFromEpoch(result.timestamp);
          const resultContent = contentOf(result.content);
          const parsedResult = parseJson(resultContent);
          if (parsedResult.ok) {
            const value = parsedResult.value;
            responses =
              isObject(value) && Array.isArray(value.responses)
                ? value.responses
                : [];
          } else {
            const match = CLARIFY_TEXT_ANSWER.exec(resultContent);
            if (match !== null) {
              textAnswer = match[1] ?? "";
              bump(stats, `${tag}.warn.clarify_answer_from_pruned_result`);
            } else
              bump(stats, `${tag}.warn.clarify_result_pruned_without_answer`);
          }
        }
        let questions: unknown = isObject(args) ? args.questions : undefined;
        if (!truthy(questions) && isObject(args) && truthy(args.question))
          questions = [{ question: args.question, choices: args.choices }];
        const list = Array.isArray(questions) ? questions : [];
        const out = isChat ? chatQa : platform;
        list.forEach((entry, index) => {
          const question = isObject(entry) ? entry : {};
          const choices = Array.isArray(question.choices)
            ? question.choices.map((choice) =>
                typeof choice === "string"
                  ? choice
                  : isObject(choice) && truthy(choice.label)
                    ? String(choice.label)
                    : "",
              )
            : [];
          out.push({
            id: `hermes:${uid}#q${asked}`,
            ts,
            channel,
            tag,
            author: "assistant",
            kind: "question",
            text: truthy(question.question)
              ? String(question.question).trim()
              : "",
            attachments: [],
            ...(choices.length > 0 ? { options: choices } : {}),
            source: ref,
          });
          bump(stats, `${tag}.buddy.question`);
          const response = responses[index];
          const answer =
            isObject(response) &&
            response.user_response !== null &&
            response.user_response !== undefined
              ? answerText(response.user_response)
              : textAnswer !== undefined && index === 0
                ? textAnswer
                : undefined;
          if (answer !== undefined && result !== undefined) {
            out.push({
              id: `hermes:${uid}#a${asked}`,
              ts: resultTs ?? ts,
              channel,
              tag,
              author: "user",
              kind: "answer",
              text: answer.trim(),
              attachments: [],
              source: { db: "hermes", row: result.id },
            });
            bump(stats, `${tag}.user.answer`);
          } else bump(stats, `${tag}.question_without_answer`);
          asked += 1;
        });
      }
    }

    if (asciiTrim(content) === "") {
      bump(stats, `${tag}.skipped.tool_call_row`);
      continue;
    }
    if (isChat) {
      bump(stats, `${tag}.assistant_text.covered_by_t3`);
      covered += 1;
      continue;
    }
    if (content.trim() === "NO_REPLY") {
      bump(stats, `${tag}.skipped.no_reply`);
      continue;
    }
    const hasFinal = items.some(
      (item) => isObject(item) && item.phase === "final_answer",
    );
    const { text, attachments } = splitMedia(content, locate, home);
    let kind: Kind;
    if (hasFinal || truthy(row.tool_calls)) kind = "message";
    else if (
      kinds.has("failed_turn") ||
      content.startsWith("Operation interrupted:") ||
      content.startsWith("Your request was not")
    ) {
      bump(stats, `${tag}.skipped.turn_stub`);
      continue;
    } else kind = "notice"; // put into the conversation outside the model
    platform.push({
      id: `hermes:${uid}`,
      ts,
      channel,
      tag,
      author: kind === "notice" ? "system" : "assistant",
      kind,
      text,
      attachments,
      source: ref,
    });
    bump(stats, `${tag}.buddy.${kind}`);
  }
  return { platform, chatQa, chatCommentary, covered };
}

/** A path named by Hermes, as an attachment to copy. */
export const hermesAttachment = (path: string): PendingAttachment => ({
  name: basename(path),
  mime: mimeOf(path),
  path,
});
