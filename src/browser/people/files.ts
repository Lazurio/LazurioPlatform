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

/** A name's stem and its extension, the extension only where it is short
 * enough to keep (`maxExtensionBytes`): `smlouva.v2.pdf` is `smlouva.v2` and
 * `.pdf`; `.env` and `README` have none. */
function splitExtension(name: string): readonly [string, string] {
  const dot = name.lastIndexOf(".");
  return dot > 0 && bytes(name.slice(dot)) <= maxExtensionBytes
    ? [name.slice(0, dot), name.slice(dot)]
    : [name, ""];
}

/** The longest start of `text` that fits `max` bytes of UTF-8, cut at a
 * whole character. */
function cutBytes(text: string, max: number): string {
  let room = max;
  let start = "";
  for (const character of text) {
    const size = bytes(character);
    if (size > room) break;
    start += character;
    room -= size;
  }
  return start;
}

/** At most `max` bytes of UTF-8, cut at a whole character, and before the
 * extension where there is one, so `Smlouva….pdf` stays a PDF. */
function fitBytes(name: string, max: number): string {
  if (bytes(name) <= max) return name;
  const [stem, extension] = splitExtension(name);
  return cutBytes(stem, max - bytes(extension)) + extension;
}

/** One name as the Environment keeps it: the person's own text, Unicode,
 * spaces and leading dots (`.env`) as they are; only what cannot be part of
 * one name goes (path separators, control characters), and it is cut to
 * 255 bytes. A name of nothing but what goes, `.` or `..` (which name no
 * file), is `fallback`. */
function cleanName(name: string, fallback: string): string {
  const clean = fitBytes(name.replace(unsafe, ""), maxNameBytes);
  return clean === "" || clean === "." || clean === ".." ? fallback : clean;
}

/** A file's name as the page gets it (#973): `Výpis z OR – 2026.pdf` stays
 * `Výpis z OR – 2026.pdf`. A name of nothing but what goes is `file`. */
export function uploadName(name: string): string {
  return cleanName(name, "file");
}

/** A folder's name in an upload, by the same rule; `folder` for one of
 * nothing but what goes. */
const folderName = (name: string) => cleanName(name, "folder");

/** `name`, or when one place of the folder has it already, `name (2)`,
 * `name (3)`… before its extension, still at most 255 bytes of UTF-8: the
 * stem gives way at a whole character, never the number or the extension. */
export function freeName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) return name;
  const [stem, extension] = splitExtension(name);
  for (let n = 2; ; n++) {
    const end = ` (${n})${extension}`;
    const free = cutBytes(stem, maxNameBytes - bytes(end)) + end;
    if (!taken.has(free)) return free;
  }
}

/** Whether a segment of a folder's place names a folder: an empty segment,
 * `.` and `..` do not, so a place never climbs out of its upload. */
const namesFolder = (segment: string) =>
  segment !== "" && segment !== "." && segment !== "..";

/** A file's place as the person has it (#973): the folders of a folder the
 * person gave, the folder's own name first, and the file's name last; a
 * file on its own is its name alone. The segments are the person's own
 * text, never a path on the Environment (`FolderNames` names them there).
 * Folder segments that name nothing are left out; null for a place too deep
 * or, once named, too long: such a file is not taken. */
export function uploadPlace(segments: readonly string[]): string[] | null {
  const name = segments[segments.length - 1];
  if (name === undefined || segments.length > maxPathDepth) return null;
  const place = [...segments.slice(0, -1).filter(namesFolder), name];
  const named = [...place.slice(0, -1).map(folderName), uploadName(name)];
  return bytes(named.join("/")) > maxPathBytes ? null : place;
}

/** A file's `path` field as the view sends it: its place as the person has
 * it, the segments of its path in a folder the person gave
 * (`webkitRelativePath`, a dropped entry's `fullPath`), or its name alone
 * for a file on its own. As JSON, so the form carries every name exactly: a
 * form's text turns a line break into CR LF, and a browser writes `"` in a
 * file's name as `%22`. */
export function placeField(name: string, relativePath = ""): string {
  const path = relativePath.replace(/^\//, "");
  return JSON.stringify(path === "" ? [name] : path.split("/"));
}

/** Reads a `path` field (`placeField`); null for anything else. */
function readPlace(field: unknown): string[] | null {
  if (typeof field !== "string") return null;
  let segments: unknown;
  try {
    segments = JSON.parse(field);
  } catch {
    return null;
  }
  return Array.isArray(segments) &&
    segments.every((segment) => typeof segment === "string")
    ? uploadPlace(segments)
    : null;
}

type Folder = {
  /** The names its places have on the Environment, files and folders. */
  readonly taken: Set<string>;
  /** Its folders by the person's own name. */
  readonly folders: Map<string, Readonly<{ name: string; folder: Folder }>>;
};
const newFolder = (): Folder => ({ taken: new Set(), folders: new Map() });

/** The names one upload's places in folders get on the Environment, given
 * in the upload's order. A folder is known by the person's own names
 * (`uploadPlace`), so one folder of the person is always one folder here,
 * and two places of one folder, files or folders, never share a name: the
 * first takes the cleaned name, the next one whose name cleans to the same
 * takes `freeName`'s. A file always has a name of its own, even when the
 * same place comes twice. */
export class FolderNames {
  private readonly top = newFolder();

  of(place: readonly string[]): string[] {
    let at = this.top;
    const names: string[] = [];
    for (const segment of place.slice(0, -1)) {
      let known = at.folders.get(segment);
      if (known === undefined) {
        const name = freeName(folderName(segment), at.taken);
        at.taken.add(name);
        known = { name, folder: newFolder() };
        at.folders.set(segment, known);
      }
      names.push(known.name);
      at = known.folder;
    }
    const name = freeName(uploadName(place[place.length - 1] ?? ""), at.taken);
    at.taken.add(name);
    names.push(name);
    return names;
  }
}

/** How the page gets the files: on the input that asked (`chooser`), as a
 * drop at a point of its viewport in CSS pixels, or as a paste where its
 * caret is. */
export type UploadDelivery =
  | Readonly<{ kind: "chooser" }>
  | Readonly<{ kind: "drop"; x: number; y: number }>
  | Readonly<{ kind: "paste" }>;

/** One file of an upload: its bytes, and its place as the person has it
 * (`uploadPlace`): its name alone for a file on its own, else the folders of
 * a folder the person gave and its name last. The person's own text, never
 * a path on the Environment: `writeUpload` names it there. */
export type UploadEntry = Readonly<{
  file: File;
  place: readonly string[];
}>;

export type Upload = Readonly<{
  entries: readonly UploadEntry[];
  delivery: UploadDelivery;
}>;

/** The form of `POST /t/<id>/files`: each file as `file` with its place as
 * `path` in the same order (`placeField`), and for a drop or a paste
 * `deliver` with the drop's `x` and `y`. A form without places gives files
 * on their own, by the names their parts carry. */
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
 * many, places that do not match the files or are unusable, an unknown way
 * to deliver. */
export function readUpload(form: FormData): Upload | null {
  const values = form.getAll(uploadFields.file);
  const files = values.filter((value): value is File => value instanceof File);
  if (files.length === 0 || files.length > maxUploadFiles) return null;
  if (values.length !== files.length) return null;
  const fields = form.getAll(uploadFields.path);
  if (fields.length !== 0 && fields.length !== files.length) return null;
  const entries: UploadEntry[] = [];
  for (const [index, file] of files.entries()) {
    const place = fields.length === 0 ? [file.name] : readPlace(fields[index]);
    if (place === null) return null;
    entries.push({ file, place });
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
