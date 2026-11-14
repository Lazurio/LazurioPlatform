/** Files from a person's computer to a page in the Environment browser
 * (decision F39 point 7, #973): the rules the view page, the service and the
 * hub share. A person gives files three ways: in the view's own chooser when
 * the page asks for them, by dropping them on the view, and by pasting them.
 * The view uploads them with `POST /t/<id>/files?token=` (`uploadFields`),
 * the hub writes them into a folder of their own on the Environment
 * (`uploads.ts`) and gives the page the paths. Pure, with no DOM and no I/O,
 * so the page, Bun and the tests read one definition. */

/** One name's limit on Linux, in bytes of UTF-8. */
export const maxNameBytes = 255;
/** How deep a folder the person gives may go, and how long a file's place in
 * it may be, in bytes: well under Linux's 4096 for a whole path, which also
 * holds the upload folder. */
export const maxPathDepth = 32;
export const maxPathBytes = 3_000;
/** At most this many files in one upload, and this many bytes in its
 * request (the service's limit). */
export const maxUploadFiles = 1_000;
export const maxUploadBytes = 256 * 1024 * 1024;
/** An extension kept when a long name is cut: up to this many bytes. */
const maxExtensionBytes = 32;

// Path separators, NUL and the other control characters (Unicode's Cc: C0,
// DEL and C1).
const unsafe = /[/\\\p{Cc}]/gu;
const bytes = (text: string) => new TextEncoder().encode(text).length;

/** At most `max` bytes of UTF-8, cut at a whole character, and before the
 * extension where there is one, so `Smlouva….pdf` stays a PDF. */
function fitBytes(name: string, max: number): string {
  if (bytes(name) <= max) return name;
  const dot = name.lastIndexOf(".");
  const extension =
    dot > 0 && bytes(name.slice(dot)) <= maxExtensionBytes
      ? name.slice(dot)
      : "";
  let room = max - bytes(extension);
  let stem = "";
  for (const character of extension === "" ? name : name.slice(0, dot)) {
    const size = bytes(character);
    if (size > room) break;
    stem += character;
    room -= size;
  }
  return stem + extension;
}

/** One segment as the Environment keeps it: the person's own text, Unicode
 * and spaces as they are; only what cannot be part of one name or would hide
 * the file goes (path separators, control characters, leading dots, which
 * also make `.` and `..` nothing). Empty when nothing is left. */
function cleanSegment(segment: string): string {
  return fitBytes(
    segment.replace(unsafe, "").replace(/^\.+/, ""),
    maxNameBytes,
  );
}

/** A file's name as the page gets it (#973): `Výpis z OR – 2026.pdf` stays
 * `Výpis z OR – 2026.pdf`. A name of nothing but what goes is `file`. */
export function uploadName(name: string): string {
  const clean = cleanSegment(name);
  return clean === "" ? "file" : clean;
}

/** A file's place in a folder the person gave (`webkitRelativePath`,
 * segments by `/`, the folder's own name first), each segment cleaned as a
 * name and the empty ones left out. Null when no place is left, or one too
 * deep or too long: such a file is not taken. */
export function uploadSegments(path: string): string[] | null {
  const segments = path
    .split("/")
    .map(cleanSegment)
    .filter((segment) => segment !== "");
  if (segments.length === 0 || segments.length > maxPathDepth) return null;
  if (bytes(segments.join("/")) > maxPathBytes) return null;
  return segments;
}

/** How the page gets the files: on the input that asked (`chooser`), as a
 * drop at a point of its viewport in CSS pixels, or as a paste where its
 * caret is. */
export type UploadDelivery =
  | Readonly<{ kind: "chooser" }>
  | Readonly<{ kind: "drop"; x: number; y: number }>
  | Readonly<{ kind: "paste" }>;

/** One file of an upload: its bytes and name, and its place in a folder the
 * person gave (`uploadSegments`), null for a file on its own. */
