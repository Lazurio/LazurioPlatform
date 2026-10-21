import { shellFonts } from "../../../shell/fonts";
import {
  type Attachment,
  type ClarifyAnswer,
  checkHistoryPage,
  checkMessageAccepted,
  createSseReader,
  isFileName,
  isMimeType,
  type MessageRequest,
  type PageContext,
} from "../../contract/runtime";
import { hostOriginAtLoad, signInUrl } from "../hosts";
import { browserLang } from "./copy";
import {
  acceptContext,
  type Lang,
  type Layout,
  layoutMessage,
  readyMessage,
} from "./host";
import {
  type DraftAttachment,
  eventAction,
  type FrameAction,
  type FrameState,
  initialState,
  type Pending,
  reduce,
} from "./state";
import { createView } from "./view";

// Buddy's chat in the frame: the effects around the pure state (state.ts)
// and the view (view.ts). It reads the newest page of the conversation, then
// the events after its snapshot, reconnecting as the stream ends (the server
// closes it within 110 s, so each reconnect passes the gateway's admission
// again). A 401 or a redirect from the gateway means the session ended: the
// frame offers „Přihlásit“, a popup to the gateway's sign-in, and reloads
// once the popup lands on `/signed-in`.

const frameOrigin = location.origin;
const framed = window.parent !== window;
const ancestors = location.ancestorOrigins
  ? [...location.ancestorOrigins]
  : null;
const hostOrigin = hostOriginAtLoad(
  frameOrigin,
  framed,
  ancestors,
  document.referrer,
  new URLSearchParams(location.search).get("host"),
);

/** The frame loads again, signed in: it names its host, because its own
 * document sends no referrer (`frameAncestors`). */
const reloadFrame = () =>
  location.replace(
    hostOrigin === null ? "/" : `/?host=${encodeURIComponent(hostOrigin)}`,
  );

let state: FrameState = initialState;
let lang: Lang = browserLang(navigator.languages ?? [navigator.language]);
document.documentElement.lang = lang;

// The brand fonts, the shell's own faces (src/shell/fonts.ts), from this
// origin's `/fonts/`: declared here, so the bundler does not inline them
// into the stylesheet and the browser keeps them; each loads when used.
for (const font of shellFonts)
  document.fonts.add(
    new FontFace(font.family, `url("/fonts/${font.file}") format("woff2")`, {
      weight: font.weight,
      unicodeRange: font.range,
      display: "swap",
    }),
  );

/** Full screen is the host's to draw; the frame knows it by its width. */
const fullscreen = () => framed && window.innerWidth >= 560;

const post = (message: unknown) => {
  if (hostOrigin !== null) window.parent.postMessage(message, hostOrigin);
};

let scheduled = false;
function dispatch(action: FrameAction) {
  state = reduce(state, action);
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    view.render(state, lang, new Date());
  });
}

// The host's messages are heard before anything else runs.
let signInWindow: Window | null = null;
window.addEventListener("message", (event) => {
  if (
    event.origin === frameOrigin &&
    event.source === signInWindow &&
    (event.data as { type?: unknown } | null)?.type ===
      "lazurio.buddy.signed-in"
  ) {
    reloadFrame();
    return;
  }
  const accepted = acceptContext(
    {
      data: event.data,
      origin: event.origin,
      fromParent: framed && event.source === window.parent,
    },
    frameOrigin,
    hostOrigin,
  );
  if (accepted === null) return;
  lang = accepted.lang;
  document.documentElement.lang = lang;
  document.documentElement.dataset.theme = accepted.theme;
  dispatch({ type: "context", host: accepted });
});

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** The stream's wait before it tries again, which „Zkusit znovu“ cuts
 * short. */
let wake: (() => void) | null = null;
const backoffWait = (ms: number) =>
  new Promise<void>((done) => {
    const timer = setTimeout(() => {
      wake = null;
      done();
    }, ms);
    wake = () => {
      clearTimeout(timer);
      wake = null;
      done();
    };
  });

type Answer =
  | Readonly<{ kind: "ok"; status: number; body: unknown }>
  | Readonly<{ kind: "signed-out" }>
  | Readonly<{ kind: "failed"; status: number }>;

/** A call of the frame's API: the gateway's refusal (401, or a redirect
 * toward its sign-in) is a signed-out answer, never followed. */
async function call(path: string, init: RequestInit = {}): Promise<Answer> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      cache: "no-store",
      redirect: "manual",
      headers: { accept: "application/json", ...init.headers },
    });
  } catch {
    return { kind: "failed", status: 0 };
  }
  if (response.type === "opaqueredirect" || response.status === 401)
    return { kind: "signed-out" };
  if (!response.ok) return { kind: "failed", status: response.status };
  try {
    return { kind: "ok", status: response.status, body: await response.json() };
  } catch {
    return { kind: "failed", status: response.status };
  }
}

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

