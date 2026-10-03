import { archiveName, filesUrlPath } from "../files/rules";
import type { MessageKey } from "./messages";
import { fill } from "./update-view";

type Copy = Readonly<Record<MessageKey, string>>;
type Locale = "cs" | "en";

// Pure presentation of the Files page (decision F35); the DOM lives in
// files-panel.ts. Every value from the server is shown as text, never as
// markup, and every request path is built here from the folder's names.

export type FilesEntry = Readonly<{
  name: string;
  kind: "file" | "directory";
  size: number | null;
  modifiedAt: string;
}>;

export type FilesListing = Readonly<{
  path: string;
  entries: readonly FilesEntry[];
}>;

function isEntry(value: unknown): value is FilesEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    Object.keys(entry).length === 4 &&
    typeof entry.name === "string" &&
    entry.name !== "" &&
    (entry.kind === "directory"
      ? entry.size === null
      : entry.kind === "file" &&
        typeof entry.size === "number" &&
        Number.isSafeInteger(entry.size) &&
        entry.size >= 0) &&
    typeof entry.modifiedAt === "string" &&
    !Number.isNaN(Date.parse(entry.modifiedAt))
  );
}

/** The answer of `GET /api/files/list` in its exact shape, or null. */
export function parseFilesListing(value: unknown): FilesListing | null {
  if (typeof value !== "object" || value === null) return null;
  const answer = value as Record<string, unknown>;
  if (
    Object.keys(answer).length !== 2 ||
    typeof answer.path !== "string" ||
    !Array.isArray(answer.entries) ||
    !answer.entries.every(isEntry)
  )
    return null;
  return { path: answer.path, entries: answer.entries };
}

/** The refusal code of an answer (`{ error }`), or null. */
export function filesError(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const error = (value as Record<string, unknown>).error;
  return typeof error === "string" ? error : null;
}

const query = (path: readonly string[]) =>
  `path=${encodeURIComponent(path.join("/"))}`;
export const listPath = (path: readonly string[]) =>
  `/api/files/list?${query(path)}`;
export const downloadPath = (path: readonly string[]) =>
  `/api/files/download?${query(path)}`;
export const zipPath = (path: readonly string[]) =>
  `/api/files/zip?${query(path)}`;
export const uploadPath = (path: readonly string[], name: string) =>
  `/api/files/upload?${query(path)}&name=${encodeURIComponent(name)}`;
/** The page of a folder, and the download of a file behind a gateway: the
 * same link `lazurio files link` prints. */
export const filesHref = (path: readonly string[]) => filesUrlPath(path);
/** The name a folder's archive is saved under. */
export const zipName = (path: readonly string[]) => `${archiveName(path)}.zip`;

const numberLocale = (locale: Locale) => (locale === "cs" ? "cs-CZ" : "en-US");
const units = ["B", "kB", "MB", "GB", "TB"] as const;

/** Bytes in decimal units, as people read sizes: `107 MB`, `1.5 GB`;
 * Czech with a decimal comma. Number and unit never wrap apart. */
export function formatSize(bytes: number, locale: Locale): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  const digits = unit === 0 || value >= 10 ? 0 : 1;
  const number = new Intl.NumberFormat(numberLocale(locale), {
    maximumFractionDigits: digits,
  }).format(value);
  return `${number} ${units[unit]}`;
}

/** The modification time in the browser's time zone (or `timeZone`). */
export function formatModified(
  iso: string,
  locale: Locale,
  timeZone?: string,
): string {
  return new Intl.DateTimeFormat(numberLocale(locale), {
    dateStyle: "medium",
    timeStyle: "short",
    ...(timeZone === undefined ? {} : { timeZone }),
  }).format(new Date(iso));
}

export type FilesCrumb = Readonly<{
  label: string;
  href: string;
  current: boolean;
}>;

/** The folder's path as links: the Documents folder, then each folder
 * below it; the last one is the current page. */
export function filesCrumbs(
  path: readonly string[],
  copy: Copy,
): readonly FilesCrumb[] {
  return [copy.filesRoot, ...path].map((label, index) => ({
    label,
    href: filesHref(path.slice(0, index)),
    current: index === path.length,
  }));
}

export type FilesState =
  | Readonly<{ kind: "loaded"; listing: FilesListing }>
  | Readonly<{ kind: "missing" }>
  | Readonly<{ kind: "file"; name: string }>
  | Readonly<{ kind: "unavailable" }>
  | Readonly<{ kind: "failed" }>;

/** What a listing answer means for the page. A name refused by the rules,
 * or a link out of the folder, is reported like a missing one. */
export function filesState(
  path: readonly string[],
  ok: boolean,
  value: unknown,
): FilesState {
  if (ok) {
    const listing = parseFilesListing(value);
    return listing === null ? { kind: "failed" } : { kind: "loaded", listing };
  }
  const error = filesError(value);
  if (error === "not-directory" && path.length > 0)
    return { kind: "file", name: path.at(-1) as string };
  if (error === "documents-unavailable") return { kind: "unavailable" };
  if (
    error === "not-found" ||
    error === "path-hidden" ||
    error === "path-invalid" ||
    error === "outside-documents" ||
    error === "not-regular"
  )
    return { kind: "missing" };
  return { kind: "failed" };
}

/** The sentence of a finished upload: done, renamed, or why it failed. */
export function uploadOutcome(
  requested: string,
  status: number,
  value: unknown,
  copy: Copy,
): Readonly<{ ok: boolean; text: string; name: string }> {
  if (status === 201 && typeof value === "object" && value !== null) {
    const saved = (value as Record<string, unknown>).name;
    if (typeof saved === "string")
      return {
        ok: true,
        name: saved,
        text:
          saved === requested.normalize("NFC")
            ? copy.filesUploaded
            : fill(copy.filesUploadedAs, { name: saved }),
      };
  }
  const error = filesError(value);
  const text =
    error === "disk-full"
      ? copy.filesUploadDiskFull
      : error === "upload-incomplete"
        ? copy.filesUploadIncomplete
        : error === "path-invalid" ||
            error === "path-hidden" ||
            error === "name-unavailable"
          ? copy.filesUploadName
          : error === "not-found" ||
              error === "not-directory" ||
              error === "outside-documents"
            ? copy.filesUploadMissing
            : copy.filesUploadFailed;
  return { ok: false, name: requested, text };
}
