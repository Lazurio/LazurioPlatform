import { describe, expect, test } from "bun:test";
import {
  type ConversationMessage,
  createSseReader,
  type HistoryPage,
  type RuntimeEvent,
} from "../src/buddy/contract/runtime";
import {
  frameAncestors,
  hostEnvironmentOf,
  hostOriginAtLoad,
  hostOriginOf,
  isFrameOrigin,
  signInUrl,
} from "../src/buddy/frame/hosts";
import {
  browserLang,
  channelName,
  contextLine,
} from "../src/buddy/frame/page/copy";
import {
  acceptContext,
  type HostContext,
  layoutMessage,
  readyMessage,
} from "../src/buddy/frame/page/host";
import {
  readInline,
  readMarkdown,
  safeHref,
} from "../src/buddy/frame/page/markdown";
import {
  canSend,
  dayLabel,
  eventAction,
  type FrameAction,
  type FrameState,
  initialState,
  reduce,
  statusKey,
  threadRows,
} from "../src/buddy/frame/page/state";

const frame = "https://buddy.jana.lazurio.io";

describe("who may frame Buddy", () => {
  test("the shell's apps of the person's Environments, nothing else", () => {
    expect(hostEnvironmentOf(frame, "https://launchpad.jana.lazurio.io")).toBe(
      "jana",
    );
    expect(hostEnvironmentOf(frame, "https://t3code.jana.lazurio.io")).toBe(
      "jana",
    );
    expect(
      hostEnvironmentOf(frame, "https://mausbot.vm-01.acme.lazurio.io"),
    ).toBe("vm-01.acme");
    expect(
      hostEnvironmentOf(frame, "https://launchpad.team-01.acme.lazurio.io"),
    ).toBe("team-01.acme");
    for (const foreign of [
      // A Module's app runs an Organization's own code.
      "https://notes.vm-01.acme.lazurio.io",
      // Another person's Osobní Prostředí.
      "https://launchpad.petr.lazurio.io",
      // Another domain, a deeper base, the bare domain, another scheme.
      "https://launchpad.vm-01.acme.lazurio.io.evil.example",
      "https://launchpad.evil.example",
      "https://launchpad.a.vm-01.acme.lazurio.io",
      "https://launchpad.lazurio.io",
      "http://launchpad.jana.lazurio.io",
      "https://launchpad.jana.lazurio.io:8443",
      "https://user@launchpad.jana.lazurio.io",
      "https://dashboard.lazurio.ai",
      "null",
      "",
    ])
      expect(hostEnvironmentOf(frame, foreign)).toBeNull();
    expect(hostEnvironmentOf(frame, null)).toBeNull();
  });

  test("frame-ancestors names exactly the host that asks, never a wildcard", () => {
    expect(
      frameAncestors(frame, "https://launchpad.vm-01.acme.lazurio.io/"),
    ).toBe("https://launchpad.vm-01.acme.lazurio.io");
    expect(
      frameAncestors(frame, "https://t3code.jana.lazurio.io/c/thread-1"),
    ).toBe("https://t3code.jana.lazurio.io");
    expect(frameAncestors(frame, "https://notes.vm-01.acme.lazurio.io/")).toBe(
      "'none'",
    );
    expect(frameAncestors(frame, "not a url")).toBe("'none'");
    expect(frameAncestors(frame, null)).toBe("'none'");
    // The frame reloading itself names its host; the Referer still comes first.
    expect(
      frameAncestors(frame, null, "https://launchpad.jana.lazurio.io"),
    ).toBe("https://launchpad.jana.lazurio.io");
    expect(
      frameAncestors(
        frame,
        "https://t3code.jana.lazurio.io/",
        "https://launchpad.jana.lazurio.io",
      ),
    ).toBe("https://t3code.jana.lazurio.io");
    for (const named of [
      "https://notes.vm-01.acme.lazurio.io",
      "https://launchpad.jana.lazurio.io/",
      "https://evil.example",
      "*",
    ])
      expect(frameAncestors(frame, null, named)).toBe("'none'");
    expect(hostOriginOf(frame, "https://launchpad.jana.lazurio.io/x?y")).toBe(
      "https://launchpad.jana.lazurio.io",
    );
  });

  test("a local preview keeps its scheme and port", () => {
    const local = "http://buddy.jana.lazurio.localhost:8801";
    expect(isFrameOrigin(local)).toBe(true);
    expect(
      hostEnvironmentOf(local, "http://launchpad.jana.lazurio.localhost:8801"),
    ).toBe("jana");
    expect(
      hostEnvironmentOf(local, "http://launchpad.jana.lazurio.localhost:8802"),
    ).toBeNull();
    expect(isFrameOrigin("https://buddy.lazurio.io")).toBe(false);
    expect(isFrameOrigin("https://buddy.jana.lazurio.io/")).toBe(false);
  });

  test("the sign-in starts on the bare domain and comes back to /signed-in", () => {
    expect(signInUrl(frame)).toBe(
      "https://jana.lazurio.io/oauth2/start?rd=https%3A%2F%2Fbuddy.jana.lazurio.io%2Fsigned-in",
    );
    expect(signInUrl("http://buddy.jana.lazurio.localhost:8801")).toBe(
      "http://jana.lazurio.localhost:8801/oauth2/start?rd=http%3A%2F%2Fbuddy.jana.lazurio.localhost%3A8801%2Fsigned-in",
    );
  });
});

