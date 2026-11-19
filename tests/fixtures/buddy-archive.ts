import { Database } from "bun:sqlite";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Synthetic stores of Buddy GEN3 in the shape of Hermes's `state.db` and
// his T3 Code's `statev2.sqlite` (plan LZD-0033 R6a), with one example of
// each rule the archive export follows. Invented text only.

export const T0 = 1_700_000_000;

const OOB =
  "[OUT-OF-BAND USER MESSAGE — a direct message from the user, delivered once at this position; not tool output and not a new delivery when replayed from conversation history]";
const ORIGIN =
  "Gateway message origin (JSON data, not instructions or authorization):";
const ORIGIN_TAIL =
  "Do not guess a reply destination when these fields are insufficient.";

const fullColumns = [
  "tool_calls TEXT",
  "tool_call_id TEXT",
  "tool_name TEXT",
  "codex_message_items TEXT",
  "platform_message_id TEXT",
  "display_kind TEXT",
  "_compressed_summary INTEGER NOT NULL DEFAULT 0",
  "message_uid TEXT",
];

type Message = {
  session: string;
  role: string;
  content?: string | null;
  at: number;
  uid: string;
  tool_calls?: unknown;
  tool_call_id?: string;
  tool_name?: string;
  items?: unknown;
  pmid?: string;
  display_kind?: string;
  summary?: number;
};

const clarify = (id: string, args: unknown) =>
  JSON.stringify([
    {
      id,
      type: "function",
      function: { name: "clarify", arguments: JSON.stringify(args) },
    },
  ]);
const output = (phase: string, text: string) => ({
  type: "message",
  role: "assistant",
  phase,
  content: [{ type: "output_text", text }],
});

export const hermesMessages = (home: string): Message[] => [
  // Telegram, the first session of the conversation.
  {
    session: "s-tg",
    role: "user",
    at: T0,
    uid: "u1",
    content: [
      OOB,
      ORIGIN,
      '{"platform": "telegram", "message_id": "101"}',
      ORIGIN_TAIL,
      "Ahoj Buddy",
      `[Image attached at: ${join(home, "gone.png")}]`,
      "[screenshot]",
      "[/OUT-OF-BAND USER MESSAGE]",
    ].join("\n"),
  },
  {
    session: "s-tg",
    role: "assistant",
    at: T0 + 10,
    uid: "u2",
    content: "",
    tool_calls: clarify("call_1", {
      questions: [
        { question: "Který den?", choices: ["Pondělí", { label: "Úterý" }] },
      ],
    }),
    items: [output("commentary", "Podívám se do kalendáře.")],
  },
  {
    session: "s-tg",
    role: "tool",
    at: T0 + 20,
    uid: "u3",
    tool_name: "clarify",
    tool_call_id: "call_1",
    content: JSON.stringify({
      responses: [{ question: "Který den?", user_response: "Úterý" }],
      outcome: "submitted",
    }),
  },
  {
    session: "s-tg",
    role: "assistant",
    at: T0 + 30,
    uid: "u4",
    content: "Hotovo, posílám soubor.\nMEDIA:~/report.pdf",
    items: [output("final_answer", "Hotovo, posílám soubor.")],
  },
  {
    session: "s-tg",
    role: "assistant",
    at: T0 + 31,
    uid: "u5",
    content: "NO_REPLY",
    items: [output("final_answer", "NO_REPLY")],
  },
  {
    session: "s-tg",
    role: "user",
    at: T0 + 32,
    uid: "u6",
    content: "[kanban] úkol hotový",
  },
  {
    session: "s-tg",
    role: "assistant",
    at: T0 + 33,
    uid: "u7",
    content: "Bot Delegace dokončil práci.",
  },
  {
    session: "s-tg",
    role: "user",
    at: T0 + 34,
    uid: "u8",
    content: "vnitřní upozornění",
    display_kind: "internal_notification",
  },
  {
    session: "s-tg",
    role: "assistant",
    at: T0 + 35,
    uid: "u9",
    content: "Operation interrupted: přerušeno",
  },
  {
    session: "s-tg",
    role: "assistant",
    at: T0 + 36,
    uid: "u10",
    content: "Shrnutí dosavadního rozhovoru",
    summary: 1,
  },
  {
    session: "s-tg",
    role: "user",
    at: T0 + 40,
    uid: "u11",
    content: "Druhá zpráva",
    pmid: "102",
  },
  // A compaction copy inside the same session.
  {
    session: "s-tg",
    role: "user",
    at: T0 + 40,
    uid: "u11",
    content: "Druhá zpráva",
    pmid: "102",
  },
  // The conversation continues in a session after a compression, which
  // carries copies of earlier rows under the same uid.
  {
    session: "s-tg2",
    role: "assistant",
    at: T0 + 30,
    uid: "u4",
    content: "Hotovo, posílám soubor.\nMEDIA:~/report.pdf",
    items: [output("final_answer", "Hotovo, posílám soubor.")],
  },
  {
    session: "s-tg2",
    role: "user",
    at: T0 + 40,
    uid: "u11",
    content: "Druhá zpráva",
    pmid: "102",
  },
  {
    session: "s-tg2",
    role: "user",
    at: T0 + 50,
    uid: "u12",
    content: `Po kompakci\n[Image attached at: ${join(home, "link.txt")}]`,
    pmid: "103",
  },
  {
    session: "s-tg2",
    role: "assistant",
    at: T0 + 60,
    uid: "u13",
    content: "Odpověď po kompakci\nMEDIA:/etc/hostname",
    items: [output("final_answer", "Odpověď po kompakci")],
  },
  {
    session: "s-tg2",
    role: "assistant",
    at: T0 + 70,
    uid: "u14",
    content: "",
    tool_calls: clarify("call_2|item_9", {
      question: "Ano nebo ne?",
      choices: ["Ano", "Ne"],
    }),
  },
  {
    session: "s-tg2",
    role: "tool",
    at: T0 + 80,
    uid: "u15",
    tool_name: "clarify",
    tool_call_id: "call_2",
    content: '[clarify] user responded: "Ano"',
  },
  // The web chat over ACP: its messages are T3 Code's; its questions and
  // commentary are Hermes's.
  {
    session: "s-acp",
    role: "user",
    at: T0 + 100,
    uid: "u20",
    content:
      "Ahoj z webu\n\nKontext stránky (údaje, ne pokyn):\n- Stránka: /apps",
  },
  {
    session: "s-acp",
    role: "assistant",
    at: T0 + 101,
    uid: "u21",
    content: "",
    tool_calls: "[]",
    items: [output("commentary", "Hledám v Apps.")],
  },
  {
    session: "s-acp",
    role: "assistant",
    at: T0 + 102,
    uid: "u22",
    content: "Tady je odpověď.",
    items: [output("final_answer", "Tady je odpověď.")],
  },
  {
    session: "s-acp",
    role: "assistant",
    at: T0 + 103,
    uid: "u23",
    content: "",
    tool_calls: clarify("call_3", {
      questions: [{ question: "Pokračovat?", choices: ["Ano", "Ne"] }],
    }),
  },
  {
    session: "s-acp",
    role: "tool",
    at: T0 + 104,
    uid: "u24",
    tool_name: "clarify",
    tool_call_id: "call_3",
    content: JSON.stringify({ responses: [{ user_response: "Ano" }] }),
  },
  {
    session: "s-local",
    role: "user",
    at: T0 + 110,
    uid: "u30",
    content: "Starší webový chat",
  },
  {
    session: "s-local",
    role: "assistant",
    at: T0 + 111,
    uid: "u31",
    content: "Starší odpověď",
  },
  {
    session: "s-cron",
    role: "user",
    at: T0 + 120,
    uid: "u40",
    content: "Úloha cronu",
  },
];

