import { describe, expect, test } from "bun:test";
import {
  maxNewTabTools,
  type NewTabChoice,
  newTabEventName,
  parseNewTabChoice,
  parseNewTabTools,
} from "../src/browser/contract/pure";
import { parseShell, type Shell } from "../src/shell/contract";
import { shellElementInterface } from "../src/shell/interface";
import {
  acceptNewTabHostMessage,
  acceptNewTabPageMessage,
  type NewTabHostMessage,
  type NewTabPageMessage,
  newTabFrameSource,
  newTabHostMessageOf,
  newTabHostOrigins,
  newTabMessage,
  newTabPagePath,
  newTabReadyTargets,
  newTabThemeRoles,
  parseNewTabHostMessage,
  parseNewTabPageMessage,
  parseNewTabTheme,
  themeValue,
} from "../src/shell/new-tab-protocol";

// Nová karta's protocol (decision F47 points 1 and 2): the messages between
// the shell element `<lazurio-new-tab>` and the Launchpad's page `/new-tab`
// it frames. Each side reads every message field by field and drops one of
// another type, shape or kind; the element hears only its own frame on the
// page's origin, the page only its parent on an origin of the Environment's
// own apps, and neither posts anywhere else.

const view = "https://browser.vm-01.example.lazurio.io";
const tab = "0123456789ABCDEF".repeat(2);
const tools = [
  { id: "terminal", label: "Terminal", key: "T", icon: "terminal" },
  { id: "files", label: "Files", key: "F", icon: "files" },
  { id: "diff", label: "Diff", key: "D" },
  { id: "pull-request", label: "Pull request", key: "P" },
  { id: "agents", label: "Agents", key: "A", icon: "agents" },
  { id: "device", label: "Device", key: "M", icon: "device" },
];

const shellOf = (
  apps: Readonly<{
    apps: string;
    chat: string | null;
    automate: string | null;
  }>,
  current: string | null = "vm-01.example",
): Shell => {
  const shell = parseShell({
    schema: "lazurio.shell.v1",
    locale: "cs",
    current,
    operator: { initials: "EU", login: "example-user", avatar: null },
    environments: [
      {
        id: "vm-01.example",
        label: null,
        kind: "work",
        organizations: ["example"],
        assignee: "example-user",
        apps,
      },
    ],
    organizations: [
      {
        slug: "example",
        name: "Example Company",
        avatar: null,
        dashboard: "https://dashboard.lazurio.ai/orgs/example",
      },
    ],
    dashboard: "https://dashboard.lazurio.ai/",
    account: "https://dashboard.lazurio.ai/settings",
    addOrganization: null,
  });
  if (shell === null) throw new Error("The fixture is a shell document");
  return shell;
};
const hosted = shellOf({
  apps: "https://launchpad.vm-01.example.lazurio.io/",
  chat: "https://t3code.vm-01.example.lazurio.io/",
  automate: "https://mausbot.vm-01.example.lazurio.io/",
});

describe("the tools an app hands over", () => {
  test("a list of at most twelve, each with an id and a label, an optional letter and icon, none twice", () => {
    expect(parseNewTabTools(tools)).toEqual(tools);
    expect(parseNewTabTools([])).toEqual([]);
    const twelve = Array.from({ length: maxNewTabTools }, (_, n) => ({
      id: `tool-${n}`,
      label: `Tool ${n}`,
    }));
    expect(parseNewTabTools(twelve)).toHaveLength(12);
    const refused: unknown[] = [
      null,
      "tools",
      { id: "terminal", label: "Terminal" },
      [...twelve, { id: "tool-12", label: "Tool 12" }],
      ["terminal"],
      [{ id: "Terminal", label: "Terminal" }],
      [{ id: "terminal" }],
      [{ id: "terminal", label: " " }],
      [{ id: "terminal", label: "x".repeat(49) }],
      [{ id: "terminal", label: "Terminal\n" }],
      [{ id: "terminal", label: "Terminal", key: "Tab" }],
      [{ id: "terminal", label: "Terminal", key: "+" }],
      [{ id: "terminal", label: "Terminal", key: 7 }],
      [{ id: "terminal", label: "Terminal", icon: "<svg>" }],
      [tools[0], { ...tools[1], id: "terminal" }],
      // Letters are told apart regardless of case.
      [tools[0], { ...tools[1], key: "t" }],
    ];
    for (const value of refused) expect(parseNewTabTools(value)).toBeNull();
  });
});

