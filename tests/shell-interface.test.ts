import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { shellElementInterface } from "../src/shell/interface";
import { columnHeadCss, railCss } from "../src/shell/styles";
import { shellApps } from "../src/shell/view";

// Decision F36, addendum of 2026-10-04: the forks (T3 Code, MausBot) and the
// Dashboard build on the elements' interface v1. A Launchpad release may add
// to it and redraw everything, but never rename or remove a promised name.
// Changing this snapshot is a new interface version, not a refactor.

test("the promised interface v1 is exactly this", () => {
  expect(JSON.parse(JSON.stringify(shellElementInterface))).toEqual({
    version: 1,
    script: "/.lazurio/shell.js",
    elements: {
      "lazurio-rail": ["lang"],
      "lazurio-column-head": ["active", "lang"],
      "lazurio-buddy": [],
    },
    active: ["chat", "apps", "automate"],
    events: ["lazurio-navigate", "lazurio-app"],
    properties: [
      "--lazurio-rail-width",
      "--lazurio-host-tone",
      "--lazurio-surface",
      "--lazurio-ink",
      "--lazurio-ink-muted",
      "--lazurio-line",
      "--lazurio-line-strong",
      "--lazurio-hover",
      "--lazurio-selected",
      "--lazurio-control",
      "--lazurio-raised",
      "--lazurio-overlay",
      "--lazurio-overlay-ink",
      "--lazurio-focus",
    ],
  });
});

test("the elements keep every promised name", async () => {
  const source = await readFile("src/shell/elements.ts", "utf8");
  const observed = (className: string) => {
    const at = source.indexOf(`class ${className} `);
    const match = /static observedAttributes = \[([^\]]*)\]/.exec(
      source.slice(at),
    );
    return [...(match?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  };
  for (const attribute of shellElementInterface.elements["lazurio-rail"])
    expect(observed("LazurioRail")).toContain(attribute);
  for (const attribute of shellElementInterface.elements["lazurio-column-head"])
    expect(observed("LazurioColumnHead")).toContain(attribute);
  for (const name of ["lazurio-rail", "lazurio-column-head"])
    expect(source).toContain(`customElements.define("${name}", `);
  for (const event of shellElementInterface.events)
    expect(source).toContain(`new CustomEvent("${event}"`);
  // The rail width and the tone in the script, the colour roles in the
  // styles of both elements.
  for (const property of shellElementInterface.properties)
    expect(
      source.includes(`"${property}"`) ||
        (railCss.includes(`var(${property},`) &&
          columnHeadCss.includes(`var(${property},`)),
    ).toBe(true);
  for (const app of shellElementInterface.active)
    expect(shellApps as readonly string[]).toContain(app);
});

// The colour roles (F36, addendum of 2026-10-04, evening) are optional: a
// host that sets none, or only some, keeps the design system's colour for
// the rest. A role is read either with that colour as its fallback, or in a
// `--shell-host-*` value that is itself only ever read with one.
test("an unset colour role leaves the design system's colour", () => {
  for (const css of [railCss, columnHeadCss]) {
    for (const declaration of css.split(/[;{}]/)) {
      if (!/var\(--lazurio-[a-z-]+\)/.test(declaration)) continue;
      expect(declaration.trim()).toMatch(/^--shell-host-[a-z-]+:/);
    }
    expect(css).not.toMatch(/var\(--shell-host-[a-z-]+\)/);
  }
});

test("the Launchpad serves the promised script", async () => {
  const page = await readFile("src/launchpad/page.ts", "utf8");
  expect(page).toContain(`"${shellElementInterface.script}":`);
});
