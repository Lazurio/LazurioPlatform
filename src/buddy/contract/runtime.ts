// `lazurio.buddy-runtime.v1`: the API between Buddy's frame server (this
// repository, src/buddy/frame/) and the Hermes `lazurio_web` adapter
// (Lazurio/hermes-agent), the web channel of the person's Buddy (root
// decision 0210, drafts/buddy-web-v1/CONTRACT.md section 5). The frame server
// is the adapter's only client: it runs in the same Osobní Prostředí, talks
// HTTP on loopback with a bearer secret from a 0600 file, and passes the
// person's browser through. The executable vectors in `vectors/v1/` are the
// contract's truth; this module is the Platform's reading of them and the
// adapter implements the same rules (README.md).
//
// Pure: no I/O, no DOM, no clock. Every check is strict: exact keys, plain
// objects, closed enums and bounded strings; a defect refuses the whole
// value, never just a member of it.

export const buddyRuntime = "lazurio.buddy-runtime.v1";

/** The schema of a vector file of this contract. */
export const buddyRuntimeVectors = "lazurio.buddy-runtime-vectors.v1";

export const runtimeLimits = Object.freeze({
  /** `client_id`, `message_id`, `clarify_id`, `media_id`, `event_id`. */
  idLength: 64,
  /** A history cursor. */
  cursorLength: 128,
  /** A message's text, in Unicode code points. */
  textLength: 16_000,
  /** Attachments of one message. */
  attachments: 4,
  /** One attachment, decoded. */
  attachmentBytes: 5 * 1024 * 1024,
  /** All attachments of one message, decoded. */
  attachmentsBytes: 10 * 1024 * 1024,
  /** An attachment's or a media item's file name. */
  nameLength: 255,
  /** Media items of one message. */
  media: 16,
  historyLimitDefault: 30,
  historyLimitMax: 100,
  clarifyQuestionLength: 2_000,
  clarifyChoices: 8,
  clarifyChoiceLength: 200,
  clarifyTextLength: 2_000,
  progressLength: 300,
  /** The longest an event stream stays open: every reconnect then passes the
   * gateway's admission again. */
  streamSeconds: 110,
  /** A request body to `POST /v1/messages`, encoded (the attachments in
   * base64 included). */
  messageBodyBytes: 15 * 1024 * 1024,
  /** Any other JSON body. */
  smallBodyBytes: 64 * 1024,
});

/** What a check answers: the value as given, or why it is refused. */
export type Checked<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; why: string }>;

const yes = <T>(value: T): Checked<T> => ({ ok: true, value });
const no = <T>(why: string): Checked<T> => ({ ok: false, why });

// ---- Primitives --------------------------------------------------------------

type Data = Readonly<Record<string, unknown>>;

/** A plain JSON object: neither an array nor an object of another prototype. */
function isPlain(value: unknown): value is Data {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Exactly the required keys and none but the optional ones. */
function hasKeys(
  value: Data,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(value);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  );
}

const codePoints = (value: string) => [...value].length;

/** Whether `value` is well-formed text without control characters: no lone
 * surrogate (JSON parsers on both sides admit them), no C0 control and no
 * DEL, except tab, line feed and carriage return where it may span lines. */
function isClean(value: string, lines: boolean): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index++;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) return false;
    if (code === 0x7f) return false;
    if (
      code < 0x20 &&
      !(lines && (code === 0x09 || code === 0x0a || code === 0x0d))
    )
      return false;
  }
  return true;
}

/** Text of at most `max` code points that may span lines. */
function isText(value: unknown, max: number, empty = false): value is string {
  return (
    typeof value === "string" &&
    (empty || value.length > 0) &&
    codePoints(value) <= max &&
    isClean(value, true)
  );
}

/** One line of at most `max` code points, not blank. */
function isLine(value: unknown, max: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    codePoints(value) <= max &&
    isClean(value, false)
  );
}

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
/** An opaque id the side that mints it chooses; compared only for equality. */
export const isRuntimeId = (value: unknown): value is string =>
  typeof value === "string" && idPattern.test(value);