describe("the page's messages", () => {
  test("a choice is a page or a tab with its view, or a tool; the tab's id in upper case", () => {
    for (const kind of ["page", "tab"] as const) {
      expect(
        parseNewTabChoice({ kind, tab, view: `${view}/t/${tab}` }),
      ).toEqual({ kind, tab, view: `${view}/t/${tab}` });
      expect(
        parseNewTabChoice({
          kind,
          tab: tab.toLowerCase(),
          view: `${view}/t/${tab}`,
        }),
      ).toEqual({ kind, tab, view: `${view}/t/${tab}` });
    }
    expect(parseNewTabChoice({ kind: "tool", id: "terminal" })).toEqual({
      kind: "tool",
      id: "terminal",
    });
    // A later version's members are ignored.
    expect(
      parseNewTabChoice({ kind: "tool", id: "terminal", later: true }),
    ).toEqual({ kind: "tool", id: "terminal" });
  });

  test("a choice of another kind, type or shape is nothing: no other view, no address but the tab's own", () => {
    const other = "FEDCBA9876543210".repeat(2);
    const refused: unknown[] = [
      null,
      "page",
      [{ kind: "page", tab, view: `${view}/t/${tab}` }],
      { kind: "link", tab },
      { kind: "sleep", tab },
      { kind: "Page", tab, view: `${view}/t/${tab}` },
      { kind: "page", tab },
      { kind: "page", tab: "not-a-tab", view: `${view}/t/not-a-tab` },
      { kind: "page", tab: 42, view: `${view}/t/42` },
      { kind: "page", tab, view: `${view}/t/${other}` },
      { kind: "page", tab, view: `${view}/t/${tab}?x=1` },
      { kind: "page", tab, view: `${view}/t/${tab}#x` },
      { kind: "page", tab, view: `${view.replace("https", "http")}/t/${tab}` },
      {
        kind: "tab",
        tab,
        view: `https://a:b@browser.example.lazurio.io/t/${tab}`,
      },
      { kind: "tab", tab, view: `javascript:alert(1)//t/${tab}` },
      // Not as written: the host would read another address.
      { kind: "tab", tab, view: `${view.toUpperCase()}/t/${tab}` },
      { kind: "tool", id: "Terminal" },
      { kind: "tool", id: 7 },
      { kind: "tool" },
    ];
    for (const value of refused) expect(parseNewTabChoice(value)).toBeNull();
  });

  test("a choice's view is a view address in the contract's strict form, on the view host of an Environment (decision F50 point 2)", () => {
    for (const address of [
      `https://browser.a.b.c.lazurio.io/t/${tab}`,
      `https://browser.-vm.example.lazurio.io/t/${tab}`,
      `https://t3code.vm-01.example.lazurio.io/t/${tab}`,
      `https://example.com/t/${tab}`,
    ])
      expect(parseNewTabChoice({ kind: "tab", tab, view: address })).toBeNull();
    // A view with its id in lower case is the tab's view, as the contract
    // writes it.
    expect(
      parseNewTabChoice({
        kind: "tab",
        tab,
        view: `${view}/t/${tab.toLowerCase()}`,
      }),
    ).toEqual({ kind: "tab", tab, view: `${view}/t/${tab}` });
    // Another Environment's view is a view address all the same.
    const other = `https://browser.vm-02.example.lazurio.io/t/${tab}`;
    expect(parseNewTabChoice({ kind: "tab", tab, view: other })).toEqual({
      kind: "tab",
      tab,
      view: other,
    });
  });

  test("the page says ready or what was chosen, and nothing else", () => {
    expect(parseNewTabPageMessage({ type: newTabMessage.ready })).toEqual({
      type: "lazurio-new-tab:ready",
    });
    expect(
      parseNewTabPageMessage({
        type: newTabMessage.choice,
        choice: { kind: "tool", id: "files" },
      }),
    ).toEqual({
      type: "lazurio-new-tab:choice",
      choice: { kind: "tool", id: "files" },
    });
    for (const value of [
      null,
      "lazurio-new-tab:ready",
      [newTabMessage.ready],
      { type: newTabMessage.host },
      { type: "lazurio-new-tab:navigate", href: "https://example.com/" },
      { type: newTabMessage.choice },
      { type: newTabMessage.choice, choice: { kind: "link", tab } },
    ])
      expect(parseNewTabPageMessage(value)).toBeNull();
  });

  test("the element hears only its own frame on the page's origin, and only a tool it has", () => {
    const page = "https://launchpad.vm-01.example.lazurio.io";
    const event = (data: unknown, extra = {}) => ({
      data,
      origin: page,
      fromFrame: true,
      ...extra,
    });
    const ready = { type: newTabMessage.ready };
    const choose = (choice: NewTabChoice): NewTabPageMessage => ({
      type: newTabMessage.choice,
      choice,
    });
    const handed = parseNewTabTools(tools) ?? [];
    expect(acceptNewTabPageMessage(event(ready), page, handed)).toEqual(ready);
    expect(
      acceptNewTabPageMessage(
        event(choose({ kind: "tool", id: "diff" })),
        page,
        handed,
      ),
    ).toEqual(choose({ kind: "tool", id: "diff" }));
    for (const [message, extra, origin] of [
      [ready, { fromFrame: false }, page],
      [ready, { origin: "https://t3code.vm-01.example.lazurio.io" }, page],
      [ready, {}, null],
      [choose({ kind: "tool", id: "terminal-2" }), {}, page],
    ] as const)
      expect(
        acceptNewTabPageMessage(event(message, extra), origin, handed),
      ).toBeNull();
    // The Launchpad has no tools: a tool from its Nová karta is nothing.
    expect(
      acceptNewTabPageMessage(
        event(choose({ kind: "tool", id: "terminal" })),
        page,
        [],
      ),
    ).toBeNull();
  });
});

