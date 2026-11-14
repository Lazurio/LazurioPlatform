import { randomBytes } from "node:crypto";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type ChooserAsk,
  chooserAsk,
  type Upload,
  type UploadEntry,
  uploadName,
} from "./files";

/** The hub's side of the files a person gives a remote page (decision F39
 * point 7, #973): writing them on the Environment and handing them to the
 * page over DevTools. The rules they follow are `files.ts`; which session
 * reaches which frame is `frame-sessions.ts`. */

type Send = (
  method: string,
  params?: Readonly<Record<string, unknown>>,
  sessionId?: string,
) => Promise<Record<string, unknown>>;

/** A file chooser a page opened, until the person answers it in the view:
 * the session it came on (the page's, or its frame's for a frame of another
 * site), its input there and what it asks for. */
export type Chooser = Readonly<{
  targetId: string;
  session: string;
  backendNodeId: number;
  ask: ChooserAsk;
}>;

/** What a chooser asks for, read from its input on its own session. A read
 * that fails asks for what the chooser's mode says, and any file. */
export async function readChooserAsk(
  send: Send,
  session: string,
  backendNodeId: number,
  mode: unknown,
): Promise<ChooserAsk> {
  try {
    const described = await send(
      "DOM.describeNode",
      { backendNodeId },
      session,
    );
    return chooserAsk(
      mode,
      (described.node as { attributes?: unknown } | undefined)?.attributes,
    );
  } catch {
    return chooserAsk(mode, []);
  }
}

/** One token per kind of upload. A chooser's is good once, for its chooser;
 * a viewer's (`ViewerTokens`) for the files that viewer drops or pastes, as
 * long as its socket views the tab. Both are 24 hexadecimal digits. */
export const newToken = (): string => randomBytes(12).toString("hex");

/** The tokens viewers drop and paste files with: one per socket, sent when
 * it attaches (`upload-token`), gone when it detaches. */
export class ViewerTokens<Viewer> {
  private readonly viewers = new Map<string, Viewer>();
  private readonly tokens = new Map<Viewer, string>();

  issue(viewer: Viewer): string {
    const known = this.tokens.get(viewer);
    if (known !== undefined) return known;
    const token = newToken();
    this.viewers.set(token, viewer);
    this.tokens.set(viewer, token);
    return token;
  }

  viewer(token: string): Viewer | undefined {
    return this.viewers.get(token);
  }

  forget(viewer: Viewer): void {
    const token = this.tokens.get(viewer);
    if (token === undefined) return;
    this.tokens.delete(viewer);
    this.viewers.delete(token);
  }
}

/** An upload written on the Environment: its folder, and the paths the page
 * is given, in the person's order: each file on its own, and each folder
 * the person gave once, at its top. */
export type Written = Readonly<{
  folder: string;
  files: readonly string[];
  folders: readonly string[];
  given: readonly string[];
}>;

/** Writes an upload into a new folder of its own under `root`, owner-only
 * (0700, files 0600). A file on its own lands in `<n>/<name>`, so two files
 * of one name both arrive under their own names; a folder's files at their
 * places under `tree/`. The names are the person's (`uploadName`). Throws
 * when a place comes twice or the disk refuses; nothing half-written is
 * given to the page. */
