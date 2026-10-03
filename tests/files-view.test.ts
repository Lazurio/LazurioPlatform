import { expect, test } from "bun:test";
import {
  downloadPath,
  filesCrumbs,
  filesHref,
  filesState,
  formatModified,
  formatSize,
  listPath,
  parseFilesListing,
  uploadOutcome,
  uploadPath,
  zipName,
  zipPath,
} from "../src/launchpad/files-view";
import { messages } from "../src/launchpad/messages";

// The page side of the Files page (decision F34), without a DOM: what it
// accepts from the server, the paths it asks for and what it says.

const entry = {
  name: "Zpráva.docx",
  kind: "file",
  size: 107_000_000,
  modifiedAt: "2026-10-02T08:30:00.000Z",
} as const;

test("a listing is accepted only in its exact shape", () => {
  const listing = {
    path: "Úkol",
    entries: [
      {
        name: "podklady",
        kind: "directory" as const,
        size: null,
        modifiedAt: entry.modifiedAt,
      },
      entry,
    ],
  };
  expect(parseFilesListing(listing)).toEqual(listing);
  for (const value of [
    null,
    { path: "", entries: [], extra: 1 },
    { path: 1, entries: [] },
    { path: "", entries: [{ ...entry, size: -1 }] },
    { path: "", entries: [{ ...entry, size: null }] },
    { path: "", entries: [{ ...entry, kind: "link" }] },
    { path: "", entries: [{ ...entry, name: "" }] },
    { path: "", entries: [{ ...entry, modifiedAt: "yesterday" }] },
    { path: "", entries: [{ ...entry, html: "<b>" }] },
    {
      path: "",
      entries: [
        { name: "x", kind: "directory", size: 1, modifiedAt: entry.modifiedAt },
      ],
    },
  ])
    expect(parseFilesListing(value)).toBeNull();
});

test("every request path encodes the folder's names", () => {
  const path = ["Úkol 42", "a&b=c"];
  expect(listPath(path)).toBe(
    "/api/files/list?path=%C3%9Akol%2042%2Fa%26b%3Dc",
  );
  expect(downloadPath(["x.docx"])).toBe("/api/files/download?path=x.docx");
  expect(zipPath([])).toBe("/api/files/zip?path=");
  expect(uploadPath(["Úkol"], "Zpráva #1.docx")).toBe(
    "/api/files/upload?path=%C3%9Akol&name=Zpr%C3%A1va%20%231.docx",
  );
  expect(filesHref(["Úkol", "Zpráva.docx"])).toBe(
    "/files/%C3%9Akol/Zpr%C3%A1va.docx",
  );
  expect(zipName([])).toBe("Documents.zip");
  expect(zipName(["Úkol"])).toBe("Úkol.zip");
});

test("sizes read in decimal units, Czech with a decimal comma, never broken apart", () => {
  expect(formatSize(0, "en")).toBe("0 B");
  expect(formatSize(999, "en")).toBe("999 B");
  expect(formatSize(1_500, "en")).toBe("1.5 kB");
  expect(formatSize(107_000_000, "en")).toBe("107 MB");
  expect(formatSize(107_000_000, "cs")).toBe("107 MB");
  expect(formatSize(2_340_000_000, "cs")).toBe("2,3 GB");
  expect(formatSize(5e15, "en")).toBe("5,000 TB");
});

// The exact punctuation is ICU's and differs between versions; the date in
// the language's order and the time in the asked zone are what matter.
test("a modification time is shown in the reader's language and time zone", () => {
  const en = formatModified(entry.modifiedAt, "en", "UTC");
  expect(en).toContain("Oct 2, 2026");
  expect(en).toContain("8:30");
  const cs = formatModified(entry.modifiedAt, "cs", "Europe/Prague");
  expect(cs).toContain("2. 10. 2026");
  expect(cs).toContain("10:30");
});

test("the path is the Documents folder, then each folder, the last one current", () => {
  expect(filesCrumbs([], messages("cs"))).toEqual([
    { label: "Dokumenty", href: "/files", current: true },
  ]);
  expect(filesCrumbs(["Úkol", "Q3"], messages("en"))).toEqual([
    { label: "Documents", href: "/files", current: false },
    { label: "Úkol", href: "/files/%C3%9Akol", current: false },
    { label: "Q3", href: "/files/%C3%9Akol/Q3", current: true },
  ]);
});

test("a listing answer becomes the folder, a file, a missing path or a failure", () => {
  expect(filesState([], true, { path: "", entries: [] })).toEqual({
    kind: "loaded",
    listing: { path: "", entries: [] },
  });
  expect(
    filesState(["Úkol", "a.docx"], false, { error: "not-directory" }),
  ).toEqual({
    kind: "file",
    name: "a.docx",
  });
  for (const error of [
    "not-found",
    "path-hidden",
    "path-invalid",
    "outside-documents",
    "not-regular",
  ])
    expect(filesState(["x"], false, { error })).toEqual({ kind: "missing" });
  expect(filesState([], false, { error: "documents-unavailable" })).toEqual({
    kind: "unavailable",
  });
  expect(filesState([], false, { error: "denied" })).toEqual({
    kind: "failed",
  });
  expect(filesState([], true, { entries: "x" })).toEqual({ kind: "failed" });
});

test("an upload says where it landed, or why not, in words", () => {
  const en = messages("en");
  expect(uploadOutcome("a.docx", 201, { name: "a.docx" }, en)).toEqual({
    ok: true,
    name: "a.docx",
    text: "Uploaded",
  });
  expect(uploadOutcome("a.docx", 201, { name: "a (2).docx" }, en)).toEqual({
    ok: true,
    name: "a (2).docx",
    text: "Uploaded as a (2).docx",
  });
  // A decomposed name the server stored in NFC is the same name.
  expect(
    uploadOutcome("Zpráva.txt", 201, { name: "Zpráva.txt" }, en).text,
  ).toBe("Uploaded");
  for (const [status, error, text] of [
    [507, "disk-full", en.filesUploadDiskFull],
    [400, "upload-incomplete", en.filesUploadIncomplete],
    [404, "path-hidden", en.filesUploadName],
    [409, "name-unavailable", en.filesUploadName],
    [404, "not-found", en.filesUploadMissing],
    [500, "operation-failed", en.filesUploadFailed],
  ] as const)
    expect(uploadOutcome("a.docx", status, { error }, en)).toEqual({
      ok: false,
      name: "a.docx",
      text,
    });
  expect(uploadOutcome("a.docx", 0, null, messages("cs")).text).toBe(
    "Nahrání se nezdařilo. Zkuste to znovu.",
  );
});
