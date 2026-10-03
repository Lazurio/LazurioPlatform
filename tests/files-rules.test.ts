import { expect, test } from "bun:test";
import {
  archiveName,
  contentDisposition,
  contentType,
  filesUrlPath,
  parseRelativePath,
  parseUrlPath,
  segmentRefusal,
  uploadNames,
} from "../src/files/rules";

// Decision F35: one set of path rules for the Files routes, the page's route
// and `lazurio files link`. A path is names inside the Documents folder; the
// rules refuse everything that could leave it or reveal what is hidden.

test("a name is refused when empty, a dot segment, hidden, a separator, a control character or too long", () => {
  for (const name of ["", ".", ".."])
    expect([name, segmentRefusal(name, "linux")]).toEqual([
      name,
      "path-invalid",
    ]);
  for (const name of [".ssh", ".git", ".lazurio-upload-0123456789abcdef.part"])
    expect([name, segmentRefusal(name, "linux")]).toEqual([
      name,
      "path-hidden",
    ]);
  for (const name of [
    "a/b",
    "a\\b",
    "nul\u0000byte",
    "line\nbreak",
    "tab\tname",
    "del\u007f",
    "c1\u0085",
    "lone\uD800surrogate",
    "x".repeat(256),
    // 128 two-byte characters are 256 UTF-8 bytes.
    "é".repeat(128),
  ])
    expect([name, segmentRefusal(name, "linux")]).toEqual([
      name,
      "path-invalid",
    ]);
  for (const name of [
    "Zpráva pro klienta.docx",
    "report (2).pptx",
    "x".repeat(255),
    "😀 emoji.png",
    "a:b",
    "trailing.",
    "NUL.txt",
  ])
    expect([name, segmentRefusal(name, "linux")]).toEqual([name, null]);
  // Windows refuses its own reserved characters and device names.
  for (const name of [
    "a:b",
    "what?",
    "trailing.",
    "trailing ",
    "NUL.txt",
    "con",
    "COM1.log",
    "lpt¹",
  ])
    expect([name, segmentRefusal(name, "win32")]).toEqual([
      name,
      "path-invalid",
    ]);
  expect(segmentRefusal("console.log", "win32")).toBeNull();
});

test("a relative path is names separated by /; the empty path is the Documents folder", () => {
  expect(parseRelativePath("", "linux")).toEqual({ segments: [] });
  expect(parseRelativePath("Úkol/Zpráva.docx", "linux")).toEqual({
    segments: ["Úkol", "Zpráva.docx"],
  });
  for (const path of [
    "/etc/passwd",
    "a/",
    "a//b",
    "a/../b",
    "../outside",
    "./a",
    "a\\..\\b",
  ])
    expect([path, parseRelativePath(path, "linux")]).toEqual([
      path,
      { refusal: "path-invalid" },
    ]);
  expect(parseRelativePath("task/.secret/x", "linux")).toEqual({
    refusal: "path-hidden",
  });
  expect(
    parseRelativePath(Array.from({ length: 65 }, () => "a").join("/"), "linux"),
  ).toEqual({ refusal: "path-invalid" });
  expect(
    parseRelativePath(
      Array.from({ length: 20 }, () => "x".repeat(250)).join("/"),
      "linux",
    ),
  ).toEqual({ refusal: "path-invalid" });
});

test("a Files URL path is percent-decoded once per segment; encoded separators and dot segments stay refused", () => {
  expect(parseUrlPath("", "linux")).toEqual({ segments: [] });
  expect(parseUrlPath("/", "linux")).toEqual({ segments: [] });
  expect(parseUrlPath("/%C3%9Akol/Zpr%C3%A1va.docx", "linux")).toEqual({
    segments: ["Úkol", "Zpráva.docx"],
  });
  expect(parseUrlPath("/task/", "linux")).toEqual({ segments: ["task"] });
  // A double encoding decodes once: a literal name, not a traversal.
  expect(parseUrlPath("/%252e%252e", "linux")).toEqual({
    segments: ["%2e%2e"],
  });
  for (const raw of [
    "/%2e%2e/secret",
    "/%2E%2E",
    "/a%2f..%2f..%2fetc",
    "/a%2Fb",
    "/a%5cb",
    "/%00",
    "//double",
    "/bad%E0%A4%A",
    "no-leading-slash",
  ])
    expect([raw, parseUrlPath(raw, "linux")]).toEqual([
      raw,
      { refusal: "path-invalid" },
    ]);
  expect(parseUrlPath("/%2essh/id_rsa", "linux")).toEqual({
    refusal: "path-hidden",
  });
});

test("the URL of a path encodes every name, and decodes back to it", () => {
  expect(filesUrlPath([])).toBe("/files");
  const segments = ["Úkol 42", "Zpráva (final)!.docx", "100% done*'.txt"];
  const path = filesUrlPath(segments);
  expect(path).toBe(
    "/files/%C3%9Akol%2042/Zpr%C3%A1va%20%28final%29%21.docx/100%25%20done%2A%27.txt",
  );
  expect(parseUrlPath(path.slice("/files".length), "linux")).toEqual({
    segments,
  });
});

test("upload names never replace: the name, then (2), (3) before the extension", () => {
  expect([...uploadNames("report.docx", 4)]).toEqual([
    "report.docx",
    "report (2).docx",
    "report (3).docx",
    "report (4).docx",
  ]);
  expect([...uploadNames("README", 3)]).toEqual([
    "README",
    "README (2)",
    "README (3)",
  ]);
  expect([...uploadNames("archive.tar.gz", 2)]).toEqual([
    "archive.tar.gz",
    "archive.tar (2).gz",
  ]);
});

test("downloads carry the exact UTF-8 name, an ASCII fallback and a type that never renders active content", () => {
  expect(contentDisposition("Zpráva pro klienta.docx")).toBe(
    "attachment; filename=\"Zprava pro klienta.docx\"; filename*=UTF-8''Zpr%C3%A1va%20pro%20klienta.docx",
  );
  expect(contentDisposition('ř"\\%😀.txt')).toBe(
    "attachment; filename=\"r____.txt\"; filename*=UTF-8''%C5%99%22%5C%25%F0%9F%98%80.txt",
  );
  expect(contentType("Zpráva.DOCX")).toBe(
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  );
  expect(contentType("slides.pptx")).toBe(
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  );
  for (const name of ["page.html", "image.svg", "script.js", "noextension"])
    expect(contentType(name)).toBe("application/octet-stream");
  expect(archiveName([])).toBe("Documents");
  expect(archiveName(["Úkol", "Podklady"])).toBe("Podklady");
});
