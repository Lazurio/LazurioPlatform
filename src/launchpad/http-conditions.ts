// The conditions of a GET the Launchpad answers itself (RFC 9110 13 and
// 14.2): whether the browser's copy is still the current one, and which one
// byte range it asks for. The Files downloads (files-routes.ts), the shell's
// script (page.ts) and the guide videos (guide-video-files.ts) share them.

/** Whether a request's `If-None-Match` names `etag` (`*`, or the tag, weak
 * or strong). */
export function notModified(request: Request, etag: string): boolean {
  const asked = request.headers.get("if-none-match");
  if (asked === null) return false;
  const tag = etag.replace(/^W\//, "");
  return asked
    .split(",")
    .map((value) => value.trim())
    .some((value) => value === "*" || value.replace(/^W\//, "") === tag);
}

export type ByteRange =
  | Readonly<{ kind: "full" }>
  | Readonly<{ kind: "range"; start: number; end: number }>
  | Readonly<{ kind: "unsatisfiable" }>;

/** The one byte range of a request (RFC 9110 14.2), inclusive. A missing,
 * malformed or multiple range, another unit, or an `If-Range` that names
 * another version of the file is the whole file; a start past its end is
 * unsatisfiable. */
export function selectRange(
  range: string | null,
  ifRange: string | null,
  size: number,
  validators: Readonly<{ etag: string; lastModified: string }>,
): ByteRange {
  if (range === null) return { kind: "full" };
  if (
    ifRange !== null &&
    ifRange.trim() !== validators.etag &&
    ifRange.trim() !== validators.lastModified
  )
    return { kind: "full" };
  const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (match === null) return { kind: "full" };
  const [first = "", last = ""] = [match[1], match[2]];
  if (first === "" && last === "") return { kind: "full" };
  if (size === 0) return { kind: "unsatisfiable" };
  if (first === "") {
    const suffix = Number(last);
    return suffix === 0
      ? { kind: "unsatisfiable" }
      : { kind: "range", start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(first);
  if (last !== "" && Number(last) < start) return { kind: "full" };
  if (start >= size) return { kind: "unsatisfiable" };
  return {
    kind: "range",
    start,
    end: last === "" ? size - 1 : Math.min(Number(last), size - 1),
  };
}
