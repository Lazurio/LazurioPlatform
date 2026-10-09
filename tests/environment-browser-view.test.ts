import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CdpConnection, CdpEvent } from "../src/browser/people/cdp";
import {
  browserExtensionFiles,
  writeBrowserExtension,
} from "../src/browser/people/extension";
import {
  BrowserHub,
  jpegSize,
  navigableAddress,
  type Viewer,
} from "../src/browser/people/hub";
import {
  identityIcon,
  identityLabel,
  viewIdentity,
} from "../src/browser/people/identity";
import {
  type ClientMessage,
  decodeFrame,
  type ServerMessage,
} from "../src/browser/people/protocol";
import { parseServeArgs } from "../src/browser/people/serve";
import {
  appShellOrigin,
  classifyRequest,
  frameAncestors,
  pageHeaders,
  startViewService,
  type ViewService,
} from "../src/browser/people/service";

// The people's view of the Environment browser (decision F39) against a
// scripted DevTools peer: no Chrome runs, every call is recorded and
// answered the way Chrome answers it.

const origin = "https://browser.pilot.example.lazurio.io";
const host = new URL(origin).host;

// The smallest bytes `jpegSize` reads: SOI and a baseline SOF0 of 3×2.
const jpeg = Buffer.from([
  0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x02, 0x00, 0x03, 0x03, 0x01,
  0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9,
]);

type Call = {
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
};
type Target = {
  targetId: string;
  url: string;
  title: string;
  openerId?: string;
  canAccessOpener?: boolean;
};

const id = (n: number) => n.toString(16).toUpperCase().padStart(32, "0");

/** A browser target that answers like Chrome for what the hub asks. */
class FakeBrowser {
  readonly targets = new Map<string, Target>();
  readonly calls: Call[] = [];
  private listeners: ((event: CdpEvent) => void)[] = [];
  private closers: (() => void)[] = [];
  private next = 100;
  connections = 0;
  open = false;
  /** What the page's selection and title read as. */
  selection = "";
  /** Holds the next selection read until it is opened (ordering tests). */
  gate: Promise<void> | null = null;
  pageTitle = "Stránka z dokumentu";

  constructor(initial: Target[] = []) {
    for (const target of initial) this.targets.set(target.targetId, target);
  }

  connect = async (): Promise<CdpConnection> => {
    this.connections++;
    this.open = true;
    this.listeners = [];
    this.closers = [];
    return {
      send: async (method, params = {}, sessionId) => {
        if (!this.open) throw new Error("closed");
        const expression = String(
          (params as { expression?: unknown }).expression,
        );
        if (
          method === "Runtime.evaluate" &&
          expression.includes("getSelection") &&
          this.gate !== null
        ) {
          // The page's answer is what it was when the read was asked.
          const answer = this.selection;
          await this.gate;
          this.calls.push({
            method,
            params: { ...params },
            ...(sessionId === undefined ? {} : { sessionId }),
          });
          return { result: { value: answer } };
        }
        this.calls.push({
          method,
          params: { ...params },
          ...(sessionId === undefined ? {} : { sessionId }),
        });
        return this.answer(
          method,
          params as Record<string, unknown>,
          sessionId,
        );
      },
      onEvent: (listener) => {
        this.listeners.push(listener);
      },
      onClose: (listener) => {
        this.closers.push(listener);
      },
      close: () => this.drop(),
    };
  };

  drop(): void {
    if (!this.open) return;
    this.open = false;
    for (const closer of this.closers.splice(0)) closer();
  }

  emit(method: string, params: Record<string, unknown>, sessionId?: string) {
    for (const listener of this.listeners)
      listener({ method, params, ...(sessionId ? { sessionId } : {}) });
  }

  created(target: Target): void {
    this.targets.set(target.targetId, target);
    this.emit("Target.targetCreated", {
      targetInfo: { type: "page", attached: false, ...target },
    });
  }

  called(method: string): Call[] {
    return this.calls.filter((call) => call.method === method);
  }

  private answer(
    method: string,
    params: Record<string, unknown>,
    sessionId?: string,
  ): Record<string, unknown> {
    switch (method) {
      case "Target.setDiscoverTargets":
        for (const target of this.targets.values())
          this.emit("Target.targetCreated", {
            targetInfo: { type: "page", attached: false, ...target },
          });
        return {};
      case "Target.attachToTarget":
        return { sessionId: `S-${params.targetId}` };
      case "Target.createTarget": {
        const targetId = id(this.next++);
        queueMicrotask(() =>
          this.created({ targetId, url: String(params.url), title: "" }),
        );
        return { targetId };
      }
      case "Target.closeTarget":
        this.targets.delete(String(params.targetId));
        queueMicrotask(() =>
          this.emit("Target.targetDestroyed", { targetId: params.targetId }),
        );
        return { success: true };
      case "Page.getFrameTree":
        return { frameTree: { frame: { id: `F-${sessionId}` } } };
      case "Page.getNavigationHistory":
        return { currentIndex: 1, entries: [{ id: 1 }, { id: 2 }, { id: 3 }] };
      case "Page.captureScreenshot":
        return { data: jpeg.toString("base64") };
      case "Page.getLayoutMetrics":
        return {
          cssVisualViewport: { clientWidth: 1280, clientHeight: 800 },
          cssLayoutViewport: { clientWidth: 1280, clientHeight: 800 },
        };
      case "Browser.getWindowForTarget":
        return { windowId: 7, bounds: { width: 1280, height: 885 } };
      case "Page.createIsolatedWorld":
        return { executionContextId: 3 };
      case "Runtime.evaluate":
        return {
          result: {
            value: String(params.expression).includes("getSelection")
              ? this.selection
              : JSON.stringify({
                  title: this.pageTitle,
                  icon: "https://example.com/favicon.ico",
                }),
          },
        };
      default:
        return {};
    }
  }
}

