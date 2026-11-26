import { expect, test } from "bun:test";
import { silk } from "../src/launchpad/silk";

// The blue silk behind an app template's screen (plan DEV-6593, silk.ts): an
// offer's card folds the same way on every visit, two offers fold differently,
// and the fabric is painted only with the design system's blue tokens, so it
// follows the tokens in light and dark mode.

test("an offer's silk folds the same way on every visit", () => {
  expect(silk("presentations")).toEqual(silk("presentations"));
});

test("two offers get different folds", () => {
  const a = silk("presentations");
  const b = silk("knowledgebase");
  expect(a.transform).not.toBe(b.transform);
  expect(a.ribbons[0]?.d).not.toBe(b.ribbons[0]?.d);
});

test("the fabric is painted only with the blue tokens and white", () => {
  const colours = silk("quotes").ribbons.flatMap((ribbon) => [
    ribbon.top,
    ribbon.mid,
    ribbon.bottom,
  ]);
  expect(colours.length).toBeGreaterThan(0);
  for (const colour of colours) {
    const plain = colour
      .replaceAll(/var\(--lz-blue-\d+\)/g, "")
      .replaceAll(/color-mix\(in srgb,|white|\d+%|[\s,()]/g, "");
    expect(plain).toBe("");
  }
});
