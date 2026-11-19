import type { Database } from "bun:sqlite";
import {
  chatSources,
  column,
  columnsOf,
  nonConversationSources,
} from "./hermes";
import { liveThread } from "./t3";

// The completeness check's own count of each group from the sources (plan
// LZD-0033 R6a), by another path than the export: SQL over the oldest row
// of each message_uid per channel, as the V4 verification counted, with the
// export's rules written once more as conditions. A difference between
// the two names a record the export lost or invented.

const quoted = (values: readonly string[]) =>
  values.map((value) => `'${value}'`).join(", ");
const blank = (expression: string) =>
  `trim(coalesce(${expression}, ''), char(32, 9, 10, 11, 12, 13))`;
const startsWith = (expression: string, prefix: string) =>
  `substr(coalesce(${expression}, ''), 1, ${prefix.length}) = '${prefix}'`;

/** Group counts from Hermes, keyed `<channel>/<author>/<kind>`. */
export function recountHermes(db: Database): Map<string, number> {
  const c = columnsOf(db, "messages");
  const uid = c.has("message_uid")
    ? "coalesce(x.message_uid, 'row-' || x.id)"
    : "'row-' || x.id";
  const base = `with sess as (
      select id, case when source in (${quoted(chatSources)}) then 'chat'
        when source in (${quoted(nonConversationSources)}) then null
        else source end as channel
      from sessions),
    m as (
      select x.id, x.role, x.content, s.channel, ${uid} as uidk,
        ${column(c, "tool_calls")}, ${column(c, "tool_name")},
        ${column(c, "codex_message_items", "cmi")},
        ${column(c, "display_kind")},
        ${column(c, "_compressed_summary", "summary")}
      from messages x join sess s on s.id = x.session_id
      where s.channel is not null),
    o as (select * from m where id in (select min(id) from m group by channel, uidk)),
    k as (select channel, uidk,
        max(coalesce(display_kind, '') = 'internal_notification') as internal,
        max(coalesce(display_kind, '') = 'failed_turn') as failed
      from m group by channel, uidk)`;
  const counts = new Map<string, number>();
  const add = (sql: string, author: string, kind: string) => {
    for (const row of db.query(sql).all() as { channel: string; n: number }[])
      if (row.n > 0) {
        const key = `${row.channel}/${author}/${kind}`;
        counts.set(key, (counts.get(key) ?? 0) + row.n);
      }
  };
  const content = (expression: string) =>
    `case when substr(coalesce(${expression}, ''), 1, 6) = char(0) || 'json:' then '' else coalesce(${expression}, '') end`;
  const items = (expression: string) =>
    `case when json_valid(${expression}) and json_type(${expression}) = 'array' then ${expression} else '[]' end`;
  const final = `exists (select 1 from json_each(${items("o.cmi")}) j where json_type(j.value) = 'object' and json_extract(j.value, '$.phase') = 'final_answer')`;
  const assistant = `o.role = 'assistant' and coalesce(o.summary, 0) = 0 and ${blank("o.content")} <> '' and ${blank("o.content")} <> 'NO_REPLY' and o.channel <> 'chat'`;
  const decided = `(${final} or coalesce(o.tool_calls, '') <> '')`;

  add(
    `${base} select o.channel, count(*) as n from o join k using (channel, uidk)
      where o.channel <> 'chat' and o.role = 'user'
        and not (${startsWith(content("o.content"), "[kanban]")}) and k.internal = 0
      group by o.channel`,
    "user",
    "message",
  );
  add(
    `${base} select o.channel, count(*) as n from o where ${assistant} and ${decided} group by o.channel`,
    "assistant",
    "message",
  );
  add(
    `${base} select o.channel, count(*) as n from o join k using (channel, uidk)
      where ${assistant} and not ${decided} and k.failed = 0
        and not (${startsWith("o.content", "Operation interrupted:")})
        and not (${startsWith("o.content", "Your request was not")})
      group by o.channel`,
    "system",
    "notice",
  );
  const itemText = `case json_type(it.value, '$.content')
      when 'text' then json_extract(it.value, '$.content')
      when 'array' then (select group_concat(json_extract(p.value, '$.text'), '')
        from json_each(it.value, '$.content') p
        where json_type(p.value) = 'object' and json_type(p.value, '$.text') = 'text')
      else '' end`;
  add(
    `${base} select o.channel, count(*) as n from o, json_each(${items("o.cmi")}) it
      where o.role = 'assistant' and coalesce(o.summary, 0) = 0 and o.channel <> 'chat'
        and json_type(it.value) = 'object' and json_extract(it.value, '$.phase') = 'commentary'
        and ${blank(itemText)} <> ''
      group by o.channel`,
    "assistant",
    "commentary",
  );
  const args = "a.args";
  add(
    `${base}, calls as (
        select o.channel, case when json_type(c.value, '$.function.arguments') = 'object'
            then json_extract(c.value, '$.function.arguments')
            else coalesce(nullif(json_extract(c.value, '$.function.arguments'), ''), '{}') end as args
        from o, json_each(case when json_valid(o.tool_calls) and json_type(o.tool_calls) = 'array' then o.tool_calls else '[]' end) c
        where o.role = 'assistant' and coalesce(o.summary, 0) = 0
          and json_type(c.value) = 'object' and json_extract(c.value, '$.function.name') = 'clarify')
      select a.channel, sum(case when not json_valid(${args}) or json_type(${args}) <> 'object' then 0
          when json_type(${args}, '$.questions') = 'array' and json_array_length(${args}, '$.questions') > 0
            then json_array_length(${args}, '$.questions')
          when json_type(${args}, '$.question') = 'text' and json_extract(${args}, '$.question') <> '' then 1
          else 0 end) as n
      from calls a group by a.channel`,
    "assistant",
    "question",
  );
  // Answers from the tool's results themselves, as the V4 verification
  // counted them: each response with an answer, or one where the result
  // was pruned to its text.
  add(
    `${base} select o.channel, sum(case
          when json_valid(o.content) then (case when json_type(o.content) = 'object'
              and json_type(o.content, '$.responses') = 'array'
            then (select count(*) from json_each(o.content, '$.responses') r
              where json_type(r.value) = 'object'
                and coalesce(json_type(r.value, '$.user_response'), 'null') <> 'null')
            else 0 end)
          when ${startsWith("o.content", '[clarify] user responded: "')} then 1
          else 0 end) as n
      from o where o.role = 'tool' and o.tool_name = 'clarify' group by o.channel`,
    "user",
    "answer",
  );
  // Rows the export could not parse, which may hide a question or
  // commentary: counted here without json_valid filtering them away.
  const unparsed = (what: string, sql: string) =>
    counts.set(
      `unparsed/hermes/${what}`,
      Number((db.query(sql).get() as { n: number | null }).n ?? 0),
    );
  const relevant = `o.role = 'assistant' and coalesce(o.summary, 0) = 0`;
  unparsed(
    "codex_message_items",
    `${base} select count(*) as n from o where ${relevant} and coalesce(o.cmi, '') <> '' and not json_valid(o.cmi)`,
  );
  unparsed(
    "tool_calls",
    `${base} select count(*) as n from o where ${relevant} and coalesce(o.tool_calls, '') <> '' and not json_valid(o.tool_calls)`,
  );
  unparsed(
    "clarify_arguments",
    `${base} select count(*) as n from o, json_each(case when json_valid(o.tool_calls) and json_type(o.tool_calls) = 'array' then o.tool_calls else '[]' end) c
      where ${relevant} and json_type(c.value) = 'object'
        and json_extract(c.value, '$.function.name') = 'clarify'
        and json_type(c.value, '$.function.arguments') = 'text'
        and json_extract(c.value, '$.function.arguments') <> ''
        and not json_valid(json_extract(c.value, '$.function.arguments'))`,
  );
  return counts;
}