const cursorPattern = /^[A-Za-z0-9][A-Za-z0-9._:=-]{0,127}$/;
/** An opaque history cursor the adapter mints. */
export const isHistoryCursor = (value: unknown): value is string =>
  typeof value === "string" && cursorPattern.test(value);

const mimePattern =
  /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;
/** A media type in lower case, without parameters. */
export const isMimeType = (value: unknown): value is string =>
  typeof value === "string" && mimePattern.test(value);

/** A file's name: one line, no path separator, never `.` or `..`. */
export const isFileName = (value: unknown): value is string =>
  isLine(value, runtimeLimits.nameLength) &&
  !/[/\\]/.test(value) &&
  value !== "." &&
  value !== "..";

const instantPattern =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?Z$/;
/** An instant in UTC, RFC 3339 with `Z`: `2026-10-21T19:30:00Z`. */
export function isInstant(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parts = instantPattern.exec(value);
  if (parts === null) return false;
  const [year, month, day, hour, minute, second] = parts
    .slice(1, 7)
    .map(Number) as [number, number, number, number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day &&
    hour < 24 &&
    minute < 60 &&
    second < 60
  );
}

/** The Hermes platform a message came through (`lazurio_web`, `telegram`). */
export const isChannel = (value: unknown): value is string =>
  typeof value === "string" && /^[a-z][a-z0-9_]{0,31}$/.test(value);

const base64Pattern =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
/** The bytes standard base64 (with padding) decodes to, or null for any
 * other text. */
export function base64Bytes(value: unknown): number | null {
  if (typeof value !== "string" || !base64Pattern.test(value)) return null;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

// ---- The page context ----------------------------------------------------------

export type EnvironmentKind = "personal" | "work" | "team";
export const environmentKinds: readonly EnvironmentKind[] = Object.freeze([
  "personal",
  "work",
  "team",
]);

/** The app of the page Buddy is asked from, as the shell's column head
 * names it. */
export type PageApp = "apps" | "settings" | "chat" | "automate";
export const pageApps: readonly PageApp[] = Object.freeze([
  "apps",
  "settings",
  "chat",
  "automate",
]);

/** Where the person asks from, as the frame took it from its host and the
 * person sent it along (CONTRACT section 2): data about the page, never an
 * instruction. The adapter adds it to the model's copy of the turn only. */
export type PageContext = Readonly<{
  environment: Readonly<{
    id: string;
    kind: EnvironmentKind;
    name: string;
  }> | null;
  organization: Readonly<{ slug: string; name: string }> | null;
  app: PageApp | null;
  page: Readonly<{ path: string }>;
  /** The explanation the guide last showed on the page and its step,
   * counted from 1, at most 16 (the shell's `buddyContextLimits.steps`). */
  guide: Readonly<{ explainer: string; step: number }> | null;
}>;

const labelPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/** An Environment id: one lowercase DNS label (the Osobní Prostředí's slug)
 * or two (`<machine>.<org>`), as `src/browser/contract/pure.ts` reads it. */
export function isEnvironmentId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const labels = value.split(".");
  return (
    labels.length <= 2 && labels.every((label) => labelPattern.test(label))
  );
}

