import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { noHolds } from "../src/browser/contract/node";
import type { CdpConnection, CdpEvent } from "../src/browser/people/cdp";
import {
  chooserAsk,
  maxNameBytes,
  maxPathDepth,
  pasteIsFiles,
  readUpload,
  uploadFields,
  uploadName,
  uploadSegments,
} from "../src/browser/people/files";
import { FrameSessions } from "../src/browser/people/frame-sessions";
import type { ServerMessage } from "../src/browser/people/protocol";
import {
  startViewService,
  type ViewService,
} from "../src/browser/people/service";
import { chooserPaths, writeUpload } from "../src/browser/people/uploads";

// Files from a person's computer to a remote page (decision F39 point 7,
// #973): the names, the upload's form, the chooser's ask, the frames of
// other sites and the drop and the paste, against a scripted DevTools peer.

const origin = "https://browser.pilot.example.lazurio.io";
const host = new URL(origin).host;
const id = (n: number) => n.toString(16).toUpperCase().padStart(32, "0");
const page = id(1);
const pageSession = `S-${page}`;
const frameTarget = id(0xf1);
const frameSession = "S-FRAME-1";
const innerTarget = id(0xf2);
const innerSession = "S-FRAME-2";
const utf8 = (text: string) => new TextEncoder().encode(text).length;

// ---- Names (files.ts) ----------------------------------------------------------

test("a file keeps the person's name: Unicode and spaces arrive unchanged", () => {
  expect(uploadName("Výpis z OR – 2026.pdf")).toBe("Výpis z OR – 2026.pdf");
  expect(uploadName("občanka přední strana.jpg")).toBe(
    "občanka přední strana.jpg",
  );
  expect(uploadName("報告書 2026.xlsx")).toBe("報告書 2026.xlsx");
  expect(uploadName("  mezery  .txt")).toBe("  mezery  .txt");
});

test("only path separators, control characters and leading dots go", () => {
  expect(uploadName("../../etc/passwd")).toBe("etcpasswd");
  expect(uploadName("C:\\fakepath\\scan.png")).toBe("C:fakepathscan.png");
  expect(uploadName("a\u0000b\u0007c\u001bd\u007fe\u0085f.txt")).toBe(
    "abcdef.txt",
  );
  expect(uploadName(".bashrc")).toBe("bashrc");
  expect(uploadName("...tajné")).toBe("tajné");
  expect(uploadName("smlouva.v2.pdf")).toBe("smlouva.v2.pdf");
  for (const nothing of ["", ".", "..", "/", "\u0000", "./"])
    expect(uploadName(nothing)).toBe("file");
});

test("a long name is cut to 255 bytes of UTF-8 at a whole character, before its extension", () => {
  const long = `${"č".repeat(200)}.pdf`;
  const cut = uploadName(long);
  expect(utf8(cut)).toBeLessThanOrEqual(maxNameBytes);
  expect(cut.endsWith(".pdf")).toBe(true);
  expect(cut.startsWith("č")).toBe(true);
  // No character is broken: the cut text encodes to itself.
  expect(
    new TextDecoder("utf-8", { fatal: true }).decode(
      new TextEncoder().encode(cut),
    ),
  ).toBe(cut);
  const emoji = "😀".repeat(100);
  expect(utf8(uploadName(emoji))).toBeLessThanOrEqual(maxNameBytes);
  expect(uploadName(emoji).length % 2).toBe(0);
  const short = "a".repeat(255);
  expect(uploadName(short)).toBe(short);
});

test("a place in a folder keeps its segments and drops what would climb out", () => {
  expect(uploadSegments("Složka s mezerou/pod/b č.txt")).toEqual([
    "Složka s mezerou",
    "pod",
    "b č.txt",
  ]);
  expect(uploadSegments("a/../b/./c")).toEqual(["a", "b", "c"]);
  expect(uploadSegments("/a//b/")).toEqual(["a", "b"]);
  expect(uploadSegments("../..")).toBeNull();
  expect(uploadSegments("")).toBeNull();
  expect(
    uploadSegments(
      Array.from({ length: maxPathDepth + 1 }, () => "d").join("/"),
    ),
  ).toBeNull();
});

// ---- The upload's form ----------------------------------------------------------

