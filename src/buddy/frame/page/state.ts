import {
  type BuddyState,
  type Clarify,
  type ConversationMessage,
  checkRuntimeEvent,
  type HistoryPage,
  isRuntimeId,
  type RuntimeEvent,
  runtimeLimits,
  type SseEvent,
} from "../../contract/runtime";
import { type CopyKey, channelName, copyOf } from "./copy";
import type { HostContext, Lang } from "./host";

// The chat's state and every change to it, pure, so the page only renders
// it and runs the effects (`app.ts`). One conversation (CONTRACT section 5:
// the session `lazurio_web:dm:owner`), loaded from its newest page and kept
// current by the events after the page's snapshot.

export type Phase =
  | "loading"
  | "ready"
  | "signed-out"
  | "signing-in"
  | "offline";

/** A file the person picked for the next message; its bytes stay with the
 * page (`app.ts`), here only what the chip shows. */
export type DraftAttachment = Readonly<{
  id: string;
  name: string;
  mime: string;
  size: number;
  /** A `blob:` address of an image, to show it; null for other files. */
  preview: string | null;
}>;

/** A message the person sent that the conversation does not list yet. */
export type Pending = Readonly<{
  client_id: string;
  text: string;
  attachments: readonly DraftAttachment[];
  status: "sending" | "sent" | "failed";
  message_id: string | null;
  at: string;
}>;

export type Notice =
  | "emptyFile"
  | "tooLarge"
  | "tooMuch"
  | "tooMany"
  | "sendFailed"
  | "turnFailed"
  | "turnUnavailable";

export type FrameState = Readonly<{
  phase: Phase;
  name: string;
  messages: readonly ConversationMessage[];
  /** The cursor of the next older page; null at the conversation's start. */
  before: string | null;
  loaded: boolean;
  olderLoading: boolean;
  /** The last event read: where the stream goes on. */
  eventId: string | null;
  buddy: BuddyState;
  streaming: Readonly<{ message_id: string; text: string }> | null;
  progress: string | null;
  clarify: Clarify | null;
  pending: readonly Pending[];
  host: HostContext | null;
  withContext: boolean;
  attachments: readonly DraftAttachment[];
  notice: Notice | null;
}>;

export const initialState: FrameState = Object.freeze({
  phase: "loading",
  name: "Buddy",
  messages: [],
  before: null,
  loaded: false,
  olderLoading: false,
  eventId: null,
  buddy: "idle",
  streaming: null,
  progress: null,
  clarify: null,
  pending: [],
  host: null,
  withContext: true,
  attachments: [],
  notice: null,
});

export type FrameAction =
  | Readonly<{ type: "persona"; name: string }>
  | Readonly<{ type: "history"; page: HistoryPage }>
  | Readonly<{ type: "older-loading" }>
  | Readonly<{ type: "older"; page: HistoryPage }>
  | Readonly<{ type: "event"; id: string; event: RuntimeEvent }>
  | Readonly<{ type: "signed-out" }>
  | Readonly<{ type: "signing-in" }>
  | Readonly<{ type: "offline" }>
  | Readonly<{ type: "online" }>
  | Readonly<{ type: "context"; host: HostContext }>
  | Readonly<{ type: "context-toggle"; on: boolean }>
  | Readonly<{ type: "attach"; attachment: DraftAttachment }>
  | Readonly<{ type: "detach"; id: string }>
  | Readonly<{ type: "send"; pending: Pending }>
  | Readonly<{ type: "sent"; client_id: string; message_id: string }>
  | Readonly<{ type: "send-failed"; client_id: string }>
  | Readonly<{ type: "retry"; client_id: string }>
  | Readonly<{ type: "clarify-done"; clarify_id: string }>
  | Readonly<{ type: "notice"; notice: Notice | null }>;

const time = (at: string) => Date.parse(at);

/** Messages by id, oldest first; a message seen again replaces its copy. */
export function mergeMessages(
  current: readonly ConversationMessage[],
  incoming: readonly ConversationMessage[],
): ConversationMessage[] {
  const byId = new Map<string, ConversationMessage>();
  for (const message of current) byId.set(message.message_id, message);
  for (const message of incoming) byId.set(message.message_id, message);
  return [...byId.values()]
    .map((message, index) => ({ message, index }))
    .sort(
      (a, b) => time(a.message.at) - time(b.message.at) || a.index - b.index,
    )
    .map(({ message }) => message);
}

