import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { hostTokens } from "../src/shell/base-styles";
import { designTokens } from "../src/shell/design-tokens";
import { shellFonts } from "../src/shell/fonts";
import { environmentCss } from "../src/shell/identity-styles";
import { shellElementInterface } from "../src/shell/interface";
import { columnHeadCss, railCss } from "../src/shell/styles";
import {
  installShellTokens,
  shellTheme,
  shellTokensCss,
  type TokenDocument,
} from "../src/shell/tokens";

// F36's addendum of 2026-10-13 (root decision 0200): `/.lazurio/shell.js`
// puts the vendored tokens.css, without its comments, on the root of the
// app's document, once, and marks it `data-lazurio-theme="light"`, so the
// T3 Code fork maps its own tokens onto them only where Lazurio's shell is
// present. A document that has the tokens already is left as it is, and the
// elements' shadow trees resolve every token from their own `:host`. Of the
// names, only `declares.tokens` is promised to a fork.

const vendored = join(
  import.meta.dir,
  "..",
  "src",
  "shell",
  "vendor",
  "lazurio",
  "tokens.css",
);
const comments = /\/\*[\s\S]*?\*\//g;

/** Why a stylesheet is not the shape the shell injects: exactly one
 * top-level `:root { … }` rule whose declarations are all `--lz-*` custom
 * properties. Empty when it is. */
function shapeProblems(css: string): string[] {
  const rule = /^\s*:root\s*\{([^{}]*)\}\s*$/.exec(css.replace(comments, ""));
  if (rule === null)
    return [
      "something besides one top-level `:root { … }` rule: another rule, an at-rule, a selector list or a nested block",
    ];
  return (rule[1] ?? "")
    .split(";")
    .map((declaration) => declaration.trim())
    .filter(
      (declaration) =>
        declaration !== "" && !/^--lz-[\w-]+\s*:/.test(declaration),
    )
    .map((declaration) => `a declaration other than --lz-*: ${declaration}`);
}

/** The custom properties of the injected text, by name. */
const declared = new Map(
  [...shellTokensCss.matchAll(/(--lz-[\w-]+)\s*:\s*([^;]*);/g)].map(
    (match) => [match[1] ?? "", (match[2] ?? "").trim()] as const,
  ),
);
const names = [...declared.keys()];

test("the vendored tokens.css is exactly the shape the shell injects", async () => {
  expect(designTokens).toBe(await readFile(vendored, "utf8"));
  expect(
    shapeProblems(designTokens),
    "src/shell/vendor/lazurio/tokens.css must be, without its comments, exactly one top-level `:root { … }` rule of `--lz-*` custom properties. The shell puts this text as it is into every app's document (src/shell/tokens.ts) and, as `:host`, into every element (src/shell/base-styles.ts), so anything else in it would restyle the apps. Keep the design system's file to its tokens, or change how the shell injects them before vendoring this copy (F36's addendum of 2026-10-13).",
  ).toEqual([]);
  // What the document gets is that text without its comments.
  expect(shellTokensCss).toBe(designTokens.replace(comments, ""));
  expect(names.length).toBeGreaterThan(100);
});

test("the shape check refuses anything besides the root's tokens", () => {
  const root = ":root {\n\t--lz-a: 1px;\n\t--lz-b: var(--lz-a);\n}\n";
  expect(shapeProblems(root)).toEqual([]);
  expect(shapeProblems(`/* a comment */\n${root}/* another */`)).toEqual([]);
  for (const added of [
    "html { font-family: var(--lz-font-sans); }",
    "body { margin: 0; }",
    "::selection { background: var(--lz-blue-100); }",
    ".lz-button { color: var(--lz-ink); }",
    '@font-face { font-family: "Other"; src: url(other.woff2); }',
    "@media (prefers-color-scheme: dark) { :root { --lz-a: 2px; } }",
    "@layer base;",
    '@import url("other.css");',
  ])
    expect(shapeProblems(`${root}${added}\n`), added).not.toEqual([]);
  for (const rule of [
    ":root, :host { --lz-a: 1px; }",
    "html { --lz-a: 1px; }",
    ":root { --lz-a: 1px; color-scheme: light; }",
    ":root { --lz-a: 1px; font-family: sans-serif; }",
    ":root { --lz-a: 1px; --other: 2px; }",
    ":root { --lz-a: 1px; & .nested { color: red; } }",
  ])
    expect(shapeProblems(rule), rule).not.toEqual([]);
});

test("every token name a fork may rely on is declared, and only those are promised", () => {
  const promised = shellElementInterface.declares.tokens;
  expect(new Set(promised).size).toBe(promised.length);
  for (const name of promised)
    expect(names, `${name} is promised to the forks`).toContain(name);
  // The shell declares every token; the promise is the short list.
  expect(promised.length).toBeLessThan(names.length);
});

type FakeStyle = {
  dataset: Record<string, string | undefined>;
  textContent: string | null;
};

