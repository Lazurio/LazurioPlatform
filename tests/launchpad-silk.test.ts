import { expect, test } from "bun:test";
import { silk, silkId } from "../src/launchpad/silk";

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

test("two different offers never share their gradients' ids", () => {
  const seeds = ["a-b", "ab", "a_b", "a_2d_b", "a.b", "A-B", "šablona"];
  const ids = seeds.map(silkId);
  expect(new Set(ids).size).toBe(seeds.length);
  for (const id of ids) expect(id).toMatch(/^shot-silk-[A-Za-z0-9_]+$/);
});