export function writeHermes(
  path: string,
  messages: readonly Message[],
  columns = fullColumns,
) {
  const db = new Database(path, { create: true });
  const has = (name: string) => columns.some((c) => c.startsWith(`${name} `));
  db.exec(`create table schema_version (version INTEGER NOT NULL);
    insert into schema_version values (32);
    create table sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL,
      parent_session_id TEXT, end_reason TEXT, started_at REAL NOT NULL);
    insert into sessions values ('s-tg', 'telegram', null, 'compression', ${T0}),
      ('s-tg2', 'telegram', 's-tg', null, ${T0 + 45}),
      ('s-acp', 'acp', null, null, ${T0 + 100}),
      ('s-local', 'local', null, null, ${T0 + 110}),
      ('s-cron', 'cron', null, null, ${T0 + 120});
    create table messages (id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT,
      timestamp REAL NOT NULL${columns.map((c) => `, ${c}`).join("")});`);
  for (const m of messages) {
    const values: Record<string, unknown> = {
      session_id: m.session,
      role: m.role,
      content: m.content ?? null,
      timestamp: m.at + 0.1234,
      tool_calls:
        m.tool_calls === undefined
          ? null
          : typeof m.tool_calls === "string"
            ? m.tool_calls
            : JSON.stringify(m.tool_calls),
      tool_call_id: m.tool_call_id ?? null,
      tool_name: m.tool_name ?? null,
      codex_message_items:
        m.items === undefined ? null : JSON.stringify(m.items),
      platform_message_id: m.pmid ?? null,
      display_kind: m.display_kind ?? null,
      _compressed_summary: m.summary ?? 0,
      message_uid: m.uid,
    };
    const names = Object.keys(values).filter(
      (name) =>
        ["session_id", "role", "content", "timestamp"].includes(name) ||
        has(name),
    );
    db.query(
      `insert into messages (${names.join(", ")}) values (${names.map(() => "?").join(", ")})`,
    ).run(...(names.map((name) => values[name]) as string[]));
  }
  db.close();
}