describe("the host's message", () => {
  const message: NewTabHostMessage = {
    type: newTabMessage.host,
    strip: "t3-x",
    tools,
    focusAddress: false,
    lang: "cs",
    theme: {
      "--lazurio-surface": "#151515",
      "--lazurio-ink": "rgb(236 236 236)",
    },
  };

  test("its strip, tools, whether the address bar takes the keys, the language and the colour roles", () => {
    expect(parseNewTabHostMessage(message)).toEqual(message);
    const refused: Record<string, unknown>[] = [
      { type: newTabMessage.ready },
      { strip: "t3 x" },
      { strip: "../launchpad" },
      { strip: "" },
      { tools: [{ id: "terminal" }] },
      { tools: "[]" },
      { focusAddress: "true" },
      { lang: "de" },
      { theme: null },
      { theme: ["#fff"] },
    ];
    for (const change of refused)
      expect(parseNewTabHostMessage({ ...message, ...change })).toBeNull();
    for (const value of [null, "host", [message]])
      expect(parseNewTabHostMessage(value)).toBeNull();
  });

  test("a colour role is a colour, never anything that could load: an unknown role or an unsafe value keeps the design system's colour", () => {
    for (const colour of [
      "#fff",
      "#0d12dbcc",
      "white",
      "rgb(13, 18, 219)",
      "rgb(13 18 219 / 22%)",
      "oklch(0.62 0.19 264)",
      "color-mix(in srgb, #0d12db 40%, white)",
      "light-dark(#fff, #111)",
    ])
      expect(themeValue(colour)).toBe(colour);
    for (const unsafe of [
      "url(https://example.com/x.png)",
      "var(--lazurio-ink)",
      "image(#fff)",
      "#fff; background: red",
      "expression(alert(1))",
      "{}",
      "",
      " ",
      "#".repeat(161),
      7,
      null,
    ])
      expect(themeValue(unsafe)).toBeNull();
    expect(
      parseNewTabTheme({
        "--lazurio-surface": "#151515",
        "--lazurio-ink": "url(https://example.com/)",
        "--lazurio-rail-width": "64px",
        "--lazurio-buddy-bottom": "112px",
        "--elsewhere": "#fff",
      }),
    ).toEqual({ "--lazurio-surface": "#151515" });
    // The roles are the interface's colour roles, without the rail's width,
    // the host's tone, where Buddy's launcher stands (decision F60) and how
    // wide its corner is (F60's addendum of 2026-10-25).
    expect(newTabThemeRoles).toEqual(
      shellElementInterface.properties.filter(
        (role) =>
          role !== "--lazurio-rail-width" &&
          role !== "--lazurio-host-tone" &&
          role !== "--lazurio-buddy-right" &&
          role !== "--lazurio-buddy-bottom" &&
          role !== "--lazurio-buddy-clearance",
      ),
    );
    expect(newTabThemeRoles).toHaveLength(12);
  });

  test("the page hears only its parent, on an origin of the Environment's own apps", () => {
    const origins = newTabHostOrigins(
      hosted,
      "https://launchpad.vm-01.example.lazurio.io",
    );
    const event = (extra = {}) => ({
      data: message,
      origin: "https://t3code.vm-01.example.lazurio.io",
      fromParent: true,
      ...extra,
    });
    expect(acceptNewTabHostMessage(event(), origins)).toEqual(message);
    expect(
      acceptNewTabHostMessage(event({ fromParent: false }), origins),
    ).toBeNull();
    for (const origin of [
      "https://t3code.vm-02.example.lazurio.io",
      "https://browser.vm-01.example.lazurio.io",
      "http://t3code.vm-01.example.lazurio.io",
      "null",
    ])
      expect(acceptNewTabHostMessage(event({ origin }), origins)).toBeNull();
    expect(acceptNewTabHostMessage(event(), [])).toBeNull();
  });

  test("the element's message from its attributes, the shell's language and the host document's colour roles", () => {
    const roles: Record<string, string> = {
      "--lazurio-surface": " #151515 ",
      "--lazurio-ink": "url(https://example.com/)",
    };
    const of = (input: Partial<Parameters<typeof newTabHostMessageOf>[0]>) =>
      newTabHostMessageOf({
        strip: "t3-x",
        tools: JSON.stringify(tools),
        focusAddress: false,
        lang: null,
        locale: "cs",
        role: (name) => roles[name] ?? "",
        ...input,
      });
    expect(of({})).toEqual({
      type: "lazurio-new-tab:host",
      strip: "t3-x",
      tools,
      focusAddress: false,
      lang: "cs",
      theme: { "--lazurio-surface": "#151515" },
    });
    // The element's `lang` wins over the shell's language.
    expect(of({ lang: "en", focusAddress: true })).toMatchObject({
      lang: "en",
      focusAddress: true,
    });
    expect(of({ lang: "de", locale: "en" })?.lang).toBe("en");
    // Tools that are not a valid list are no tools; Nová karta still shows.
    for (const value of [null, "not json", '[{"id":"x"}]', "{}"])
      expect(of({ tools: value })?.tools).toEqual([]);
    // Without a valid strip the element frames nothing.
    for (const strip of [null, "", "t3 x", "a".repeat(65)])
      expect(of({ strip })).toBeNull();
    // What it sends is what the page accepts.
    expect(parseNewTabHostMessage(of({}))).toEqual(of({}));
  });
});

