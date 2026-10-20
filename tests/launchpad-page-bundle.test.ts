import { expect, test } from "bun:test";

// The Launchpad's pages bundled for the browser, as the Launchpad run from
// source serves them (plan DEV-6656): the page takes a few lists and labels
// from modules the server also uses, and an import of `node:crypto` there put
// its browser stand-in, with `node:stream` and `node:buffer`, half a megabyte,
// into the page's script. The compiled executable leaves them out by itself;
// this keeps the browser bundle from carrying them again.

test("the pages' script, bundled for the browser, carries no Node stand-in of crypto, stream or buffer", async () => {
  const result = await Bun.build({
    entrypoints: [
      new URL("../src/launchpad/index.html", import.meta.url).pathname,
      new URL("../src/launchpad/new-tab.html", import.meta.url).pathname,
    ],
    target: "browser",
    minify: true,
    metafile: true,
  });
  expect(result.success).toBe(true);
  const inputs = Object.keys(result.metafile?.inputs ?? {});
  expect(inputs.some((input) => input.endsWith("src/launchpad/ui.ts"))).toBe(
    true,
  );
  expect(
    inputs.filter((input) =>
      ["node:crypto", "node:stream", "node:buffer"].includes(input),
    ),
  ).toEqual([]);
});