export async function writeUpload(
  root: string,
  entries: readonly UploadEntry[],
): Promise<Written> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const folder = join(root, newToken());
  await mkdir(folder, { mode: 0o700 });
  const files: string[] = [];
  const folders: string[] = [];
  const given: string[] = [];
  try {
    for (const [index, { file, path }] of entries.entries()) {
      let target: string;
      if (path === null || path.length === 1) {
        const place = join(folder, String(index));
        await mkdir(place, { mode: 0o700 });
        target = join(place, path?.[0] ?? uploadName(file.name));
        given.push(target);
      } else {
        const top = join(folder, "tree", path[0] as string);
        if (!folders.includes(top)) {
          folders.push(top);
          given.push(top);
        }
        const place = join(folder, "tree", ...path.slice(0, -1));
        await mkdir(place, { recursive: true, mode: 0o700 });
        target = join(place, path[path.length - 1] as string);
      }
      // `wx`: a place that came twice is refused, never overwritten.
      await writeFile(target, new Uint8Array(await file.arrayBuffer()), {
        mode: 0o600,
        flag: "wx",
      });
      files.push(target);
    }
  } catch (error) {
    await rm(folder, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  return { folder, files, folders, given };
}

/** The paths a chooser's input takes, or null for an upload it cannot take:
 * for a folder (`webkitdirectory`) exactly one folder, which Chrome reads
 * itself so the page gets every file with its `webkitRelativePath`; else
 * the files, one unless it takes several. */
export function chooserPaths(
  ask: ChooserAsk,
  written: Written,
): readonly string[] | null {
  if (ask.directory)
    return written.folders.length === 1 &&
      written.given.length === 1 &&
      written.given[0] === written.folders[0]
      ? written.folders
      : null;
  if (written.folders.length > 0) return null;
  if (!ask.multiple && written.files.length > 1) return null;
  return written.files;
}

/** Drops files on the page at a point of its viewport (CSS pixels), as a
 * drag from the person's desktop would: Chrome sends `dragenter`,
 * `dragover` and `drop` to the element there, in a frame of another site
 * too, and a file input there takes the files as its own drop. A place
 * where nothing takes the drop leaves the page as it was. */
export async function dropFiles(
  send: Send,
  session: string,
  at: Readonly<{ x: number; y: number }>,
  paths: readonly string[],
): Promise<void> {
  // Copy, link and move, as a file manager offers them.
  const data = { items: [], files: [...paths], dragOperationsMask: 1 | 2 | 16 };
  for (const type of ["dragEnter", "dragOver", "drop"] as const)
    await send(
      "Input.dispatchDragEvent",
      { type, x: at.x, y: at.y, data },
      session,
    );
}

const objectGroup = "lazurio-view-files";
const worldName = "lazurio-view-files";

// The element that has the focus, through the shadow roots and the frames
// this document can reach; a frame it cannot reach (another origin) is
// answered as itself, and the hub goes on in that frame.
const focusedScript = `(() => {
  let doc = document;
  for (let depth = 0; depth < 16; depth++) {
    let el = doc.activeElement;
    while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
    if (!el) return doc.body || doc.documentElement;
    if (el.tagName === "IFRAME" || el.tagName === "FRAME") {
      let inner = null;
      try { inner = el.contentDocument; } catch {}
      if (inner) { doc = inner; continue; }
    }
    return el;
  }
  return doc.activeElement;
})()`;
// A file input of the view's own, never in the page's document, which
// DevTools fills with the files: the page's `paste` gets the same files a
// file input would give it.
const inputScript = `function () {
  const input = (this.ownerDocument || document).createElement("input");
  input.type = "file";
  input.multiple = true;
  return input;
}`;
const pasteScript = `function (target) {
  const data = new DataTransfer();
  for (const file of this.files) data.items.add(file);
  const event = new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true, composed: true });
  target.dispatchEvent(event);
  return this.files.length;
}`;

/** Where a paste goes: a session and a frame it reaches. */
export type PasteFrame = Readonly<{ session: string; frameId: string }>;

/** Pastes files where the page's caret is, as the person's own browser
 * pastes a copied file or a screenshot: a `paste` event with the files in
 * its `clipboardData`, on the focused element of the focused frame, in a
 * frame of another site too (`frameSession` names a frame's own session).
 * The page's script takes them as it would there; the event comes from the
 * view, so a page that waits for the browser to insert a picture by itself
 * gets nothing. True once the event was sent. */
export async function pasteFiles(
  send: Send,
  start: PasteFrame,
  paths: readonly string[],
  frameSession: (frameId: string) => string | undefined,
): Promise<boolean> {
  const sessions = new Set<string>();
  try {
    let at = start;
    for (let depth = 0; depth < 8; depth++) {
      sessions.add(at.session);
      const world = await send(
        "Page.createIsolatedWorld",
        { frameId: at.frameId, worldName },
        at.session,
      );
      const focused = await send(
        "Runtime.evaluate",
        {
          expression: focusedScript,
          contextId: world.executionContextId,
          objectGroup,
        },
        at.session,
      );
      const target = (focused.result as { objectId?: unknown } | undefined)
        ?.objectId;
      if (typeof target !== "string") return false;
      const node = (
        await send("DOM.describeNode", { objectId: target }, at.session)
      ).node as { nodeName?: unknown; frameId?: unknown } | undefined;
      const inner =
        (node?.nodeName === "IFRAME" || node?.nodeName === "FRAME") &&
        typeof node.frameId === "string"
          ? node.frameId
          : null;
      if (inner !== null) {
        // A frame of another origin has the focus: its own session where
        // Chrome runs it apart, else the same one.
        at = { session: frameSession(inner) ?? at.session, frameId: inner };
        continue;
      }
      const made = await send(
        "Runtime.callFunctionOn",
        { objectId: target, functionDeclaration: inputScript, objectGroup },
        at.session,
      );
      const input = (made.result as { objectId?: unknown } | undefined)
        ?.objectId;
      if (typeof input !== "string") return false;
      await send(
        "DOM.setFileInputFiles",
        { files: [...paths], objectId: input },
        at.session,
      );
      await send(
        "Runtime.callFunctionOn",
        {
          objectId: input,
          functionDeclaration: pasteScript,
          arguments: [{ objectId: target }],
          returnByValue: true,
        },
        at.session,
      );
      return true;
    }
    return false;
  } finally {
    for (const session of sessions)
      void send("Runtime.releaseObjectGroup", { objectGroup }, session).catch(
        () => undefined,
      );
  }
}

/** Answers a chooser with the person's files: written, then set on its
 * input on its own session. False when the upload does not fit the chooser
 * or the browser refused. */
export async function answerChooser(
  send: Send,
  chooser: Chooser,
  upload: Upload,
  root: string,
  log: (line: string) => void,
): Promise<boolean> {
  if (upload.delivery.kind !== "chooser") return false;
  // A chooser of files takes them by name only, never into folders.
  const entries = chooser.ask.directory
    ? upload.entries
    : upload.entries.map(({ file }) => ({ file, path: null }));
  let written: Written;
  try {
    written = await writeUpload(root, entries);
  } catch (error) {
    log(`writing the uploaded files failed: ${String(error)}`);
    return false;
  }
  const paths = chooserPaths(chooser.ask, written);
  if (paths === null) {
    await rm(written.folder, { recursive: true, force: true }).catch(
      () => undefined,
    );
    return false;
  }
  try {
    await send(
      "DOM.setFileInputFiles",
      { files: [...paths], backendNodeId: chooser.backendNodeId },
      chooser.session,
    );
  } catch (error) {
    log(`setFileInputFiles failed: ${String(error)}`);
    return false;
  }
  return true;
}

/** Gives the page files a person dropped or pasted: written, then dropped at
 * the point or pasted at the caret. */
export async function deliverFiles(
  send: Send,
  page: Readonly<{
    session: string;
    mainFrameId: string | null;
    frameSession: (frameId: string) => string | undefined;
  }>,
  upload: Upload,
  root: string,
  log: (line: string) => void,
): Promise<boolean> {
  const delivery = upload.delivery;
  if (delivery.kind === "chooser") return false;
  let written: Written;
  try {
    written = await writeUpload(root, upload.entries);
  } catch (error) {
    log(`writing the uploaded files failed: ${String(error)}`);
    return false;
  }
  try {
    if (delivery.kind === "drop") {
      await dropFiles(send, page.session, delivery, written.given);
      return true;
    }
    if (page.mainFrameId === null) return false;
    return await pasteFiles(
      send,
      { session: page.session, frameId: page.mainFrameId },
      written.files,
      page.frameSession,
    );
  } catch (error) {
    log(`${delivery.kind} of files failed: ${String(error)}`);
    return false;
  }
}

/** Removes upload folders older than an hour. */
export async function sweepUploads(root: string): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 }).catch(() => undefined);
  const names = await readdir(root).catch(() => [] as string[]);
  const old = Date.now() - 3_600_000;
  for (const name of names) {
    const path = join(root, name);
    const info = await stat(path).catch(() => null);
    if (info !== null && info.mtimeMs < old)
      await rm(path, { recursive: true, force: true }).catch(() => undefined);
  }
}