async function loadNewest(): Promise<boolean> {
  const answer = await call("/api/v1/history?limit=30");
  if (answer.kind === "signed-out") {
    dispatch({ type: "signed-out" });
    return false;
  }
  const page =
    answer.kind === "ok" ? checkHistoryPage(answer.body, true) : null;
  if (page === null || !page.ok) {
    dispatch({ type: "offline" });
    return false;
  }
  dispatch({ type: "history", page: page.value });
  return true;
}

async function loadOlder() {
  if (state.before === null || state.olderLoading) return;
  dispatch({ type: "older-loading" });
  const answer = await call(
    `/api/v1/history?before=${encodeURIComponent(state.before)}&limit=30`,
  );
  const page =
    answer.kind === "ok" ? checkHistoryPage(answer.body, false) : null;
  if (page?.ok) dispatch({ type: "older", page: page.value });
  else if (answer.kind === "signed-out") dispatch({ type: "signed-out" });
  else
    dispatch({
      type: "older",
      page: { messages: [], before: state.before, snapshot: null },
    });
}

let streaming = false;
async function stream() {
  if (streaming) return;
  streaming = true;
  let backoff = 1000;
  try {
    while (state.phase !== "signed-out" && state.phase !== "signing-in") {
      const after = state.eventId;
      let response: Response;
      try {
        response = await fetch(
          `/api/v1/events${after === null ? "" : `?after=${encodeURIComponent(after)}`}`,
          {
            cache: "no-store",
            redirect: "manual",
            headers: { accept: "text/event-stream" },
          },
        );
      } catch {
        dispatch({ type: "offline" });
        await backoffWait(backoff);
        backoff = Math.min(backoff * 2, 15_000);
        continue;
      }
      if (response.type === "opaqueredirect" || response.status === 401) {
        dispatch({ type: "signed-out" });
        return;
      }
      if (response.status === 409) {
        // The outbox no longer holds where the frame was: read the newest
        // page again and go on from its snapshot.
        await response.body?.cancel();
        if (!(await loadNewest())) await backoffWait(backoff);
        continue;
      }
      if (!response.ok || response.body === null) {
        await response.body?.cancel();
        dispatch({ type: "offline" });
        await backoffWait(backoff);
        backoff = Math.min(backoff * 2, 15_000);
        continue;
      }
      backoff = 1000;
      dispatch({ type: "online" });
      const reader = createSseReader();
      const decoder = new TextDecoder();
      const body = response.body.getReader();
      try {
        for (;;) {
          const { done, value } = await body.read();
          if (done) break;
          for (const event of reader.push(
            decoder.decode(value, { stream: true }),
          )) {
            const action = eventAction(event);
            if (action !== null) dispatch(action);
          }
        }
      } catch {
        // Cut off: go on from the last event read.
      }
      await sleep(250);
    }
  } finally {
    streaming = false;
  }
}

async function boot() {
  const persona = await call("/api/persona");
  if (persona.kind === "signed-out") {
    dispatch({ type: "signed-out" });
    return;
  }
  if (persona.kind !== "ok") {
    dispatch({ type: "offline" });
    return;
  }
  const name = (persona.body as { name?: unknown } | null)?.name;
  if (typeof name === "string" && name !== "")
    dispatch({ type: "persona", name });
  if (await loadNewest()) void stream();
}

// ---- Sending ----------------------------------------------------------------------

const files = new Map<string, File>();
const outbox = new Map<
  string,
  Readonly<{
    text: string;
    files: readonly File[];
    context: PageContext | null;
  }>
>();

function base64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      resolve(url.slice(url.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function fileName(name: string): string {
  const clean = [...name]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 0x20 ||
        code === 0x7f ||
        character === "/" ||
        character === "\\"
        ? "_"
        : character;
    })
    .slice(0, 255)
    .join("")
    .trim();
  return isFileName(clean) ? clean : "soubor";
}