const settle = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await settle(5);
  }
}

let root: string | undefined;
let service: ViewService | undefined;
afterEach(async () => {
  await service?.stop();
  service = undefined;
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

async function serve(
  browser: FakeBrowser,
  options: { bound?: string[]; graceMs?: number; reconnectMs?: number } = {},
) {
  root = await realpath(await mkdtemp(join(tmpdir(), "people-view-")));
  const logs: string[] = [];
  service = startViewService({
    origin,
    port: 0,
    log: (line) => logs.push(line),
    hub: {
      connect: browser.connect,
      boundTargets: async () => new Set(options.bound ?? []),
      uploadDirectory: join(root, "uploads"),
      screen: { width: 1920, height: 1080 },
      log: (line) => logs.push(line),
      graceMs: options.graceMs ?? 60_000,
      unviewedGraceMs: options.graceMs ?? 60_000,
      reconnectMs: options.reconnectMs ?? 20,
    },
  });
  await until(() => service?.hub.connected === true);
  const base = `http://127.0.0.1:${service.server.port}`;
  return { base, logs, root };
}

/** A person's socket, as the view page opens it. */
async function person(
  base: string,
  targetId: string,
  headers = { Host: host, Origin: origin },
) {
  const messages: (
    | ServerMessage
    | { frame: ReturnType<typeof decodeFrame> }
  )[] = [];
  const socket = new WebSocket(
    `${base.replace("http", "ws")}/t/${targetId}/live`,
    {
      // Bun's client sends these as given, as the gateway forwards them.
      headers,
    } as unknown as string[],
  );
  socket.binaryType = "arraybuffer";
  socket.addEventListener("message", (event) => {
    if (typeof event.data === "string")
      messages.push(JSON.parse(event.data) as ServerMessage);
    else messages.push({ frame: decodeFrame(event.data as ArrayBuffer) });
  });
  const closed = new Promise<void>((resolve) =>
    socket.addEventListener("close", () => resolve()),
  );
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve());
    socket.addEventListener("error", () => reject(new Error("socket error")));
  });
  const send = (message: ClientMessage) => socket.send(JSON.stringify(message));
  const of = <K extends ServerMessage["t"]>(t: K) =>
    messages.filter(
      (m): m is Extract<ServerMessage, { t: K }> => "t" in m && m.t === t,
    );
  return { socket, messages, send, of, closed };
}

const tab = (n: number, extra: Partial<Target> = {}): Target => ({
  targetId: id(n),
  url: "https://example.com/",
  title: "Example",
  ...extra,
});

// ---- Admission (F39 point 8) -------------------------------------------------

test("every request must name the view's host; sockets and changes must come from its origin", () => {
  const ask = (
    method: string,
    path: string,
    headers: {
      host?: string | null;
      origin?: string | null;
      upgrade?: boolean;
    },
  ) =>
    classifyRequest(
      {
        method,
        url: `http://127.0.0.1:4848${path}`,
        host: headers.host === undefined ? host : headers.host,
        origin: headers.origin ?? null,
        upgrade: headers.upgrade ?? false,
      },
      origin,
      4848,
    );
  const live = `/t/${id(1)}/live`;
  expect(ask("GET", "/", {})).toEqual({ kind: "page" });
  expect(ask("GET", `/t/${id(1)}`, {})).toEqual({ kind: "page" });
  expect(ask("GET", "/assets/view.js", {})).toEqual({ kind: "script" });
  expect(ask("GET", "/", { host: "evil.example" }).kind).toBe("refused");
  // DNS rebinding names another host.
  expect(
    ask("GET", live, { host: "127.0.0.1:4848", upgrade: true, origin }),
  ).toEqual({
    kind: "refused",
    status: 421,
    error: "wrong-host",
  });
  expect(ask("GET", live, { upgrade: true, origin })).toEqual({
    kind: "live",
    targetId: id(1),
  });
  // Another app of the same site is same-site but not this origin.
  for (const other of [
    null,
    "https://t3code.pilot.example.lazurio.io",
    "https://browser.other.example.lazurio.io",
  ])
    expect(ask("GET", live, { upgrade: true, origin: other })).toEqual({
      kind: "refused",
      status: 403,
      error: "wrong-origin",
    });
  expect(ask("POST", "/api/tabs", { origin })).toEqual({ kind: "create" });
  expect(
    ask("POST", "/api/tabs", { origin: "https://evil.example" }).kind,
  ).toBe("refused");
  expect(ask("GET", "/api/tabs", { origin }).kind).toBe("refused");
  expect(ask("POST", `/t/${id(1)}/files`, {}).kind).toBe("refused");
  expect(ask("POST", "/", { origin }).kind).toBe("refused");
  expect(ask("GET", "/json/version", {}).kind).toBe("refused");
  // Doctor asks the health on loopback.
  expect(ask("GET", "/.lazurio/health", { host: "127.0.0.1:4848" })).toEqual({
    kind: "health",
  });
  expect(ask("GET", "/.lazurio/health", { host: "evil.example" }).kind).toBe(
    "refused",
  );
});