const host = "https://launchpad.vm-01.acme.lazurio.io";
const context = {
  type: "lazurio.buddy.context",
  v: 1,
  lang: "cs",
  theme: "dark",
  environment: { id: "vm-01.acme", kind: "work", name: "vm-01" },
  organization: { slug: "acme", name: "Acme" },
  app: "apps",
  page: { path: "/files" },
  guide: { explainer: "files", step: 1 },
};
const event = (data: unknown, origin = host, fromParent = true) => ({
  data,
  origin,
  fromParent,
});

describe("the host protocol, the frame's side", () => {
  test("ready and layout go out as v1", () => {
    expect(readyMessage()).toEqual({ type: "lazurio.buddy.ready", v: 1 });
    expect(layoutMessage("fullscreen")).toEqual({
      type: "lazurio.buddy.layout",
      v: 1,
      mode: "fullscreen",
    });
  });

  test("the host's origin at load: the parent, else the referrer, else the named host, only framed", () => {
    expect(hostOriginAtLoad(frame, true, [host], "", null)).toBe(host);
    expect(hostOriginAtLoad(frame, true, null, `${host}/`, null)).toBe(host);
    // After the frame reloaded itself: no referrer, the host it named.
    expect(hostOriginAtLoad(frame, true, null, "", host)).toBe(host);
    expect(hostOriginAtLoad(frame, true, null, `${frame}/`, host)).toBe(host);
    // The browser's list is the real parent: a name never overrides it.
    expect(
      hostOriginAtLoad(frame, true, ["https://evil.example"], "", host),
    ).toBeNull();
    expect(
      hostOriginAtLoad(
        frame,
        true,
        null,
        "",
        "https://notes.vm-01.acme.lazurio.io",
      ),
    ).toBeNull();
    expect(hostOriginAtLoad(frame, true, null, "", `${host}/x`)).toBeNull();
    expect(hostOriginAtLoad(frame, true, [], "", null)).toBeNull();
    expect(hostOriginAtLoad(frame, false, [host], `${host}/`, host)).toBeNull();
  });

  test("a context from the host is taken whole", () => {
    expect(acceptContext(event(context), frame, host)).toEqual({
      lang: "cs",
      theme: "dark",
      context: {
        environment: { id: "vm-01.acme", kind: "work", name: "vm-01" },
        organization: { slug: "acme", name: "Acme" },
        app: "apps",
        page: { path: "/files" },
        guide: { explainer: "files", step: 1 },
      },
    });
  });

  test("the Osobní Prostředí's own Launchpad is personal, and only it", () => {
    const own = "https://launchpad.jana.lazurio.io";
    const personal = {
      ...context,
      environment: { id: "jana", kind: "personal", name: "Osobní Prostředí" },
      organization: null,
    };
    expect(
      acceptContext(event(personal, own), frame, own)?.context.environment,
    ).toEqual({
      id: "jana",
      kind: "personal",
      name: "Osobní Prostředí",
    });
    expect(
      acceptContext(
        event(
          {
            ...personal,
            environment: { ...personal.environment, kind: "work" },
          },
          own,
        ),
        frame,
        own,
      ),
    ).toBeNull();
  });

  test("anything defective drops the whole message", () => {
    const refused: unknown[] = [
      { ...context, extra: true },
      { ...context, v: 2 },
      { ...context, type: "lazurio.buddy.draft" },
      { ...context, lang: "de" },
      { ...context, theme: "blue" },
      { ...context, environment: { ...context.environment, id: "vm-02.acme" } },
      { ...context, environment: null },
      {
        ...context,
        environment: { ...context.environment, kind: "automated" },
      },
      { ...context, environment: { ...context.environment, name: "" } },
      { ...context, environment: { ...context.environment, extra: 1 } },
      { ...context, environment: { ...context.environment, kind: "personal" } },
      { ...context, guide: { explainer: "files", step: 0 } },
      { ...context, guide: { explainer: "files", step: 17 } },
      { ...context, organization: { slug: " acme", name: "Acme" } },
      { ...context, app: "module" },
      { ...context, page: { path: "/files?token=1" } },
      { ...context, guide: { explainer: "files", step: -1 } },
      Object.assign(Object.create({ inherited: true }), context),
      null,
      "context",
    ];
    for (const data of refused)
      expect(acceptContext(event(data), frame, host)).toBeNull();
    // Another origin, another window, or a host that may not frame Buddy.
    expect(
      acceptContext(
        event(context, "https://launchpad.vm-02.acme.lazurio.io"),
        frame,
        host,
      ),
    ).toBeNull();
    expect(acceptContext(event(context, host, false), frame, host)).toBeNull();
    expect(acceptContext(event(context), frame, null)).toBeNull();
    const module = "https://notes.vm-01.acme.lazurio.io";
    expect(acceptContext(event(context, module), frame, module)).toBeNull();
  });
});