async function deliver(clientId: string) {
  const message = outbox.get(clientId);
  if (message === undefined) return;
  let attachments: Attachment[];
  try {
    attachments = await Promise.all(
      message.files.map(async (file) => ({
        name: fileName(file.name),
        mime: isMimeType(file.type) ? file.type : "application/octet-stream",
        data_base64: await base64(file),
      })),
    );
  } catch {
    dispatch({ type: "send-failed", client_id: clientId });
    return;
  }
  const body: MessageRequest = {
    client_id: clientId,
    text: message.text,
    attachments,
    context: message.context,
  };
  const answer = await call("/api/v1/messages", json(body));
  if (answer.kind === "signed-out") {
    dispatch({ type: "send-failed", client_id: clientId });
    dispatch({ type: "signed-out" });
    return;
  }
  const accepted =
    answer.kind === "ok" ? checkMessageAccepted(answer.body) : null;
  if (accepted?.ok) {
    outbox.delete(clientId);
    dispatch({
      type: "sent",
      client_id: clientId,
      message_id: accepted.value.message_id,
    });
  } else dispatch({ type: "send-failed", client_id: clientId });
}

function send(text: string) {
  const clientId = crypto.randomUUID();
  const picked = state.attachments;
  outbox.set(clientId, {
    text,
    files: picked.flatMap((item) => {
      const file = files.get(item.id);
      return file === undefined ? [] : [file];
    }),
    context: state.withContext ? (state.host?.context ?? null) : null,
  });
  for (const item of picked) files.delete(item.id);
  const pending: Pending = {
    client_id: clientId,
    text,
    attachments: picked,
    status: "sending",
    message_id: null,
    at: new Date().toISOString(),
  };
  dispatch({ type: "send", pending });
  void deliver(clientId);
}

function pick(chosen: readonly File[]) {
  for (const file of chosen) {
    const id = crypto.randomUUID();
    const image = /^image\/(?:png|jpeg|gif|webp)$/.test(file.type);
    const attachment: DraftAttachment = {
      id,
      name: fileName(file.name),
      mime: file.type,
      size: file.size,
      preview: image ? URL.createObjectURL(file) : null,
    };
    const before = state.attachments.length;
    dispatch({ type: "attach", attachment });
    if (state.attachments.length > before) files.set(id, file);
    else if (attachment.preview !== null)
      URL.revokeObjectURL(attachment.preview);
  }
}

async function answer(clarifyId: string, reply: ClarifyAnswer) {
  const result = await call(
    `/api/v1/clarify/${encodeURIComponent(clarifyId)}`,
    json(reply),
  );
  if (result.kind === "signed-out") dispatch({ type: "signed-out" });
  else if (
    result.kind === "ok" ||
    result.status === 404 ||
    result.status === 409
  )
    dispatch({ type: "clarify-done", clarify_id: clarifyId });
}

// ---- Signing in ---------------------------------------------------------------------

function signIn() {
  signInWindow = window.open(
    signInUrl(frameOrigin),
    "lazurio-buddy-sign-in",
    "popup,width=480,height=640",
  );
  dispatch({ type: "signing-in" });
  let channel: BroadcastChannel | null = null;
  try {
    channel = new BroadcastChannel("lazurio-buddy");
    channel.onmessage = (event) => {
      if (
        (event.data as { type?: unknown } | null)?.type ===
        "lazurio.buddy.signed-in"
      )
        reloadFrame();
    };
  } catch {
    channel = null;
  }
  // The issuer may cut the popup's tie to this frame: ask for the session
  // every two seconds, for two minutes at most.
  const started = Date.now();
  const poll = async () => {
    if (Date.now() - started > 120_000) {
      channel?.close();
      dispatch({ type: "signed-out" });
      return;
    }
    const answer = await call("/api/persona");
    if (answer.kind === "ok") {
      reloadFrame();
      return;
    }
    setTimeout(poll, 2000);
  };
  setTimeout(poll, 2000);
}

const view = createView(
  document.getElementById("buddy") ?? document.body,
  {
    send,
    stop: () => void call("/api/v1/stop", json({})),
    layout: (mode: Layout) => post(layoutMessage(mode)),
    contextToggle: (on) => dispatch({ type: "context-toggle", on }),
    pick,
    detach: (id) => {
      const item = state.attachments.find((entry) => entry.id === id);
      if (item?.preview) URL.revokeObjectURL(item.preview);
      files.delete(id);
      dispatch({ type: "detach", id });
    },
    answer: (clarifyId, reply) => void answer(clarifyId, reply),
    older: () => void loadOlder(),
    signIn,
    retry: () => {
      if (wake !== null) wake();
      else if (state.loaded) void stream();
      else void boot();
    },
    resend: (clientId) => {
      dispatch({ type: "retry", client_id: clientId });
      void deliver(clientId);
    },
  },
  framed,
  fullscreen,
);

window.addEventListener("resize", () => view.render(state, lang, new Date()));
view.render(state, lang, new Date());
post(readyMessage());
void boot();
