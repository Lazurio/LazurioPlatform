import { afterAll, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundledFileCaching, bundledFilePaths } from "../src/launchpad/page";
import { freePort } from "./fixtures/ports";
import { runChild } from "./fixtures/run-child";

// #532: through the gateway's path the bundle's hashed files are kept a year,
// although the compiled executable serves them with no `Cache-Control`; the
// page itself is never stored.

test("the bundled files are the non-page files under their page's directory, POSIX and Windows alike", () => {
  const file = (path: string, loader: "html" | "js" | "css" | "file") => ({
    path,
    loader,
    isEntry: loader === "html",
    headers: { etag: "x", "content-type": "y" },
  });
  expect([
    ...bundledFilePaths([
      {
        index: "/$bunfs/root/index-aaaaaaaa.html",
        files: [
          file("/$bunfs/root/index-aaaaaaaa.html", "html"),
          file("/$bunfs/root/chunk-bbbbbbbb.js", "js"),
          file("/$bunfs/root/chunk-cccccccc.css", "css"),
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
    "/assets/logo-dddddddd.svg",
    "/chunk-gggggggg.js",
  ]);
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
  },
  120_000,
);