/** Pending messages the conversation now lists drop out. */
function settle(
  pending: readonly Pending[],
  messages: readonly ConversationMessage[],
): readonly Pending[] {
  const listed = new Set(messages.map((message) => message.message_id));
  return pending.filter(
    (item) => item.message_id === null || !listed.has(item.message_id),
  );
}

function onEvent(state: FrameState, event: RuntimeEvent): FrameState {
  switch (event.type) {
    case "turn.started":
      return {
        ...state,
        buddy: "working",
        progress: null,
        notice:
          state.notice === "turnFailed" || state.notice === "turnUnavailable"
            ? null
            : state.notice,
      };
    case "message.delta": {
      const same = state.streaming?.message_id === event.data.message_id;
      return {
        ...state,
        buddy: "working",
        streaming: {
          message_id: event.data.message_id,
          text: (same ? (state.streaming?.text ?? "") : "") + event.data.text,
        },
      };
    }
    case "message.final": {
      const { client_id, ...message } = event.data;
      const messages = mergeMessages(state.messages, [message]);
      const pending = state.pending.filter(
        (item) =>
          item.client_id !== client_id &&
          item.message_id !== message.message_id,
      );
      const finished =
        message.role === "assistant" &&
        state.streaming?.message_id === message.message_id;
      return {
        ...state,
        messages,
        pending,
        streaming: finished ? null : state.streaming,
        progress: message.role === "assistant" ? null : state.progress,
      };
    }
    case "progress":
      return { ...state, progress: event.data.text };
    case "status":
      return event.data.state === "idle"
        ? { ...state, buddy: "idle", progress: null, streaming: null }
        : { ...state, buddy: event.data.state };
    case "clarify.request":
      return { ...state, clarify: event.data, buddy: "waiting" };
    case "clarify.retired":
      return state.clarify?.clarify_id === event.data.clarify_id
        ? { ...state, clarify: null }
        : state;
    case "error":
      // The turn ended: Buddy no longer writes, whether or not a status
      // follows.
      return {
        ...state,
        buddy: state.clarify === null ? "idle" : "waiting",
        streaming: null,
        progress: null,
        notice:
          event.data.code === "unavailable" ? "turnUnavailable" : "turnFailed",
      };
  }
}

/** What one event read from the stream does: an event of the contract
 * whose id the contract allows becomes an action and its id the cursor the
 * stream goes on from; anything else is dropped whole, cursor and all, so a
 * defective event can never make the next reconnect ask for a cursor the
 * contract refuses. */
export function eventAction(event: SseEvent): FrameAction | null {
  if (event.id === null || !isRuntimeId(event.id)) return null;
  let data: unknown;
  try {
    data = JSON.parse(event.data);
  } catch {
    return null;
  }
  const checked = checkRuntimeEvent(event.event, data);
  return checked.ok
    ? { type: "event", id: event.id, event: checked.value }
    : null;
}

