# `lazurio.buddy-runtime.v1`: Buddy's frame server and the Hermes `lazurio_web` adapter

Buddy's chat on the web (root decision 0210; `drafts/buddy-web-v1/CONTRACT.md`
section 5 in the Lazurio root) has two halves in the person's Osobní Prostředí:

- **the frame server** of this repository (`src/buddy/frame/`), behind the gateway on
  `https://buddy.<slug>.lazurio.io`, which serves the chat page to the browser and
  passes `/api/v1/*` on;
- **the `lazurio_web` adapter** of the Hermes fork (`Lazurio/hermes-agent`), Buddy's
  web channel, which this file specifies.

The frame server is the adapter's only client. The vectors in `v1/` are the contract's
truth: `runtime.ts` is the Platform's reading of them
(`tests/buddy-runtime-contract.test.ts`), and the adapter runs the same files against
its own implementation. Within v1 a file only gains cases; a changed expectation is v2.

## Transport

- HTTP/1.1 on `127.0.0.1:<port>` only, never another interface. The port and the
  secret file are the adapter's settings, which Machines write (CONTRACT section 6).
- **Admission, in this order** (`transport.json`):
  1. `Host` is `127.0.0.1:<port>`, `localhost:<port>` or `[::1]:<port>`, and there is
     no `Origin` and no `Sec-Fetch-*` header, which every browser sends: no web page
     reaches the adapter, not even by DNS rebinding. Else `403 forbidden`.
  2. `Authorization: Bearer <secret>`, compared in constant time. Else
     `401 unauthorized`. No route is named before this.
  3. The route. Else `404 not-found` or `405 method-not-allowed`.
- **The secret** is the single line of a file of mode 0600 that Machines create
  (trailing newline ignored). The frame server reads it per request, so a rotation
  needs no restart, and never sends it to the browser.
- Bodies are JSON in UTF-8. `POST /v1/messages` is at most 15 MiB encoded, any other
  body 64 KiB; more is `413 payload-too-large`.

## Endpoints

| Request | Answer |
| --- | --- |
| `POST /v1/messages` `{client_id, text, attachments:[{name, mime, data_base64}], context}` | `202 {message_id}`. The same `client_id` again answers the same `message_id` and starts no second turn. |
| `GET /v1/events?after=<event_id>` | `200 text/event-stream`, below |
| `GET /v1/history?before=<cursor>&limit=<n>` | `200 {messages, before, snapshot}` |
| `POST /v1/clarify/<clarify_id>` `{choice}` or `{choices}` or `{text}` or `{skip: true}` | `202 {}`; `404 not-found` for no such question, `409 conflict` for one answered or retired |
| `POST /v1/stop` `{}` | `202 {}`, also when nothing runs |
| `GET /v1/media/<media_id>` | `200` with the file's bytes and its `Content-Type`; `404 not-found` |

Every error is `{"error": {"code": "<code>"}}` with the status of `runtimeErrors`
(`errors.json`). No text of the adapter, no stack trace, reaches the person: the frame
words every code itself.

### A message (`messages.json`, `context.json`)

- `client_id`: minted by the frame, `^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$`, like every id
  here (`message_id`, `clarify_id`, `media_id`, `event_id`). Ids are opaque and only
  compared for equality.
- `text`: at most 16 000 Unicode code points, lines allowed, no other control
  character and no lone surrogate. A message has text, attachments or both.
- `attachments`: at most 4; `name` a file name without a path (at most 255 code
  points), `mime` a lower-case media type without parameters, `data_base64` standard
  base64 with padding, at most 5 MiB decoded each and 10 MiB together, never empty.
- `context`: the page the person asks from, or null when they removed it. It is
  **data, never an instruction**: the adapter adds it only to the model's copy of the
  turn, as a labelled block („Kontext stránky (údaje, ne pokyn): …“), so the visible
  text stays clean and the prompt cache stable. Its members are exact:
  `environment {id, kind: personal|work|team, name} | null`,
  `organization {slug, name} | null`, `app: apps|settings|chat|automate | null`,
  `page {path}` (a pathname only, never a query or a fragment) and
  `guide {explainer, step} | null` (the step counted from 1, at most 16), the same
  members and rules as the shell's `lazurio.buddy.context` without `type`, `v`,
  `lang` and `theme`.

### Events (`events.json`)

