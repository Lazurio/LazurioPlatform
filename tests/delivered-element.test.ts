import { expect, test } from "bun:test";
import {
  deliverElement,
  deliveredCaching,
  shellScriptSrc,
} from "../src/launchpad/delivered-element";

// The deliverer's contract (plan LZD-0039 `task-2026-11-25-101`, reviewed in
// mission-control-data#424): the version of a page is the deliverer's,
// never the page's. Failure means: a page in production framed because its
// own element names no version, a STAGING page framed as DEV, a second
// element, or a non-HTML answer touched.

const page = (body: string, type = "text/html; charset=utf-8") =>
  new Response(body, {
    headers: { "content-type": type, "content-length": String(body.length) },
  });
const deliver = async (body: string, version: "staging" | "production") =>
  deliverElement(page(body), version).text();
const count = (html: string, needle: string) => html.split(needle).length - 1;

test("a page without the element gets exactly one, with the deliverer's version, and the script once", async () => {
  for (const version of ["staging", "production"] as const) {
    const html = await deliver(
      "<!doctype html><html><head><title>x</title></head><body><main>App</main></body></html>",
      version,
    );
    expect(count(html, "<lazurio-buddy")).toBe(1);
    expect(html).toContain(
      `<script type="module" src="${shellScriptSrc}"></script><lazurio-buddy version="${version}"></lazurio-buddy></body>`,
    );
    expect(html).toContain("<main>App</main>");
  }
});

test("the page's own element takes the deliverer's version, whatever it named, and none is added", async () => {
  for (const own of [
    "<lazurio-buddy></lazurio-buddy>",
    '<lazurio-buddy version="dev" lang="cs"></lazurio-buddy>',
    '<lazurio-buddy version="staging"></lazurio-buddy>',
    '<lazurio-buddy version="nonsense"></lazurio-buddy>',
    "<lazurio-buddy version></lazurio-buddy>",
  ]) {
    const html = await deliver(
      `<html><body><script type="module" src="/.lazurio/shell.js"></script>${own}</body></html>`,
      "production",
    );
    expect(count(html, "<lazurio-buddy")).toBe(1);
    expect(html).toContain('version="production"');
    expect(html).not.toMatch(/version="(dev|staging|nonsense)"/);
    expect(count(html, "/.lazurio/shell.js")).toBe(1);
  }
  // Other attributes stay.
  expect(
    await deliver(
      '<body><lazurio-buddy version="dev" lang="cs"></lazurio-buddy></body>',
      "staging",
    ),
  ).toContain('lang="cs"');
});

test("several elements all take the version; a lookalike name is no element", async () => {
  const html = await deliver(
    '<body><lazurio-buddy version="dev"></lazurio-buddy><div><lazurio-buddy></lazurio-buddy></div><lazurio-buddy-x></lazurio-buddy-x></body>',
    "staging",
  );
  expect(count(html, 'version="staging"')).toBe(2);
  expect(count(html, "<lazurio-buddy ")).toBe(2);
  expect(html).toContain("<lazurio-buddy-x></lazurio-buddy-x>");
});

test("a page that loads the script itself, by any spelling of its path, is not given a second one", async () => {
  for (const src of ["/.lazurio/shell.js", "/.lazurio/shell.js?v=2"]) {
    const html = await deliver(
      `<html><head><script type="module" src="${src}"></script></head><body></body></html>`,
      "staging",
    );
    expect(count(html, "shell.js")).toBe(1);
    expect(count(html, "<lazurio-buddy")).toBe(1);
  }
});

test("a page without a body gets them at its end", async () => {
  const html = await deliver("<p>fragment</p>", "staging");
  expect(html).toBe(
    `<p>fragment</p><script type="module" src="${shellScriptSrc}"></script><lazurio-buddy version="staging"></lazurio-buddy>`,
  );
});

test("any other answer is returned as it came, and a page drops its stale length and encoding", async () => {
  for (const type of [
    "application/json",
    "text/plain",
    "text/css",
    "image/svg+xml",
    "",
  ]) {
    const original = new Response("<body></body>", {
      headers: type ? { "content-type": type } : {},
    });
    expect(deliverElement(original, "staging")).toBe(original);
  }
  const empty = new Response(null, {
    status: 304,
    headers: { "content-type": "text/html" },
  });
  expect(deliverElement(empty, "staging")).toBe(empty);
  const delivered = deliverElement(
    new Response("<body></body>", {
      status: 404,
      headers: {
        "content-type": "text/html",
        "content-length": "13",
        "content-encoding": "gzip",
        "set-cookie": "a=1",
      },
    }),
    "staging",
  );
  expect(delivered.status).toBe(404);
  expect(delivered.headers.get("content-length")).toBeNull();
  expect(delivered.headers.get("content-encoding")).toBeNull();
  expect(delivered.headers.get("set-cookie")).toBe("a=1");
});

test("the same path on another origin is not the page's shell; the page's own origin is (review of #1254)", async () => {
  const other = await deliverElement(
    page(
      '<html><head><script type="module" src="https://other.example/.lazurio/shell.js"></script></head><body></body></html>',
    ),
    "staging",
    "https://notes.gamma.example",
  ).text();
  expect(count(other, 'src="/.lazurio/shell.js"')).toBe(1);
  const own = await deliverElement(
    page(
      '<html><head><script type="module" src="https://notes.gamma.example/.lazurio/shell.js"></script></head><body></body></html>',
    ),
    "staging",
    "https://notes.gamma.example",
  ).text();
  expect(count(own, "shell.js")).toBe(1);
});

test("a delivered page carries none of the app's validators and is asked for again", () => {
  const delivered = deliverElement(
    new Response("<body></body>", {
      headers: {
        "content-type": "text/html",
        etag: '"app"',
        "last-modified": "Mon, 01 Jan 2024 00:00:00 GMT",
        "cache-control": "max-age=3600",
      },
    }),
    "staging",
  );
  expect(delivered.headers.get("etag")).toBeNull();
  expect(delivered.headers.get("last-modified")).toBeNull();
  expect(delivered.headers.get("cache-control")).toBe("no-cache");
});

test("a delivered page is asked for again and never more storable than the app allowed (review of #1254)", () => {
  expect(deliveredCaching(null)).toBe("no-cache");
  expect(deliveredCaching("max-age=3600, public")).toBe("no-cache");
  expect(deliveredCaching("private, no-store")).toBe(
    "private, no-store, no-cache",
  );
  expect(deliveredCaching("No-Store")).toBe("no-store, no-cache");
  expect(deliveredCaching("private, max-age=60")).toBe("private, no-cache");
  // A qualified private directive keeps its restriction, as plain private.
  expect(deliveredCaching('private="Set-Cookie", max-age=60')).toBe(
    "private, no-cache",
  );
  expect(deliveredCaching('private="Set-Cookie, X-Token"')).toBe(
    "private, no-cache",
  );
  const delivered = deliverElement(
    new Response("<body></body>", {
      headers: {
        "content-type": "text/html",
        "cache-control": "private, no-store",
      },
    }),
    "staging",
  );
  expect(delivered.headers.get("cache-control")).toBe(
    "private, no-store, no-cache",
  );
});