test("only the Environment's own origins may frame the view", () => {
  expect(frameAncestors(origin)).toBe(
    "'self' https://*.pilot.example.lazurio.io",
  );
  expect(frameAncestors("https://browser.someone.lazurio.io")).toBe(
    "'self' https://*.someone.lazurio.io",
  );
  expect(frameAncestors("http://localhost:4848")).toBe("'self'");
  const csp = pageHeaders(origin)["content-security-policy"] ?? "";
  expect(csp).toContain("script-src 'self'");
  expect(csp).toContain(`connect-src 'self' wss://${host}`);
  expect(csp).toContain(
    "frame-ancestors 'self' https://*.pilot.example.lazurio.io",
  );
});

// Root decision 0191, addendum of 2026-10-09: T3 Code or the Launchpad of
// another Environment may frame the view when it asks for the page; any other
// page may not, and the gateway's sign-in still decides who sees it.
test("a requesting T3 Code or Launchpad of another Environment may frame the view, nothing else", () => {
  const siblings = "'self' https://*.pilot.example.lazurio.io";
  for (const referer of [
    "https://t3code.someone.lazurio.io/abc/def",
    "https://launchpad.jana.acme.lazurio.io/",
  ])
    expect(frameAncestors(origin, referer)).toBe(
      `${siblings} ${new URL(referer).origin}`,
    );
  for (const referer of [
    undefined,
    null,
    "",
    "not an address",
    "https://evil.someone.lazurio.io/",
    "https://app.jana.acme.lazurio.io/",
    "http://t3code.someone.lazurio.io/",
    "https://t3code.someone.lazurio.io:8443/",
    "https://t3code.lazurio.io.evil.example/",
    "https://t3code.evil.example/",
    // An app of this Environment is a sibling already.
    "https://t3code.pilot.example.lazurio.io/",
  ])
    expect(frameAncestors(origin, referer)).toBe(siblings);
  expect(appShellOrigin("https://T3CODE.Someone.lazurio.io/x")).toBe(
    "https://t3code.someone.lazurio.io",
  );
  expect(
    pageHeaders(origin, "https://t3code.someone.lazurio.io/")[
      "content-security-policy"
    ],
  ).toContain(`frame-ancestors ${siblings} https://t3code.someone.lazurio.io`);
});

test("the view names its Environment from its own address", () => {
  expect(viewIdentity("browser.jana.acme.lazurio.io")).toEqual({
    kind: "organization",
    organization: "acme",
    environment: "jana",
  });
  expect(viewIdentity("browser.someone.lazurio.io")).toEqual({
    kind: "personal",
    login: "someone",
  });
  for (const hostname of [
    "localhost",
    "127.0.0.1",
    "t3code.jana.acme.lazurio.io",
    "browser.lazurio.io",
    "browser.a.b.acme.lazurio.io",
    "browser.jana.acme.example.com",
    "browser.-bad.acme.lazurio.io",
  ])
    expect(viewIdentity(hostname)).toBeNull();
  const work = viewIdentity("browser.jana.acme.lazurio.io");
  const personal = viewIdentity("browser.someone.lazurio.io");
  if (work === null || personal === null) throw new Error("no identity");
  expect(identityLabel(work, true)).toBe("Acme · jana");
  expect(identityLabel(work, false)).toBe("Acme · jana");
  expect(identityLabel(personal, true)).toBe("Osobní · someone");
  expect(identityLabel(personal, false)).toBe("Personal · someone");
  expect(identityIcon(work)).toBe("https://github.com/acme.png?size=40");
  expect(identityIcon(personal)).toBe("https://github.com/someone.png?size=40");
});

test("the page names the app that asks for it as the one that may frame it, end to end", async () => {
  const browser = new FakeBrowser([tab(1)]);
  const { base } = await serve(browser);
  const asked = await fetch(`${base}/t/${id(1)}`, {
    headers: { Host: host, Referer: "https://t3code.someone.lazurio.io/" },
  });
  expect(asked.headers.get("content-security-policy")).toContain(
    "frame-ancestors 'self' https://*.pilot.example.lazurio.io https://t3code.someone.lazurio.io",
  );
  const other = await fetch(`${base}/t/${id(1)}`, {
    headers: { Host: host, Referer: "https://evil.someone.lazurio.io/" },
  });
  const otherPolicy = other.headers.get("content-security-policy") ?? "";
  expect(otherPolicy).toEndWith(
    "frame-ancestors 'self' https://*.pilot.example.lazurio.io",
  );
  expect(otherPolicy).not.toContain("evil");
});

test("the service refuses another host and a socket from another origin end to end", async () => {
  const browser = new FakeBrowser([tab(1)]);
  const { base } = await serve(browser);
  const wrongHost = await fetch(`${base}/`, {
    headers: { Host: "evil.example" },
  });
  expect(wrongHost.status).toBe(421);
  const page = await fetch(`${base}/t/${id(1)}`, { headers: { Host: host } });
  expect(page.status).toBe(200);
  expect(page.headers.get("content-security-policy")).toContain(
    "frame-ancestors",
  );
  const health = await fetch(`${base}/.lazurio/health`);
  expect(await health.json()).toEqual({ ok: true, browser: "connected" });
  await expect(
    person(base, id(1), {
      Host: host,
      Origin: "https://t3code.pilot.example.lazurio.io",
    }),
  ).rejects.toThrow();
});