const formOf = (
  files: readonly File[],
  extra: Readonly<Record<string, string | readonly string[]>> = {},
) => {
  const form = new FormData();
  for (const file of files) form.append(uploadFields.file, file);
  for (const [name, value] of Object.entries(extra))
    for (const one of typeof value === "string" ? [value] : value)
      form.append(name, one);
  return form;
};

test("the upload's form names its files, their places and how the page gets them", () => {
  const a = new File(["a"], "a.txt");
  const b = new File(["b"], "b.txt");
  expect(readUpload(formOf([a]))).toEqual({
    entries: [{ file: expect.any(File), path: null }],
    delivery: { kind: "chooser" },
  });
  expect(
    readUpload(
      formOf([a, b], { path: ["Složka/a.txt", "Složka/pod/b.txt"] }),
    )?.entries.map((entry) => entry.path),
  ).toEqual([
    ["Složka", "a.txt"],
    ["Složka", "pod", "b.txt"],
  ]);
  expect(
    readUpload(formOf([a], { deliver: "drop", x: "120", y: "48.5" }))?.delivery,
  ).toEqual({ kind: "drop", x: 120, y: 48.5 });
  expect(readUpload(formOf([a], { deliver: "paste" }))?.delivery).toEqual({
    kind: "paste",
  });
  // What the view never sends.
  expect(readUpload(formOf([]))).toBeNull();
  expect(readUpload(formOf([a], { deliver: "print" }))).toBeNull();
  expect(readUpload(formOf([a], { deliver: "drop", x: "1" }))).toBeNull();
  expect(
    readUpload(formOf([a], { deliver: "drop", x: "NaN", y: "1" })),
  ).toBeNull();
  expect(readUpload(formOf([a, b], { path: ["x/a.txt"] }))).toBeNull();
  expect(readUpload(formOf([a], { path: "../.." }))).toBeNull();
  const text = new FormData();
  text.append(uploadFields.file, "not a file");
  expect(readUpload(text)).toBeNull();
});

test("a chooser asks for what its input says: several files, its types, a folder", () => {
  expect(chooserAsk("selectSingle", ["id", "f", "type", "file"])).toEqual({
    multiple: false,
    accept: null,
    directory: false,
  });
  expect(
    chooserAsk("selectSingle", [
      "type",
      "file",
      "multiple",
      "",
      "accept",
      " image/*,.pdf ",
    ]),
  ).toEqual({ multiple: true, accept: "image/*,.pdf", directory: false });
  expect(
    chooserAsk("selectSingle", ["type", "file", "webkitdirectory", ""]),
  ).toEqual({ multiple: false, accept: null, directory: true });
  expect(chooserAsk("selectMultiple", undefined).multiple).toBe(true);
  expect(chooserAsk("selectSingle", ["accept", ""]).accept).toBeNull();
});

test("a paste gives files for a screenshot or a copied file, text for an office copy", () => {
  expect(pasteIsFiles("", ["image.png"])).toBe(true);
  expect(pasteIsFiles("Výpis z OR – 2026.pdf", ["Výpis z OR – 2026.pdf"])).toBe(
    true,
  );
  expect(
    pasteIsFiles("/home/ana/Dokumenty/smlouva.pdf\n", ["smlouva.pdf"]),
  ).toBe(true);
  expect(pasteIsFiles("file:///home/ana/V%C3%BDpis.pdf", ["Výpis.pdf"])).toBe(
    true,
  );
  // A table copied from a spreadsheet brings a picture of itself.
  expect(pasteIsFiles("Položka\tCena\nKáva\t49", ["image.png"])).toBe(false);
  expect(pasteIsFiles("jen text", [])).toBe(false);
  expect(pasteIsFiles("", [])).toBe(false);
});

// ---- Writing (uploads.ts) -------------------------------------------------------

let root: string | undefined;
let service: ViewService | undefined;
afterEach(async () => {
  await service?.stop();
  service = undefined;
  if (root !== undefined) await rm(root, { recursive: true, force: true });
  root = undefined;
});

