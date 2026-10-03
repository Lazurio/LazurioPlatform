// The rules of a path inside the Operator's Documents folder (decision F35):
// one pure implementation that the Launchpad's Files routes and `lazurio files
// link` both apply, and the page reads its route with. A path is a list of
// names relative to the Documents folder; the filesystem effects (realpath,
// the containment check, reading and writing) are the Documents adapter's
// (documents.ts). Nothing here may need Node: the page bundles this module.

/** Why a path is refused before anything is read. */
export type PathRefusal = "path-invalid" | "path-hidden";

/** One name of a path, in UTF-8 bytes: what the common filesystems allow. */
export const maxNameBytes = 255;
/** A whole relative path, in UTF-8 bytes. */
export const maxPathBytes = 4096;
const maxDepth = 64;

const encoder = new TextEncoder();
/** The length of a string in UTF-8 bytes. */
export const utf8Bytes = (text: string) => encoder.encode(text).length;

// A control character (C0, DEL, C1), either separator, or a UTF-16
// surrogate without its pair, which no UTF-8 file name can hold. Iterating a
// string by code points leaves only an unpaired surrogate in that range.
function forbiddenCharacter(segment: string): boolean {
  for (const character of segment) {
    const code = character.codePointAt(0) ?? 0;
    if (
      code < 0x20 ||
      (code >= 0x7f && code <= 0x9f) ||
      (code >= 0xd800 && code <= 0xdfff) ||
      character === "/" ||
      character === "\\"
    )
      return true;
  }
  return false;
}
// Windows refuses these characters, a name that ends in a dot or a space,
// and the device names (with any extension): `NUL.txt` opens the device.
const windowsCharacters = /[<>:"|?*]/;
const windowsDevice =
  /^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[0-9¹²³]|LPT[0-9¹²³])$/i;

/** Whether one name may appear in a served path: not empty, not `.` or `..`,
 * not hidden (a leading dot: such entries are neither listed nor served),
 * no control character or separator, at most `maxNameBytes`, and on Windows
 * none of the names Windows itself refuses. */
export function segmentRefusal(
  segment: string,
  platform: string,
): PathRefusal | null {
  if (segment === "" || segment === "." || segment === "..")
    return "path-invalid";
  if (segment.startsWith(".")) return "path-hidden";
  if (forbiddenCharacter(segment)) return "path-invalid";
  if (utf8Bytes(segment) > maxNameBytes) return "path-invalid";
  if (
    platform === "win32" &&
    (windowsCharacters.test(segment) ||
      /[. ]$/.test(segment) ||
      windowsDevice.test(segment.split(".")[0]?.trimEnd() ?? ""))
  )
    return "path-invalid";
  return null;
}

export type ParsedPath =
  | Readonly<{ segments: readonly string[] }>
  | Readonly<{ refusal: PathRefusal }>;

function checked(segments: readonly string[], platform: string): ParsedPath {
  if (segments.length > maxDepth) return { refusal: "path-invalid" };
  let bytes = 0;
  // The first refusal decides, so a hidden name inside an invalid path is
  // still `path-invalid` only when it comes first.
  for (const segment of segments) {
    const refusal = segmentRefusal(segment, platform);
    if (refusal !== null) return { refusal };
    bytes += utf8Bytes(segment) + 1;
  }
  if (bytes > maxPathBytes) return { refusal: "path-invalid" };
  return { segments: Object.freeze([...segments]) };
}

/** A relative path as the API and the CLI write it: names separated by `/`,
 * no leading or trailing separator; the empty string is the Documents folder
 * itself. Nothing is decoded: the caller passes the decoded value. */
export function parseRelativePath(input: string, platform: string): ParsedPath {
  if (input === "") return { segments: Object.freeze([]) };
  return checked(input.split("/"), platform);
}

/** The path of a Files URL after its `/files` prefix (`""`, `"/"` or
 * `"/a/b%20c"`), each segment percent-decoded once. A trailing `/` is
 * ignored; an encoded separator (`%2f`, `%5c`) or a dot segment that
 * survived the URL parser decodes into a refused name. */
export function parseUrlPath(raw: string, platform: string): ParsedPath {
  if (raw === "" || raw === "/") return { segments: Object.freeze([]) };
  if (!raw.startsWith("/")) return { refusal: "path-invalid" };
  const trimmed = raw.endsWith("/") ? raw.slice(1, -1) : raw.slice(1);
  const segments: string[] = [];
  for (const part of trimmed.split("/")) {
    try {
      segments.push(decodeURIComponent(part));
    } catch {
      return { refusal: "path-invalid" };
    }
  }
  return checked(segments, platform);
}

// RFC 3986 unreserved characters stay; everything else is percent-encoded,
// also `!'()*`, which encodeURIComponent keeps but chat renderers and RFC
// 5987 do not.
const encodeName = (name: string) =>
  encodeURIComponent(name).replace(
    /[!'()*]/g,
    (character) =>
      `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`,
  );

/** The path part of a Files URL: `/files` for the Documents folder itself,
 * `/files/<name>/<name>` below it, every name percent-encoded. */
export function filesUrlPath(segments: readonly string[]): string {
  return segments.length === 0
    ? "/files"
    : `/files/${segments.map(encodeName).join("/")}`;
}

/** The names an upload may end under, in order: the name itself, then
 * `name (2).ext`, `name (3).ext`, …; an existing file is never replaced. */
export function* uploadNames(name: string, limit = 1000): Generator<string> {
  yield name;
  const dot = name.lastIndexOf(".");
  const [stem, extension] =
    dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  for (let count = 2; count <= limit; count++)
    yield `${stem} (${count})${extension}`;
}

// Content types by extension for what an office team downloads. Active
// content (HTML, SVG, XML, scripts) is deliberately absent: it is served as
// `application/octet-stream` and only ever as an attachment.
const contentTypes: Readonly<Record<string, string>> = {
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  odp: "application/vnd.oasis.opendocument.presentation",
  rtf: "application/rtf",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  zip: "application/zip",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
};

export function contentType(name: string): string {
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  return Object.hasOwn(contentTypes, extension)
    ? (contentTypes[extension] as string)
    : "application/octet-stream";
}

/** `attachment` with the name twice (RFC 6266): an ASCII fallback, with
 * diacritics dropped (`Zpráva` → `Zprava`) and anything else outside
 * printable ASCII replaced, for old clients, and the exact UTF-8 name as an
 * RFC 5987 `filename*`, which every current browser prefers. */
export function contentDisposition(name: string): string {
  const fallback = name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x20-\x7e]|["\\%]/gu, "_");
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeName(name)}`;
}

/** The archive of a folder is named after it; the Documents folder's own
 * archive is `Documents.zip`. Its entries sit under the same name. */
export function archiveName(segments: readonly string[]): string {
  return segments.at(-1) ?? "Documents";
}