// ---- Tabs (F39 points 1 and 2) -----------------------------------------------

test("a person's new tab is a new window of the default context at the person's size", async () => {
  const browser = new FakeBrowser();
  const { base } = await serve(browser);
  const created = await fetch(`${base}/api/tabs`, {
    method: "POST",
    headers: { Host: host, Origin: origin, "content-type": "application/json" },
    body: JSON.stringify({ width: 900, height: 600, dpr: 2 }),
  });
  expect(created.status).toBe(201);
  const body = (await created.json()) as { id: string; view: string };
  expect(body.view).toBe(`/t/${body.id}`);
  expect(browser.called("Target.createTarget")[0]?.params).toEqual({
    url: "about:blank",
    newWindow: true,
    width: 900,
    height: 600,
  });
  expect(service?.hub.hasTab(body.id)).toBe(true);
});

test("a viewer gets the tab's state, frames at its size, and Chrome is acked", async () => {
  const browser = new FakeBrowser([tab(1)]);
  const { base } = await serve(browser);
  const view = await person(base, id(1));
  await until(() => view.of("info").length > 0);
  expect(view.of("browser")[0]).toEqual({ t: "browser", state: "connected" });
  view.send({ t: "hello", width: 700, height: 500, dpr: 2, resize: true });
  await until(() => browser.called("Page.startScreencast").length > 0);
  expect(browser.called("Page.startScreencast")[0]?.params).toMatchObject({
    format: "jpeg",
    maxWidth: 1400,
    maxHeight: 1000,
  });
  browser.emit(
    "Page.screencastFrame",
    {
      data: jpeg.toString("base64"),
      sessionId: 5,
      metadata: {
        deviceWidth: 700,
        deviceHeight: 500,
        offsetTop: 0,
        pageScaleFactor: 1,
      },
    },
    `S-${id(1)}`,
  );
  await until(() => browser.called("Page.screencastFrameAck").length > 0);
  expect(browser.called("Page.screencastFrameAck")[0]?.params).toEqual({
    sessionId: 5,
  });
  const frames = () =>
    view.messages.flatMap((m) => ("frame" in m && m.frame ? [m.frame] : []));
  // The frame reaches the person after Chrome is acked.
  await until(() => frames().some((f) => f.header.deviceWidth === 700));
  const last = frames().at(-1);
  expect(last?.header).toEqual({
    width: 3,
    height: 2,
    deviceWidth: 700,
    deviceHeight: 500,
    offsetTop: 0,
    pageScaleFactor: 1,
  });
  // F39 point 3: the window takes the person's page area plus Chrome's bars.
  await until(() => browser.called("Browser.setWindowBounds").length > 0);
  expect(browser.called("Browser.setWindowBounds")[0]?.params).toEqual({
    windowId: 7,
    bounds: { width: 700, height: 585 },
  });
  // Every page has its dialogs and file choosers kept in the view.
  expect(
    browser
      .called("Page.setInterceptFileChooserDialog")
      .map((c) => c.sessionId),
  ).toContain(`S-${id(1)}`);
  view.socket.close();
});

test("the title and icon come from the page itself, since Chrome reports a target's title only as its address", async () => {
  const browser = new FakeBrowser([
    tab(1, { url: "https://example.com/", title: "example.com/" }),
  ]);
  const { base } = await serve(browser);
  const view = await person(base, id(1));
  await until(() =>
    view.of("info").some((m) => m.title === "Stránka z dokumentu"),
  );
  expect(view.of("info").at(-1)).toMatchObject({
    url: "https://example.com/",
    title: "Stránka z dokumentu",
    favicon: "https://example.com/favicon.ico",
    canGoBack: true,
    canGoForward: true,
  });
  // A later change of the page's title follows while someone views it.
  browser.pageTitle = "(1) Nová zpráva";
  await until(
    () => view.of("info").some((m) => m.title === "(1) Nová zpráva"),
    4_000,
  );
  view.socket.close();
});

// ---- Input (F39 points 5 and 6) ----------------------------------------------

test("keys keep their codes, paste inserts text, the mouse lands where it was sent", async () => {
  const browser = new FakeBrowser([tab(1)]);
  const { base } = await serve(browser);
  const view = await person(base, id(1));
  await until(() => view.of("info").length > 0);
  view.send({
    t: "key",
    type: "keyDown",
    key: ".",
    code: "Period",
    keyCode: 190,
    text: ".",
    modifiers: 0,
    location: 0,
    repeat: false,
  });
  view.send({
    t: "key",
    type: "keyDown",
    key: "a",
    code: "KeyA",
    keyCode: 65,
    modifiers: 2,
    location: 0,
    repeat: false,
  });
  view.send({ t: "text", text: "heslo z mé schránky" });
  view.send({
    t: "mouse",
    type: "mousePressed",
    x: 120.5,
    y: 80,
    button: "left",
    buttons: 1,
    clickCount: 1,
    modifiers: 0,
  });
  await until(() => browser.called("Input.dispatchMouseEvent").length > 0);
  const keys = browser.called("Input.dispatchKeyEvent").map((c) => c.params);
  expect(keys[0]).toMatchObject({
    type: "keyDown",
    key: ".",
    code: "Period",
    windowsVirtualKeyCode: 190,
    text: ".",
  });
  expect(keys[1]).toMatchObject({ type: "rawKeyDown", key: "a", modifiers: 2 });
  expect(keys[1]?.text).toBeUndefined();
  expect(browser.called("Input.insertText")[0]?.params).toEqual({
    text: "heslo z mé schránky",
  });
  expect(browser.called("Input.dispatchMouseEvent")[0]?.params).toMatchObject({
    type: "mousePressed",
    x: 120.5,
    y: 80,
    button: "left",
  });
  // Co-control (F39 point 5): nothing locks the agent out.
  expect(
    browser.calls.some((c) => /lock|Emulation.setTouch/.test(c.method)),
  ).toBe(false);
  view.socket.close();
});