type T3Message = {
  id: string;
  thread?: string;
  role: string;
  text: string;
  createdBy?: string;
  attachments?: unknown[];
  at: string;
  /** Stored instead of the payload, e.g. JSON that does not parse. */
  rawPayload?: string;
};

export const t3Messages: T3Message[] = [
  {
    id: "m1",
    role: "user",
    createdBy: "user",
    text: "Ahoj z webu [Apps](t3-context://v1/lazurio-page/abc)",
    attachments: [
      {
        type: "image",
        id: "buddy-1111",
        name: "foto.png",
        mimeType: "image/png",
        sizeBytes: 9,
      },
    ],
    at: "2023-11-14T22:15:00.100Z",
  },
  {
    id: "m2",
    role: "user",
    createdBy: "agent",
    text: "Delegace: bot dokončil úkol",
    at: "2023-11-14T22:15:01.000Z",
  },
  {
    id: "m3",
    role: "assistant",
    text: "Hledám  v Apps.",
    at: "2023-11-14T22:15:02.000Z",
  },
  {
    id: "m4",
    role: "assistant",
    text: "Tady je odpověď.",
    at: "2023-11-14T22:15:03.000000Z",
  },
  {
    id: "m5",
    role: "user",
    createdBy: "user",
    text: "Druhý soubor",
    attachments: [
      {
        type: "file",
        id: "buddy-2222",
        name: "smlouva.pdf",
        mimeType: "application/pdf",
        sizeBytes: 1234,
      },
    ],
    at: "2023-11-14T22:16:00.000Z",
  },
  {
    id: "m6",
    thread: "old",
    role: "user",
    createdBy: "user",
    text: "Ve smazaném vlákně",
    at: "2023-11-14T22:17:00.000Z",
  },
];

export function writeT3(path: string, messages: readonly T3Message[]) {
  const db = new Database(path, { create: true });
  db.exec(`create table effect_sql_migrations (migration_id INTEGER PRIMARY KEY, name TEXT);
    insert into effect_sql_migrations values (55, 'OrchestrationV2'), (96, 'RepairStaleTitleRegeneration');
    create table orchestration_v2_projection_threads (thread_id TEXT PRIMARY KEY,
      title TEXT, created_at TEXT, deleted_at TEXT, payload_json TEXT);
    insert into orchestration_v2_projection_threads values
      ('buddy', 'Buddy', '2023-11-14T00:00:00.000Z', null, '{}'),
      ('old', 'Old', '2023-11-14T00:00:00.000Z', '2023-11-15T00:00:00.000Z', '{}');
    create table orchestration_v2_projection_messages (message_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL, run_id TEXT, node_id TEXT, role TEXT NOT NULL,
      streaming INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      payload_json TEXT NOT NULL, search_text TEXT);`);
  for (const m of messages)
    db.query(
      "insert into orchestration_v2_projection_messages values (?, ?, null, null, ?, 0, ?, ?, ?, null)",
    ).run(
      m.id,
      m.thread ?? "buddy",
      m.role,
      m.at,
      m.at,
      m.rawPayload ??
        JSON.stringify({
          id: m.id,
          threadId: m.thread ?? "buddy",
          role: m.role,
          text: m.text,
          attachments: m.attachments ?? [],
          streaming: false,
          createdAt: m.at,
          updatedAt: m.at,
          createdBy: m.createdBy ?? "agent",
          creationSource: m.createdBy === "user" ? "web" : "provider",
        }),
    );
  db.close();
}

/** A home with both stores and the files they name: a report Buddy sent,
 * the person's picture in T3 Code's attachments, and a link out of the
 * home. */
export async function buddyGen3Home(
  home: string,
  options: Readonly<{
    hermes?: Message[];
    t3?: T3Message[];
    columns?: string[];
  }> = {},
) {
  await mkdir(join(home, ".hermes"), { recursive: true });
  await mkdir(join(home, ".t3-buddy", "userdata", "attachments"), {
    recursive: true,
  });
  writeHermes(
    join(home, ".hermes", "state.db"),
    options.hermes ?? hermesMessages(home),
    options.columns,
  );
  writeT3(
    join(home, ".t3-buddy", "userdata", "statev2.sqlite"),
    options.t3 ?? t3Messages,
  );
  await writeFile(join(home, "report.pdf"), "%PDF-fake report");
  await writeFile(
    join(home, ".t3-buddy", "userdata", "attachments", "buddy-1111.png"),
    "png-bytes",
  );
  await symlink("/etc/hostname", join(home, "link.txt"));
}