test("an upload is written owner-only in a folder of its own, a folder's files at their places", async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "view-files-")));
  const uploads = join(root, "uploads");
  const written = await writeUpload(uploads, [
    { file: new File(["1"], "Výpis z OR – 2026.pdf"), path: null },
    { file: new File(["2"], "Výpis z OR – 2026.pdf"), path: null },
    { file: new File(["a"], "a.txt"), path: ["Složka", "a.txt"] },
    { file: new File(["b"], "b č.txt"), path: ["Složka", "pod", "b č.txt"] },
  ]);
  expect(written.files).toHaveLength(4);
  // Two files of one name both arrive under it.
  expect(written.files[0]?.endsWith("/0/Výpis z OR – 2026.pdf")).toBe(true);
  expect(written.files[1]?.endsWith("/1/Výpis z OR – 2026.pdf")).toBe(true);
  expect(written.folders).toEqual([join(written.folder, "tree", "Složka")]);
  expect(written.given).toEqual([
    written.files[0] as string,
    written.files[1] as string,
    join(written.folder, "tree", "Složka"),
  ]);
  expect(
    await readFile(
      join(written.folder, "tree", "Složka", "pod", "b č.txt"),
      "utf8",
    ),
  ).toBe("b");
  expect((await stat(uploads)).mode & 0o777).toBe(0o700);
  expect((await stat(written.folder)).mode & 0o777).toBe(0o700);
  expect((await stat(written.files[3] as string)).mode & 0o777).toBe(0o600);
  // A place that comes twice is refused and nothing stays.
  await expect(
    writeUpload(uploads, [
      { file: new File(["x"], "x"), path: ["D", "x"] },
      { file: new File(["y"], "x"), path: ["D", "x"] },
    ]),
  ).rejects.toThrow();
});

test("a chooser takes one folder for a folder, its files otherwise", () => {
  const files = {
    folder: "/u/1",
    files: ["/u/1/0/a", "/u/1/1/b"],
    folders: [],
    given: ["/u/1/0/a", "/u/1/1/b"],
  };
  const folder = {
    folder: "/u/2",
    files: ["/u/2/tree/D/a"],
    folders: ["/u/2/tree/D"],
    given: ["/u/2/tree/D"],
  };
  const ask = { multiple: false, accept: null, directory: false };
  expect(chooserPaths({ ...ask, multiple: true }, files)).toEqual(files.files);
  expect(chooserPaths(ask, files)).toBeNull();
  expect(chooserPaths({ ...ask, directory: true }, folder)).toEqual([
    "/u/2/tree/D",
  ]);
  expect(chooserPaths({ ...ask, directory: true }, files)).toBeNull();
  expect(chooserPaths({ ...ask, multiple: true }, folder)).toBeNull();
});

test("a frame's session belongs to its tab, and goes with the session it came under", () => {
  const frames = new FrameSessions();
  frames.add(page, pageSession, frameSession, frameTarget);
  frames.add(page, frameSession, innerSession, innerTarget);
  frames.add(id(2), `S-${id(2)}`, "S-OTHER", id(0xf3));
  expect(frames.get(innerSession)?.tab).toBe(page);
  expect(frames.ofFrame(page, innerTarget)?.session).toBe(innerSession);
  expect(frames.ofFrame(id(2), innerTarget)).toBeUndefined();
  expect(frames.remove(frameSession).sort()).toEqual(
    [frameSession, innerSession].sort(),
  );
  expect(frames.size).toBe(1);
  frames.removeTab(id(2));
  expect(frames.size).toBe(0);
});

// ---- The hub against a scripted DevTools peer -------------------------------------

type Call = {
  method: string;
  params: Record<string, unknown>;
  session?: string;
};

// The smallest bytes the hub's frame reader takes: SOI and a baseline SOF0.
const jpeg = Buffer.from([
  0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x02, 0x00, 0x03, 0x03, 0x01,
  0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9,
]);

/** A browser with one page that answers what the hub asks, its inputs'
 * attributes by session and backend node, and where the focus is. */
class FakeBrowser {
  readonly calls: Call[] = [];
  private listeners: ((event: CdpEvent) => void)[] = [];
  private closers: (() => void)[] = [];
  open = false;
  /** `DOM.describeNode` of a backend node, by `<session> <node>`. */
  readonly inputs = new Map<string, unknown[]>();
  /** The session whose document has the focus inside a frame, or none. */
  focusIn: string | null = null;