test("the address bar navigates only to web addresses", async () => {
  expect(navigableAddress("https://example.com/a")).toBe(
    "https://example.com/a",
  );
  expect(navigableAddress("about:blank")).toBe("about:blank");
  expect(navigableAddress("javascript:alert(1)")).toBeNull();
  expect(navigableAddress("file:///etc/passwd")).toBeNull();
  expect(navigableAddress("chrome://settings")).toBeNull();
  const browser = new FakeBrowser([tab(1)]);
  const { base } = await serve(browser);
  const view = await person(base, id(1));
  await until(() => view.of("info").length > 0);
  view.send({ t: "goto", url: "javascript:alert(1)" });
  view.send({ t: "goto", url: "https://example.org/" });
  view.send({ t: "nav", action: "back" });
  await until(() => browser.called("Page.navigateToHistoryEntry").length > 0);
  expect(browser.called("Page.navigate").map((c) => c.params.url)).toEqual([
    "https://example.org/",
  ]);
  expect(browser.called("Page.navigateToHistoryEntry")[0]?.params).toEqual({
    entryId: 1,
  });
  view.socket.close();
});

test("the remote selection reaches the person for copy and cut, read when it may have changed", async () => {
  const browser = new FakeBrowser([tab(1)]);
  const { base } = await serve(browser);
  const view = await person(base, id(1));
  await until(() => view.of("info").length > 0);
  browser.selection = "zkopírovaný text";
  // A drag that ends selects; the release is when the selection is read.
  view.send({
    t: "mouse",
    type: "mouseReleased",
    x: 10,
    y: 10,
    button: "left",
    buttons: 0,
    clickCount: 1,
    modifiers: 0,
  });
  await until(() => view.of("selection").length > 0);
  expect(view.of("selection")[0]).toEqual({
    t: "selection",
    text: "zkopírovaný text",
  });
  // Ctrl (or ⌘) pressed, just before a copy, reads it again.
  browser.selection = "jiný výběr";
  view.send({
    t: "key",
    type: "keyDown",
    key: "Control",
    code: "ControlLeft",
    keyCode: 17,
    modifiers: 2,
    location: 1,
    repeat: false,
  });
  await until(() =>
    view.of("selection").some((message) => message.text === "jiný výběr"),
  );
  // A navigation clears it: a copy must not take the old page's text.
  browser.emit(
    "Page.frameNavigated",
    { frame: { id: `F-S-${id(1)}`, url: "https://example.org/" } },
    `S-${id(1)}`,
  );
  await until(() => view.of("selection").at(-1)?.text === "");
  // Read in the view's isolated world; the Runtime domain is never enabled,
  // which pages could detect as automation.
  expect(browser.called("Page.createIsolatedWorld")[0]?.params).toMatchObject({
    worldName: "lazurio-view",
  });
  expect(browser.called("Runtime.enable")).toHaveLength(0);
  expect(browser.called("Runtime.addBinding")).toHaveLength(0);
  view.socket.close();
});

test("a selection read that a navigation overtook is dropped: a copy never takes the previous document's text", async () => {
  const browser = new FakeBrowser([tab(1)]);
  const { base } = await serve(browser);
  const view = await person(base, id(1));
  await until(() => view.of("info").length > 0);
  browser.selection = "OLD-DOCUMENT-SECRET";
  let open = () => {};
  browser.gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  view.send({
    t: "mouse",
    type: "mouseReleased",
    x: 10,
    y: 10,
    button: "left",
    buttons: 0,
    clickCount: 1,
    modifiers: 0,
  });
  await until(() =>
    browser.calls.some((c) => c.method === "Page.createIsolatedWorld"),
  );
  await settle(80);
  // The page navigates while the read is still out; then the old answer
  // comes back.
  browser.emit(
    "Page.frameNavigated",
    { frame: { id: `F-S-${id(1)}`, url: "https://example.org/next" } },
    `S-${id(1)}`,
  );
  await settle(30);
  browser.gate = null;
  open();
  await settle(150);
  expect(
    view.of("selection").some((m) => m.text === "OLD-DOCUMENT-SECRET"),
  ).toBe(false);
  view.socket.close();
});

// ---- Pop-ups and new tabs (F39 point 4) --------------------------------------

test("a page that can reach its opener is a pop-up; one that cannot is a new tab", async () => {
  const browser = new FakeBrowser([tab(1)]);
  const { base } = await serve(browser);
  const view = await person(base, id(1));
  await until(() => view.of("info").length > 0);
  browser.created(
    tab(2, {
      url: "https://accounts.google.com/o/oauth2",
      openerId: id(1),
      canAccessOpener: true,
    }),
  );
  browser.created(
    tab(3, {
      url: "https://example.com/doc",
      openerId: id(1),
      canAccessOpener: false,
    }),
  );
  browser.created(tab(4, { openerId: id(9), canAccessOpener: true }));
  await until(
    () => view.of("popup").length > 0 && view.of("new-tab").length > 0,
  );
  expect(view.of("popup")).toEqual([
    { t: "popup", id: id(2), url: "https://accounts.google.com/o/oauth2" },
  ]);
  expect(view.of("new-tab")).toEqual([
    { t: "new-tab", id: id(3), url: "https://example.com/doc" },
  ]);
  view.socket.close();
});

