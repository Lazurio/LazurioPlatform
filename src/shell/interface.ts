// The interface of the shell's elements that apps outside this repository
// build on: the T3 Code and MausBot forks place the elements in their own
// page, the Dashboard embeds them (decision F36, addendum of 2026-10-04).
// Version 1 is a promise: a Launchpad release may add attributes, values,
// events, document attributes, exports or properties and may change
// everything the elements draw, but it never renames or removes anything
// listed here. A change that would is a new version, decided like the
// contract and announced to the forks first. F36's addendum of 2026-10-05
// added, in version 1, what a host page that is no Environment's (the
// Dashboard) needs: the attributes the elements already read, the document
// attributes of a host that provides the documents, and the exports that
// hand them over. F36's addendum of 2026-10-06 added, in version 1, the
// export `parseShellSignedOut`: a host page with nobody signed in hands its
// signed-out document to the same `provideShell`, which accepts it besides
// `lazurio.shell.v1`. Decision F47 (2026-10-11) added, in version 1,
// `<lazurio-new-tab>` with its attributes and its event `lazurio-new-tab`.
export const shellElementInterface = Object.freeze({
  version: 1,
  /** The script an app loads, on its own origin. */
  script: "/.lazurio/shell.js",
  /** Element names and the attributes a host may set on each. */
  elements: Object.freeze({
    "lazurio-rail": Object.freeze(["lang", "app", "space"]),
    "lazurio-column-head": Object.freeze([
      "active",
      "lang",
      "settings",
      "space",
    ]),
    // Reserved for Buddy's bubble (root decision 0180); not defined yet.
    "lazurio-buddy": Object.freeze([] as string[]),
    // Nová karta (decision F47 point 2): the strip the tab is for, the app's
    // tools as JSON (`[{id, label, key?, icon?}]`), whether the address bar
    // takes the keys, and the language.
    "lazurio-new-tab": Object.freeze([
      "strip",
      "tools",
      "focus-address",
      "lang",
    ]),
  }),
  /** Values of `active` on `<lazurio-column-head>`: the app the head sits
   * in, or `settings` inside the Settings its gear opens. */
  active: Object.freeze(["chat", "apps", "automate", "settings"]),
  /** Composed events: the first two are cancelable and a host may take them
   * over; `lazurio-new-tab` says what Nová karta became (`detail`:
   * `{kind: "page" | "tab", tab, view}` or `{kind: "tool", id}`). */
  events: Object.freeze(["lazurio-navigate", "lazurio-app", "lazurio-new-tab"]),
  /** Attributes a host sets on its document (`<html>`) and their values:
   * `host` says the page provides that document itself (`provideShell`,
   * `provideAccount`) and the elements read nothing of it. */
  document: Object.freeze({
    "data-lazurio-shell": Object.freeze(["host"]),
    "data-lazurio-account": Object.freeze(["host"]),
  }),
  /** What the script exports to a host. */
  exports: Object.freeze([
    "provideShell",
    "provideAccount",
    "parseShell",
    "parseShellAccount",
    "parseShellSignedOut",
  ]),
  /** Custom properties: the rail sets the first on the document; a host may
   * set the second to override the detected tone. The rest are the colour
   * roles (F36, addendum of 2026-10-04, evening): a host fills them from its
   * own theme on its document (`:root`), each one optional; an unset role
   * keeps the design system's colour, and a set one wins over the tone. */
  properties: Object.freeze([
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
  ]),
});
