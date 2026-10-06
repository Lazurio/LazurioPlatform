import { expect, test } from "bun:test";
import {
  browserEntryOf,
  browserViewUrl,
  resolveBrowserView,
} from "../src/browser/view";
import {
  type BrowserPanelState,
  browserHandOverPath,
  browserPanelOrigin,
  browserPanelView,
  browserViewAddress,
  browserViewDocumentPath,
  readBrowserView,
} from "../src/launchpad/browser-panel-view";
import { publicEntry } from "../src/launchpad/chat";
import { parseEntryAnswer } from "../src/launchpad/chat-view";
import { messages } from "../src/launchpad/messages";
import {
  browserViewDocumentPath as serverDocumentPath,
  browserViewPath as serverHandOverPath,
} from "../src/launchpad/server";
import { bindings } from "./fixtures/machine-bindings";

// The Launchpad's right panel (decision F38's addendum of 2026-10-05, root
// decision 0191 points 8a and 18, #207): offered only where the recorded entry
// routes the Environment browser's view, never on a workstation or in
// Recovery mode; it asks this origin for the view without a session, which is
// the people's view of a new remote tab (decision F39), and embeds it only on
// exactly the recorded origin. The DOM (browser-panel.ts) only draws this.

const origin = "https://browser.workspace.example.lazurio.io";
const page = "https://launchpad.workspace.example.lazurio.io";
const target = "0123456789ABCDEF".repeat(2);
const view = browserViewUrl(origin, null);

// The page's view of the recorded entry, as the server projects it and the
// page parses `GET /api/entry`.
const entryOf = (binding: { entry?: Parameters<typeof publicEntry>[0] }) =>
  parseEntryAnswer({
    kind: "entry",
    entry: publicEntry(binding.entry ?? null),
  });

test("offered only where the recorded entry routes the view: never on a workstation, without the browser's route, or in Recovery mode", () => {
  const withView = entryOf(bindings.organizationBrowser);
  expect(withView?.browserOrigin).toBe(origin);
  expect(browserPanelOrigin(withView, false)).toBe(origin);
  // The personal and the Team Environment the same way.
  expect(browserPanelOrigin(entryOf(bindings.personalBrowser), false)).toBe(
    "https://browser.example.lazurio.io",
  );
  expect(browserPanelOrigin(entryOf(bindings.teamBrowser), false)).toBe(origin);
  // An entry whose gateway routes no view, a workstation (no entry), and
  // Recovery mode.
  const withoutView = entryOf(bindings.organizationEntry);
  expect(withoutView).not.toBeNull();
  expect(browserPanelOrigin(withoutView, false)).toBeNull();
  expect(
    browserPanelOrigin(parseEntryAnswer({ kind: "entry", entry: null }), false),
  ).toBeNull();
  expect(browserPanelOrigin(withView, true)).toBeNull();
  // An entry whose browser origin is not an https origin is no entry at all.
  expect(
    parseEntryAnswer({
      kind: "entry",
      entry: {
        ...withView,
        browserOrigin: "http://browser.example.lazurio.io",
      },
    }),
  ).toBeNull();
});

test("the view only as an https URL on exactly the recorded origin, as written: the server's own answers pass, nothing else does", async () => {
  // What the server answers for the panel (no session: a new tab) and for a
  // thread's link (a session's tab): both are the view.
  expect(browserViewAddress({ available: true, view }, origin, page)).toBe(
    view,
  );
  const windowView = browserViewUrl(origin, target);
  expect(
    browserViewAddress(
      { available: true, view: windowView, session: "t3-a" },
      origin,
      page,
    ),
  ).toBe(windowView);
  // The server's resolution itself, from the fixture's recorded entry.
  const entry = browserEntryOf(bindings.organizationBrowser.entry);
  const answer = await resolveBrowserView(entry, null, {
    openWindow: async () => ({ targetId: target }),
  });
  expect(browserViewAddress(answer, origin, page)).toBe(view);

  for (const refused of [
    null,
    "view",
    [view],
    {},
    { available: false, reason: "not-declared" },
    { available: "true", view },
    { available: true },
    { available: true, view: 42 },
    { available: true, view: "/.lazurio/browser" },
    { available: true, view: "javascript:alert(1)" },
    // Not https, another origin, a sibling app, a port, credentials.
    { available: true, view: view.replace("https:", "http:") },
    { available: true, view: "https://elsewhere.example/" },
    { available: true, view: `${page}/` },
    { available: true, view: view.replace(origin, `${origin}:8443`) },
    { available: true, view: view.replace("https://", "https://user:secret@") },
    // Not as written: the browser would read another address.
    { available: true, view: view.replace("browser.", "BROWSER.") },
    { available: true, view: ` ${view}` },
  ])
    expect(browserViewAddress(refused, origin, page)).toBeNull();
  // Never a frame on the page's own origin, even where it is recorded so:
  // the sandbox keeps the view apart only while it is another origin.
  expect(
    browserViewAddress({ available: true, view }, origin, origin),
  ).toBeNull();
});