export type UploadEntry = Readonly<{
  file: File;
  path: readonly string[] | null;
}>;

export type Upload = Readonly<{
  entries: readonly UploadEntry[];
  delivery: UploadDelivery;
}>;

/** The form of `POST /t/<id>/files`: each file as `file`, for a folder each
 * file's place as `path` in the same order (empty for a file on its own),
 * and for a drop or a paste `deliver` with the drop's `x` and `y`. */
export const uploadFields = Object.freeze({
  file: "file",
  path: "path",
  deliver: "deliver",
  x: "x",
  y: "y",
});

const coordinate = (value: unknown): number | null => {
  if (typeof value !== "string" || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && Math.abs(number) <= 100_000 ? number : null;
};

/** Reads an upload's form; null for one the view never sends: no file, too
 * many, places that do not match the files, an unknown way to deliver, a
 * folder's file whose place is unusable. */
export function readUpload(form: FormData): Upload | null {
  const files = form
    .getAll(uploadFields.file)
    .filter((value): value is File => value instanceof File);
  if (files.length === 0 || files.length > maxUploadFiles) return null;
  if (form.getAll(uploadFields.file).length !== files.length) return null;
  const paths = form.getAll(uploadFields.path);
  if (paths.length !== 0 && paths.length !== files.length) return null;
  const entries: UploadEntry[] = [];
  for (const [index, file] of files.entries()) {
    const path = paths[index];
    if (path !== undefined && typeof path !== "string") return null;
    if (path === undefined || path === "") {
      entries.push({ file, path: null });
      continue;
    }
    const segments = uploadSegments(path);
    if (segments === null) return null;
    entries.push({ file, path: segments });
  }
  const deliver = form.get(uploadFields.deliver);
  let delivery: UploadDelivery;
  if (deliver === null) delivery = { kind: "chooser" };
  else if (deliver === "paste") delivery = { kind: "paste" };
  else if (deliver === "drop") {
    const x = coordinate(form.get(uploadFields.x));
    const y = coordinate(form.get(uploadFields.y));
    if (x === null || y === null) return null;
    delivery = { kind: "drop", x, y };
  } else return null;
  return { entries, delivery };
}

/** What a file chooser asks for, from its input's attributes as DevTools
 * describes the node (`DOM.describeNode`: names and values in turn) and the
 * chooser's `mode`: several files, which types (`accept`, as the page wrote
 * it), a folder (`webkitdirectory`). */
export type ChooserAsk = Readonly<{
  multiple: boolean;
  accept: string | null;
  directory: boolean;
}>;

export function chooserAsk(mode: unknown, attributes: unknown): ChooserAsk {
  const named = new Map<string, string>();
  if (Array.isArray(attributes))
    for (let i = 0; i + 1 < attributes.length; i += 2) {
      const [name, value] = [attributes[i], attributes[i + 1]];
      if (typeof name === "string" && typeof value === "string")
        named.set(name.toLowerCase(), value);
    }
  const accept = named.get("accept")?.trim() ?? "";
  return {
    multiple: mode === "selectMultiple" || named.has("multiple"),
    accept: accept === "" ? null : accept.slice(0, 1_000),
    directory: named.has("webkitdirectory"),
  };
}

/** Whether a paste gives the page files rather than text (#973): files and
 * no text, or text that only names the files (a file manager's copy puts
 * their names or paths there). Text an office program copies brings a
 * picture of itself too; that paste stays text, as in the person's own
 * browser. */
export function pasteIsFiles(text: string, names: readonly string[]): boolean {
  if (names.length === 0) return false;
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  return lines.every((line) => {
    const last =
      line
        .replace(/^file:\/\//, "")
        .split(/[/\\]/)
        .pop() ?? "";
    let decoded = last;
    try {
      decoded = decodeURIComponent(last);
    } catch {}
    return (
      names.includes(line) || names.includes(last) || names.includes(decoded)
    );
  });
}