// ---- Nothing outside the page blocks the view (F39 point 7) ------------------

test("a page's dialog is answered from the view", async () => {
  const browser = new FakeBrowser([tab(1)]);
  const { base } = await serve(browser);
  const view = await person(base, id(1));
  await until(() => view.of("info").length > 0);
  browser.emit(
    "Page.javascriptDialogOpening",
    { type: "prompt", message: "Jméno?", defaultPrompt: "Matěj" },
    `S-${id(1)}`,
  );
  await until(() => view.of("dialog").length > 0);
  expect(view.of("dialog")[0]).toEqual({
    t: "dialog",
    kind: "prompt",
    message: "Jméno?",
    defaultPrompt: "Matěj",
  });
  view.send({ t: "dialog", accept: true, text: "Anička" });
  await until(() => browser.called("Page.handleJavaScriptDialog").length > 0);
  expect(browser.called("Page.handleJavaScriptDialog")[0]?.params).toEqual({
    accept: true,
    promptText: "Anička",
  });
  view.socket.close();
});

test("a file chooser is answered with the person's files; without a viewer it is dropped", async () => {
  const browser = new FakeBrowser([tab(1), tab(2)]);
  const { base, logs } = await serve(browser);
  const view = await person(base, id(1));
  await until(() => view.of("info").length > 0);
  browser.emit(
    "Page.fileChooserOpened",
    { frameId: "F", mode: "selectSingle", backendNodeId: 42 },
    `S-${id(1)}`,
  );
  await until(() => view.of("files").length > 0);
  const { token, multiple } = view.of("files")[0] as {
    token: string;
    multiple: boolean;
  };
  expect(multiple).toBe(false);
  const form = new FormData();
  form.append("file", new File(["obsah faktury"], "faktura ../x.pdf"));
  const refused = await fetch(`${base}/t/${id(1)}/files?token=${token}`, {
    method: "POST",
    headers: { Host: host },
    body: form,
  });
  expect(refused.status).toBe(403);
  const uploaded = await fetch(`${base}/t/${id(1)}/files?token=${token}`, {
    method: "POST",
    headers: { Host: host, Origin: origin },
    body: form,
  });
  expect(uploaded.status).toBe(204);
  const set = browser.called("DOM.setFileInputFiles")[0];
  if (set === undefined) throw new Error("no setFileInputFiles");
  expect(set.params.backendNodeId).toBe(42);
  const [path] = set.params.files as string[];
  // Only the base name survives, so a name cannot leave the upload folder.
  expect(path?.endsWith("/0/x.pdf")).toBe(true);
  expect(await readFile(path as string, "utf8")).toBe("obsah faktury");
  await until(() => view.of("files-closed").length > 0);
  // The token is single-use.
  const again = await fetch(`${base}/t/${id(1)}/files?token=${token}`, {
    method: "POST",
    headers: { Host: host, Origin: origin },
    body: form,
  });
  expect(again.status).toBe(409);
  browser.emit(
    "Page.fileChooserOpened",
    { frameId: "F", mode: "selectSingle", backendNodeId: 43 },
    `S-${id(2)}`,
  );
  await settle();
  expect(
    logs.some((line) => line.includes("file chooser") && line.includes(id(2))),
  ).toBe(true);
  view.socket.close();
});

// ---- Closing (F39 point 9) ---------------------------------------------------

test("a closed person's tab closes its own remote tab after the grace, unless an agent is bound to it", async () => {
  const browser = new FakeBrowser([tab(1)]);
  const { base } = await serve(browser, { graceMs: 60, bound: [] });
  const make = async () => {
    const response = await fetch(`${base}/api/tabs`, {
      method: "POST",
      headers: {
        Host: host,
        Origin: origin,
        "content-type": "application/json",
      },
      body: "{}",
    });
    return ((await response.json()) as { id: string }).id;
  };
  const own = await make();
  const view = await person(base, own);
  await until(() => view.of("info").length > 0);
  view.socket.close();
  await until(() =>
    browser.called("Target.closeTarget").some((c) => c.params.targetId === own),
  );
  // An agent's tab the view did not open is never closed by it.
  const agent = await person(base, id(1));
  await until(() => agent.of("info").length > 0);
  agent.socket.close();
  await settle(150);
  expect(
    browser
      .called("Target.closeTarget")
      .some((c) => c.params.targetId === id(1)),
  ).toBe(false);
});

test("an own tab an agent bound itself to stays open; an own tab nobody opened closes", async () => {
  const browser = new FakeBrowser();
  // The fake's first two new tabs are id(100) and id(101); an agent-browser
  // session is bound to the first.
  const { base } = await serve(browser, { graceMs: 40, bound: [id(100)] });
  const make = async () => {
    const response = await fetch(`${base}/api/tabs`, {
      method: "POST",
      headers: {
        Host: host,
        Origin: origin,
        "content-type": "application/json",
      },
      body: "{}",
    });
    return ((await response.json()) as { id: string }).id;
  };
  const bound = await make();
  expect(bound).toBe(id(100));
  const view = await person(base, bound);
  await until(() => view.of("info").length > 0);
  view.socket.close();
  const unopened = await make();
  await until(() =>
    browser
      .called("Target.closeTarget")
      .some((c) => c.params.targetId === unopened),
  );
  await settle(100);
  expect(
    browser
      .called("Target.closeTarget")
      .some((c) => c.params.targetId === bound),
  ).toBe(false);
});

