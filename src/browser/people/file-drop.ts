import { viewPath } from "../contract/pure";
import {
  maxUploadBytes,
  maxUploadFiles,
  pasteIsFiles,
  uploadFields,
} from "./files";
import type { Words } from "./words";

/** The view's side of files a person drops on the remote page or pastes into
 * it (#973). While a drag with files is over the page area the view says
 * where they go; a drop uploads them with the viewer's token
 * (`upload-token`) and the hub drops them on the page at that point, a paste
 * of files (a copied file, a screenshot) pastes them at the page's caret. A
 * drop or a paste of anything but files stays as it was: a paste of text
 * goes to the page as text. Every failure is said in the view, never
 * swallowed. Runs in the view page only (`client.ts` gives it its viewer). */

export type FileDropSeams = Readonly<{
  /** The viewer's box: the drag's veil and the upload's status go in it. */
  box: HTMLElement;
  /** The viewer's token for drops and pastes, null until its socket has
   * one. */
  token: () => string | null;
  /** The place on the remote page under an event, CSS pixels of its
   * viewport, a place outside the frame at its nearest edge; null while no
   * frame is drawn. */
  point: (event: MouseEvent) => Readonly<{ x: number; y: number }> | null;
  /** `POST /t/<id>/files?token=` with the form; true when the page has
   * them. */
  post: (token: string, form: FormData) => Promise<boolean>;
  say: Words;
}>;

type Entry = Readonly<{ file: File; path: string }>;

/** `POST /t/<id>/files?token=` with an upload's form: true when the hub gave
 * the page the files. */
export async function postFiles(
  id: string,
  token: string,
  form: FormData,
  signal?: AbortSignal,
): Promise<boolean> {
  return fetch(`${viewPath(id)}/files?token=${encodeURIComponent(token)}`, {
    method: "POST",
    body: form,
    credentials: "same-origin",
    ...(signal === undefined ? {} : { signal }),
  }).then(
    (response) => response.ok,
    () => false,
  );
}

/** Files dropped anywhere else on the view page (its bar, a notice) would
 * open in the person's own tab and take the view away: the page takes no
 * drop of files but the page area's. */
let guarded = false;
function guardPage(): void {
  if (guarded) return;
  guarded = true;
  for (const type of ["dragover", "drop"] as const)
    window.addEventListener(type, (event) => {
      if (!hasFiles(event.dataTransfer) || event.defaultPrevented) return;
      event.preventDefault();
      if (event.dataTransfer !== null) event.dataTransfer.dropEffect = "none";
    });
}

const hasFiles = (data: DataTransfer | null) =>
  data !== null && Array.from(data.types).includes("Files");

/** Every file under a dropped folder, with its place in it from the folder's
 * own name on, as a chooser of folders gives them. */
async function folderEntries(
  entry: FileSystemEntry,
  into: Entry[],
): Promise<void> {
  if (into.length > maxUploadFiles) return;
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) =>
      (entry as FileSystemFileEntry).file(resolve, reject),
    );
    into.push({ file, path: entry.fullPath.replace(/^\//, "") });
    return;
  }
  if (!entry.isDirectory) return;
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
      reader.readEntries(resolve, reject),
    );
    if (batch.length === 0) return;
    for (const child of batch) await folderEntries(child, into);
  }
}

export class FileDrop {
  private readonly veil: HTMLElement;
  private readonly note: HTMLElement;
  private noteTimer: ReturnType<typeof setTimeout> | null = null;
  /** Hides the veil once no `dragover` came for a while: a browser sends
   * them all the time a drag is over the page, still or not, and a drag
   * that ends elsewhere (Escape, another window) may say nothing here. */
  private overTimer: ReturnType<typeof setTimeout> | null = null;
  private busy = false;

  constructor(private readonly seams: FileDropSeams) {
    guardPage();
    const { box, say } = seams;
    this.veil = document.createElement("div");
    this.veil.className = "drop-veil";
    this.veil.hidden = true;
    const title = document.createElement("p");
    title.className = "drop-title";
    title.textContent = say.dropHere;
    const hint = document.createElement("p");
    hint.className = "drop-hint";
    hint.textContent = say.dropHint;
    const label = document.createElement("div");
    label.className = "drop-label";
    label.append(title, hint);
    this.veil.append(label);
    this.note = document.createElement("div");
    this.note.className = "transfer";
    this.note.setAttribute("role", "status");
    this.note.hidden = true;
    box.append(this.veil, this.note);
    box.addEventListener("dragenter", (event) => this.over(event));
    box.addEventListener("dragover", (event) => this.over(event));
    box.addEventListener("dragleave", (event) => {
      // Only leaving the box, not moving between what is in it.
      const into = event.relatedTarget;
      if (into instanceof Node && box.contains(into)) return;
      this.hideVeil();
    });
    box.addEventListener("drop", (event) => void this.dropped(event));
    window.addEventListener("dragend", () => this.hideVeil());
  }

