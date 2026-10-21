import type { Server } from "bun";
import {
  admitAdapterRequest,
  type BuddyState,
  type Clarify,
  type ConversationMessage,
  checkClarifyAnswer,
  checkEmptyBody,
  checkEventsQuery,
  checkHistoryQuery,
  checkMessageRequest,
  errorBody,
  formatSseEvent,
  type Media,
  type RuntimeErrorCode,
  type RuntimeEventType,
  runtimeErrors,
} from "../../src/buddy/contract/runtime";

// A Hermes `lazurio_web` adapter for tests and the frame's local preview: the
// runtime contract (src/buddy/contract/README.md) over loopback, with a
// durable outbox in memory, replay by id and a stream closed after
// `streamMs`. With `script`, every message gets a short answer, streamed in
// pieces with one line of progress, and a message with a question mark gets
// a clarify question first.

export type FakeAdapterOptions = Readonly<{
  secret: string;
  streamMs?: number;
  script?: boolean;
  /** How long each scripted step waits. */
  stepMs?: number;
}>;

type Stored = Readonly<{ id: string; type: RuntimeEventType; data: unknown }>;

export async function startFakeAdapter(options: FakeAdapterOptions) {
  const outbox: Stored[] = [];
  const messages: ConversationMessage[] = [];
  const media = new Map<
    string,
    Readonly<{ mime: string; bytes: Uint8Array<ArrayBuffer> }>
  >();
  const clients = new Map<string, string>();
  const requests: {
    method: string;
    path: string;
    headers: Record<string, string>;
  }[] = [];
  const listeners = new Set<() => void>();
  let sequence = 0;
  let messageSequence = 0;
  let state: BuddyState = "idle";
  let clarify: Clarify | null = null;
  const step = options.stepMs ?? 150;
  const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

  function emit(type: RuntimeEventType, data: unknown): string {
    sequence++;
    const id = `e-${sequence}`;
    outbox.push({ id, type, data });
    if (type === "status") state = (data as { state: BuddyState }).state;
    if (type === "clarify.request") clarify = data as Clarify;
    if (type === "clarify.retired") clarify = null;
    for (const listener of listeners) listener();
    return id;
  }

  const at = () => new Date().toISOString();
  const nextMessageId = () => `m-${++messageSequence}`;

  async function answerScripted(text: string, replyTo: string) {
    emit("turn.started", { reply_to: replyTo });
    emit("status", { state: "working" });
    await sleep(step);
    emit("progress", { text: "Čtu, co se stalo…" });
    await sleep(step);
    const reply =
      text.trim() === ""
        ? "Mám to, **díky** za přílohu."
        : `Rozumím. Podívám se na to a ozvu se.\n\n- bod jedna\n- bod dva\n\nVíc na https://lazurio.io.`;
    const messageId = nextMessageId();
    const pieces = reply.match(/.{1,12}/gs) ?? [reply];
    for (const piece of pieces) {
      emit("message.delta", { message_id: messageId, text: piece });
      await sleep(step / 3);
    }
    const message: ConversationMessage = {
      message_id: messageId,
      role: "assistant",
      text: reply,
      at: at(),
      via: "lazurio_web",
      media: [],
    };
    messages.push(message);
    emit("message.final", { ...message, client_id: null });
    emit("status", { state: "idle" });
  }

  async function askScripted(replyTo: string) {
    emit("turn.started", { reply_to: replyTo });
    emit("status", { state: "working" });
    await sleep(step);
    emit("clarify.request", {
      clarify_id: `q-${sequence}`,
      question: "Mám změny publikovat hned?",
      choices: ["Ano", "Ne", "Až zítra"],
      multi: false,
    });
    emit("status", { state: "waiting" });
  }

  const json = (body: unknown, status: number) =>
    Response.json(body, { status });
  const refuse = (code: RuntimeErrorCode) =>
    json(errorBody(code), runtimeErrors[code]);

  async function body(request: Request): Promise<unknown> {
    try {
      return await request.json();
    } catch {
      return undefined;
    }
  }

  function stream(after: string | null): Response {
    const encoder = new TextEncoder();
    let index = 0;
    if (after !== null) {
      const found = outbox.findIndex((event) => event.id === after);
      if (found < 0 && after !== "0") return refuse("cursor-expired");
      index = found + 1;
    } else index = outbox.length;
    let close: () => void = () => undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        let open = true;
        const flush = () => {
          if (!open) return;
          while (index < outbox.length) {
            const event = outbox[index++] as Stored;
            controller.enqueue(
              encoder.encode(formatSseEvent(event.id, event.type, event.data)),
            );
          }
        };
        const ping = setInterval(() => {
          if (open) controller.enqueue(encoder.encode(": ping\n\n"));
        }, 15_000);
        close = () => {
          if (!open) return;
          open = false;
          clearInterval(ping);
          clearTimeout(timer);
          listeners.delete(flush);
          try {
            controller.close();
          } catch {
            // Already closed.
          }
        };
        const timer = setTimeout(close, options.streamMs ?? 110_000);
        listeners.add(flush);
        controller.enqueue(encoder.encode("retry: 500\n\n"));
        flush();
      },
      cancel() {
        close();
      },
    });
    return new Response(body, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
      },
    });
  }

  const server: Server<undefined> = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const headers: Record<string, string> = {};
      request.headers.forEach((value, name) => {
        headers[name.toLowerCase()] = value;
      });
      requests.push({ method: request.method, path: url.pathname, headers });
      const admission = admitAdapterRequest(
        { method: request.method, path: url.pathname, headers },
        { port: server.port ?? 0, secret: options.secret },
      );
      if (!admission.ok)
        return json(errorBody(admission.code), admission.status);
      const route = admission.route;
      switch (route.kind) {
        case "messages": {
          const checked = checkMessageRequest(await body(request));
          if (!checked.ok) return refuse("bad-request");
          const sent = checked.value;
          const known = clients.get(sent.client_id);
          if (known !== undefined) return json({ message_id: known }, 202);
          const messageId = nextMessageId();
          clients.set(sent.client_id, messageId);
          const files: Media[] = sent.attachments.map((attachment, index) => {
            const mediaId = `md-${messageId}-${index}`;
            const bytes = Uint8Array.from(
              Buffer.from(attachment.data_base64, "base64"),
            );
            media.set(mediaId, { mime: attachment.mime, bytes });
            return {
              media_id: mediaId,
              name: attachment.name,
              mime: attachment.mime,
              size: bytes.byteLength,
            };
          });
          const message: ConversationMessage = {
            message_id: messageId,
            role: "user",
            text: sent.text,
            at: at(),
            via: "lazurio_web",
            media: files,
          };
          messages.push(message);
          emit("message.final", { ...message, client_id: sent.client_id });
          if (options.script)
            void (sent.text.includes("?")
              ? askScripted(messageId)
              : answerScripted(sent.text, messageId));
          return json({ message_id: messageId }, 202);
        }
        case "history": {
          const query = checkHistoryQuery(url.search.slice(1));
          if (!query.ok) return refuse("bad-request");
          const end =
            query.value.before === null
              ? messages.length
              : Number(query.value.before.slice("c-".length));
          const start = Math.max(0, end - query.value.limit);
          return json(
            {
              messages: messages.slice(start, end),
              before: start > 0 ? `c-${start}` : null,
              snapshot:
                query.value.before === null
                  ? {
                      event_id: outbox.at(-1)?.id ?? "0",
                      state,
                      clarify,
                    }
                  : null,
            },
            200,
          );
        }
        case "events": {
          const query = checkEventsQuery(url.search.slice(1));
          if (!query.ok) return refuse("bad-request");
          return stream(query.value.after);
        }
        case "clarify": {
          const checked = checkClarifyAnswer(await body(request));
          if (!checked.ok) return refuse("bad-request");
          if (clarify?.clarify_id !== route.clarify_id)
            return refuse("not-found");
          emit("clarify.retired", { clarify_id: route.clarify_id });
          if (options.script) void answerScripted("odpověď", route.clarify_id);
          return json({}, 202);
        }
        case "stop": {
          if (!checkEmptyBody(await body(request)).ok)
            return refuse("bad-request");
          emit("status", { state: "idle" });
          return json({}, 202);
        }
        case "media": {
          const file = media.get(route.media_id);
          if (file === undefined) return refuse("not-found");
          return new Response(file.bytes, {
            headers: { "content-type": file.mime },
          });
        }
      }
    },
  });

  return {
    port: server.port ?? 0,
    requests,
    outbox,
    messages,
    emit,
    /** A message of the conversation without an event, as an older one. */
    remember(message: ConversationMessage) {
      messages.push(message);
    },
    /** Media the adapter holds, by id. */
    media,
    stop: () => server.stop(true),
  };
}