test("a tab a page opened closes when nobody views it, unless an agent is bound to it; the agent's own tab stays", async () => {
  // id(1) is an agent's window (not opened by the view); its page opens two
  // tabs, and an agent-browser session is bound to the second.
  const browser = new FakeBrowser([tab(1)]);
  await serve(browser, { graceMs: 40, bound: [id(3)] });
  browser.created(
    tab(2, {
      url: "https://example.com/a",
      openerId: id(1),
      canAccessOpener: false,
    }),
  );
  browser.created(
    tab(3, {
      url: "https://example.com/b",
      openerId: id(1),
      canAccessOpener: false,
    }),
  );
  await until(() =>
    browser
      .called("Target.closeTarget")
      .some((c) => c.params.targetId === id(2)),
  );
  await settle(120);
  const closed = browser
    .called("Target.closeTarget")
    .map((c) => c.params.targetId);
  expect(closed).not.toContain(id(3));
  expect(closed).not.toContain(id(1));
});

test("a tab that goes away tells its viewers", async () => {
  const browser = new FakeBrowser([tab(1)]);
  const { base } = await serve(browser);
  const view = await person(base, id(1));
  await until(() => view.of("info").length > 0);
  browser.emit("Target.targetDestroyed", { targetId: id(1) });
  await view.closed;
  expect(view.of("closed")).toEqual([{ t: "closed" }]);
  // A tab that no longer exists, opened again (a reload after a browser
  // restart): told so, not left reconnecting.
  const stale = await person(base, id(77));
  await stale.closed;
  expect(stale.of("closed")).toEqual([{ t: "closed" }]);
});

test("while the browser is away, a new socket is told to try again, never that its tab is gone", async () => {
  const browser = new FakeBrowser([tab(1)]);
  const { base } = await serve(browser, { reconnectMs: 60_000 });
  browser.drop();
  await until(() => service?.hub.connected === false);
  const view = await person(base, id(1));
  await view.closed;
  expect(view.of("browser")).toEqual([{ t: "browser", state: "reconnecting" }]);
  expect(view.of("closed")).toEqual([]);
});

test("a lost browser connection is reported and the view resumes on its tab", async () => {
  const browser = new FakeBrowser([tab(1)]);
  const { base } = await serve(browser);
  const view = await person(base, id(1));
  await until(() => view.of("info").length > 0);
  browser.drop();
  await until(() => view.of("browser").some((m) => m.state === "reconnecting"));
  await until(
    () => browser.connections >= 2 && service?.hub.connected === true,
  );
  await until(
    () => view.of("browser").filter((m) => m.state === "connected").length >= 2,
  );
  expect(
    browser
      .called("Target.attachToTarget")
      .filter((c) => c.params.targetId === id(1)).length,
  ).toBeGreaterThanOrEqual(2);
  view.socket.close();
});

// ---- Flow control ------------------------------------------------------------

test("a slow viewer holds Chrome's next frame instead of the service's memory", async () => {
  const browser = new FakeBrowser([tab(1)]);
  const hub = new BrowserHub({
    connect: browser.connect,
    boundTargets: async () => new Set(),
    uploadDirectory: tmpdir(),
    screen: { width: 1920, height: 1080 },
    log: () => {},
    reconnectMs: 20,
  });
  hub.start();
  await until(() => hub.connected);
  let backlog = 2 << 20;
  const viewer: Viewer = {
    send: () => {},
    sendFrame: () => {},
    buffered: () => backlog,
    close: () => {},
    size: null,
    resize: true,
  };
  await until(() => hub.attach(id(1), viewer));
  await hub.handle(id(1), viewer, {
    t: "hello",
    width: 800,
    height: 600,
    dpr: 1,
    resize: false,
  });
  await until(() => browser.called("Page.startScreencast").length > 0);
  browser.emit(
    "Page.screencastFrame",
    {
      data: jpeg.toString("base64"),
      sessionId: 9,
      metadata: { deviceWidth: 800, deviceHeight: 600 },
    },
    `S-${id(1)}`,
  );
  await settle();
  expect(browser.called("Page.screencastFrameAck")).toHaveLength(0);
  backlog = 0;
  hub.drained(id(1));
  await until(() => browser.called("Page.screencastFrameAck").length === 1);
  // A pop-up viewer (resize false) never resizes its window.
  expect(browser.called("Browser.setWindowBounds")).toHaveLength(0);
  hub.stop();
});

test("jpegSize reads a frame's size and refuses other bytes", () => {
  expect(jpegSize(jpeg)).toEqual({ width: 3, height: 2 });
  expect(jpegSize(Buffer.from("not a jpeg"))).toBeNull();
});

// ---- The extension (F39 point 7) ---------------------------------------------

