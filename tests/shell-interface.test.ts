import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  parseShell,
  type ShellThemeValues,
  shellThemeColors,
} from "../src/shell/contract";
import { environmentCss } from "../src/shell/identity-styles";
import { shellElementInterface } from "../src/shell/interface";
import { shellMessages } from "../src/shell/messages";
import { accountSourceOf } from "../src/shell/state";
import { columnHeadCss, railCss } from "../src/shell/styles";
import { environmentThemeCss } from "../src/shell/theme";
import { columnHead, shellApps } from "../src/shell/view";

/** One appearance of a theme: every promised colour name, one colour. */
const themeValues = Object.fromEntries(
  shellThemeColors.map((name) => [name, "#f0f0f0"]),
) as ShellThemeValues;

// Decision F36, addendum of 2026-10-04: the forks (T3 Code, MausBot) and the
// Dashboard build on the elements' interface v1. A Launchpad release may add
// to it and redraw everything, but never rename or remove a promised name.
// Changing this snapshot is a new interface version, not a refactor, unless
// it only adds names: F36's addendum of 2026-10-05 added, in version 1, the
// rail's `app` and `space`, the column head's `settings` and `space` and
// `active="settings"`, the host's document attributes and the script's
// exports, and removed nothing; the addendum of 2026-10-06 added the export
// `parseShellSignedOut`; decision F47 (2026-10-11) added `<lazurio-new-tab>`
// with its attributes and its event `lazurio-new-tab`, and removed nothing;
// F39's addendum of 2026-10-12 added `<lazurio-environment>` with its
// attributes `environment` and `lang`, and removed nothing; F36's addendum
// of 2026-10-13 added what the script declares in the app's document
// (`declares`: the fonts, the token names a fork may rely on and their
// mark), and removed nothing; F36's addendum of 2026-10-18 (root decision
// 0208) added the Environment theme: `declares.environmentTheme` (its two
// marks, `--lazurio-color-scheme` and the class `dark`), the host's
// `data-lazurio-appearance` and the event `lazurio-theme`, and removed
// nothing; decision F56 (2026-10-18) added the guide: `<lazurio-buddy>`'s
// attribute `lang`, the page's `marks` `data-guide` and `data-guide-help`,
// the event `lazurio-guide` and the export `provideGuides`, and removed
// nothing.