const message = (
  id: string,
  role: "user" | "assistant",
  at: string,
  text = id,
): ConversationMessage => ({
  message_id: id,
  role,
  text,
  at,
  via: "lazurio_web",
  media: [],
});

const page = (
  messages: ConversationMessage[],
  before: string | null,
  snapshot: HistoryPage["snapshot"],
): HistoryPage => ({
  messages,
  before,
  snapshot,
});

const run = (actions: FrameAction[], from: FrameState = initialState) =>
  actions.reduce(reduce, from);
const on = (id: string, value: RuntimeEvent): FrameAction => ({
  type: "event",
  id,
  event: value,
});

describe("the chat's state", () => {
  const loaded = run([
    { type: "persona", name: "Mattyčus" },
    {
      type: "history",
      page: page(
        [
          message("m-1", "assistant", "2026-10-20T07:00:00Z"),
          message("m-2", "user", "2026-10-21T09:00:00Z"),
        ],
        "c-1",
        { event_id: "e-10", state: "idle", clarify: null },
      ),
    },
  ]);

  test("the newest page: messages, where the events go on, ready", () => {
    expect(loaded.phase).toBe("ready");
    expect(loaded.name).toBe("Mattyčus");
    expect(loaded.messages.map((item) => item.message_id)).toEqual([
      "m-1",
      "m-2",
    ]);
    expect(loaded.eventId).toBe("e-10");
    expect(loaded.before).toBe("c-1");
    expect(statusKey(loaded)).toBe("online");
  });

  test("an older page goes before, without repeats", () => {
    const older = run(
      [
        { type: "older-loading" },
        {
          type: "older",
          page: page(
            [
              message("m-0", "user", "2026-10-19T07:00:00Z"),
              message("m-1", "assistant", "2026-10-20T07:00:00Z"),
            ],
            null,
            null,
          ),
        },
      ],
      loaded,
    );
    expect(older.messages.map((item) => item.message_id)).toEqual([
      "m-0",
      "m-1",
      "m-2",
    ]);
    expect(older.before).toBeNull();
    expect(older.olderLoading).toBe(false);
  });

  test("a sent message waits until the conversation lists it, by its client_id", () => {
    const pending = {
      client_id: "c-9",
      text: "Ahoj",
      attachments: [],
      status: "sending" as const,
      message_id: null,
      at: "2026-10-21T10:00:00Z",
    };
    const sent = run(
      [
        { type: "send", pending },
        { type: "sent", client_id: "c-9", message_id: "m-3" },
      ],
      loaded,
    );
    expect(sent.pending).toEqual([
      { ...pending, status: "sent", message_id: "m-3" },
    ]);
    const listed = run(
      [
        on("e-11", {
          type: "message.final",
          data: {
            ...message("m-3", "user", "2026-10-21T10:00:00Z", "Ahoj"),
            client_id: "c-9",
          },
        }),
      ],
      sent,
    );
    expect(listed.pending).toEqual([]);
    expect(listed.messages.at(-1)?.message_id).toBe("m-3");
    expect(listed.eventId).toBe("e-11");
    // The event may come before the answer to the request: nothing is left.
    const early = run(
      [
        { type: "send", pending },
        on("e-11", {
          type: "message.final",
          data: {
            ...message("m-3", "user", "2026-10-21T10:00:00Z", "Ahoj"),
            client_id: "c-9",
          },
        }),
        { type: "sent", client_id: "c-9", message_id: "m-3" },
      ],
      loaded,
    );
    expect(early.pending).toEqual([]);
    const failed = run(
      [
        { type: "send", pending },
        { type: "send-failed", client_id: "c-9" },
      ],
      loaded,
    );
    expect(failed.pending[0]?.status).toBe("failed");
    expect(failed.notice).toBe("sendFailed");
    expect(
      run([{ type: "retry", client_id: "c-9" }], failed).pending[0]?.status,
    ).toBe("sending");
  });

  test("an answer streams in pieces, shows its progress, and its final replaces them", () => {
    const working = run(
      [
        on("e-11", { type: "turn.started", data: { reply_to: "m-2" } }),
        on("e-12", { type: "progress", data: { text: "Čtu repozitář…" } }),
        on("e-13", {
          type: "message.delta",
          data: { message_id: "m-4", text: "Chybí " },
        }),
        on("e-14", {
          type: "message.delta",
          data: { message_id: "m-4", text: "proměnná." },
        }),
      ],
      loaded,
    );
    expect(working.streaming).toEqual({
      message_id: "m-4",
      text: "Chybí proměnná.",
    });
    expect(working.progress).toBe("Čtu repozitář…");
    expect(statusKey(working)).toBe("writing");
    const done = run(
      [
        on("e-15", {
          type: "message.final",
          data: {
            ...message(
              "m-4",
              "assistant",
              "2026-10-21T09:01:00Z",
              "Chybí proměnná.",
            ),
            client_id: null,
          },
        }),
        on("e-16", { type: "status", data: { state: "idle" } }),
      ],
      working,
    );
    expect(done.streaming).toBeNull();
    expect(done.progress).toBeNull();
    expect(done.messages.at(-1)?.text).toBe("Chybí proměnná.");
    expect(statusKey(done)).toBe("online");
  });

  test("a question waits for the person until it is answered or retired", () => {
    const clarify = {
      clarify_id: "q-1",
      question: "Publikovat?",
      choices: ["Ano", "Ne"],
      multi: false,
    };
    const asked = run(
      [on("e-11", { type: "clarify.request", data: clarify })],
      loaded,
    );
    expect(asked.clarify).toEqual(clarify);
    expect(statusKey(asked)).toBe("waiting");
    expect(
      run(
        [on("e-12", { type: "clarify.retired", data: { clarify_id: "q-2" } })],
        asked,
      ).clarify,
    ).toEqual(clarify);
    expect(
      run(
        [on("e-12", { type: "clarify.retired", data: { clarify_id: "q-1" } })],
        asked,
      ).clarify,
    ).toBeNull();
    expect(
      run([{ type: "clarify-done", clarify_id: "q-1" }], asked).clarify,
    ).toBeNull();
  });

  test("a failed turn says so and clears what it showed", () => {
    const failed = run(
      [
        on("e-11", {
          type: "message.delta",
          data: { message_id: "m-5", text: "Zač" },
        }),
        on("e-12", {
          type: "error",
          data: { code: "unavailable", message_id: "m-2" },
        }),
      ],
      loaded,
    );
    expect(failed.streaming).toBeNull();
    expect(failed.notice).toBe("turnUnavailable");
    expect(
      run(
        [on("e-13", { type: "turn.started", data: { reply_to: null } })],
        failed,
      ).notice,
    ).toBeNull();
  });

  test("only an event with an id of the contract is applied, and only it moves the cursor", () => {
    const status = (
      id: string | null,
      data = '{"state":"working"}',
      name = "status",
    ) => eventAction({ id, event: name, data });
    expect(status("e-11")).toEqual({
      type: "event",
      id: "e-11",
      event: { type: "status", data: { state: "working" } },
    });
    for (const defective of [
      status("invalid id"),
      status(""),
      status(null),
      status("e-12", "{not json"),
      status("e-12", '{"state":"busy"}'),
      status("e-12", '{"state":"working"}', "message.created"),
    ])
      expect(defective).toBeNull();
    // A stream with a defective event in the middle: the cursor is the last
    // good event's, so the next reconnect asks for a cursor the contract takes.
    const applied = (...actions: (FrameAction | null)[]) =>
      run(
        actions.filter((action): action is FrameAction => action !== null),
        loaded,
      );
    expect(
      applied(
        status("e-11"),
        status("bad id"),
        status("e-13", '{"state":"idle"}'),
      ).eventId,
    ).toBe("e-13");
    expect(applied(status("bad id")).eventId).toBe("e-10");
  });

  test("an event without its own id is dropped, and the reconnect replays the answer once", () => {
    // The stream of the adapter: "A" with its id, then "B" whose id line is
    // missing; the connection drops.
    const first = createSseReader().push(
      'id: e-11\nevent: message.delta\ndata: {"message_id":"m-4","text":"A"}\n\n' +
        'event: message.delta\ndata: {"message_id":"m-4","text":"B"}\n\n',
    );
    let state = loaded;
    for (const event of first) {
      const action = eventAction(event);
      if (action !== null) state = reduce(state, action);
    }
    expect(state.streaming).toEqual({ message_id: "m-4", text: "A" });
    expect(state.eventId).toBe("e-11");
    // The reconnect asks after e-11 and the adapter replays "B" with its id.
    const replay = createSseReader().push(
      'id: e-12\nevent: message.delta\ndata: {"message_id":"m-4","text":"B"}\n\n',
    );
    for (const event of replay) {
      const action = eventAction(event);
      if (action !== null) state = reduce(state, action);
    }
    expect(state.streaming).toEqual({ message_id: "m-4", text: "AB" });
    expect(state.eventId).toBe("e-12");
  });

  test("a turn that ends in an error leaves Buddy idle, or waiting for an open question", () => {
    const ended = run(
      [
        on("e-11", { type: "turn.started", data: { reply_to: "m-2" } }),
        on("e-12", {
          type: "error",
          data: { code: "turn-failed", message_id: "m-2" },
        }),
      ],
      loaded,
    );
    expect(ended.buddy).toBe("idle");
    expect(statusKey(ended)).toBe("online");
    const clarify = {
      clarify_id: "q-1",
      question: "Publikovat?",
      choices: ["Ano"],
      multi: false,
    };
    const asked = run(
      [
        on("e-11", { type: "clarify.request", data: clarify }),
        on("e-12", { type: "turn.started", data: { reply_to: null } }),
        on("e-13", {
          type: "error",
          data: { code: "internal", message_id: null },
        }),
      ],
      loaded,
    );
    expect(asked.buddy).toBe("waiting");
    expect(statusKey(asked)).toBe("waiting");
  });

  test("signed out, offline and back", () => {
    expect(run([{ type: "signed-out" }], loaded).phase).toBe("signed-out");
    expect(
      run([{ type: "signed-out" }, { type: "offline" }], loaded).phase,
    ).toBe("signed-out");
    const offline = run([{ type: "offline" }], loaded);
    expect(offline.phase).toBe("offline");
    expect(statusKey(offline)).toBe("unavailable");
    expect(canSend(offline, "Ahoj")).toBe(false);
    expect(run([{ type: "online" }], offline).phase).toBe("ready");
    // Never loaded: back online is still loading, not ready.
    expect(run([{ type: "offline" }, { type: "online" }]).phase).toBe(
      "offline",
    );
  });

  test("attachments within their bounds", () => {
    const file = (id: string, size: number) => ({
      id,
      name: `${id}.bin`,
      mime: "application/octet-stream",
      size,
      preview: null,
    });
    const MiB = 1024 * 1024;
    expect(
      run([{ type: "attach", attachment: file("a", 5 * MiB + 1) }], loaded)
        .notice,
    ).toBe("tooLarge");
    // An empty file is refused when it is picked: nothing to send, nothing to retry.
    const empty = run([{ type: "attach", attachment: file("a", 0) }], loaded);
    expect(empty.notice).toBe("emptyFile");
    expect(empty.attachments).toEqual([]);
    expect(canSend(empty, "")).toBe(false);
    const three = run(
      [
        { type: "attach", attachment: file("a", 4 * MiB) },
        { type: "attach", attachment: file("b", 4 * MiB) },
        { type: "attach", attachment: file("c", 4 * MiB) },
      ],
      loaded,
    );
    expect(three.attachments.map((item) => item.id)).toEqual(["a", "b"]);
    expect(three.notice).toBe("tooMuch");
    const four = run(
      ["a", "b", "c", "d", "e"].map((id) => ({
        type: "attach" as const,
        attachment: file(id, 1),
      })),
      loaded,
    );
    expect(four.attachments).toHaveLength(4);
    expect(four.notice).toBe("tooMany");
    expect(
      canSend(run([{ type: "attach", attachment: file("a", 1) }], loaded), " "),
    ).toBe(true);
    expect(canSend(loaded, "  ")).toBe(false);
    expect(
      run([{ type: "detach", id: "a" }], three).attachments.map(
        (item) => item.id,
      ),
    ).toEqual(["b"]);
  });

  test("the context chip comes from the host and can be taken off", () => {
    const host: HostContext = {
      lang: "cs",
      theme: "light",
      context: {
        environment: { id: "vm-01.acme", kind: "work", name: "vm-01" },
        organization: { slug: "acme", name: "Acme" },
        app: "apps",
        page: { path: "/" },
        guide: null,
      },
    };
    const withHost = run([{ type: "context", host }], loaded);
    expect(withHost.host).toEqual(host);
    expect(withHost.withContext).toBe(true);
    expect(
      run([{ type: "context-toggle", on: false }], withHost).withContext,
    ).toBe(false);
    expect(contextLine(host.context, "cs")).toBe(
      "Pracovní Prostředí vm-01 · Acme · Apps",
    );
    expect(contextLine(host.context, "en")).toBe(
      "Work Environment vm-01 · Acme · Apps",
    );
    expect(
      contextLine(
        {
          environment: {
            id: "jana",
            kind: "personal",
            name: "Osobní Prostředí",
          },
          organization: null,
          app: "chat",
          page: { path: "/" },
          guide: null,
        },
        "cs",
      ),
    ).toBe("Osobní Prostředí · Chat");
  });

  test("the thread: a separator per day, the channel of a message from elsewhere, the stream last", () => {
    const now = new Date(2026, 9, 21, 12, 0);
    const local = (day: number, hour: number) =>
      new Date(2026, 9, day, hour, 0).toISOString();
    const state = run([
      {
        type: "history",
        page: page(
          [
            { ...message("m-1", "user", local(19, 9)), via: "telegram" },
            message("m-2", "assistant", local(20, 9)),
            message("m-3", "user", local(21, 9)),
          ],
          null,
          { event_id: "e-1", state: "working", clarify: null },
        ),
      },
      on("e-2", {
        type: "message.delta",
        data: { message_id: "m-4", text: "Hned" },
      }),
    ]);
    const rows = threadRows(state, now, "cs");
    expect(rows.map((row) => row.kind)).toEqual([
      "day",
      "message",
      "day",
      "message",
      "day",
      "message",
      "streaming",
    ]);
    expect(
      rows
        .filter((row) => row.kind === "day")
        .map((row) => (row.kind === "day" ? row.label : "")),
    ).toEqual(["19. října", "Včera", "Dnes"]);
    expect(rows[1]?.kind === "message" ? rows[1].channel : null).toBe(
      "Telegram",
    );
    expect(rows[3]?.kind === "message" ? rows[3].channel : "x").toBeNull();
    expect(dayLabel(local(21, 1), now, "en")).toBe("Today");
    expect(dayLabel(new Date(2025, 11, 31, 9).toISOString(), now, "en")).toBe(
      "31 December 2025",
    );
    expect(channelName("whatsapp")).toBe("WhatsApp");
    expect(channelName("lazurio_web")).toBeNull();
  });

  test("the browser's language before the host says one", () => {
    expect(browserLang(["cs-CZ", "en"])).toBe("cs");
    expect(browserLang(["en-GB"])).toBe("en");
  });
});