test("the extension declines passkeys and leaves other credentials alone", async () => {
  const original: string[] = [];
  class CredentialsContainer {
    get(options: unknown) {
      original.push(`get ${JSON.stringify(options)}`);
      return Promise.resolve("password-credential");
    }
    create(options: unknown) {
      original.push(`create ${JSON.stringify(options)}`);
      return Promise.resolve("created");
    }
  }
  const PublicKeyCredential = {
    isUserVerifyingPlatformAuthenticatorAvailable: () => Promise.resolve(true),
    isConditionalMediationAvailable: () => Promise.resolve(true),
  };
  const scope = { CredentialsContainer, PublicKeyCredential, DOMException };
  new Function(
    "globalThis",
    "DOMException",
    browserExtensionFiles["webauthn.js"] as string,
  )(scope, DOMException);
  const container = new CredentialsContainer();
  const declined = await container
    .get({ publicKey: { challenge: new Uint8Array(1) } })
    .catch((error: DOMException) => error.name);
  expect(declined).toBe("NotAllowedError");
  expect(
    await container
      .create({ publicKey: {} })
      .catch((error: DOMException) => error.name),
  ).toBe("NotAllowedError");
  expect(await container.get({ password: true })).toBe("password-credential");
  expect(original).toEqual(['get {"password":true}']);
  expect(
    await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable(),
  ).toBe(false);
  expect(await PublicKeyCredential.isConditionalMediationAvailable()).toBe(
    false,
  );
});

test("the extension turns Chrome's own context menu off even when the page stops the event, and the page's own menu still opens", () => {
  // A small model of DOM dispatch on one target under the window: capture
  // listeners of the window first, then the target's, then the window's
  // bubbling listeners unless propagation was stopped.
  const windowCapture: ((event: Event) => void)[] = [];
  const windowBubble: ((event: Event) => void)[] = [];
  const window = {
    addEventListener: (
      type: string,
      listener: (event: Event) => void,
      capture?: boolean,
    ) => {
      if (type !== "contextmenu") return;
      (capture === true ? windowCapture : windowBubble).push(listener);
    },
  };
  new Function("window", browserExtensionFiles["menu.js"] as string)(window);
  let pageMenu = 0;
  const pageHandler = (event: Event) => {
    pageMenu += 1;
    event.stopPropagation();
  };
  const event = new Event("contextmenu", { bubbles: true, cancelable: true });
  let stopped = false;
  const stop = event.stopPropagation.bind(event);
  event.stopPropagation = () => {
    stopped = true;
    stop();
  };
  for (const listener of windowCapture) listener(event);
  pageHandler(event);
  if (!stopped) for (const listener of windowBubble) listener(event);
  expect(windowCapture).toHaveLength(1);
  expect(windowBubble).toHaveLength(0);
  expect(pageMenu).toBe(1);
  expect(event.defaultPrevented).toBe(true);
});

test("the extension moves a second tab of a window into a window of its own", async () => {
  const moved: unknown[] = [];
  let listener:
    | ((tab: { id?: number; windowId?: number }) => Promise<void>)
    | undefined;
  const windows = new Map([
    [1, { type: "normal", tabs: 2 }],
    [2, { type: "popup", tabs: 2 }],
    [3, { type: "normal", tabs: 1 }],
  ]);
  const chrome = {
    tabs: {
      onCreated: { addListener: (fn: typeof listener) => (listener = fn) },
      query: async ({ windowId }: { windowId: number }) =>
        Array.from({ length: windows.get(windowId)?.tabs ?? 0 }),
    },
    windows: {
      get: async (windowId: number) => windows.get(windowId),
      create: async (options: unknown) => moved.push(options),
    },
  };
  new Function("chrome", browserExtensionFiles["background.js"] as string)(
    chrome,
  );
  await listener?.({ id: 10, windowId: 1 });
  await listener?.({ id: 11, windowId: 2 });
  await listener?.({ id: 12, windowId: 3 });
  expect(moved).toEqual([{ tabId: 10, focused: false }]);
});

test("the extension is written next to the profile and only when it differs", async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "extension-")));
  expect(await writeBrowserExtension(root)).toBe(true);
  expect(await writeBrowserExtension(root)).toBe(false);
  const manifest = JSON.parse(
    await readFile(
      join(root, ".local/share/lazurio-browser/extension/manifest.json"),
      "utf8",
    ),
  ) as {
    permissions?: unknown;
    content_scripts: { js: string[]; world?: string; run_at: string }[];
  };
  // No permission at all, and the passkey script runs before the page.
  expect(manifest.permissions).toBeUndefined();
  expect(manifest.content_scripts[0]).toMatchObject({
    js: ["webauthn.js"],
    world: "MAIN",
    run_at: "document_start",
  });
  // The menu script runs in the extension's own world, at the start too.
  expect(manifest.content_scripts[1]).toMatchObject({
    js: ["menu.js"],
    run_at: "document_start",
  });
  expect(manifest.content_scripts[1]?.world).toBeUndefined();
});

test("serve takes exactly a loopback port and an origin", () => {
  expect(parseServeArgs(["--port", "4848", "--origin", origin])).toEqual({
    port: 4848,
    origin,
  });
  expect(
    parseServeArgs(["--port", "4848", "--origin", `${origin}/`]),
  ).toBeNull();
  expect(parseServeArgs(["--port", "0", "--origin", origin])).toBeNull();
  expect(parseServeArgs(["--port", "4848"])).toBeNull();
  expect(parseServeArgs(["--port", "4848", "--origin", "ftp://x"])).toBeNull();
  expect(
    parseServeArgs(["extra", "--port", "4848", "--origin", origin]),
  ).toBeNull();
});