describe("where the page is and who may host it", () => {
  test("the element frames /new-tab on the origin of the current Environment's apps; a workstation's apps is the host page's origin", () => {
    expect(newTabPagePath).toBe("/new-tab");
    expect(newTabEventName).toBe("lazurio-new-tab");
    expect(shellElementInterface.events).toContain(newTabEventName);
    expect(
      newTabFrameSource(hosted, "https://t3code.vm-01.example.lazurio.io/c/1")
        ?.href,
    ).toBe("https://launchpad.vm-01.example.lazurio.io/new-tab");
    const local = shellOf({ apps: "/", chat: null, automate: null });
    expect(
      newTabFrameSource(local, "http://127.0.0.1:24611/settings")?.href,
    ).toBe("http://127.0.0.1:24611/new-tab");
    expect(newTabFrameSource(null, "https://example.com/")).toBeNull();
    const nowhere = shellOf({ apps: "/", chat: null, automate: null }, null);
    expect(newTabFrameSource(nowhere, "https://example.com/")).toBeNull();
  });

  test("the hosts are exactly the current Environment's apps, chat and automate; nothing on a page of no Environment", () => {
    expect(
      newTabHostOrigins(hosted, "https://launchpad.vm-01.example.lazurio.io"),
    ).toEqual([
      "https://launchpad.vm-01.example.lazurio.io",
      "https://t3code.vm-01.example.lazurio.io",
      "https://mausbot.vm-01.example.lazurio.io",
    ]);
    expect(
      newTabHostOrigins(
        shellOf({ apps: "/", chat: null, automate: null }),
        "http://127.0.0.1:24620",
      ),
    ).toEqual(["http://127.0.0.1:24620"]);
    expect(
      newTabHostOrigins(
        shellOf({ apps: "/", chat: null, automate: null }, null),
        "http://127.0.0.1:24620",
      ),
    ).toEqual([]);
  });

  test("ready goes only to the parent's origin where the browser names it, and nowhere when that is another", () => {
    const origins = [
      "https://launchpad.vm-01.example.lazurio.io",
      "https://t3code.vm-01.example.lazurio.io",
    ];
    expect(
      newTabReadyTargets(origins, "https://t3code.vm-01.example.lazurio.io"),
    ).toEqual(["https://t3code.vm-01.example.lazurio.io"]);
    expect(newTabReadyTargets(origins, "https://elsewhere.example")).toEqual(
      [],
    );
    // Not named (another browser, or a frame without a referrer): every app
    // origin, of which the browser delivers only the parent's own.
    expect(newTabReadyTargets(origins, null)).toEqual(origins);
    expect(newTabReadyTargets(origins, "null")).toEqual(origins);
  });
});