export function reduce(state: FrameState, action: FrameAction): FrameState {
  switch (action.type) {
    case "persona":
      return { ...state, name: action.name };
    case "history": {
      const messages = mergeMessages(state.messages, action.page.messages);
      const snapshot = action.page.snapshot;
      return {
        ...state,
        phase: "ready",
        loaded: true,
        messages,
        pending: settle(state.pending, messages),
        before: state.loaded ? state.before : action.page.before,
        ...(snapshot === null
          ? {}
          : {
              eventId: snapshot.event_id,
              buddy: snapshot.state,
              clarify: snapshot.clarify,
              ...(snapshot.state === "idle"
                ? { streaming: null, progress: null }
                : {}),
            }),
      };
    }
    case "older-loading":
      return { ...state, olderLoading: true };
    case "older":
      return {
        ...state,
        olderLoading: false,
        messages: mergeMessages(state.messages, action.page.messages),
        before: action.page.before,
      };
    case "event":
      return { ...onEvent(state, action.event), eventId: action.id };
    case "signed-out":
      return { ...state, phase: "signed-out" };
    case "signing-in":
      return { ...state, phase: "signing-in" };
    case "offline":
      return state.phase === "signed-out" || state.phase === "signing-in"
        ? state
        : { ...state, phase: "offline" };
    case "online":
      return state.phase === "offline" && state.loaded
        ? { ...state, phase: "ready" }
        : state;
    case "context":
      return { ...state, host: action.host };
    case "context-toggle":
      return { ...state, withContext: action.on };
    case "attach": {
      const { attachments } = state;
      const size = action.attachment.size;
      const total = attachments.reduce((sum, item) => sum + item.size, 0);
      // An empty file is no attachment the contract takes.
      const notice: Notice | null =
        attachments.length >= runtimeLimits.attachments
          ? "tooMany"
          : size === 0
            ? "emptyFile"
            : size > runtimeLimits.attachmentBytes
              ? "tooLarge"
              : total + size > runtimeLimits.attachmentsBytes
                ? "tooMuch"
                : null;
      return notice === null
        ? {
            ...state,
            attachments: [...attachments, action.attachment],
            notice: null,
          }
        : { ...state, notice };
    }
    case "detach":
      return {
        ...state,
        attachments: state.attachments.filter((item) => item.id !== action.id),
      };
    case "send":
      return {
        ...state,
        pending: [...state.pending, action.pending],
        attachments: [],
        notice: null,
      };
    case "sent": {
      const pending = state.pending.map((item) =>
        item.client_id === action.client_id
          ? { ...item, status: "sent" as const, message_id: action.message_id }
          : item,
      );
      return { ...state, pending: settle(pending, state.messages) };
    }
    case "send-failed":
      return {
        ...state,
        notice: "sendFailed",
        pending: state.pending.map((item) =>
          item.client_id === action.client_id
            ? { ...item, status: "failed" as const }
            : item,
        ),
      };
    case "retry":
      return {
        ...state,
        notice: null,
        pending: state.pending.map((item) =>
          item.client_id === action.client_id
            ? { ...item, status: "sending" as const }
            : item,
        ),
      };
    case "clarify-done":
      return state.clarify?.clarify_id === action.clarify_id
        ? { ...state, clarify: null }
        : state;
    case "notice":
      return { ...state, notice: action.notice };
  }
}

// ---- What the page shows -----------------------------------------------------------

/** The status under Buddy's name. */
export function statusKey(state: FrameState): CopyKey {
  if (state.phase === "offline") return "unavailable";
  if (state.buddy === "waiting" || state.clarify !== null) return "waiting";
  if (state.buddy === "working" || state.streaming !== null) return "writing";
  return "online";
}

/** Whether the composer can send `text` with the picked attachments now. */
export function canSend(state: FrameState, text: string): boolean {
  return (
    state.phase === "ready" &&
    (text.trim() !== "" || state.attachments.length > 0)
  );
}

const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate();

/** The separator above the first message of a day, in local time: Dnes,
 * Včera, or the date. */
export function dayLabel(at: string, now: Date, lang: Lang): string {
  const day = new Date(at);
  const copy = copyOf(lang);
  if (sameDay(day, now)) return copy.today;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(day, yesterday)) return copy.yesterday;
  return new Intl.DateTimeFormat(lang === "cs" ? "cs-CZ" : "en-GB", {
    day: "numeric",
    month: "long",
    ...(day.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  }).format(day);
}

export type Row =
  | Readonly<{ kind: "day"; key: string; label: string }>
  | Readonly<{
      kind: "message";
      key: string;
      message: ConversationMessage;
      channel: string | null;
    }>
  | Readonly<{ kind: "pending"; key: string; pending: Pending }>
  | Readonly<{ kind: "streaming"; key: string; text: string }>;

/** The thread as rows: each day's separator, the messages with the channel
 * they came through when it is not this one, the person's pending messages,
 * then Buddy's answer as it streams. */
export function threadRows(state: FrameState, now: Date, lang: Lang): Row[] {
  const rows: Row[] = [];
  let lastDay: Date | null = null;
  const day = (at: string) => {
    const date = new Date(at);
    if (lastDay === null || !sameDay(lastDay, date))
      rows.push({
        kind: "day",
        key: `day:${date.toDateString()}`,
        label: dayLabel(at, now, lang),
      });
    lastDay = date;
  };
  for (const message of state.messages) {
    day(message.at);
    rows.push({
      kind: "message",
      key: `m:${message.message_id}`,
      message,
      channel: channelName(message.via),
    });
  }
  for (const pending of state.pending) {
    day(pending.at);
    rows.push({ kind: "pending", key: `p:${pending.client_id}`, pending });
  }
  if (state.streaming !== null) {
    day(now.toISOString());
    rows.push({
      kind: "streaming",
      key: `s:${state.streaming.message_id}`,
      text: state.streaming.text,
    });
  }
  return rows;
}
