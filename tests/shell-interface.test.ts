import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { parseShell } from "../src/shell/contract";
import { shellElementInterface } from "../src/shell/interface";
import { shellMessages } from "../src/shell/messages";
import { accountSourceOf } from "../src/shell/state";
import { columnHeadCss, railCss } from "../src/shell/styles";
import { columnHead, shellApps } from "../src/shell/view";

// Decision F36, addendum of 2026-10-04: the forks (T3 Code, MausBot) and the
// Dashboard build on the elements' interface v1. A Launchpad release may add
// to it and redraw everything, but never rename or remove a promised name.
// Changing this snapshot is a new interface version, not a refactor, unless
// it only adds names: F36's addendum of 2026-10-05 added, in version 1, the
// rail's `app` and `space`, the column head's `settings` and `space` and
// `active="settings"`, the host's document attributes and the script's
// exports, and removed nothing; the addendum of 2026-10-06 added the export
// `parseShellSignedOut`.

test("the promised interface v1 is exactly this", () => {
  expect(JSON.parse(JSON.stringify(shellElementInterface))).toEqual({
    version: 1,
    script: "/.lazurio/shell.js",
    elements: {
      "lazurio-rail": ["lang", "app", "space"],
      "lazurio-column-head": ["active", "lang", "settings", "space"],
      "lazurio-buddy": [],
    },
    active: ["chat", "apps", "automate", "settings"],
    events: ["lazurio-navigate", "lazurio-app"],
    document: {
      "data-lazurio-shell": ["host"],
      "data-lazurio-account": ["host"],
    },
    exports: [
      "provideShell",
      "provideAccount",
      "parseShell",
      "parseShellAccount",
      "parseShellSignedOut",
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
  // The elements read each document attribute (`<html data-lazurio-…>`).
  const source = await readFile("src/shell/elements.ts", "utf8");
  for (const attribute of Object.keys(shellElementInterface.document)) {
    const key = attribute
      .replace(/^data-/, "")
      .replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
    expect(source).toContain(`documentElement.dataset.${key}`);
  }
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