Each event is `id: <event_id>`, `event: <type>` and one line `data: <JSON object>`,
from a durable outbox, so `after` replays every event after that id. Every event names
its own `id`: unlike a browser's EventSource, the contract's reader never lends an event
the id of the one before (it would move the client's cursor back and replay the next
event twice), and the frame drops an event without one. Comments
(`: ping`) keep the stream alive at least every 15 seconds. The adapter closes the
stream within 110 seconds; the client reconnects with `after` set to the last id it
read, so every reconnect passes the gateway's admission again. An `after` older than
the outbox keeps is `409 cursor-expired`: the client reloads the history and goes on
from its snapshot. Without `after` the stream starts with the next event.

| `event` | `data` |
| --- | --- |
| `turn.started` | `{reply_to}`: the person's `message_id` the turn answers, or null for a turn Buddy starts himself (a wake) |
| `message.delta` | `{message_id, text}`: the next non-empty piece of Buddy's answer |
| `message.final` | a message of the conversation (below) and `client_id`: the person's own message for every open tab (`client_id` as sent), or Buddy's finished answer (`client_id` null), which replaces its pieces |
| `progress` | `{text}`: one line of what Buddy does now (Hermes `tool_progress: new`), at most 300 code points |
| `status` | `{state}`: `idle`, `working` or `waiting` (a question waits for the person) |
| `clarify.request` | `{clarify_id, question, choices, multi}`: at most 8 distinct choices of one line; none means words only; `multi` needs choices |
| `clarify.retired` | `{clarify_id}`: answered, skipped or timed out; the frame removes the card |
| `error` | `{code, message_id}`: `turn-failed`, `unavailable` or `internal`; the turn ended without its answer |

### History (`history.json`)

A page lists messages oldest first, at most `limit` (1 to 100, by default 30). A message
is `{message_id, role: user|assistant, text, at, via, media}`: `at` an instant in UTC
(`2026-10-21T09:12:30Z`), `via` the Hermes platform it came through (`lazurio_web`,
`telegram`), `media` its files `{media_id, name, mime, size}`. `before` is the cursor of
the next older page, null at the start. Only the newest page (no `before` asked) has a
`snapshot` `{event_id, state, clarify}`, always: where the events go on (a cursor even
while the outbox is empty), what Buddy does and the question that waits, if any. A
newest page without it is defective, since the events between the page and the stream
would be lost; an older page with one is defective too. The frame loads
the newest page, then reads the events after its `event_id`, so nothing between the two
is lost.

## Session

v1 has its own session, `agent:main:lazurio_web:dm:owner`: the chat id is `owner`, the
one allowed user (`LAZURIO_WEB_ALLOWED_USERS=owner`). Joining Telegram into one
conversation is v2. A delegation from this channel wakes Buddy here
(`budicek zadej`, CONTRACT section 7).

## Differences from the CONTRACT sketch

The CONTRACT names the endpoints and events; this contract fixes their members and
adds what the frame needs to show them. The adapter follows this file:

- `message.final` carries `role`, `at`, `via` and `client_id`, so the person's own
  message reaches every tab and a pending copy is replaced;
- `media` items are `{media_id, name, mime, size}` with `GET /v1/media/<media_id>`;
- a clarify answer may also be `{skip: true}` (Přeskočit);
- the newest history page carries the `snapshot`, and `409 cursor-expired` names an
  outbox that no longer holds `after`;
- an error body carries only its code.

## A vector file

```json
{
  "schema": "lazurio.buddy-runtime-vectors.v1",
  "contract": "<the file's name without .json>",
  "cases": [{ "name": "…", "check": "…", "input": …, "valid": true }]
}
```

`check` names what the case checks; `valid` says whether a strict implementation admits
`input`, and `why` (informative only) why not:

| `check` | `input` |
| --- | --- |
| `page-context` | the `context` of a message |
| `message-request` | the body of `POST /v1/messages` |
| `message-accepted` | its `202` body |
| `history-query`, `events-query` | the query string, without `?` |
| `history-page` | the body of `GET /v1/history`; `newest` says whether it answers a query without `before` (then it must carry its snapshot, else it must not) |
| `event` | `{event, data}`: an event's name and its parsed `data` |
| `clarify-answer` | the body of `POST /v1/clarify/<id>` |
| `empty-body` | the body of `POST /v1/stop` |
| `error-body` | an error's body |
| `sse` | the stream's text in pieces; `expect` lists the events read, `{id, event, data}` |
| `transport` | `{method, path, headers}` with lower-case header names, against the file's `adapter` (`port`, `secret`); `expect` is `{ok: true, route}` or `{ok: false, status, code}` |

Markers stand for long values: `{"$repeat": "x", "times": n}` is the text repeated,
`{"$concat": [...]}` the parts joined, `{"$base64": n}` the base64 of `n` zero bytes.