/** Group counts of the web chat from T3 Code, and its attachments. */
export function recountT3(db: Database): Map<string, number> {
  const threads = columnsOf(db, "orchestration_v2_projection_threads");
  const from = `from orchestration_v2_projection_messages m where ${liveThread(threads)} and json_valid(m.payload_json) and json_type(m.payload_json) = 'object'`;
  const one = (sql: string) =>
    Number((db.query(sql).get() as { n: number | null }).n ?? 0);
  const user = `${from} and m.role = 'user' and json_extract(m.payload_json, '$.createdBy') = 'user'`;
  return new Map([
    [
      "unparsed/t3/payload_json",
      one(
        `select count(*) as n from orchestration_v2_projection_messages m where ${liveThread(threads)} and not (json_valid(m.payload_json) and json_type(m.payload_json) = 'object')`,
      ),
    ],
    ["chat/user/message", one(`select count(*) as n ${user}`)],
    [
      "chat/assistant/message+commentary",
      one(`select count(*) as n ${from} and m.role = 'assistant'`),
    ],
    [
      "chat/user/attachments",
      one(
        `select sum(case when json_type(m.payload_json, '$.attachments') = 'array' then json_array_length(m.payload_json, '$.attachments') else 0 end) as n ${user}`,
      ),
    ],
  ]);
}
