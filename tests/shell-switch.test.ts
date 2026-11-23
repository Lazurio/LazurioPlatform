import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { columnHeadCss } from "../src/shell/styles";

// The switch Chat · Apps · Automate in a narrow column: a label wider than
// its third ends in "…" instead of running over its neighbour, and the tab
// keeps the whole name in its title (Anna 2026-11-23, "Automatizace" in
// Inter at 11 px over "Aplikace").

test("a switch label is cut with an ellipsis inside its tab", () => {
  const rule = /\.tab span \{([^}]*)\}/.exec(columnHeadCss)?.[1] ?? "";
  for (const declaration of [
    "max-width: 100%",
    "overflow: hidden",
    "text-overflow: ellipsis",
    "white-space: nowrap",
  ])
    expect(rule).toContain(declaration);
  // The tab may shrink below its label's width, so the label is what gives.
  expect(/\.tab \{[^}]*min-width: 0/.test(columnHeadCss)).toBe(true);
});

test("every switch link carries its whole name as its title", () => {
  const source = readFileSync(
    new URL("../src/shell/elements.ts", import.meta.url),
    "utf8",
  );
  expect(source).toContain("anchor.title = tab.label;");
});