type Call = Readonly<{ input: string; init: RequestInit }>;
function fetcher(answer: () => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetch = async (input: string, init: RequestInit) => {
    calls.push({ input, init });
    return answer();
  };
  return { calls, fetch };
}

test("the read: this origin's answer for every window, with the session cookie only, no cache and no redirect followed; every failure says so", async () => {
  // The page and the server name the same two routes.
  expect(browserViewDocumentPath).toBe(serverDocumentPath);
  expect(browserHandOverPath).toBe(serverHandOverPath);

  const ok = fetcher(() =>
    Response.json({ available: true, view, session: null }),
  );
  expect(await readBrowserView(origin, page, ok.fetch)).toEqual({
    kind: "view",
    view,
  });
  expect(ok.calls).toHaveLength(1);
  const [call] = ok.calls;
  // No session: a new remote tab. No token or other header: the
  // gateway's session cookie is the credential, sent by the browser itself.
  expect(call?.input).toBe("/.lazurio/browser.json");
  expect(call?.init).toMatchObject({
    cache: "no-store",
    credentials: "same-origin",
    redirect: "error",
  });
  expect(call?.init.headers).toBeUndefined();
  expect(call?.init.signal).toBeInstanceOf(AbortSignal);

  // The Environment says it has no view right now.
  for (const reason of ["view-unavailable", "not-declared"])
    expect(
      await readBrowserView(
        origin,
        page,
        fetcher(() => Response.json({ available: false, reason })).fetch,
      ),
    ).toEqual({ kind: "unavailable" });
  // No answer the panel can use: a refusal or an expired session, a closing
  // Launchpad, a page instead of JSON, a view elsewhere, a redirect the read
  // refuses to follow, a network failure.
  for (const answer of [
    () => Response.json({ error: "denied" }, { status: 401 }),
    () => Response.json({ error: "closing" }, { status: 503 }),
    () => new Response("<!doctype html><title>Sign in</title>"),
    () =>
      Response.json({
        available: true,
        view: "https://elsewhere.example/",
      }),
    () => {
      throw new TypeError("Failed to fetch: redirect mode is set to error");
    },
  ])
    expect(await readBrowserView(origin, page, fetcher(answer).fetch)).toEqual({
      kind: "failed",
    });
  // An answer that does not come is given up.
  const hanging = (_input: string, init: RequestInit) =>
    new Promise<Response>((_resolve, reject) =>
      init.signal?.addEventListener("abort", () =>
        reject(new DOMException("The operation was aborted.", "AbortError")),
      ),
    );
  expect(await readBrowserView(origin, page, hanging, 5)).toEqual({
    kind: "failed",
  });
});

test("what the open panel draws: one sentence until the view is known, then the frame; its link is the view only once known, else the hand-over", () => {
  for (const locale of ["en", "cs"] as const) {
    const copy = messages(locale);
    const cases: readonly [
      BrowserPanelState,
      ReturnType<typeof browserPanelView>,
    ][] = [
      [
        { kind: "loading" },
        { frame: null, message: copy.browserLoading, tab: "/.lazurio/browser" },
      ],
      [
        { kind: "view", view },
        { frame: view, message: null, tab: view },
      ],
      [
        { kind: "unavailable" },
        {
          frame: null,
          message: copy.browserUnavailable,
          tab: "/.lazurio/browser",
        },
      ],
      [
        { kind: "failed" },
        { frame: null, message: copy.browserFailed, tab: "/.lazurio/browser" },
      ],
    ];
    for (const [state, drawn] of cases)
      expect(browserPanelView(state, copy)).toEqual(drawn);
    // Each state its own sentence, in both languages.
    expect(
      new Set([
        copy.browserLoading,
        copy.browserUnavailable,
        copy.browserFailed,
      ]).size,
    ).toBe(3);
  }
});
