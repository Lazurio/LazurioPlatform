import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Hold,
  type Holds,
  holdsReader,
  noHolds,
} from "../src/browser/contract/node";
import type { TabFacts } from "../src/browser/contract/platform";
import {
  appShellOrigin,
  viewFrameAncestors as frameAncestors,
  navigableAddress,
} from "../src/browser/contract/pure";
import type { CdpConnection, CdpEvent } from "../src/browser/people/cdp";
import {
  browserExtensionFiles,
  writeBrowserExtension,
} from "../src/browser/people/extension";
import {
  BrowserHub,
  type HubSeams,
  jpegSize,
  pictureFrames,
  screencastFor,
  type Viewer,
} from "../src/browser/people/hub";
import {
  type ClientMessage,
  decodeFrame,
  type ServerMessage,
} from "../src/browser/people/protocol";
import { parseServeArgs } from "../src/browser/people/serve";
import {
  classifyRequest,
  pageHeaders,
  startViewService,
  type ViewService,
} from "../src/browser/people/service";
import {
  closeTab,
  listTabs,
  openTab,
  restoreTab,
} from "../src/launchpad/new-tab/hub-client";
import {
  parseEmbeddedIdentity,
  viewIdentityElementId,
} from "../src/shell/identity-protocol";
import type { EnvironmentIdentity } from "../src/shell/view";

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
const firstWindow = id(0xb1a4c);
const testBoot = "6f2c1d0e-1a2b-4c3d-8e4f-5a6b7c8d9e0f";
const blankWindow = { targetId: firstWindow, url: "about:blank", title: "" };

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
  /** What `Runtime.getHeapUsage` answers in each tab's session: its heap,
   * an error, or nothing ever; 1 MB of 2 MB unless named. */
  readonly heaps = new Map<
    string,
    { usedSize: number; totalSize: number } | "fail" | "hang"
  >();
  /** When each `Runtime.getHeapUsage` was asked (`performance.now()`). */
  readonly heapAskedAt: number[] = [];
  /** Decision F57: how many milliseconds ago each tab's page last had input
   * (none unless named), the tabs whose focused field has unsaved input,
   * and those whose `beforeunload` objects to closing. */
  readonly inputAgo = new Map<string, number>();
  readonly unsaved = new Set<string>();
  readonly beforeUnload = new Set<string>();
  /** The browser's own id, as its socket's address names it; a new one
   * stands for a restarted browser. */
  browserId: string | undefined = undefined;

  /** Chrome's first window (the unit starts it with `about:blank`), which
   * the hub keeps as its own blank window unless `blank` is false. */
  constructor(initial: Target[] = [], blank = true) {
    if (blank) this.targets.set(firstWindow, { ...blankWindow });
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
        if (method === "Runtime.getHeapUsage") {
          this.heapAskedAt.push(performance.now());
          this.calls.push({
            method,
            params: { ...params },
            ...(sessionId === undefined ? {} : { sessionId }),
          });
          const heap = this.heaps.get(String(sessionId).slice("S-".length));
          if (heap === "hang") return new Promise(() => {});
          if (heap === "fail") throw new Error(`${method}: Target closed`);
          return heap ?? { usedSize: 1_000_000, totalSize: 2_000_000 };
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
      ...(this.browserId === undefined ? {} : { browser: this.browserId }),
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
      case "Target.getTargets":
        return {
          targetInfos: [...this.targets.values()].map((target) => ({
            type: "page",
            attached: false,
            ...target,
          })),
        };
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
      case "Page.close": {
        // As Chrome: the page's `beforeunload` may object, else it closes.
        const target = String(sessionId).slice("S-".length);
        if (this.beforeUnload.has(target))
          queueMicrotask(() =>
            this.emit(
              "Page.javascriptDialogOpening",
              { type: "beforeunload", message: "", url: "" },
              sessionId,
            ),
          );
        else {
          this.targets.delete(target);
          queueMicrotask(() =>
            this.emit("Target.targetDestroyed", { targetId: target }),
          );
        }
        return {};
      }
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
      case "Runtime.evaluate": {
        const target = String(sessionId).slice("S-".length);
        const expression = String(params.expression);
        if (expression.includes("__lazurioActivity"))
          return { result: { value: this.inputAgo.get(target) ?? null } };
        if (expression.includes("defaultValue"))
          return { result: { value: this.unsaved.has(target) } };
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
      }
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

type HoldsState = {
  /** Targets an agent works in (a bound session whose daemon runs). */
  working?: readonly string[];
  /** Targets bound to a session whose daemon ended. */
  idle?: readonly string[];
  /** Holder strips and the targets each holds. */
  holders?: Readonly<Record<string, readonly string[]>>;
};

/** The holds a state names, as `readHolds` answers them in `holds`. */
function holdsOf(state: HoldsState): Holds {
  const holders = new Map<string, Hold[]>();
  for (const [strip, ids] of Object.entries(state.holders ?? {}))
    for (const target of ids)
      holders.set(target, [
        ...(holders.get(target) ?? []),
        { strip, label: `Strip ${strip}` },
      ]);
  const working = new Map<string, string[]>();
  const bound = new Map<string, string[]>();
  for (const target of state.working ?? []) {
    working.set(target, [`codex-${target.slice(-4)}`]);
    bound.set(target, [`codex-${target.slice(-4)}`]);
  }
  for (const target of state.idle ?? [])
    bound.set(target, [`codex-${target.slice(-4)}`]);
  return { holders, working, bound };
}

async function serve(
  browser: FakeBrowser,
  options: HoldsState & {
    graceMs?: number;
    unviewedGraceMs?: number;
    releaseGraceMs?: number;
    holdsEveryMs?: number;
    reconnectMs?: number;
    /** The real reader instead of the state above. */
    holds?: () => Promise<Holds>;
    /** How the shell names the Environment, for the page. */
    identity?: (() => Promise<EnvironmentIdentity | null>) | undefined;
    /** The cookie sweep at each connection (#504). */
    sweepCookies?: HubSeams["sweepCookies"];
    /** Decision F57's times and what the hub writes down. */
    idleSleepMs?: number;
    sleepCloseMs?: number;
    wakeRetryMs?: number;
    sleepState?: HubSeams["sleepState"];
  } = {},
) {
  root = await realpath(await mkdtemp(join(tmpdir(), "people-view-")));
  const logs: string[] = [];
  let state: Holds = holdsOf(options);
  let failing = false;
  let changed: (() => void) | null = null;
  const writes: string[][] = [];
  const takenAts: number[] = [];
  // The boot clock: seconds since a fixed boot, later at each reading.
  let uptime = 1_000;
  service = startViewService({
    origin,
    port: 0,
    log: (line) => logs.push(line),
    identity: options.identity,
    hub: {
      connect: browser.connect,
      ...(options.sweepCookies === undefined
        ? {}
        : { sweepCookies: options.sweepCookies }),
      holds:
        options.holds ??
        (async () => {
          if (failing) throw new Error("unreadable");
          return state;
        }),
      watchHolds: (callback) => {
        changed = callback;
        return { retry: () => {}, stop: () => {} };
      },
      writeTabs: async (ids, takenAt) => {
        writes.push([...ids].sort());
        takenAts.push(takenAt.at);
      },
      bootClock: async () => {
        uptime += 0.01;
        return { boot: testBoot, at: uptime };
      },
      uploadDirectory: join(root, "uploads"),
      screen: { width: 1920, height: 1080 },
      log: (line) => logs.push(line),
      graceMs: options.graceMs ?? 60_000,
      unviewedGraceMs: options.unviewedGraceMs ?? options.graceMs ?? 60_000,
      releaseGraceMs: options.releaseGraceMs ?? options.graceMs ?? 60_000,
      holdsEveryMs: options.holdsEveryMs ?? 60_000,
      reconnectMs: options.reconnectMs ?? 20,
      ...(options.idleSleepMs === undefined
        ? {}
        : { idleSleepMs: options.idleSleepMs }),
      ...(options.sleepCloseMs === undefined
        ? {}
        : { sleepCloseMs: options.sleepCloseMs }),
      ...(options.wakeRetryMs === undefined
        ? {}
        : { wakeRetryMs: options.wakeRetryMs }),
      ...(options.sleepState === undefined
        ? {}
        : { sleepState: options.sleepState }),
    },
  });
  await until(() => service?.hub.ready === true);
  const base = `http://127.0.0.1:${service.server.port}`;
  /** New holds, as when an app rewrites its holder file. */
  const setHolds = (next: HoldsState) => {
    state = holdsOf(next);
    changed?.();
  };
  const failHolds = (fail: boolean) => {
    failing = fail;
  };
  /** As when a watched directory changed. */
  const refresh = () => changed?.();
  return { base, logs, root, setHolds, failHolds, refresh, writes, takenAts };
}

/** The Launchpad's request to the hub on loopback (F47 point 6): no Origin,
 * no Sec-Fetch-Site, the loopback host Bun's fetch sends by itself. */
async function loopback(
  base: string,
  path: string,
  init: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
) {
  const response = await fetch(`${base}${path}`, {
    method: init.method ?? "GET",
    headers: {
      ...(init.body === undefined
        ? {}
        : { "content-type": "application/json" }),
      ...init.headers,
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

const closedTargets = (browser: FakeBrowser) =>
  browser.called("Target.closeTarget").map((c) => c.params.targetId);

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

test("the view routes /t/<id>, its /live and its /files by the path alone: the id in either case, named in upper case (decision F50, C1)", () => {
  const ask = (method: string, path: string, upgrade = false) =>
    classifyRequest(
      {
        method,
        url: `http://127.0.0.1:4848${path}`,
        host,
        origin,
        upgrade,
      },
      origin,
      4848,
    );
  const tab = id(0xabcdef);
  for (const named of [tab, tab.toLowerCase()]) {
    expect(ask("GET", `/t/${named}`)).toEqual({ kind: "page" });
    expect(ask("GET", `/t/${named}/live`, true)).toEqual({
      kind: "live",
      targetId: tab,
    });
    expect(ask("POST", `/t/${named}/files`)).toEqual({
      kind: "files",
      targetId: tab,
    });
  }
  // The query is not part of the path: the page is served all the same.
  expect(ask("GET", `/t/${tab}?from=link`)).toEqual({ kind: "page" });
  // Any other path names no tab.
  for (const path of [
    `/T/${tab}`,
    `/t/${tab}/`,
    `/t/${tab.slice(1)}`,
    `/t/${"g".repeat(32)}`,
  ])
    expect(ask("GET", path)).toEqual({
      kind: "refused",
      status: 404,
      error: "not-found",
    });
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

// F39's addendum of 2026-10-12: the view names its Environment as the shell
// does, never from its own address. Its page carries the identity the
// service reads (the Environment's own shell document) as data the script
// reads back, and the shell's `<lazurio-environment>` draws it.
const embedded = (html: string) =>
  parseEmbeddedIdentity(
    new RegExp(
      `<script type="application/json" id="${viewIdentityElementId}">([^<]*)</script>`,
    ).exec(html)?.[1],
  );

test("the page carries the identity the service reads, for the shell's element; none without one", async () => {
  const work: EnvironmentIdentity = {
    id: "pilot.example",
    name: "Pracovní",
    who: "@jana",
    glyph: {
      kind: "avatar",
      organization: "Example Works",
      avatar: "https://avatars.githubusercontent.com/u/4242?v=4",
      initials: "EW",
    },
  };
  let reads = 0;
  const browser = new FakeBrowser([tab(1)]);
  const { base } = await serve(browser, {
    identity: async () => {
      reads += 1;
      return work;
    },
  });
  for (const path of ["/", `/t/${id(1)}`]) {
    const page = await fetch(`${base}${path}`, { headers: { Host: host } });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain(
      '<lazurio-environment id="environment" class="environment" hidden></lazurio-environment>',
    );
    expect(embedded(html)).toEqual(work);
    // The data comes before the script that reads it, and the hostname rule
    // of the addendum of 2026-10-09 names nothing.
    expect(html.indexOf(viewIdentityElementId)).toBeLessThan(
      html.indexOf("/assets/view.js"),
    );
    expect(html).not.toContain("pilot ·");
    expect(html).not.toContain("github.com/example.png");
  }
  expect(reads).toBe(2);
});

test("a page without an identity to give, or whose read fails, names none and still loads", async () => {
  const browser = new FakeBrowser([tab(1)]);
  for (const identity of [
    undefined,
    async () => null,
    async () => {
      throw new Error("the Folder cannot be read");
    },
  ]) {
    const { base } = await serve(browser, { identity });
    const page = await fetch(`${base}/t/${id(1)}`, { headers: { Host: host } });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('<lazurio-environment id="environment"');
    expect(html).not.toContain(viewIdentityElementId);
    await service?.stop();
    service = undefined;
  }
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

// F39's addendum of 2026-10-13: the view's bar is the only toolbar above a
// remote tab in every app. It ends with Kvalita obrazu, a menu button with
// two choices, and Otevřít samostatně, which the script shows only inside an
// app's frame. The script names them in the person's language (both
// languages in `environment-browser-view-client.test.ts`); all behaviour is
// the script's, as the page's policy allows no inline script.
test("the bar ends with Kvalita obrazu and, hidden until the view is framed, Otevřít samostatně", async () => {
  const browser = new FakeBrowser([tab(1)]);
  const { base } = await serve(browser);
  for (const path of ["/", `/t/${id(1)}`]) {
    const page = await fetch(`${base}${path}`, { headers: { Host: host } });
    const bar: string[] = [];
    const byId = new Map<string, Record<string, string>>();
    const items: Record<string, string>[] = [];
    const scripts: Record<string, string>[] = [];
    const attributes = (element: { attributes: Iterable<[string, string]> }) =>
      Object.fromEntries(element.attributes);
    await new HTMLRewriter()
      .on("header.bar > *", {
        element(element) {
          bar.push(element.getAttribute("id") ?? element.tagName);
        },
      })
      .on("[id]", {
        element(element) {
          byId.set(element.getAttribute("id") ?? "", attributes(element));
        },
      })
      .on('#picture-menu [role="menuitemradio"]', {
        element(element) {
          items.push(attributes(element));
        },
      })
      .on("script", {
        element(element) {
          scripts.push(attributes(element));
        },
      })
      .transform(page)
      .text();
    expect(bar).toEqual([
      "environment",
      "back",
      "forward",
      "reload",
      "address",
      "picture-box",
      "alone",
    ]);
    expect(byId.get("picture")).toEqual({
      id: "picture",
      class: "tool",
      type: "button",
      "aria-haspopup": "menu",
      "aria-expanded": "false",
      "aria-controls": "picture-menu",
      "data-picture": "standard",
    });
    expect(byId.get("picture-menu")).toEqual({
      id: "picture-menu",
      class: "menu",
      role: "menu",
      hidden: "",
    });
    // Each choice is named by its label; Data saver's hint describes it.
    expect(items).toEqual([
      {
        class: "menu-item",
        type: "button",
        role: "menuitemradio",
        "aria-checked": "true",
        "data-picture": "standard",
        tabindex: "-1",
        "aria-labelledby": "picture-standard",
      },
      {
        class: "menu-item",
        type: "button",
        role: "menuitemradio",
        "aria-checked": "false",
        "data-picture": "saver",
        tabindex: "-1",
        "aria-labelledby": "picture-saver",
        "aria-describedby": "picture-saver-hint",
      },
    ]);
    for (const part of [
      "picture-standard",
      "picture-saver",
      "picture-saver-hint",
    ])
      expect(byId.has(part)).toBe(true);
    // Hidden and disabled until the script finds an app's frame and a tab.
    expect(byId.get("alone")).toEqual({
      id: "alone",
      class: "tool",
      type: "button",
      hidden: "",
      disabled: "",
    });
    expect(
      scripts.every(
        (script) =>
          script.src === "/assets/view.js" ||
          script.type === "application/json",
      ),
    ).toBe(true);
  }
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
  expect(await health.json()).toEqual({
    ok: true,
    browser: "connected",
    github: null,
  });
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
  // Numbered in its tab, for the page's acknowledgements (F39's addendum of
  // 2026-10-13): the first screenshot was the tab's first frame.
  expect(last?.header).toEqual({
    width: 3,
    height: 2,
    deviceWidth: 700,
    deviceHeight: 500,
    offsetTop: 0,
    pageScaleFactor: 1,
    seq: 2,
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
  // Never an address on the view host of an Environment browser: no view
  // inside the Environment browser (F50 point 2).
  const viewHost = `https://browser.vm-02.example.lazurio.io/t/${id(2)}`;
  expect(navigableAddress(viewHost)).toBeNull();
  const browser = new FakeBrowser([tab(1)]);
  const { base } = await serve(browser);
  const view = await person(base, id(1));
  await until(() => view.of("info").length > 0);
  view.send({ t: "goto", url: "javascript:alert(1)" });
  view.send({ t: "goto", url: viewHost });
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

// ---- The hand-off to the person's own browser (#504) --------------------------

// F39's addendum of 2026-10-18: the browser's policy (Machines) blocks the
// pages of a person's Lazurio account, and Chrome commits an error page that
// names the failed navigation's loader. Only that failure, by its DevTools
// error text, is offered to the viewer's own browser; the view never opens it
// inside. The event shapes are Chrome 155's (scripts/proof-browser-loopback-entry.ts).
test("a navigation the browser's policy blocks is offered to the viewer's own browser, never opened inside; other failures are not", async () => {
  const browser = new FakeBrowser([tab(1)]);
  const { base } = await serve(browser);
  const session = `S-${id(1)}`;
  // Nobody views the tab: the Network domain stays off.
  await until(() => browser.called("Page.enable").length > 0);
  expect(browser.called("Network.enable")).toEqual([]);
  const view = await person(base, id(1));
  await until(() => browser.called("Network.enable").length > 0);
  // Nothing of the pages' bodies is kept for it.
  expect(browser.called("Network.enable")).toEqual([
    {
      method: "Network.enable",
      params: {
        maxTotalBufferSize: 0,
        maxResourceBufferSize: 0,
        maxPostDataSize: 0,
      },
      sessionId: session,
    },
  ]);
  const failAndCommit = (loader: string, url: string, errorText: string) => {
    browser.emit(
      "Network.loadingFailed",
      { requestId: loader, type: "Document", errorText, canceled: false },
      session,
    );
    browser.emit(
      "Page.frameNavigated",
      {
        frame: {
          id: `F-${session}`,
          loaderId: loader,
          url: "chrome-error://chromewebdata/",
          unreachableUrl: url,
        },
        type: "Navigation",
      },
      session,
    );
  };
  // A refused connection, a blocked image and a blocked subframe: nothing.
  failAndCommit("L1", "https://example.com/", "net::ERR_CONNECTION_REFUSED");
  browser.emit(
    "Network.loadingFailed",
    {
      requestId: "R2",
      type: "Image",
      errorText: "net::ERR_BLOCKED_BY_ADMINISTRATOR",
    },
    session,
  );
  browser.emit(
    "Page.frameNavigated",
    {
      frame: {
        id: "child",
        parentId: `F-${session}`,
        loaderId: "R2",
        url: "chrome-error://chromewebdata/",
        unreachableUrl: "https://dashboard.lazurio.ai/embed",
      },
    },
    session,
  );
  // An error page whose loader no blocked request names: nothing.
  browser.emit(
    "Page.frameNavigated",
    {
      frame: {
        id: `F-${session}`,
        loaderId: "L9",
        url: "chrome-error://chromewebdata/",
        unreachableUrl: "https://auth.lazurio.ai/",
      },
    },
    session,
  );
  // The sign-in service, blocked: handed off, exactly once.
  failAndCommit(
    "L3",
    "https://auth.lazurio.ai/realms/lazurio/account",
    "net::ERR_BLOCKED_BY_ADMINISTRATOR",
  );
  await until(() => view.of("hand-off").length > 0);
  await settle();
  expect(view.of("hand-off")).toEqual([
    { t: "hand-off", url: "https://auth.lazurio.ai/realms/lazurio/account" },
  ]);
  // The hub navigated nowhere for it.
  expect(browser.called("Page.navigate")).toEqual([]);
  expect(browser.called("Target.createTarget")).toEqual([]);
  // Once nobody views the tab, the Network domain goes off again.
  view.socket.close();
  await until(() => browser.called("Network.disable").length > 0);
});

// #504: the view sweeps the browser's cookies each time it reaches it, before
// it is ready, and its health says whom the kept GitHub sign-in names. A
// sweep that fails is logged and the view still serves.
test("the view sweeps Lazurio sessions at every connection to the browser and says whom GitHub's sign-in names", async () => {
  const browser = new FakeBrowser([tab(1)]);
  const sweeps: number[] = [];
  let fail = false;
  const { base, logs } = await serve(browser, {
    reconnectMs: 10,
    sweepCookies: async (cdp) => {
      sweeps.push(browser.connections);
      if (fail) throw new Error("Storage.getCookies: timed out");
      await cdp.send("Storage.getCookies", {});
      return { removed: 2, remaining: 0, github: "octocat" };
    },
  });
  expect(sweeps).toEqual([1]);
  expect(browser.called("Storage.getCookies")).toHaveLength(1);
  expect(logs).toContain(
    "removed 2 Lazurio session cookie(s) from the browser",
  );
  const health = await loopback(base, "/.lazurio/health");
  expect(health).toEqual({
    status: 200,
    body: { ok: true, browser: "connected", github: "octocat" },
  });
  // A restarted browser is swept again; a failed sweep is a log line.
  fail = true;
  browser.drop();
  await until(() => sweeps.length === 2 && service?.hub.ready === true);
  expect(logs.some((line) => line.startsWith("cookie sweep failed:"))).toBe(
    true,
  );
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

// ---- Closing (F39 point 9, F47 point 5) -----------------------------------------

test("a closed person's tab closes its remote tab after the grace; a tab an agent works in stays", async () => {
  const browser = new FakeBrowser([tab(1)]);
  const { base } = await serve(browser, { graceMs: 60, working: [id(1)] });
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
  await until(() => closedTargets(browser).includes(own));
  // An agent's window it works in stays after its viewer leaves.
  const agent = await person(base, id(1));
  await until(() => agent.of("info").length > 0);
  agent.socket.close();
  await settle(150);
  expect(closedTargets(browser)).not.toContain(id(1));
});

test("a tab an agent works in stays; once the agent stops, it ends after the grace of Vrátit", async () => {
  const browser = new FakeBrowser([tab(1), tab(2)]);
  const { setHolds } = await serve(browser, {
    graceMs: 60_000,
    releaseGraceMs: 40,
    working: [id(1), id(2)],
  });
  await settle(80);
  expect(closedTargets(browser)).toEqual([]);
  // The agent of id(1) stopped: its daemon ended, its binding stays.
  setHolds({ working: [id(2)], idle: [id(1)] });
  await until(() => closedTargets(browser).includes(id(1)));
  await settle(80);
  expect(closedTargets(browser)).not.toContain(id(2));
});

test("a tab a strip holds stays without viewers; after its last hold it ends unless held again within the grace", async () => {
  const browser = new FakeBrowser([tab(1), tab(2)]);
  const { setHolds } = await serve(browser, {
    unviewedGraceMs: 60_000,
    releaseGraceMs: 300,
    holders: { "t3-a": [id(1), id(2)], "t3-b": [id(2)] },
  });
  const graceOf = (target: string) =>
    service?.hub.list().find((t) => t.id === target)?.grace ?? null;
  await settle(120);
  expect(closedTargets(browser)).toEqual([]);
  // Thread a lets go of both; thread b still holds id(2).
  setHolds({ holders: { "t3-b": [id(2)] } });
  await until(() => graceOf(id(1))?.kind === "release");
  expect(graceOf(id(2))).toBeNull();
  // Vrátit in thread a within the grace: held again.
  setHolds({ holders: { "t3-a": [id(1)], "t3-b": [id(2)] } });
  await until(() => graceOf(id(1)) === null);
  await settle(400);
  expect(closedTargets(browser)).toEqual([]);
  // Both threads let go of id(2): it ends; id(1) stays held.
  setHolds({ holders: { "t3-a": [id(1)] } });
  await until(() => closedTargets(browser).includes(id(2)));
  expect(closedTargets(browser)).not.toContain(id(1));
});

test("an own tab nobody views or holds closes; an agent's tab stays while it works", async () => {
  const browser = new FakeBrowser();
  // The fake's first two new tabs are id(100) and id(101); an agent works
  // in the first.
  const { base } = await serve(browser, { graceMs: 40, working: [id(100)] });
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
  await until(() => closedTargets(browser).includes(unopened));
  await settle(100);
  expect(closedTargets(browser)).not.toContain(bound);
});

test("a tab a page opened closes when nobody views or holds it; the tabs agents work in stay", async () => {
  // id(1) is an agent's window; its page opens two tabs, and an agent works
  // in the second.
  const browser = new FakeBrowser([tab(1)]);
  await serve(browser, { graceMs: 40, working: [id(1), id(3)] });
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
  await until(() => closedTargets(browser).includes(id(2)));
  await settle(120);
  expect(closedTargets(browser)).not.toContain(id(3));
  expect(closedTargets(browser)).not.toContain(id(1));
});

test("after a start, a tab nothing holds gets the time of a new tab; before, the view never closed it", async () => {
  const browser = new FakeBrowser([tab(1), tab(2)]);
  await serve(browser, {
    unviewedGraceMs: 60,
    holders: { launchpad: [id(2)] },
  });
  await until(() => closedTargets(browser).includes(id(1)));
  await settle(100);
  expect(closedTargets(browser)).not.toContain(id(2));
});

test("a failed read of the holds lets no tab go", async () => {
  // id(2) is held by nothing: its grace ends, but the read before closing
  // fails, so it stays.
  const browser = new FakeBrowser([tab(1), tab(2)]);
  const { failHolds, setHolds } = await serve(browser, {
    working: [id(1)],
    releaseGraceMs: 30,
    unviewedGraceMs: 100,
  });
  failHolds(true);
  setHolds({});
  await settle(300);
  expect(closedTargets(browser)).toEqual([]);
});

// ---- The list of live tabs (F47 point 4) -----------------------------------------

test("the hub writes the list of live tabs whenever one appears or ends, never while it does not know the browser's targets", async () => {
  const browser = new FakeBrowser([tab(1)]);
  const { base, writes } = await serve(browser, {
    releaseGraceMs: 30,
    reconnectMs: 250,
    holders: { launchpad: [id(1)] },
  });
  const last = () => writes.at(-1) ?? null;
  // After discovery: every page but the hub's blank window.
  await until(() => last() !== null);
  expect(last()).toEqual([id(1)]);
  const opened = await loopback(base, "/.lazurio/tabs", {
    method: "POST",
    body: { url: "https://example.com/n" },
  });
  const fresh = String(opened.body.id);
  await until(() => last()?.includes(fresh) === true);
  await loopback(base, `/.lazurio/tabs/${fresh}/close`, { method: "POST" });
  await until(() => last()?.includes(fresh) === false);
  // The browser goes away and comes back restarted, with new ids: nothing is
  // written while the hub does not know its targets, then the new list.
  const before = writes.length;
  browser.drop();
  browser.targets.delete(id(1));
  browser.targets.set(id(5), tab(5));
  await settle(150);
  expect(service?.hub.connected).toBe(false);
  expect(writes.length).toBe(before);
  await until(() => JSON.stringify(last()) === JSON.stringify([id(5)]));
});

test("the hub takes a snapshot again on its beat, so a record made after its tab ended meets a newer list", async () => {
  const browser = new FakeBrowser([tab(1)]);
  const { writes, takenAts } = await serve(browser, {
    holdsEveryMs: 60,
    holders: { launchpad: [id(1)] },
  });
  await until(() => writes.length > 0);
  const before = writes.length;
  await settle(300);
  expect(writes.length).toBeGreaterThanOrEqual(before + 3);
  expect(writes.at(-1)).toEqual([id(1)]);
  // Each snapshot is stamped with the boot clock when it began, later each
  // time.
  for (let n = 1; n < takenAts.length; n++)
    expect(takenAts[n] as number).toBeGreaterThan(takenAts[n - 1] as number);
});

test("snapshots are stamped by the boot clock, whatever the wall clock does", async () => {
  const browser = new FakeBrowser([tab(1)]);
  const { writes, takenAts } = await serve(browser, {
    holdsEveryMs: 50,
    holders: { launchpad: [id(1)] },
  });
  await until(() => writes.length > 0);
  // The wall clock steps back an hour.
  const realNow = Date.now;
  const back = realNow() - 3_600_000;
  Date.now = () => back;
  try {
    const before = takenAts.length;
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(takenAts.length).toBeGreaterThan(before);
    for (let n = 1; n < takenAts.length; n++)
      expect(takenAts[n] as number).toBeGreaterThan(takenAts[n - 1] as number);
  } finally {
    Date.now = realNow;
  }
});

test("a live tab whose event reaches the hub late is in the list, because the list is a snapshot of the browser", async () => {
  const browser = new FakeBrowser([tab(1)]);
  const { writes } = await serve(browser, {
    holdsEveryMs: 60,
    holders: { launchpad: [id(1)] },
  });
  // Chrome has the target, but its targetCreated has not reached the hub.
  browser.targets.set(id(7), tab(7));
  const before = writes.length;
  await until(() => writes.length > before + 1);
  expect(service?.hub.list().some((t) => t.id === id(7))).toBe(false);
  expect(writes.at(-1)).toEqual([id(1), id(7)]);
});

test("a holder directory that cannot be read lets no tab go until a read succeeds and shows the release", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "people-holders-")));
  const holders = join(dir, "holders");
  await mkdir(holders, { mode: 0o700 });
  const hold = (tabs: string[]) =>
    writeFile(
      join(holders, "launchpad.json"),
      JSON.stringify({ strip: "launchpad", label: "Launchpad", tabs }),
    );
  await hold([id(1)]);
  const browser = new FakeBrowser([tab(1)]);
  const { refresh } = await serve(browser, {
    releaseGraceMs: 40,
    unviewedGraceMs: 60_000,
    holds: holdsReader({ holders }),
  });
  try {
    expect(
      service?.hub.list().find((t) => t.id === id(1))?.holders,
    ).toHaveLength(1);
    // The directory becomes unreadable: the hub keeps its last reading.
    await chmod(holders, 0o000);
    refresh();
    await settle(300);
    expect(closedTargets(browser)).toEqual([]);
    expect(
      service?.hub.list().find((t) => t.id === id(1))?.holders,
    ).toHaveLength(1);
    // Readable again, and the Launchpad let go: now the release counts.
    await chmod(holders, 0o700);
    await hold([]);
    refresh();
    await until(() => closedTargets(browser).includes(id(1)));
  } finally {
    await chmod(holders, 0o700).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
});

// Root decision 0191 point 32, which changes F47 point 5: before, one holder
// file the hub could not read kept every tab of the Environment.
test("one holder file that cannot be read keeps only its own tabs: another app's release still ends a tab", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "people-holders-")));
  const holders = join(dir, "holders");
  await mkdir(holders, { mode: 0o700 });
  const hold = (strip: string, tabs: string[]) =>
    writeFile(
      join(holders, `${strip}.json`),
      JSON.stringify({ strip, label: strip, tabs }),
    );
  await hold("launchpad", [id(1)]);
  await hold("t3-a", [id(2)]);
  const browser = new FakeBrowser([tab(1), tab(2)]);
  const { refresh } = await serve(browser, {
    releaseGraceMs: 40,
    unviewedGraceMs: 60_000,
    holds: holdsReader({ holders }),
  });
  try {
    expect(service?.hub.list().map((t) => t.holders.length)).toEqual([1, 1]);
    // The Launchpad's file breaks; the thread lets go of its tab.
    await writeFile(join(holders, "launchpad.json"), "{");
    await hold("t3-a", []);
    refresh();
    await until(() => closedTargets(browser).includes(id(2)));
    await settle(200);
    expect(closedTargets(browser)).toEqual([id(2)]);
    expect(service?.hub.list().find((t) => t.id === id(1))?.holders).toEqual([
      { strip: "launchpad", label: "launchpad" },
    ]);
    // Mended, and the Launchpad let go: now its release counts.
    await hold("launchpad", []);
    refresh();
    await until(() => closedTargets(browser).includes(id(1)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an agent whose .pid cannot be understood keeps its tab; a .pid of an ended process lets it go", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "people-sockets-")));
  const sockets = join(dir, "agent-browser");
  await mkdir(sockets, { mode: 0o700 });
  await writeFile(
    join(sockets, "codex-1.target"),
    JSON.stringify({ targetId: id(1) }),
  );
  await writeFile(join(sockets, "codex-1.pid"), "");
  const browser = new FakeBrowser([tab(1)]);
  const { refresh } = await serve(browser, {
    releaseGraceMs: 40,
    unviewedGraceMs: 60,
    holds: holdsReader({ sockets }),
  });
  try {
    await settle(300);
    expect(closedTargets(browser)).toEqual([]);
    // A well-formed id of a process that does not run: the agent ended.
    await writeFile(join(sockets, "codex-1.pid"), "4194303");
    refresh();
    await until(() => closedTargets(browser).includes(id(1)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("while the browser is away, close and restore change nothing and answer 503", async () => {
  const browser = new FakeBrowser([tab(1)]);
  const { base } = await serve(browser, {
    reconnectMs: 60_000,
    holders: { launchpad: [id(1)] },
  });
  // A viewer keeps the tab known to the hub across the lost connection.
  const view = await person(base, id(1));
  await until(() => view.of("info").length > 0);
  browser.drop();
  await until(() => service?.hub.connected === false);
  expect(service?.hub.hasTab(id(1))).toBe(true);
  for (const action of ["close", "restore"])
    expect(
      (
        await loopback(base, `/.lazurio/tabs/${id(1)}/${action}`, {
          method: "POST",
        })
      ).status,
    ).toBe(503);
  expect(service?.hub.list().find((t) => t.id === id(1))?.closing).toBeNull();
  view.socket.close();
});

// ---- The hub's blank window (F47 point 5) -----------------------------------------

test("the hub keeps Chrome's first window as its own, never closes or lists it, and opens another when someone uses it", async () => {
  const browser = new FakeBrowser([tab(1)]);
  const { base } = await serve(browser, { graceMs: 30, working: [id(1)] });
  await settle(100);
  expect(closedTargets(browser)).toEqual([]);
  expect(browser.called("Target.createTarget")).toEqual([]);
  const listed = (await loopback(base, "/.lazurio/tabs")).body
    .tabs as TabFacts[];
  expect(listed.map((t) => t.id)).toEqual([id(1)]);
  // Someone navigated it: a tab like any other now, and a new blank one.
  browser.emit("Target.targetInfoChanged", {
    targetInfo: {
      type: "page",
      targetId: firstWindow,
      url: "https://example.com/x",
      title: "",
    },
  });
  await until(() => browser.called("Target.createTarget").length === 1);
  expect(browser.called("Target.createTarget")[0]?.params).toEqual({
    url: "about:blank",
    newWindow: true,
  });
  // The used window nobody views or holds ends; the new one stays.
  await until(() => closedTargets(browser).includes(firstWindow));
  await settle(100);
  expect(closedTargets(browser)).toEqual([firstWindow]);
});

test("a browser without a blank window gets one from the hub, and another when it closes", async () => {
  const browser = new FakeBrowser([tab(1)], false);
  await serve(browser, { working: [id(1)] });
  await until(() => browser.called("Target.createTarget").length === 1);
  const keeper = id(100);
  browser.emit("Target.targetDestroyed", { targetId: keeper });
  await until(() => browser.called("Target.createTarget").length === 2);
});

// ---- The Launchpad's requests (F47 point 6) ---------------------------------------

test("the tab requests exist only on loopback and never for a browser", () => {
  const ask = (
    method: string,
    path: string,
    headers: {
      host?: string;
      origin?: string | null;
      fetchSite?: string | null;
    } = {},
  ) =>
    classifyRequest(
      {
        method,
        url: `http://x${path}`,
        host: headers.host ?? "127.0.0.1:4100",
        origin: headers.origin ?? null,
        upgrade: false,
        fetchSite: headers.fetchSite ?? null,
      },
      origin,
      4100,
    );
  const target = id(5);
  expect(ask("GET", "/.lazurio/tabs")).toEqual({ kind: "tabs" });
  expect(ask("GET", "/.lazurio/tabs", { host: "localhost:4100" })).toEqual({
    kind: "tabs",
  });
  expect(ask("POST", "/.lazurio/tabs")).toEqual({ kind: "open" });
  expect(ask("POST", `/.lazurio/tabs/${target}/close`)).toEqual({
    kind: "close",
    targetId: target,
  });
  expect(ask("POST", `/.lazurio/tabs/${target.toLowerCase()}/restore`)).toEqual(
    {
      kind: "restore",
      targetId: target,
    },
  );
  // Through the gateway, which sends the view's own host, they do not exist.
  expect(ask("GET", "/.lazurio/tabs", { host })).toEqual({
    kind: "refused",
    status: 404,
    error: "not-found",
  });
  expect(
    ask("POST", `/.lazurio/tabs/${target}/close`, { host, origin }),
  ).toMatchObject({ status: 404 });
  // A page in the Environment's own browser reaches the loopback too.
  for (const headers of [
    { origin: "https://evil.example" },
    { origin: "null" },
    { fetchSite: "cross-site" },
    { fetchSite: "same-origin" },
    { fetchSite: "none" },
  ])
    expect(ask("POST", `/.lazurio/tabs/${target}/close`, headers)).toEqual({
      kind: "refused",
      status: 403,
      error: "browser-request",
    });
  expect(ask("GET", `/.lazurio/tabs/${target}/close`)).toMatchObject({
    status: 405,
  });
  expect(ask("DELETE", "/.lazurio/tabs")).toMatchObject({ status: 405 });
  expect(
    ask("GET", "/.lazurio/tabs/nope/close", { host: "127.0.0.1:4100" }),
  ).toMatchObject({
    status: 421,
  });
});

test("the list names each tab's opener, holders, agents and countdown", async () => {
  const browser = new FakeBrowser([
    tab(1),
    tab(2, { url: "https://example.com/p" }),
  ]);
  const { base } = await serve(browser, {
    working: [id(1)],
    holders: { "t3-x": [id(2)], launchpad: [id(2)] },
    unviewedGraceMs: 60_000,
  });
  const opened = await loopback(base, "/.lazurio/tabs", {
    method: "POST",
    body: { url: "https://example.com/new", strip: "t3-x" },
  });
  expect(opened.status).toBe(201);
  expect(opened.body.view).toBe(`${origin}/t/${opened.body.id}`);
  expect(browser.called("Target.createTarget")[0]?.params).toEqual({
    url: "https://example.com/new",
    newWindow: true,
  });
  const listed = (await loopback(base, "/.lazurio/tabs")).body
    .tabs as TabFacts[];
  const byId = new Map(listed.map((t) => [t.id, t]));
  expect(byId.get(id(1))).toMatchObject({
    opener: { kind: "agent", session: `codex-${id(1).slice(-4)}` },
    agents: [`codex-${id(1).slice(-4)}`],
    holders: [],
    grace: null,
    closing: null,
  });
  expect(
    byId
      .get(id(2))
      ?.holders.map((h) => h.strip)
      .sort(),
  ).toEqual(["launchpad", "t3-x"]);
  const fresh = byId.get(String(opened.body.id));
  expect(fresh?.opener).toEqual({ kind: "new-tab", strip: "t3-x" });
  expect(fresh?.grace?.kind).toBe("unviewed");
  expect(Date.parse(String(fresh?.openedAt))).toBeGreaterThan(0);
  expect(byId.has(firstWindow)).toBe(false);
  // Not an address the bar may open, or a strip that is no file name.
  for (const body of [
    { url: "javascript:alert(1)" },
    { url: "file:///etc/passwd" },
    { url: "https://example.com", strip: "../x" },
    { url: 42 },
  ])
    expect(
      (await loopback(base, "/.lazurio/tabs", { method: "POST", body })).status,
    ).toBe(400);
  // A browser's request is refused even on loopback.
  const refused = await loopback(base, "/.lazurio/tabs", {
    headers: { Origin: "https://evil.example" },
  });
  expect(refused.status).toBe(403);
});

test("the list with heap=1 adds each tab's JavaScript heap from its own session, null where the read fails or is late; without it nothing changes", async () => {
  const browser = new FakeBrowser([tab(1), tab(2), tab(3)]);
  browser.heaps.set(id(1), "hang");
  browser.heaps.set(id(2), "fail");
  browser.heaps.set(id(3), { usedSize: 12_345_678, totalSize: 20_000_000 });
  const { base } = await serve(browser);
  // Every page has its session, the hub's blank window too.
  await until(() => browser.called("Page.getFrameTree").length >= 4);
  const started = Date.now();
  const listed = (await loopback(base, "/.lazurio/tabs?heap=1")).body
    .tabs as TabFacts[];
  // Each read waits 500 ms at most, and all are asked at once: the tab
  // after the one that never answers is not kept waiting for it.
  expect(Date.now() - started).toBeLessThan(1_500);
  const asked = browser.heapAskedAt;
  expect(Math.max(...asked) - Math.min(...asked)).toBeLessThan(250);
  const byId = new Map(listed.map((t) => [t.id, t]));
  expect(byId.get(id(1))?.heap).toBeNull();
  expect(byId.get(id(2))?.heap).toBeNull();
  expect(byId.get(id(3))?.heap).toEqual({
    used: 12_345_678,
    total: 20_000_000,
  });
  expect(
    browser
      .called("Runtime.getHeapUsage")
      .map((call) => call.sessionId)
      .sort(),
  ).toEqual([`S-${id(1)}`, `S-${id(2)}`, `S-${id(3)}`]);
  // Without it the list is as it was, and no heap is read.
  const reads = browser.called("Runtime.getHeapUsage").length;
  const plain = (await loopback(base, "/.lazurio/tabs")).body.tabs as Record<
    string,
    unknown
  >[];
  expect(plain.map((t) => t.id).sort()).toEqual([id(1), id(2), id(3)]);
  for (const t of plain) expect(Object.hasOwn(t, "heap")).toBe(false);
  expect(browser.called("Runtime.getHeapUsage").length).toBe(reads);
  // The Runtime domain is never enabled, so no page can tell.
  expect(browser.called("Runtime.enable")).toEqual([]);
});

test("the Launchpad's hub client reads the service's own answers on loopback, with no Origin or Sec-Fetch-Site", async () => {
  const browser = new FakeBrowser([tab(1)]);
  const { base } = await serve(browser, { holders: { launchpad: [id(1)] } });
  await until(() => browser.called("Page.getFrameTree").length >= 2);
  const entry = { origin, listenPort: Number(new URL(base).port) };
  expect(await listTabs(entry, { heap: true })).toMatchObject({
    kind: "tabs",
    tabs: [
      {
        id: id(1),
        heap: { used: 1_000_000, total: 2_000_000 },
        holders: [{ strip: "launchpad", label: "Strip launchpad" }],
      },
    ],
  });
  const opened = await openTab(entry, "https://example.com/new", "launchpad");
  if (opened.kind !== "opened") throw new Error("The hub opened no tab");
  expect(browser.called("Target.createTarget")[0]?.params).toEqual({
    url: "https://example.com/new",
    newWindow: true,
  });
  const listed = await listTabs(entry, { heap: false });
  if (listed.kind !== "tabs") throw new Error("The hub listed no tabs");
  const fresh = listed.tabs.find((t) => t.id === opened.tab);
  expect(fresh?.opener).toEqual({ kind: "new-tab", strip: "launchpad" });
  expect(fresh && Object.hasOwn(fresh, "heap")).toBe(false);
  expect(await closeTab(entry, opened.tab)).toMatchObject({ kind: "closing" });
  expect(await restoreTab(entry, opened.tab)).toEqual({ kind: "restored" });
  // The same page for the same strip again is that tab (decision F57).
  expect(await openTab(entry, "https://example.com/new", "launchpad")).toEqual({
    kind: "opened",
    tab: opened.tab,
    reused: true,
  });
  // A held tab counts nothing down: nothing to restore.
  expect(await restoreTab(entry, id(1))).toEqual({
    kind: "refused",
    reason: "nothing-to-restore",
  });
  expect(await closeTab(entry, id(77))).toEqual({
    kind: "refused",
    reason: "not-found",
  });
  expect(await restoreTab(entry, id(77))).toEqual({
    kind: "refused",
    reason: "not-found",
  });
  expect(await openTab(entry, "javascript:alert(1)", null)).toEqual({
    kind: "refused",
    reason: "invalid-request",
  });
});

test("a close for everyone ends a held tab after the grace, and Vrátit within it keeps the tab", async () => {
  const browser = new FakeBrowser([tab(1), tab(2)]);
  const { base } = await serve(browser, {
    releaseGraceMs: 80,
    working: [id(2)],
    holders: { "t3-a": [id(1)], launchpad: [id(2)] },
  });
  const closing = await loopback(base, `/.lazurio/tabs/${id(1)}/close`, {
    method: "POST",
  });
  expect(closing.status).toBe(202);
  expect(Date.parse(String(closing.body.closing))).toBeGreaterThan(
    Date.now() - 1_000,
  );
  const restored = await loopback(base, `/.lazurio/tabs/${id(1)}/restore`, {
    method: "POST",
  });
  expect(restored).toEqual({ status: 200, body: { restored: true } });
  await settle(160);
  expect(closedTargets(browser)).toEqual([]);
  // Held and with an agent working in it: closed for everyone all the same.
  expect(
    (await loopback(base, `/.lazurio/tabs/${id(2)}/close`, { method: "POST" }))
      .status,
  ).toBe(202);
  const listed = (await loopback(base, "/.lazurio/tabs")).body
    .tabs as TabFacts[];
  expect(listed.find((t) => t.id === id(2))?.closing).not.toBeNull();
  await until(() => closedTargets(browser).includes(id(2)));
  // Unknown tabs and nothing to restore.
  expect(
    (await loopback(base, `/.lazurio/tabs/${id(77)}/close`, { method: "POST" }))
      .status,
  ).toBe(404);
  expect(
    (
      await loopback(base, `/.lazurio/tabs/${id(77)}/restore`, {
        method: "POST",
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await loopback(base, `/.lazurio/tabs/${id(1)}/restore`, {
        method: "POST",
      })
    ).status,
  ).toBe(409);
  // The hub's blank window cannot be closed this way.
  expect(
    (
      await loopback(base, `/.lazurio/tabs/${firstWindow}/close`, {
        method: "POST",
      })
    ).status,
  ).toBe(404);
});

test("a close for everyone whose grace ends while the browser is away finishes after the reconnect", async () => {
  const browser = new FakeBrowser([tab(1)]);
  const { base } = await serve(browser, {
    releaseGraceMs: 40,
    reconnectMs: 250,
    holders: { launchpad: [id(1)] },
  });
  expect(
    (await loopback(base, `/.lazurio/tabs/${id(1)}/close`, { method: "POST" }))
      .status,
  ).toBe(202);
  browser.drop();
  await settle(120);
  expect(service?.hub.connected).toBe(false);
  expect(closedTargets(browser)).toEqual([]);
  await until(() => closedTargets(browser).includes(id(1)));
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
    holds: async () => noHolds,
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
    picture: "standard",
    acks: false,
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

// F39's addendum of 2026-10-13, #370: a page that acknowledges its frames has
// at most two of them on the way; the newest waits in the hub. Chrome makes
// the next frame only when it is acked, and the hub acks it only as far as
// every viewer has room, so a fast-changing page no longer fills the buffers
// on a slow link. A viewer that holds Chrome without progress for `stallMs`
// holds the others no longer.

/** A hub on a scripted browser, with the given stall (long by default). */
async function flowHub(browser: FakeBrowser, stallMs = 60_000) {
  const hub = new BrowserHub({
    connect: browser.connect,
    holds: async () => noHolds,
    uploadDirectory: tmpdir(),
    screen: { width: 1920, height: 1080 },
    log: () => {},
    reconnectMs: 20,
    stallMs,
  });
  hub.start();
  await until(() => hub.ready);
  return hub;
}

/** A person's view as the hub sees it: the numbers of the frames it got,
 * acks the test sends for it, and its socket's backlog. */
async function flowViewer(
  hub: BrowserHub,
  target: string,
  acks: boolean,
  backlog: () => number = () => 0,
) {
  const got: number[] = [];
  const viewer: Viewer = {
    send: () => {},
    sendFrame: (frame) => {
      const seq = decodeFrame(frame)?.header.seq;
      if (seq !== undefined) got.push(seq);
    },
    buffered: backlog,
    close: () => {},
    size: null,
    resize: false,
    picture: "standard",
    acks: false,
  };
  await until(() => hub.attach(target, viewer));
  await hub.handle(target, viewer, {
    t: "hello",
    width: 800,
    height: 600,
    dpr: 1,
    resize: false,
    ...(acks ? { acks } : {}),
  });
  const ack = (frame: number) =>
    hub.handle(target, viewer, { t: "ack", frame });
  return { viewer, got, ack };
}

/** Chrome's next screencast frame of a tab. */
function chromeFrame(browser: FakeBrowser, target: string) {
  browser.emit(
    "Page.screencastFrame",
    {
      data: jpeg.toString("base64"),
      sessionId: 1,
      metadata: { deviceWidth: 800, deviceHeight: 600 },
    },
    `S-${target}`,
  );
}

const chromeAcks = (browser: FakeBrowser) =>
  browser.called("Page.screencastFrameAck").length;

test("a viewer that acknowledges at once gets every frame, and Chrome is acked for each", async () => {
  const browser = new FakeBrowser([tab(1)]);
  const hub = await flowHub(browser);
  const fast = await flowViewer(hub, id(1), true);
  // The first screenshot is the tab's frame 1.
  await until(() => fast.got.length === 1);
  await fast.ack(1);
  await until(() => browser.called("Page.startScreencast").length > 0);
  for (let n = 2; n <= 6; n++) {
    chromeFrame(browser, id(1));
    await until(() => fast.got.includes(n));
    await fast.ack(n);
    await until(() => chromeAcks(browser) === n - 1);
  }
  expect(fast.got).toEqual([1, 2, 3, 4, 5, 6]);
  hub.stop();
});

test("a slow viewer has at most two frames on the way: the newest waits for its ack, Chrome waits for room", async () => {
  const browser = new FakeBrowser([tab(1)]);
  const hub = await flowHub(browser);
  const slow = await flowViewer(hub, id(1), true);
  await until(() => slow.got.length === 1);
  await until(() => browser.called("Page.startScreencast").length > 0);
  // Frame 1 (the screenshot) is unacknowledged; frame 2 fills the window.
  chromeFrame(browser, id(1));
  await until(() => slow.got.length === 2);
  await settle();
  expect(chromeAcks(browser)).toBe(0);
  // Chrome sends up to three frames without an ack: they wait in the hub,
  // the newest replacing the older.
  chromeFrame(browser, id(1));
  chromeFrame(browser, id(1));
  await settle();
  expect(slow.got).toEqual([1, 2]);
  expect(chromeAcks(browser)).toBe(0);
  // Room for one: the newest frame at once, frame 3 never.
  await slow.ack(1);
  expect(slow.got).toEqual([1, 2, 4]);
  expect(chromeAcks(browser)).toBe(0);
  // Done with all: Chrome may make frames for the room there is.
  await slow.ack(4);
  await until(() => chromeAcks(browser) === 2);
  // An ack of a frame it was never sent changes nothing.
  await slow.ack(99);
  await settle();
  expect(chromeAcks(browser)).toBe(2);
  hub.stop();
});

test("a viewer that never acknowledges holds the others for stallMs only, gets nothing past its window, and is back once it acks", async () => {
  const browser = new FakeBrowser([tab(1)]);
  const hub = await flowHub(browser, 300);
  const hung = await flowViewer(hub, id(1), true);
  const fast = await flowViewer(hub, id(1), true);
  await until(() => hung.got.length === 1 && fast.got.length === 1);
  await fast.ack(1);
  await until(() => browser.called("Page.startScreencast").length > 0);
  chromeFrame(browser, id(1));
  await until(() => fast.got.length === 2);
  await fast.ack(2);
  // The hung viewer's window is full: Chrome waits, for everyone.
  await settle(100);
  expect(chromeAcks(browser)).toBe(0);
  expect(hung.got).toEqual([1, 2]);
  // After stallMs it holds the others no longer.
  await until(() => chromeAcks(browser) === 1, 2_000);
  for (let n = 3; n <= 5; n++) {
    chromeFrame(browser, id(1));
    await until(() => fast.got.includes(n));
    await fast.ack(n);
    await until(() => chromeAcks(browser) === n - 1);
  }
  // It got nothing past its window meanwhile.
  expect(hung.got).toEqual([1, 2]);
  // Its ack brings the newest frame, and it holds Chrome again.
  await hung.ack(2);
  expect(hung.got).toEqual([1, 2, 5]);
  chromeFrame(browser, id(1));
  await until(() => fast.got.includes(6));
  await fast.ack(6);
  await until(() => hung.got.includes(6));
  await settle(100);
  expect(chromeAcks(browser)).toBe(4);
  hub.stop();
});

test("with every viewer stalled Chrome waits: nobody would see what it draws", async () => {
  const browser = new FakeBrowser([tab(1)]);
  const hub = await flowHub(browser, 100);
  const hung = await flowViewer(hub, id(1), true);
  await until(() => hung.got.length === 1);
  await until(() => browser.called("Page.startScreencast").length > 0);
  chromeFrame(browser, id(1));
  await until(() => hung.got.length === 2);
  await settle(400);
  expect(chromeAcks(browser)).toBe(0);
  hub.stop();
});

test("a page from before acknowledgements gets every frame, held by its socket's 1 MiB as before, and a viewer too far behind gets the newest once it drains", async () => {
  const browser = new FakeBrowser([tab(1)]);
  const hub = await flowHub(browser);
  let backlog = 0;
  const old = await flowViewer(hub, id(1), false, () => backlog);
  await until(() => old.got.length === 1);
  await until(() => browser.called("Page.startScreencast").length > 0);
  for (let n = 2; n <= 4; n++) {
    chromeFrame(browser, id(1));
    await until(() => chromeAcks(browser) === n - 1);
  }
  expect(old.got).toEqual([1, 2, 3, 4]);
  // 4 MiB waiting: no frame for it, and Chrome waits.
  backlog = 5 << 20;
  chromeFrame(browser, id(1));
  chromeFrame(browser, id(1));
  await settle();
  expect(old.got).toEqual([1, 2, 3, 4]);
  expect(chromeAcks(browser)).toBe(3);
  // Drained: the newest frame, and Chrome goes on.
  backlog = 0;
  hub.drained(id(1));
  expect(old.got).toEqual([1, 2, 3, 4, 6]);
  await until(() => chromeAcks(browser) === 5);
  hub.stop();
});

test("a viewer that leaves no longer holds Chrome; one that joins gets the newest frame at once, in its window", async () => {
  const browser = new FakeBrowser([tab(1)]);
  const hub = await flowHub(browser);
  const slow = await flowViewer(hub, id(1), true);
  const fast = await flowViewer(hub, id(1), true);
  await until(() => slow.got.length === 1 && fast.got.length === 1);
  await fast.ack(1);
  await until(() => browser.called("Page.startScreencast").length > 0);
  chromeFrame(browser, id(1));
  await until(() => fast.got.length === 2);
  await fast.ack(2);
  await settle();
  expect(chromeAcks(browser)).toBe(0);
  hub.detach(id(1), slow.viewer);
  await until(() => chromeAcks(browser) === 1);
  // A viewer joining mid-stream: the newest frame, numbered.
  chromeFrame(browser, id(1));
  await until(() => fast.got.includes(3));
  const late = await flowViewer(hub, id(1), true);
  expect(late.got).toEqual([3]);
  // It counts in its window like any other: with one frame unacknowledged
  // it takes one more, then Chrome waits for it.
  await fast.ack(3);
  chromeFrame(browser, id(1));
  await until(() => late.got.includes(4) && fast.got.includes(4));
  await fast.ack(4);
  await settle();
  const before = chromeAcks(browser);
  chromeFrame(browser, id(1));
  await until(() => fast.got.includes(5));
  await fast.ack(5);
  await settle();
  expect(late.got).toEqual([3, 4]);
  expect(chromeAcks(browser)).toBe(before);
  await late.ack(4);
  expect(late.got).toEqual([3, 4, 5]);
  hub.stop();
});

test("each tab has its own frames: a pop-up's viewer that never acknowledges holds only the pop-up", async () => {
  const browser = new FakeBrowser([
    tab(1),
    tab(2, { openerId: id(1), canAccessOpener: true }),
  ]);
  const hub = await flowHub(browser);
  const page = await flowViewer(hub, id(1), true);
  const popup = await flowViewer(hub, id(2), true);
  await until(() => page.got.length === 1 && popup.got.length === 1);
  await page.ack(1);
  await until(() => browser.called("Page.startScreencast").length === 2);
  chromeFrame(browser, id(2));
  await until(() => popup.got.length === 2);
  for (let n = 2; n <= 4; n++) {
    chromeFrame(browser, id(1));
    await until(() => page.got.includes(n));
    await page.ack(n);
  }
  const acked = (target: string) =>
    browser
      .called("Page.screencastFrameAck")
      .filter((call) => call.sessionId === `S-${target}`).length;
  await until(() => acked(id(1)) === 3);
  expect(acked(id(2))).toBe(0);
  hub.stop();
});

// ---- Picture quality (F39's addendum of 2026-10-13) ----------------------------

test("one screencast serves the most demanding viewer: Standard asks for its size × dpr at 70, Data saver for two thirds of its CSS size at 40", () => {
  const viewer = (
    picture: "standard" | "saver",
    width: number,
    height: number,
    dpr: number,
  ) => ({ size: { width, height, dpr }, picture });
  expect(pictureFrames).toEqual({
    standard: { quality: 70 },
    saver: { scale: 2 / 3, quality: 40 },
  });
  expect(screencastFor([])).toBeNull();
  expect(screencastFor([{ size: null, picture: "saver" }])).toBeNull();
  expect(screencastFor([viewer("standard", 700, 500, 2)])).toEqual({
    width: 1400,
    height: 1000,
    quality: 70,
  });
  // Data saver: two thirds of the CSS size, whatever the device pixel
  // ratio, since Chrome draws at device scale 1.
  for (const dpr of [1, 2, 3])
    expect(screencastFor([viewer("saver", 900, 600, dpr)])).toEqual({
      width: 600,
      height: 400,
      quality: 40,
    });
  // Standard and Data saver: Standard's frames for both.
  expect(
    screencastFor([
      viewer("standard", 700, 500, 2),
      viewer("saver", 900, 600, 2),
    ]),
  ).toEqual({ width: 1400, height: 1000, quality: 70 });
  // A viewer that has not said its size asks for nothing yet.
  expect(
    screencastFor([
      viewer("saver", 900, 600, 1),
      { size: null, picture: "standard" },
    ]),
  ).toEqual({ width: 600, height: 400, quality: 40 });
  // Within the protocol's limits.
  expect(screencastFor([viewer("standard", 3000, 2000, 3)])).toEqual({
    width: 3840,
    height: 2400,
    quality: 70,
  });
});

test("viewers of one tab in Standard and Data saver get Standard's frames; Data saver alone, smaller frames at a lower quality", async () => {
  const browser = new FakeBrowser([tab(1)]);
  const { base } = await serve(browser);
  const starts = () =>
    browser.called("Page.startScreencast").map((call) => call.params);
  const standard = await person(base, id(1));
  await until(() => standard.of("info").length > 0);
  standard.send({ t: "hello", width: 700, height: 500, dpr: 2, resize: true });
  await until(() => starts().length === 1);
  expect(starts()[0]).toEqual({
    format: "jpeg",
    quality: 70,
    maxWidth: 1400,
    maxHeight: 1000,
    everyNthFrame: 1,
  });
  const saver = await person(base, id(1));
  await until(() => saver.of("info").length > 0);
  saver.send({
    t: "hello",
    width: 900,
    height: 600,
    dpr: 2,
    resize: false,
    picture: "saver",
  });
  await settle(100);
  // Standard's frames serve both: nothing restarts.
  expect(starts()).toHaveLength(1);
  expect(browser.called("Page.stopScreencast")).toHaveLength(0);
  // The Standard viewer leaves: the screencast restarts once for Data saver.
  standard.socket.close();
  await until(() => starts().length === 2);
  expect(browser.called("Page.stopScreencast")).toHaveLength(1);
  expect(starts()[1]).toEqual({
    format: "jpeg",
    quality: 40,
    maxWidth: 600,
    maxHeight: 400,
    everyNthFrame: 1,
  });
  saver.socket.close();
});

test("a change of the picture quality restarts the screencast once; the same choice again changes nothing, and a hello without one is Standard", async () => {
  const browser = new FakeBrowser([tab(1)]);
  const { base } = await serve(browser);
  const starts = () =>
    browser.called("Page.startScreencast").map((call) => call.params);
  const stops = () => browser.called("Page.stopScreencast").length;
  const view = await person(base, id(1));
  await until(() => view.of("info").length > 0);
  // A page from before the choice says none: Standard.
  view.send({ t: "hello", width: 900, height: 600, dpr: 1, resize: true });
  await until(() => starts().length === 1);
  expect(starts()[0]).toMatchObject({
    quality: 70,
    maxWidth: 900,
    maxHeight: 600,
  });
  view.send({ t: "picture", picture: "saver" });
  await until(() => starts().length === 2);
  expect(stops()).toBe(1);
  expect(starts()[1]).toMatchObject({
    quality: 40,
    maxWidth: 600,
    maxHeight: 400,
  });
  view.send({ t: "picture", picture: "saver" });
  view.send({ t: "size", width: 900, height: 600, dpr: 1 });
  await settle(100);
  expect(starts()).toHaveLength(2);
  expect(stops()).toBe(1);
  view.send({ t: "picture", picture: "standard" });
  await until(() => starts().length === 3);
  expect(stops()).toBe(2);
  expect(starts()[2]).toMatchObject({
    quality: 70,
    maxWidth: 900,
    maxHeight: 600,
  });
  view.socket.close();
});

test("the first screenshot of a watched tab has the quality its viewers chose", async () => {
  const browser = new FakeBrowser([tab(1)]);
  const { base } = await serve(browser);
  const shots = () =>
    browser.called("Page.captureScreenshot").map((call) => call.params);
  const view = await person(base, id(1));
  await until(() => view.of("info").length > 0);
  // Watched before the page said anything: Standard's.
  await until(() => shots().length === 1);
  expect(shots()[0]).toEqual({ format: "jpeg", quality: 70 });
  view.send({
    t: "hello",
    width: 900,
    height: 600,
    dpr: 1,
    resize: true,
    picture: "saver",
  });
  await until(() => browser.called("Page.startScreencast").length === 1);
  // The browser comes back, and the tab is watched again for a viewer in
  // Data saver: its first screenshot and its screencast are Data saver's.
  browser.drop();
  await until(() => browser.connections >= 2 && shots().length === 2);
  expect(shots()[1]).toEqual({ format: "jpeg", quality: 40 });
  await until(() => browser.called("Page.startScreencast").length === 2);
  expect(browser.called("Page.startScreencast")[1]?.params).toMatchObject({
    quality: 40,
    maxWidth: 600,
    maxHeight: 400,
  });
  view.socket.close();
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

// ---- Sleeping tabs (decision F57) ---------------------------------------------

/** The running service's hub, read anew each time. */
const hubNow = () => service?.hub;
const factsOf = (n: number) =>
  hubNow()
    ?.list()
    .find((facts) => facts.id === id(n));
const asleep = (n: number) => factsOf(n)?.sleeping !== undefined;
const pageClosed = (browser: FakeBrowser) =>
  browser.called("Page.close").map((call) => call.sessionId);
/** The window the browser opened at an address (the fake's new targets). */
const opened = (browser: FakeBrowser, url: string) =>
  [...browser.targets.values()].find(
    (target) =>
      target.url === url && Number.parseInt(target.targetId, 16) >= 100,
  )?.targetId;

test("a held tab nobody views and no agent uses sleeps after the idle time: its page closes, and every list keeps it by its id", async () => {
  const browser = new FakeBrowser([
    tab(1, { url: "https://example.com/a", title: "A" }),
    tab(2, { url: "https://example.com/b" }),
  ]);
  const { writes } = await serve(browser, {
    holdsEveryMs: 30,
    idleSleepMs: 200,
    unviewedGraceMs: 60_000,
    holders: { "t3-a": [id(1)] },
  });
  await until(() => asleep(1));
  // Asked to close through the page, so its `beforeunload` may object;
  // never closed as a tab that ends.
  expect(pageClosed(browser)).toEqual([`S-${id(1)}`]);
  expect(closedTargets(browser)).toEqual([]);
  expect(browser.targets.has(id(1))).toBe(false);
  expect(factsOf(1)).toMatchObject({
    url: "https://example.com/a",
    title: "A",
    holders: [{ strip: "t3-a" }],
    agents: [],
    viewers: 0,
    grace: null,
    sleeping: { reason: "idle" },
  });
  // The list of live tabs keeps it, so no app lets go of it.
  await settle(120);
  expect(writes.at(-1)).toContain(id(1));
  // A tab nothing holds is F47's to end, never put to sleep.
  expect(factsOf(2)?.sleeping).toBeUndefined();
  expect(browser.targets.has(id(2))).toBe(true);
  // A sleeping tab has no renderer, so no heap.
  const listed = await service?.hub.listWithHeap();
  expect(listed?.find((facts) => facts.id === id(1))?.heap).toBeNull();
});

test("a tab someone views never sleeps; a view whose page is hidden keeps it no longer, and showing the page wakes it in place", async () => {
  const browser = new FakeBrowser([tab(1, { url: "https://example.com/a" })]);
  const { base } = await serve(browser, {
    holdsEveryMs: 30,
    idleSleepMs: 150,
    holders: { launchpad: [id(1)] },
  });
  const view = await person(base, id(1));
  view.send({
    t: "hello",
    width: 800,
    height: 600,
    dpr: 1,
    resize: true,
    acks: true,
    visible: true,
  });
  await settle(500);
  expect(pageClosed(browser)).toEqual([]);
  // The person's browser hides the page: it sleeps, and the socket waits.
  view.send({ t: "visible", visible: false });
  await until(() => asleep(1));
  expect(view.of("closed")).toEqual([]);
  await settle(100);
  expect(opened(browser, "https://example.com/a")).toBeUndefined();
  // Shown again: the tab opens at its address, in a window of its own at
  // the person's size, under the same id.
  const before = view.messages.length;
  const since = () => view.messages.slice(before);
  view.send({ t: "visible", visible: true });
  await until(() => opened(browser, "https://example.com/a") !== undefined);
  expect(browser.called("Target.createTarget").at(-1)?.params).toEqual({
    url: "https://example.com/a",
    newWindow: true,
    width: 800,
    height: 600,
  });
  await until(() => factsOf(1) !== undefined && !asleep(1));
  await until(() =>
    since().some(
      (m) => "t" in m && m.t === "browser" && m.state === "connected",
    ),
  );
  await until(() => since().some((m) => "frame" in m));
  expect(view.of("closed")).toEqual([]);
});

test("an agent's tab never sleeps under its hands: while its daemon runs, an idle time after, and while its page has input nobody viewed", async () => {
  const browser = new FakeBrowser([
    tab(1, { url: "https://example.com/a" }),
    tab(2, { url: "https://example.com/b" }),
  ]);
  // id(2): an agent drives it over its own DevTools connection (T3 Code's
  // browser tools): its page has input all the time.
  browser.inputAgo.set(id(2), 0);
  const { setHolds } = await serve(browser, {
    holdsEveryMs: 30,
    idleSleepMs: 300,
    working: [id(1)],
    holders: { "t3-a": [id(1), id(2)] },
  });
  await settle(800);
  expect(pageClosed(browser)).toEqual([]);
  // id(1)'s agent stopped: its daemon ended, its binding stays. It sleeps
  // only an idle time after the hub last saw the daemon.
  const stopped = Date.now();
  setHolds({ idle: [id(1)], holders: { "t3-a": [id(1), id(2)] } });
  await until(() => pageClosed(browser).length > 0);
  expect(Date.now() - stopped).toBeGreaterThanOrEqual(200);
  expect(pageClosed(browser)).toEqual([`S-${id(1)}`]);
  // id(2)'s agent stops too: an idle time after its last input it sleeps.
  browser.inputAgo.delete(id(2));
  await until(() => asleep(2));
});

test("a tab with unsaved input stays awake: a changed focused field, or a beforeunload that objects; the list says so, and it is asked again an idle time later", async () => {
  const browser = new FakeBrowser([
    tab(1, { url: "https://example.com/a" }),
    tab(2, { url: "https://example.com/b" }),
  ]);
  browser.unsaved.add(id(1));
  browser.beforeUnload.add(id(2));
  await serve(browser, {
    holdsEveryMs: 30,
    idleSleepMs: 300,
    holders: { launchpad: [id(1), id(2)] },
  });
  await until(() => browser.called("Page.handleJavaScriptDialog").length > 0);
  // The hub answers "stay" itself: nobody views the page.
  expect(browser.called("Page.handleJavaScriptDialog")).toEqual([
    {
      method: "Page.handleJavaScriptDialog",
      params: { accept: false },
      sessionId: `S-${id(2)}`,
    },
  ]);
  // id(1) was never asked to close: its focused field speaks first.
  expect(pageClosed(browser)).toEqual([`S-${id(2)}`]);
  await settle(50);
  for (const n of [1, 2]) {
    expect(browser.targets.has(id(n))).toBe(true);
    expect(factsOf(n)?.sleeping).toBeUndefined();
    expect(Date.parse(String(factsOf(n)?.unsaved))).toBeGreaterThan(0);
  }
  // Not asked again before another idle time.
  await settle(150);
  expect(pageClosed(browser)).toEqual([`S-${id(2)}`]);
  // Saved: it sleeps on a later beat.
  browser.unsaved.delete(id(1));
  await until(() => asleep(1));
  expect(factsOf(1)?.unsaved).toBeUndefined();
});

test("viewing a tab that sleeps opens its address again under the same id; the lists name it by that id, and its viewer works in it", async () => {
  const address = "https://example.com/a?x=1#top";
  const browser = new FakeBrowser([tab(1, { url: address, title: "A" })]);
  const { base, writes } = await serve(browser, {
    holdsEveryMs: 30,
    idleSleepMs: 150,
    holders: { "t3-a": [id(1)] },
  });
  await until(() => asleep(1));
  const view = await person(base, id(1));
  // At once the tab's address and title, from its tombstone.
  await until(() => view.of("info").length > 0);
  expect(view.of("info")[0]).toMatchObject({
    url: address,
    title: "A",
    loading: true,
  });
  await until(() => opened(browser, address) !== undefined);
  const woken = opened(browser, address) as string;
  await until(() => view.of("browser").some((m) => m.state === "connected"));
  // One tab, by its id; the new target's id is in no list of tabs but the
  // list of live tabs, which names both.
  expect(service?.hub.list().map((facts) => facts.id)).toEqual([id(1)]);
  expect(factsOf(1)).toMatchObject({
    viewers: 1,
    holders: [{ strip: "t3-a" }],
  });
  await until(
    () =>
      (writes.at(-1) ?? []).includes(id(1)) &&
      (writes.at(-1) ?? []).includes(woken),
  );
  // Its input goes to the new window.
  view.send({
    t: "mouse",
    type: "mousePressed",
    x: 10,
    y: 10,
    button: "left",
    buttons: 1,
    clickCount: 1,
    modifiers: 0,
  });
  await until(() =>
    browser
      .called("Input.dispatchMouseEvent")
      .some((call) => call.sessionId === `S-${woken}`),
  );
  // Its view, left, keeps it awake no longer than any other: held, it stays.
  view.socket.close();
  await settle(100);
  expect(browser.targets.has(woken)).toBe(true);
});

test("a tab that sleeps ends when nothing holds it after the grace of Vrátit; a hold within it keeps it, and Zavřít ends it for everyone with Vrátit", async () => {
  const browser = new FakeBrowser([
    tab(1, { url: "https://example.com/a" }),
    tab(2, { url: "https://example.com/b" }),
  ]);
  const { base, setHolds, writes } = await serve(browser, {
    holdsEveryMs: 30,
    idleSleepMs: 150,
    releaseGraceMs: 250,
    holders: { "t3-a": [id(1), id(2)] },
  });
  await until(() => asleep(1) && asleep(2));
  // The thread lets go of id(1): its tombstone counts the grace down, and a
  // hold within it keeps it.
  setHolds({ holders: { "t3-a": [id(2)] } });
  await until(() => factsOf(1)?.grace?.kind === "release");
  setHolds({ holders: { "t3-a": [id(1), id(2)] } });
  await until(() => factsOf(1)?.grace === null);
  await settle(350);
  expect(asleep(1)).toBe(true);
  // Let go again: it ends, and the list of live tabs drops it.
  setHolds({ holders: { "t3-a": [id(2)] } });
  await until(() => service?.hub.hasTab(id(1)) === false);
  await until(() => !(writes.at(-1) ?? [id(1)]).includes(id(1)));
  // Zavřít for everyone, and Vrátit within its grace.
  const ask = (action: string) =>
    loopback(base, `/.lazurio/tabs/${id(2)}/${action}`, { method: "POST" });
  expect((await ask("close")).status).toBe(202);
  expect(factsOf(2)?.closing).not.toBeNull();
  expect(await ask("restore")).toEqual({
    status: 200,
    body: { restored: true },
  });
  await settle(350);
  expect(asleep(2)).toBe(true);
  expect((await ask("close")).status).toBe(202);
  await until(() => service?.hub.hasTab(id(2)) === false);
  expect((await ask("restore")).status).toBe(404);
});

test("Uspat and Probudit on loopback: never a tab someone views or an agent works in, nor one with unsaved input or no address to open again", async () => {
  const browser = new FakeBrowser([
    tab(1, { url: "https://example.com/a" }),
    tab(2, { url: "https://example.com/b" }),
    tab(3, { url: "https://example.com/c" }),
    tab(4, { url: "about:blank" }),
  ]);
  browser.unsaved.add(id(3));
  const { base } = await serve(browser, {
    working: [id(2)],
    holders: { launchpad: [id(1), id(2), id(3), id(4)] },
  });
  const view = await person(base, id(1));
  await until(() => view.of("info").length > 0);
  const ask = (n: number, action: string) =>
    loopback(base, `/.lazurio/tabs/${id(n)}/${action}`, { method: "POST" });
  expect(await ask(1, "sleep")).toEqual({
    status: 409,
    body: { error: "viewed" },
  });
  expect(await ask(2, "sleep")).toEqual({
    status: 409,
    body: { error: "agent" },
  });
  expect(await ask(3, "sleep")).toEqual({
    status: 409,
    body: { error: "unsaved" },
  });
  expect(await ask(4, "sleep")).toEqual({
    status: 409,
    body: { error: "not-sleepable" },
  });
  expect((await ask(77, "sleep")).status).toBe(404);
  expect((await ask(77, "wake")).status).toBe(404);
  expect(pageClosed(browser)).toEqual([]);
  // Nobody views it now: Uspat puts it to sleep, at once.
  view.socket.close();
  await until(() => factsOf(1)?.viewers === 0);
  expect(await ask(1, "sleep")).toEqual({
    status: 200,
    body: { sleeping: true },
  });
  expect(factsOf(1)?.sleeping?.reason).toBe("asked");
  expect(await ask(1, "sleep")).toEqual({
    status: 200,
    body: { sleeping: true },
  });
  // Probudit opens it again under its id and answers once it is there.
  expect(await ask(1, "wake")).toEqual({ status: 200, body: { awake: true } });
  expect(factsOf(1)?.sleeping).toBeUndefined();
  expect(opened(browser, "https://example.com/a")).toBeDefined();
  // An awake tab is awake.
  expect(await ask(2, "wake")).toEqual({ status: 200, body: { awake: true } });
  // Probudit is no agent's doing: Uspat puts it to sleep again at once.
  expect(await ask(1, "sleep")).toEqual({
    status: 200,
    body: { sleeping: true },
  });
});

test("no duplicate opens: a strip's tab that shows the page already is that tab, awake or asleep; another strip gets its own; a different query moves only a tab not in use", async () => {
  const browser = new FakeBrowser([
    tab(1, { url: "https://vault.example.com/#/vault" }),
    tab(2, { url: "https://module.example.com/list?page=1" }),
  ]);
  // id(2) is in use: its page has input now.
  browser.inputAgo.set(id(2), 0);
  const { base } = await serve(browser, {
    holdsEveryMs: 30,
    idleSleepMs: 400,
    holders: { launchpad: [id(1)], "t3-a": [id(2)] },
  });
  const open = (url: string, strip: string | null) =>
    loopback(base, "/.lazurio/tabs", { method: "POST", body: { url, strip } });
  // The same address for the same strip: that tab, not a new window.
  expect(await open("https://vault.example.com/#/vault", "launchpad")).toEqual({
    status: 200,
    body: { id: id(1), view: `${origin}/t/${id(1)}`, reused: true },
  });
  expect(browser.called("Target.createTarget")).toEqual([]);
  // Another strip gets a tab of its own.
  const elsewhere = await open("https://vault.example.com/#/vault", "t3-b");
  expect(elsewhere.status).toBe(201);
  expect(elsewhere.body.id).not.toBe(id(1));
  // The same strip asks again for its new tab, which its app has not
  // recorded yet: that tab.
  expect(
    (await open("https://vault.example.com/#/vault", "t3-b")).body.id,
  ).toBe(elsewhere.body.id);
  // A different query on a tab in use: a new tab, the old one untouched.
  const busy = await open("https://module.example.com/list?page=2", "t3-a");
  expect(busy.status).toBe(201);
  expect(browser.called("Page.navigate")).toEqual([]);
  // A page for the person that nothing holds (`lazurio browser link --url`):
  // once quiet, a different query takes it there.
  const link = await open("https://docs.example.com/guide?a=1", null);
  expect(link.status).toBe(201);
  await settle(450);
  const moved = await open("https://docs.example.com/guide?a=2", null);
  expect(moved.body).toMatchObject({ id: link.body.id, reused: true });
  expect(browser.called("Page.navigate")).toEqual([
    {
      method: "Page.navigate",
      params: { url: "https://docs.example.com/guide?a=2" },
      sessionId: `S-${link.body.id}`,
    },
  ]);
  // Asleep, the strip's tab is reused and keeps the new address to wake at.
  await until(() => asleep(1));
  const sleeping = await open("https://vault.example.com/#/send", "launchpad");
  expect(sleeping.body).toMatchObject({ id: id(1), reused: true });
  expect(factsOf(1)).toMatchObject({
    url: "https://vault.example.com/#/send",
    sleeping: { reason: "idle" },
  });
  expect(asleep(2)).toBe(false);
});

test("a restart of the view keeps the tabs that sleep and the woken tabs' ids; a restarted browser keeps none of them", async () => {
  let written: string | null = null;
  const sleepState: HubSeams["sleepState"] = {
    read: async () => written,
    write: async (text) => {
      written = text;
    },
  };
  const browser = new FakeBrowser([
    tab(1, { url: "https://example.com/a" }),
    tab(2, { url: "https://example.com/b" }),
  ]);
  browser.browserId = "browser-one";
  await serve(browser, {
    holdsEveryMs: 30,
    idleSleepMs: 300,
    holders: { "t3-a": [id(1), id(2)] },
    sleepState,
  });
  await until(() => asleep(1) && asleep(2));
  // id(2) woke and is awake under its id.
  expect(await service?.hub.wakeTab(id(2))).toBe(true);
  const woken = opened(browser, "https://example.com/b") as string;
  await until(() => written?.includes(woken) === true);
  await service?.stop();
  service = undefined;
  if (root) await rm(root, { recursive: true, force: true });
  // The view restarts; the browser runs on.
  browser.drop();
  await serve(browser, {
    holdsEveryMs: 60_000,
    holders: { "t3-a": [id(1), id(2)] },
    sleepState,
  });
  expect(factsOf(1)?.sleeping?.reason).toBe("idle");
  expect(factsOf(2)?.sleeping).toBeUndefined();
  expect(
    hubNow()
      ?.list()
      .map((facts) => facts.id)
      .sort(),
  ).toEqual([id(1), id(2)].sort());
  expect(hubNow()?.hasTab(woken)).toBe(true);
  // The browser restarts: no tab of it comes back, asleep or awake.
  browser.drop();
  browser.browserId = "browser-two";
  browser.targets.delete(woken);
  await until(() => hubNow()?.ready === true && !asleep(1));
  await until(() => hubNow()?.hasTab(id(1)) === false);
  expect(hubNow()?.hasTab(id(2))).toBe(false);
});