describe("Buddy's Markdown, never HTML", () => {
  test("paragraphs, lists, code, emphasis and safe links", () => {
    expect(
      readMarkdown(
        "Ahoj **světe**,\nřádek dva.\n\n- jedna\n- dvě\n\n```\nkód <b>\n```",
      ),
    ).toEqual([
      {
        kind: "paragraph",
        lines: [
          [
            { kind: "text", text: "Ahoj " },
            { kind: "strong", children: [{ kind: "text", text: "světe" }] },
            { kind: "text", text: "," },
          ],
          [{ kind: "text", text: "řádek dva." }],
        ],
      },
      {
        kind: "list",
        ordered: false,
        items: [
          [{ kind: "text", text: "jedna" }],
          [{ kind: "text", text: "dvě" }],
        ],
      },
      { kind: "code", text: "kód <b>" },
    ]);
    expect(readInline("viz [docs](https://lazurio.io/docs) a `kód`")).toEqual([
      { kind: "text", text: "viz " },
      {
        kind: "link",
        href: "https://lazurio.io/docs",
        children: [{ kind: "text", text: "docs" }],
      },
      { kind: "text", text: " a " },
      { kind: "code", text: "kód" },
    ]);
    expect(readInline("Na https://lazurio.io.")).toEqual([
      { kind: "text", text: "Na " },
      {
        kind: "link",
        href: "https://lazurio.io/",
        children: [{ kind: "text", text: "https://lazurio.io" }],
      },
      { kind: "text", text: "." },
    ]);
    expect(readInline("snake_case_name zůstává")).toEqual([
      { kind: "text", text: "snake_case_name zůstává" },
    ]);
    expect(readInline("*důraz*")).toEqual([
      { kind: "em", children: [{ kind: "text", text: "důraz" }] },
    ]);
  });

  test("a link elsewhere than http, https or mailto stays text", () => {
    expect(readInline("[klik](javascript:alert(1))")).toEqual([
      { kind: "text", text: "klik" },
      { kind: "text", text: ")" },
    ]);
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("data:text/html,x")).toBeNull();
    expect(safeHref("mailto:jana@example.com")).toBe("mailto:jana@example.com");
  });
});