const pagePathPattern = /^\/(?!\/)[^\s\\?#]*$/;
/** A pathname only: never a query or a fragment, which may carry tokens. */
export const isPagePath = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length <= 512 &&
  pagePathPattern.test(value) &&
  isClean(value, false);

/** An explanation of the guide (src/shell/guide-protocol.ts). */
export const isExplainerId = (value: unknown): value is string =>
  typeof value === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(value);

/** The page context of a message: an object of exactly its members, or null
 * when the person sends without it. */
export function checkPageContext(input: unknown): Checked<PageContext | null> {
  if (input === null) return yes(null);
  if (!isPlain(input)) return no("not an object");
  if (!hasKeys(input, ["environment", "organization", "app", "page", "guide"]))
    return no("not exactly its keys");
  const { environment, organization, app, page, guide } = input;
  if (environment !== null) {
    if (!isPlain(environment) || !hasKeys(environment, ["id", "kind", "name"]))
      return no("environment");
    if (!isEnvironmentId(environment.id)) return no("environment id");
    if (!environmentKinds.includes(environment.kind as EnvironmentKind))
      return no("environment kind");
    if (!isLine(environment.name, 128)) return no("environment name");
  }
  if (organization !== null) {
    if (!isPlain(organization) || !hasKeys(organization, ["slug", "name"]))
      return no("organization");
    if (
      !isLine(organization.slug, 128) ||
      organization.slug.trim() !== organization.slug
    )
      return no("organization slug");
    if (!isLine(organization.name, 128)) return no("organization name");
  }
  if (app !== null && !pageApps.includes(app as PageApp)) return no("app");
  if (!isPlain(page) || !hasKeys(page, ["path"]) || !isPagePath(page.path))
    return no("page");
  if (guide !== null) {
    if (!isPlain(guide) || !hasKeys(guide, ["explainer", "step"]))
      return no("guide");
    if (!isExplainerId(guide.explainer)) return no("guide explainer");
    if (
      typeof guide.step !== "number" ||
      !Number.isInteger(guide.step) ||
      guide.step < 1 ||
      guide.step > 16
    )
      return no("guide step");
  }
  return yes(input as PageContext);
}

// ---- POST /v1/messages -----------------------------------------------------------

export type Attachment = Readonly<{
  name: string;
  mime: string;
  data_base64: string;
}>;

export type MessageRequest = Readonly<{
  client_id: string;
  text: string;
  attachments: readonly Attachment[];
  context: PageContext | null;
}>;

/** A message from the person. `client_id`, which the frame mints, makes a
 * retry idempotent: the adapter answers the same `message_id` and starts no
 * second turn. A message has text, attachments or both. */
export function checkMessageRequest(input: unknown): Checked<MessageRequest> {
  if (!isPlain(input)) return no("not an object");
  if (!hasKeys(input, ["client_id", "text", "attachments", "context"]))
    return no("not exactly its keys");
  if (!isRuntimeId(input.client_id)) return no("client_id");
  if (!isText(input.text, runtimeLimits.textLength, true)) return no("text");
  const attachments = input.attachments;
  if (!Array.isArray(attachments)) return no("attachments");
  if (attachments.length > runtimeLimits.attachments)
    return no("too many attachments");
  let total = 0;
  for (const attachment of attachments) {
    if (
      !isPlain(attachment) ||
      !hasKeys(attachment, ["name", "mime", "data_base64"])
    )
      return no("attachment");
    if (!isFileName(attachment.name)) return no("attachment name");
    if (!isMimeType(attachment.mime)) return no("attachment mime");
    const bytes = base64Bytes(attachment.data_base64);
    if (bytes === null || bytes === 0) return no("attachment data");
    if (bytes > runtimeLimits.attachmentBytes)
      return no("attachment too large");
    total += bytes;
  }
  if (total > runtimeLimits.attachmentsBytes)
    return no("attachments too large");
  if (input.text.trim() === "" && attachments.length === 0)
    return no("nothing to send");
  const context = checkPageContext(input.context);
  if (!context.ok) return no(`context: ${context.why}`);
  return yes(input as MessageRequest);
}

export type MessageAccepted = Readonly<{ message_id: string }>;

/** `202` to a message: the id of the person's message. */
export function checkMessageAccepted(input: unknown): Checked<MessageAccepted> {
  if (!isPlain(input) || !hasKeys(input, ["message_id"]))
    return no("not exactly its keys");
  if (!isRuntimeId(input.message_id)) return no("message_id");
  return yes(input as MessageAccepted);
}

// ---- Messages, media and the clarify question -------------------------------------

/** A file of a message: one the person attached, or one Buddy sent. Its
 * bytes are at `GET /v1/media/<media_id>`. */
export type Media = Readonly<{
  media_id: string;
  name: string;
  mime: string;
  size: number;
}>;

export function checkMedia(input: unknown): Checked<Media> {
  if (!isPlain(input) || !hasKeys(input, ["media_id", "name", "mime", "size"]))
    return no("media");
  if (!isRuntimeId(input.media_id)) return no("media_id");
  if (!isFileName(input.name)) return no("media name");
  if (!isMimeType(input.mime)) return no("media mime");
  if (
    typeof input.size !== "number" ||
    !Number.isSafeInteger(input.size) ||
    input.size < 0
  )
    return no("media size");
  return yes(input as Media);
}

export type MessageRole = "user" | "assistant";

/** A message of the conversation, as history lists it and as
 * `message.final` delivers it. `via` is the Hermes platform it came through:
 * the frame marks every other channel than its own. */
export type ConversationMessage = Readonly<{
  message_id: string;
  role: MessageRole;
  text: string;
  at: string;
  via: string;
  media: readonly Media[];
}>;

function checkMessageMembers(
  input: Data,
): Checked<Omit<ConversationMessage, "media">> {
  if (!isRuntimeId(input.message_id)) return no("message_id");
  if (input.role !== "user" && input.role !== "assistant") return no("role");
  if (!isText(input.text, runtimeLimits.textLength, true)) return no("text");
  if (!isInstant(input.at)) return no("at");
  if (!isChannel(input.via)) return no("via");
  return yes(input as unknown as Omit<ConversationMessage, "media">);
}

function checkMediaList(input: unknown): Checked<readonly Media[]> {
  if (!Array.isArray(input) || input.length > runtimeLimits.media)
    return no("media");
  for (const item of input) {
    const media = checkMedia(item);
    if (!media.ok) return no(media.why);
  }
  return yes(input as readonly Media[]);
}

export function checkConversationMessage(
  input: unknown,
): Checked<ConversationMessage> {
  if (
    !isPlain(input) ||
    !hasKeys(input, ["message_id", "role", "text", "at", "via", "media"])
  )
    return no("message");
  const members = checkMessageMembers(input);
  if (!members.ok) return no(members.why);
  const media = checkMediaList(input.media);
  if (!media.ok) return no(media.why);
  return yes(input as ConversationMessage);
}

/** A question Buddy asks the person (Hermes's clarify): up to eight choices,
 * one or many of them (`multi`); the person may also answer in words or
 * skip it. */
export type Clarify = Readonly<{
  clarify_id: string;
  question: string;
  choices: readonly string[];
  multi: boolean;
}>;

export function checkClarify(input: unknown): Checked<Clarify> {
  if (
    !isPlain(input) ||
    !hasKeys(input, ["clarify_id", "question", "choices", "multi"])
  )
    return no("clarify");
  if (!isRuntimeId(input.clarify_id)) return no("clarify_id");
  if (!isText(input.question, runtimeLimits.clarifyQuestionLength))
    return no("question");
  const choices = input.choices;
  if (
    !Array.isArray(choices) ||
    choices.length > runtimeLimits.clarifyChoices ||
    !choices.every((choice) =>
      isLine(choice, runtimeLimits.clarifyChoiceLength),
    )
  )
    return no("choices");
  if (new Set(choices).size !== choices.length) return no("choices repeat");
  if (typeof input.multi !== "boolean") return no("multi");
  if (input.multi && choices.length === 0) return no("multi without choices");
  return yes(input as Clarify);
}

// ---- GET /v1/history ----------------------------------------------------------------

export type BuddyState = "idle" | "working" | "waiting";
export const buddyStates: readonly BuddyState[] = Object.freeze([
  "idle",
  "working",
  "waiting",
]);

/** Where the live events continue from the newest page: the id of the
 * newest event in the outbox (a cursor the adapter mints even while the
 * outbox is empty), what Buddy is doing and the question that waits for the
 * person, if any. */
export type HistorySnapshot = Readonly<{
  event_id: string;
  state: BuddyState;
  clarify: Clarify | null;
}>;

/** One page of the conversation, oldest first. `before` is the cursor of the
 * next older page, null at the conversation's start. Only the newest page
 * (no `before` asked) carries a `snapshot`; an older page carries null. */
export type HistoryPage = Readonly<{
  messages: readonly ConversationMessage[];
  before: string | null;
  snapshot: HistorySnapshot | null;
}>;

export type HistoryQuery = Readonly<{ before: string | null; limit: number }>;

/** The query of `GET /v1/history`: `before` (a cursor) and `limit` (1 to
 * 100, by default 30), each at most once, nothing else. */
export function checkHistoryQuery(query: string): Checked<HistoryQuery> {
  const params = new URLSearchParams(query);
  const names = [...params.keys()];
  if (names.some((name) => name !== "before" && name !== "limit"))
    return no("unknown parameter");
  if (params.getAll("before").length > 1 || params.getAll("limit").length > 1)
    return no("repeated parameter");
  const before = params.get("before");
  if (before !== null && !isHistoryCursor(before)) return no("before");
  const written = params.get("limit");
  if (written !== null && !/^[1-9][0-9]{0,2}$/.test(written))
    return no("limit");
  const limit =
    written === null ? runtimeLimits.historyLimitDefault : Number(written);
  if (limit > runtimeLimits.historyLimitMax) return no("limit");
  return yes({ before, limit });
}

export function checkHistoryPage(input: unknown): Checked<HistoryPage> {
  if (!isPlain(input) || !hasKeys(input, ["messages", "before", "snapshot"]))
    return no("not exactly its keys");
  const messages = input.messages;
  if (
    !Array.isArray(messages) ||
    messages.length > runtimeLimits.historyLimitMax
  )
    return no("messages");
  for (const message of messages) {
    const checked = checkConversationMessage(message);
    if (!checked.ok) return no(checked.why);
  }
  if (input.before !== null && !isHistoryCursor(input.before))
    return no("before");
  const snapshot = input.snapshot;
  if (snapshot !== null) {
    if (
      !isPlain(snapshot) ||
      !hasKeys(snapshot, ["event_id", "state", "clarify"])
    )
      return no("snapshot");
    if (!isRuntimeId(snapshot.event_id)) return no("snapshot event_id");
    if (!buddyStates.includes(snapshot.state as BuddyState))
      return no("snapshot state");
    if (snapshot.clarify !== null && !checkClarify(snapshot.clarify).ok)
      return no("snapshot clarify");
  }
  return yes(input as HistoryPage);
}

// ---- GET /v1/events -------------------------------------------------------------------

/** The query of `GET /v1/events`: `after`, the last event the client has,
 * at most once. Without it the stream starts with the next event. */
export function checkEventsQuery(
  query: string,
): Checked<Readonly<{ after: string | null }>> {
  const params = new URLSearchParams(query);
  if ([...params.keys()].some((name) => name !== "after"))
    return no("unknown parameter");
  if (params.getAll("after").length > 1) return no("repeated parameter");
  const after = params.get("after");
  if (after !== null && !isRuntimeId(after)) return no("after");
  return yes({ after });
}

export const runtimeEventTypes = Object.freeze([
  "turn.started",
  "message.delta",
  "message.final",
  "progress",
  "status",
  "clarify.request",
  "clarify.retired",
  "error",
] as const);
export type RuntimeEventType = (typeof runtimeEventTypes)[number];

/** Why a turn ended without its answer. */
export const turnErrorCodes = Object.freeze([
  "turn-failed",
  "unavailable",
  "internal",
] as const);
export type TurnErrorCode = (typeof turnErrorCodes)[number];

/** A message as `message.final` delivers it: the conversation's message
 * and, for the person's own, the `client_id` it was sent with (null for
 * Buddy's), so the sending tab replaces its pending copy and another tab
 * shows it. */
export type FinalMessage = ConversationMessage &
  Readonly<{ client_id: string | null }>;

export type RuntimeEvent =
  | Readonly<{ type: "turn.started"; data: { reply_to: string | null } }>
  | Readonly<{
      type: "message.delta";
      data: { message_id: string; text: string };
    }>
  | Readonly<{ type: "message.final"; data: FinalMessage }>
  | Readonly<{ type: "progress"; data: { text: string } }>
  | Readonly<{ type: "status"; data: { state: BuddyState } }>
  | Readonly<{ type: "clarify.request"; data: Clarify }>
  | Readonly<{ type: "clarify.retired"; data: { clarify_id: string } }>
  | Readonly<{
      type: "error";
      data: { code: TurnErrorCode; message_id: string | null };
    }>;

/** One event of the stream by its SSE `event` name and its `data` parsed as
 * JSON. An unknown name is refused like a defective value: a later version
 * that adds one is v2. */
export function checkRuntimeEvent(
  type: string,
  data: unknown,
): Checked<RuntimeEvent> {
  if (!isPlain(data)) return no("data");
  const event = (value: unknown) =>
    yes({ type, data: value } as unknown as RuntimeEvent);
  switch (type) {
    case "turn.started":
      if (!hasKeys(data, ["reply_to"])) return no("keys");
      if (data.reply_to !== null && !isRuntimeId(data.reply_to))
        return no("reply_to");
      return event(data);
    case "message.delta":
      if (!hasKeys(data, ["message_id", "text"])) return no("keys");
      if (!isRuntimeId(data.message_id)) return no("message_id");
      if (!isText(data.text, runtimeLimits.textLength)) return no("text");
      return event(data);
    case "message.final": {
      if (
        !hasKeys(data, [
          "message_id",
          "role",
          "text",
          "at",
          "via",
          "media",
          "client_id",
        ])
      )
        return no("keys");
      const members = checkMessageMembers(data);
      if (!members.ok) return no(members.why);
      const media = checkMediaList(data.media);
      if (!media.ok) return no(media.why);
      if (data.client_id !== null && !isRuntimeId(data.client_id))
        return no("client_id");
      if (data.role === "assistant" && data.client_id !== null)
        return no("client_id of Buddy's message");
      return event(data);
    }
    case "progress":
      if (!hasKeys(data, ["text"])) return no("keys");
      if (!isLine(data.text, runtimeLimits.progressLength)) return no("text");
      return event(data);
    case "status":
      if (!hasKeys(data, ["state"])) return no("keys");
      if (!buddyStates.includes(data.state as BuddyState)) return no("state");
      return event(data);
    case "clarify.request": {
      const clarify = checkClarify(data);
      return clarify.ok ? event(data) : no(clarify.why);
    }
    case "clarify.retired":
      if (!hasKeys(data, ["clarify_id"])) return no("keys");
      if (!isRuntimeId(data.clarify_id)) return no("clarify_id");
      return event(data);
    case "error":
      if (!hasKeys(data, ["code", "message_id"])) return no("keys");
      if (!turnErrorCodes.includes(data.code as TurnErrorCode))
        return no("code");
      if (data.message_id !== null && !isRuntimeId(data.message_id))
        return no("message_id");
      return event(data);
    default:
      return no("unknown event");
  }
}

// ---- Server-sent events framing -------------------------------------------------------

/** One event of a `text/event-stream` as the WHATWG HTML parsing rules read
 * it: `id` null when the event named none. */
export type SseEvent = Readonly<{
  id: string | null;
  event: string;
  data: string;
}>;

/** One event of the stream in its wire form: `id`, `event` and the JSON
 * `data` on one line. */
export function formatSseEvent(
  id: string,
  type: RuntimeEventType,
  data: unknown,
): string {
  if (!isRuntimeId(id)) throw new Error("Invalid event id");
  return `id: ${id}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** An incremental reader of a `text/event-stream`: feed it the decoded text
 * as it arrives, it returns the events completed so far. Comments (`:` lines,
 * the heartbeat) and `retry` are read and dropped; an event without data is
 * not dispatched, as the standard says. */
export function createSseReader() {
  let line = "";
  // A `\r` ended the last line: a `\n` right after it belongs to it, even
  // in the next piece.
  let afterReturn = false;
  // The last event id persists from event to event, as the standard says.
  let id: string | null = null;
  let event = "";
  let data: string[] = [];
  const events: SseEvent[] = [];
  function end() {
    if (line === "") {
      if (data.length > 0)
        events.push({ id, event: event || "message", data: data.join("\n") });
      event = "";
      data = [];
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") data.push(value);
    else if (field === "event") event = value;
    else if (field === "id" && !value.includes("\u0000")) id = value;
  }
  return {
    push(text: string): SseEvent[] {
      for (const character of text) {
        if (character === "\n" && afterReturn) {
          afterReturn = false;
          continue;
        }
        afterReturn = character === "\r";
        if (character === "\r" || character === "\n") {
          end();
          line = "";
        } else line += character;
      }
      return events.splice(0);
    },
  };
}

// ---- Errors ---------------------------------------------------------------------------

/** Every error the adapter answers, with its HTTP status. */
export const runtimeErrors = Object.freeze({
  "bad-request": 400,
  unauthorized: 401,
  forbidden: 403,
  "not-found": 404,
  "method-not-allowed": 405,
  conflict: 409,
  "cursor-expired": 409,
  "payload-too-large": 413,
  unavailable: 503,
  internal: 500,
} as const);
export type RuntimeErrorCode = keyof typeof runtimeErrors;

/** An error's body: `{"error": {"code": …}}`. The code is the contract; no
 * text of the adapter reaches the person. */
export type ErrorBody = Readonly<{
  error: Readonly<{ code: RuntimeErrorCode }>;
}>;

export function checkErrorBody(input: unknown): Checked<ErrorBody> {
  if (!isPlain(input) || !hasKeys(input, ["error"])) return no("keys");
  const error = input.error;
  if (!isPlain(error) || !hasKeys(error, ["code"])) return no("error");
  if (
    typeof error.code !== "string" ||
    !Object.hasOwn(runtimeErrors, error.code)
  )
    return no("code");
  return yes(input as ErrorBody);
}

export const errorBody = (code: RuntimeErrorCode): ErrorBody => ({
  error: { code },
});

// ---- POST /v1/clarify/<clarify_id> -------------------------------------------------------

/** The person's answer: one of the offered choices, several of them (only
 * for `multi`), words of their own (Jiné…), or nothing (Přeskočit). Whether
 * a choice was offered is the adapter's to check against its question. */
export type ClarifyAnswer =
  | Readonly<{ choice: string }>
  | Readonly<{ choices: readonly string[] }>
  | Readonly<{ text: string }>
  | Readonly<{ skip: true }>;

export function checkClarifyAnswer(input: unknown): Checked<ClarifyAnswer> {
  if (!isPlain(input)) return no("not an object");
  const keys = Object.keys(input);
  if (keys.length !== 1) return no("not exactly one answer");
  if (hasKeys(input, ["choice"]))
    return isLine(input.choice, runtimeLimits.clarifyChoiceLength)
      ? yes(input as ClarifyAnswer)
      : no("choice");
  if (hasKeys(input, ["choices"])) {
    const choices = input.choices;
    return Array.isArray(choices) &&
      choices.length > 0 &&
      choices.length <= runtimeLimits.clarifyChoices &&
      choices.every((choice) =>
        isLine(choice, runtimeLimits.clarifyChoiceLength),
      ) &&
      new Set(choices).size === choices.length
      ? yes(input as ClarifyAnswer)
      : no("choices");
  }
  if (hasKeys(input, ["text"]))
    return isText(input.text, runtimeLimits.clarifyTextLength) &&
      input.text.trim() !== ""
      ? yes(input as ClarifyAnswer)
      : no("text");
  if (hasKeys(input, ["skip"]))
    return input.skip === true ? yes(input as ClarifyAnswer) : no("skip");
  return no("unknown answer");
}

/** `POST /v1/stop` carries an empty object; it and an answered clarify are
 * `202 {}`. */
export function checkEmptyBody(input: unknown): Checked<Readonly<object>> {
  return isPlain(input) && Object.keys(input).length === 0
    ? yes(input)
    : no("not an empty object");
}

// ---- The adapter's transport ----------------------------------------------------------------

/** What the adapter routes a request to. */
export type AdapterRoute =
  | Readonly<{ kind: "messages" }>
  | Readonly<{ kind: "events" }>
  | Readonly<{ kind: "history" }>
  | Readonly<{ kind: "clarify"; clarify_id: string }>
  | Readonly<{ kind: "stop" }>
  | Readonly<{ kind: "media"; media_id: string }>;

export type AdapterRequest = Readonly<{
  method: string;
  /** The request target's path, without the query. */
  path: string;
  /** Header names in lower case. */
  headers: Readonly<Record<string, string>>;
}>;

export type AdapterAdmission =
  | Readonly<{ ok: true; route: AdapterRoute }>
  | Readonly<{ ok: false; status: number; code: RuntimeErrorCode }>;

/** Equal secrets, compared in time that does not depend on where they
 * differ. */
export function sameSecret(given: string, expected: string): boolean {
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(expected);
  let difference = a.length ^ b.length;
  for (let index = 0; index < b.length; index++)
    difference |= (a[index] ?? 0) ^ (b[index] as number);
  return difference === 0 && b.length > 0;
}

const routes: readonly (readonly [
  string,
  RegExp,
  (match: RegExpExecArray) => AdapterRoute,
])[] = [
  ["POST", /^\/v1\/messages$/, () => ({ kind: "messages" })],
  ["GET", /^\/v1\/events$/, () => ({ kind: "events" })],
  ["GET", /^\/v1\/history$/, () => ({ kind: "history" })],
  [
    "POST",
    /^\/v1\/clarify\/([A-Za-z0-9][A-Za-z0-9._:-]{0,63})$/,
    (match) => ({ kind: "clarify", clarify_id: match[1] as string }),
  ],
  ["POST", /^\/v1\/stop$/, () => ({ kind: "stop" })],
  [
    "GET",
    /^\/v1\/media\/([A-Za-z0-9][A-Za-z0-9._:-]{0,63})$/,
    (match) => ({ kind: "media", media_id: match[1] as string }),
  ],
];

const refused = (code: RuntimeErrorCode): AdapterAdmission => ({
  ok: false,
  status: runtimeErrors[code],
  code,
});

/** The adapter's admission of a request, in this order: a loopback `Host`
 * naming its port, and nothing a browser sends (`Origin`, any `Sec-Fetch-*`),
 * so no web page reaches it, not even by DNS rebinding (403 `forbidden`);
 * exactly `Authorization: Bearer <secret>` (401 `unauthorized`); then the
 * route (404 `not-found`, 405 `method-not-allowed`). */
export function admitAdapterRequest(
  request: AdapterRequest,
  adapter: Readonly<{ port: number; secret: string }>,
): AdapterAdmission {
  const host = request.headers.host;
  if (
    host !== `127.0.0.1:${adapter.port}` &&
    host !== `localhost:${adapter.port}` &&
    host !== `[::1]:${adapter.port}`
  )
    return refused("forbidden");
  for (const name of Object.keys(request.headers))
    if (name === "origin" || name.startsWith("sec-fetch-"))
      return refused("forbidden");
  const authorization = request.headers.authorization ?? "";
  if (
    !authorization.startsWith("Bearer ") ||
    !sameSecret(authorization.slice("Bearer ".length), adapter.secret)
  )
    return refused("unauthorized");
  let known = false;
  for (const [method, pattern, route] of routes) {
    const match = pattern.exec(request.path);
    if (match === null) continue;
    known = true;
    if (method === request.method) return { ok: true, route: route(match) };
  }
  return refused(known ? "method-not-allowed" : "not-found");
}