test("the promised interface v1 is exactly this", () => {
  expect(JSON.parse(JSON.stringify(shellElementInterface))).toEqual({
    version: 1,
    script: "/.lazurio/shell.js",
    elements: {
      "lazurio-rail": ["lang", "app", "space"],
      "lazurio-column-head": ["active", "lang", "settings", "space"],
      "lazurio-buddy": ["lang"],
      "lazurio-new-tab": ["strip", "tools", "focus-address", "lang"],
      "lazurio-environment": ["environment", "lang", "space"],
    },
    active: ["chat", "apps", "automate", "settings"],
    events: [
      "lazurio-navigate",
      "lazurio-app",
      "lazurio-new-tab",
      "lazurio-theme",
      "lazurio-guide",
    ],
    document: {
      "data-lazurio-shell": ["host"],
      "data-lazurio-account": ["host"],
      "data-lazurio-appearance": ["device", "light", "dark"],
    },
    marks: ["data-guide", "data-guide-help"],
    declares: {
      fonts: ["Inter Tight Variable", "Geist Mono"],
      tokens: [
        "--lz-surface",
        "--lz-paper",
        "--lz-ink",
        "--lz-ink-muted",
        "--lz-line",
        "--lz-accent",
        "--lz-accent-button",
        "--lz-accent-button-hover",
        "--lz-on-accent",
        "--lz-gray-50",
        "--lz-gray-100",
        "--lz-red-500",
        "--lz-danger",
        "--lz-danger-bg",
        "--lz-warning",
        "--lz-warning-bg",
        "--lz-green-500",
        "--lz-success",
        "--lz-info",
        "--lz-info-bg",
        "--lz-font-sans",
        "--lz-font-mono",
        "--lz-radius-sm",
      ],
      theme: { "data-lazurio-theme": ["light"] },
      environmentTheme: {
        marks: ["data-lazurio-environment-theme", "data-lazurio-theme-dark"],
        properties: ["--lazurio-color-scheme"],
        darkClass: "dark",
      },
    },
    exports: [
      "provideShell",
      "provideAccount",
      "parseShell",
      "parseShellAccount",
      "parseShellSignedOut",
      "provideGuides",
    ],
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
  // Nová karta's element is built in its own module (decision F47), and so
  // is the one that names an Environment (F39's addendum of 2026-10-12).
  const newTab = await readFile("src/shell/new-tab-element.ts", "utf8");
  const environment = await readFile("src/shell/identity-element.ts", "utf8");
  const observed = (className: string, text = source) => {
    const at = text.indexOf(`class ${className} `);
    expect(at).toBeGreaterThanOrEqual(0);
    const match = /static observedAttributes = \[([^\]]*)\]/.exec(
      text.slice(at),
    );
    return [...(match?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  };
  for (const attribute of shellElementInterface.elements["lazurio-rail"])
    expect(observed("LazurioRail")).toContain(attribute);
  for (const attribute of shellElementInterface.elements["lazurio-column-head"])
    expect(observed("LazurioColumnHead")).toContain(attribute);
  for (const attribute of shellElementInterface.elements["lazurio-new-tab"])
    expect(observed("LazurioNewTab", newTab)).toContain(attribute);
  for (const attribute of shellElementInterface.elements["lazurio-environment"])
    expect(observed("LazurioEnvironment", environment)).toContain(attribute);
  for (const attribute of shellElementInterface.elements["lazurio-buddy"])
    expect(observed("LazurioBuddy")).toContain(attribute);
  for (const name of [
    "lazurio-rail",
    "lazurio-column-head",
    "lazurio-new-tab",
    "lazurio-environment",
    "lazurio-buddy",
  ])
    expect(source).toMatch(
      new RegExp(`customElements\\.define\\(\\s*"${name}",`),
    );
  for (const event of shellElementInterface.events)
    expect(`${source}${newTab}`).toContain(`new CustomEvent("${event}"`);
  // The rail width and the tone in the script, the colour roles in the
  // styles of both elements.
  for (const property of shellElementInterface.properties)
    expect(
      source.includes(`"${property}"`) ||
        (railCss.includes(`var(${property},`) &&
          columnHeadCss.includes(`var(${property},`)),
    ).toBe(true);
  // Every promised value of `active` marks something in the head: an app
  // its tab of the switch, `settings` the gear.
  const shell = parseShell({
    schema: "lazurio.shell.v1",
    locale: "en",
    current: "vm-01.example",
    operator: { initials: null, login: null, avatar: null },
    environments: [
      {
        id: "vm-01.example",
        label: null,
        kind: "work",
        organizations: ["example"],
        assignee: null,
        apps: {
          apps: "https://launchpad.vm-01.example.lazurio.io/",
          chat: "https://t3code.vm-01.example.lazurio.io/",
          automate: "https://mausbot.vm-01.example.lazurio.io/",
        },
      },
    ],
    organizations: [
      {
        slug: "example",
        name: "Example",
        avatar: null,
        dashboard: "https://dashboard.lazurio.ai/orgs/example",
      },
    ],
    dashboard: "https://dashboard.lazurio.ai/",
    account: "https://dashboard.lazurio.ai/settings",
    addOrganization: null,
  });
  if (shell === null) throw new Error("The fixture is a valid document");
  for (const active of shellElementInterface.active) {
    const head = columnHead(shell, shellMessages("en"), {
      space: null,
      active,
      settings: null,
    });
    const marked =
      active === "settings"
        ? head?.gear.current
        : head?.tabs?.find((tab) => tab.app === active)?.active;
    expect([active, marked]).toEqual([active, true]);
    if (active !== "settings")
      expect(shellApps as readonly string[]).toContain(active);
  }
});

test("a host's document attributes and the script's exports are kept", async () => {
  // The elements read each document attribute (`<html data-lazurio-…>`),
  // but for the host's dark switch, which the theme's style reads.
  const source = await readFile("src/shell/elements.ts", "utf8");
  for (const attribute of Object.keys(shellElementInterface.document)) {
    if (attribute === "data-lazurio-appearance") continue;
    const key = attribute
      .replace(/^data-/, "")
      .replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
    expect(source).toContain(`documentElement.dataset.${key}`);
  }
  // The Environment theme's dark values hold where the host shows dark:
  // `dark` always, `device` with the device, `light` never; and with the
  // class `darkClass` (F36's addendum of 2026-10-18).
  const dark = { ...themeValues, "--lz-surface": "#101010" };
  const css = environmentThemeCss({
    id: "example",
    label: "Example",
    revision: 1,
    light: themeValues,
    dark,
  });
  const { darkClass } = shellElementInterface.declares.environmentTheme;
  expect(css).toContain(
    `:root:is(.${darkClass}, [data-lazurio-appearance="dark"]) {`,
  );
  expect(css).toContain(
    '@media (prefers-color-scheme: dark) {\n  :root[data-lazurio-appearance="device"] {',
  );
  expect(css).not.toContain('"light"]');
  expect(shellElementInterface.document["data-lazurio-appearance"]).toEqual([
    "device",
    "light",
    "dark",
  ]);
  expect(shellElementInterface.document["data-lazurio-account"]).toEqual([
    "host",
  ]);
  expect(accountSourceOf("host")).toBe("host");
  // `/.lazurio/shell.js` is `src/shell/index.ts`; it exports every promised
  // name.
  const entry = new Bun.Transpiler({ loader: "ts" }).scan(
    await readFile("src/shell/index.ts", "utf8"),
  );
  for (const name of shellElementInterface.exports)
    expect(entry.exports).toContain(name);
});

test("the guide reads the page's marks it promises (decision F56)", async () => {
  // `data-guide-help` on the "?" a click plays (elements.ts listens for
  // it), `data-guide` on the element a step points at (guide-layer.ts finds
  // it on the page).
  const source = await readFile("src/shell/elements.ts", "utf8");
  const layer = await readFile("src/shell/guide-layer.ts", "utf8");
  expect(shellElementInterface.marks).toEqual([
    "data-guide",
    "data-guide-help",
  ]);
  expect(source).toContain("dataset.guideHelp");
  expect(layer).toContain("[data-guide=");
});

test("the script declares in the document what `declares` promises", async () => {
  // `/.lazurio/shell.js` defines the elements as it loads (index.ts), and
  // defining them declares the fonts and the tokens in the document (F36's
  // addendum of 2026-10-13); tests/shell-tokens.test.ts holds what each
  // declares, and when not.
  const source = await readFile("src/shell/elements.ts", "utf8");
  const define = source.slice(
    source.indexOf("export function defineShellElements"),
  );
  expect(define).toContain("installShellFonts(document);");
  expect(define).toContain("installShellTokens(document);");
  expect(await readFile("src/shell/index.ts", "utf8")).toContain(
    "\ndefineShellElements();",
  );
  // The Environment theme this origin remembers (F36's addendum of
  // 2026-10-18), right after the tokens and before any element is defined,
  // in the same synchronous call the script makes as it evaluates: a
  // deferred module runs before the app's own later module, so the theme is
  // there before the app's code. tests/shell-theme.test.ts holds what is
  // declared.
  const body = define.slice(0, define.indexOf("\n}\n"));
  expect(body).not.toContain("await");
  expect(body.indexOf("installShellTokens(document);")).toBeLessThan(
    body.indexOf("theme.start();"),
  );
  expect(body.indexOf("theme.start();")).toBeLessThan(
    body.indexOf("customElements.define"),
  );
});

// The colour roles (F36, addendum of 2026-10-04, evening) are optional: a
// host that sets none, or only some, keeps the design system's colour for
// the rest. A role is read either with that colour as its fallback, or in a
// `--shell-host-*` value that is itself only ever read with one.
test("an unset colour role leaves the design system's colour", () => {
  for (const css of [railCss, columnHeadCss, environmentCss]) {
    for (const declaration of css.split(/[;{}]/)) {
      if (!/var\(--lazurio-[a-z-]+\)/.test(declaration)) continue;
      expect(declaration.trim()).toMatch(/^--shell-host-[a-z-]+:/);
    }
    expect(css).not.toMatch(/var\(--shell-host-[a-z-]+\)/);
  }
});

/** What `property` of an element's host comes to: its stylesheet's plain
 * `:host` rules, the last declaration winning, with every `var()` resolved
 * as the browser resolves it there: a custom property the host declares,
 * else the host page's own (`page`, inherited into the shadow root), else the
 * fallback. Undefined when the host declares no such property. */
function onHost(
  css: string,
  property: string,
  page: Readonly<Record<string, string>>,
): string | undefined {
  const declared = new Map<string, string>();
  // Each `}` closes a rule; only the rules whose selector is exactly `:host`
  // are read (the rail's stylesheet has no at-rule around one).
  for (const rule of css.replace(/\/\*[\s\S]*?\*\//g, "").split("}")) {
    const open = rule.indexOf("{");
    if (open < 0 || rule.slice(0, open).trim() !== ":host") continue;
    for (const declaration of rule.slice(open + 1).split(";")) {
      const colon = declaration.indexOf(":");
      if (colon > 0)
        declared.set(
          declaration.slice(0, colon).trim(),
          declaration.slice(colon + 1).trim(),
        );
    }
  }
  const resolve = (value: string, depth: number): string => {
    const start = value.indexOf("var(");
    if (start < 0 || depth > 32) return value;
    let level = 0;
    let end = start + 3;
    for (; end < value.length; end += 1) {
      if (value[end] === "(") level += 1;
      else if (value[end] === ")" && --level === 0) break;
    }
    const inner = value.slice(start + 4, end);
    const comma = inner.indexOf(",");
    const name = (comma < 0 ? inner : inner.slice(0, comma)).trim();
    const found =
      declared.get(name) ??
      page[name] ??
      (comma < 0 ? "" : inner.slice(comma + 1).trim());
    return resolve(
      `${value.slice(0, start)}${resolve(found, depth + 1)}${value.slice(end + 1)}`,
      depth + 1,
    );
  };
  const value = declared.get(property);
  return value === undefined ? undefined : resolve(value, 0);
}

// The rail's edge toward the app (Matěj 2026-10-17, amending root decision
// 0187 point 2): one hairline in the host's line role, which T3 Code maps
// from its sidebar's border and MausBot from its skin's hairline, so the line
// follows every theme of every app with no change of a fork; the design
// system's line where a host sets no roles (the Launchpad page). Inside the
// rail's own width, so the app beside it keeps its place, and never a border:
// a host's border colour on the rail (T3 Code's sidebar scope, which the rail
// joins, sets one) would win over the role.
test("the rail draws its edge toward the app in the host's line, inside its own width", () => {
  const themed = "oklch(0.86 0.01 256)";
  expect(onHost(railCss, "box-shadow", { "--lazurio-line": themed })).toBe(
    `inset -1px 0 0 ${themed}`,
  );
  const line = onHost(railCss, "--lz-line", {});
  expect(line).toMatch(/^#[0-9a-f]{6}$/i);
  expect(onHost(railCss, "box-shadow", {})).toBe(`inset -1px 0 0 ${line}`);
  // Only the line role reaches it: another role leaves the design system's.
  expect(
    onHost(railCss, "box-shadow", { "--lazurio-line-strong": themed }),
  ).toBe(`inset -1px 0 0 ${line}`);
  for (const border of [
    "border",
    "border-right",
    "border-inline-end",
    "border-color",
    "border-width",
  ])
    expect(onHost(railCss, border, {})).toBeUndefined();
});

test("the Launchpad serves the promised script", async () => {
  const page = await readFile("src/launchpad/page.ts", "utf8");
  expect(page).toContain(`"${shellElementInterface.script}":`);
});