  /** A paste in the view: files go to the page as files and true is
   * answered; text, or text with a picture of itself (`pasteIsFiles`), is
   * left to the caller. */
  paste(event: ClipboardEvent): boolean {
    const data = event.clipboardData;
    if (data === null) return false;
    const files = Array.from(data.files);
    if (
      !pasteIsFiles(
        data.getData("text/plain"),
        files.map((file) => file.name),
      )
    )
      return false;
    event.preventDefault();
    const form = new FormData();
    form.append(uploadFields.deliver, "paste");
    void this.send(
      files.map((file) => ({ file, path: "" })),
      form,
    );
    return true;
  }

  private over(event: DragEvent): void {
    if (!hasFiles(event.dataTransfer)) return;
    // A drop of files on the view page would open them in the person's own
    // tab: the view takes it.
    event.preventDefault();
    if (event.dataTransfer !== null) event.dataTransfer.dropEffect = "copy";
    this.veil.hidden = false;
    if (this.overTimer !== null) clearTimeout(this.overTimer);
    this.overTimer = setTimeout(() => this.hideVeil(), 1_000);
  }

  private hideVeil(): void {
    if (this.overTimer !== null) clearTimeout(this.overTimer);
    this.overTimer = null;
    this.veil.hidden = true;
  }

  private async dropped(event: DragEvent): Promise<void> {
    const data = event.dataTransfer;
    if (!hasFiles(data) || data === null) return;
    event.preventDefault();
    this.hideVeil();
    const at = this.seams.point(event);
    // The items are readable only while the event runs: their entries and
    // files are taken now, a folder's contents read after.
    const files = Array.from(data.files);
    const entries = Array.from(data.items, (item) =>
      item.kind === "file" ? (item.webkitGetAsEntry?.() ?? null) : null,
    );
    if (at === null) {
      this.say(this.seams.say.uploadFailed, true);
      return;
    }
    const taken: Entry[] = [];
    try {
      for (const [index, entry] of entries.entries()) {
        if (entry?.isDirectory === true) await folderEntries(entry, taken);
        else {
          const file = files[index] ?? null;
          if (file !== null) taken.push({ file, path: "" });
        }
      }
    } catch {
      this.say(this.seams.say.uploadFailed, true);
      return;
    }
    // A browser without entries gives only the files.
    if (taken.length === 0)
      for (const file of files) taken.push({ file, path: "" });
    const form = new FormData();
    form.append(uploadFields.deliver, "drop");
    form.append(uploadFields.x, String(Math.round(at.x)));
    form.append(uploadFields.y, String(Math.round(at.y)));
    await this.send(taken, form);
  }

  /** Uploads the files with the rest of the form, and says how it went. */
  private async send(entries: readonly Entry[], form: FormData): Promise<void> {
    const { say } = this.seams;
    const token = this.seams.token();
    if (entries.length === 0) return;
    if (token === null || this.busy) {
      this.say(say.uploadFailed, true);
      return;
    }
    const size = entries.reduce((sum, { file }) => sum + file.size, 0);
    if (entries.length > maxUploadFiles || size > maxUploadBytes) {
      this.say(say.tooLarge, true);
      return;
    }
    for (const { file, path } of entries) {
      form.append(uploadFields.file, file);
      form.append(uploadFields.path, path);
    }
    this.busy = true;
    this.say(say.uploading, false);
    const done = await this.seams.post(token, form).catch(() => false);
    this.busy = false;
    if (done) this.say(null, false);
    else this.say(say.uploadFailed, true);
  }

  /** The upload's status at the bottom of the page area: while it runs, and
   * a failure for a while. */
  private say(text: string | null, failed: boolean): void {
    if (this.noteTimer !== null) clearTimeout(this.noteTimer);
    this.noteTimer = null;
    this.note.hidden = text === null;
    this.note.classList.toggle("failed", failed);
    if (text === null) return;
    this.note.textContent = text;
    if (failed)
      this.noteTimer = setTimeout(() => {
        this.noteTimer = null;
        this.note.hidden = true;
      }, 6_000);
  }
}
