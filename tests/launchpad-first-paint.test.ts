import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pageFrame } from "../src/launchpad/routes";
import { fontFaceCss } from "../src/shell/fonts";

// The first paint is the final page (F36's addendum of 2026-10-08): the
// page names its frame before anything of it runs, the same way its frame
// does later, and declares the shell's fonts itself. What it looks like is
// checked in a browser, not here (root decision 0178).

const page = await readFile(
  join(import.meta.dir, "..", "src", "launchpad", "index.html"),
  "utf8",
);

/** What the inline script of the page writes on `<html>` for a path. */
function frameOf(pathname: string) {
  const script = /<script data-lazurio-frame>([\s\S]*?)<\/script>/.exec(
    page,
  )?.[1];
  if (script === undefined) throw new Error("No frame script in the page");
  const attributes = new Map<string, string>();
  new Function("location", "document", script)(
    { pathname },
    {
      documentElement: {
        setAttribute: (name: string, value: string) =>
          attributes.set(name, value),
      },
    },
  );
  return {
    frame: attributes.get("data-frame"),
    section: attributes.get("data-section") ?? null,
  };
}

test("the page's first frame is the frame its route shows", () => {
  for (const path of [
    "/",
    "",
    "//",
    "/o/example",
    "/o/example/deals",
    "/o/example/deals/more",
    "/o/%E2%9C%93",
    "/files",
    "/files/",
    "/files/Nab%C3%ADdky",
    "/files/a/b",
    "/files/a%2Fb",
    "/filesx",
    "/marketplace",
    "/marketplace/",
    "/marketplace//",
    "/marketplacex",
    "/settings",
    "/settings/",
    "/settings/general",
    "/settings/machine",
    "/settings/tools",
    "/settings/tools/",
    "/settings/recovery",
    "/settings/unknown",
    "/settings/tools/x",
    "/settings//tools",
    "/settings/%74ools",
    "/settingsx",
    "/Settings/tools",
    "/elsewhere",
  ])
    expect([path, frameOf(path)]).toEqual([path, pageFrame(path)]);
});

test("the page declares the shell's font faces itself, exactly as the elements would", () => {
  const declared = /<style data-lazurio-fonts>\n([\s\S]*?)\n<\/style>/.exec(
    page,
  )?.[1];
  expect(declared).toBe(fontFaceCss());
});
