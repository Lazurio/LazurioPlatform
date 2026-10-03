import {
  downloadPath,
  type FilesEntry,
  type FilesState,
  filesCrumbs,
  filesHref,
  filesState,
  formatModified,
  formatSize,
  listPath,
  uploadOutcome,
  uploadPath,
  zipName,
  zipPath,
} from "./files-view";
import type { MessageKey } from "./messages";
import type { PageRoute } from "./routes";
import { fill } from "./update-view";

type Copy = Readonly<Record<MessageKey, string>>;

type Upload = {
  readonly file: File;
  readonly folder: readonly string[];
  state: "queued" | "uploading" | "done" | "failed" | "cancelled";
  percent: number;
  text: string;
  request: XMLHttpRequest | null;
  readonly row: HTMLLIElement;
};

// The Files page (decision F34): the Documents folder of this Environment.
// Folders are routes of the page; files download. Behind a gateway a
// download is a plain link, which the session cookie admits and the browser
// saves itself (resumable, at any size); locally the session token cannot
// ride on a link, so the page fetches the file with it and saves the result.
// Uploads go one at a time, from the file picker or a drop anywhere on the
// page, each with its own progress, and never replace a file: the server
// picks a free name. Every value from the server is drawn with textContent.
export function createFilesPanel(
  options: Readonly<{
    /** A read-only GET with the page's credential. */
    get: (path: string) => Promise<{ value: unknown; ok: boolean }>;
    /** The page's credential headers: the token locally, none hosted. */
    credential: () => Record<string, string>;
    /** Whether downloads are plain links: behind a gateway. */
    linkDownloads: () => boolean;
    /** Called with the status of every answer: a 401 behind a gateway
     * means the session ended. */
    denied: (status: number) => void;
    copy: () => Copy;
    locale: () => "cs" | "en";
  }>,
) {
  const find = <T extends HTMLElement>(selector: string): T => {
    const element = document.querySelector<T>(selector);
    if (!element) throw new Error("Missing files UI");
    return element;
  };
  const navLink = find<HTMLAnchorElement>("#files-open");
  const crumbs = find<HTMLOListElement>("#files-crumbs");
  const toolbar = find<HTMLDivElement>("#files-toolbar");
  const uploadButton = find<HTMLButtonElement>("#files-upload");
  const input = find<HTMLInputElement>("#files-input");
  const zip = find<HTMLAnchorElement>("#files-zip");
  const uploadsSection = find<HTMLElement>("#files-uploads");
  const uploadList = find<HTMLUListElement>("#files-upload-list");
  const status = find<HTMLParagraphElement>("#files-status");
  const announcer = find<HTMLParagraphElement>("#files-announce");
  const body = find<HTMLDivElement>("#files-body");
  const shared = find<HTMLParagraphElement>("#files-shared");
  const drop = find<HTMLDivElement>("#files-drop");
  const dropText = find<HTMLParagraphElement>("#files-drop-text");
  const refreshButton = find<HTMLButtonElement>("#files-refresh");

  // The route the page shows (`show` is called on every move, also while
  // the frame is still being built), the folder shown, the last answer with
  // the folder it is for, whether a read is under way, and a counter that
  // drops the answer of a read the operator already moved away from.
  let route: PageRoute = { view: "home" };
  let path: readonly string[] | null = null;
  let answer: Readonly<{ folder: string; state: FilesState }> | null = null;
  let loading = false;
  let reads = 0;
  let note = "";
  const uploads: Upload[] = [];
  let sending = false;
  let dragging = 0;

  const element = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className?: string,
    content?: string,
  ): HTMLElementTagNameMap[K] => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (content !== undefined) node.textContent = content;
    return node;
  };
  const icon = (name: string, kind?: string) => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "icon");
    svg.setAttribute("aria-hidden", "true");
    if (kind !== undefined) svg.dataset.kind = kind;
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", `#${name}`);
    svg.append(use);
    return svg;
  };
  const active = () => route.view === "files";
  const folderKey = (folder: readonly string[]) => folder.join("/");
  // The answer for the folder shown; null until its first read is in. A
  // later read of the same folder (after an upload, Refresh) keeps showing
  // it, so nothing flickers.
  const shown = (): FilesState | null =>
    path !== null && answer !== null && answer.folder === folderKey(path)
      ? answer.state
      : null;
  // A sentence that stays visible (a download under way or failed, folders
  // left out of a drop) and one only read out (an upload done, which its row
  // already shows).
  const announce = (text: string) => {
    note = text;
    status.textContent = text;
  };
  const readOut = (text: string) => {
    announcer.textContent = text;
  };

  // A folder: a route of the page, moved to without a reload.
  const routeLink = (href: string, className: string, content: string) => {
    const link = element("a", className, content);
    link.href = href;
    link.dataset.route = "";
    return link;
  };
  const folderLink = (target: readonly string[], content: string) =>
    routeLink(filesHref(target), "files-name", content);

  // Saves a download fetched with the session token (locally only).
  async function saveFetched(request: string, name: string) {
    announce(fill(options.copy().filesDownloading, { name }));
    try {
      const response = await fetch(request, {
        headers: options.credential(),
        cache: "no-store",
      });
      options.denied(response.status);
      if (!response.ok) throw new Error("Download refused");
      const url = URL.createObjectURL(await response.blob());
      const link = element("a");
      link.href = url;
      link.download = name;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      announce("");
    } catch {
      announce(fill(options.copy().filesDownloadFailed, { name }));
    }
  }

  // A download: behind a gateway the link itself; locally a click fetches
  // it with the token instead. The address is the same either way.
  const downloadLink = (
    target: readonly string[],
    request: string,
    name: string,
    className: string,
    content: string,
  ) => {
    const link = element("a", className, content);
    link.href = filesHref(target);
    link.addEventListener("click", (event) => {
      if (
        options.linkDownloads() ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      event.preventDefault();
      void saveFetched(request, name);
    });
    return link;
  };

  function entryRow(entry: FilesEntry, folder: readonly string[]) {
    const copy = options.copy();
    const locale = options.locale();
    const target = [...folder, entry.name];
    const item = element("li", "row files-row");
    const main = element("div", "files-row-main");
    const name =
      entry.kind === "directory"
        ? folderLink(target, entry.name)
        : downloadLink(
            target,
            downloadPath(target),
            entry.name,
            "files-name",
            entry.name,
          );
    const meta = element("span", "files-meta");
    meta.append(
      element(
        "span",
        "files-size",
        entry.kind === "directory"
          ? copy.filesFolder
          : formatSize(entry.size ?? 0, locale),
      ),
      element(
        "span",
        "files-modified",
        formatModified(entry.modifiedAt, locale),
      ),
    );
    const action = element("span", "files-action");
    if (entry.kind === "file") {
      const button = downloadLink(
        target,
        downloadPath(target),
        entry.name,
        "button",
        copy.filesDownload,
      );
      button.prepend(icon("i-download"));
      button.setAttribute(
        "aria-label",
        fill(copy.filesDownloadNamed, { name: entry.name }),
      );
      action.append(button);
    }
    main.append(
      icon(entry.kind === "directory" ? "i-folder" : "i-file", entry.kind),
      name,
      meta,
      action,
    );
    item.append(main);
    return item;
  }

  function listView(entries: readonly FilesEntry[], folder: readonly string[]) {
    const copy = options.copy();
    if (entries.length === 0)
      return [
        element(
          "p",
          "callout",
          folder.length === 0 ? copy.filesEmptyRoot : copy.filesEmpty,
        ),
      ];
    const list = element("ul", "card files-list");
    // Column names for sighted readers of a wide list; each row says the
    // same in its own text.
    const head = element("li", "row files-row files-head");
    head.setAttribute("aria-hidden", "true");
    const headMain = element("div", "files-row-main");
    const meta = element("span", "files-meta");
    meta.append(
      element("span", "files-size", copy.filesSize),
      element("span", "files-modified", copy.filesModified),
    );
    headMain.append(
      element("span", "files-icon"),
      element("span", "files-name", copy.filesName),
      meta,
      element("span", "files-action"),
    );
    head.append(headMain);
    list.append(head, ...entries.map((entry) => entryRow(entry, folder)));
    return [list];
  }

  function render() {
    const copy = options.copy();
    if (active()) navLink.setAttribute("aria-current", "page");
    else navLink.removeAttribute("aria-current");
    refreshButton.disabled = loading;
    if (path === null) return;
    const folder = path;
    crumbs.replaceChildren(
      ...filesCrumbs(folder, copy).map((crumb) => {
        const item = element("li");
        if (crumb.current) {
          const here = element("span", "", crumb.label);
          here.setAttribute("aria-current", "page");
          item.append(here);
        } else item.append(routeLink(crumb.href, "", crumb.label));
        return item;
      }),
    );
    const state = shown();
    toolbar.hidden = state?.kind !== "loaded";
    zip.href = options.linkDownloads() ? zipPath(folder) : filesHref(folder);
    status.textContent = state === null && loading ? copy.filesLoading : note;
    if (state === null) {
      body.replaceChildren();
      return;
    }
    if (state.kind === "loaded")
      body.replaceChildren(...listView(state.listing.entries, folder));
    else if (state.kind === "file") {
      const callout = element("div", "callout files-callout");
      const download = downloadLink(
        folder,
        downloadPath(folder),
        state.name,
        "button",
        copy.filesDownload,
      );
      download.prepend(icon("i-download"));
      callout.append(
        element("p", "", fill(copy.filesIsFile, { name: state.name })),
        download,
        routeLink(filesHref(folder.slice(0, -1)), "", copy.filesOpenFolder),
      );
      body.replaceChildren(callout);
    } else if (state.kind === "missing") {
      const callout = element("div", "callout files-callout");
      callout.append(
        element("p", "", copy.filesNotFound),
        routeLink(filesHref([]), "", copy.filesOpenRoot),
      );
      body.replaceChildren(callout);
    } else
      body.replaceChildren(
        element(
          "p",
          "callout",
          state.kind === "unavailable"
            ? copy.filesUnavailable
            : copy.filesLoadFailed,
        ),
      );
  }

  async function load() {
    if (path === null) return;
    const folder = path;
    reads += 1;
    const read = reads;
    loading = true;
    render();
    let next: FilesState;
    try {
      const { value, ok } = await options.get(listPath(folder));
      next = filesState(folder, ok, value);
    } catch {
      next = { kind: "failed" };
    }
    if (read !== reads) return;
    answer = { folder: folderKey(folder), state: next };
    loading = false;
    render();
  }

  /** Shows the route: reads the folder when it changed. */
  function show(next: PageRoute) {
    route = next;
    if (next.view !== "files") {
      dragging = 0;
      drop.hidden = true;
      render();
      return;
    }
    const target = next.path;
    const changed =
      path === null ||
      path.length !== target.length ||
      path.some((name, index) => name !== target[index]);
    path = target;
    if (changed) {
      note = "";
      // The first route is shown while the page's script is still running:
      // read once it has finished, as every later move does at once.
      queueMicrotask(() => void load());
    } else render();
  }

  // Uploads.
  function renderUpload(upload: Upload) {
    const copy = options.copy();
    upload.row.dataset.state = upload.state;
    const progress = upload.row.querySelector("progress");
    const text = upload.row.querySelector(".files-upload-state");
    const cancel = upload.row.querySelector("button");
    if (progress) {
      progress.value = upload.state === "done" ? 100 : upload.percent;
      progress.hidden =
        upload.state !== "uploading" && upload.state !== "queued";
    }
    if (text)
      text.textContent =
        upload.state === "queued"
          ? copy.filesQueued
          : upload.state === "uploading"
            ? fill(copy.filesUploading, { percent: String(upload.percent) })
            : upload.state === "cancelled"
              ? copy.filesUploadCancelled
              : upload.text;
    if (cancel) {
      cancel.hidden = upload.state !== "queued" && upload.state !== "uploading";
      cancel.textContent = copy.filesCancel;
      cancel.setAttribute(
        "aria-label",
        fill(copy.filesCancelNamed, { name: upload.file.name }),
      );
    }
  }

  function send(upload: Upload): Promise<void> {
    return new Promise((done) => {
      const request = new XMLHttpRequest();
      upload.request = request;
      upload.state = "uploading";
      renderUpload(upload);
      request.open("POST", uploadPath(upload.folder, upload.file.name));
      for (const [name, value] of Object.entries(options.credential()))
        request.setRequestHeader(name, value);
      request.setRequestHeader("Content-Type", "application/octet-stream");
      request.upload.addEventListener("progress", (event) => {
        if (!event.lengthComputable || event.total === 0) return;
        upload.percent = Math.min(
          99,
          Math.floor((event.loaded / event.total) * 100),
        );
        renderUpload(upload);
      });
      const finish = () => {
        upload.request = null;
        renderUpload(upload);
        done();
      };
      request.addEventListener("load", () => {
        options.denied(request.status);
        let value: unknown = null;
        try {
          value = JSON.parse(request.responseText);
        } catch {}
        const outcome = uploadOutcome(
          upload.file.name,
          request.status,
          value,
          options.copy(),
        );
        upload.state = outcome.ok ? "done" : "failed";
        upload.text = outcome.text;
        if (outcome.ok)
          readOut(
            fill(options.copy().filesUploadedStatus, { name: outcome.name }),
          );
        finish();
        // The folder shown gets the new file.
        const shown = path;
        if (
          outcome.ok &&
          active() &&
          shown !== null &&
          shown.join("/") === upload.folder.join("/")
        )
          void load();
      });
      request.addEventListener("error", () => {
        upload.state = "failed";
        upload.text = options.copy().filesUploadIncomplete;
        finish();
      });
      request.addEventListener("abort", () => {
        upload.state = "cancelled";
        finish();
      });
      request.send(upload.file);
    });
  }

  async function pump() {
    if (sending) return;
    sending = true;
    try {
      for (;;) {
        const next = uploads.find((upload) => upload.state === "queued");
        if (next === undefined) break;
        await send(next);
      }
    } finally {
      sending = false;
    }
  }

  function enqueue(files: readonly File[]) {
    if (path === null || files.length === 0) return;
    const folder = path;
    for (const file of files) {
      const row = element("li", "row files-upload");
      const progress = element("progress");
      progress.max = 100;
      progress.value = 0;
      const cancel = element("button", "ghost");
      cancel.type = "button";
      row.append(
        element("span", "files-upload-name", file.name),
        cancel,
        progress,
        element("span", "files-upload-state"),
      );
      const upload: Upload = {
        file,
        folder,
        state: "queued",
        percent: 0,
        text: "",
        request: null,
        row,
      };
      cancel.addEventListener("click", () => {
        if (upload.request !== null) upload.request.abort();
        else if (upload.state === "queued") {
          upload.state = "cancelled";
          renderUpload(upload);
        }
      });
      uploads.push(upload);
      uploadList.append(row);
      renderUpload(upload);
    }
    uploadsSection.hidden = false;
    void pump();
  }

  uploadButton.addEventListener("click", () => input.click());
  input.addEventListener("change", () => {
    enqueue([...(input.files ?? [])]);
    input.value = "";
  });
  zip.addEventListener("click", (event) => {
    if (
      path === null ||
      options.linkDownloads() ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    event.preventDefault();
    void saveFetched(zipPath(path), zipName(path));
  });
  refreshButton.addEventListener("click", () => void load());

  // A drop anywhere on the page uploads into the folder shown; a folder in
  // the drop is skipped and said so.
  const carriesFiles = (event: DragEvent) =>
    event.dataTransfer?.types.includes("Files") === true;
  const droppable = () => active() && shown()?.kind === "loaded";
  window.addEventListener("dragenter", (event) => {
    if (!droppable() || !carriesFiles(event)) return;
    dragging += 1;
    dropText.textContent = fill(options.copy().filesDrop, {
      folder: path?.at(-1) ?? options.copy().filesRoot,
    });
    drop.hidden = false;
  });
  window.addEventListener("dragleave", () => {
    if (dragging === 0) return;
    dragging -= 1;
    if (dragging === 0) drop.hidden = true;
  });
  window.addEventListener("dragover", (event) => {
    if (!droppable() || !carriesFiles(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  });
  window.addEventListener("drop", (event) => {
    if (!droppable() || !carriesFiles(event)) return;
    event.preventDefault();
    dragging = 0;
    drop.hidden = true;
    const files: File[] = [];
    let folders = 0;
    for (const item of event.dataTransfer?.items ?? []) {
      if (item.kind !== "file") continue;
      if (item.webkitGetAsEntry()?.isDirectory) {
        folders += 1;
        continue;
      }
      const file = item.getAsFile();
      if (file !== null) files.push(file);
    }
    if (folders > 0) announce(options.copy().filesFoldersSkipped);
    enqueue(files);
  });

  return {
    show,
    /** The language changed: everything drawn again. */
    relabel() {
      for (const upload of uploads) renderUpload(upload);
      render();
    },
    /** The Team note follows the preset, known once the profile is read. */
    shared(value: boolean) {
      shared.hidden = !value;
    },
  };
}