  connect = async (): Promise<CdpConnection> => {
    this.open = true;
    this.listeners = [];
    this.closers = [];
    return {
      send: async (method, params = {}, session) => {
        if (!this.open) throw new Error("closed");
        this.calls.push({
          method,
          params: { ...params },
          ...(session === undefined ? {} : { session }),
        });
        return this.answer(method, params as Record<string, unknown>, session);
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

  emit(method: string, params: Record<string, unknown>, session?: string) {
    for (const listener of this.listeners)
      listener({ method, params, ...(session ? { sessionId: session } : {}) });
  }

  called(method: string, session?: string): Call[] {
    return this.calls.filter(
      (call) =>
        call.method === method &&
        (session === undefined || call.session === session),
    );
  }

  /** A frame of another site attached under `parent`, as Chrome's
   * auto-attach reports it. */
  frame(parent: string, session: string, targetId: string): void {
    this.emit(
      "Target.attachedToTarget",
      {
        sessionId: session,
        targetInfo: { targetId, type: "iframe", url: "http://localhost:8702/" },
        waitingForDebugger: false,
      },
      parent,
    );
  }

  private answer(
    method: string,
    params: Record<string, unknown>,
    session?: string,
  ): Record<string, unknown> {
    switch (method) {
      case "Target.setDiscoverTargets":
        for (const targetId of [id(0xb1a4c), page])
          this.emit("Target.targetCreated", {
            targetInfo: {
              type: "page",
              targetId,
              url: targetId === page ? "https://example.com/" : "about:blank",
              title: "",
              attached: false,
            },
          });
        return {};
      case "Target.attachToTarget":
        return { sessionId: `S-${params.targetId}` };
      case "Page.getFrameTree":
        return { frameTree: { frame: { id: `F-${session}` } } };
      case "Page.getNavigationHistory":
        return { currentIndex: 0, entries: [{ id: 1 }] };
      case "Page.captureScreenshot":
        return { data: jpeg.toString("base64") };
      case "Page.getLayoutMetrics":
        return { cssLayoutViewport: { clientWidth: 1280, clientHeight: 800 } };
      case "Browser.getWindowForTarget":
        return { windowId: 7, bounds: { width: 1280, height: 885 } };
      case "Page.createIsolatedWorld":
        return { executionContextId: 9 };
      case "DOM.describeNode": {
        if (typeof params.backendNodeId === "number")
          return {
            node: {
              nodeName: "INPUT",
              attributes: this.inputs.get(
                `${session} ${params.backendNodeId}`,
              ) ?? ["type", "file"],
            },
          };
        // The focused element: the frame of another site while the focus is
        // in it, else a field.
        if (session === pageSession && this.focusIn === frameSession)
          return { node: { nodeName: "IFRAME", frameId: frameTarget } };
        return { node: { nodeName: "TEXTAREA" } };
      }
      case "Runtime.evaluate":
        if (params.contextId === 9)
          return { result: { type: "object", objectId: `focused ${session}` } };
        return { result: { value: JSON.stringify({ title: "", icon: "" }) } };
      case "Runtime.callFunctionOn":
        return String(params.functionDeclaration).includes("createElement")
          ? { result: { type: "object", objectId: `input ${session}` } }
          : { result: { value: 1 } };
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

async function serve(browser: FakeBrowser) {
  root = await realpath(await mkdtemp(join(tmpdir(), "view-files-")));
  const logs: string[] = [];
  service = startViewService({
    origin,
    port: 0,
    log: (line) => logs.push(line),
    hub: {
      connect: browser.connect,
      holds: async () => noHolds,
      uploadDirectory: join(root, "uploads"),
      screen: { width: 1920, height: 1080 },
      log: (line) => logs.push(line),
      graceMs: 60_000,
      unviewedGraceMs: 60_000,
      releaseGraceMs: 60_000,
      holdsEveryMs: 60_000,
      reconnectMs: 20,
    },
  });
  await until(() => service?.hub.ready === true);
  await until(
    () => browser.called("Target.setAutoAttach", pageSession).length > 0,
  );
  return { base: `http://127.0.0.1:${service.server.port}`, logs };
}

async function person(base: string, targetId: string) {
  const messages: ServerMessage[] = [];
  const socket = new WebSocket(
    `${base.replace("http", "ws")}/t/${targetId}/live`,
    { headers: { Host: host, Origin: origin } } as unknown as string[],
  );
  socket.addEventListener("message", (event) => {
    if (typeof event.data === "string")
      messages.push(JSON.parse(event.data) as ServerMessage);
  });
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve());
    socket.addEventListener("error", () => reject(new Error("socket error")));
  });
  const of = <K extends ServerMessage["t"]>(t: K) =>
    messages.filter((m): m is Extract<ServerMessage, { t: K }> => m.t === t);
  await until(() => of("upload-token").length > 0);
  return {
    socket,
    of,
    token: (of("upload-token")[0] as { token: string }).token,
  };
}

const post = (base: string, token: string, form: FormData) =>
  fetch(`${base}/t/${page}/files?token=${token}`, {
    method: "POST",
    headers: { Host: host, Origin: origin },
    body: form,
  });

test("a frame of another site is attached under its page, asked for its choosers, and answered on its own session", async () => {
  const browser = new FakeBrowser();
  const { base } = await serve(browser);
  expect(
    browser.called("Target.setAutoAttach", pageSession)[0]?.params,
  ).toEqual({
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: true,
    filter: [{ type: "iframe" }],
  });
  browser.frame(pageSession, frameSession, frameTarget);
  await until(
    () => browser.called("Target.setAutoAttach", frameSession).length > 0,
  );
  expect(browser.called("Page.enable", frameSession)).toHaveLength(1);
  expect(
    browser.called("Page.setInterceptFileChooserDialog", frameSession)[0]
      ?.params,
  ).toEqual({ enabled: true });
  const view = await person(base, page);
  browser.inputs.set(`${frameSession} 3`, [
    "type",
    "file",
    "accept",
    ".pdf,image/*",
  ]);
  browser.emit(
    "Page.fileChooserOpened",
    { frameId: frameTarget, mode: "selectSingle", backendNodeId: 3 },
    frameSession,
  );
  await until(() => view.of("files").length > 0);
  const asked = view.of("files")[0];
  expect(asked).toEqual({
    t: "files",
    multiple: false,
    token: expect.any(String),
    accept: ".pdf,image/*",
  });
  const uploaded = await post(
    base,
    asked?.token ?? "",
    formOf([new File(["obsah"], "Výpis z OR – 2026.pdf")]),
  );
  expect(uploaded.status).toBe(204);
  const set = browser.called("DOM.setFileInputFiles")[0];
  if (set === undefined) throw new Error("no setFileInputFiles");
  expect(set.session).toBe(frameSession);
  expect(set.params.backendNodeId).toBe(3);
  const [path] = set.params.files as string[];
  expect(path?.endsWith("/0/Výpis z OR – 2026.pdf")).toBe(true);
  expect(await readFile(path as string, "utf8")).toBe("obsah");
  await until(() => view.of("files-closed").length > 0);
  view.socket.close();
});

test("a frame's own navigations and loads leave the tab as its main frame has it (decision F57)", async () => {
  const browser = new FakeBrowser();
  const { base } = await serve(browser);
  browser.frame(pageSession, frameSession, frameTarget);
  await until(
    () => browser.called("Target.setAutoAttach", frameSession).length > 0,
  );
  const view = await person(base, page);
  await until(() => view.of("info").length > 0);
  const infos = view.of("info").length;
  browser.emit(
    "Page.frameNavigated",
    { frame: { id: frameTarget, url: "http://localhost:8702/next" } },
    frameSession,
  );
  browser.emit(
    "Page.frameStartedLoading",
    { frameId: frameTarget },
    frameSession,
  );
  await settle(100);
  expect(view.of("info")).toHaveLength(infos);
  expect(service?.hub.list().find((tab) => tab.id === page)?.url).toBe(
    "https://example.com/",
  );
  view.socket.close();
});

test("a frame under a frame is attached too, and goes when its parent detaches", async () => {
  const browser = new FakeBrowser();
  const { base, logs } = await serve(browser);
  browser.frame(pageSession, frameSession, frameTarget);
  browser.frame(frameSession, innerSession, innerTarget);
  await until(
    () => browser.called("Target.setAutoAttach", innerSession).length > 0,
  );
  const view = await person(base, page);
  browser.emit(
    "Target.detachedFromTarget",
    { sessionId: frameSession, targetId: frameTarget },
    pageSession,
  );
  browser.emit(
    "Page.fileChooserOpened",
    { frameId: innerTarget, mode: "selectSingle", backendNodeId: 5 },
    innerSession,
  );
  await settle(100);
  expect(view.of("files")).toHaveLength(0);
  // A frame whose parent the hub does not know is let go.
  browser.frame("S-UNKNOWN", "S-STRAY", id(0xf9));
  await until(() =>
    browser
      .called("Target.detachFromTarget")
      .some((call) => call.params.sessionId === "S-STRAY"),
  );
  expect(logs.some((line) => line.includes("incomplete"))).toBe(false);
  view.socket.close();
});

test("a folder chooser gets one folder whose files keep their places", async () => {
  const browser = new FakeBrowser();
  const { base } = await serve(browser);
  const view = await person(base, page);
  browser.inputs.set(`${pageSession} 17`, [
    "type",
    "file",
    "webkitdirectory",
    "",
  ]);
  browser.emit(
    "Page.fileChooserOpened",
    { frameId: "F", mode: "selectSingle", backendNodeId: 17 },
    pageSession,
  );
  await until(() => view.of("files").length > 0);
  const asked = view.of("files")[0];
  expect(asked?.directory).toBe(true);
  const token = asked?.token ?? "";
  // Files without their places are not a folder.
  const loose = await post(base, token, formOf([new File(["a"], "a.txt")]));
  expect(loose.status).toBe(409);
  browser.emit(
    "Page.fileChooserOpened",
    { frameId: "F", mode: "selectSingle", backendNodeId: 17 },
    pageSession,
  );
  await until(() => view.of("files").length > 1);
  const again = view.of("files")[1]?.token ?? "";
  const done = await post(
    base,
    again,
    formOf([new File(["a"], "a.txt"), new File(["b"], "b č.txt")], {
      path: ["Složka s mezerou/a.txt", "Složka s mezerou/pod/b č.txt"],
    }),
  );
  expect(done.status).toBe(204);
  const set = browser.called("DOM.setFileInputFiles")[0];
  const files = set?.params.files as string[];
  expect(files).toHaveLength(1);
  expect(files[0]?.endsWith("/tree/Složka s mezerou")).toBe(true);
  expect(
    await readFile(join(files[0] as string, "pod", "b č.txt"), "utf8"),
  ).toBe("b");
  view.socket.close();
});

test("a chooser without an input is refused in the view, with no token to upload to", async () => {
  const browser = new FakeBrowser();
  const { base, logs } = await serve(browser);
  const view = await person(base, page);
  browser.emit(
    "Page.fileChooserOpened",
    { frameId: "F", mode: "selectSingle" },
    pageSession,
  );
  await until(() => view.of("files-refused").length > 0);
  expect(view.of("files-refused")[0]).toEqual({
    t: "files-refused",
    reason: "no-input",
  });
  expect(view.of("files")).toHaveLength(0);
  expect(logs.some((line) => line.includes("without an input"))).toBe(true);
  view.socket.close();
});

test("a drop puts the files on the page at the person's point, as a drag from the desktop", async () => {
  const browser = new FakeBrowser();
  const { base } = await serve(browser);
  const view = await person(base, page);
  const done = await post(
    base,
    view.token,
    formOf(
      [
        new File(["1"], "Výpis z OR – 2026.pdf"),
        new File(["a"], "a.txt"),
        new File(["b"], "b.txt"),
      ],
      {
        path: ["", "Složka/a.txt", "Složka/b.txt"],
        deliver: "drop",
        x: "310",
        y: "212",
      },
    ),
  );
  expect(done.status).toBe(204);
  const drags = browser.called("Input.dispatchDragEvent", pageSession);
  expect(drags.map((call) => call.params.type)).toEqual([
    "dragEnter",
    "dragOver",
    "drop",
  ]);
  for (const drag of drags) {
    expect(drag.params.x).toBe(310);
    expect(drag.params.y).toBe(212);
  }
  const data = drags[2]?.params.data as {
    files: string[];
    dragOperationsMask: number;
  };
  // The file on its own, and the folder once at its top.
  expect(data.files).toHaveLength(2);
  expect(data.files[0]?.endsWith("/0/Výpis z OR – 2026.pdf")).toBe(true);
  expect(data.files[1]?.endsWith("/tree/Složka")).toBe(true);
  expect(data.dragOperationsMask).toBe(1 | 2 | 16);
  view.socket.close();
});

test("a paste goes to the focused element, in the frame of another site that has the focus", async () => {
  const browser = new FakeBrowser();
  const { base } = await serve(browser);
  browser.frame(pageSession, frameSession, frameTarget);
  await until(
    () => browser.called("Target.setAutoAttach", frameSession).length > 0,
  );
  const view = await person(base, page);
  const pasted = await post(
    base,
    view.token,
    formOf([new File(["png"], "Snímek obrazovky 2026-11-14.png")], {
      deliver: "paste",
    }),
  );
  expect(pasted.status).toBe(204);
  const [set] = browser.called("DOM.setFileInputFiles");
  if (set === undefined) throw new Error("no setFileInputFiles");
  expect(set.session).toBe(pageSession);
  expect(set.params.objectId).toBe(`input ${pageSession}`);
  expect(
    (set.params.files as string[])[0]?.endsWith(
      "/0/Snímek obrazovky 2026-11-14.png",
    ),
  ).toBe(true);
  const paste = browser
    .called("Runtime.callFunctionOn", pageSession)
    .find((call) => String(call.params.functionDeclaration).includes("paste"));
  expect(paste?.params.objectId).toBe(`input ${pageSession}`);
  expect(paste?.params.arguments).toEqual([
    { objectId: `focused ${pageSession}` },
  ]);
  // Now the focus is in the frame: the paste goes on there.
  browser.focusIn = frameSession;
  const inFrame = await post(
    base,
    view.token,
    formOf([new File(["png"], "a.png")], { deliver: "paste" }),
  );
  expect(inFrame.status).toBe(204);
  expect(
    browser.called("Page.createIsolatedWorld", frameSession)[0]?.params,
  ).toEqual({ frameId: frameTarget, worldName: "lazurio-view-files" });
  expect(browser.called("DOM.setFileInputFiles", frameSession)).toHaveLength(1);
  // The view's objects are let go in every session the paste used.
  await until(
    () => browser.called("Runtime.releaseObjectGroup", frameSession).length > 0,
  );
  view.socket.close();
});

test("a viewer's token drops and pastes only while that viewer views the tab; a chooser's token only answers its chooser", async () => {
  const browser = new FakeBrowser();
  const { base } = await serve(browser);
  const first = await person(base, page);
  const second = await person(base, page);
  expect(first.token).not.toBe(second.token);
  const drop = () =>
    formOf([new File(["x"], "x.txt")], { deliver: "drop", x: "1", y: "1" });
  // A viewer's token is no chooser's.
  expect(
    (await post(base, first.token, formOf([new File(["x"], "x")]))).status,
  ).toBe(409);
  // A chooser's token is no drop, and stays its chooser's.
  browser.emit(
    "Page.fileChooserOpened",
    { frameId: "F", mode: "selectSingle", backendNodeId: 8 },
    pageSession,
  );
  await until(() => first.of("files").length > 0);
  const chooser = first.of("files")[0]?.token ?? "";
  expect((await post(base, chooser, drop())).status).toBe(409);
  expect(
    (await post(base, chooser, formOf([new File(["x"], "x")]))).status,
  ).toBe(204);
  first.socket.close();
  await settle(50);
  expect((await post(base, first.token, drop())).status).toBe(409);
  expect((await post(base, second.token, drop())).status).toBe(204);
  expect((await post(base, "0".repeat(24), drop())).status).toBe(409);
  second.socket.close();
});

test("a lost browser forgets the frames' sessions", async () => {
  const browser = new FakeBrowser();
  const { base } = await serve(browser);
  browser.frame(pageSession, frameSession, frameTarget);
  await until(
    () => browser.called("Target.setAutoAttach", frameSession).length > 0,
  );
  browser.drop();
  await until(() => browser.open && service?.hub.ready === true);
  await until(
    () => browser.called("Target.setAutoAttach", pageSession).length > 1,
  );
  const view = await person(base, page);
  browser.emit(
    "Page.fileChooserOpened",
    { frameId: frameTarget, mode: "selectSingle", backendNodeId: 3 },
    frameSession,
  );
  await settle(100);
  expect(view.of("files")).toHaveLength(0);
  view.socket.close();
});