/** A document with the app's own stylesheet in its head; `own` answers the
 * custom properties its root resolves without the shell; `refused`, a policy
 * that refuses inline styles, keeps the shell's style from applying. */
const fakeDocument = (
  own: (name: string) => string = () => "",
  { window = true, refused = false } = {},
) => {
  const head: (FakeStyle | string)[] = ["<link rel=stylesheet>"];
  const attributes = new Map<string, string>();
  const calls = { created: 0, marked: 0 };
  const ours = () =>
    head.find(
      (node): node is FakeStyle =>
        typeof node !== "string" && node.dataset.lazurioTokens !== undefined,
    ) ?? null;
  const doc: TokenDocument = {
    querySelector: (selectors) =>
      selectors === "style[data-lazurio-tokens]" ? ours() : null,
    createElement: () => {
      calls.created += 1;
      return { dataset: {}, textContent: null };
    },
    head: { prepend: (node) => head.unshift(node as FakeStyle) },
    documentElement: {
      setAttribute: (name, value) => {
        calls.marked += 1;
        attributes.set(name, value);
      },
    },
    defaultView: window
      ? {
          getComputedStyle: () => ({
            getPropertyValue: (name) => {
              const value = declared.get(name);
              return ours() !== null && !refused && value !== undefined
                ? value
                : own(name);
            },
          }),
        }
      : null,
  };
  return { doc, head, attributes, calls };
};

test("the shell declares the tokens once, first in the head, and marks the root", () => {
  const { doc, head, attributes, calls } = fakeDocument();
  installShellTokens(doc);
  expect(head).toHaveLength(2);
  expect(head[0]).toEqual({
    dataset: { lazurioTokens: "" },
    textContent: shellTokensCss,
  });
  expect(head[1]).toBe("<link rel=stylesheet>");
  expect([...attributes]).toEqual([["data-lazurio-theme", "light"]]);
  // The mark is the one interface v1 promises.
  expect(Object.entries(shellElementInterface.declares.theme)).toEqual([
    [shellTheme.attribute, [shellTheme.value]],
  ]);
  // A second load finds its style and adds nothing.
  installShellTokens(doc);
  installShellTokens(doc);
  expect(head).toHaveLength(2);
  expect(calls).toEqual({ created: 1, marked: 1 });
});

test("a document whose root has the tokens already is left as it is", () => {
  // Its own tokens.css (the Launchpad page, the Dashboard), or just one of
  // the names, the first or the last.
  for (const has of [
    (name: string) => declared.get(name) ?? "",
    (name: string) => (name === names[0] ? "#fff" : ""),
    (name: string) => (name === names.at(-1) ? " 1px " : ""),
  ]) {
    const { doc, head, attributes, calls } = fakeDocument(has);
    installShellTokens(doc);
    expect(head).toEqual(["<link rel=stylesheet>"]);
    expect(attributes.size).toBe(0);
    expect(calls).toEqual({ created: 0, marked: 0 });
  }
});

test("a document without a window gets them once too", () => {
  const { doc, head, calls } = fakeDocument(() => "", { window: false });
  installShellTokens(doc);
  installShellTokens(doc);
  expect(head).toHaveLength(2);
  expect(calls).toEqual({ created: 1, marked: 1 });
});

test("where the style does not apply, the root is not marked", () => {
  // A policy that refuses inline styles: a fork's mapping onto tokens that
  // do not hold would paint nothing, so it must not match.
  const { doc, head, attributes, calls } = fakeDocument(() => "", {
    refused: true,
  });
  installShellTokens(doc);
  installShellTokens(doc);
  expect(head).toHaveLength(2);
  expect(attributes.size).toBe(0);
  expect(calls).toEqual({ created: 1, marked: 0 });
});

test("the elements resolve every token from their own :host, never from the document", () => {
  // Each element declares on its host exactly what the document gets, and
  // nothing in its stylesheet declares a token again: an inherited value of
  // the document's root, the shell's or the app's own, never reaches its
  // shadow tree. Their colours stay the app's roles over these (root
  // decision 0187).
  expect(hostTokens.replace(comments, "")).toBe(
    shellTokensCss.replace(":root", ":host"),
  );
  for (const css of [railCss, columnHeadCss, environmentCss]) {
    expect(css.startsWith(hostTokens)).toBe(true);
    expect(css.slice(hostTokens.length)).not.toMatch(/--lz-[\w-]+\s*:/);
  }
});

test("the font faces the shell declares are the families the tokens name first", () => {
  const families: string[] = [
    ...new Set(shellFonts.map((font) => font.family)),
  ];
  expect(families).toEqual([...shellElementInterface.declares.fonts]);
  const first = (name: string) =>
    /^"([^"]+)"/.exec(declared.get(name) ?? "")?.[1];
  expect([first("--lz-font-sans"), first("--lz-font-mono")]).toEqual(families);
});
