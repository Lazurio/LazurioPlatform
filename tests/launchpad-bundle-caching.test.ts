import { afterAll, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assetCaching,
  bundledFileCaching,
  bundledFilePaths,
  contentHashedName,
} from "../src/launchpad/page";
import { freePort } from "./fixtures/ports";
import { runChild } from "./fixtures/run-child";

// #532: through the gateway's path the bundle's hashed files are kept a year,
// although the compiled executable serves them with no `Cache-Control`; the
// page itself is never stored.

const file = (path: string, loader: "html" | "js" | "css" | "file") => ({
  path,
  loader,
  isEntry: loader === "html",
  headers: { etag: "x", "content-type": "y" },
});

test("a name proves its content only as Bun names a compiled page's output", () => {
  // As a compiled candidate served them on 2026-10-20.
  for (const name of [
    "chunk-ghc4ygpz.js",
    "chunk-ejehpt9h.css",
    "symbol-color-j5ttq22m.svg",
    "bitwarden-api-key-en-71bjxp3z.webp",
  ])
    expect(contentHashedName(name)).toBe(true);
  for (const name of [
    "runtime-config.js",
    "chunk.js",
    "chunk-ghc4ygp.js",
    "chunk-ghc4ygpzz.js",
    "chunk-GHC4YGPZ.js",
    // i, l, o and u are no characters of Crockford base32.
    "chunk-ghc4ygpi.js",
    "chunk-ghc4ygpu.js",
    "chunk-ghc4ygpz",
    "assets/chunk-ghc4ygpz.js",
    "-ghc4ygpz.js",
  ])
    expect(contentHashedName(name)).toBe(false);
});

test("the content-hashed files are the non-page files beside their page, POSIX and Windows alike", () => {
  expect([
    ...bundledFilePaths([
      {
        index: "/$bunfs/root/index-aaaaaaaa.html",
        files: [
          file("/$bunfs/root/index-aaaaaaaa.html", "html"),
          file("/$bunfs/root/chunk-bbbbbbbb.js", "js"),
          file("/$bunfs/root/chunk-cccccccc.css", "css"),
          file("/$bunfs/root/logo-dddddddd.svg", "file"),
          // Listed, but no name that proves its content.
          file("/$bunfs/root/runtime-config.js", "js"),
          file("/$bunfs/root/assets/logo-dddddddd.svg", "file"),
          file("/elsewhere/chunk-eeeeeeee.js", "js"),
        ],
      },
      {
        index: "B:\\~BUN\\root\\new-tab-ffffffff.html",
        files: [file("B:\\~BUN\\root\\chunk-gggggggg.js", "js")],
      },
      // Run from source: Bun lists nothing.
      { index: "/source/src/launchpad/index.html" },
    ]),
  ]).toEqual([
    "/chunk-bbbbbbbb.js",
    "/chunk-cccccccc.css",
    "/logo-dddddddd.svg",
    "/chunk-gggggggg.js",
  ]);
});

test("only a content-hashed file is kept a year; a listed file without that name keeps the inner caching, or no-store", () => {
  const hashed = bundledFilePaths([
    {
      index: "/$bunfs/root/index-aaaaaaaa.html",
      files: [
        file("/$bunfs/root/chunk-bbbbbbbb.js", "js"),
        file("/$bunfs/root/runtime-config.js", "js"),
      ],
    },
  ]);
  expect(assetCaching("/chunk-bbbbbbbb.js", null, hashed)).toBe(
    bundledFileCaching,
  );
  expect(assetCaching("/chunk-bbbbbbbb.js?v=1", "no-store", hashed)).toBe(
    bundledFileCaching,
  );
  expect(assetCaching("/runtime-config.js", null, hashed)).toBe("no-store");
  expect(assetCaching("/runtime-config.js", "no-cache", hashed)).toBe(
    "no-cache",
  );
  expect(
    assetCaching(
      "/.lazurio/fonts/a.woff2",
      "public, max-age=604800, immutable",
      hashed,
    ),
  ).toBe("public, max-age=604800, immutable");
});

let root: string | undefined;
afterAll(async () => root && rm(root, { recursive: true, force: true }));

test.skipIf(process.platform === "win32")(
  "the compiled executable's hashed files are kept a year through the gateway's path, the page never",
  async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "bundle-caching-")));
    const binary = join(root, "hosted-bundle-files");
    const build = await runChild([
      process.execPath,
      "build",
      new URL("./fixtures/hosted-bundle-files.ts", import.meta.url).pathname,
      "--compile",
      "--no-compile-autoload-dotenv",
      "--no-compile-autoload-bunfig",
      "--outfile",
      binary,
    ]);
    expect(build.exitCode, build.stderr).toBe(0);
    const run = await runChild([binary, String(freePort())], {
      timeout: 60_000,
    });
    expect(run.exitCode, run.stderr).toBe(0);
    const seen = JSON.parse(run.stdout.trim().split("\n").at(-1) as string);
    expect(seen.page).toMatchObject({ status: 200, cacheControl: "no-store" });
    const paths: string[] = seen.files.map(
      (file: { path: string }) => file.path,
    );
    expect(paths.some((path) => /^\/chunk-[^/]+\.js$/.test(path))).toBe(true);
    expect(paths.some((path) => /^\/chunk-[^/]+\.css$/.test(path))).toBe(true);
    for (const file of seen.files) {
      expect(file).toMatchObject({
        status: 200,
        cacheControl: bundledFileCaching,
      });
      expect(file.etag).not.toBeNull();
      // Asked again with its ETag: not sent again, and still kept a year.
      expect(file.revalidated).toMatchObject({
        status: 304,
        cacheControl: bundledFileCaching,
      });
    }
    // A missing file is not one of them and is never stored.
    expect(seen.missing).toMatchObject({
      status: 404,
      cacheControl: "no-store",
    });
    // Every file the compiled bundle lists has a name that proves its
    // content: should Bun name them otherwise, this says so before a file
    // silently loses its caching.
    expect(seen.listed.length).toBeGreaterThan(0);
    expect(seen.hashed).toEqual(seen.listed);
  },
  120_000,
);
